//! 计划内重启以后自动接上被打断的对话。
//!
//! 发起重启的一方（Cowork 的 root 进程、桌面 app）停服务之前在数据目录里写
//! `restart-intent.json`。停机时（[`interrupt_turns_for_shutdown`]）意图有效就把这次
//! 打断的对话（`turns`）和后台任务被掐的对话（`background`）写进 `restart-resume.json`；
//! 新进程起来以后（[`run_live`]）先把它改名成 `restart-resume.done.json`，再一个一个
//! 重连这些对话、各发一句固定的话。没有意图的重启（手动重启、崩溃）和原来一样，
//! 只标「被打断」、等人点「继续」。
//!
//! 一次重启只接一遍：文件先改名再接，接到一半进程又挂了，下次启动不会再接。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::models::system::AppLocale;

/// 发起重启的一方写的意图文件。
pub const INTENT_FILE: &str = "restart-intent.json";
/// 停机时写的名单。
pub const RESUME_FILE: &str = "restart-resume.json";
/// 启动时名单改名成这个再接（覆盖旧的）。
pub const RESUME_DONE_FILE: &str = "restart-resume.done.json";
/// `off` / `0` / `false` / `no`：起来以后不接。
pub const RESUME_ENV: &str = "CODEG_RESUME_AFTER_RESTART";
/// 连上的智能体会话记在这个窗口名下。
pub const OWNER_LABEL: &str = "restart-resume";

/// 意图写下以后多久之内的停机才算它的。
const INTENT_MAX_AGE_SECS: i64 = 15 * 60;
/// 意图的时间最多比现在晚这么多（两台机器的钟差一点）。
const INTENT_MAX_AHEAD_SECS: i64 = 60;
/// 停机以后多久之内起来才接。
const RESUME_MAX_AGE_SECS: i64 = 15 * 60;
/// 接完一个、等这么久再接下一个：一起拉起十几个智能体会把内存顶上去。
const RESUME_GAP: Duration = Duration::from_secs(2);

/// `restart-intent.json` 里认的字段。`reason`、`requested_at` 必填，别的可缺，
/// 不认识的字段忽略。
#[derive(Debug, Clone, PartialEq, Deserialize)]
pub struct RestartIntent {
    pub reason: String,
    pub requested_at: DateTime<Utc>,
    #[serde(default)]
    pub from: Option<String>,
    #[serde(default)]
    pub to: Option<String>,
    #[serde(default)]
    pub waited_secs: u64,
    #[serde(default)]
    pub forced: bool,
    #[serde(default = "default_resume")]
    pub resume: bool,
}

fn default_resume() -> bool {
    true
}

/// `restart-resume.json`。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResumeFile {
    /// 意图原样。
    pub intent: serde_json::Value,
    pub turns: Vec<i32>,
    pub background: Vec<i32>,
    pub stopped_at: DateTime<Utc>,
}

/// 意图文件的内容有效时回原样的 JSON 和读出来的字段：读得出来、
/// `requested_at` 在现在之前不超过 15 分钟、也不在将来超过 1 分钟。
pub fn parse_valid_intent(
    raw: &str,
    now: DateTime<Utc>,
) -> Option<(serde_json::Value, RestartIntent)> {
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    let intent: RestartIntent = serde_json::from_value(value.clone()).ok()?;
    let age = now.signed_duration_since(intent.requested_at).num_seconds();
    if !(-INTENT_MAX_AHEAD_SECS..=INTENT_MAX_AGE_SECS).contains(&age) {
        return None;
    }
    Some((value, intent))
}

/// 名单里的哪一份：这次被打断的回合，还是后台任务被掐的对话。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResumeList {
    Turns,
    Background,
}

/// 发给一个对话的那句话。界面语言简体、繁体各一份，别的都用英文；
/// `upgrade` 为假（`reason` 不是 `upgrade`）时说「重启」不说「升级重启」。
pub fn resume_message(lang: AppLocale, list: ResumeList, upgrade: bool) -> String {
    let text = match (lang, list) {
        (AppLocale::ZhCn, ResumeList::Turns) => "（自动发送）服务刚刚升级重启，上一轮没跑完就被打断了，当时正在执行的命令和后台任务都已经停掉。请先检查已经做了哪些，再从那里接着做完。",
        (AppLocale::ZhCn, ResumeList::Background) => "（自动发送）服务刚刚升级重启，这个对话放在后台的任务（后台命令、子智能体）都已经停掉，结果不会再回来。请检查它们做到哪一步了，还需要的就重新跑。",
        (AppLocale::ZhTw, ResumeList::Turns) => "（自動傳送）服務剛剛升級並重新啟動，上一輪還沒跑完就被打斷了，當時正在執行的指令和背景工作都已經停掉。請先檢查已經做了哪些，再從那裡接著做完。",
        (AppLocale::ZhTw, ResumeList::Background) => "（自動傳送）服務剛剛升級並重新啟動，這個對話放在背景的工作（背景指令、子智能體）都已經停掉，結果不會再回來。請檢查它們做到哪一步了，還需要的就重新跑。",
        (_, ResumeList::Turns) => "(Sent automatically) The service was just upgraded and restarted, so the last turn was interrupted before it finished. Commands and background tasks that were running at that moment have been stopped. First check what was already done, then continue from there.",
        (_, ResumeList::Background) => "(Sent automatically) The service was just upgraded and restarted. The background work of this conversation (background commands, sub-agents) has been stopped and its results will not arrive. Check how far it got and run again whatever is still needed.",
    };
    if upgrade {
        return text.to_string();
    }
    match lang {
        AppLocale::ZhCn => text.replacen("升级重启", "重启", 1),
        AppLocale::ZhTw => text.replacen("升級並重新啟動", "重新啟動", 1),
        _ => text.replacen("upgraded and ", "", 1),
    }
}

// ---- 停机 ----

/// 停机时代替 [`crate::commands::conversations::interrupt_running_turns_core`]：先读意图，
/// 照旧把还在跑的回合标成被打断；意图有效就把名单写进 `restart-resume.json`。
/// 要在 `disconnect_all` 之前调（后台任务的名单只在连接上）。不返回错误。
pub async fn interrupt_turns_for_shutdown(
    data_dir: &Path,
    conn: &sea_orm::DatabaseConnection,
    manager: &crate::acp::manager::ConnectionManager,
) {
    let intent = read_intent(data_dir, Utc::now());
    let turns = crate::commands::conversations::interrupt_running_turns_core(conn, manager).await;
    let background = if intent.is_some() {
        manager.conversations_with_background_work().await
    } else {
        Vec::new()
    };
    record_for_restart(data_dir, intent, turns, background, Utc::now());
}

/// 读意图文件，有效时回原样的 JSON。没有这个文件不打日志。
fn read_intent(data_dir: &Path, now: DateTime<Utc>) -> Option<serde_json::Value> {
    let path = data_dir.join(INTENT_FILE);
    match std::fs::read_to_string(&path) {
        Ok(raw) => match parse_valid_intent(&raw, now) {
            Some((value, _)) => Some(value),
            None => {
                tracing::info!("[restart] restart intent is stale or unreadable, ignored");
                None
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => {
            tracing::warn!("[restart] reading the restart intent: {e}");
            None
        }
    }
}

/// 意图有效（`intent` 是 `Some`）时写 `restart-resume.json`（先写临时文件再改名）；
/// 不管有效没有，意图文件有就删掉。`background` 里去掉已经在 `turns` 里的。
/// 写失败只打 warn。
pub fn record_for_restart(
    data_dir: &Path,
    intent: Option<serde_json::Value>,
    turns: Vec<i32>,
    background: Vec<i32>,
    now: DateTime<Utc>,
) {
    if let Some(intent) = intent {
        let background: Vec<i32> = background
            .into_iter()
            .filter(|id| !turns.contains(id))
            .collect();
        let file = ResumeFile {
            intent,
            turns,
            background,
            stopped_at: now,
        };
        match write_resume_file(data_dir, &file) {
            Ok(()) => tracing::info!(
                turns = file.turns.len(),
                background = file.background.len(),
                "[restart] planned restart: conversations to resume recorded"
            ),
            Err(e) => tracing::warn!("[restart] writing the conversations to resume: {e}"),
        }
    }
    match std::fs::remove_file(data_dir.join(INTENT_FILE)) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => tracing::warn!("[restart] removing the restart intent: {e}"),
    }
}

/// 先写临时文件再改名，停机中途被杀不会留下半个文件。
fn write_resume_file(data_dir: &Path, file: &ResumeFile) -> std::io::Result<()> {
    let body = serde_json::to_vec_pretty(file).map_err(std::io::Error::other)?;
    let tmp = data_dir.join(format!("{RESUME_FILE}.tmp"));
    std::fs::write(&tmp, body)?;
    std::fs::rename(&tmp, data_dir.join(RESUME_FILE))
}

// ---- 启动以后 ----

/// 一个对话接的结果。
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResumeOutcome {
    Resumed,
    /// 跳过，带原因的类别（`skipped_gone` 这些）。
    Skipped(&'static str),
    /// 没接上，带类别和错误信息。
    Failed {
        category: &'static str,
        error: String,
    },
}

/// 对话行里决定接不接的几件事。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationFacts {
    pub is_loop: bool,
    /// 现在的状态是 `cancelled`。
    pub cancelled: bool,
    /// 有智能体那边的会话 id（`external_id`）。
    pub has_session: bool,
}

/// 接对话要用到的外面的东西。真的实现（[`LiveResumer`]）去读库、连智能体，测试里用假的。
#[async_trait]
pub trait Resumer: Send + Sync {
    /// 服务端存的界面语言。
    async fn language(&self) -> AppLocale;
    /// 对话行；不存在或已删除回 `None`。
    async fn conversation(&self, conversation_id: i32) -> Option<ConversationFacts>;
    /// 连上这个对话的智能体会话、发 `text`。
    async fn resume(&self, conversation_id: i32, text: &str) -> ResumeOutcome;
}

/// 一次接的汇总。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ResumeReport {
    pub turns: usize,
    pub background: usize,
    pub resumed: usize,
    pub skipped: usize,
    pub failed: usize,
    /// 每个对话的结果，按接的顺序。
    pub outcomes: Vec<(i32, ResumeOutcome)>,
}

/// 读 `restart-resume.json` 按名单逐个接。没有这个文件、不接（太久以前停的、
/// `resume` 是 `false`、`enabled` 为假）都回 `None`。`gap` 是两个之间等多久。
pub async fn resume_after_restart(
    data_dir: &Path,
    now: DateTime<Utc>,
    enabled: bool,
    resumer: &dyn Resumer,
    gap: Duration,
) -> Option<ResumeReport> {
    let file = take_resume_file(data_dir)?;
    let intent: RestartIntent = match serde_json::from_value(file.intent.clone()) {
        Ok(intent) => intent,
        Err(e) => {
            tracing::warn!(
                "[restart] the recorded restart intent is unreadable, not resuming: {e}"
            );
            return None;
        }
    };
    let since_stop = now.signed_duration_since(file.stopped_at).num_seconds();
    if since_stop > RESUME_MAX_AGE_SECS {
        tracing::info!(
            since_stop_secs = since_stop,
            "[restart] not resuming: the service stopped too long ago"
        );
        return None;
    }
    if !intent.resume {
        tracing::info!("[restart] not resuming: the restart intent asked not to");
        return None;
    }
    if !enabled {
        tracing::info!("[restart] not resuming: switched off by {RESUME_ENV}");
        return None;
    }

    let mut turns = file.turns.clone();
    turns.sort_unstable();
    turns.dedup();
    let mut background: Vec<i32> = file
        .background
        .iter()
        .copied()
        .filter(|id| !turns.contains(id))
        .collect();
    background.sort_unstable();
    background.dedup();

    let lang = resumer.language().await;
    let upgrade = intent.reason == "upgrade";
    let started = std::time::Instant::now();
    let mut report = ResumeReport {
        turns: turns.len(),
        background: background.len(),
        ..ResumeReport::default()
    };
    let plan: Vec<(i32, ResumeList)> = turns
        .iter()
        .map(|id| (*id, ResumeList::Turns))
        .chain(background.iter().map(|id| (*id, ResumeList::Background)))
        .collect();
    let mut tried_one = false;
    for (conversation_id, list) in plan {
        let outcome = match resumer.conversation(conversation_id).await {
            None => ResumeOutcome::Skipped("skipped_gone"),
            Some(f) if f.is_loop => ResumeOutcome::Skipped("skipped_loop"),
            Some(f) if list == ResumeList::Turns && !f.cancelled => {
                ResumeOutcome::Skipped("skipped_moved_on")
            }
            Some(f) if !f.has_session => ResumeOutcome::Skipped("skipped_no_session"),
            Some(_) => {
                if tried_one && !gap.is_zero() {
                    tokio::time::sleep(gap).await;
                }
                tried_one = true;
                resumer
                    .resume(conversation_id, &resume_message(lang, list, upgrade))
                    .await
            }
        };
        match &outcome {
            ResumeOutcome::Resumed => {
                report.resumed += 1;
                tracing::info!(conversation_id, "[restart] conversation resumed");
            }
            ResumeOutcome::Skipped(category) => {
                report.skipped += 1;
                tracing::info!(
                    conversation_id,
                    category = *category,
                    "[restart] conversation not resumed"
                );
            }
            ResumeOutcome::Failed { category, error } => {
                report.failed += 1;
                tracing::warn!(
                    conversation_id,
                    category = *category,
                    error = %crate::telemetry::scrub::scrub_text(error),
                    "[restart] resuming a conversation failed"
                );
            }
        }
        report.outcomes.push((conversation_id, outcome));
    }

    tracing::info!(
        reason = %intent.reason,
        forced = intent.forced,
        waited_secs = intent.waited_secs,
        from_release = intent.from.as_deref().unwrap_or("-"),
        to_release = intent.to.as_deref().unwrap_or("-"),
        turns = report.turns,
        background = report.background,
        resumed = report.resumed,
        skipped = report.skipped,
        failed = report.failed,
        resume_ms = started.elapsed().as_millis() as u64,
        "[restart] planned restart finished"
    );
    if report.failed > 0 {
        tracing::error!(
            failed = report.failed,
            "[restart] {} conversation(s) could not be resumed after a planned restart",
            report.failed
        );
    }
    Some(report)
}

/// 有 `restart-resume.json` 就先改名成 `restart-resume.done.json`（覆盖旧的）再读：
/// 接到一半进程又挂了，下次启动不会再接一遍。改不了名就不接。
fn take_resume_file(data_dir: &Path) -> Option<ResumeFile> {
    let path = data_dir.join(RESUME_FILE);
    if !path.exists() {
        return None;
    }
    let done = data_dir.join(RESUME_DONE_FILE);
    if let Err(e) = std::fs::rename(&path, &done) {
        tracing::warn!("[restart] cannot set the conversations to resume aside, not resuming: {e}");
        return None;
    }
    let parsed = std::fs::read_to_string(&done)
        .map_err(|e| e.to_string())
        .and_then(|raw| serde_json::from_str::<ResumeFile>(&raw).map_err(|e| e.to_string()));
    match parsed {
        Ok(file) => Some(file),
        Err(e) => {
            tracing::warn!("[restart] the conversations to resume are unreadable: {e}");
            None
        }
    }
}

/// `CODEG_RESUME_AFTER_RESTART` 的值允不允许接。
pub fn resume_enabled_by(value: Option<&str>) -> bool {
    !value.is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "off" | "0" | "false" | "no"
        )
    })
}

// ---- 真的实现 ----

/// 读库、连智能体的 [`Resumer`]。
pub struct LiveResumer {
    pub db: crate::db::AppDatabase,
    pub manager: crate::acp::manager::ConnectionManager,
    pub emitter: crate::web::event_bridge::EventEmitter,
    pub data_dir: PathBuf,
}

#[async_trait]
impl Resumer for LiveResumer {
    async fn language(&self) -> AppLocale {
        crate::commands::system_settings::load_system_language_settings(&self.db.conn)
            .await
            .map(|s| s.language)
            .unwrap_or_default()
    }

    async fn conversation(&self, conversation_id: i32) -> Option<ConversationFacts> {
        use crate::db::entities::conversation;
        let row = live_row(&self.db.conn, conversation_id).await?;
        Some(ConversationFacts {
            is_loop: row.kind == conversation::ConversationKind::Loop,
            cancelled: row.status == conversation::ConversationStatus::Cancelled,
            has_session: row.external_id.as_deref().is_some_and(|s| !s.is_empty()),
        })
    }

    async fn resume(&self, conversation_id: i32, text: &str) -> ResumeOutcome {
        use crate::acp::error::AcpError;
        use crate::acp::types::{ConnectionStatus, PromptInputBlock};

        let Some(row) = live_row(&self.db.conn, conversation_id).await else {
            return ResumeOutcome::Skipped("skipped_gone");
        };
        let Some(session_id) = row.external_id.clone().filter(|s| !s.is_empty()) else {
            return ResumeOutcome::Skipped("skipped_no_session");
        };
        let folder = match crate::db::service::folder_service::get_folder_by_id(
            &self.db.conn,
            row.folder_id,
        )
        .await
        {
            Ok(Some(folder)) => folder,
            _ => return ResumeOutcome::Skipped("skipped_no_folder"),
        };
        let agent_type =
            crate::db::service::conversation_service::parse_agent_type(&row.agent_type);
        if crate::commands::acp::verify_agent_installed(agent_type)
            .await
            .is_err()
        {
            return ResumeOutcome::Skipped("skipped_agent_missing");
        }
        if let Some(existing) = self
            .manager
            .find_connection_by_conversation_id(conversation_id)
            .await
        {
            if let Some(state) = self.manager.get_state(&existing).await {
                if state.read().await.status == ConnectionStatus::Prompting {
                    return ResumeOutcome::Skipped("skipped_busy");
                }
            }
        }
        let runtime_env = match crate::commands::acp::build_session_runtime_env(
            &self.db,
            agent_type,
            Some(&session_id),
            &self.data_dir,
        )
        .await
        {
            Ok(env) => env,
            Err(e) => return failed("failed_connect", e.to_string()),
        };
        let prefs = crate::acp::session_prefs::resolve_connect_prefs(
            &self.db.conn,
            agent_type,
            Some(&session_id),
            None,
            BTreeMap::new(),
        )
        .await;
        let working_dir = row
            .origin_cwd
            .clone()
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| folder.path.clone());
        let outcome = match self
            .manager
            .spawn_agent_with_outcome(
                agent_type,
                Some(working_dir),
                Some(session_id.clone()),
                runtime_env,
                OWNER_LABEL.to_string(),
                self.emitter.clone(),
                prefs.mode_id,
                prefs.config_values,
            )
            .await
        {
            Ok(outcome) => outcome,
            Err(e) => return failed("failed_connect", e.to_string()),
        };
        // 续会话失败时连接会一路回退到新会话，新会话的 id 和原来的不一样：
        // 那样智能体不记得上文，不发那句话，记成没接上。
        if let Some(state) = self.manager.get_state(&outcome.connection_id).await {
            let now_session = state.read().await.external_id.clone();
            if now_session.is_some_and(|s| s != session_id) {
                if !outcome.reused {
                    let _ = self.manager.disconnect(&outcome.connection_id).await;
                }
                return failed(
                    "session_not_resumed",
                    "the agent started a new session instead of resuming".to_string(),
                );
            }
        }
        match self
            .manager
            .send_prompt_linked(
                &self.db,
                &outcome.connection_id,
                vec![PromptInputBlock::Text {
                    text: text.to_string(),
                }],
                Some(row.folder_id),
                Some(conversation_id),
                None,
            )
            .await
        {
            Ok(_) => ResumeOutcome::Resumed,
            Err(AcpError::TurnInProgress) => ResumeOutcome::Skipped("skipped_busy"),
            Err(e) => failed("failed_send", e.to_string()),
        }
    }
}

fn failed(category: &'static str, error: String) -> ResumeOutcome {
    ResumeOutcome::Failed { category, error }
}

/// 没删除的对话行。
async fn live_row(
    conn: &sea_orm::DatabaseConnection,
    conversation_id: i32,
) -> Option<crate::db::entities::conversation::Model> {
    use sea_orm::EntityTrait;
    match crate::db::entities::conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await
    {
        Ok(Some(row)) if row.deleted_at.is_none() => Some(row),
        Ok(_) => None,
        Err(e) => {
            tracing::warn!(conversation_id, "[restart] reading conversation: {e}");
            None
        }
    }
}

/// 服务起来、开始接请求以后起一个任务调它：有 `restart-resume.json` 就按名单接。
pub async fn run_live(resumer: LiveResumer) {
    let enabled = resume_enabled_by(std::env::var(RESUME_ENV).ok().as_deref());
    let data_dir = resumer.data_dir.clone();
    resume_after_restart(&data_dir, Utc::now(), enabled, &resumer, RESUME_GAP).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    const NOW: &str = "2026-11-17T20:00:00Z";

    fn intent_at(requested_at: &str) -> String {
        format!(
            r#"{{"reason":"upgrade","from":"cowork-codeg-v0.6.39","to":"cowork-codeg-v0.6.40","requested_at":"{requested_at}","waited_secs":1800,"forced":true,"resume":true,"extra":1}}"#
        )
    }

    // ---- 完成标准 13：意图有效 ----

    #[test]
    fn a_fresh_intent_is_valid() {
        let (value, intent) =
            parse_valid_intent(&intent_at("2026-11-17T19:59:30Z"), at(NOW)).expect("valid");
        assert_eq!(intent.reason, "upgrade");
        assert_eq!(intent.from.as_deref(), Some("cowork-codeg-v0.6.39"));
        assert_eq!(intent.to.as_deref(), Some("cowork-codeg-v0.6.40"));
        assert_eq!(intent.waited_secs, 1800);
        assert!(intent.forced);
        assert!(intent.resume);
        assert_eq!(value["extra"], serde_json::json!(1), "原样留着不认识的字段");
    }

    #[test]
    fn an_intent_16_minutes_old_is_not_valid() {
        assert!(parse_valid_intent(&intent_at("2026-11-17T19:44:00Z"), at(NOW)).is_none());
    }

    #[test]
    fn an_intent_5_minutes_ahead_is_not_valid() {
        assert!(parse_valid_intent(&intent_at("2026-11-17T20:05:00Z"), at(NOW)).is_none());
    }

    #[test]
    fn an_intent_a_few_seconds_ahead_is_valid() {
        assert!(parse_valid_intent(&intent_at("2026-11-17T20:00:20Z"), at(NOW)).is_some());
    }

    #[test]
    fn bad_json_is_not_valid() {
        assert!(parse_valid_intent("{not json", at(NOW)).is_none());
    }

    #[test]
    fn an_intent_without_reason_is_not_valid() {
        let raw = r#"{"requested_at":"2026-11-17T19:59:00Z"}"#;
        assert!(parse_valid_intent(raw, at(NOW)).is_none());
    }

    #[test]
    fn missing_optional_fields_take_their_defaults() {
        let raw = r#"{"reason":"desktop_update","requested_at":"2026-11-17T19:59:00Z"}"#;
        let (_, intent) = parse_valid_intent(raw, at(NOW)).expect("valid");
        assert!(intent.resume);
        assert!(!intent.forced);
        assert_eq!(intent.waited_secs, 0);
        assert_eq!(intent.from, None);
        assert_eq!(intent.to, None);
    }

    // ---- 完成标准 17：发的那句话 ----

    #[test]
    fn zh_cn_interrupted_turn_after_upgrade() {
        assert_eq!(
            resume_message(AppLocale::ZhCn, ResumeList::Turns, true),
            "（自动发送）服务刚刚升级重启，上一轮没跑完就被打断了，当时正在执行的命令和后台任务都已经停掉。请先检查已经做了哪些，再从那里接着做完。"
        );
    }

    #[test]
    fn zh_cn_background_after_plain_restart() {
        assert_eq!(
            resume_message(AppLocale::ZhCn, ResumeList::Background, false),
            "（自动发送）服务刚刚重启，这个对话放在后台的任务（后台命令、子智能体）都已经停掉，结果不会再回来。请检查它们做到哪一步了，还需要的就重新跑。"
        );
    }

    #[test]
    fn zh_tw_background_after_upgrade() {
        assert_eq!(
            resume_message(AppLocale::ZhTw, ResumeList::Background, true),
            "（自動傳送）服務剛剛升級並重新啟動，這個對話放在背景的工作（背景指令、子智能體）都已經停掉，結果不會再回來。請檢查它們做到哪一步了，還需要的就重新跑。"
        );
    }

    #[test]
    fn zh_tw_interrupted_turn_after_plain_restart() {
        assert_eq!(
            resume_message(AppLocale::ZhTw, ResumeList::Turns, false),
            "（自動傳送）服務剛剛重新啟動，上一輪還沒跑完就被打斷了，當時正在執行的指令和背景工作都已經停掉。請先檢查已經做了哪些，再從那裡接著做完。"
        );
    }

    #[test]
    fn en_interrupted_turn_after_upgrade() {
        assert_eq!(
            resume_message(AppLocale::En, ResumeList::Turns, true),
            "(Sent automatically) The service was just upgraded and restarted, so the last turn was interrupted before it finished. Commands and background tasks that were running at that moment have been stopped. First check what was already done, then continue from there."
        );
    }

    #[test]
    fn en_background_after_plain_restart() {
        assert_eq!(
            resume_message(AppLocale::En, ResumeList::Background, false),
            "(Sent automatically) The service was just restarted. The background work of this conversation (background commands, sub-agents) has been stopped and its results will not arrive. Check how far it got and run again whatever is still needed."
        );
    }

    #[test]
    fn other_languages_use_english() {
        for lang in [AppLocale::Ja, AppLocale::De, AppLocale::Ar] {
            assert_eq!(
                resume_message(lang, ResumeList::Turns, true),
                resume_message(AppLocale::En, ResumeList::Turns, true)
            );
        }
    }

    // ---- 完成标准 14：停机时记名单 ----

    fn intent_value() -> serde_json::Value {
        serde_json::from_str(&intent_at("2026-11-17T19:59:00Z")).unwrap()
    }

    #[test]
    fn a_valid_intent_writes_the_lists_and_removes_the_intent() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(INTENT_FILE), "{}").unwrap();
        record_for_restart(
            dir.path(),
            Some(intent_value()),
            vec![5, 2],
            vec![2, 9],
            at(NOW),
        );
        let raw = std::fs::read_to_string(dir.path().join(RESUME_FILE)).expect("written");
        let file: ResumeFile = serde_json::from_str(&raw).unwrap();
        assert_eq!(file.intent, intent_value());
        assert_eq!(file.turns, vec![5, 2]);
        assert_eq!(file.background, vec![9], "已经在 turns 里的不再算后台");
        assert_eq!(file.stopped_at, at(NOW));
        assert!(!dir.path().join(INTENT_FILE).exists());
    }

    #[test]
    fn without_a_valid_intent_nothing_is_written_and_the_intent_goes() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(INTENT_FILE), "{stale").unwrap();
        record_for_restart(dir.path(), None, vec![1], vec![2], at(NOW));
        assert!(!dir.path().join(RESUME_FILE).exists());
        assert!(!dir.path().join(INTENT_FILE).exists());
    }

    // ---- 完成标准 18：按名单逐个接 ----

    struct Fake {
        data_dir: PathBuf,
        facts: HashMap<i32, ConversationFacts>,
        fail: HashSet<i32>,
        calls: Mutex<Vec<(i32, String)>>,
        /// `language()` 被调的那一刻两个文件在不在：(restart-resume.json, done)。
        files_at_start: Mutex<Option<(bool, bool)>>,
    }

    fn facts(cancelled: bool) -> ConversationFacts {
        ConversationFacts {
            is_loop: false,
            cancelled,
            has_session: true,
        }
    }

    impl Fake {
        fn new(dir: &Path, ids: &[i32]) -> Self {
            Self {
                data_dir: dir.to_path_buf(),
                facts: ids.iter().map(|id| (*id, facts(true))).collect(),
                fail: HashSet::new(),
                calls: Mutex::new(Vec::new()),
                files_at_start: Mutex::new(None),
            }
        }
        fn calls(&self) -> Vec<(i32, String)> {
            self.calls.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl Resumer for Fake {
        async fn language(&self) -> AppLocale {
            *self.files_at_start.lock().unwrap() = Some((
                self.data_dir.join(RESUME_FILE).exists(),
                self.data_dir.join(RESUME_DONE_FILE).exists(),
            ));
            AppLocale::En
        }
        async fn conversation(&self, conversation_id: i32) -> Option<ConversationFacts> {
            self.facts.get(&conversation_id).cloned()
        }
        async fn resume(&self, conversation_id: i32, text: &str) -> ResumeOutcome {
            self.calls
                .lock()
                .unwrap()
                .push((conversation_id, text.to_string()));
            if self.fail.contains(&conversation_id) {
                failed("failed_send", "boom".into())
            } else {
                ResumeOutcome::Resumed
            }
        }
    }

    fn write_resume(dir: &Path, turns: &[i32], background: &[i32], stopped_at: &str) {
        let file = ResumeFile {
            intent: intent_value(),
            turns: turns.to_vec(),
            background: background.to_vec(),
            stopped_at: at(stopped_at),
        };
        std::fs::write(dir.join(RESUME_FILE), serde_json::to_string(&file).unwrap()).unwrap();
    }

    async fn run(fake: &Fake, enabled: bool) -> Option<ResumeReport> {
        resume_after_restart(&fake.data_dir, at(NOW), enabled, fake, Duration::ZERO).await
    }

    #[tokio::test]
    async fn turns_first_then_background_each_by_id() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[3, 1], &[2], "2026-11-17T19:59:30Z");
        let fake = Fake::new(dir.path(), &[1, 2, 3]);
        let report = run(&fake, true).await.expect("ran");
        let turn_text = resume_message(AppLocale::En, ResumeList::Turns, true);
        let bg_text = resume_message(AppLocale::En, ResumeList::Background, true);
        assert_eq!(
            fake.calls(),
            vec![(1, turn_text.clone()), (3, turn_text), (2, bg_text)]
        );
        assert_eq!(report.resumed, 3);
        assert_eq!(report.turns, 2);
        assert_eq!(report.background, 1);
    }

    #[tokio::test]
    async fn one_failure_does_not_stop_the_rest() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[3, 1], &[2], "2026-11-17T19:59:30Z");
        let mut fake = Fake::new(dir.path(), &[1, 2, 3]);
        fake.fail.insert(3);
        let report = run(&fake, true).await.expect("ran");
        let ids: Vec<i32> = fake.calls().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec![1, 3, 2]);
        assert_eq!(report.resumed, 2);
        assert_eq!(report.failed, 1);
    }

    #[tokio::test]
    async fn a_turn_that_moved_on_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[1, 4], &[], "2026-11-17T19:59:30Z");
        let mut fake = Fake::new(dir.path(), &[1, 4]);
        fake.facts.insert(4, facts(false));
        let report = run(&fake, true).await.expect("ran");
        let ids: Vec<i32> = fake.calls().into_iter().map(|(id, _)| id).collect();
        assert_eq!(ids, vec![1]);
        assert_eq!(report.skipped, 1);
        assert!(report
            .outcomes
            .contains(&(4, ResumeOutcome::Skipped("skipped_moved_on"))));
    }

    #[tokio::test]
    async fn gone_loop_and_sessionless_conversations_are_skipped() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[1, 2, 3], &[], "2026-11-17T19:59:30Z");
        let mut fake = Fake::new(dir.path(), &[2, 3]);
        fake.facts.insert(
            2,
            ConversationFacts {
                is_loop: true,
                cancelled: true,
                has_session: true,
            },
        );
        fake.facts.insert(
            3,
            ConversationFacts {
                is_loop: false,
                cancelled: true,
                has_session: false,
            },
        );
        let report = run(&fake, true).await.expect("ran");
        assert!(fake.calls().is_empty());
        assert_eq!(
            report.outcomes,
            vec![
                (1, ResumeOutcome::Skipped("skipped_gone")),
                (2, ResumeOutcome::Skipped("skipped_loop")),
                (3, ResumeOutcome::Skipped("skipped_no_session")),
            ]
        );
    }

    #[tokio::test]
    async fn the_file_is_renamed_before_resuming() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[1], &[], "2026-11-17T19:59:30Z");
        let fake = Fake::new(dir.path(), &[1]);
        run(&fake, true).await.expect("ran");
        assert_eq!(*fake.files_at_start.lock().unwrap(), Some((false, true)));
        assert!(!dir.path().join(RESUME_FILE).exists());
        assert!(dir.path().join(RESUME_DONE_FILE).exists());
    }

    #[tokio::test]
    async fn a_stop_20_minutes_ago_resumes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[1], &[2], "2026-11-17T19:40:00Z");
        let fake = Fake::new(dir.path(), &[1, 2]);
        assert!(run(&fake, true).await.is_none());
        assert!(fake.calls().is_empty());
        assert!(!dir.path().join(RESUME_FILE).exists(), "也改了名");
    }

    #[tokio::test]
    async fn switched_off_resumes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        write_resume(dir.path(), &[1], &[2], "2026-11-17T19:59:30Z");
        let fake = Fake::new(dir.path(), &[1, 2]);
        assert!(run(&fake, false).await.is_none());
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn an_intent_that_says_no_resume_resumes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let mut intent = intent_value();
        intent["resume"] = serde_json::json!(false);
        let file = ResumeFile {
            intent,
            turns: vec![1],
            background: vec![],
            stopped_at: at("2026-11-17T19:59:30Z"),
        };
        std::fs::write(
            dir.path().join(RESUME_FILE),
            serde_json::to_string(&file).unwrap(),
        )
        .unwrap();
        let fake = Fake::new(dir.path(), &[1]);
        assert!(run(&fake, true).await.is_none());
        assert!(fake.calls().is_empty());
    }

    #[tokio::test]
    async fn no_file_does_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = Fake::new(dir.path(), &[1]);
        assert!(run(&fake, true).await.is_none());
        assert!(fake.files_at_start.lock().unwrap().is_none());
        assert!(!dir.path().join(RESUME_DONE_FILE).exists());
    }

    #[test]
    fn the_switch_reads_off_values() {
        for off in ["off", "0", "false", "no", " OFF "] {
            assert!(!resume_enabled_by(Some(off)), "{off}");
        }
        for on in [None, Some("on"), Some("1"), Some("")] {
            assert!(resume_enabled_by(on), "{on:?}");
        }
    }
}
