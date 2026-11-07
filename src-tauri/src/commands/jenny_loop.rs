//! jenny fork: the commands behind a folder's Loop conversation
//! (`crate::jenny_loop`). The `_core` functions serve both the desktop commands
//! and the axum handlers in `web::handlers::jenny_loop`.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::Utc;
use sea_orm::{ActiveValue::NotSet, ColumnTrait, EntityTrait, QueryFilter, Set};
use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::commands::conversations::{emit_conversation_upsert, parse_error_to_app_error};
use crate::commands::folders::emit_folder_upsert;
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder;
use crate::db::service::{agent_setting_service, folder_service};
use crate::jenny_loop::{self, FolderLoopSummary, LoopConversationDetail, SessionStores};
use crate::jenny_progress;
use crate::models::agent::AgentType;
use crate::models::message::MessageTurn;
use crate::parsers::build_agent_parser;
use crate::web::event_bridge::EventEmitter;

/// How often the sidebar rows are brought in line with the Loops on disk.
const SYNC_INTERVAL: Duration = Duration::from_secs(20);
/// A parsed session stays reusable this long while a view polls it.
const LIVE_REPARSE_AFTER: Duration = Duration::from_secs(4);
/// Parsed sessions kept for paging. A big rollout parses to tens of megabytes.
const PARSED_SESSIONS_KEPT: usize = 4;
const PARSED_SESSION_IDLE: Duration = Duration::from_secs(600);
const DEFAULT_PAGE_TURNS: usize = 30;
/// What one page may carry to the view. A long Codex stage reaches many
/// megabytes in a single turn.
const PAGE_BYTES: usize = 3 * 1024 * 1024;
const STEER_TIMEOUT: Duration = Duration::from_secs(30);

async fn session_stores(conn: &sea_orm::DatabaseConnection) -> SessionStores {
    SessionStores {
        codex_env: agent_setting_service::load_agent_env(conn, AgentType::Codex).await,
        claude_env: agent_setting_service::load_agent_env(conn, AgentType::ClaudeCode).await,
        grok_env: agent_setting_service::load_agent_env(conn, AgentType::Grok).await,
        data_root: jenny_progress::data_root(),
    }
}

async fn folder_path_of(
    conn: &sea_orm::DatabaseConnection,
    folder_id: i32,
) -> Result<PathBuf, AppCommandError> {
    folder_service::get_folder_by_id(conn, folder_id)
        .await
        .map_err(AppCommandError::from)?
        .map(|f| PathBuf::from(f.path))
        .ok_or_else(|| AppCommandError::not_found(format!("Folder {folder_id} not found")))
}

pub async fn get_loop_conversation_core(
    conn: &sea_orm::DatabaseConnection,
    folder_id: i32,
) -> Result<LoopConversationDetail, AppCommandError> {
    let folder = folder_path_of(conn, folder_id).await?;
    let stores = session_stores(conn).await;
    tokio::task::spawn_blocking(move || jenny_loop::read_conversation(&folder, &stores, Utc::now()))
        .await
        .map_err(|e| AppCommandError::io_error(format!("Loop read stopped: {e}")))
}

/// One window of a Loop session's transcript. A running stage's rollout can
/// reach tens of megabytes, so the view pages it instead of parsing and
/// shipping the whole session on every poll.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSessionPage {
    pub session_id: String,
    pub agent_type: AgentType,
    pub total_turns: usize,
    /// Index of `turns[0]`; earlier turns come from a request with this as
    /// `before`.
    pub first_index: usize,
    pub turns: Vec<MessageTurn>,
    /// Steps of `turns[0]` left out because that one turn is over the page size.
    pub omitted_blocks: usize,
}

struct ParsedSession {
    turns: Arc<Vec<MessageTurn>>,
    parsed_at: Instant,
    used_at: Instant,
}

type ParsedCache = Mutex<HashMap<(AgentType, String), ParsedSession>>;

fn parsed_sessions() -> &'static ParsedCache {
    static CACHE: OnceLock<ParsedCache> = OnceLock::new();
    CACHE.get_or_init(Default::default)
}

fn cached_turns(key: &(AgentType, String), live: bool) -> Option<Arc<Vec<MessageTurn>>> {
    let mut cache = parsed_sessions().lock().ok()?;
    let entry = cache.get_mut(key)?;
    // A finished session never changes; a live one is re-read, but not faster
    // than it takes to read: a big file must not parse back to back.
    if live && entry.parsed_at.elapsed() >= LIVE_REPARSE_AFTER {
        return None;
    }
    entry.used_at = Instant::now();
    Some(Arc::clone(&entry.turns))
}

fn remember_turns(key: (AgentType, String), turns: Arc<Vec<MessageTurn>>) {
    let Ok(mut cache) = parsed_sessions().lock() else {
        return;
    };
    let now = Instant::now();
    cache.retain(|_, s| now.duration_since(s.used_at) < PARSED_SESSION_IDLE);
    while cache.len() >= PARSED_SESSIONS_KEPT && !cache.contains_key(&key) {
        let Some(oldest) = cache
            .iter()
            .min_by_key(|(_, s)| s.used_at)
            .map(|(k, _)| k.clone())
        else {
            break;
        };
        cache.remove(&oldest);
    }
    cache.insert(
        key,
        ParsedSession {
            turns,
            parsed_at: now,
            used_at: now,
        },
    );
}

fn json_size(value: &impl Serialize) -> usize {
    serde_json::to_vec(value).map(|v| v.len()).unwrap_or(0)
}

/// The newest turns before `end` that fit the page. At least one turn always
/// comes back; when that one is over the limit, its latest steps do.
fn window_turns(
    turns: &[MessageTurn],
    end: usize,
    limit: usize,
    max_bytes: usize,
) -> (usize, Vec<MessageTurn>, usize) {
    let end = end.min(turns.len());
    let mut start = end;
    let mut used = 0;
    while start > 0 && end - start < limit {
        let size = json_size(&turns[start - 1]);
        if start < end && used + size > max_bytes {
            break;
        }
        used += size;
        start -= 1;
    }
    let mut window: Vec<MessageTurn> = turns[start..end].to_vec();
    let mut omitted = 0;
    if used > max_bytes && window.len() == 1 {
        let turn = &mut window[0];
        let mut kept = 0;
        let mut size = 0;
        for block in turn.blocks.iter().rev() {
            size += json_size(block);
            if size > max_bytes && kept > 0 {
                break;
            }
            kept += 1;
        }
        omitted = turn.blocks.len() - kept;
        turn.blocks.drain(..omitted);
    }
    (start, window, omitted)
}

pub async fn get_loop_session_page_core(
    conn: &sea_orm::DatabaseConnection,
    agent_type: AgentType,
    session_id: String,
    before: Option<usize>,
    limit: Option<usize>,
    live: bool,
) -> Result<LoopSessionPage, AppCommandError> {
    let env = agent_setting_service::load_agent_env(conn, agent_type).await;
    tokio::task::spawn_blocking(move || -> Result<LoopSessionPage, AppCommandError> {
        let key = (agent_type, session_id.clone());
        // A page further back reads what the first page parsed.
        let turns = match cached_turns(&key, live && before.is_none()) {
            Some(turns) => turns,
            None => {
                let detail = build_agent_parser(agent_type, &env)
                    .get_conversation(&session_id)
                    .map_err(parse_error_to_app_error)?;
                let turns = Arc::new(detail.turns);
                remember_turns(key, Arc::clone(&turns));
                turns
            }
        };
        let total_turns = turns.len();
        let (first_index, window, omitted_blocks) = window_turns(
            &turns,
            before.unwrap_or(total_turns),
            limit.unwrap_or(DEFAULT_PAGE_TURNS).max(1),
            PAGE_BYTES,
        );
        Ok(LoopSessionPage {
            session_id,
            agent_type,
            total_turns,
            first_index,
            turns: window,
            omitted_blocks,
        })
    })
    .await
    .map_err(|e| AppCommandError::io_error(format!("Loop session read stopped: {e}")))?
}

/// What Jenny answered to a message for a running stage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSteerResult {
    pub steered: bool,
    pub reason: Option<String>,
}

/// Hands a message to the stage agent through Jenny's own `steer` command. A
/// message can't reach a stage Jenny has no live channel to; the answer says so.
pub async fn steer_loop_core(
    conn: &sea_orm::DatabaseConnection,
    folder_id: i32,
    loop_id: String,
    message: String,
) -> Result<LoopSteerResult, AppCommandError> {
    if message.trim().is_empty() {
        return Err(AppCommandError::invalid_input("The message is empty"));
    }
    let folder = folder_path_of(conn, folder_id).await?;
    let loop_dir = jenny_loop::loop_dir_for(&folder, &loop_id)
        .ok_or_else(|| AppCommandError::not_found(format!("Loop {loop_id} not found")))?;
    let data_root = jenny_progress::data_root();
    let cli = jenny_loop::loop_cli_path(data_root.as_deref()).ok_or_else(|| {
        AppCommandError::dependency_missing("Jenny's loop-cli.mjs not found (set JENNY_HOME)")
    })?;
    let node = which::which("node").map_err(|e| {
        AppCommandError::dependency_missing("Node.js not found").with_detail(e.to_string())
    })?;
    let mut command = tokio::process::Command::new(node);
    command
        .arg(cli)
        .arg("steer")
        .arg("--loop")
        .arg(&loop_dir)
        .arg("--message")
        .arg(&message)
        .current_dir(&folder)
        .kill_on_drop(true);
    let output = tokio::time::timeout(STEER_TIMEOUT, command.output())
        .await
        .map_err(|_| AppCommandError::task_execution_failed("Jenny's steer command timed out"))?
        .map_err(|e| AppCommandError::io_error(format!("Jenny's steer command failed: {e}")))?;
    let answer: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or(serde_json::Value::Null);
    if !output.status.success() {
        // Jenny says why on stderr as JSON: a stage it can't reach is an answer
        // for the person, not a failure of this command.
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let reason = serde_json::from_str::<serde_json::Value>(&stderr)
            .ok()
            .and_then(|v| v.get("message")?.as_str().map(str::to_string));
        return match reason {
            Some(reason) => Ok(LoopSteerResult {
                steered: false,
                reason: Some(reason),
            }),
            None => Err(
                AppCommandError::task_execution_failed("Jenny refused the message")
                    .with_detail(stderr),
            ),
        };
    }
    Ok(LoopSteerResult {
        steered: answer
            .get("steered")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
        reason: answer
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .map(str::to_string),
    })
}

fn loop_external_id(folder_id: i32) -> String {
    format!("jenny-loop:{folder_id}")
}

/// Brings one folder's row in line. Returns the row id when something changed.
async fn upsert_loop_row(
    conn: &sea_orm::DatabaseConnection,
    folder_id: i32,
    existing: Option<&conversation::Model>,
    summary: &FolderLoopSummary,
) -> Result<Option<i32>, AppCommandError> {
    let agent_type = summary.agent_type.as_wire().into_owned();
    let status = serde_json::from_value::<conversation::ConversationStatus>(
        serde_json::Value::String(summary.status.to_string()),
    )
    .unwrap_or(conversation::ConversationStatus::Cancelled);
    let now = Utc::now();
    let Some(row) = existing else {
        let inserted = conversation::ActiveModel {
            id: NotSet,
            folder_id: Set(folder_id),
            title: Set(Some(summary.title.clone())),
            // Jenny's state names this row; nothing may auto-title it.
            title_locked: Set(true),
            agent_type: Set(agent_type),
            status: Set(status),
            kind: Set(ConversationKind::Loop),
            model: Set(None),
            git_branch: Set(None),
            external_id: Set(Some(loop_external_id(folder_id))),
            parent_id: Set(None),
            parent_tool_use_id: Set(None),
            delegation_call_id: Set(None),
            message_count: Set(summary.stage_count as i32),
            created_at: Set(summary.created_at.unwrap_or(now)),
            updated_at: Set(summary.updated_at.unwrap_or(now)),
            deleted_at: Set(None),
            pinned_at: Set(None),
            origin_cwd: Set(None),
            assistant_id: Set(None),
            assistant_snapshot: Set(None),
            source: Set(None),
        };
        let row = sea_orm::ActiveModelTrait::insert(inserted, conn)
            .await
            .map_err(|e| AppCommandError::database_error(e.to_string()))?;
        return Ok(Some(row.id));
    };
    // A row the person removed stays removed.
    if row.deleted_at.is_some() {
        return Ok(None);
    }
    let unchanged = row.title.as_deref() == Some(summary.title.as_str())
        && row.status == status
        && row.agent_type == agent_type
        && row.message_count == summary.stage_count as i32;
    let newer = summary.updated_at.filter(|at| *at != row.updated_at);
    if unchanged && newer.is_none() {
        return Ok(None);
    }
    let mut active: conversation::ActiveModel = row.clone().into();
    active.title = Set(Some(summary.title.clone()));
    active.status = Set(status);
    active.agent_type = Set(agent_type);
    active.message_count = Set(summary.stage_count as i32);
    if let Some(at) = newer {
        active.updated_at = Set(at);
    }
    let row = sea_orm::ActiveModelTrait::update(active, conn)
        .await
        .map_err(|e| AppCommandError::database_error(e.to_string()))?;
    Ok(Some(row.id))
}

/// Makes the database say what the Loops on disk say: one `kind = 'loop'` row
/// per folder that has Loops. A Loop started in a folder dodoer doesn't know
/// yet brings that folder in and opens it, so a new Loop always has a place in
/// the sidebar.
pub async fn sync_loop_conversations_core(
    conn: &sea_orm::DatabaseConnection,
    emitter: &EventEmitter,
) -> Result<(), AppCommandError> {
    let folders = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .all(conn)
        .await
        .map_err(|e| AppCommandError::database_error(e.to_string()))?;
    let mut known: HashMap<String, (i32, bool)> = HashMap::new();
    for row in &folders {
        if row.kind != folder::FolderKind::Chat {
            known.insert(row.path.clone(), (row.id, row.is_open));
        }
    }
    let paths: Vec<String> = known.keys().cloned().collect();
    let summaries = tokio::task::spawn_blocking(move || {
        let now = Utc::now();
        let mut seen: HashSet<PathBuf> = paths.iter().map(PathBuf::from).collect();
        let registered = jenny_progress::data_root()
            .map(|root| jenny_loop::registered_loop_folders(&root))
            .unwrap_or_default();
        seen.extend(registered);
        seen.into_iter()
            .filter_map(|path| {
                let summary = jenny_loop::summarize_folder(Path::new(&path), now)?;
                Some((path.to_string_lossy().into_owned(), summary))
            })
            .collect::<Vec<_>>()
    })
    .await
    .map_err(|e| AppCommandError::io_error(format!("Loop scan stopped: {e}")))?;

    let existing = conversation::Entity::find()
        .filter(conversation::Column::Kind.eq(ConversationKind::Loop))
        .all(conn)
        .await
        .map_err(|e| AppCommandError::database_error(e.to_string()))?;

    for (path, summary) in summaries {
        let (folder_id, is_open) = match known.get(&path) {
            Some(known) => *known,
            // Only a Loop at work earns a new sidebar folder; old ones wait for
            // the person to open the folder.
            None if summary.running => {
                let entry = folder_service::ensure_folder_for_path(conn, &path)
                    .await
                    .map_err(AppCommandError::from)?;
                (entry.id, false)
            }
            None => continue,
        };
        let row = existing.iter().find(|r| r.folder_id == folder_id);
        let is_new = row.is_none();
        let Some(changed) = upsert_loop_row(conn, folder_id, row, &summary).await? else {
            continue;
        };
        if is_new && summary.running && !is_open {
            folder_service::set_folder_open(conn, folder_id, true)
                .await
                .map_err(AppCommandError::from)?;
            if let Ok(Some(detail)) = folder_service::get_folder_by_id(conn, folder_id).await {
                emit_folder_upsert(emitter, detail);
            }
        }
        emit_conversation_upsert(emitter, conn, changed).await;
    }
    Ok(())
}

/// Runs for the app's whole life, on the desktop and the server alike.
pub async fn loop_conversation_sync_task(conn: sea_orm::DatabaseConnection, emitter: EventEmitter) {
    loop {
        if let Err(error) = sync_loop_conversations_core(&conn, &emitter).await {
            tracing::warn!(?error, "[jenny-loop] sidebar sync failed");
        }
        tokio::time::sleep(SYNC_INTERVAL).await;
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_loop_conversation(
    db: tauri::State<'_, crate::db::AppDatabase>,
    folder_id: i32,
) -> Result<LoopConversationDetail, AppCommandError> {
    get_loop_conversation_core(&db.conn, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_loop_session_page(
    db: tauri::State<'_, crate::db::AppDatabase>,
    agent_type: AgentType,
    session_id: String,
    before: Option<usize>,
    limit: Option<usize>,
    live: Option<bool>,
) -> Result<LoopSessionPage, AppCommandError> {
    get_loop_session_page_core(
        &db.conn,
        agent_type,
        session_id,
        before,
        limit,
        live.unwrap_or(false),
    )
    .await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn steer_loop(
    db: tauri::State<'_, crate::db::AppDatabase>,
    folder_id: i32,
    loop_id: String,
    message: String,
) -> Result<LoopSteerResult, AppCommandError> {
    steer_loop_core(&db.conn, folder_id, loop_id, message).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::message::ContentBlock;
    use chrono::TimeZone;

    fn turn(id: &str, text: &str) -> MessageTurn {
        MessageTurn {
            id: id.to_string(),
            role: crate::models::message::TurnRole::Assistant,
            blocks: vec![ContentBlock::Text {
                text: text.to_string(),
            }],
            timestamp: Utc.timestamp_opt(1_700_000_000, 0).unwrap(),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    #[test]
    fn a_page_holds_the_newest_turns_before_its_end() {
        let turns: Vec<_> = (0..5).map(|i| turn(&i.to_string(), "x")).collect();
        let (start, window, omitted) = window_turns(&turns, 5, 2, 1024);
        assert_eq!((start, omitted), (3, 0));
        assert_eq!(window[0].id, "3");
        let (start, window, _) = window_turns(&turns, 3, 2, 1024);
        assert_eq!(start, 1);
        assert_eq!(window[1].id, "2");
    }

    #[test]
    fn the_size_limit_stops_a_page_but_always_leaves_one_turn() {
        let big = "x".repeat(2_000);
        let turns = vec![turn("old", &big), turn("new", &big)];
        let (start, window, _) = window_turns(&turns, 2, 10, 2_500);
        assert_eq!(start, 1);
        assert_eq!(window.len(), 1);
        assert_eq!(window[0].id, "new");
    }

    #[test]
    fn one_turn_over_the_limit_keeps_its_latest_steps() {
        let big = "x".repeat(2_000);
        let mut only = turn("only", "first");
        only.blocks.push(ContentBlock::Text { text: big.clone() });
        only.blocks.push(ContentBlock::Text { text: big });
        let (start, window, omitted) = window_turns(&[only], 1, 10, 2_500);
        assert_eq!((start, omitted), (0, 2));
        assert_eq!(window[0].blocks.len(), 1);
    }
}
