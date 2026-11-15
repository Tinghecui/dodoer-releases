//! Cowork fork: an agent moves its own conversation to where it works
//! (`docs/agent-relocate.md`).
//!
//! Two codeg-mcp tools, group `relocate` ([`COMPANION_FEATURE`]):
//!
//! - `continue_in_worktree`: a new worktree on a new branch (made the way the
//!   composer's "start in a new branch" makes one, optionally carrying the
//!   checkout's uncommitted changes over), or a worktree the agent made itself.
//! - `adopt_project`: a directory on this machine, opened as a project.
//!
//! Each call shows the person a card first (the `ask_user_question` card, as
//! `use_device` does) and does nothing without their yes. Once they agree, the
//! worktree / project is there at once, and the conversation itself moves when
//! it is idle again — the agent is mid-turn when it calls, and a move ends the
//! connection — through the same path as "Move to project…"
//! ([`super::conversations::move_conversation_for_agent`]). The pending move
//! lives in memory only: a restart before it happens leaves the conversation
//! where it was, with the worktree / project still there.
//!
//! Only the caller's own top-level conversation is ever moved; nothing here
//! closes, renames or removes a project.

use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::conversations::{move_conversation_for_agent, MoveSkipReason};
use crate::acp::delegation::transport::RelocateOp;
use crate::acp::manager::ConnectionManager;
use crate::acp::question::{QuestionOption, QuestionSpec, SessionQuestionAccess};
use crate::acp::types::ConnectionStatus;
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder::{self, FolderKind};
use crate::db::AppDatabase;
use crate::web::event_bridge::EventEmitter;

/// The codeg-mcp `--features` group of the two tools.
pub const COMPANION_FEATURE: &str = "relocate";

/// The card's chip.
const CARD_HEADER: &str = "挪对话";

/// Files listed on the card before "and N more".
const CARD_FILES_SHOWN: usize = 20;

/// How often a pending move checks whether its conversation is idle.
const RETRY_EVERY: Duration = Duration::from_secs(2);

/// A pending move still waiting after this long is dropped.
const GIVE_UP_AFTER: Duration = Duration::from_secs(24 * 60 * 60);

const CARRY: &str = "转过去，带上这些改动";
const LEAVE: &str = "转过去，改动留在原处";
const GO: &str = "转过去";
const NO_GO: &str = "不转";
const ADD_AND_MOVE: &str = "加进去并移过去";
const ADD_ONLY: &str = "只加到侧栏";
const MOVE: &str = "移过去";
const NEITHER: &str = "都不要";

/// What both tools answer: words for the agent, and the same as data.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RelocateAnswer {
    /// The person agreed and it was done; `false` for a refusal, a "no", or
    /// a failure (the text says which).
    pub ok: bool,
    pub text: String,
    /// The worktree's / project's directory.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    /// Its folder.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder_id: Option<i32>,
    /// The conversation moves there once it is idle.
    pub moves: bool,
}

impl RelocateAnswer {
    /// Where nothing serves the tools.
    pub fn unavailable() -> Self {
        Self::refused("Moving this conversation is not available here.")
    }

    fn refused(text: impl Into<String>) -> Self {
        Self {
            ok: false,
            text: text.into(),
            path: None,
            folder_id: None,
            moves: false,
        }
    }
}

/// The uncommitted changes of a checkout, as repo-relative paths.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Changes {
    /// Tracked files that differ from `HEAD` (staged or not; both sides of a
    /// rename).
    pub tracked: Vec<String>,
    /// Untracked files that are not ignored.
    pub untracked: Vec<String>,
}

impl Changes {
    fn is_empty(&self) -> bool {
        self.tracked.is_empty() && self.untracked.is_empty()
    }

    fn all(&self) -> BTreeSet<&str> {
        self.tracked
            .iter()
            .chain(&self.untracked)
            .map(String::as_str)
            .collect()
    }
}

/// What [`carry_changes`] could not clean up in the original checkout after
/// the changes were safely in the worktree.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CarryReport {
    pub left_behind: Vec<String>,
}

/// The tools, for the conversations of this process.
pub struct RelocateTools {
    db: AppDatabase,
    emitter: EventEmitter,
    manager: ConnectionManager,
    questions: Arc<dyn SessionQuestionAccess>,
    /// Conversation → the generation of its pending move. A later move of the
    /// same conversation replaces an earlier one.
    pending: Mutex<HashMap<i32, u64>>,
    generation: AtomicU64,
}

static TOOLS: OnceLock<Arc<RelocateTools>> = OnceLock::new();

/// Serve the tools from this process, once.
pub fn install(tools: Arc<RelocateTools>) {
    if TOOLS.set(tools).is_err() {
        tracing::warn!("[relocate] the relocate tools were installed twice");
    }
}

pub fn installed() -> Option<&'static Arc<RelocateTools>> {
    TOOLS.get()
}

/// `features` (a codeg-mcp `--features` value) with the relocate tools, where
/// this process serves them.
pub fn with_companion_feature(features: String) -> String {
    if installed().is_some() {
        format!("{features},{COMPANION_FEATURE}")
    } else {
        features
    }
}

/// Withdraws the card when the call waiting on it is dropped (the agent's
/// call was cancelled) before the person answered.
struct Withdraw {
    questions: Arc<dyn SessionQuestionAccess>,
    connection: String,
    question: String,
    armed: bool,
}

impl Drop for Withdraw {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let questions = Arc::clone(&self.questions);
        let connection = std::mem::take(&mut self.connection);
        let question = std::mem::take(&mut self.question);
        tokio::spawn(async move {
            questions.cancel_question(&connection, &question).await;
        });
    }
}

/// The caller's conversation and the folder it is in.
struct Caller {
    conversation: conversation::Model,
    folder: folder::Model,
}

impl RelocateTools {
    pub fn new(
        db: AppDatabase,
        emitter: EventEmitter,
        manager: ConnectionManager,
        questions: Arc<dyn SessionQuestionAccess>,
    ) -> Self {
        Self {
            db,
            emitter,
            manager,
            questions,
            pending: Mutex::new(HashMap::new()),
            generation: AtomicU64::new(0),
        }
    }

    fn conn(&self) -> &DatabaseConnection {
        &self.db.conn
    }

    /// The tool `op`, for the conversation on `connection_id`.
    pub async fn answer(self: &Arc<Self>, connection_id: &str, op: RelocateOp) -> RelocateAnswer {
        let caller = match self.caller(connection_id).await {
            Ok(caller) => caller,
            Err(text) => return RelocateAnswer::refused(text),
        };
        match op {
            RelocateOp::Worktree { branch, path } => {
                self.worktree(connection_id, caller, branch, path).await
            }
            RelocateOp::Project { path } => self.project(connection_id, caller, &path).await,
        }
    }

    async fn caller(&self, connection_id: &str) -> Result<Caller, String> {
        let state = self
            .manager
            .get_state(connection_id)
            .await
            .ok_or("This conversation's connection is gone.")?;
        let id = state.read().await.conversation_id;
        let id = id.ok_or(
            "This conversation is not saved yet, so it cannot be moved. Try again after your \
             first reply.",
        )?;
        let conversation = conversation::Entity::find_by_id(id)
            .filter(conversation::Column::DeletedAt.is_null())
            .one(self.conn())
            .await
            .ok()
            .flatten()
            .ok_or("This conversation no longer exists.")?;
        if conversation.parent_id.is_some() {
            return Err(
                "A delegated conversation does not move on its own: it moves with the \
                        conversation that started it. Leave this to that conversation's agent."
                    .to_string(),
            );
        }
        if !matches!(
            conversation.kind,
            ConversationKind::Regular | ConversationKind::Chat
        ) {
            return Err("This kind of conversation cannot be moved.".to_string());
        }
        let owned =
            crate::db::service::work_task_service::conversations_bound_to_tasks(self.conn(), &[id])
                .await
                .unwrap_or_default();
        if owned.contains(&id) {
            return Err(
                "This conversation belongs to a to-do task, which decides where it \
                        works. It cannot be moved."
                    .to_string(),
            );
        }
        let folder = folder::Entity::find_by_id(conversation.folder_id)
            .one(self.conn())
            .await
            .ok()
            .flatten()
            .ok_or("This conversation's folder no longer exists.")?;
        Ok(Caller {
            conversation,
            folder,
        })
    }

    // -- continue_in_worktree ------------------------------------------------

    async fn worktree(
        self: &Arc<Self>,
        connection_id: &str,
        caller: Caller,
        branch: Option<String>,
        path: Option<String>,
    ) -> RelocateAnswer {
        let folder = &caller.folder;
        if folder.parent_id.is_some() {
            return RelocateAnswer::refused(format!(
                "This conversation already works in a worktree (`{}`), and stays there. Make \
                 the new branch there with git if the user wants one.",
                folder.path
            ));
        }
        if folder.kind != FolderKind::Regular {
            return RelocateAnswer::refused(
                "This conversation is not in a project, so there is no repository to branch \
                 from. If the work is in a project directory, use adopt_project first.",
            );
        }
        if crate::git_repo::ensure_git_repo(&folder.path).is_err() {
            return RelocateAnswer::refused(format!(
                "`{}` is not a git repository, so there is no branch to move to.",
                folder.path
            ));
        }
        match (branch, path) {
            (_, Some(path)) => self.existing_worktree(connection_id, caller, &path).await,
            (Some(branch), None) => self.new_worktree(connection_id, caller, &branch).await,
            (None, None) => RelocateAnswer::refused(
                "Pass `branch` (the new branch's name) to have a worktree made, or `path` (a \
                 worktree you already made).",
            ),
        }
    }

    async fn existing_worktree(
        self: &Arc<Self>,
        connection_id: &str,
        caller: Caller,
        path: &str,
    ) -> RelocateAnswer {
        let folder = &caller.folder;
        let path = trim_path(path);
        let dir = Path::new(&path);
        if !dir.is_absolute() || !dir.is_dir() {
            return RelocateAnswer::refused(format!(
                "`{path}` is not an existing directory (give an absolute path)."
            ));
        }
        let Some(main) = crate::git_repo::main_worktree_root(dir) else {
            return RelocateAnswer::refused(format!(
                "`{path}` is not a linked git worktree. Pass `branch` instead to have one made."
            ));
        };
        if !same_dir(&main, Path::new(&folder.path)) {
            return RelocateAnswer::refused(format!(
                "`{path}` is a worktree of `{}`, not of this conversation's repository `{}`.",
                main.display(),
                folder.path
            ));
        }
        let branch = current_branch(dir).await;
        let question = format!(
            "这个对话要转到分支 {}（worktree：{path}）。回复结束后对话挪到这个 worktree 下面，之后不能再挪回「{}」。",
            branch.as_deref().unwrap_or("（分离的 HEAD）"),
            display_name(folder),
        );
        let options = vec![
            option(GO, "回复结束后对话挪过去"),
            option(NO_GO, "什么都不做"),
        ];
        match self.ask(connection_id, question, options).await {
            Ok(choice) if choice == GO => {}
            Ok(_) => return declined(),
            Err(text) => return RelocateAnswer::refused(text),
        }
        let worktree = match super::folders::open_worktree_folder_core(
            &self.db,
            path.clone(),
            folder.id,
        )
        .await
        {
            Ok(worktree) => worktree,
            Err(e) => {
                return RelocateAnswer::refused(format!(
                    "The user agreed, but the worktree could not be added: {e}"
                ))
            }
        };
        super::folders::emit_folder_upsert(&self.emitter, worktree.clone());
        self.schedule(caller.conversation.id, worktree.id);
        RelocateAnswer {
            ok: true,
            text: format!(
                "The user agreed. Do the rest of this turn in `{path}`. This conversation moves to \
                 that worktree once your reply has finished; its next turn starts there."
            ),
            path: Some(path),
            folder_id: Some(worktree.id),
            moves: true,
        }
    }

    async fn new_worktree(
        self: &Arc<Self>,
        connection_id: &str,
        caller: Caller,
        branch: &str,
    ) -> RelocateAnswer {
        let folder = &caller.folder;
        let root = PathBuf::from(&folder.path);
        let branch = branch.trim();
        if git(&root, &["check-ref-format", "--branch", branch])
            .await
            .is_err()
        {
            return RelocateAnswer::refused(format!(
                "`{branch}` is not a valid branch name. Pick another one."
            ));
        }
        let head = match git(&root, &["rev-parse", "--verify", "HEAD"]).await {
            Ok(out) => String::from_utf8_lossy(&out).trim().to_string(),
            Err(_) => {
                return RelocateAnswer::refused(format!(
                    "`{}` has no commits yet, so there is nothing to branch from.",
                    folder.path
                ))
            }
        };
        let changes = match list_changes(&root, &head).await {
            Ok(changes) => changes,
            Err(e) => {
                return RelocateAnswer::refused(format!(
                    "Could not read the uncommitted changes in `{}`: {e}",
                    folder.path
                ))
            }
        };
        let others = self.others_running(folder.id, caller.conversation.id).await;
        let (question, options) = worktree_card(branch, &display_name(folder), &changes, &others);
        let carry = match self.ask(connection_id, question, options).await {
            Ok(choice) if choice == CARRY => true,
            Ok(choice) if choice == LEAVE || choice == GO => false,
            Ok(_) => return declined(),
            Err(text) => return RelocateAnswer::refused(text),
        };
        let spec = super::folders::ConversationWorktreeSpec::BranchOff {
            branch: branch.to_string(),
            base: Some(head.clone()),
        };
        let created = match super::folders::create_conversation_worktree_core(
            &self.emitter,
            &self.db,
            folder.id,
            spec,
        )
        .await
        {
            Ok(created) => created,
            Err(e) => {
                return RelocateAnswer::refused(format!(
                    "The user agreed, but the worktree could not be made: {e}. Nothing else was \
                     changed."
                ))
            }
        };
        let worktree = created.folder;
        super::folders::emit_folder_upsert(&self.emitter, worktree.clone());
        let wt_path = worktree.path.clone();
        let mut text =
            format!("The user agreed. The new worktree is `{wt_path}`, on branch `{branch}`.");
        if carry {
            match carry_changes(&root, Path::new(&wt_path), &head, &changes).await {
                Ok(report) => {
                    text.push_str(&format!(
                        " The {} uncommitted change(s) from `{}` were carried over to it.",
                        changes.all().len(),
                        folder.path
                    ));
                    if !report.left_behind.is_empty() {
                        text.push_str(&format!(
                            " These could not be cleaned up in `{}` and are still there too: {}. \
                             Tell the user.",
                            folder.path,
                            report.left_behind.join(", ")
                        ));
                    }
                }
                Err(e) => {
                    return RelocateAnswer {
                        ok: false,
                        text: format!(
                            "{text} But the uncommitted changes could not be carried over: {e}. \
                             Nothing was changed in `{}`, and this conversation stays where it \
                             is. Tell the user.",
                            folder.path
                        ),
                        path: Some(wt_path),
                        folder_id: Some(worktree.id),
                        moves: false,
                    };
                }
            }
        } else if !changes.is_empty() {
            text.push_str(&format!(
                " The uncommitted changes stay in `{}`, as the user chose.",
                folder.path
            ));
        }
        text.push_str(
            " Do the rest of this turn there. This conversation moves to the worktree once your \
             reply has finished; its next turn starts there.",
        );
        self.schedule(caller.conversation.id, worktree.id);
        RelocateAnswer {
            ok: true,
            text,
            path: Some(wt_path),
            folder_id: Some(worktree.id),
            moves: true,
        }
    }

    /// Titles of the other top-level conversations in `folder_id` with a turn
    /// running now.
    async fn others_running(&self, folder_id: i32, me: i32) -> Vec<String> {
        let mut ids = Vec::new();
        for info in self.manager.list_connections().await {
            let Some(state) = self.manager.get_state(&info.id).await else {
                continue;
            };
            let (id, running) = {
                let s = state.read().await;
                (
                    s.conversation_id,
                    s.turn_in_flight || s.status == ConnectionStatus::Prompting,
                )
            };
            if let (Some(id), true) = (id, running) {
                if id != me && !ids.contains(&id) {
                    ids.push(id);
                }
            }
        }
        if ids.is_empty() {
            return Vec::new();
        }
        conversation::Entity::find()
            .filter(conversation::Column::Id.is_in(ids))
            .filter(conversation::Column::FolderId.eq(folder_id))
            .filter(conversation::Column::ParentId.is_null())
            .filter(conversation::Column::DeletedAt.is_null())
            .all(self.conn())
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|row| {
                row.title
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or_else(|| format!("对话 {}", row.id))
            })
            .collect()
    }

    // -- adopt_project -------------------------------------------------------

    async fn project(
        self: &Arc<Self>,
        connection_id: &str,
        caller: Caller,
        path: &str,
    ) -> RelocateAnswer {
        let path = trim_path(path);
        let dir = Path::new(&path);
        if path.is_empty() || !dir.is_absolute() || !dir.is_dir() {
            return RelocateAnswer::refused(format!(
                "`{path}` is not an existing directory on this machine (give an absolute path)."
            ));
        }
        if dir.parent().is_none() {
            return RelocateAnswer::refused("The filesystem root cannot be a project.");
        }
        if crate::git_repo::main_worktree_root(dir).is_some() {
            return RelocateAnswer::refused(format!(
                "`{path}` is a git worktree. Use continue_in_worktree with `path` for it."
            ));
        }
        if caller.folder.parent_id.is_some() {
            return RelocateAnswer::refused(format!(
                "This conversation works in a worktree (`{}`), and stays there.",
                caller.folder.path
            ));
        }
        let open = folder::Entity::find()
            .filter(folder::Column::DeletedAt.is_null())
            .filter(folder::Column::IsOpen.eq(true))
            .filter(folder::Column::Kind.eq(FolderKind::Regular))
            .all(self.conn())
            .await
            .unwrap_or_default();
        let existing = open.iter().find(|f| same_dir(Path::new(&f.path), dir));
        if existing.is_none() {
            if let Some(outer) = open
                .iter()
                .filter(|f| f.parent_id.is_none())
                .find(|f| dir.starts_with(Path::new(&f.path)))
            {
                return RelocateAnswer::refused(format!(
                    "`{path}` is inside the open project `{}` (`{}`). Work there instead, or ask \
                     the user to open the directory as a project themselves.",
                    display_name(outer),
                    outer.path
                ));
            }
        }
        if let Some(existing) = existing {
            if existing.parent_id.is_some() {
                return RelocateAnswer::refused(format!(
                    "`{path}` is a worktree. Use continue_in_worktree with `path` for it."
                ));
            }
            if existing.id == caller.folder.id {
                return RelocateAnswer::refused("This conversation is already in that project.");
            }
        }
        let (question, options) = project_card(&path, existing.map(display_name).as_deref());
        let choice = match self.ask(connection_id, question, options).await {
            Ok(choice) => choice,
            Err(text) => return RelocateAnswer::refused(text),
        };
        let moves = choice == ADD_AND_MOVE || choice == MOVE;
        if !moves && choice != ADD_ONLY {
            return declined();
        }
        let target = match existing {
            Some(existing) => existing.id,
            None => match super::folders::open_folder_core(&self.db, path.clone()).await {
                Ok(detail) => {
                    let id = detail.id;
                    super::folders::emit_folder_upsert(&self.emitter, detail);
                    id
                }
                Err(e) => {
                    return RelocateAnswer::refused(format!(
                        "The user agreed, but the project could not be added: {e}"
                    ))
                }
            },
        };
        if !moves {
            return RelocateAnswer {
                ok: true,
                text: format!(
                    "The user added `{path}` to the sidebar as a project, but chose to keep this \
                     conversation where it is. Keep using absolute paths for it."
                ),
                path: Some(path),
                folder_id: Some(target),
                moves: false,
            };
        }
        self.schedule(caller.conversation.id, target);
        RelocateAnswer {
            ok: true,
            text: format!(
                "The user agreed. `{path}` is in the sidebar. This conversation moves into it once \
                 your reply has finished; its next turn starts there. Until then keep using \
                 absolute paths."
            ),
            path: Some(path),
            folder_id: Some(target),
            moves: true,
        }
    }

    // -- the card and the move -----------------------------------------------

    /// Ask the person on the conversation's card; the label they chose.
    async fn ask(
        &self,
        connection_id: &str,
        question: String,
        options: Vec<QuestionOption>,
    ) -> Result<String, String> {
        let spec = QuestionSpec {
            id: format!("relocate-{}", uuid::Uuid::new_v4()),
            question,
            header: CARD_HEADER.to_string(),
            multi_select: false,
            options,
            is_secret: false,
            allow_other: false,
        };
        let Some(registered) = self
            .questions
            .register_question(connection_id, vec![spec])
            .await
        else {
            return Err("Another question is waiting for the user's answer in this \
                        conversation. Call this tool again once it is answered."
                .to_string());
        };
        let mut withdraw = Withdraw {
            questions: Arc::clone(&self.questions),
            connection: connection_id.to_string(),
            question: registered.question_id,
            armed: true,
        };
        let outcome = registered.answer_rx.await;
        withdraw.armed = false;
        let Ok(outcome) = outcome else {
            return Err(
                "The question was withdrawn before the user answered. Nothing was \
                        changed."
                    .to_string(),
            );
        };
        if outcome.declined {
            return Err(
                "The user dismissed the card. Nothing was changed; do not move this \
                        conversation unless they ask again."
                    .to_string(),
            );
        }
        Ok(outcome
            .answers
            .first()
            .and_then(|a| a.selected.first())
            .map(|label| label.trim().to_string())
            .unwrap_or_default())
    }

    /// Move `conversation_id` to `target_folder_id` once it is idle,
    /// replacing any earlier pending move of it.
    fn schedule(self: &Arc<Self>, conversation_id: i32, target_folder_id: i32) {
        let generation = self.generation.fetch_add(1, Ordering::Relaxed) + 1;
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(conversation_id, generation);
        let tools = Arc::clone(self);
        tokio::spawn(async move {
            tools
                .move_when_idle(conversation_id, target_folder_id, generation)
                .await;
        });
    }

    fn is_current(&self, conversation_id: i32, generation: u64) -> bool {
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&conversation_id)
            == Some(&generation)
    }

    async fn move_when_idle(&self, conversation_id: i32, target: i32, generation: u64) {
        let started = Instant::now();
        loop {
            tokio::time::sleep(RETRY_EVERY).await;
            if !self.is_current(conversation_id, generation) {
                return;
            }
            let outcome = move_conversation_for_agent(
                &self.emitter,
                self.conn(),
                &self.manager,
                conversation_id,
                target,
            )
            .await;
            let reason = match outcome {
                Ok(result) if result.moved.contains(&conversation_id) => {
                    tracing::info!(
                        "[relocate] conversation {conversation_id} moved to folder {target}"
                    );
                    break;
                }
                Ok(result) => result.skipped.first().map(|skip| skip.reason),
                Err(e) => {
                    tracing::warn!(
                        "[relocate] conversation {conversation_id} could not move to folder \
                         {target}: {e}"
                    );
                    break;
                }
            };
            if reason == Some(MoveSkipReason::Busy) && started.elapsed() < GIVE_UP_AFTER {
                continue;
            }
            tracing::warn!(
                "[relocate] conversation {conversation_id} stays where it is (to folder \
                 {target}): {reason:?}"
            );
            break;
        }
        let mut pending = self.pending.lock().unwrap_or_else(|e| e.into_inner());
        if pending.get(&conversation_id) == Some(&generation) {
            pending.remove(&conversation_id);
        }
    }
}

fn option(label: &str, description: &str) -> QuestionOption {
    QuestionOption {
        label: label.to_string(),
        description: description.to_string(),
    }
}

fn declined() -> RelocateAnswer {
    RelocateAnswer::refused(
        "The user said no. Nothing was changed; this conversation stays where it is. Do not \
         call this again unless they ask.",
    )
}

/// How the sidebar names a folder.
fn display_name(folder: &folder::Model) -> String {
    folder
        .alias
        .as_deref()
        .map(str::trim)
        .filter(|alias| !alias.is_empty())
        .unwrap_or(&folder.name)
        .to_string()
}

/// `path` without surrounding blanks or a trailing separator.
fn trim_path(path: &str) -> String {
    let path = path.trim();
    let trimmed = path.trim_end_matches(['/', '\\']);
    if trimmed.is_empty() {
        path.to_string()
    } else {
        trimmed.to_string()
    }
}

/// The same directory, symlinks resolved where possible.
fn same_dir(a: &Path, b: &Path) -> bool {
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(a), Ok(b)) => a == b,
        _ => a == b,
    }
}

/// The card for a new worktree: the question and its options.
fn worktree_card(
    branch: &str,
    folder_name: &str,
    changes: &Changes,
    others: &[String],
) -> (String, Vec<QuestionOption>) {
    let mut question = format!(
        "这个对话要转到新分支 {branch}：新建一个 worktree，回复结束后对话挪到它下面，之后不能再挪回「{folder_name}」。"
    );
    if changes.is_empty() {
        return (
            question,
            vec![
                option(GO, "回复结束后对话挪过去"),
                option(NO_GO, "什么都不做"),
            ],
        );
    }
    let files = changes.all();
    question.push_str(&format!(
        "\n\n「{folder_name}」里有 {} 个没提交的改动：",
        files.len()
    ));
    for file in files.iter().take(CARD_FILES_SHOWN) {
        question.push_str(&format!("\n- {file}"));
    }
    if files.len() > CARD_FILES_SHOWN {
        question.push_str(&format!("\n…还有 {} 个", files.len() - CARD_FILES_SHOWN));
    }
    if !others.is_empty() {
        question.push_str(&format!(
            "\n\n注意：这个项目里还有别的对话正在跑（{}），这些改动可能是它们的，带走以后它们那边的文件会变回去。",
            others.join("、")
        ));
    }
    (
        question,
        vec![
            option(CARRY, "改动搬到新分支，这里恢复干净"),
            option(LEAVE, "新分支从当前提交开始，这里的改动不动"),
            option(NO_GO, "什么都不做"),
        ],
    )
}

/// The card for a project: `existing` is the name of the open project at
/// `path`, if it is one.
fn project_card(path: &str, existing: Option<&str>) -> (String, Vec<QuestionOption>) {
    match existing {
        Some(name) => (
            format!(
                "这个对话要移到项目「{name}」（{path}）。回复结束后对话挪过去；以后可以用「移动到项目…」挪回来。"
            ),
            vec![
                option(MOVE, "回复结束后对话挪过去"),
                option(NEITHER, "什么都不做"),
            ],
        ),
        None => (
            format!(
                "智能体想把 {path} 加到侧栏，并把这个对话移进去。回复结束后对话挪过去；以后可以用「移动到项目…」挪回来。"
            ),
            vec![
                option(ADD_AND_MOVE, "项目出现在侧栏，回复结束后对话挪过去"),
                option(ADD_ONLY, "项目出现在侧栏，对话留在这里"),
                option(NEITHER, "什么都不做"),
            ],
        ),
    }
}

// -- git ----------------------------------------------------------------------

/// Run git in `dir`; its stdout.
async fn git(dir: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    git_with_input(dir, args, None).await
}

async fn git_with_input(
    dir: &Path,
    args: &[&str],
    input: Option<&[u8]>,
) -> Result<Vec<u8>, String> {
    let mut command = crate::process::tokio_command("git");
    command
        .args(args)
        .current_dir(dir)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .stdin(if input.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        });
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not run git: {e}"))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin
            .write_all(input)
            .await
            .map_err(|e| format!("could not feed git: {e}"))?;
        drop(stdin);
    }
    let output = child
        .wait_with_output()
        .await
        .map_err(|e| format!("git did not finish: {e}"))?;
    if !output.status.success() {
        return Err(format!(
            "`git {}` failed: {}",
            args.first().copied().unwrap_or_default(),
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(output.stdout)
}

/// NUL-separated paths.
fn split_nul(out: &[u8]) -> Result<Vec<String>, String> {
    out.split(|b| *b == 0)
        .filter(|part| !part.is_empty())
        .map(|part| {
            String::from_utf8(part.to_vec())
                .map_err(|_| "a changed file has a name that is not UTF-8".to_string())
        })
        .collect()
}

async fn current_branch(dir: &Path) -> Option<String> {
    let out = git(dir, &["symbolic-ref", "--short", "-q", "HEAD"])
        .await
        .ok()?;
    let branch = String::from_utf8_lossy(&out).trim().to_string();
    (!branch.is_empty()).then_some(branch)
}

/// The uncommitted changes of the checkout at `root`, against `head`.
pub async fn list_changes(root: &Path, head: &str) -> Result<Changes, String> {
    let tracked = git(root, &["diff", "--name-only", "--no-renames", "-z", head]).await?;
    let untracked = git(root, &["ls-files", "--others", "--exclude-standard", "-z"]).await?;
    let mut tracked = split_nul(&tracked)?;
    let mut untracked = split_nul(&untracked)?;
    tracked.sort();
    untracked.sort();
    Ok(Changes { tracked, untracked })
}

/// Carry `changes` of the checkout at `root` over to the fresh worktree at
/// `worktree` (made from `head`), then clean them up in `root`.
///
/// The changes must still be exactly `changes` (what the person saw on the
/// card); otherwise nothing happens. Tracked changes go over as one binary
/// patch (staged and unstaged alike arrive unstaged), untracked files are
/// copied, and every file is compared on both sides before anything in
/// `root` is touched. A failure up to there puts the worktree back to `head`
/// and leaves `root` alone. Once the changes are safely in the worktree, a
/// path that cannot be cleaned up in `root` is reported, not undone.
pub async fn carry_changes(
    root: &Path,
    worktree: &Path,
    head: &str,
    changes: &Changes,
) -> Result<CarryReport, String> {
    let now = list_changes(root, head).await?;
    if now != *changes {
        return Err(
            "the uncommitted changes are not the ones the user was shown any more (something \
             changed them meanwhile)"
                .to_string(),
        );
    }
    if let Err(e) = put_changes(root, worktree, head, changes).await {
        reset_worktree(worktree, head).await;
        return Err(e);
    }

    let mut report = CarryReport::default();
    if !changes.tracked.is_empty() {
        let mut list = Vec::new();
        for path in &changes.tracked {
            list.extend_from_slice(path.as_bytes());
            list.push(0);
        }
        let restored = git_with_input(
            root,
            &[
                // File names are names, not patterns.
                "--literal-pathspecs",
                "restore",
                "--source",
                head,
                "--staged",
                "--worktree",
                "--pathspec-from-file=-",
                "--pathspec-file-nul",
            ],
            Some(&list),
        )
        .await;
        if let Err(e) = restored {
            tracing::warn!("[relocate] could not restore {}: {e}", root.display());
            report.left_behind.extend(changes.tracked.iter().cloned());
        }
    }
    for path in &changes.untracked {
        let file = root.join(path);
        if std::fs::remove_file(&file).is_err() {
            report.left_behind.push(path.clone());
            continue;
        }
        remove_empty_parents(root, &file);
    }
    Ok(report)
}

/// The patch, the copies and the comparison of [`carry_changes`].
async fn put_changes(
    root: &Path,
    worktree: &Path,
    head: &str,
    changes: &Changes,
) -> Result<(), String> {
    if !changes.tracked.is_empty() {
        let patch = git(root, &["diff", "--binary", "--no-renames", head]).await?;
        if !patch.is_empty() {
            git_with_input(worktree, &["apply", "--binary", "-"], Some(&patch))
                .await
                .map_err(|e| format!("could not apply the changes in the worktree: {e}"))?;
        }
    }
    let root = root.to_path_buf();
    let worktree = worktree.to_path_buf();
    let changes = changes.clone();
    tokio::task::spawn_blocking(move || {
        copy_untracked(&root, &worktree, &changes.untracked)?;
        for path in changes.all() {
            if read_entry(&root.join(path))? != read_entry(&worktree.join(path))? {
                return Err(format!(
                    "`{path}` is not the same in the worktree after carrying it over"
                ));
            }
        }
        Ok(())
    })
    .await
    .map_err(|e| format!("carrying the changes over stopped: {e}"))?
}

fn copy_untracked(root: &Path, worktree: &Path, paths: &[String]) -> Result<(), String> {
    for path in paths {
        let from = root.join(path);
        let to = worktree.join(path);
        if std::fs::symlink_metadata(&to).is_ok() {
            return Err(format!("`{path}` is already in the worktree"));
        }
        if let Some(parent) = to.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("could not make the folder for `{path}`: {e}"))?;
        }
        let meta = std::fs::symlink_metadata(&from)
            .map_err(|e| format!("could not read `{path}`: {e}"))?;
        if meta.file_type().is_symlink() {
            let target =
                std::fs::read_link(&from).map_err(|e| format!("could not read `{path}`: {e}"))?;
            #[cfg(unix)]
            std::os::unix::fs::symlink(&target, &to)
                .map_err(|e| format!("could not copy `{path}`: {e}"))?;
            #[cfg(not(unix))]
            {
                let _ = target;
                std::fs::copy(&from, &to).map_err(|e| format!("could not copy `{path}`: {e}"))?;
            }
        } else {
            std::fs::copy(&from, &to).map_err(|e| format!("could not copy `{path}`: {e}"))?;
        }
    }
    Ok(())
}

/// What a path holds, for comparing the two sides.
#[derive(Debug, PartialEq, Eq)]
enum Entry {
    Missing,
    Link(PathBuf),
    File { bytes: Vec<u8>, executable: bool },
}

fn read_entry(path: &Path) -> Result<Entry, String> {
    let meta = match std::fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Entry::Missing),
        Err(e) => return Err(format!("could not read `{}`: {e}", path.display())),
    };
    if meta.file_type().is_symlink() {
        return std::fs::read_link(path)
            .map(Entry::Link)
            .map_err(|e| format!("could not read `{}`: {e}", path.display()));
    }
    if meta.is_dir() {
        return Err(format!(
            "`{}` is a directory (a submodule?), which cannot be carried over",
            path.display()
        ));
    }
    #[cfg(unix)]
    let executable = {
        use std::os::unix::fs::PermissionsExt;
        meta.permissions().mode() & 0o111 != 0
    };
    #[cfg(not(unix))]
    let executable = false;
    let bytes =
        std::fs::read(path).map_err(|e| format!("could not read `{}`: {e}", path.display()))?;
    Ok(Entry::File { bytes, executable })
}

/// Put the fresh worktree back to `head` after a failed carry.
async fn reset_worktree(worktree: &Path, head: &str) {
    if let Err(e) = git(worktree, &["reset", "--hard", "-q", head]).await {
        tracing::warn!("[relocate] could not reset {}: {e}", worktree.display());
    }
    if let Err(e) = git(worktree, &["clean", "-fdq"]).await {
        tracing::warn!("[relocate] could not clean {}: {e}", worktree.display());
    }
}

/// Remove the folders `file` leaves empty, up to (not including) `root`.
fn remove_empty_parents(root: &Path, file: &Path) {
    let mut dir = file.parent();
    while let Some(current) = dir {
        if current == root || !current.starts_with(root) || std::fs::remove_dir(current).is_err() {
            break;
        }
        dir = current.parent();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(dir: &Path, args: &[&str]) {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?}");
    }

    /// A repository with two committed files and its HEAD.
    fn repo(dir: &Path) -> String {
        run(dir, &["init", "-q", "-b", "main"]);
        std::fs::write(dir.join("a.txt"), "a\n").unwrap();
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::write(dir.join("src/b.txt"), "b\n").unwrap();
        std::fs::write(dir.join(".gitignore"), "*.log\n").unwrap();
        run(dir, &["add", "."]);
        run(dir, &["commit", "-q", "-m", "init"]);
        let out = std::process::Command::new("git")
            .args(["rev-parse", "HEAD"])
            .current_dir(dir)
            .output()
            .unwrap();
        String::from_utf8(out.stdout).unwrap().trim().to_string()
    }

    fn worktree(root: &Path, at: &Path, head: &str) {
        run(
            root,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "feature",
                at.to_str().unwrap(),
                head,
            ],
        );
    }

    #[tokio::test]
    async fn changes_go_over_and_the_checkout_is_left_clean() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let head = repo(&root);
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        std::fs::remove_file(root.join("src/b.txt")).unwrap();
        std::fs::create_dir_all(root.join("new/deep")).unwrap();
        std::fs::write(root.join("new/deep/c.txt"), "c\n").unwrap();
        std::fs::write(root.join("staged.txt"), "s\n").unwrap();
        run(&root, &["add", "staged.txt"]);
        std::fs::write(root.join("debug.log"), "ignored\n").unwrap();

        let changes = list_changes(&root, &head).await.unwrap();
        assert_eq!(changes.tracked, vec!["a.txt", "src/b.txt", "staged.txt"]);
        assert_eq!(changes.untracked, vec!["new/deep/c.txt"]);

        let wt = tmp.path().join("wt");
        worktree(&root, &wt, &head);
        let report = carry_changes(&root, &wt, &head, &changes).await.unwrap();
        assert!(report.left_behind.is_empty(), "{report:?}");

        assert_eq!(
            std::fs::read_to_string(wt.join("a.txt")).unwrap(),
            "changed\n"
        );
        assert!(!wt.join("src/b.txt").exists());
        assert_eq!(
            std::fs::read_to_string(wt.join("new/deep/c.txt")).unwrap(),
            "c\n"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join("staged.txt")).unwrap(),
            "s\n"
        );
        assert!(!wt.join("debug.log").exists(), "ignored files stay behind");

        assert_eq!(
            list_changes(&root, &head).await.unwrap(),
            Changes::default()
        );
        assert_eq!(std::fs::read_to_string(root.join("a.txt")).unwrap(), "a\n");
        assert!(root.join("src/b.txt").exists());
        assert!(!root.join("new").exists(), "emptied folders go too");
        assert!(root.join("debug.log").exists());
    }

    #[tokio::test]
    async fn changes_that_moved_on_since_the_card_are_not_carried() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let head = repo(&root);
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        let shown = list_changes(&root, &head).await.unwrap();
        std::fs::write(root.join("late.txt"), "late\n").unwrap();

        let wt = tmp.path().join("wt");
        worktree(&root, &wt, &head);
        assert!(carry_changes(&root, &wt, &head, &shown).await.is_err());
        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "a\n");
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "changed\n"
        );
        assert!(root.join("late.txt").exists());
    }

    #[tokio::test]
    async fn a_failed_carry_leaves_both_sides_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("repo");
        std::fs::create_dir_all(&root).unwrap();
        let head = repo(&root);
        std::fs::write(root.join("a.txt"), "changed\n").unwrap();
        std::fs::write(root.join("clash.txt"), "mine\n").unwrap();
        let changes = list_changes(&root, &head).await.unwrap();

        let wt = tmp.path().join("wt");
        worktree(&root, &wt, &head);
        // Something already sits where an untracked file would be copied.
        std::fs::write(wt.join("clash.txt"), "theirs\n").unwrap();
        assert!(carry_changes(&root, &wt, &head, &changes).await.is_err());

        assert_eq!(std::fs::read_to_string(wt.join("a.txt")).unwrap(), "a\n");
        assert!(
            !wt.join("clash.txt").exists(),
            "the worktree is back to HEAD"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("a.txt")).unwrap(),
            "changed\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("clash.txt")).unwrap(),
            "mine\n"
        );
    }

    #[test]
    fn the_worktree_card_lists_the_changes_and_who_else_is_running() {
        let none = Changes::default();
        let (question, options) = worktree_card("fix/x", "work", &none, &[]);
        assert!(question.contains("fix/x") && question.contains("「work」"));
        let labels: Vec<&str> = options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, vec![GO, NO_GO]);

        let many = Changes {
            tracked: (0..25).map(|i| format!("f{i:02}.txt")).collect(),
            untracked: vec!["new.txt".to_string()],
        };
        let others = vec!["侧栏修复".to_string()];
        let (question, options) = worktree_card("fix/x", "work", &many, &others);
        assert!(question.contains("26 个没提交的改动"));
        assert!(question.contains("- f00.txt") && !question.contains("- f24.txt"));
        assert!(question.contains("还有 6 个"));
        assert!(question.contains("侧栏修复"));
        let labels: Vec<&str> = options.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, vec![CARRY, LEAVE, NO_GO]);
    }

    #[test]
    fn the_project_card_offers_adding_alone_only_for_a_new_project() {
        let (_, fresh) = project_card("/srv/new", None);
        let labels: Vec<&str> = fresh.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, vec![ADD_AND_MOVE, ADD_ONLY, NEITHER]);
        let (question, open) = project_card("/srv/old", Some("old"));
        assert!(question.contains("「old」"));
        let labels: Vec<&str> = open.iter().map(|o| o.label.as_str()).collect();
        assert_eq!(labels, vec![MOVE, NEITHER]);
    }

    #[test]
    fn paths_lose_blanks_and_a_trailing_separator() {
        assert_eq!(trim_path("  /srv/new/ "), "/srv/new");
        assert_eq!(trim_path("/"), "/");
        assert_eq!(trim_path(""), "");
    }

    #[test]
    fn the_card_header_fits_its_chip() {
        assert!(CARD_HEADER.chars().count() <= crate::acp::question::MAX_HEADER_CHARS);
        for label in [
            CARRY,
            LEAVE,
            GO,
            NO_GO,
            ADD_AND_MOVE,
            ADD_ONLY,
            MOVE,
            NEITHER,
        ] {
            assert!(!label.is_empty());
        }
    }
}
