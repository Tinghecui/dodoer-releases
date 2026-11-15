//! Cowork fork: the device each conversation works on (`docs/devices.md` 6).
//!
//! A conversation's agent operates one of the person's computers at a time,
//! its *working device*, and only ones the person has confirmed for that
//! conversation. The first time it needs one, the person picks it on a card
//! (the `ask_user_question` card); a device confirmed once is switched back
//! to without asking again. Where the person typed their latest message
//! (`X-Codeg-Device` on `/api/acp_prompt`) only ever suggests: that device
//! goes first on the card, and the agent is told which one "my computer" is.
//! Nothing here moves the working device by itself.
//!
//! Kept per top-level conversation (a delegated child works where its parent
//! does) in `app_metadata` (`host_devices.conversations`), for the
//! [`KEEP`] conversations used last.
//!
//! The agent's tools are `list_devices` and `use_device` (codeg-mcp group
//! `devices`, [`COMPANION_FEATURE`]), served by [`DeviceTools`] where this
//! server has no desktop app of its own ([`install`]).

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::http::HeaderMap;
use axum::{Extension, Json};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

use super::host_devices::{now_ms, DeviceView};
use super::host_registry::HostRegistry;
use crate::acp::delegation::transport::DevicesOp;
use crate::acp::manager::ConnectionManager;
use crate::acp::question::{QuestionOption, QuestionSpec, SessionQuestionAccess, MAX_OPTIONS};
use crate::app_state::AppState;
use crate::db::service::app_metadata_service;

/// The header a desktop app's remote window sends a message with: the id of
/// the computer it is on (`host_device`).
pub const HEADER: &str = "x-codeg-device";

/// The codeg-mcp feature token for `list_devices` and `use_device`.
pub const COMPANION_FEATURE: &str = "devices";

/// The `server_info` feature of a server that answers
/// `/api/get_conversation_device`.
pub const FEATURE: &str = "conversation_device";

const KEY: &str = "host_devices.conversations";

/// How many conversations are remembered: the ones used last.
pub const KEEP: usize = 500;

/// Writes wait this long, so that a burst of messages is one write.
const SAVE_DELAY: Duration = Duration::from_secs(2);

/// A delegation chain deeper than this is not walked to its top.
const MAX_DEPTH: usize = 16;

/// The card's short label (at most 12 characters).
const CARD_HEADER: &str = "选设备";

/// What one conversation has to do with the person's devices, by device id.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDevice {
    pub conversation_id: i32,
    /// The device it works on.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working: Option<String>,
    /// The devices the person has chosen for it.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub confirmed: Vec<String>,
    /// The device the person's latest message came from; none for the web
    /// or a phone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_from: Option<String>,
    /// When it last changed, in milliseconds since 1970.
    #[serde(default)]
    pub touched: i64,
}

#[derive(Serialize, Deserialize)]
struct Stored {
    conversations: Vec<ConversationDevice>,
}

/// Every conversation's devices, held by the [`HostRegistry`].
pub struct WorkingDevices {
    inner: Mutex<HashMap<i32, ConversationDevice>>,
    /// Moved on whenever something changes, for [`start`] to write.
    changes: watch::Sender<u64>,
}

impl Default for WorkingDevices {
    fn default() -> Self {
        Self {
            inner: Mutex::default(),
            changes: watch::channel(0).0,
        }
    }
}

impl WorkingDevices {
    fn lock(&self) -> MutexGuard<'_, HashMap<i32, ConversationDevice>> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn get(&self, conversation_id: i32) -> Option<ConversationDevice> {
        self.lock().get(&conversation_id).cloned()
    }

    /// The conversation works on `device` from now on, which the person has
    /// chosen for it.
    pub fn work_on(&self, conversation_id: i32, device: &str) {
        self.change(conversation_id, |c| {
            c.working = Some(device.to_string());
            if !c.confirmed.iter().any(|d| d == device) {
                c.confirmed.push(device.to_string());
            }
        });
    }

    /// The person's latest message to the conversation came from `device`.
    pub fn note_from(&self, conversation_id: i32, device: Option<&str>) {
        self.change(conversation_id, |c| {
            c.last_from = device.map(str::to_string);
        });
    }

    /// A device left the book: no conversation works on it or has it.
    pub fn forget_device(&self, device: &str) {
        let mut inner = self.lock();
        let mut changed = false;
        for c in inner.values_mut() {
            let before = c.clone();
            if c.working.as_deref() == Some(device) {
                c.working = None;
            }
            c.confirmed.retain(|d| d != device);
            if c.last_from.as_deref() == Some(device) {
                c.last_from = None;
            }
            changed |= *c != before;
        }
        drop(inner);
        if changed {
            self.note_change();
        }
    }

    fn change(&self, conversation_id: i32, edit: impl FnOnce(&mut ConversationDevice)) {
        let mut inner = self.lock();
        let entry = inner
            .entry(conversation_id)
            .or_insert_with(|| ConversationDevice {
                conversation_id,
                ..ConversationDevice::default()
            });
        edit(entry);
        entry.touched = now_ms();
        keep_latest(&mut inner);
        drop(inner);
        self.note_change();
    }

    fn note_change(&self) {
        self.changes
            .send_modify(|version| *version = version.wrapping_add(1));
    }

    /// Every conversation, to write.
    pub fn records(&self) -> Vec<ConversationDevice> {
        let mut records: Vec<ConversationDevice> = self.lock().values().cloned().collect();
        records.sort_by_key(|c| c.conversation_id);
        records
    }

    /// What was kept, when the server starts. A conversation that changed
    /// since keeps what it has now.
    pub fn restore(&self, stored: Vec<ConversationDevice>) {
        let mut inner = self.lock();
        for c in stored {
            inner.entry(c.conversation_id).or_insert(c);
        }
        keep_latest(&mut inner);
    }

    pub fn watch(&self) -> watch::Receiver<u64> {
        self.changes.subscribe()
    }
}

/// Drop the conversations used longest ago, down to [`KEEP`].
fn keep_latest(conversations: &mut HashMap<i32, ConversationDevice>) {
    if conversations.len() <= KEEP {
        return;
    }
    let mut by_age: Vec<(i64, i32)> = conversations
        .values()
        .map(|c| (c.touched, c.conversation_id))
        .collect();
    by_age.sort_unstable();
    let extra = conversations.len() - KEEP;
    for (_, id) in by_age.into_iter().take(extra) {
        conversations.remove(&id);
    }
}

/// Read back what was kept and keep it written, for as long as the server
/// runs (`host_devices::start`).
pub async fn start(state: &AppState) {
    let working = state.host_registry.working();
    match app_metadata_service::get_value(&state.db.conn, KEY).await {
        Ok(Some(text)) => match serde_json::from_str::<Stored>(&text) {
            Ok(stored) => working.restore(stored.conversations),
            Err(e) => tracing::warn!("[working-device] what was kept does not read: {e}"),
        },
        Ok(None) => {}
        Err(e) => tracing::warn!("[working-device] reading what was kept: {e}"),
    }
    let registry = Arc::clone(&state.host_registry);
    let conn = state.db.conn.clone();
    let mut changes = registry.working().watch();
    tokio::spawn(async move {
        while changes.changed().await.is_ok() {
            tokio::time::sleep(SAVE_DELAY).await;
            drop(changes.borrow_and_update());
            let text = match serde_json::to_string(&Stored {
                conversations: registry.working().records(),
            }) {
                Ok(text) => text,
                Err(e) => {
                    tracing::warn!("[working-device] does not write: {e}");
                    continue;
                }
            };
            if let Err(e) = app_metadata_service::upsert_value(&conn, KEY, &text).await {
                tracing::warn!("[working-device] keeping it: {e}");
            }
        }
    });
}

/// The conversation at the top of `conversation_id`'s delegation chain.
pub async fn root_of(db: &DatabaseConnection, conversation_id: i32) -> i32 {
    let mut at = conversation_id;
    for _ in 0..MAX_DEPTH {
        match crate::db::entities::conversation::Entity::find_by_id(at)
            .one(db)
            .await
        {
            Ok(Some(row)) => match row.parent_id {
                Some(parent) if parent != at => at = parent,
                _ => return at,
            },
            _ => return at,
        }
    }
    at
}

/// The device `headers` say a message came from: an id, as an app sends it.
pub fn device_in(headers: &HeaderMap) -> Option<&str> {
    headers
        .get(HEADER)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|id| crate::host_device::is_id(id))
}

/// The person sent a message to `conversation_id`, from the device
/// `headers` name or from one that names none. Only where the device tools
/// are served.
pub async fn note_prompt(state: &AppState, headers: &HeaderMap, conversation_id: Option<i32>) {
    let (Some(conversation), Some(_)) = (conversation_id, installed()) else {
        return;
    };
    let device = device_in(headers).filter(|id| state.host_registry.knows_device(id));
    let root = root_of(&state.db.conn, conversation).await;
    state.host_registry.working().note_from(root, device);
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetConversationDeviceParams {
    conversation_id: i32,
}

/// `POST /api/get_conversation_device`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ConversationDeviceAnswer {
    /// The device the conversation works on, as it is now; none until one
    /// is chosen (and always where no device tools are served).
    pub device: Option<DeviceView>,
}

/// `POST /api/get_conversation_device` (`cowork::api_routes`): what the mark
/// beside a conversation's composer shows (`docs/devices.md` 8). A
/// delegated child shows the device of the conversation it was started from.
pub async fn get_conversation_device(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GetConversationDeviceParams>,
) -> Json<ConversationDeviceAnswer> {
    let root = root_of(&state.db.conn, params.conversation_id).await;
    Json(ConversationDeviceAnswer {
        device: working_view(&state.host_registry, root),
    })
}

/// The working device of the top-level `conversation`, as clients are shown
/// it: online or not, and what it lends now.
pub fn working_view(registry: &HostRegistry, conversation: i32) -> Option<DeviceView> {
    let id = registry.working().get(conversation)?.working?;
    registry
        .device_list()
        .devices
        .into_iter()
        .find(|device| device.id == id)
}

tokio::task_local! {
    /// The connection whose agent made the browser call being run
    /// ([`as_caller`]).
    static CALLER: String;
}

/// Run `call`, a browser call of the agent on `connection_id`: what
/// `web::host_browser` checks against that conversation's devices. Set by
/// the delegation listener, around each browser call it serves.
pub async fn as_caller<F: std::future::Future>(connection_id: String, call: F) -> F::Output {
    CALLER.scope(connection_id, call).await
}

/// The connection whose browser call is running, if one is.
pub fn caller() -> Option<String> {
    CALLER.try_with(Clone::clone).ok()
}

/// Which conversation a connection is, and the other way round.
#[async_trait]
pub trait Conversations: Send + Sync {
    /// The top-level conversation the connection is in.
    async fn conversation_of(&self, connection_id: &str) -> Option<i32>;
    /// The connection open on a conversation now.
    async fn connection_of(&self, conversation_id: i32) -> Option<String>;
}

/// [`Conversations`] of the running server.
pub struct LiveConversations {
    pub manager: ConnectionManager,
    pub db: DatabaseConnection,
}

#[async_trait]
impl Conversations for LiveConversations {
    async fn conversation_of(&self, connection_id: &str) -> Option<i32> {
        let state = self.manager.get_state(connection_id).await?;
        let conversation = state.read().await.conversation_id?;
        Some(root_of(&self.db, conversation).await)
    }

    async fn connection_of(&self, conversation_id: i32) -> Option<String> {
        self.manager
            .find_connection_by_conversation_id(conversation_id)
            .await
    }
}

/// What `list_devices` and `use_device` answer: words for the agent, and the
/// same as data.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DevicesAnswer {
    pub text: String,
    /// The conversation's working device, by name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub working: Option<String>,
    pub devices: Vec<DeviceState>,
}

impl DevicesAnswer {
    /// Where nothing serves the device tools.
    pub fn unavailable() -> Self {
        Self {
            text: "The user's devices cannot be reached from here.".to_string(),
            working: None,
            devices: Vec::new(),
        }
    }
}

/// One device, as an agent is told of it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceState {
    #[serde(flatten)]
    pub device: DeviceView,
    /// Chosen for this conversation.
    pub confirmed: bool,
    /// This conversation's working device.
    pub working: bool,
    /// Where the person's latest message came from.
    pub current: bool,
}

/// The agent's device tools, for the conversations of this server.
pub struct DeviceTools {
    hosts: Arc<HostRegistry>,
    conversations: Arc<dyn Conversations>,
    questions: Arc<dyn SessionQuestionAccess>,
}

static TOOLS: OnceLock<Arc<DeviceTools>> = OnceLock::new();

/// Serve the device tools from this process, once.
pub fn install(tools: Arc<DeviceTools>) {
    if TOOLS.set(tools).is_err() {
        tracing::warn!("[working-device] the device tools were installed twice");
    }
}

pub fn installed() -> Option<&'static Arc<DeviceTools>> {
    TOOLS.get()
}

/// `features` (a codeg-mcp `--features` value) with the device tools, where
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

impl DeviceTools {
    pub fn new(
        hosts: Arc<HostRegistry>,
        conversations: Arc<dyn Conversations>,
        questions: Arc<dyn SessionQuestionAccess>,
    ) -> Self {
        Self {
            hosts,
            conversations,
            questions,
        }
    }

    /// The tool `op`, for the conversation on `connection_id`.
    pub async fn answer(&self, connection_id: &str, op: DevicesOp) -> DevicesAnswer {
        match op {
            DevicesOp::List => self.list(connection_id).await,
            DevicesOp::Use { name } => self.use_device(connection_id, name.as_deref()).await,
        }
    }

    /// `list_devices` for the conversation on `connection_id`.
    pub async fn list(&self, connection_id: &str) -> DevicesAnswer {
        let devices = self.hosts.device_list().devices;
        let state = match self.conversations.conversation_of(connection_id).await {
            Some(conversation) => self.hosts.working().get(conversation),
            None => None,
        }
        .unwrap_or_default();
        let mut text = describe_all(&devices, &state);
        if !devices.is_empty() {
            text.push_str(&match working_name(&devices, &state) {
                Some(name) => format!(
                    "\nThis conversation works on `{name}`. Keep to it: a message from another \
                     device does not change it. Switch only when the user says so, with \
                     use_device."
                ),
                None => "\nThis conversation has no working device yet: call use_device before \
                         operating any of these (with the name, when the user said which)."
                    .to_string(),
            });
            text.push('\n');
            text.push_str(&latest_from(&devices, &state));
            text.push_str(
                "\nIf the device you work on cannot be used, tell the user; do not use another \
                 one instead. Ask before deleting, overwriting or changing system settings.",
            );
        }
        answer(text, devices, &state)
    }

    /// `use_device` for the conversation on `connection_id`: `name`, or the
    /// one the person picks.
    pub async fn use_device(&self, connection_id: &str, name: Option<&str>) -> DevicesAnswer {
        let devices = self.hosts.device_list().devices;
        if devices.is_empty() {
            return answer(no_devices(), devices, &ConversationDevice::default());
        }
        let Some(conversation) = self.conversations.conversation_of(connection_id).await else {
            return answer(
                "This conversation is not saved yet, so it cannot have a working device. Try \
                 again after your first reply."
                    .to_string(),
                devices,
                &ConversationDevice::default(),
            );
        };
        let state = self.hosts.working().get(conversation).unwrap_or_default();
        let wanted = name.map(|name| name.trim().to_ascii_lowercase());
        let named = match wanted.as_deref().filter(|name| !name.is_empty()) {
            Some(wanted) => match devices.iter().find(|d| d.name == wanted) {
                Some(device) => Some(device.clone()),
                None => {
                    let text = format!(
                        "There is no device called `{wanted}`. The user's devices: {}. Ask the \
                         user which one they mean.",
                        names(&devices)
                    );
                    return answer(text, devices, &state);
                }
            },
            None => None,
        };
        let chosen = match named {
            Some(device) if devices.len() == 1 || state.confirmed.contains(&device.id) => device,
            None if devices.len() == 1 => devices[0].clone(),
            named => {
                let card = self
                    .ask(connection_id, conversation, &devices, named.as_ref(), &state)
                    .await;
                match card {
                    Ok(device) => device,
                    Err(text) => return answer(text, devices, &state),
                }
            }
        };
        self.hosts.working().work_on(conversation, &chosen.id);
        let state = self.hosts.working().get(conversation).unwrap_or_default();
        let mut text = format!("This conversation now works on `{}`.", chosen.name);
        if let Some(wanted) = wanted.filter(|w| !w.is_empty() && *w != chosen.name) {
            text.push_str(&format!(
                " The user chose it, not `{wanted}`: use `{}`.",
                chosen.name
            ));
        }
        text.push(' ');
        text.push_str(&how_to_use(&chosen));
        answer(text, devices, &state)
    }

    /// Which device a browser call of the conversation on `connection_id`
    /// goes to: `name`, else the working device; one this conversation has
    /// confirmed, asking the person if it has not. `Ok(None)`: nothing to go
    /// by (no conversation, no device), so the call goes as it did before
    /// devices. A name that is none of the devices is handed back as it is,
    /// for the call to say so.
    pub async fn resolve(
        &self,
        connection_id: &str,
        name: Option<&str>,
    ) -> Result<Option<String>, String> {
        let wanted = name
            .map(|name| name.trim().to_ascii_lowercase())
            .filter(|name| !name.is_empty());
        let devices = self.hosts.device_list().devices;
        let Some(conversation) = self.conversations.conversation_of(connection_id).await else {
            return Ok(wanted);
        };
        if devices.len() <= 1 {
            return Ok(wanted.or_else(|| devices.first().map(|d| d.name.clone())));
        }
        let state = self.hosts.working().get(conversation).unwrap_or_default();
        let target = match &wanted {
            Some(wanted) => match devices.iter().find(|d| &d.name == wanted) {
                Some(device) => Some(device.clone()),
                None => return Ok(Some(wanted.clone())),
            },
            None => state
                .working
                .as_deref()
                .and_then(|id| devices.iter().find(|d| d.id == id))
                .cloned(),
        };
        if let Some(device) = &target {
            if state.confirmed.contains(&device.id) {
                return Ok(Some(device.name.clone()));
            }
        }
        let picked = self
            .ask(
                connection_id,
                conversation,
                &devices,
                target.as_ref(),
                &state,
            )
            .await?;
        self.hosts.working().work_on(conversation, &picked.id);
        Ok(Some(picked.name))
    }

    /// The names of the devices the conversation on `connection_id` may
    /// use: the ones it has confirmed, or the only one there is. `None`:
    /// nothing to go by.
    pub async fn confirmed_names(&self, connection_id: &str) -> Option<Vec<String>> {
        let conversation = self.conversations.conversation_of(connection_id).await?;
        let devices = self.hosts.device_list().devices;
        if devices.len() <= 1 {
            return Some(devices.into_iter().map(|d| d.name).collect());
        }
        let state = self.hosts.working().get(conversation).unwrap_or_default();
        Some(
            devices
                .into_iter()
                .filter(|d| state.confirmed.contains(&d.id))
                .map(|d| d.name)
                .collect(),
        )
    }

    /// Whether the conversation on `connection_id` may `ssh` to the device
    /// with this id. Never waits on the person: `ssh` would hang.
    pub async fn check_ssh(&self, connection_id: &str, device_id: &str) -> Result<(), String> {
        let Some(conversation) = self.conversations.conversation_of(connection_id).await else {
            // Not an agent's conversation (a shell the person opened): theirs.
            return Ok(());
        };
        let devices = self.hosts.device_list().devices;
        if devices.len() <= 1 {
            return Ok(());
        }
        let state = self.hosts.working().get(conversation).unwrap_or_default();
        if state.confirmed.iter().any(|d| d == device_id) {
            return Ok(());
        }
        let name = devices
            .iter()
            .find(|d| d.id == device_id)
            .map_or("that device", |d| d.name.as_str());
        Err(format!(
            "This conversation has not been given `{name}` by the user. Call the use_device \
             tool (with the name `{name}` if the user asked for it), then run ssh again."
        ))
    }

    /// The card: which device this conversation is to work on.
    async fn ask(
        &self,
        connection_id: &str,
        conversation: i32,
        devices: &[DeviceView],
        proposed: Option<&DeviceView>,
        state: &ConversationDevice,
    ) -> Result<DeviceView, String> {
        let current = state.last_from.as_deref();
        let order = card_order(devices, proposed.map(|d| d.id.as_str()), current);
        let now = now_ms();
        let options: Vec<QuestionOption> = order
            .iter()
            .take(MAX_OPTIONS)
            .map(|d| card_option(d, current, proposed.map(|d| d.id.as_str()), now))
            .collect();
        let mut question = "这个对话要操作你的电脑，用哪台？".to_string();
        if let Some(proposed) = proposed {
            question.push_str(&format!("智能体想用 {}。", proposed.name));
        }
        question.push_str("选了以后这个对话就在这台上操作，以后再换回这台不再问。");
        let more = order.len() > options.len();
        if more {
            let rest: Vec<&str> = order[options.len()..]
                .iter()
                .map(|d| d.name.as_str())
                .collect();
            question.push_str(&format!("其余的设备：{}，可以直接填名字。", rest.join("、")));
        }
        let spec = QuestionSpec {
            id: format!("device-{}", uuid::Uuid::new_v4()),
            question,
            header: CARD_HEADER.to_string(),
            multi_select: false,
            options,
            is_secret: false,
            allow_other: more,
        };
        // The person watches the conversation they started, not a helper
        // working for it.
        let target = self
            .conversations
            .connection_of(conversation)
            .await
            .unwrap_or_else(|| connection_id.to_string());
        let Some(registered) = self.questions.register_question(&target, vec![spec]).await else {
            return Err("Another question is waiting for the user's answer in this \
                        conversation. Call use_device again once it is answered."
                .to_string());
        };
        let mut withdraw = Withdraw {
            questions: Arc::clone(&self.questions),
            connection: target,
            question: registered.question_id,
            armed: true,
        };
        let outcome = registered.answer_rx.await;
        withdraw.armed = false;
        let Ok(outcome) = outcome else {
            return Err("The question was withdrawn before the user answered. Do not operate \
                        any of the user's computers until they say which one."
                .to_string());
        };
        if outcome.declined {
            return Err("The user did not choose a device. Do not operate any of their \
                        computers until they say which one."
                .to_string());
        }
        let picked = outcome
            .answers
            .first()
            .and_then(|a| a.selected.first())
            .map(|label| label.trim().to_ascii_lowercase())
            .unwrap_or_default();
        devices
            .iter()
            .find(|d| d.name == picked)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "The user answered `{picked}`, which is none of their devices ({}). Ask \
                     them which one they mean.",
                    names(devices)
                )
            })
    }
}

fn answer(text: String, devices: Vec<DeviceView>, state: &ConversationDevice) -> DevicesAnswer {
    let working = working_name(&devices, state);
    let devices = devices
        .into_iter()
        .map(|device| DeviceState {
            confirmed: state.confirmed.contains(&device.id),
            working: state.working.as_deref() == Some(device.id.as_str()),
            current: state.last_from.as_deref() == Some(device.id.as_str()),
            device,
        })
        .collect();
    DevicesAnswer {
        text,
        working,
        devices,
    }
}

fn working_name(devices: &[DeviceView], state: &ConversationDevice) -> Option<String> {
    let id = state.working.as_deref()?;
    devices.iter().find(|d| d.id == id).map(|d| d.name.clone())
}

fn names(devices: &[DeviceView]) -> String {
    devices
        .iter()
        .map(|d| d.name.as_str())
        .collect::<Vec<_>>()
        .join(", ")
}

fn no_devices() -> String {
    "No computer of the user's has connected to this server. They can open this workspace \
     in the dodoer desktop app on their computer."
        .to_string()
}

/// The proposed device first, then the one the person is at, then the rest
/// as the book lists them (online first).
fn card_order<'a>(
    devices: &'a [DeviceView],
    proposed: Option<&str>,
    current: Option<&str>,
) -> Vec<&'a DeviceView> {
    let rank = |d: &&DeviceView| {
        if Some(d.id.as_str()) == proposed {
            0
        } else if Some(d.id.as_str()) == current {
            1
        } else {
            2
        }
    };
    let mut order: Vec<&DeviceView> = devices.iter().collect();
    // Stable: the book's order within each rank.
    order.sort_by_key(rank);
    order
}

fn card_option(
    device: &DeviceView,
    current: Option<&str>,
    proposed: Option<&str>,
    now: i64,
) -> QuestionOption {
    let mut parts: Vec<String> = Vec::new();
    let what = if device.computer_name.is_empty() {
        device.model.clone()
    } else {
        device.computer_name.clone()
    };
    if !what.is_empty() {
        parts.push(what);
    }
    if Some(device.id.as_str()) == current {
        parts.push("你现在用的这台".to_string());
    }
    if Some(device.id.as_str()) == proposed {
        parts.push("智能体想用的".to_string());
    }
    parts.push(if device.online {
        match (device.shell, device.browser) {
            (true, true) => "在线，借出了命令行和浏览器".to_string(),
            (true, false) => "在线，借出了命令行".to_string(),
            (false, true) => "在线，借出了浏览器".to_string(),
            (false, false) => "在线，命令行和浏览器都没借出".to_string(),
        }
    } else {
        format!("离线（上次在线{}）", ago_zh(device.last_seen, now))
    });
    QuestionOption {
        label: device.name.clone(),
        description: parts.join(" · "),
    }
}

/// [`super::host_devices::ago`], for the person.
fn ago_zh(then: i64, now: i64) -> String {
    if then <= 0 {
        return "很久以前".to_string();
    }
    let minutes = (now - then).max(0) / 60_000;
    match minutes {
        0 => "是刚才".to_string(),
        1..=59 => format!("是 {minutes} 分钟前"),
        60..=1439 => format!("是 {} 小时前", minutes / 60),
        _ => format!("是 {} 天前", minutes / 1440),
    }
}

/// Every device in a line each.
fn describe_all(devices: &[DeviceView], state: &ConversationDevice) -> String {
    if devices.is_empty() {
        return no_devices();
    }
    let now = now_ms();
    let mut text = format!("The user's devices ({}):", devices.len());
    for device in devices {
        text.push_str("\n- ");
        text.push_str(&describe(device, now));
        let mut marks = Vec::new();
        if state.working.as_deref() == Some(device.id.as_str()) {
            marks.push("this conversation's working device");
        } else if state.confirmed.contains(&device.id) {
            marks.push("confirmed for this conversation");
        }
        if state.last_from.as_deref() == Some(device.id.as_str()) {
            marks.push("the user's latest message came from it");
        }
        if !marks.is_empty() {
            text.push_str(&format!(" [{}]", marks.join("; ")));
        }
    }
    text
}

/// "`laptop` (MacBook Air, macos): online; shell lent, `ssh laptop`; …"
fn describe(device: &DeviceView, now: i64) -> String {
    let mut about: Vec<&str> = Vec::new();
    for part in [&device.computer_name, &device.model] {
        if !part.is_empty() && !about.contains(&part.as_str()) {
            about.push(part);
        }
    }
    if let Some(platform) = device.platform.as_deref() {
        about.push(platform);
    }
    let mut line = format!("`{}`", device.name);
    if !about.is_empty() {
        line.push_str(&format!(" ({})", about.join(", ")));
    }
    if device.online {
        line.push_str(": online; ");
        line.push_str(&lends(device));
    } else {
        line.push_str(&format!(
            ": offline, last online {}",
            super::host_devices::ago(device.last_seen, now)
        ));
    }
    line
}

fn lends(device: &DeviceView) -> String {
    let shell = if device.shell {
        format!("shell lent, `ssh {}`", device.name)
    } else {
        "shell not lent".to_string()
    };
    let browser = if device.browser {
        format!("browser lent, browser_open_tab with device \"{}\"", device.name)
    } else {
        "browser not lent".to_string()
    };
    format!("{shell}; {browser}")
}

/// What the agent can do on the device it is to work on.
fn how_to_use(device: &DeviceView) -> String {
    if !device.online {
        return format!(
            "It is offline (last online {}): tell the user, and ask them to open this workspace \
             in the dodoer desktop app on it. Do not use another device instead.",
            super::host_devices::ago(device.last_seen, now_ms())
        );
    }
    let mut text = format!("It is online; {}.", lends(device));
    if !device.shell || !device.browser {
        text.push_str(
            " What it does not lend, the user can lend from the dodoer desktop app on it.",
        );
    }
    text
}

/// Where the person's latest message came from, for the agent.
fn latest_from(devices: &[DeviceView], state: &ConversationDevice) -> String {
    match state
        .last_from
        .as_deref()
        .and_then(|id| devices.iter().find(|d| d.id == id))
    {
        Some(device) => format!(
            "The user's latest message came from `{}`: that is the computer they mean by \"this \
             computer\" or \"my computer\".",
            device.name
        ),
        None => "The user's latest message did not come from one of these devices (the web, a \
                 phone, or an older app)."
            .to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::question::{QuestionAnsweredItem, QuestionOutcome, RegisteredQuestion};
    use crate::host_device::HostDevice;
    use crate::web::host_registry::{HostRegistration, CAPABILITY_BROWSER};
    use tokio::sync::{mpsc, oneshot};

    fn device(id: &str, name: &str) -> HostDevice {
        HostDevice {
            id: format!("{id}-0123456789"),
            name: name.to_string(),
            model: String::new(),
            kind: None,
        }
    }

    fn connect(registry: &Arc<HostRegistry>, id: &str, name: &str) -> HostRegistration {
        let (tx, rx) = mpsc::channel(8);
        std::mem::forget(rx);
        registry.register_on(
            tx,
            vec![CAPABILITY_BROWSER.to_string()],
            None,
            None,
            Some(device(id, name)),
            None,
        )
    }

    /// Conversation 7 on connection `conn-7`, open.
    struct OneConversation;

    #[async_trait]
    impl Conversations for OneConversation {
        async fn conversation_of(&self, connection_id: &str) -> Option<i32> {
            (connection_id == "conn-7").then_some(7)
        }
        async fn connection_of(&self, conversation_id: i32) -> Option<String> {
            (conversation_id == 7).then(|| "conn-7".to_string())
        }
    }

    /// A person who answers every card at once: with `pick`, or not at all.
    struct Person {
        pick: Option<&'static str>,
        asked: Mutex<Vec<(String, QuestionSpec)>>,
    }

    impl Person {
        fn picking(pick: Option<&'static str>) -> Arc<Self> {
            Arc::new(Self {
                pick,
                asked: Mutex::new(Vec::new()),
            })
        }

        fn asked(&self) -> Vec<(String, QuestionSpec)> {
            self.asked.lock().unwrap().clone()
        }
    }

    #[async_trait]
    impl SessionQuestionAccess for Person {
        async fn register_question(
            &self,
            parent_connection_id: &str,
            mut questions: Vec<QuestionSpec>,
        ) -> Option<RegisteredQuestion> {
            let spec = questions.remove(0);
            let (tx, rx) = oneshot::channel();
            let _ = tx.send(QuestionOutcome {
                answers: vec![QuestionAnsweredItem {
                    question: spec.question.clone(),
                    header: spec.header.clone(),
                    multi_select: false,
                    selected: self.pick.iter().map(|p| p.to_string()).collect(),
                }],
                declined: self.pick.is_none(),
            });
            self.asked
                .lock()
                .unwrap()
                .push((parent_connection_id.to_string(), spec));
            Some(RegisteredQuestion {
                question_id: "q-1".into(),
                answer_rx: rx,
            })
        }

        async fn cancel_question(&self, _parent_connection_id: &str, _question_id: &str) {}

        async fn cancel_questions_by_parent(&self, _parent_connection_id: &str) {}
    }

    fn tools(registry: &Arc<HostRegistry>, person: &Arc<Person>) -> DeviceTools {
        DeviceTools::new(
            Arc::clone(registry),
            Arc::new(OneConversation),
            Arc::clone(person) as Arc<dyn SessionQuestionAccess>,
        )
    }

    /// With one device, nobody is asked: it is the working device.
    #[tokio::test]
    async fn the_only_device_is_used_without_a_card() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let person = Person::picking(None);
        let tools = tools(&registry, &person);
        let used = tools.use_device("conn-7", None).await;
        assert_eq!(used.working.as_deref(), Some("study-imac"));
        assert!(person.asked().is_empty());
        assert!(used.text.contains("now works on `study-imac`"), "{}", used.text);
    }

    /// Two devices: the first use of each asks once, the device the person
    /// is at first; switching back to one chosen before does not ask.
    #[tokio::test]
    async fn each_device_is_confirmed_once_per_conversation() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let _book = connect(&registry, "book", "MacBook");
        registry
            .working()
            .note_from(7, Some("book-0123456789"));
        let person = Person::picking(Some("study-imac"));
        let tools = tools(&registry, &person);

        let used = tools.use_device("conn-7", None).await;
        assert_eq!(used.working.as_deref(), Some("study-imac"));
        let asked = person.asked();
        assert_eq!(asked.len(), 1);
        let (on, card) = &asked[0];
        assert_eq!(on, "conn-7");
        assert_eq!(card.header, CARD_HEADER);
        assert_eq!(card.options[0].label, "macbook", "where the person is, first");
        assert!(card.options[0].description.contains("你现在用的这台"));
        assert!(!card.allow_other);

        // Chosen before: no card.
        let again = tools.use_device("conn-7", Some("Study-iMac")).await;
        assert_eq!(again.working.as_deref(), Some("study-imac"));
        assert_eq!(person.asked().len(), 1);

        // The other device, named: asked once, it first.
        let other = Person::picking(Some("macbook"));
        let tools = DeviceTools::new(
            Arc::clone(&registry),
            Arc::new(OneConversation),
            Arc::clone(&other) as Arc<dyn SessionQuestionAccess>,
        );
        let switched = tools.use_device("conn-7", Some("macbook")).await;
        assert_eq!(switched.working.as_deref(), Some("macbook"));
        assert_eq!(other.asked()[0].1.options[0].label, "macbook");
        // And back, without asking.
        let back = tools.use_device("conn-7", Some("study-imac")).await;
        assert_eq!(back.working.as_deref(), Some("study-imac"));
        assert_eq!(other.asked().len(), 1);
        let kept = registry.working().get(7).unwrap();
        assert_eq!(
            kept.confirmed,
            ["imac-0123456789", "book-0123456789"],
            "both, in the order chosen"
        );
    }

    /// The person picks another device than the agent named: the agent is
    /// told which.
    #[tokio::test]
    async fn the_person_has_the_last_word() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let _book = connect(&registry, "book", "MacBook");
        let person = Person::picking(Some("macbook"));
        let used = tools(&registry, &person)
            .use_device("conn-7", Some("study-imac"))
            .await;
        assert_eq!(used.working.as_deref(), Some("macbook"));
        assert!(
            used.text.contains("not `study-imac`: use `macbook`"),
            "{}",
            used.text
        );
        assert_eq!(person.asked()[0].1.options[0].label, "study-imac", "proposed first");
    }

    /// No answer, or a name that is none of them: nothing is chosen.
    #[tokio::test]
    async fn without_a_choice_nothing_is_used() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let _book = connect(&registry, "book", "MacBook");
        let declined = tools(&registry, &Person::picking(None))
            .use_device("conn-7", None)
            .await;
        assert_eq!(declined.working, None);
        assert!(declined.text.contains("did not choose"), "{}", declined.text);

        let unknown = tools(&registry, &Person::picking(None))
            .use_device("conn-7", Some("laptop"))
            .await;
        assert!(unknown.text.contains("no device called `laptop`"), "{}", unknown.text);
        assert_eq!(registry.working().get(7).and_then(|c| c.working), None);

        let elsewhere = tools(&registry, &Person::picking(Some("study-imac")))
            .use_device("conn-unknown", None)
            .await;
        assert!(elsewhere.text.contains("not saved yet"), "{}", elsewhere.text);
    }

    #[tokio::test]
    async fn the_list_says_what_this_conversation_works_on() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let book = connect(&registry, "book", "MacBook");
        drop(book);
        let person = Person::picking(None);
        let tools = tools(&registry, &person);

        let before = tools.list("conn-7").await;
        assert!(before.text.contains("no working device yet"), "{}", before.text);
        assert!(before.text.contains("`macbook` (MacBook): offline, last online just now"));
        assert!(before.text.contains("did not come from one of these"));

        registry.working().work_on(7, "imac-0123456789");
        registry.working().note_from(7, Some("book-0123456789"));
        let after = tools.list("conn-7").await;
        assert_eq!(after.working.as_deref(), Some("study-imac"));
        assert!(after.text.contains("works on `study-imac`"), "{}", after.text);
        assert!(after.text.contains("came from `macbook`"), "{}", after.text);
        let imac = after.devices.iter().find(|d| d.device.name == "study-imac").unwrap();
        assert!(imac.working && imac.confirmed && !imac.current);
        assert!(imac.device.online && imac.device.browser && !imac.device.shell);
    }

    /// A browser call goes to a device the conversation has been given:
    /// the one named, or its working device; one it has not been given is
    /// asked for. `ssh` is refused rather than asked.
    #[tokio::test]
    async fn calls_go_only_to_devices_the_conversation_has() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let _book = connect(&registry, "book", "MacBook");
        let person = Person::picking(Some("macbook"));
        let tools = tools(&registry, &person);

        // No working device and none named: the person picks.
        assert_eq!(
            tools.resolve("conn-7", None).await,
            Ok(Some("macbook".into()))
        );
        assert_eq!(person.asked().len(), 1);
        // Their pick is the working device now, and given.
        assert_eq!(
            tools.resolve("conn-7", None).await,
            Ok(Some("macbook".into()))
        );
        assert_eq!(
            tools.resolve("conn-7", Some(" MacBook ")).await,
            Ok(Some("macbook".into()))
        );
        assert_eq!(person.asked().len(), 1);
        // A name that is none of them goes on, for the call to say so.
        assert_eq!(
            tools.resolve("conn-7", Some("laptop")).await,
            Ok(Some("laptop".into()))
        );
        assert_eq!(
            tools.confirmed_names("conn-7").await,
            Some(vec!["macbook".to_string()])
        );

        assert_eq!(tools.check_ssh("conn-7", "book-0123456789").await, Ok(()));
        let refused = tools
            .check_ssh("conn-7", "imac-0123456789")
            .await
            .unwrap_err();
        assert!(refused.contains("not been given `study-imac`"), "{refused}");
        assert_eq!(person.asked().len(), 1, "ssh never waits on a card");

        // Not an agent's conversation: as before devices.
        assert_eq!(
            tools.resolve("conn-9", Some("study-imac")).await,
            Ok(Some("study-imac".into()))
        );
        assert_eq!(tools.confirmed_names("conn-9").await, None);
        assert_eq!(tools.check_ssh("conn-9", "imac-0123456789").await, Ok(()));
    }

    #[tokio::test]
    async fn a_closed_card_gives_no_device() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let _book = connect(&registry, "book", "MacBook");
        let declined = tools(&registry, &Person::picking(None))
            .resolve("conn-7", None)
            .await;
        assert!(declined.unwrap_err().contains("did not choose"));
    }

    #[tokio::test]
    async fn with_one_device_nothing_is_asked_or_refused() {
        let registry = Arc::new(HostRegistry::new());
        let _imac = connect(&registry, "imac", "Study iMac");
        let person = Person::picking(None);
        let tools = tools(&registry, &person);
        assert_eq!(
            tools.resolve("conn-7", None).await,
            Ok(Some("study-imac".into()))
        );
        assert_eq!(tools.check_ssh("conn-7", "imac-0123456789").await, Ok(()));
        assert_eq!(
            tools.confirmed_names("conn-7").await,
            Some(vec!["study-imac".to_string()])
        );
        assert!(person.asked().is_empty());
    }

    /// The mark shows the working device as it is now; nothing before one
    /// is chosen, or once it has left the book.
    #[tokio::test]
    async fn the_mark_shows_the_working_device_as_it_is() {
        let registry = Arc::new(HostRegistry::new());
        let imac = connect(&registry, "imac", "Study iMac");
        let _book = connect(&registry, "book", "MacBook");
        assert_eq!(working_view(&registry, 7), None);

        registry.working().work_on(7, "imac-0123456789");
        let shown = working_view(&registry, 7).unwrap();
        assert_eq!(shown.name, "study-imac");
        assert!(shown.online && shown.browser && !shown.shell);
        assert_eq!(working_view(&registry, 8), None);

        drop(imac);
        let shown = working_view(&registry, 7).unwrap();
        assert!(!shown.online && !shown.browser);

        registry.forget_device("imac-0123456789").unwrap();
        assert_eq!(working_view(&registry, 7), None);
    }

    #[tokio::test]
    async fn the_caller_is_known_inside_its_call_only() {
        assert_eq!(caller(), None);
        let inside = as_caller("conn-7".to_string(), async { caller() }).await;
        assert_eq!(inside.as_deref(), Some("conn-7"));
    }

    #[test]
    fn the_conversations_used_longest_ago_are_let_go() {
        let working = WorkingDevices::default();
        working.restore(
            (0..KEEP as i32 + 3)
                .map(|id| ConversationDevice {
                    conversation_id: id,
                    working: Some("imac-0123456789".into()),
                    touched: i64::from(id),
                    ..ConversationDevice::default()
                })
                .collect(),
        );
        let kept = working.records();
        assert_eq!(kept.len(), KEEP);
        assert_eq!(kept[0].conversation_id, 3, "the three oldest went");

        working.forget_device("imac-0123456789");
        assert!(working.records().iter().all(|c| c.working.is_none()));
    }

    #[test]
    fn a_message_names_its_device_by_id() {
        let mut headers = HeaderMap::new();
        assert_eq!(device_in(&headers), None);
        headers.insert(HEADER, " imac-0123456789 ".parse().unwrap());
        assert_eq!(device_in(&headers), Some("imac-0123456789"));
        headers.insert(HEADER, "not one!".parse().unwrap());
        assert_eq!(device_in(&headers), None);
    }
}
