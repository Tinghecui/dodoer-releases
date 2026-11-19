use std::collections::HashMap;
use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{ser::SerializeStruct, Serialize, Serializer};
use tokio::sync::{broadcast, RwLock};

use crate::acp::types::{
    BackgroundPendingEntry, BackgroundPendingState, BackgroundPendingTask,
    BackgroundUncertainReason, ConnectionStatus,
};
use crate::acp::{AcpEvent, EventBusMetrics, EventEnvelope, InternalEventBus, SessionState};

/// Broadcast-delivered event.
///
/// `payload` is wrapped in `Arc` so cloning across broadcast receivers is
/// refcount-only — avoids copying multi-MB JSON trees per subscriber.
#[derive(Clone, Debug)]
pub struct WebEvent {
    pub channel: String,
    pub payload: Arc<serde_json::Value>,
}

impl Serialize for WebEvent {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut state = serializer.serialize_struct("WebEvent", 2)?;
        state.serialize_field("channel", &self.channel)?;
        state.serialize_field("payload", self.payload.as_ref())?;
        state.end()
    }
}

pub struct WebEventBroadcaster {
    sender: broadcast::Sender<WebEvent>,
    /// Cowork 加的：「留下来的『?』」，按对话 id。连接从 `ConnectionManager` 删掉以后还在，
    /// 只在内存里（重启就没了）。只在很短的同步代码里拿着，从不跨 `.await`，拿着它时也不去拿
    /// 别的锁（里面只会往 `sender` 发消息）。
    background_slots: std::sync::Mutex<BackgroundSlots>,
}

/// Cowork 加的：一个对话在「留下来的『?』」表里的一格。
#[derive(Debug, Default)]
struct BackgroundSlot {
    /// 报过读数或绑过这个对话的最新 [`crate::acp::SessionState`] 编号。
    generation: u64,
    /// 留下来的「?」；没有就是 `None`。
    uncertain: Option<BackgroundPendingEntry>,
    /// 留下「?」的那条连接断开前的智能体会话 id（#441）：刷新后自动连上的新连接只 resume
    /// 这个会话、不绑对话，靠它认出来。
    external_id: Option<String>,
    /// #834：被取消的任务连接的编号（这个及更旧的被挡在外面）。它们晚到的断开不留「?」，
    /// 只把客户端上的沙漏清掉，或者（回合没跑完）照 #817 记下没跑完的后台任务。之后有更新的
    /// 连接报了读数就作废。
    retired_through: Option<u64>,
}

/// Cowork 加的（#441）：一条没断开的活连接绑着什么，给 [`WebEventBroadcaster::merge_background_pending_with`]
/// 判断留下来的「?」还算不算数。
#[derive(Debug, Clone)]
pub struct LiveBinding {
    pub conversation_id: Option<i32>,
    pub external_id: Option<String>,
    /// 这条连接启动时要 resume 的会话 id（[`crate::acp::SessionState::resumed_from_external_id`]）：
    /// resume 失败、回退成新会话时 `external_id` 是新的，还没绑对话，靠它认出来。
    pub resumed_from: Option<String>,
    /// 这条连接的 [`crate::acp::SessionState`] 编号。
    pub generation: u64,
}

impl LiveBinding {
    /// 这条连接认领表里这一格的「?」：绑着同一个对话，或者 resume 着同一个会话 id
    /// （resume 成功是现在的会话 id，回退成新会话是启动时要 resume 的那个），而且不比
    /// 留下「?」的连接旧。
    fn claims(&self, conversation_id: i32, slot: &BackgroundSlot) -> bool {
        if self.generation < slot.generation {
            return false;
        }
        if self.conversation_id == Some(conversation_id) {
            return true;
        }
        let Some(left) = slot.external_id.as_deref() else {
            return false;
        };
        self.external_id.as_deref() == Some(left) || self.resumed_from.as_deref() == Some(left)
    }
}

type BackgroundSlots = HashMap<i32, BackgroundSlot>;

impl Default for WebEventBroadcaster {
    fn default() -> Self {
        Self::new()
    }
}

impl WebEventBroadcaster {
    pub fn new() -> Self {
        let (sender, _) = broadcast::channel(4096);
        Self {
            sender,
            background_slots: std::sync::Mutex::new(HashMap::new()),
        }
    }

    fn lock_background_slots(&self) -> std::sync::MutexGuard<'_, BackgroundSlots> {
        self.background_slots
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Cowork 加的：`acp_list_background_pending` 的结果。`live` 是活着的连接的读数
    /// （`ConnectionManager::list_background_pending`），再加上留下来的「?」里那些活着的连接
    /// 没报过的对话；两边都有时以活着的连接为准。
    #[cfg(test)]
    pub fn merge_background_pending(
        &self,
        live: Vec<BackgroundPendingEntry>,
    ) -> Vec<BackgroundPendingEntry> {
        self.merge_background_pending_with(live, &[])
    }

    /// [`Self::merge_background_pending`]，再看 `bound`（所有没断开的活连接，空闲的也算）：
    /// 有一条认领了某个对话留下来的「?」（[`LiveBinding::claims`]），这个「?」作废，从表里
    /// 删掉、不再列出来（#441：自动重连以后智能体确实起来了，连接点写着「已连接」）。
    pub fn merge_background_pending_with(
        &self,
        live: Vec<BackgroundPendingEntry>,
        bound: &[LiveBinding],
    ) -> Vec<BackgroundPendingEntry> {
        let mut entries = live;
        {
            let mut slots = self.lock_background_slots();
            for (conversation_id, slot) in slots.iter_mut() {
                if slot.uncertain.is_none() {
                    continue;
                }
                if bound.iter().any(|b| b.claims(*conversation_id, slot)) {
                    slot.uncertain = None;
                    slot.external_id = None;
                    continue;
                }
                let Some(uncertain) = &slot.uncertain else {
                    continue;
                };
                if entries
                    .iter()
                    .all(|e| e.conversation_id != *conversation_id)
                {
                    entries.push(uncertain.clone());
                }
            }
        }
        entries.sort_by_key(|e| e.conversation_id);
        entries
    }

    /// Serialize `payload` once and broadcast. Returns the serialized
    /// `Value` so Tauri callers can reuse it without serializing twice.
    pub fn send(&self, channel: &str, payload: &impl Serialize) -> Option<Arc<serde_json::Value>> {
        let value = Arc::new(serde_json::to_value(payload).ok()?);
        if self.sender.receiver_count() > 0 {
            let _ = self.sender.send(WebEvent {
                channel: channel.to_string(),
                payload: value.clone(),
            });
        }
        Some(value)
    }

    /// Broadcast a pre-serialized `Value` without re-serialization.
    pub fn send_value(&self, channel: &str, payload: Arc<serde_json::Value>) {
        if self.sender.receiver_count() == 0 {
            return;
        }
        let _ = self.sender.send(WebEvent {
            channel: channel.to_string(),
            payload,
        });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<WebEvent> {
        self.sender.subscribe()
    }
}

/// Abstraction over event emission targets.
///
/// Three concerns layered together:
/// - **Tauri webview** (`Tauri` variant): events delivered to the desktop
///   webview via `app.emit`. Looked-up state (`Arc<WebEventBroadcaster>`,
///   `Arc<InternalEventBus>`) goes through `app.try_state`, registered in
///   `lib.rs::run` setup.
/// - **WS clients** (`WebOnly` variant): standalone server mode. Carries
///   the broadcaster directly because there's no AppHandle to look it up
///   from.
/// - **In-process consumers** (lifecycle / pet / chat-channel): receive
///   typed `Arc<EventEnvelope>` from `InternalEventBus`. Both `Tauri` and
///   `WebOnly` resolve to the same bus (via `acp_event_bus()`).
///
/// `Noop` drops everything — used for legacy non-streaming call paths and
/// in tests that don't observe events.
#[derive(Clone)]
pub enum EventEmitter {
    #[cfg(feature = "tauri-runtime")]
    Tauri(tauri::AppHandle),
    /// Standalone server runtime. Carries the broadcaster (transport-bound
    /// JSON delivery to WS clients on non-ACP channels) and the internal
    /// bus (typed envelope delivery to in-process subscribers).
    WebOnly {
        broadcaster: Arc<WebEventBroadcaster>,
        bus: Arc<InternalEventBus>,
    },
    /// Silent no-op emitter — drops all events. Used when streaming progress
    /// is not needed (e.g. legacy non-streaming call paths).
    Noop,
}

impl EventEmitter {
    /// Convenience constructor for the standalone server runtime path.
    /// Mirrors how `Tauri` resolves the same two pieces of state via
    /// `app.try_state`.
    pub fn web_only(broadcaster: Arc<WebEventBroadcaster>, bus: Arc<InternalEventBus>) -> Self {
        EventEmitter::WebOnly { broadcaster, bus }
    }

    /// Resolve the `InternalEventBus` for ACP-typed event delivery.
    ///
    /// In Tauri mode, looks up `Arc<InternalEventBus>` registered with
    /// `app.manage` during setup. Returns `None` if the bus isn't
    /// registered (only happens in degraded test setups) — the caller
    /// treats this as "no in-process consumers wired".
    pub fn acp_event_bus(&self) -> Option<Arc<InternalEventBus>> {
        match self {
            #[cfg(feature = "tauri-runtime")]
            EventEmitter::Tauri(app) => {
                use tauri::Manager;
                app.try_state::<Arc<InternalEventBus>>()
                    .map(|s| Arc::clone(&s))
            }
            EventEmitter::WebOnly { bus, .. } => Some(Arc::clone(bus)),
            EventEmitter::Noop => None,
        }
    }

    /// Cowork 加的：这个发射器背后的 [`WebEventBroadcaster`]（桌面从 `app.manage` 里找）。
    pub fn web_broadcaster(&self) -> Option<Arc<WebEventBroadcaster>> {
        match self {
            #[cfg(feature = "tauri-runtime")]
            EventEmitter::Tauri(app) => {
                use tauri::Manager;
                app.try_state::<Arc<WebEventBroadcaster>>()
                    .map(|s| Arc::clone(&s))
            }
            EventEmitter::WebOnly { broadcaster, .. } => Some(Arc::clone(broadcaster)),
            EventEmitter::Noop => None,
        }
    }

    /// Resolve the `EventBusMetrics` handle. Same lookup rules as
    /// `acp_event_bus()`.
    pub fn metrics(&self) -> Option<Arc<EventBusMetrics>> {
        self.acp_event_bus().map(|bus| Arc::clone(bus.metrics()))
    }

    /// Test-only convenience: build a `WebOnly` emitter with a fresh,
    /// orphan `InternalEventBus`. Tests that assert against the
    /// broadcaster don't need to wire the bus through their own setup.
    #[cfg(any(test, feature = "test-utils"))]
    pub fn test_web_only(broadcaster: Arc<WebEventBroadcaster>) -> Self {
        let metrics = Arc::new(EventBusMetrics::default());
        let bus = Arc::new(InternalEventBus::new(metrics));
        EventEmitter::WebOnly { broadcaster, bus }
    }
}

/// Global side-channel for cross-client conversation list/status sync.
pub const CONVERSATION_CHANGED_EVENT: &str = "conversation://changed";

/// Cowork fork: global side-channel for the sidebar's "waiting on background
/// work" hourglass. Payload: [`BackgroundPendingEntry`], one per conversation
/// whose count or labels changed (`count: 0` clears it). Emitted centrally from
/// [`emit_with_state`], like the `Status` bridge onto
/// [`CONVERSATION_CHANGED_EVENT`], so a client holding no connection to the
/// session still learns it. A channel of its own rather than a new
/// [`ConversationChange`] kind: older clients read any kind they don't know
/// as a status change and would blank the row's status.
pub const BACKGROUND_PENDING_EVENT: &str = "conversation://background";

/// Global side-channel announcing a live-feedback enable/disable. The settings
/// UI runs in a SEPARATE window (`openSettingsWindow`), so the conversation
/// feedback bar can't learn about a save through any frontend-only cache — it
/// relies on this backend broadcast to converge across every window / WS client,
/// exactly like [`CONVERSATION_CHANGED_EVENT`]. Payload: `FeedbackSettings`
/// (`{ "enabled": bool }`).
pub const FEEDBACK_SETTINGS_CHANGED_EVENT: &str = "feedback-settings://changed";

/// Global side-channel announcing an ask-user-question enable/disable. Same
/// cross-window rationale as [`FEEDBACK_SETTINGS_CHANGED_EVENT`]: the settings UI
/// runs in a separate window, so a conversation view learns the flag flipped
/// only via this backend broadcast. Payload: `QuestionSettings` (`{ "enabled":
/// bool }`).
pub const QUESTION_SETTINGS_CHANGED_EVENT: &str = "question-settings://changed";

/// Global side-channel announcing a `get_session_info` enable/disable. Same
/// cross-window rationale as [`QUESTION_SETTINGS_CHANGED_EVENT`]: the settings UI
/// runs in a separate window, so other views learn the flag flipped only via this
/// backend broadcast. Payload: `SessionInfoSettings` (`{ "enabled": bool }`).
pub const SESSION_INFO_SETTINGS_CHANGED_EVENT: &str = "session-info-settings://changed";

/// Global side-channel announcing a browser-tools enable/disable
/// (`browser_list_tabs` / `browser_snapshot`). Same cross-window rationale as
/// [`SESSION_INFO_SETTINGS_CHANGED_EVENT`]. Payload: `BrowserToolsSettings`
/// (`{ "enabled": bool }`).
pub const BROWSER_TOOLS_SETTINGS_CHANGED_EVENT: &str = "browser-tools-settings://changed";

/// Global side-channel announcing a change to the computer-use settings (the
/// group switch, the grant timeout, the blocklist). Same cross-window
/// rationale as [`SESSION_INFO_SETTINGS_CHANGED_EVENT`]. Payload:
/// `ComputerToolsSettings`. Carries no window titles or anything else about
/// the screen, so it is safe on the web broadcaster too.
pub const COMPUTER_TOOLS_SETTINGS_CHANGED_EVENT: &str = "computer-tools-settings://changed";

/// Global side-channel announcing a chat-authoring enable/disable
/// (`create_automation` / `create_work_task`). Same cross-window rationale as
/// [`SESSION_INFO_SETTINGS_CHANGED_EVENT`]. Payload: `ChatAuthoringSettings`
/// (`{ "automations_enabled": bool, "work_tasks_enabled": bool }`).
pub const CHAT_AUTHORING_SETTINGS_CHANGED_EVENT: &str = "chat-authoring-settings://changed";

/// Announces that the desktop web service started or stopped, from whichever
/// surface did it — the Settings window, the status-bar toggle, or auto-start
/// at launch. Every window (each workspace's status bar, an open Settings
/// page) follows it by re-reading `get_web_server_status`. Payload is
/// [`WebServiceStatusChanged`] and deliberately nothing more: like every side
/// channel it also reaches the web broadcaster, and the status itself carries
/// the access token.
pub const WEB_SERVICE_STATUS_CHANGED_EVENT: &str = "web-service://status-changed";

/// Payload for [`WEB_SERVICE_STATUS_CHANGED_EVENT`].
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServiceStatusChanged {
    pub running: bool,
}

/// Announces a delegation-settings write. Same cross-window rationale as
/// [`CHAT_AUTHORING_SETTINGS_CHANGED_EVENT`], and load-bearing for the same
/// reason: the record has two editors — the settings form, which writes all
/// four keys, and the status-bar codeg-mcp popover, which writes only
/// `enabled` — so a form left open across a popover toggle would revert it on
/// the next save. Payload: `DelegationSettings`.
pub const DELEGATION_SETTINGS_CHANGED_EVENT: &str = "delegation-settings://changed";

/// Payload for the global [`CONVERSATION_CHANGED_EVENT`] side-channel. Drives
/// cross-client sidebar sync (membership + status) independent of the
/// per-connection ACP attach protocol, so clients that are NOT attached to a
/// conversation's connection still see it appear / update / disappear / change
/// state.
///
/// Delivered via [`emit_event`], so in desktop mode a single emit reaches both
/// the Tauri webview (`app.emit`) and every WebSocket browser
/// (`WebEventBroadcaster`); in standalone server mode it reaches all browsers.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationChange {
    /// Insert-or-replace by id. Covers create and field updates (e.g. title).
    /// Carries the full summary so the frontend renders without a re-fetch.
    /// Root conversations omit `parent_id` (serde skips `None`); delegation
    /// children carry it and the frontend filters them out of the sidebar.
    ///
    /// Boxed so this variant doesn't bloat the whole enum (the summary is by far
    /// the largest payload); serde serializes `Box<T>` transparently, so the wire
    /// shape — `{ "kind": "upsert", "summary": { … } }` — is unchanged.
    Upsert {
        summary: Box<crate::models::DbConversationSummary>,
    },
    /// Remove by id (soft delete).
    Deleted { id: i32 },
    /// Lightweight running-state change. Emitted centrally from
    /// [`emit_with_state`] whenever a `ConversationStatusChanged` ACP event
    /// flows through, so the sidebar's status reaches every client (not just
    /// those attached to the connection).
    Status { id: i32, status: String },
}

/// Global side-channel for cross-client folder list sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client. A folder created headlessly (e.g. the
/// automation engine minting a per-run worktree) is otherwise invisible to every
/// client until the next full `fetchFolders` — so without this broadcast a
/// conversation produced in that worktree can't be placed in the sidebar
/// (grouping renders rows only under known/open folders).
///
/// Distinct from [`"folder://open-in-workspace"`] (the project launcher's
/// hand-off, whose listener also opens + focuses a new conversation tab): this
/// channel ONLY upserts the folder into the workspace list, so a background
/// emitter never steals the user's focus.
pub const FOLDER_CHANGED_EVENT: &str = "folder://changed";

/// Payload for [`FOLDER_CHANGED_EVENT`]. The full [`FolderDetail`] rides on the
/// event so clients apply it without a re-fetch (matching
/// [`ConversationChange::Upsert`]). `folder` is boxed to keep the enum small
/// next to the id-only `Deleted`.
///
/// [`FolderDetail`]: crate::models::FolderDetail
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderChange {
    /// Insert-or-replace by id (create / reopen / field update).
    Upsert {
        folder: Box<crate::models::FolderDetail>,
    },
    /// Drop by id: the folder row is soft-deleted and will never come back
    /// (today: a work task's worktree folder, once the worktree is off disk).
    /// The mirror image of `Upsert` — without it a vanished worktree keeps
    /// rendering in every client's sidebar until the next full `fetchFolders`.
    ///
    /// Deliberately NOT emitted when a folder is merely closed
    /// (`remove_folder_from_workspace`): that row stays alive in
    /// `list_all_folder_details` for by-id cwd lookups.
    Deleted { id: i32 },
}

/// Global side-channel for sidebar folder-group sync, alongside
/// [`FOLDER_CHANGED_EVENT`]. Groups are edited in one window but rendered in
/// every client, so a rename / recolor / delete has to reach them all.
pub const FOLDER_GROUP_CHANGED_EVENT: &str = "folder-group://changed";

/// Payload for [`FOLDER_GROUP_CHANGED_EVENT`].
///
/// Group CRUD carries its detail so clients apply it without a re-fetch, but a
/// LAYOUT change deliberately carries nothing: one drag rewrites `group_id` /
/// `sort_order` on every visible folder, and per-row `folder://changed` upserts
/// would turn a single gesture into a burst of events that must then be applied
/// in order to land on the right layout. A single "go re-read both lists" nudge
/// is smaller, order-independent and self-healing.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderGroupChange {
    /// Insert-or-replace by id (create / rename / recolor).
    Upsert {
        group: crate::models::FolderGroupDetail,
    },
    /// The group is gone. Its member folders are NOT deleted — they returned to
    /// the top level, which the accompanying `Layout` refetch picks up.
    Deleted { id: i32 },
    /// Folder membership and/or ordering changed; re-fetch the folder and group
    /// lists.
    Layout,
}

/// Global side-channel for conversation-tag DEFINITIONS (name, colour, order),
/// and for the branch tag setting that is drawn alongside them. Tags are
/// defined in one window but drawn on conversations in every window and
/// client. Which tags a conversation carries travels on
/// [`CONVERSATION_CHANGED_EVENT`] instead, inside the summary's `tag_ids`, so
/// it shares that channel's ordering and reconnect refetch.
pub const CONVERSATION_TAG_CHANGED_EVENT: &str = "conversation-tag://changed";

/// Payload for [`CONVERSATION_TAG_CHANGED_EVENT`].
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ConversationTagChange {
    /// Insert-or-replace by id (create / rename / recolour).
    Upsert {
        tag: crate::models::ConversationTagDetail,
    },
    /// The tag is gone, and with it every link to it. No per-conversation
    /// upserts follow: clients drop the id themselves, and any summary still
    /// naming it renders as if it did not (an unknown id is never drawn).
    Deleted { id: i32 },
    /// Positions changed across a whole scope; re-fetch the tag list. A nudge
    /// rather than N upserts for the same reason as [`FolderGroupChange::Layout`].
    Reordered,
    /// The branch tag setting as just saved, whole.
    BranchTag {
        setting: crate::models::ConversationBranchTag,
    },
}

/// Global side-channel for assistant definitions. Assistants are edited in the
/// settings window but drawn in every window and client — the mention panel,
/// delegation cards, sub-session rows.
pub const ASSISTANT_CHANGED_EVENT: &str = "assistant://changed";

/// Payload for [`ASSISTANT_CHANGED_EVENT`].
///
/// Always WHOLE rows, never a partial update: a client keeps a row only when
/// it carries a higher `revision` than the copy it holds, and one revision
/// always names one content. A nudge carrying only the changed fields would
/// break that — it would advance a stale copy's revision past the broadcast
/// that carried the content it missed.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AssistantChange {
    /// Insert-or-replace by id: create, edit, enable/disable, and delete (the
    /// row then carries `deleted_at`).
    Upsert {
        assistant: Box<crate::models::AssistantInfo>,
    },
    /// The rows whose position changed in a reorder, whole.
    Reordered {
        assistants: Vec<crate::models::AssistantInfo>,
    },
    /// Rows changed without a per-row broadcast (a config snapshot applied
    /// here): re-fetch the whole list.
    Resync,
}

/// Per-agent progress of the import picker's local-session scan. Emitted by
/// `scan_importable_sessions` once per parser so the picker window can render
/// a live checklist while the (potentially seconds-long) filesystem walk runs.
/// Broadcast like every other side-channel — windows not in the `scanning`
/// phase simply ignore it.
pub const IMPORT_SCAN_PROGRESS_EVENT: &str = "import-scan://progress";

/// Payload for [`IMPORT_SCAN_PROGRESS_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ImportScanProgress {
    pub agent_type: crate::models::AgentType,
    /// Parsers completed so far (1-based, monotonic).
    pub done: u32,
    pub total: u32,
    /// Importable root sessions this parser contributed.
    pub session_count: u32,
}

/// One-shot "a batch import finished" nudge. Deliberately a NEW channel rather
/// than a [`ConversationChange`] variant: the frontend's `conversation://changed`
/// handler routes any unknown `kind` into its status branch (clobbering state
/// with `undefined`s on stale clients), whereas an unknown channel simply has no
/// subscriber. Carries ids only — clients respond with a single full refetch,
/// which also covers the per-row title refreshes, so a large batch never floods
/// the bus with thousands of upserts (created folders still broadcast
/// individually on [`FOLDER_CHANGED_EVENT`]).
pub const CONVERSATIONS_BULK_CHANGED_EVENT: &str = "conversations://bulk-changed";

/// Payload for [`CONVERSATIONS_BULK_CHANGED_EVENT`].
#[derive(Debug, Clone, Serialize)]
pub struct ConversationsBulkChanged {
    pub imported: u32,
    pub updated: u32,
    pub folder_ids: Vec<i32>,
}

/// Global side-channel for cross-client open-tab sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client.
pub const TABS_CHANGED_EVENT: &str = "tabs://changed";

/// Payload for the [`TABS_CHANGED_EVENT`] side-channel. Carries the full
/// conversation-bound tab set (a snapshot, not a delta) so every client
/// converges idempotently — matching the full-replacement save semantics.
///
/// - `version` — workspace-global logical clock; clients drop events at or
///   below their last-applied version (except `origin == "server"`).
/// - `origin` — the originating client's id, echoed back so the originator can
///   ignore its own broadcast; the sentinel `"server"` marks cascade-originated
///   changes (folder removal, conversation deletion) that every client applies.
/// - `tabs` — the canonical persisted set; `is_active` marks the focused tab,
///   which is mirrored across clients.
#[derive(Debug, Clone, Serialize)]
pub struct TabsChanged {
    pub version: i64,
    pub origin: String,
    pub tabs: Vec<crate::models::OpenedTab>,
}

/// Global side-channel for cross-client automation list + run sync. Mirrors
/// [`CONVERSATION_CHANGED_EVENT`]: a single [`emit_event`] reaches the Tauri
/// webview and every WebSocket client. The scheduler runs headless (no window),
/// so this broadcast is the only way an open automations view learns a run
/// started or settled.
pub const AUTOMATION_CHANGED_EVENT: &str = "automation://changed";

/// Payload for [`AUTOMATION_CHANGED_EVENT`]. Carries only ids — clients refetch
/// the affected automation / its runs. All variants are small, so no boxing is
/// needed (unlike [`ConversationChange`]).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AutomationChange {
    /// Insert-or-replace by id (create, edit, enable/disable, last-run update).
    Upsert { id: i32 },
    /// Soft-deleted by id.
    Deleted { id: i32 },
    /// A run was claimed and launched.
    RunStarted { automation_id: i32, run_id: i32 },
    /// A run reached a terminal state (succeeded / failed / cancelled / skipped).
    RunSettled {
        automation_id: i32,
        run_id: i32,
        status: String,
    },
}

/// Global side-channel for cross-client work-task board sync. Mirrors
/// [`AUTOMATION_CHANGED_EVENT`]: the task engine runs headless, so this
/// broadcast is the only way an open tasks view (or the sidebar badge) learns a
/// task advanced. Payload is id-only — clients refetch.
pub const WORK_TASK_CHANGED_EVENT: &str = "task://changed";

/// Payload for [`WORK_TASK_CHANGED_EVENT`]. Ids only — clients respond with a
/// refetch of the task list (and badge count).
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum WorkTaskChange {
    /// Insert-or-replace by id (create, edit, any status transition).
    Upsert { id: i32 },
    /// Soft-deleted by id.
    Deleted { id: i32 },
    /// Something the folder's tasks INHERIT changed: its task settings, or the
    /// folder's own default agent (the layer below them). Either can change
    /// what an inheriting task runs — and reports — without touching a row.
    Settings { folder_id: i32 },
    /// Bulk change (e.g. boot reconcile) — refetch everything.
    Refresh,
}

/// Progress of a token-usage sync, emitted while the dashboard's materialized
/// facts are rebuilt from the agents' transcripts. Throttled by the emitter
/// (see `commands::token_usage`), so a multi-thousand-conversation pass sends
/// tens of messages rather than thousands. Payload is
/// [`crate::models::token_usage::TokenUsageSyncProgress`]; the final tick
/// carries the completed result. Like every other side channel this is
/// broadcast — clients not showing the dashboard simply ignore it.
pub const TOKEN_USAGE_SYNC_PROGRESS_EVENT: &str = "token-usage-sync://progress";

/// Unified event emission: serializes the payload exactly once and dispatches
/// the shared `Arc<Value>` to both the Tauri webview and the web broadcaster.
pub fn emit_event(emitter: &EventEmitter, event: &str, payload: impl Serialize) {
    let sent = match emitter {
        #[cfg(feature = "tauri-runtime")]
        EventEmitter::Tauri(app) => {
            use tauri::{Emitter, Manager};
            let Ok(value) = serde_json::to_value(&payload) else {
                return;
            };
            let shared = Arc::new(value);
            // `&Value` is Copy, so Tauri's `Clone` bound is satisfied without
            // copying the payload — Tauri serializes through the reference.
            let _ = app.emit(event, shared.as_ref());
            if let Some(web) = app.try_state::<Arc<WebEventBroadcaster>>() {
                web.send_value(event, Arc::clone(&shared));
            }
            Some(shared)
        }
        EventEmitter::WebOnly { broadcaster, .. } => broadcaster.send(event, &payload),
        EventEmitter::Noop => None,
    };
    // Cowork 加的：对话完成、取消或删掉了，留下来的「?」跟着删。只看这个频道发出去的内容，
    // 不改 `ConversationChange` 本身。
    if event == CONVERSATION_CHANGED_EVENT {
        if let Some((conversation_id, status)) = sent.as_deref().and_then(settled_conversation_id) {
            clear_uncertain_background(emitter, conversation_id, status);
        }
    }
}

/// Cowork 加的：[`settled_conversation_id`] 说的对话是怎么结束的。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SettledAs {
    /// 完成或删掉：留下来的什么都删。
    Closed,
    /// 取消（红叉）：只删「?」，没跑完的后台任务（#817）留着给红叉写任务名。
    Cancelled,
}

/// Cowork 加的：一条 [`CONVERSATION_CHANGED_EVENT`] 是不是说某个对话结束了（`Status` /
/// `Upsert` 是 `completed` / `cancelled`，或者 `Deleted`）。是就返回对话 id 和怎么结束的。
fn settled_conversation_id(value: &serde_json::Value) -> Option<(i32, SettledAs)> {
    let settled = |status: &serde_json::Value| match status.as_str() {
        Some("completed") => Some(SettledAs::Closed),
        Some("cancelled") => Some(SettledAs::Cancelled),
        _ => None,
    };
    let id = |v: &serde_json::Value| v.as_i64().and_then(|n| i32::try_from(n).ok());
    match value.get("kind")?.as_str()? {
        "status" => {
            let how = settled(value.get("status")?)?;
            Some((id(value.get("id")?)?, how))
        }
        "upsert" => {
            let summary = value.get("summary")?;
            let how = settled(summary.get("status")?)?;
            Some((id(summary.get("id")?)?, how))
        }
        "deleted" => Some((id(value.get("id")?)?, SettledAs::Closed)),
        _ => None,
    }
}

/// Cowork 加的：删掉一个对话留下来的「?」，删了就广播一条 `idle`。编号不动：旧连接照样不能
/// 再把「?」写回来。取消时没跑完的后台任务（`abandoned`，#817）不删：那正是红叉要写的。
fn clear_uncertain_background(emitter: &EventEmitter, conversation_id: i32, how: SettledAs) {
    retire_uncertain_background(emitter, conversation_id, how, None);
}

/// Cowork 加的（#834）：[`clear_uncertain_background`]，再把 `fence`（编号）及更旧的连接
/// 挡在这个对话外面：它们之后报的读数（包括断开时留「?」）不进表、也不广播。
/// `disconnect` 只是发个命令，连接真正断开、报 `Disconnected` 在后面，取消任务时先清掉的
/// 「?」不能被它写回来。之后新起的连接编号更大，不受影响。
pub(crate) fn retire_uncertain_background(
    emitter: &EventEmitter,
    conversation_id: i32,
    how: SettledAs,
    fence: Option<u64>,
) {
    let Some(broadcaster) = emitter.web_broadcaster() else {
        return;
    };
    // 拿着表锁发，和别的连接对同一个对话的广播排好先后。
    let mut slots = broadcaster.lock_background_slots();
    if let Some(fence) = fence {
        let slot = slots.entry(conversation_id).or_default();
        slot.generation = slot.generation.max(fence.saturating_add(1));
        slot.retired_through = Some(slot.retired_through.map_or(fence, |r| r.max(fence)));
    }
    let removed = slots
        .get_mut(&conversation_id)
        .and_then(|slot| {
            let keep = how == SettledAs::Cancelled
                && slot
                    .uncertain
                    .as_ref()
                    .is_some_and(|e| e.state == BackgroundPendingState::Abandoned);
            if keep {
                None
            } else {
                slot.uncertain.take()
            }
        })
        .is_some();
    if removed {
        emit_event(
            emitter,
            BACKGROUND_PENDING_EVENT,
            BackgroundPendingEntry::idle(conversation_id),
        );
    }
}

/// 统一 ACP 事件发射入口。
///
/// 流程：
/// 1. 写锁拿到 `SessionState`
/// 2. `apply_event` 把事件应用到 state（也更新 `last_activity_at`）
/// 3. `event_seq += 1`
/// 4. 用新 seq 构造 `EventEnvelope`，推入 ring buffer，记录淘汰计数
/// 5. 释放写锁
/// 6. 分发到三条路径：
///    - 每连接 `ConnectionEventStream`（WS attach 协议主路径）
///    - 进程内 `InternalEventBus`（lifecycle / pet / chat-channel 订阅者）
///    - Tauri 模式下额外 `app.emit("acp://event", ...)` 给 webview
///
/// 不再向 `WebEventBroadcaster` 上的 `acp://event` 频道广播——所有 ACP
/// 事件消费者要么走 per-connection stream（WS 客户端），要么走
/// InternalEventBus（进程内订阅者），要么走 Tauri `app.emit`（桌面 webview）。
/// 删除该全局广播是 Phase 5 架构清理的核心：它消除了 WS 客户端 receiver-side
/// 去重 (`attachManagedConnectionIdsRef`) 的必要性。
pub async fn emit_with_state(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    payload: AcpEvent,
) {
    emit_with_state_gated(state, emitter, payload, |_| true).await;
}

/// Like [`emit_with_state`], but a `gate` predicate — evaluated under the SAME
/// write lock, BEFORE `apply_event` — can veto the emit: returning `false`
/// aborts with no mutation, no seq bump, no broadcast, and returns `false`.
///
/// The point is atomicity: the gate, the state mutation, and the seq assignment
/// all happen in one critical section, so no other event can interleave between
/// "decide to accept" and "apply + sequence". Used by feedback submit to gate on
/// `turn_in_flight` together with the append (a `TurnComplete`/`UserMessage`
/// can't slip in between to strand or re-add the note), and to assign the
/// `FeedbackSubmitted` seq atomically with the append.
pub async fn emit_with_state_gated<F>(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    payload: AcpEvent,
    gate: F,
) -> bool
where
    F: FnOnce(&SessionState) -> bool,
{
    emit_with_state_built(state, emitter, |s| gate(&*s).then_some(payload)).await
}

/// Like [`emit_with_state_gated`], but the payload itself is BUILT under the
/// same write lock, from the state it is about to be applied to: `None` aborts
/// with no event, no seq bump and no broadcast, and returns `false`.
///
/// For a read-modify-emit that another task can write in the middle of. Built
/// from a copy read under an earlier lock, the event would re-emit whatever it
/// read and undo the other writer's change. A Grok model picker is the case:
/// Grok's model catalog broadcast refreshes it from the connection's dispatch
/// task while the conversation loop applies the user's own picks to it.
///
/// `build` may also update backend-internal fields the event's reducer does not
/// own, and those updates stand even when it returns `None`.
pub async fn emit_with_state_built<F>(
    state: &Arc<RwLock<SessionState>>,
    emitter: &EventEmitter,
    build: F,
) -> bool
where
    F: FnOnce(&mut SessionState) -> Option<AcpEvent>,
{
    let (envelope_arc, stream, evicted, turn_file_jobs) = {
        let mut s = state.write().await;
        let Some(payload) = build(&mut s) else {
            return false;
        };
        // Cowork fork: read before and after under the same lock, so the
        // broadcast below says exactly what this event changed. 已经断开的连接
        // 不再报读数（它的后台活跟着进程没了，「?」在断开那一刻已经留下）。
        let disconnected = is_disconnect(&payload);
        // #817：断开时这一轮还没跑完，或者刚以失败收尾（和 lifecycle 判失败用的是同一条：
        // 还没解决的 error）。这一轮会被标成取消，后台任务不留「?」。
        let turn_failed = disconnected
            && (s.turn_in_flight
                || s.session_failures
                    .values()
                    .any(|f| f.severity == "error" && !f.resolved));
        // 进程观察标过「?」的连接，任何有进展的事件都会把它清掉，所以也要读前后
        // （只看一个字段，平常是 `None`，热路径照旧不读读数）。
        let before_reason = s.process_watch.uncertain;
        let background_before = ((moves_background_pending(&payload) || before_reason.is_some())
            && s.status != ConnectionStatus::Disconnected)
            .then(|| {
                let tasks = if disconnected {
                    s.background_pending_tasks()
                } else {
                    Vec::new()
                };
                (s.conversation_id, s.background_pending(), tasks)
            });
        s.apply_event(&payload);
        if let Some((before_id, before, before_tasks)) = background_before {
            // The CLI and the background work in it end with the
            // connection, whatever the counts last said.
            let (after, after_reason) = if disconnected {
                ((0, Vec::new()), None)
            } else {
                (s.background_pending(), s.process_watch.uncertain)
            };
            let after_tasks = if after.0 > 0 || after_reason.is_some() {
                s.background_pending_tasks()
            } else {
                Vec::new()
            };
            // 拿着会话写锁把读数交给表、发出去：同一条连接的广播不会颠倒先后。表锁是叶子锁。
            publish_background_pending(
                emitter,
                BackgroundPendingUpdate {
                    generation: s.generation,
                    before: (before_id, before),
                    before_tasks,
                    before_reason,
                    after: (s.conversation_id, after),
                    after_tasks,
                    after_reason,
                    disconnected,
                    turn_failed,
                    external_id: s.external_id.clone(),
                    resumed_from: s.resumed_from_external_id.clone(),
                },
            );
        }
        s.event_seq += 1;
        let envelope = Arc::new(EventEnvelope {
            seq: s.event_seq,
            connection_id: s.connection_id.clone(),
            payload,
        });
        let evicted = s.push_recent_event(Arc::clone(&envelope));
        let turn_file_jobs = std::mem::take(&mut s.turn_file_jobs);
        (envelope, s.event_stream(), evicted, turn_file_jobs)
    };

    // Office auto-preview: confirm the files this turn's tool calls named.
    // Filesystem work, so off the session lock and off the async workers.
    if !turn_file_jobs.is_empty() {
        let emitter = emitter.clone();
        let run = move || {
            for job in turn_file_jobs {
                crate::agent_turn_files::run_job(job, &emitter);
            }
        };
        match tokio::runtime::Handle::try_current() {
            Ok(runtime) => {
                runtime.spawn_blocking(run);
            }
            // Not reachable from the async callers today; never drop the work.
            Err(_) => run(),
        }
    }

    // Per-connection broadcaster — primary delivery path for web/remote-
    // desktop transports (they use Subscribe-with-Snapshot attach for ACP
    // events).
    stream.send(Arc::clone(&envelope_arc));

    // In-process consumers (lifecycle, pet, chat-channel). Typed envelope —
    // no JSON parse on the receiver side. Plus surface ring-buffer pressure
    // and bus emit-rate via metrics so operators can see when things drift.
    match emitter {
        #[cfg(feature = "tauri-runtime")]
        EventEmitter::Tauri(app) => {
            use tauri::{Emitter, Manager};
            // Tauri webview listener is the desktop frontend's only ACP path
            // (it subscribes via `app.listen`, not the WS attach protocol).
            let _ = app.emit("acp://event", envelope_arc.as_ref());
            if let Some(bus) = app.try_state::<Arc<InternalEventBus>>() {
                bus.send(Arc::clone(&envelope_arc));
                if evicted > 0 {
                    bus.metrics()
                        .ring_buffer_evict_count
                        .fetch_add(evicted as u64, Ordering::Relaxed);
                }
            }
        }
        EventEmitter::WebOnly { bus, .. } => {
            bus.send(Arc::clone(&envelope_arc));
            if evicted > 0 {
                bus.metrics()
                    .ring_buffer_evict_count
                    .fetch_add(evicted as u64, Ordering::Relaxed);
            }
        }
        EventEmitter::Noop => {}
    }

    // Bridge conversation status transitions onto the global
    // `conversation://changed` side-channel so clients NOT attached to this
    // connection (only showing the sidebar, or a different browser entirely)
    // still observe running-state changes live — the per-connection delivery
    // above only reaches attached clients. One central hook here covers every
    // `ConversationStatusChanged` emit site (manager + lifecycle). `status`
    // serializes to the same snake_case string the DB stores (e.g.
    // "in_progress"), matching `DbConversationSummary.status`.
    if let AcpEvent::ConversationStatusChanged {
        conversation_id,
        status,
    } = &envelope_arc.payload
    {
        if let Ok(serde_json::Value::String(status_str)) = serde_json::to_value(status) {
            emit_event(
                emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Status {
                    id: *conversation_id,
                    status: status_str,
                },
            );
        }
    }
    true
}

/// Cowork fork: whether applying `payload` can change what
/// [`SessionState::background_pending`] reports, or which conversation it is
/// reported for. Checked before the state is touched, so the hot path (content
/// and tool-call deltas) skips the before/after reading.
fn moves_background_pending(payload: &AcpEvent) -> bool {
    matches!(
        payload,
        AcpEvent::BackgroundActivity { .. }
            | AcpEvent::AsyncTask { .. }
            | AcpEvent::SessionStarted { .. }
            | AcpEvent::ConversationLinked { .. }
            | AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected
            }
    )
}

fn is_disconnect(payload: &AcpEvent) -> bool {
    matches!(
        payload,
        AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected
        }
    )
}

/// A connection's conversation and its [`SessionState::background_pending`].
type BackgroundPendingReading = (Option<i32>, (u32, Vec<String>));

/// Cowork fork: the [`BACKGROUND_PENDING_EVENT`] broadcasts that take every
/// client from a connection's `before` reading to its `after` one — none when
/// nothing changed or no conversation is bound; for a connection re-linked to
/// another conversation, a clear for the old row and the new row's state.
fn background_pending_changes(
    before: BackgroundPendingReading,
    after: BackgroundPendingReading,
) -> Vec<BackgroundPendingEntry> {
    let (before_id, (before_count, before_names)) = before;
    let (after_id, (after_count, after_names)) = after;
    let mut changes = Vec::new();
    if before_id != after_id {
        if let Some(conversation_id) = before_id.filter(|_| before_count > 0) {
            changes.push(BackgroundPendingEntry::idle(conversation_id));
        }
        if let Some(conversation_id) = after_id.filter(|_| after_count > 0) {
            changes.push(BackgroundPendingEntry::reading(
                conversation_id,
                after_count,
                after_names,
                Vec::new(),
            ));
        }
    } else if let Some(conversation_id) = after_id {
        if before_count != after_count || before_names != after_names {
            changes.push(BackgroundPendingEntry::reading(
                conversation_id,
                after_count,
                after_names,
                Vec::new(),
            ));
        }
    }
    changes
}

/// Cowork 加的：一条连接在一个会动读数的事件前后的样子，交给「留下来的『?』」表。
struct BackgroundPendingUpdate {
    /// 这条连接的 [`crate::acp::SessionState`] 编号。
    generation: u64,
    before: BackgroundPendingReading,
    /// 断开前还没完的后台任务（只在断开时读）。
    before_tasks: Vec<BackgroundPendingTask>,
    /// 事件前进程观察的结论（活着的连接上的「?」）。
    before_reason: Option<BackgroundUncertainReason>,
    after: BackgroundPendingReading,
    /// 事件后还没完的后台任务（`count > 0` 或有「?」时才读）。
    after_tasks: Vec<BackgroundPendingTask>,
    /// 事件后进程观察的结论。
    after_reason: Option<BackgroundUncertainReason>,
    /// 事件是断开。
    disconnected: bool,
    /// 断开时这一轮没跑完或者以失败收尾（#817），只在 `disconnected` 时可能是 `true`。
    turn_failed: bool,
    /// 事件后这条连接的智能体会话 id（[`SessionState::external_id`]）。
    external_id: Option<String>,
    /// 这条连接启动时要 resume 的会话 id（[`SessionState::resumed_from_external_id`]）。
    resumed_from: Option<String>,
}

/// Cowork 加的：把读数交给表，并把该发的广播发出去。拿着表锁发，和别的连接、和
/// [`clear_uncertain_background`] 对同一个对话的广播排好先后。没有 broadcaster（`Noop`、
/// 桌面上没注册）就只算不记。
fn publish_background_pending(emitter: &EventEmitter, update: BackgroundPendingUpdate) {
    let broadcaster = emitter.web_broadcaster();
    let mut scratch = BackgroundSlots::new();
    let mut guard = broadcaster.as_ref().map(|b| b.lock_background_slots());
    let slots = match guard.as_mut() {
        Some(slots) => &mut **slots,
        None => &mut scratch,
    };
    for change in background_pending_broadcasts(slots, update) {
        emit_event(emitter, BACKGROUND_PENDING_EVENT, change);
    }
}

/// Cowork 加的：轮询改了一条连接的进程观察结论（`before` → `s.process_watch.uncertain`），
/// 走和事件同一条路（同一个表、同一套编号）把这一行发出去。调用方拿着会话写锁。
pub(crate) fn publish_process_observation(
    emitter: &EventEmitter,
    s: &SessionState,
    before: Option<BackgroundUncertainReason>,
) {
    if s.status == ConnectionStatus::Disconnected {
        return;
    }
    let after_reason = s.process_watch.uncertain;
    let reading = s.background_pending();
    let after_tasks = if reading.0 > 0 || after_reason.is_some() {
        s.background_pending_tasks()
    } else {
        Vec::new()
    };
    publish_background_pending(
        emitter,
        BackgroundPendingUpdate {
            generation: s.generation,
            before: (s.conversation_id, reading.clone()),
            before_tasks: Vec::new(),
            before_reason: before,
            after: (s.conversation_id, reading),
            after_tasks,
            after_reason,
            disconnected: false,
            turn_failed: false,
            external_id: s.external_id.clone(),
            resumed_from: s.resumed_from_external_id.clone(),
        },
    );
}

/// 编号是 `generation` 的连接给 `conversation_id` 报读数：编号不比表里的小就记下、返回
/// `true`；更旧的连接返回 `false`（不进表、也不广播）。
fn admit_background_reading(
    slots: &mut BackgroundSlots,
    conversation_id: i32,
    generation: u64,
) -> bool {
    let slot = slots.entry(conversation_id).or_default();
    if generation < slot.generation {
        return false;
    }
    slot.generation = generation;
    slot.retired_through = None;
    true
}

/// #834：编号是 `generation` 的连接是不是被 [`retire_uncertain_background`] 挡住的那条（而且
/// 之后没有更新的连接接手这个对话）。
fn is_retired_connection(slots: &BackgroundSlots, conversation_id: i32, generation: u64) -> bool {
    slots.get(&conversation_id).is_some_and(|slot| {
        generation < slot.generation && slot.retired_through.is_some_and(|r| generation <= r)
    })
}

/// Cowork 加的：一次读数变化要发的 [`BACKGROUND_PENDING_EVENT`]，顺带改表：
/// - 编号比表里小的连接，什么都不发、不记；
/// - 活着的连接报读数（包括绑到这个对话上，即使 `count` 是 0），删掉留下来的「?」并发 `idle`；
/// - 较新的连接从较旧的连接手里接过一个对话，即使 `count` 是 0 也发它自己的读数（`idle`），
///   清掉旧连接留在客户端上的沙漏或「?」；
/// - 断开前 `count > 0`，发 `agent_exited` 的「?」并留在表里；这一轮没跑完或失败了（#817，
///   回合会被标成取消）就发 `abandoned`（没跑完的后台任务）代替「?」，也留在表里；
/// - 其余和原来一样（[`background_pending_changes`]）。
fn background_pending_broadcasts(
    slots: &mut BackgroundSlots,
    update: BackgroundPendingUpdate,
) -> Vec<BackgroundPendingEntry> {
    let BackgroundPendingUpdate {
        generation,
        before,
        before_tasks,
        before_reason,
        after,
        after_tasks,
        after_reason,
        disconnected,
        turn_failed,
        external_id,
        resumed_from,
    } = update;
    let (before_id, (before_count, _)) = &before;
    let after_id = after.0;
    let (after_count, after_names) = after.1.clone();
    // 事件前这一行在客户端上不是空的：有沙漏，或者有活着的连接的「?」。
    let before_shown = *before_count > 0 || before_reason.is_some();
    let mut out = Vec::new();

    if disconnected {
        // #834：被取消的任务连接晚到的断开：编号虽然被挡住了，客户端上它的沙漏或「?」还得清。
        let retired = after_id.is_some_and(|id| is_retired_connection(slots, id, generation));
        // 断开不换对话。断开前在等后台，后台活跟着进程没了：留「?」。`count` 照旧 0。
        if *before_count == 0 {
            // 只是在跑、被进程观察标了「?」的：不留（回合由 `handle_terminal_event` 标成
            // 取消），把客户端上那个「?」清掉。
            if let Some(conversation_id) = after_id.filter(|_| before_reason.is_some()) {
                if retired || admit_background_reading(slots, conversation_id, generation) {
                    out.push(BackgroundPendingEntry::idle(conversation_id));
                }
            }
            return out;
        }
        let Some(conversation_id) = after_id else {
            return out;
        };
        if retired {
            // 任务取消了，不留「?」。回合没跑完的照 #817 记下没跑完的后台任务给红叉；
            // 跑完了的（待复查）发 `idle`，把客户端上的沙漏清掉。编号不动，挡板照旧。
            if turn_failed {
                let entry = BackgroundPendingEntry::abandoned(conversation_id, before_tasks);
                if let Some(slot) = slots.get_mut(&conversation_id) {
                    slot.uncertain = Some(entry.clone());
                    slot.external_id = external_id;
                }
                out.push(entry);
            } else {
                out.push(BackgroundPendingEntry::idle(conversation_id));
            }
            return out;
        }
        if !admit_background_reading(slots, conversation_id, generation) {
            return out;
        }
        let entry = if turn_failed {
            BackgroundPendingEntry::abandoned(conversation_id, before_tasks)
        } else {
            BackgroundPendingEntry::uncertain(
                conversation_id,
                BackgroundUncertainReason::AgentExited,
                before_tasks,
            )
        };
        if let Some(slot) = slots.get_mut(&conversation_id) {
            slot.uncertain = Some(entry.clone());
            slot.external_id = external_id;
        }
        out.push(entry);
        return out;
    }

    // #441：活着的连接 resume 着留下「?」的那个会话（还没绑对话；resume 失败回退成新会话的
    // 也算，看启动时要 resume 的 id）：智能体已经起来了，这个「?」作废、发 `idle`。
    if external_id.is_some() {
        let binding = LiveBinding {
            conversation_id: None,
            external_id: external_id.clone(),
            resumed_from,
            generation,
        };
        let mut claimed: Vec<i32> = slots
            .iter()
            .filter(|(id, slot)| slot.uncertain.is_some() && binding.claims(**id, slot))
            .map(|(id, _)| *id)
            .collect();
        claimed.sort_unstable();
        for conversation_id in claimed {
            if let Some(slot) = slots.get_mut(&conversation_id) {
                slot.uncertain = None;
                slot.external_id = None;
                slot.generation = generation;
                slot.retired_through = None;
            }
            out.push(BackgroundPendingEntry::idle(conversation_id));
        }
    }

    // 换了对话：旧的那一行照原来的规矩清，但旧行上更新的连接说了算。
    let relinked = *before_id != after_id;
    // #530：这条连接从另一条（更旧的）连接手里接过新对话那一行。表里那一行显示的是旧连接
    // 最后的样子，接手后要把自己的状态推一次（没有后台任务就推 `idle`）。
    let took_over = relinked
        && after_id
            .and_then(|id| slots.get(&id))
            .is_some_and(|slot| slot.generation != 0 && slot.generation < generation);
    let old_row_admitted = !relinked
        || before_id
            .filter(|_| before_shown)
            .is_none_or(|old| admit_background_reading(slots, old, generation));
    let new_row_admitted =
        after_id.is_some_and(|id| admit_background_reading(slots, id, generation));

    // 活着的连接报了这个对话的读数（包括刚绑上、`count` 是 0）：留下来的「?」作废。
    if let Some(conversation_id) = after_id.filter(|_| new_row_admitted) {
        let removed = slots
            .get_mut(&conversation_id)
            .and_then(|slot| slot.uncertain.take())
            .is_some();
        if removed {
            out.push(BackgroundPendingEntry::idle(conversation_id));
        }
    }

    let mut changes = background_pending_changes(before.clone(), after);
    // 进程观察的「?」：读数没变、只有结论变了，或者 `count` 是 0 的那一行带着「?」，
    // [`background_pending_changes`] 都不会发，这里补上。
    if relinked {
        if let Some(old) = before_id.filter(|_| *before_count == 0 && before_reason.is_some()) {
            changes.insert(0, BackgroundPendingEntry::idle(old));
        }
        if let Some(new) =
            after_id.filter(|_| after_count == 0 && (after_reason.is_some() || took_over))
        {
            changes.push(BackgroundPendingEntry::idle(new));
        }
    } else if let Some(conversation_id) = after_id {
        if before_reason != after_reason && changes.is_empty() {
            changes.push(BackgroundPendingEntry::reading(
                conversation_id,
                after_count,
                after_names,
                Vec::new(),
            ));
        }
    }

    for mut change in changes {
        let admitted = if Some(change.conversation_id) == after_id {
            new_row_admitted
        } else {
            old_row_admitted
        };
        if !admitted {
            continue;
        }
        if Some(change.conversation_id) == after_id {
            if let Some(reason) = after_reason {
                change.state = BackgroundPendingState::Uncertain;
                change.reason = Some(reason);
                change.tasks = after_tasks.clone();
            }
        }
        // 上面已经为删「?」发过 `idle` 了，同一条不重发。
        if change.count == 0 && out.contains(&change) {
            continue;
        }
        if Some(change.conversation_id) == after_id && change.count > 0 {
            change.tasks = after_tasks.clone();
        }
        out.push(change);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::entities::conversation::ConversationStatus;
    use crate::models::AgentType;

    fn fresh_state() -> Arc<RwLock<SessionState>> {
        Arc::new(RwLock::new(SessionState::new(
            "conn-test".to_string(),
            AgentType::ClaudeCode,
            None,
            "win-test".to_string(),
            None,
        )))
    }

    #[tokio::test]
    async fn emit_with_state_bridges_status_change_to_global_channel() {
        // A ConversationStatusChanged ACP event must ALSO surface on the global
        // `conversation://changed` channel so clients NOT attached to this
        // connection (e.g. only viewing the sidebar) still observe the flip.
        let state = fresh_state();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ConversationStatusChanged {
                conversation_id: 7,
                status: ConversationStatus::PendingReview,
            },
        )
        .await;

        let evt = rx
            .try_recv()
            .expect("status change should bridge to the global channel");
        let p = &*evt.payload;
        assert_eq!(evt.channel, CONVERSATION_CHANGED_EVENT);
        assert_eq!(p["kind"], "status");
        assert_eq!(p["id"], 7);
        assert_eq!(p["status"], "pending_review");
    }

    #[tokio::test]
    async fn emit_with_state_non_status_event_does_not_touch_global_channel() {
        // High-frequency stream events (deltas, etc.) must NOT spam the global
        // sidebar channel — only status transitions bridge.
        let state = fresh_state();
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ContentDelta {
                text: "hello".to_string(),
                parent_tool_use_id: None,
            },
        )
        .await;

        assert!(
            rx.try_recv().is_err(),
            "non-status ACP events must not emit on conversation://changed"
        );
    }

    fn background_activity(outstanding: u32, watermark: u64) -> AcpEvent {
        AcpEvent::BackgroundActivity {
            session_id: "sid".into(),
            turns: vec![],
            outstanding,
            outstanding_tasks: vec![],
            settled: vec![],
            watermark,
        }
    }

    /// Cowork fork: background work reaches every client's sidebar, not just
    /// the ones attached to the connection — on a change only, and cleared
    /// when the connection ends.
    #[tokio::test]
    async fn emit_with_state_bridges_background_pending_to_global_channel() {
        let state = fresh_state();
        state.write().await.conversation_id = Some(7);
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_with_state(&state, &emitter, background_activity(1, 10)).await;
        let evt = rx
            .try_recv()
            .expect("background work should bridge to the global channel");
        assert_eq!(evt.channel, BACKGROUND_PENDING_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["conversation_id"], 7);
        assert_eq!(p["count"], 1);
        assert_eq!(p["state"], "waiting");
        assert!(p["reason"].is_null());
        assert!(p["tasks"].is_array());

        // Same count again (a turn surfaced, nothing settled): no broadcast.
        emit_with_state(&state, &emitter, background_activity(1, 20)).await;
        assert!(rx.try_recv().is_err(), "an unchanged count must stay quiet");

        emit_with_state(
            &state,
            &emitter,
            AcpEvent::StatusChanged {
                status: ConnectionStatus::Disconnected,
            },
        )
        .await;
        let evt = rx
            .try_recv()
            .expect("the connection ending should clear the hourglass");
        assert_eq!(evt.channel, BACKGROUND_PENDING_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["conversation_id"], 7);
        assert_eq!(p["count"], 0);
        assert_eq!(p["state"], "uncertain");
        assert_eq!(p["reason"], "agent_exited");
    }

    fn watcher_activity(tasks: &[(&str, &str)], watermark: u64) -> AcpEvent {
        AcpEvent::BackgroundActivity {
            session_id: "sid".into(),
            turns: vec![],
            outstanding: tasks.len() as u32,
            outstanding_tasks: tasks
                .iter()
                .map(
                    |(id, description)| crate::acp::types::BackgroundOutstandingTask {
                        task_id: (*id).into(),
                        kind: crate::acp::types::BackgroundTaskKind::Shell,
                        tool_use_id: None,
                        description: Some((*description).into()),
                        started_at_ms: 1_000,
                    },
                )
                .collect(),
            settled: vec![],
            watermark,
        }
    }

    fn linked(conversation_id: i32) -> AcpEvent {
        AcpEvent::ConversationLinked {
            conversation_id,
            folder_id: 1,
            parent_conversation_id: None,
            parent_tool_use_id: None,
        }
    }

    fn disconnected() -> AcpEvent {
        AcpEvent::StatusChanged {
            status: ConnectionStatus::Disconnected,
        }
    }

    /// 一个收 web 广播的发射器，和它后面的 broadcaster。
    fn web_emitter() -> (
        Arc<WebEventBroadcaster>,
        EventEmitter,
        broadcast::Receiver<WebEvent>,
    ) {
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        (broadcaster, emitter, rx)
    }

    /// 只留 `conversation://background` 上的广播。
    fn background_events(rx: &mut broadcast::Receiver<WebEvent>) -> Vec<serde_json::Value> {
        let mut out = Vec::new();
        while let Ok(evt) = rx.try_recv() {
            if evt.channel == BACKGROUND_PENDING_EVENT {
                out.push((*evt.payload).clone());
            }
        }
        out
    }

    /// 完成标准 2：等后台时断开，广播「?」（`count` 照旧 0、带断开前的任务）并留在表里。
    #[tokio::test]
    async fn disconnect_with_background_work_leaves_an_uncertain_mark() {
        let state = fresh_state();
        state.write().await.conversation_id = Some(7);
        let (broadcaster, emitter, mut rx) = web_emitter();

        emit_with_state(&state, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        let first = background_events(&mut rx);
        assert_eq!(first.len(), 1);
        assert_eq!(first[0]["count"], 1);
        assert_eq!(first[0]["state"], "waiting");
        assert_eq!(
            first[0]["tasks"],
            serde_json::json!([{ "task_id": "b1", "name": "Watch CI" }])
        );

        emit_with_state(&state, &emitter, disconnected()).await;
        let second = background_events(&mut rx);
        assert_eq!(
            second,
            vec![serde_json::json!({
                "conversation_id": 7,
                "count": 0,
                "names": [],
                "state": "uncertain",
                "reason": "agent_exited",
                "tasks": [{ "task_id": "b1", "name": "Watch CI" }],
            })]
        );
        let listed = broadcaster.merge_background_pending(Vec::new());
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].state,
            crate::acp::types::BackgroundPendingState::Uncertain
        );

        // 断开以后同一条连接再来的读数不算数。
        emit_with_state(&state, &emitter, watcher_activity(&[], 2)).await;
        assert!(background_events(&mut rx).is_empty());
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);
    }

    /// #817：回合还没跑完（或者刚以失败收尾）就断开、手上还有后台任务：这一轮会被标成取消
    /// （红叉），不留「?」。广播 `abandoned`（带断开前的任务，给红叉的悬停写任务名），留在
    /// 表里；之后不管取消先到还是后到，它都不变成「?」，取消也不删它，完成才删。
    #[tokio::test]
    async fn disconnect_mid_turn_leaves_abandoned_tasks_not_an_uncertain_mark() {
        let abandoned = serde_json::json!({
            "conversation_id": 7,
            "count": 0,
            "names": [],
            "state": "abandoned",
            "reason": null,
            "tasks": [{ "task_id": "b1", "name": "Watch CI" }],
        });
        let failure = crate::acp::types::SessionFailureRecord {
            id: "t1:error".into(),
            revision: 1,
            category: "connection".into(),
            severity: "error".into(),
            title: "CLI exited".into(),
            details: None,
            actions: vec!["new_session".into()],
            resolved: false,
        };
        // 两种：智能体在回合中途被杀（回合还在跑）；CLI 被杀、适配器以失败收了这一轮。
        for turn_failed_by_session_failure in [false, true] {
            let state = fresh_state();
            state.write().await.conversation_id = Some(7);
            let (broadcaster, emitter, mut rx) = web_emitter();
            emit_with_state(&state, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
            let _ = background_events(&mut rx);
            if turn_failed_by_session_failure {
                emit_with_state(
                    &state,
                    &emitter,
                    AcpEvent::SessionFailure {
                        record: failure.clone(),
                    },
                )
                .await;
            } else {
                state.write().await.turn_in_flight = true;
            }

            emit_with_state(&state, &emitter, disconnected()).await;
            assert_eq!(
                background_events(&mut rx),
                vec![abandoned.clone()],
                "failure={turn_failed_by_session_failure}"
            );
            let listed = broadcaster.merge_background_pending(Vec::new());
            assert_eq!(listed.len(), 1);
            assert_eq!(
                listed[0].state,
                crate::acp::types::BackgroundPendingState::Abandoned
            );

            // 取消不删它（红叉要接着写任务名）。
            emit_event(
                &emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Status {
                    id: 7,
                    status: "cancelled".into(),
                },
            );
            assert!(background_events(&mut rx).is_empty());
            assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);

            // 完成删掉。
            emit_event(
                &emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Status {
                    id: 7,
                    status: "completed".into(),
                },
            );
            assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
            assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
        }
    }

    /// 完成标准 11、13：轮询把一条活着的连接标成「?」时广播它（`count` 的意思不变）；
    /// 一条内容事件是进展，「?」马上变回「等后台」并广播。
    #[tokio::test]
    async fn a_live_uncertain_mark_is_published_and_cleared_by_progress() {
        use crate::acp::types::BackgroundUncertainReason;
        let state = fresh_state();
        state.write().await.conversation_id = Some(7);
        let (broadcaster, emitter, mut rx) = web_emitter();
        emit_with_state(&state, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        let _ = background_events(&mut rx);

        {
            let mut s = state.write().await;
            s.process_watch.uncertain = Some(BackgroundUncertainReason::AgentExited);
            publish_process_observation(&emitter, &s, None);
        }
        assert_eq!(
            background_events(&mut rx),
            vec![serde_json::json!({
                "conversation_id": 7,
                "count": 1,
                "names": ["Watch CI"],
                "state": "uncertain",
                "reason": "agent_exited",
                "tasks": [{ "task_id": "b1", "name": "Watch CI" }],
            })]
        );
        // 活着的连接的「?」不进留下来的表。
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());

        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ContentDelta {
                text: "still here".to_string(),
                parent_tool_use_id: None,
            },
        )
        .await;
        assert_eq!(state.read().await.process_watch.uncertain, None);
        let cleared = background_events(&mut rx);
        assert_eq!(cleared.len(), 1);
        assert_eq!(cleared[0]["state"], "waiting");
        assert_eq!(cleared[0]["count"], 1);
        assert!(cleared[0]["reason"].is_null());

        // 没有「?」时内容事件照旧什么都不发。
        emit_with_state(
            &state,
            &emitter,
            AcpEvent::ContentDelta {
                text: "more".to_string(),
                parent_tool_use_id: None,
            },
        )
        .await;
        assert!(background_events(&mut rx).is_empty());
    }

    /// 在跑、没有后台活的连接被标了「?」（`count` 是 0）以后断开：不留「?」，清成 `idle`
    /// （回合由 `handle_terminal_event` 标成取消）。
    #[tokio::test]
    async fn a_foreground_uncertain_mark_is_cleared_on_disconnect() {
        use crate::acp::types::BackgroundUncertainReason;
        let state = fresh_state();
        state.write().await.conversation_id = Some(7);
        let (broadcaster, emitter, mut rx) = web_emitter();
        {
            let mut s = state.write().await;
            s.process_watch.uncertain = Some(BackgroundUncertainReason::AgentExited);
            publish_process_observation(&emitter, &s, None);
        }
        let marked = background_events(&mut rx);
        assert_eq!(marked.len(), 1);
        assert_eq!(marked[0]["state"], "uncertain");
        assert_eq!(marked[0]["count"], 0);

        emit_with_state(&state, &emitter, disconnected()).await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// 完成标准 2：断开前 `count` 是 0，和原来一样什么都不发，也不留「?」。
    #[tokio::test]
    async fn disconnect_without_background_work_stays_quiet() {
        let state = fresh_state();
        state.write().await.conversation_id = Some(7);
        let (broadcaster, emitter, mut rx) = web_emitter();
        emit_with_state(&state, &emitter, disconnected()).await;
        assert!(background_events(&mut rx).is_empty());
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// 让对话 7 留下一个「?」：一条连接绑上 7、等后台、断开。
    async fn leave_uncertain_mark(emitter: &EventEmitter) {
        let state = fresh_state();
        emit_with_state(&state, emitter, linked(7)).await;
        emit_with_state(&state, emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        emit_with_state(&state, emitter, disconnected()).await;
    }

    fn idle_entry(conversation_id: i32) -> serde_json::Value {
        serde_json::json!({
            "conversation_id": conversation_id,
            "count": 0,
            "names": [],
            "state": "idle",
            "reason": null,
            "tasks": [],
        })
    }

    /// #441：刷新后打开会话自动连上的新连接只 resume 智能体会话（`SessionStarted` 报同一个
    /// 会话 id），要到第一次发消息才绑对话。它连上了就删掉这个对话留下的「?」并广播 `idle`，
    /// 不然侧栏写「已退出」、连接点写「已连接」。
    #[tokio::test]
    async fn a_new_connection_resuming_the_session_clears_the_mark() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        let old = fresh_state();
        emit_with_state(
            &old,
            &emitter,
            AcpEvent::SessionStarted {
                session_id: "sid-old".into(),
            },
        )
        .await;
        emit_with_state(&old, &emitter, linked(7)).await;
        emit_with_state(&old, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        emit_with_state(&old, &emitter, disconnected()).await;
        let _ = background_events(&mut rx);
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);

        // 别的会话 id 不算。
        let other = fresh_state();
        emit_with_state(
            &other,
            &emitter,
            AcpEvent::SessionStarted {
                session_id: "sid-other".into(),
            },
        )
        .await;
        assert!(background_events(&mut rx).is_empty());
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);

        let next = fresh_state();
        emit_with_state(
            &next,
            &emitter,
            AcpEvent::SessionStarted {
                session_id: "sid-old".into(),
            },
        )
        .await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// #441（返工）：resume 旧会话失败、或者智能体不支持 resume，回退成新会话：新连接的
    /// `SessionStarted` 报的是新的会话 id、也还没绑对话，但它启动时要 resume 的就是留下「?」
    /// 的那个会话，照样删掉「?」并广播 `idle`。
    #[tokio::test]
    async fn a_new_connection_falling_back_from_the_session_clears_the_mark() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        let old = fresh_state();
        emit_with_state(
            &old,
            &emitter,
            AcpEvent::SessionStarted {
                session_id: "sid-old".into(),
            },
        )
        .await;
        emit_with_state(&old, &emitter, linked(7)).await;
        emit_with_state(&old, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        emit_with_state(&old, &emitter, disconnected()).await;
        let _ = background_events(&mut rx);
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);

        // 要 resume 别的会话、回退成新会话的不算。
        let other = fresh_state();
        other.write().await.resumed_from_external_id = Some("sid-other".into());
        emit_with_state(
            &other,
            &emitter,
            AcpEvent::SessionStarted {
                session_id: "sid-fresh-1".into(),
            },
        )
        .await;
        assert!(background_events(&mut rx).is_empty());
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);

        let next = fresh_state();
        next.write().await.resumed_from_external_id = Some("sid-old".into());
        emit_with_state(
            &next,
            &emitter,
            AcpEvent::SessionStarted {
                session_id: "sid-fresh-2".into(),
            },
        )
        .await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// #441：列表时有没断开的活连接绑着对话 7（编号比留下「?」的连接新），不补「?」，
    /// 表里的也删掉；比它旧的连接不算。
    #[tokio::test]
    async fn merge_skips_a_mark_claimed_by_a_bound_live_connection() {
        let (broadcaster, emitter, _rx) = web_emitter();
        let older = fresh_state();
        let older_generation = older.read().await.generation;
        leave_uncertain_mark(&emitter).await;
        let newer_generation = fresh_state().read().await.generation;

        let binding = |generation| LiveBinding {
            conversation_id: Some(7),
            external_id: None,
            resumed_from: None,
            generation,
        };
        assert_eq!(
            broadcaster
                .merge_background_pending_with(Vec::new(), &[binding(older_generation)])
                .len(),
            1
        );
        assert!(broadcaster
            .merge_background_pending_with(Vec::new(), &[binding(newer_generation)])
            .is_empty());
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// #834：按编号挡住的连接晚到的断开不再留「?」，但要发 `idle` 把客户端上它的沙漏清掉；
    /// 之后新起的连接照常报读数、留「?」。
    #[tokio::test]
    async fn a_retired_connection_cannot_put_the_mark_back() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        let retired = fresh_state();
        emit_with_state(&retired, &emitter, linked(7)).await;
        emit_with_state(
            &retired,
            &emitter,
            watcher_activity(&[("b1", "Watch CI")], 1),
        )
        .await;
        let fence = retired.read().await.generation;

        retire_uncertain_background(&emitter, 7, SettledAs::Cancelled, Some(fence));
        let _ = background_events(&mut rx);
        emit_with_state(&retired, &emitter, disconnected()).await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());

        leave_uncertain_mark(&emitter).await;
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);
    }

    /// #834 + #817：回合还在跑时取消任务，被挡住的任务连接后来才断开：不留「?」，没跑完的
    /// 后台任务照样记下、广播给红叉写任务名。
    #[tokio::test]
    async fn a_retired_connection_disconnecting_mid_turn_still_leaves_abandoned_tasks() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        let retired = fresh_state();
        emit_with_state(&retired, &emitter, linked(7)).await;
        emit_with_state(
            &retired,
            &emitter,
            watcher_activity(&[("b1", "Watch CI")], 1),
        )
        .await;
        retired.write().await.turn_in_flight = true;
        let fence = retired.read().await.generation;

        retire_uncertain_background(&emitter, 7, SettledAs::Cancelled, Some(fence));
        let _ = background_events(&mut rx);
        emit_with_state(&retired, &emitter, disconnected()).await;
        assert_eq!(
            background_events(&mut rx),
            vec![serde_json::json!({
                "conversation_id": 7,
                "count": 0,
                "names": [],
                "state": "abandoned",
                "reason": null,
                "tasks": [{ "task_id": "b1", "name": "Watch CI" }],
            })]
        );
        let listed = broadcaster.merge_background_pending(Vec::new());
        assert_eq!(listed.len(), 1);
        assert_eq!(
            listed[0].state,
            crate::acp::types::BackgroundPendingState::Abandoned
        );
    }

    /// 完成标准 4：新连接绑到这个对话上，即使 `count` 是 0，也删掉「?」并广播 `idle`。
    #[tokio::test]
    async fn a_new_connection_linking_the_conversation_clears_the_mark() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        leave_uncertain_mark(&emitter).await;
        let _ = background_events(&mut rx);

        let next = fresh_state();
        emit_with_state(&next, &emitter, linked(7)).await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// 完成标准 4：一条连接的对话 id 换成这个对话（不经 `ConversationLinked`）也算绑上。
    #[tokio::test]
    async fn a_connection_relinked_onto_the_conversation_clears_the_mark() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        leave_uncertain_mark(&emitter).await;
        let _ = background_events(&mut rx);

        let next = fresh_state();
        emit_with_state(&next, &emitter, linked(8)).await;
        next.write().await.conversation_id = Some(7);
        emit_with_state(&next, &emitter, watcher_activity(&[], 1)).await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// 完成标准 4：`conversation://changed` 的 `Status` 是完成 / 取消时删。
    #[tokio::test]
    async fn a_settled_status_clears_the_mark() {
        for status in ["completed", "cancelled"] {
            let (broadcaster, emitter, mut rx) = web_emitter();
            leave_uncertain_mark(&emitter).await;
            let _ = background_events(&mut rx);

            // 还在审的状态不删。
            emit_event(
                &emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Status {
                    id: 7,
                    status: "pending_review".into(),
                },
            );
            assert!(background_events(&mut rx).is_empty());
            assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);

            emit_event(
                &emitter,
                CONVERSATION_CHANGED_EVENT,
                ConversationChange::Status {
                    id: 7,
                    status: status.into(),
                },
            );
            assert_eq!(background_events(&mut rx), vec![idle_entry(7)], "{status}");
            assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
        }
    }

    /// 完成标准 4：界面上手动改状态走 `Upsert`，`summary.status` 是完成时删。
    #[tokio::test]
    async fn a_settled_upsert_clears_the_mark() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        leave_uncertain_mark(&emitter).await;
        let _ = background_events(&mut rx);

        let upsert = |status: &str| serde_json::json!({ "kind": "upsert", "summary": { "id": 7, "status": status } });
        emit_event(
            &emitter,
            CONVERSATION_CHANGED_EVENT,
            upsert("pending_review"),
        );
        assert!(background_events(&mut rx).is_empty());
        emit_event(&emitter, CONVERSATION_CHANGED_EVENT, upsert("completed"));
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// 完成标准 4：删掉对话时删。
    #[tokio::test]
    async fn deleting_the_conversation_clears_the_mark() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        leave_uncertain_mark(&emitter).await;
        let _ = background_events(&mut rx);

        emit_event(
            &emitter,
            CONVERSATION_CHANGED_EVENT,
            ConversationChange::Deleted { id: 8 },
        );
        assert!(background_events(&mut rx).is_empty());
        emit_event(
            &emitter,
            CONVERSATION_CHANGED_EVENT,
            ConversationChange::Deleted { id: 7 },
        );
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// 完成标准 4：表只在内存里，服务器重启（新的 broadcaster）以后没有。
    #[tokio::test]
    async fn a_restarted_server_has_no_marks() {
        let (broadcaster, emitter, _rx) = web_emitter();
        leave_uncertain_mark(&emitter).await;
        assert_eq!(broadcaster.merge_background_pending(Vec::new()).len(), 1);
        let restarted = WebEventBroadcaster::new();
        assert!(restarted.merge_background_pending(Vec::new()).is_empty());
    }

    /// 完成标准 5：A 绑 7、B 再绑 7，A 带着 `count = 1` 断开：没有广播，表里没有「?」。
    #[tokio::test]
    async fn an_older_connection_cannot_overwrite_a_newer_one() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        let a = fresh_state();
        let b = fresh_state();
        emit_with_state(&a, &emitter, linked(7)).await;
        emit_with_state(&b, &emitter, linked(7)).await;
        let _ = background_events(&mut rx);

        emit_with_state(&a, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        emit_with_state(&a, &emitter, disconnected()).await;
        assert!(background_events(&mut rx).is_empty());
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// #530 完成标准 1：A 绑 7、有 1 个后台任务（沙漏），B 再绑 7、没有后台任务：推一条 7 的
    /// `idle` 把 A 的沙漏清掉；之后 A 的读数、断开都不再推。
    #[tokio::test]
    async fn a_newer_connection_linking_clears_an_older_connections_hourglass() {
        let (broadcaster, emitter, mut rx) = web_emitter();
        let a = fresh_state();
        let b = fresh_state();
        emit_with_state(&a, &emitter, linked(7)).await;
        emit_with_state(&a, &emitter, watcher_activity(&[("b1", "Watch CI")], 1)).await;
        let shown = background_events(&mut rx);
        assert_eq!(shown.len(), 1);
        assert_eq!(shown[0]["count"], 1);

        emit_with_state(&b, &emitter, linked(7)).await;
        assert_eq!(background_events(&mut rx), vec![idle_entry(7)]);

        emit_with_state(&a, &emitter, watcher_activity(&[], 2)).await;
        emit_with_state(&a, &emitter, disconnected()).await;
        assert!(background_events(&mut rx).is_empty());
        assert!(broadcaster.merge_background_pending(Vec::new()).is_empty());
    }

    /// #530 完成标准 2：B 接手时自己有后台任务，推的是 B 的读数。
    #[tokio::test]
    async fn a_newer_connection_linking_with_work_publishes_its_own_reading() {
        let (_broadcaster, emitter, mut rx) = web_emitter();
        let a = fresh_state();
        let b = fresh_state();
        emit_with_state(&a, &emitter, linked(7)).await;
        emit_with_state(
            &a,
            &emitter,
            watcher_activity(&[("a1", "Watch CI"), ("a2", "Tail log")], 1),
        )
        .await;
        emit_with_state(&b, &emitter, watcher_activity(&[("b1", "Build")], 1)).await;
        let _ = background_events(&mut rx);

        emit_with_state(&b, &emitter, linked(7)).await;
        let pushed = background_events(&mut rx);
        assert_eq!(pushed.len(), 1);
        assert_eq!(pushed[0]["conversation_id"], 7);
        assert_eq!(pushed[0]["count"], 1);
        assert_eq!(pushed[0]["names"], serde_json::json!(["Build"]));
        assert_eq!(pushed[0]["state"], "waiting");
    }

    /// #530：同一条连接重报自己的对话、或第一条连接绑上空对话，照旧什么都不推。
    #[tokio::test]
    async fn linking_an_unowned_conversation_without_work_stays_quiet() {
        let (_broadcaster, emitter, mut rx) = web_emitter();
        let a = fresh_state();
        emit_with_state(&a, &emitter, linked(7)).await;
        emit_with_state(&a, &emitter, linked(7)).await;
        assert!(background_events(&mut rx).is_empty());
    }

    /// 完成标准 3：同一个对话又有一条活连接报着 `count > 0` 时，列表以活连接为准。
    #[tokio::test]
    async fn the_list_prefers_a_live_reading_over_a_mark() {
        let (broadcaster, emitter, _rx) = web_emitter();
        leave_uncertain_mark(&emitter).await;
        let live = BackgroundPendingEntry::reading(7, 2, vec!["sample.sh".into()], vec![]);
        let listed = broadcaster.merge_background_pending(vec![
            live.clone(),
            BackgroundPendingEntry::reading(9, 1, vec![], vec![]),
        ]);
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0], live);
        assert_eq!(listed[1].conversation_id, 9);
    }

    #[test]
    fn background_pending_changes_cover_relinks_and_unbound_connections() {
        let none = (0, Vec::new());
        let one = || (1, vec!["Watch CI".to_string()]);
        // Unbound: nobody's row to mark.
        assert!(background_pending_changes((None, none.clone()), (None, one())).is_empty());
        // Unchanged.
        assert!(background_pending_changes((Some(7), one()), (Some(7), one())).is_empty());
        // Labels alone changing still broadcasts.
        let renamed = background_pending_changes(
            (Some(7), (1, vec!["a".to_string()])),
            (Some(7), (1, vec!["b".to_string()])),
        );
        assert_eq!(renamed.len(), 1);
        assert_eq!(renamed[0].names, vec!["b".to_string()]);
        assert_eq!(
            renamed[0].state,
            crate::acp::types::BackgroundPendingState::Waiting
        );
        // Re-linked with work out: clear the old row, mark the new one.
        let relinked = background_pending_changes((Some(7), one()), (Some(8), one()));
        assert_eq!(
            relinked
                .iter()
                .map(|c| (c.conversation_id, c.count))
                .collect::<Vec<_>>(),
            vec![(7, 0), (8, 1)]
        );
        // First link of a connection with nothing out: nothing to say.
        assert!(background_pending_changes((None, none.clone()), (Some(7), none)).is_empty());
    }

    #[test]
    fn web_service_status_changed_carries_only_the_running_flag() {
        let wire = serde_json::to_value(WebServiceStatusChanged { running: true }).unwrap();
        assert_eq!(wire, serde_json::json!({ "running": true }));
    }

    #[test]
    fn emit_event_broadcasts_tabs_changed_snapshot() {
        // The open-tab set syncs via the same global side-channel as the
        // sidebar: one `emit_event` on `tabs://changed` reaches every client,
        // carrying version + origin (for echo suppression) + the full set.
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            TABS_CHANGED_EVENT,
            TabsChanged {
                version: 6,
                origin: "win-abc".to_string(),
                tabs: vec![],
            },
        );

        let evt = rx.try_recv().expect("tabs change should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, TABS_CHANGED_EVENT);
        assert_eq!(p["version"], 6);
        assert_eq!(p["origin"], "win-abc");
        assert!(p["tabs"].is_array(), "tabs must serialize as an array");
    }

    #[test]
    fn emit_event_broadcasts_folder_change_upsert() {
        // A headlessly-created folder (e.g. an automation worktree) reaches every
        // client via `folder://changed`, carrying the full detail so clients apply
        // it without a re-fetch. The boxed `folder` serializes transparently — the
        // wire shape is `{ "kind": "upsert", "folder": { … } }`.
        use crate::db::entities::folder::FolderKind;
        use crate::models::FolderDetail;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            FOLDER_CHANGED_EVENT,
            FolderChange::Upsert {
                folder: Box::new(FolderDetail {
                    id: 42,
                    name: "repo".to_string(),
                    path: "/home/me/repo".to_string(),
                    git_branch: Some("main".to_string()),
                    default_agent_type: None,
                    last_opened_at: chrono::Utc::now(),
                    sort_order: 0,
                    color: "inherit".to_string(),
                    parent_id: Some(7),
                    kind: FolderKind::Regular,
                    alias: None,
                    group_id: None,
                }),
            },
        );

        let evt = rx.try_recv().expect("folder change should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["folder"]["id"], 42);
        assert_eq!(p["folder"]["parent_id"], 7);
        assert_eq!(p["folder"]["kind"], "regular");
    }

    #[test]
    fn emit_event_broadcasts_folder_change_deleted() {
        // A removed task worktree rides the SAME channel as its creation, so a
        // client that learned about the folder from an upsert also hears it go.
        // Wire shape is id-only: `{ "kind": "deleted", "id": 42 }`.
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            FOLDER_CHANGED_EVENT,
            FolderChange::Deleted { id: 42 },
        );

        let evt = rx.try_recv().expect("folder delete should broadcast");
        let p = &*evt.payload;
        assert_eq!(evt.channel, FOLDER_CHANGED_EVENT);
        assert_eq!(p["kind"], "deleted");
        assert_eq!(p["id"], 42);
        assert!(p["folder"].is_null(), "delete carries no folder detail");
    }

    #[test]
    fn emit_event_broadcasts_folder_group_change_wire_shapes() {
        // The three shapes the sidebar switches on. `layout` in particular must
        // serialize as a bare tagged variant with no body — the client treats it
        // as "re-read both lists", so any payload there would be dead weight the
        // sender is tempted to start trusting.
        use crate::models::FolderGroupDetail;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            FOLDER_GROUP_CHANGED_EVENT,
            FolderGroupChange::Upsert {
                group: FolderGroupDetail {
                    id: 3,
                    name: "Work".to_string(),
                    color: "blue".to_string(),
                    sort_order: 2,
                },
            },
        );
        let evt = rx.try_recv().expect("group upsert should broadcast");
        assert_eq!(evt.channel, FOLDER_GROUP_CHANGED_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["group"]["id"], 3);
        assert_eq!(p["group"]["name"], "Work");
        assert_eq!(p["group"]["color"], "blue");
        assert_eq!(p["group"]["sort_order"], 2);

        emit_event(
            &emitter,
            FOLDER_GROUP_CHANGED_EVENT,
            FolderGroupChange::Deleted { id: 3 },
        );
        let evt = rx.try_recv().expect("group delete should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "deleted");
        assert_eq!(p["id"], 3);

        emit_event(&emitter, FOLDER_GROUP_CHANGED_EVENT, FolderGroupChange::Layout);
        let evt = rx.try_recv().expect("layout nudge should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "layout");
        assert!(p["group"].is_null(), "the layout nudge carries no payload");
        assert!(p["id"].is_null(), "the layout nudge carries no payload");
    }

    #[test]
    fn emit_event_broadcasts_assistant_change_wire_shapes() {
        // The shapes the assistant store switches on: whole rows under
        // `assistant` / `assistants`, and a bare `resync` nudge.
        use crate::models::assistant::selection;
        use crate::models::{AgentType, AssistantAvatar, AssistantInfo, AssistantLabelSnapshot};

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let now = chrono::Utc::now();
        let row = AssistantInfo {
            id: 3,
            uid: "u-3".to_string(),
            name: "Reviewer".to_string(),
            description: String::new(),
            avatar: AssistantAvatar::Monogram {
                color: "teal".to_string(),
            },
            agent_type: AgentType::Codex,
            agent_options: selection(None, &[]),
            label_snapshot: AssistantLabelSnapshot::default(),
            instructions: String::new(),
            enabled: true,
            sort_order: 1,
            revision: 2,
            created_at: now,
            updated_at: now,
            deleted_at: None,
        };

        emit_event(
            &emitter,
            ASSISTANT_CHANGED_EVENT,
            AssistantChange::Upsert {
                assistant: Box::new(row.clone()),
            },
        );
        let evt = rx.try_recv().expect("assistant upsert should broadcast");
        assert_eq!(evt.channel, ASSISTANT_CHANGED_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["assistant"]["id"], 3);
        assert_eq!(p["assistant"]["revision"], 2);
        assert!(p["assistant"].get("deleted_at").is_some_and(|v| v.is_null()));

        emit_event(
            &emitter,
            ASSISTANT_CHANGED_EVENT,
            AssistantChange::Reordered {
                assistants: vec![row],
            },
        );
        let evt = rx.try_recv().expect("assistant reorder should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "reordered");
        assert_eq!(p["assistants"][0]["name"], "Reviewer");

        emit_event(&emitter, ASSISTANT_CHANGED_EVENT, AssistantChange::Resync);
        let evt = rx.try_recv().expect("assistant resync should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "resync");
        assert!(p["assistant"].is_null(), "the resync nudge carries no rows");
    }

    #[test]
    fn emit_event_broadcasts_conversation_tag_change_wire_shapes() {
        // The shapes the tag store switches on. A global tag's scope must reach
        // the client as an explicit `null`, not a missing key: the frontend
        // reads `folder_id === null` as "global".
        use crate::models::ConversationTagDetail;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        emit_event(
            &emitter,
            CONVERSATION_TAG_CHANGED_EVENT,
            ConversationTagChange::Upsert {
                tag: ConversationTagDetail {
                    id: 7,
                    folder_id: None,
                    name: "Bug".to_string(),
                    color: "#d73a4a".to_string(),
                    sort_order: 1,
                },
            },
        );
        let evt = rx.try_recv().expect("tag upsert should broadcast");
        assert_eq!(evt.channel, CONVERSATION_TAG_CHANGED_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["kind"], "upsert");
        assert_eq!(p["tag"]["id"], 7);
        assert!(p["tag"].get("folder_id").is_some_and(|v| v.is_null()));
        assert_eq!(p["tag"]["name"], "Bug");
        assert_eq!(p["tag"]["color"], "#d73a4a");
        assert_eq!(p["tag"]["sort_order"], 1);

        emit_event(
            &emitter,
            CONVERSATION_TAG_CHANGED_EVENT,
            ConversationTagChange::Deleted { id: 7 },
        );
        let evt = rx.try_recv().expect("tag delete should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "deleted");
        assert_eq!(p["id"], 7);

        emit_event(
            &emitter,
            CONVERSATION_TAG_CHANGED_EVENT,
            ConversationTagChange::Reordered,
        );
        let evt = rx.try_recv().expect("reorder nudge should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "reordered");
        assert!(p["tag"].is_null(), "the reorder nudge carries no payload");

        emit_event(
            &emitter,
            CONVERSATION_TAG_CHANGED_EVENT,
            ConversationTagChange::BranchTag {
                setting: crate::models::ConversationBranchTag {
                    enabled: true,
                    color: "#6e7781".to_string(),
                },
            },
        );
        let evt = rx.try_recv().expect("branch tag change should broadcast");
        let p = &*evt.payload;
        assert_eq!(p["kind"], "branch_tag");
        assert_eq!(p["setting"]["enabled"], true);
        assert_eq!(p["setting"]["color"], "#6e7781");
    }
}
