//! Cowork fork: desktop apps lending this server their built-in browser
//! (`docs/remote-browser.md`).
//!
//! An agent on codeg-server has no browser tabs of its own: the tabs a person
//! sees in a remote workspace window are native webviews of the desktop app
//! on their computer. That app is connected to this server over `/ws/events`
//! anyway, so it registers there as a host (`host_register`, once the
//! `server_info` it is answered says [`FEATURE`]); a browser-tool call is
//! sent down the same socket as a `host_call` and the app answers it with a
//! `host_result`, having run it on its own tabs (`host_bridge::dispatch`).
//!
//! The call and outcome are the host bridge's own (`host_bridge::BridgeCall`
//! and the `Browser*Outcome`s), so an agent sees exactly what it sees on the
//! desktop. Every check that protects the person — the per-tab share, the
//! `browser_eval` prompt — runs in the app that executes the call; nothing
//! here can grant or answer one. When no app is registered, or it goes away
//! or does not answer, the tools answer as a runtime without a browser does,
//! with a note telling the agent what the person can do about it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use tokio::sync::{mpsc, oneshot};

use super::ws_attach::ServerMsg;
use crate::acp::browser_tools::{
    BrowserActOutcome, BrowserCaptureOutcome, BrowserConsoleOutcome, BrowserEvalOutcome,
    BrowserSnapshotOutcome, BrowserTabOp, BrowserTabOutcome, BrowserTabsOutcome, BrowserToolAccess,
    ERROR_UNAVAILABLE,
};
use crate::browser::agent::ActionRequest;
use crate::browser::capture::CaptureRequest;
use crate::browser::console::ConsoleQuery;
use crate::browser::eval::EvalRequest;
use crate::host_bridge::{BridgeCall, BrowserCall};

/// The `server_info` feature a desktop app looks for before registering.
pub const FEATURE: &str = "host_bridge_ws";

/// The capability a host names to be lent browser calls.
pub const CAPABILITY_BROWSER: &str = "browser";

/// How long a call may take. `tab_op` waits on a page load.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// `browser_eval` waits on the person: the app's own prompt gives up after
/// 120 s (`browser::confirm`), so this outlasts it and the app's answer —
/// "declined" — is what the agent gets.
const EVAL_TIMEOUT: Duration = Duration::from_secs(150);

/// What an agent is told when no desktop app can take the call.
pub const NO_DESKTOP_NOTE: &str =
    "No dodoer desktop app is lending this session its built-in browser right now. Ask the \
     user to open this workspace in the dodoer desktop app and to share the tab with agents \
     from the browser toolbar, then try again.";

/// Why a call got no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCallError {
    /// No registered host has the capability.
    NoHost,
    /// The host's socket closed before it answered.
    Gone,
    /// The host did not answer in time.
    TimedOut,
}

struct Host {
    id: u64,
    tx: mpsc::Sender<ServerMsg>,
    capabilities: Vec<String>,
    window: Option<String>,
    /// When it registered or last had focus, on the registry's clock: the
    /// host a person used last is the one they are in front of.
    active_at: u64,
}

struct Pending {
    host: u64,
    reply: oneshot::Sender<serde_json::Value>,
}

#[derive(Default)]
struct Inner {
    hosts: Vec<Host>,
    pending: HashMap<u64, Pending>,
    next_host: u64,
    next_call: u64,
    clock: u64,
}

impl Inner {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }
}

/// The desktop apps registered on this server's event sockets.
#[derive(Default)]
pub struct HostRegistry {
    inner: Mutex<Inner>,
}

impl HostRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Register the socket whose outbound queue is `tx`. The host stays
    /// registered until the returned handle is dropped (the socket closes).
    pub fn register(
        self: &Arc<Self>,
        tx: mpsc::Sender<ServerMsg>,
        capabilities: Vec<String>,
        window: Option<String>,
    ) -> HostRegistration {
        let mut inner = self.lock();
        inner.next_host += 1;
        let id = inner.next_host;
        let active_at = inner.tick();
        tracing::info!(
            "[host-registry] host {id} registered ({}; {})",
            capabilities.join(","),
            window.as_deref().unwrap_or("?")
        );
        inner.hosts.push(Host {
            id,
            tx,
            capabilities,
            window,
            active_at,
        });
        HostRegistration {
            registry: Arc::clone(self),
            id,
        }
    }

    /// Whether some registered host has `capability`.
    pub fn has_host(&self, capability: &str) -> bool {
        self.lock()
            .hosts
            .iter()
            .any(|h| h.capabilities.iter().any(|c| c == capability))
    }

    fn update(&self, id: u64, capabilities: Vec<String>, window: Option<String>) {
        let mut inner = self.lock();
        let now = inner.tick();
        if let Some(host) = inner.hosts.iter_mut().find(|h| h.id == id) {
            host.capabilities = capabilities;
            host.window = window;
            host.active_at = now;
        }
    }

    fn focus(&self, id: u64) {
        let mut inner = self.lock();
        let now = inner.tick();
        if let Some(host) = inner.hosts.iter_mut().find(|h| h.id == id) {
            host.active_at = now;
        }
    }

    fn unregister(&self, id: u64) {
        let mut inner = self.lock();
        inner.hosts.retain(|h| h.id != id);
        // Dropping the senders fails the calls still waiting on this host
        // at once, instead of at their timeout.
        inner.pending.retain(|_, p| p.host != id);
        tracing::info!("[host-registry] host {id} gone");
    }

    /// Deliver a host's answer. Only the host a call was sent to can answer
    /// it; anything else (a late answer, another socket) is dropped.
    fn answer(&self, id: u64, call_id: u64, outcome: serde_json::Value) -> bool {
        let mut inner = self.lock();
        match inner.pending.get(&call_id) {
            Some(p) if p.host == id => {}
            _ => return false,
        }
        let Some(pending) = inner.pending.remove(&call_id) else {
            return false;
        };
        pending.reply.send(outcome).is_ok()
    }

    /// Send `call` to the host with `capability` the person used last and
    /// wait for its outcome.
    pub async fn call(
        &self,
        capability: &str,
        call: BridgeCall,
        timeout: Duration,
    ) -> Result<serde_json::Value, HostCallError> {
        let (call_id, tx, rx) = {
            let mut inner = self.lock();
            let Some(host) = inner
                .hosts
                .iter()
                .filter(|h| h.capabilities.iter().any(|c| c == capability))
                .max_by_key(|h| h.active_at)
            else {
                return Err(HostCallError::NoHost);
            };
            let host_id = host.id;
            let tx = host.tx.clone();
            let window = host.window.clone();
            inner.next_call += 1;
            let call_id = inner.next_call;
            tracing::debug!(
                "[host-registry] call {call_id} to host {host_id} ({})",
                window.as_deref().unwrap_or("?")
            );
            let (reply, rx) = oneshot::channel();
            inner.pending.insert(
                call_id,
                Pending {
                    host: host_id,
                    reply,
                },
            );
            (call_id, tx, rx)
        };
        if tx
            .send(ServerMsg::HostCall { call_id, call })
            .await
            .is_err()
        {
            self.lock().pending.remove(&call_id);
            return Err(HostCallError::Gone);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(outcome)) => Ok(outcome),
            Ok(Err(_)) => Err(HostCallError::Gone),
            Err(_) => {
                self.lock().pending.remove(&call_id);
                Err(HostCallError::TimedOut)
            }
        }
    }
}

/// One socket's registration. Dropping it unregisters the host.
pub struct HostRegistration {
    registry: Arc<HostRegistry>,
    id: u64,
}

impl HostRegistration {
    pub fn id(&self) -> u64 {
        self.id
    }

    /// A second `host_register` on the same socket: new capabilities (the
    /// person flipped the app's switch) or window.
    pub fn update(&self, capabilities: Vec<String>, window: Option<String>) {
        self.registry.update(self.id, capabilities, window);
    }

    /// The host's window got focus: it is the one the person is using.
    pub fn focus(&self) {
        self.registry.focus(self.id);
    }

    /// The host's `host_result`. `false` when no call of this host's was
    /// waiting for it.
    pub fn answer(&self, call_id: u64, outcome: serde_json::Value) -> bool {
        self.registry.answer(self.id, call_id, outcome)
    }
}

impl Drop for HostRegistration {
    fn drop(&mut self) {
        self.registry.unregister(self.id);
    }
}

/// The browser tools of a codeg-server with no desktop app of its own: each
/// call goes to the registered desktop app the person used last.
pub struct RemoteHostBrowser {
    hosts: Arc<HostRegistry>,
}

impl RemoteHostBrowser {
    pub fn new(hosts: Arc<HostRegistry>) -> Self {
        Self { hosts }
    }

    /// The host's outcome, or `None` when there is none to give — the
    /// caller answers as a runtime without a browser.
    async fn ask<T: DeserializeOwned>(&self, call: BrowserCall, timeout: Duration) -> Option<T> {
        match self
            .hosts
            .call(CAPABILITY_BROWSER, BridgeCall::Browser(call), timeout)
            .await
        {
            Ok(outcome) => match serde_json::from_value(outcome) {
                Ok(outcome) => Some(outcome),
                Err(e) => {
                    tracing::warn!("[host-registry] a host answered something unreadable: {e}");
                    None
                }
            },
            Err(HostCallError::NoHost) => None,
            Err(e) => {
                tracing::warn!("[host-registry] browser call failed: {e:?}");
                None
            }
        }
    }
}

#[async_trait]
impl BrowserToolAccess for RemoteHostBrowser {
    async fn list_tabs(&self) -> BrowserTabsOutcome {
        self.ask(BrowserCall::ListTabs, CALL_TIMEOUT)
            .await
            .unwrap_or_else(|| BrowserTabsOutcome::unavailable(NO_DESKTOP_NOTE))
    }

    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        let call = BrowserCall::Snapshot {
            tab_id: tab_id.to_string(),
            max_chars,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|| {
            BrowserSnapshotOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
        })
    }

    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome {
        let call = BrowserCall::Act {
            tab_id: tab_id.to_string(),
            request,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|| {
            BrowserActOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
        })
    }

    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome {
        let call = BrowserCall::Console {
            tab_id: tab_id.to_string(),
            query,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|| {
            BrowserConsoleOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
        })
    }

    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome {
        let call = BrowserCall::Capture {
            tab_id: tab_id.to_string(),
            request,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|| {
            BrowserCaptureOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
        })
    }

    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome {
        let call = BrowserCall::Eval {
            tab_id: tab_id.to_string(),
            request,
        };
        self.ask(call, EVAL_TIMEOUT).await.unwrap_or_else(|| {
            BrowserEvalOutcome::refused(tab_id, ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
        })
    }

    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        let named = op.tab_id().map(str::to_string);
        self.ask(BrowserCall::TabOp { op }, CALL_TIMEOUT)
            .await
            .unwrap_or_else(|| {
                BrowserTabOutcome::refused(named.as_deref(), ERROR_UNAVAILABLE, NO_DESKTOP_NOTE)
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::browser_tools::NoBrowserTabs;

    fn browser() -> Vec<String> {
        vec![CAPABILITY_BROWSER.to_string()]
    }

    /// A host that answers every call with `answer(call)`, on its own task.
    fn answering_host(
        registry: &Arc<HostRegistry>,
        answer: impl Fn(&BridgeCall) -> serde_json::Value + Send + 'static,
    ) {
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, browser(), Some("remote-workspace-1".into()));
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let ServerMsg::HostCall { call_id, call } = msg {
                    reg.answer(call_id, answer(&call));
                }
            }
        });
    }

    #[tokio::test]
    async fn with_no_host_the_tools_answer_as_no_browser_and_say_what_to_do() {
        let tools = RemoteHostBrowser::new(Arc::new(HostRegistry::new()));
        let tabs = tools.list_tabs().await;
        assert!(tabs.tabs.is_empty());
        assert_eq!(tabs.note.as_deref(), Some(NO_DESKTOP_NOTE));
        let refused = tools.snapshot("t1", None).await;
        let no_browser = NoBrowserTabs.snapshot("t1", None).await;
        assert_eq!(
            refused.error, no_browser.error,
            "the same slug as no browser"
        );
        assert_eq!(refused.note.as_deref(), Some(NO_DESKTOP_NOTE));
    }

    #[tokio::test]
    async fn a_call_reaches_the_host_and_its_outcome_comes_back() {
        let registry = Arc::new(HostRegistry::new());
        answering_host(&registry, |call| {
            assert_eq!(
                serde_json::to_value(call).unwrap(),
                serde_json::json!({"tool": "browser", "call": {"method": "list_tabs"}})
            );
            serde_json::to_value(BrowserTabsOutcome::unavailable("from the host")).unwrap()
        });
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));
        assert_eq!(
            tools.list_tabs().await.note.as_deref(),
            Some("from the host")
        );
    }

    #[tokio::test]
    async fn the_host_used_last_takes_the_call() {
        let registry = Arc::new(HostRegistry::new());
        let (first_tx, mut first_rx) = mpsc::channel(8);
        let first = registry.register(first_tx, browser(), None);
        let (second_tx, mut second_rx) = mpsc::channel(8);
        let second = registry.register(second_tx, browser(), None);
        // Registered last: the second takes it.
        let r = Arc::clone(&registry);
        let call = tokio::spawn(async move {
            r.call(
                CAPABILITY_BROWSER,
                BridgeCall::Browser(BrowserCall::ListTabs),
                Duration::from_secs(5),
            )
            .await
        });
        let Some(ServerMsg::HostCall { call_id, .. }) = second_rx.recv().await else {
            panic!("the second host is asked");
        };
        assert!(first_rx.try_recv().is_err());
        // The first cannot answer a call sent to the second.
        assert!(!first.answer(call_id, serde_json::json!("forged")));
        assert!(second.answer(call_id, serde_json::json!("ok")));
        assert_eq!(call.await.unwrap(), Ok(serde_json::json!("ok")));

        // Focus moves it back to the first.
        first.focus();
        let r = Arc::clone(&registry);
        tokio::spawn(async move {
            let _ = r
                .call(
                    CAPABILITY_BROWSER,
                    BridgeCall::Browser(BrowserCall::ListTabs),
                    Duration::from_secs(5),
                )
                .await;
        });
        assert!(matches!(
            first_rx.recv().await,
            Some(ServerMsg::HostCall { .. })
        ));
    }

    #[tokio::test]
    async fn a_host_without_the_capability_is_never_asked() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(8);
        let reg = registry.register(tx, Vec::new(), None);
        assert!(!registry.has_host(CAPABILITY_BROWSER));
        let err = registry
            .call(
                CAPABILITY_BROWSER,
                BridgeCall::Browser(BrowserCall::ListTabs),
                Duration::from_secs(5),
            )
            .await;
        assert_eq!(err, Err(HostCallError::NoHost));
        // The app's switch turned on: the same socket says so again.
        reg.update(browser(), None);
        assert!(registry.has_host(CAPABILITY_BROWSER));
    }

    #[tokio::test]
    async fn a_host_that_goes_away_fails_its_calls_at_once() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, browser(), None);
        let r = Arc::clone(&registry);
        let call = tokio::spawn(async move {
            r.call(
                CAPABILITY_BROWSER,
                BridgeCall::Browser(BrowserCall::ListTabs),
                Duration::from_secs(600),
            )
            .await
        });
        assert!(matches!(rx.recv().await, Some(ServerMsg::HostCall { .. })));
        drop(reg);
        assert_eq!(call.await.unwrap(), Err(HostCallError::Gone));
        assert!(!registry.has_host(CAPABILITY_BROWSER));
    }

    #[tokio::test]
    async fn a_host_that_does_not_answer_times_out_and_a_late_answer_is_dropped() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, browser(), None);
        let err = registry
            .call(
                CAPABILITY_BROWSER,
                BridgeCall::Browser(BrowserCall::ListTabs),
                Duration::from_millis(20),
            )
            .await;
        assert_eq!(err, Err(HostCallError::TimedOut));
        let Some(ServerMsg::HostCall { call_id, .. }) = rx.recv().await else {
            panic!("the call was sent");
        };
        assert!(!reg.answer(call_id, serde_json::json!("late")));
    }
}
