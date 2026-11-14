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

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::ws::WebSocket;
use serde::de::DeserializeOwned;
use tokio::sync::{mpsc, oneshot, watch};

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
use crate::host_ssh::tunnel::{ShellHost, CAPABILITY as CAPABILITY_SHELL, TUNNELS_PER_MINUTE};

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

/// What an agent is told when no desktop app can take the call. No product
/// name: the server runs under either brand (dodoer, or Cowork's overlay, which
/// only rewrites the web UI's messages).
pub const NO_DESKTOP_NOTE: &str =
    "No desktop app is lending this session its built-in browser right now. Ask the user to \
     open this workspace in the desktop app and to share the tab with agents from the \
     browser toolbar, then try again.";

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

/// Why a tunnel to a lent shell did not open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// No registered host lends its shell.
    NoHost,
    /// [`TUNNELS_PER_MINUTE`] opened in the last minute already.
    Busy,
    /// The host answered that it cannot, and why.
    Refused(String),
    /// The host's socket closed, or its dial did not upgrade.
    Gone,
    /// The host did not dial back in time.
    TimedOut,
}

/// What a tunnel's waiting end gets: the socket the host dialed, or the
/// host's reason for not dialing.
pub type TunnelReply = oneshot::Sender<Result<WebSocket, String>>;

struct Host {
    id: u64,
    tx: mpsc::Sender<ServerMsg>,
    capabilities: Vec<String>,
    window: Option<String>,
    /// The shell it lends, with the `shell` capability.
    shell: Option<ShellHost>,
    /// When it registered or last had focus, on the registry's clock: the
    /// host a person used last is the one they are in front of.
    active_at: u64,
}

impl Host {
    /// A `shell` capability counts only with the shell it is for.
    fn lends(&self, capability: &str) -> bool {
        self.capabilities.iter().any(|c| c == capability)
            && (capability != CAPABILITY_SHELL || self.shell.is_some())
    }
}

struct Pending {
    host: u64,
    reply: oneshot::Sender<serde_json::Value>,
}

struct PendingTunnel {
    host: u64,
    reply: TunnelReply,
}

#[derive(Default)]
struct Inner {
    hosts: Vec<Host>,
    pending: HashMap<u64, Pending>,
    /// Tunnels asked for and not dialed yet, by their random id.
    tunnels: HashMap<String, PendingTunnel>,
    /// When the tunnels of the last minute were asked for.
    tunnel_starts: VecDeque<Instant>,
    next_host: u64,
    next_call: u64,
    clock: u64,
}

impl Inner {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The host with `capability` the person used last.
    fn pick(&self, capability: &str) -> Option<&Host> {
        self.hosts
            .iter()
            .filter(|h| h.lends(capability))
            .max_by_key(|h| h.active_at)
    }

    /// The shells lent now, the one used last first.
    fn shells(&self) -> Vec<ShellHost> {
        let mut hosts: Vec<&Host> = self
            .hosts
            .iter()
            .filter(|h| h.lends(CAPABILITY_SHELL))
            .collect();
        hosts.sort_by_key(|h| std::cmp::Reverse(h.active_at));
        hosts.into_iter().filter_map(|h| h.shell.clone()).collect()
    }
}

/// The desktop apps registered on this server's event sockets.
pub struct HostRegistry {
    inner: Mutex<Inner>,
    /// The shells lent, as [`Inner::shells`] gives them; for the server's
    /// `ssh` files (`web::host_tunnel`).
    shells: watch::Sender<Vec<ShellHost>>,
}

impl Default for HostRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            shells: watch::channel(Vec::new()).0,
        }
    }
}

/// A shell as a desktop sent it, if it can be used as it is.
fn sound(shell: Option<ShellHost>) -> Option<ShellHost> {
    match shell {
        Some(shell) if shell.is_sound() => Some(shell),
        Some(_) => {
            tracing::warn!("[host-registry] a host lends a shell it describes oddly; ignored");
            None
        }
        None => None,
    }
}

impl HostRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> MutexGuard<'_, Inner> {
        self.inner.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// Tell whoever watches the shells, when they read differently.
    fn publish_shells(&self, inner: &Inner) {
        let now = inner.shells();
        self.shells.send_if_modified(|shells| {
            if *shells == now {
                false
            } else {
                *shells = now;
                true
            }
        });
    }

    /// Register the socket whose outbound queue is `tx`. The host stays
    /// registered until the returned handle is dropped (the socket closes).
    pub fn register(
        self: &Arc<Self>,
        tx: mpsc::Sender<ServerMsg>,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
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
            shell: sound(shell),
            active_at,
        });
        self.publish_shells(&inner);
        HostRegistration {
            registry: Arc::clone(self),
            id,
        }
    }

    /// Whether some registered host has `capability`.
    pub fn has_host(&self, capability: &str) -> bool {
        self.lock().hosts.iter().any(|h| h.lends(capability))
    }

    /// The shells lent now, the one used last first.
    pub fn shells(&self) -> Vec<ShellHost> {
        self.lock().shells()
    }

    /// Told whenever the shells lent change.
    pub fn watch_shells(&self) -> watch::Receiver<Vec<ShellHost>> {
        self.shells.subscribe()
    }

    fn update(
        &self,
        id: u64,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
    ) {
        let mut inner = self.lock();
        let now = inner.tick();
        if let Some(host) = inner.hosts.iter_mut().find(|h| h.id == id) {
            host.capabilities = capabilities;
            host.window = window;
            host.shell = sound(shell);
            host.active_at = now;
        }
        self.publish_shells(&inner);
    }

    fn focus(&self, id: u64) {
        let mut inner = self.lock();
        let now = inner.tick();
        if let Some(host) = inner.hosts.iter_mut().find(|h| h.id == id) {
            host.active_at = now;
        }
        self.publish_shells(&inner);
    }

    fn unregister(&self, id: u64) {
        let mut inner = self.lock();
        inner.hosts.retain(|h| h.id != id);
        // Dropping the senders fails the calls still waiting on this host
        // at once, instead of at their timeout.
        inner.pending.retain(|_, p| p.host != id);
        inner.tunnels.retain(|_, t| t.host != id);
        self.publish_shells(&inner);
        tracing::info!("[host-registry] host {id} gone");
    }

    /// Ask the host lending its shell that the person used last for a
    /// tunnel that lets `client_key` in, and wait up to `timeout` for it to
    /// dial back ([`claim_tunnel`](Self::claim_tunnel)).
    pub async fn open_tunnel(
        &self,
        client_key: &str,
        timeout: Duration,
    ) -> Result<WebSocket, TunnelError> {
        let (tunnel_id, tx, rx) = {
            let mut inner = self.lock();
            let Some(host) = inner.pick(CAPABILITY_SHELL) else {
                return Err(TunnelError::NoHost);
            };
            let host_id = host.id;
            let tx = host.tx.clone();
            let now = Instant::now();
            while inner
                .tunnel_starts
                .front()
                .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60))
            {
                inner.tunnel_starts.pop_front();
            }
            if inner.tunnel_starts.len() >= TUNNELS_PER_MINUTE {
                return Err(TunnelError::Busy);
            }
            inner.tunnel_starts.push_back(now);
            let tunnel_id = crate::cli_run::hello::random_hex(16);
            let (reply, rx) = oneshot::channel();
            inner.tunnels.insert(
                tunnel_id.clone(),
                PendingTunnel {
                    host: host_id,
                    reply,
                },
            );
            tracing::info!("[host-registry] tunnel asked of host {host_id}");
            (tunnel_id, tx, rx)
        };
        let order = ServerMsg::HostTunnel {
            tunnel_id: tunnel_id.clone(),
            client_key: client_key.to_string(),
        };
        if tx.send(order).await.is_err() {
            self.lock().tunnels.remove(&tunnel_id);
            return Err(TunnelError::Gone);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(Ok(socket))) => Ok(socket),
            Ok(Ok(Err(why))) => Err(TunnelError::Refused(why)),
            Ok(Err(_)) => Err(TunnelError::Gone),
            Err(_) => {
                self.lock().tunnels.remove(&tunnel_id);
                Err(TunnelError::TimedOut)
            }
        }
    }

    /// A host dialed tunnel `tunnel_id`: where its socket goes. Once; `None`
    /// for an id nobody waits on (made up, used, or given up on).
    pub fn claim_tunnel(&self, tunnel_id: &str) -> Option<TunnelReply> {
        self.lock()
            .tunnels
            .remove(tunnel_id)
            .map(|pending| pending.reply)
    }

    /// Host `id` will not dial `tunnel_id`. Only the host asked can say so.
    fn refuse_tunnel(&self, id: u64, tunnel_id: &str, why: String) -> bool {
        let mut inner = self.lock();
        if !inner.tunnels.get(tunnel_id).is_some_and(|t| t.host == id) {
            return false;
        }
        match inner.tunnels.remove(tunnel_id) {
            Some(pending) => pending.reply.send(Err(why)).is_ok(),
            None => false,
        }
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
            let Some(host) = inner.pick(capability) else {
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
    /// person flipped the app's switch), window or shell.
    pub fn update(
        &self,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
    ) {
        self.registry.update(self.id, capabilities, window, shell);
    }

    /// The host's `host_tunnel_result`: it will not dial `tunnel_id`.
    pub fn refuse_tunnel(&self, tunnel_id: &str, why: String) -> bool {
        self.registry.refuse_tunnel(self.id, tunnel_id, why)
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
        let reg = registry.register(tx, browser(), Some("remote-workspace-1".into()), None);
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
        let first = registry.register(first_tx, browser(), None, None);
        let (second_tx, mut second_rx) = mpsc::channel(8);
        let second = registry.register(second_tx, browser(), None, None);
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
        let reg = registry.register(tx, Vec::new(), None, None);
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
        reg.update(browser(), None, None);
        assert!(registry.has_host(CAPABILITY_BROWSER));
    }

    #[tokio::test]
    async fn a_host_that_goes_away_fails_its_calls_at_once() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, browser(), None, None);
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
        let reg = registry.register(tx, browser(), None, None);
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

    fn shell_host(user: &str) -> ShellHost {
        ShellHost {
            host_key: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA".to_string(),
            user: user.to_string(),
            platform: Some("macos".into()),
        }
    }

    fn lends_shell() -> Vec<String> {
        vec![CAPABILITY_SHELL.to_string()]
    }

    /// The `host_tunnel` a host got, with its id.
    async fn tunnel_order(rx: &mut mpsc::Receiver<ServerMsg>) -> (String, String) {
        match rx.recv().await {
            Some(ServerMsg::HostTunnel {
                tunnel_id,
                client_key,
            }) => (tunnel_id, client_key),
            other => panic!("a host_tunnel, not {other:?}"),
        }
    }

    /// A `shell` capability without the shell it is for, or with one that
    /// cannot go into an ssh configuration, lends nothing.
    #[tokio::test]
    async fn a_shell_counts_only_with_a_sound_description() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(8);
        let reg = registry.register(tx, lends_shell(), None, None);
        assert!(!registry.has_host(CAPABILITY_SHELL));
        reg.update(lends_shell(), None, Some(shell_host("two words")));
        assert!(!registry.has_host(CAPABILITY_SHELL));
        assert!(registry.shells().is_empty());
        reg.update(lends_shell(), None, Some(shell_host("me")));
        assert!(registry.has_host(CAPABILITY_SHELL));
        assert_eq!(registry.shells(), vec![shell_host("me")]);
        assert_eq!(
            registry
                .open_tunnel("ssh-ed25519 KEY", Duration::from_millis(1))
                .await
                .err(),
            Some(TunnelError::TimedOut),
            "asked, not answered"
        );
    }

    #[tokio::test]
    async fn with_no_shell_lent_a_tunnel_is_refused_at_once() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let _browser_only = registry.register(tx, browser(), None, None);
        assert_eq!(
            registry
                .open_tunnel("ssh-ed25519 KEY", Duration::from_secs(5))
                .await
                .err(),
            Some(TunnelError::NoHost)
        );
        assert!(rx.try_recv().is_err(), "nothing asked of a browser host");
    }

    /// The order carries the key; the host's refusal comes back as such;
    /// only the host asked can refuse, and an id is claimed once.
    #[tokio::test]
    async fn a_tunnel_order_reaches_the_host_and_its_refusal_comes_back() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, lends_shell(), None, Some(shell_host("me")));
        let (other_tx, _other_rx) = mpsc::channel(8);
        let other = registry.register(other_tx, browser(), None, None);
        let r = Arc::clone(&registry);
        let opening = tokio::spawn(async move {
            r.open_tunnel("ssh-ed25519 KEY", Duration::from_secs(5))
                .await
                .err()
        });
        let (tunnel_id, client_key) = tunnel_order(&mut rx).await;
        assert_eq!(client_key, "ssh-ed25519 KEY");
        assert_eq!(tunnel_id.len(), 32);
        assert!(!other.refuse_tunnel(&tunnel_id, "forged".into()));
        assert!(reg.refuse_tunnel(&tunnel_id, "not lent any more".into()));
        assert_eq!(
            opening.await.unwrap(),
            Some(TunnelError::Refused("not lent any more".into()))
        );
        assert!(registry.claim_tunnel(&tunnel_id).is_none(), "settled");

        // A dial in time is claimed once.
        let r = Arc::clone(&registry);
        let waiting = tokio::spawn(async move {
            r.open_tunnel("ssh-ed25519 KEY", Duration::from_secs(5))
                .await
                .err()
        });
        let (tunnel_id, _) = tunnel_order(&mut rx).await;
        let reply = registry.claim_tunnel(&tunnel_id).expect("waited on");
        assert!(registry.claim_tunnel(&tunnel_id).is_none(), "once");
        drop(reply);
        assert_eq!(waiting.await.unwrap(), Some(TunnelError::Gone));
    }

    #[tokio::test]
    async fn a_host_that_goes_away_fails_its_tunnels_and_takes_its_shell() {
        let registry = Arc::new(HostRegistry::new());
        let mut shells = registry.watch_shells();
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, lends_shell(), None, Some(shell_host("me")));
        assert!(shells.has_changed().unwrap());
        assert_eq!(*shells.borrow_and_update(), vec![shell_host("me")]);
        let r = Arc::clone(&registry);
        let opening = tokio::spawn(async move {
            r.open_tunnel("ssh-ed25519 KEY", Duration::from_secs(600))
                .await
                .err()
        });
        let (tunnel_id, _) = tunnel_order(&mut rx).await;
        drop(reg);
        assert_eq!(opening.await.unwrap(), Some(TunnelError::Gone));
        assert!(registry.claim_tunnel(&tunnel_id).is_none());
        assert!(shells.has_changed().unwrap());
        assert!(shells.borrow_and_update().is_empty());
    }

    /// No more than the cap a minute, whatever becomes of them.
    #[tokio::test]
    async fn tunnels_are_capped_per_minute() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(64);
        let _reg = registry.register(tx, lends_shell(), None, Some(shell_host("me")));
        for _ in 0..TUNNELS_PER_MINUTE {
            assert_eq!(
                registry
                    .open_tunnel("ssh-ed25519 KEY", Duration::from_millis(1))
                    .await
                    .err(),
                Some(TunnelError::TimedOut)
            );
        }
        assert_eq!(
            registry
                .open_tunnel("ssh-ed25519 KEY", Duration::from_millis(1))
                .await
                .err(),
            Some(TunnelError::Busy)
        );
    }

    /// The shell the person used last is asked, and comes first in the list
    /// the server's ssh files follow.
    #[tokio::test]
    async fn the_shell_used_last_is_asked_and_listed_first() {
        let registry = Arc::new(HostRegistry::new());
        let (a_tx, mut a_rx) = mpsc::channel(8);
        let a = registry.register(a_tx, lends_shell(), None, Some(shell_host("a")));
        let (b_tx, mut b_rx) = mpsc::channel(8);
        let _b = registry.register(b_tx, lends_shell(), None, Some(shell_host("b")));
        assert_eq!(registry.shells(), vec![shell_host("b"), shell_host("a")]);
        a.focus();
        assert_eq!(registry.shells(), vec![shell_host("a"), shell_host("b")]);
        let r = Arc::clone(&registry);
        tokio::spawn(async move {
            let _ = r
                .open_tunnel("ssh-ed25519 KEY", Duration::from_secs(5))
                .await;
        });
        tunnel_order(&mut a_rx).await;
        assert!(b_rx.try_recv().is_err());
    }
}
