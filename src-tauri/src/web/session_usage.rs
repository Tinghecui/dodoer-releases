//! Cowork fork: which conversations are using one of the person's computers
//! right now, for the mark on their sidebar row and tab
//! (`docs/session-usage-badge.md`).
//!
//! Two kinds of use, both seen here because every one of them goes through
//! this process:
//!
//! * **Browser** — a `browser_*` call of the conversation's agent is on its
//!   way to a device (`web::host_browser`), or to the desktop app this
//!   daemon belongs to (`host_bridge`). It still counts for
//!   [`BROWSER_LINGER`] after the last one came back: an agent working a
//!   page step by step leaves a few seconds between calls.
//! * **Shell** — an `ssh <device>` tunnel of the conversation is open
//!   (`web::host_tunnel`). It ends when the tunnel closes.
//!
//! The conversation is found from the agent's connection: the delegation
//! listener runs each browser call under it (`working_device::as_caller`),
//! and `desktop proxy` sends it along with a tunnel (`CODEG_CLI_CALLER`). A
//! use is shown on that conversation and, for a delegated child, on the
//! top-level conversation too.
//!
//! Clients read [`list_session_usage`] once and follow [`EVENT`], one
//! payload per conversation that changed, as `conversation://background`.

use std::collections::{BTreeSet, HashMap};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use async_trait::async_trait;
use axum::Json;
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};
use tokio::time::Instant;

use super::event_bridge::{emit_event, EventEmitter};
use super::host_devices::now_ms;
use crate::acp::manager::ConnectionManager;

/// The side channel: [`UsageEntry`], one per conversation whose uses
/// changed; no uses clears it.
pub const EVENT: &str = "conversation://device-usage";

/// How long a conversation still shows the browser after its last call came
/// back.
pub const BROWSER_LINGER: Duration = Duration::from_secs(30);

/// What is being used.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UseKind {
    Browser,
    Shell,
}

/// One thing a conversation uses now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Use {
    pub kind: UseKind,
    /// The device's name; none for the computer this daemon's app is on, or
    /// an app from before devices.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device: Option<String>,
    /// For the browser: whether its pages are in the person's own Chrome.
    /// None where that is not known here.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chrome: Option<bool>,
    /// Since when, in milliseconds since 1970.
    pub since: i64,
}

/// What [`EVENT`] carries, and [`list_session_usage`] a list of.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub conversation_id: i32,
    pub uses: Vec<Use>,
}

/// A use as it is kept: the conversations it shows on, what and where.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
struct SlotKey {
    conversations: Vec<i32>,
    kind: UseKind,
    device: Option<String>,
}

#[derive(Debug)]
struct Slot {
    chrome: Option<bool>,
    since: i64,
    /// Calls or tunnels open now.
    open: usize,
    /// When the last one ended, while none is open.
    ended_at: Option<Instant>,
}

/// The uses of every conversation, without the clock or the events: what
/// [`SessionUsage`] keeps, and what the tests drive.
#[derive(Debug, Default)]
pub struct UsageBook {
    slots: HashMap<SlotKey, Slot>,
}

/// A use [`UsageBook::begin`] started, for [`UsageBook::end`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ticket(SlotKey);

impl Ticket {
    pub fn kind(&self) -> UseKind {
        self.0.kind
    }
}

impl UsageBook {
    /// One more call or tunnel of `conversations` on `device`: the ticket
    /// to end it with, and the conversations whose uses this changed.
    pub fn begin(
        &mut self,
        conversations: &[i32],
        kind: UseKind,
        device: Option<String>,
        chrome: Option<bool>,
        now_ms: i64,
    ) -> (Ticket, Vec<i32>) {
        let mut conversations = conversations.to_vec();
        conversations.sort_unstable();
        conversations.dedup();
        let key = SlotKey {
            conversations,
            kind,
            device,
        };
        let changed = match self.slots.get_mut(&key) {
            Some(slot) => {
                slot.open += 1;
                slot.ended_at = None;
                let moved = chrome.is_some() && slot.chrome != chrome;
                if chrome.is_some() {
                    slot.chrome = chrome;
                }
                moved
            }
            None => {
                self.slots.insert(
                    key.clone(),
                    Slot {
                        chrome,
                        since: now_ms,
                        open: 1,
                        ended_at: None,
                    },
                );
                true
            }
        };
        let touched = if changed {
            key.conversations.clone()
        } else {
            Vec::new()
        };
        (Ticket(key), touched)
    }

    /// The call or tunnel of `ticket` is over. A shell goes at once; the
    /// browser stays until [`expire`](Self::expire) finds it quiet.
    pub fn end(&mut self, ticket: &Ticket, now: Instant) -> Vec<i32> {
        let Some(slot) = self.slots.get_mut(&ticket.0) else {
            return Vec::new();
        };
        slot.open = slot.open.saturating_sub(1);
        if slot.open > 0 {
            return Vec::new();
        }
        match ticket.0.kind {
            UseKind::Shell => {
                self.slots.remove(&ticket.0);
                ticket.0.conversations.clone()
            }
            UseKind::Browser => {
                slot.ended_at = Some(now);
                Vec::new()
            }
        }
    }

    /// Drop the browser uses quiet for `linger` by `now`: the conversations
    /// that changed.
    pub fn expire(&mut self, now: Instant, linger: Duration) -> Vec<i32> {
        let mut changed = BTreeSet::new();
        self.slots.retain(|key, slot| {
            let quiet = slot.open == 0
                && slot
                    .ended_at
                    .is_some_and(|at| now.saturating_duration_since(at) >= linger);
            if quiet {
                changed.extend(key.conversations.iter().copied());
            }
            !quiet
        });
        changed.into_iter().collect()
    }

    /// What `conversation` uses now: one per kind and device, the browser
    /// first.
    pub fn uses_of(&self, conversation: i32) -> Vec<Use> {
        let mut merged: HashMap<(UseKind, Option<String>), Use> = HashMap::new();
        for (key, slot) in &self.slots {
            if !key.conversations.contains(&conversation) {
                continue;
            }
            merged
                .entry((key.kind, key.device.clone()))
                .and_modify(|have| {
                    have.since = have.since.min(slot.since);
                    // Chrome if any says so; not known only if none knows.
                    have.chrome = have.chrome.max(slot.chrome);
                })
                .or_insert_with(|| Use {
                    kind: key.kind,
                    device: key.device.clone(),
                    chrome: slot.chrome,
                    since: slot.since,
                });
        }
        let mut uses: Vec<Use> = merged.into_values().collect();
        uses.sort_by(|a, b| a.kind.cmp(&b.kind).then_with(|| a.device.cmp(&b.device)));
        uses
    }

    pub fn entry(&self, conversation: i32) -> UsageEntry {
        UsageEntry {
            conversation_id: conversation,
            uses: self.uses_of(conversation),
        }
    }

    /// Every conversation using something now, by id.
    pub fn entries(&self) -> Vec<UsageEntry> {
        let ids: BTreeSet<i32> = self
            .slots
            .keys()
            .flat_map(|key| key.conversations.iter().copied())
            .collect();
        ids.into_iter().map(|id| self.entry(id)).collect()
    }
}

/// The conversations an agent's connection shows its uses on.
#[async_trait]
pub trait CallerConversations: Send + Sync {
    /// The connection's own conversation and, for a delegated child, the
    /// top-level one. Empty for a connection not known (yet).
    async fn of(&self, connection_id: &str) -> Vec<i32>;
}

/// [`CallerConversations`] of the running server.
pub struct LiveCallerConversations {
    pub manager: ConnectionManager,
    pub db: DatabaseConnection,
}

#[async_trait]
impl CallerConversations for LiveCallerConversations {
    async fn of(&self, connection_id: &str) -> Vec<i32> {
        let Some(state) = self.manager.get_state(connection_id).await else {
            return Vec::new();
        };
        let own = state.read().await.conversation_id;
        let Some(own) = own else {
            return Vec::new();
        };
        let root = super::working_device::root_of(&self.db, own).await;
        if root == own {
            vec![own]
        } else {
            vec![own, root]
        }
    }
}

/// The uses of this server's conversations, told to its clients.
pub struct SessionUsage {
    book: Mutex<UsageBook>,
    emitter: EventEmitter,
    conversations: Arc<dyn CallerConversations>,
    linger: Duration,
}

static USAGE: OnceLock<Arc<SessionUsage>> = OnceLock::new();

/// Keep the uses of this process's conversations, once.
pub fn install(usage: Arc<SessionUsage>) {
    if USAGE.set(usage).is_err() {
        tracing::warn!("[session-usage] installed twice");
    }
}

/// The uses kept here, where they are.
pub fn installed() -> Option<Arc<SessionUsage>> {
    USAGE.get().cloned()
}

impl SessionUsage {
    pub fn new(emitter: EventEmitter, conversations: Arc<dyn CallerConversations>) -> Arc<Self> {
        Self::with_linger(emitter, conversations, BROWSER_LINGER)
    }

    pub fn with_linger(
        emitter: EventEmitter,
        conversations: Arc<dyn CallerConversations>,
        linger: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            book: Mutex::new(UsageBook::default()),
            emitter,
            conversations,
            linger,
        })
    }

    fn lock(&self) -> MutexGuard<'_, UsageBook> {
        self.book.lock().unwrap_or_else(|e| e.into_inner())
    }

    pub fn entries(&self) -> Vec<UsageEntry> {
        self.lock().entries()
    }

    /// Tell the clients what `changed` use now.
    fn announce(&self, changed: Vec<i32>) {
        if changed.is_empty() {
            return;
        }
        let entries: Vec<UsageEntry> = {
            let book = self.lock();
            changed.into_iter().map(|id| book.entry(id)).collect()
        };
        for entry in entries {
            emit_event(&self.emitter, EVENT, &entry);
        }
    }

    /// A use of the agent on `connection_id`, for as long as the guard
    /// lives. None for a connection with no conversation.
    pub async fn track(
        self: &Arc<Self>,
        connection_id: &str,
        kind: UseKind,
        device: Option<String>,
        chrome: Option<bool>,
    ) -> Option<UsageGuard> {
        let conversations = self.conversations.of(connection_id).await;
        if conversations.is_empty() {
            return None;
        }
        let (ticket, changed) = self
            .lock()
            .begin(&conversations, kind, device, chrome, now_ms());
        self.announce(changed);
        Some(UsageGuard {
            usage: Arc::clone(self),
            ticket: Some(ticket),
        })
    }

    fn finish(self: &Arc<Self>, ticket: Ticket) {
        let changed = self.lock().end(&ticket, Instant::now());
        self.announce(changed);
        if ticket.kind() == UseKind::Browser {
            let usage = Arc::clone(self);
            let linger = self.linger;
            if let Ok(runtime) = tokio::runtime::Handle::try_current() {
                runtime.spawn(async move {
                    tokio::time::sleep(linger).await;
                    let changed = usage.lock().expire(Instant::now(), linger);
                    usage.announce(changed);
                });
            }
        }
    }
}

/// A use in progress; it ends when this is dropped.
pub struct UsageGuard {
    usage: Arc<SessionUsage>,
    ticket: Option<Ticket>,
}

impl Drop for UsageGuard {
    fn drop(&mut self) {
        if let Some(ticket) = self.ticket.take() {
            self.usage.finish(ticket);
        }
    }
}

/// A browser call of the agent running it now (`working_device::caller`),
/// to `device`: kept as a use while the guard lives. None where nothing is
/// kept, or the call has no caller.
pub async fn track_browser(device: Option<String>, chrome: Option<bool>) -> Option<UsageGuard> {
    let usage = installed()?;
    let caller = super::working_device::caller()?;
    usage.track(&caller, UseKind::Browser, device, chrome).await
}

/// An `ssh` tunnel of the agent on `caller` to `device`.
pub async fn track_shell(caller: Option<&str>, device: Option<String>) -> Option<UsageGuard> {
    let usage = installed()?;
    usage.track(caller?, UseKind::Shell, device, None).await
}

/// `POST /api/list_session_usage` (`cowork::api_routes`): every
/// conversation using one of the person's computers now. Empty where
/// nothing is kept.
pub async fn list_session_usage() -> Json<Vec<UsageEntry>> {
    Json(installed().map(|usage| usage.entries()).unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::web::event_bridge::WebEventBroadcaster;

    fn laptop() -> Option<String> {
        Some("laptop".to_string())
    }

    #[test]
    fn a_browser_call_shows_until_it_has_been_quiet_a_while() {
        let mut book = UsageBook::default();
        let t0 = Instant::now();
        let (ticket, changed) = book.begin(&[7], UseKind::Browser, laptop(), Some(true), 1_000);
        assert_eq!(changed, vec![7]);
        assert_eq!(
            book.uses_of(7),
            vec![Use {
                kind: UseKind::Browser,
                device: laptop(),
                chrome: Some(true),
                since: 1_000,
            }]
        );
        assert!(book.end(&ticket, t0).is_empty(), "still shown right after");
        assert!(book
            .expire(t0 + Duration::from_secs(10), BROWSER_LINGER)
            .is_empty());
        assert_eq!(book.uses_of(7).len(), 1);
        assert_eq!(book.expire(t0 + BROWSER_LINGER, BROWSER_LINGER), vec![7]);
        assert!(book.uses_of(7).is_empty());
        assert!(book.entries().is_empty());
    }

    #[test]
    fn the_next_call_keeps_it_and_changes_nothing() {
        let mut book = UsageBook::default();
        let t0 = Instant::now();
        let (first, _) = book.begin(&[7], UseKind::Browser, laptop(), Some(false), 1_000);
        book.end(&first, t0);
        let (second, changed) = book.begin(&[7], UseKind::Browser, laptop(), Some(false), 9_000);
        assert!(changed.is_empty(), "same use: no event");
        // The first call's quiet period has passed, the second is open.
        assert!(book.expire(t0 + BROWSER_LINGER, BROWSER_LINGER).is_empty());
        assert_eq!(book.uses_of(7)[0].since, 1_000);
        book.end(&second, t0 + BROWSER_LINGER);
        assert_eq!(
            book.expire(t0 + BROWSER_LINGER * 2, BROWSER_LINGER),
            vec![7]
        );
    }

    #[test]
    fn chrome_turned_on_mid_way_is_told() {
        let mut book = UsageBook::default();
        let (_a, _) = book.begin(&[7], UseKind::Browser, laptop(), Some(false), 1_000);
        let (_b, changed) = book.begin(&[7], UseKind::Browser, laptop(), Some(true), 2_000);
        assert_eq!(changed, vec![7]);
        assert_eq!(book.uses_of(7)[0].chrome, Some(true));
    }

    #[test]
    fn a_shell_goes_when_its_last_tunnel_closes() {
        let mut book = UsageBook::default();
        let now = Instant::now();
        let (a, changed) = book.begin(&[3], UseKind::Shell, laptop(), None, 1_000);
        assert_eq!(changed, vec![3]);
        let (b, changed) = book.begin(&[3], UseKind::Shell, laptop(), None, 2_000);
        assert!(changed.is_empty());
        assert!(book.end(&a, now).is_empty(), "one tunnel still open");
        assert_eq!(book.uses_of(3).len(), 1);
        assert_eq!(book.end(&b, now), vec![3]);
        assert!(book.uses_of(3).is_empty());
        // Ending twice is harmless.
        assert!(book.end(&b, now).is_empty());
    }

    #[test]
    fn a_delegated_child_shows_on_itself_and_its_top_level_conversation() {
        let mut book = UsageBook::default();
        let (_t, mut changed) = book.begin(&[12, 4, 12], UseKind::Shell, laptop(), None, 1_000);
        changed.sort_unstable();
        assert_eq!(changed, vec![4, 12]);
        assert_eq!(book.uses_of(4).len(), 1);
        assert_eq!(book.uses_of(12).len(), 1);
        assert_eq!(
            book.entries()
                .iter()
                .map(|e| e.conversation_id)
                .collect::<Vec<_>>(),
            vec![4, 12]
        );
    }

    #[test]
    fn uses_are_one_per_kind_and_device_browser_first() {
        let mut book = UsageBook::default();
        let desktop = Some("desktop".to_string());
        book.begin(&[1], UseKind::Shell, desktop.clone(), None, 5_000);
        book.begin(&[1], UseKind::Browser, laptop(), Some(true), 3_000);
        // The same device from the parent's and a child's call.
        book.begin(&[1, 2], UseKind::Browser, laptop(), None, 1_000);
        let uses = book.uses_of(1);
        assert_eq!(uses.len(), 2);
        assert_eq!(uses[0].kind, UseKind::Browser);
        assert_eq!(uses[0].since, 1_000);
        assert_eq!(uses[0].chrome, Some(true));
        assert_eq!(uses[1].kind, UseKind::Shell);
        assert_eq!(uses[1].device, desktop);
    }

    #[test]
    fn the_wire_shape_is_what_the_client_reads() {
        let entry = UsageEntry {
            conversation_id: 9,
            uses: vec![
                Use {
                    kind: UseKind::Browser,
                    device: laptop(),
                    chrome: Some(true),
                    since: 5,
                },
                Use {
                    kind: UseKind::Shell,
                    device: None,
                    chrome: None,
                    since: 6,
                },
            ],
        };
        assert_eq!(
            serde_json::to_value(&entry).unwrap(),
            serde_json::json!({
                "conversationId": 9,
                "uses": [
                    {"kind": "browser", "device": "laptop", "chrome": true, "since": 5},
                    {"kind": "shell", "since": 6},
                ],
            })
        );
    }

    struct Fixed(Vec<i32>);

    #[async_trait]
    impl CallerConversations for Fixed {
        async fn of(&self, connection_id: &str) -> Vec<i32> {
            if connection_id == "conn-a" {
                self.0.clone()
            } else {
                Vec::new()
            }
        }
    }

    fn usage_with_events(
        linger: Duration,
    ) -> (
        Arc<SessionUsage>,
        tokio::sync::broadcast::Receiver<crate::web::event_bridge::WebEvent>,
    ) {
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let events = broadcaster.subscribe();
        let usage = SessionUsage::with_linger(
            EventEmitter::test_web_only(broadcaster),
            Arc::new(Fixed(vec![5])),
            linger,
        );
        (usage, events)
    }

    fn next_entry(
        events: &mut tokio::sync::broadcast::Receiver<crate::web::event_bridge::WebEvent>,
    ) -> UsageEntry {
        let event = events.try_recv().expect("an event");
        assert_eq!(event.channel, EVENT);
        serde_json::from_value(event.payload.as_ref().clone()).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn a_browser_call_is_announced_and_cleared_after_the_linger() {
        let (usage, mut events) = usage_with_events(Duration::from_secs(30));
        let guard = usage
            .track("conn-a", UseKind::Browser, laptop(), Some(true))
            .await
            .expect("a known connection");
        let shown = next_entry(&mut events);
        assert_eq!(shown.conversation_id, 5);
        assert_eq!(shown.uses.len(), 1);
        assert_eq!(usage.entries().len(), 1);

        drop(guard);
        assert!(
            events.try_recv().is_err(),
            "nothing until it has been quiet"
        );
        tokio::time::sleep(Duration::from_secs(31)).await;
        let cleared = next_entry(&mut events);
        assert_eq!(cleared.conversation_id, 5);
        assert!(cleared.uses.is_empty());
        assert!(usage.entries().is_empty());
    }

    #[tokio::test]
    async fn a_tunnel_is_announced_and_cleared_when_it_closes() {
        let (usage, mut events) = usage_with_events(Duration::from_secs(30));
        let guard = usage
            .track("conn-a", UseKind::Shell, laptop(), None)
            .await
            .expect("a known connection");
        assert_eq!(next_entry(&mut events).uses[0].kind, UseKind::Shell);
        drop(guard);
        assert!(next_entry(&mut events).uses.is_empty());
    }

    #[tokio::test]
    async fn a_connection_without_a_conversation_is_not_kept() {
        let (usage, mut events) = usage_with_events(Duration::from_secs(30));
        assert!(usage
            .track("conn-unknown", UseKind::Shell, laptop(), None)
            .await
            .is_none());
        assert!(events.try_recv().is_err());
        assert!(usage.entries().is_empty());
    }
}
