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
//!
//! Several apps may be registered at once — the same person on two computers
//! — and which one takes a call is theirs to say (`docs/host-choice.md`):
//! each app names the computer it is on (`host_device`), and the person can
//! fix the browser, or the command line, to one of them ([`HostChoices`],
//! `web::host_choice`). Left alone, a call goes to the computer whose Chrome
//! they let agents use ([`CAPABILITY_CHROME`]), else to the one they used
//! last.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use axum::extract::ws::WebSocket;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
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
use crate::host_device::HostDevice;
use crate::host_ssh::tunnel::{ShellHost, CAPABILITY as CAPABILITY_SHELL, TUNNELS_PER_MINUTE};

/// The `server_info` feature a desktop app looks for before registering.
pub const FEATURE: &str = "host_bridge_ws";

/// The capability a host names to be lent browser calls.
pub const CAPABILITY_BROWSER: &str = "browser";

/// The capability a host names beside `browser` while the person lets this
/// server's agents use their own Chrome there (`browser::chrome::lending`).
/// Nothing is asked by it: with several computers lending their tabs, it
/// says which one the person means.
pub const CAPABILITY_CHROME: &str = "chrome";

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

/// What an agent is told when the person fixed the browser to a computer
/// that lends none right now. Never another computer's instead: an agent
/// working on the wrong one is what fixing it is for.
pub fn browser_away_note(name: &str) -> String {
    format!(
        "The user fixed this workspace's browser to {}, and no desktop app there lends its \
         browser right now. Ask the user to open this workspace in the desktop app on that \
         computer, or to choose another computer from the computers icon at the foot of the \
         sidebar, then try again.",
        named(name)
    )
}

/// A computer as a note names it.
pub fn named(name: &str) -> String {
    if name.is_empty() {
        "one particular computer".to_string()
    } else {
        format!("the computer \"{name}\"")
    }
}

/// Why a call got no answer.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostCallError {
    /// No registered host has the capability.
    NoHost,
    /// The person fixed the capability to a computer that does not lend it
    /// now ([`HostRegistry::pinned_name`] says which).
    PinnedAway,
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
    /// The person fixed `ssh desktop` to the computer of this name, and it
    /// lends no shell now.
    PinnedAway(String),
    /// [`TUNNELS_PER_MINUTE`] opened in the last minute already.
    Busy,
    /// The host answered that it cannot, and why.
    Refused(String),
    /// The host's socket closed, or its dial did not upgrade.
    Gone,
    /// The host did not dial back in time.
    TimedOut,
}

/// A computer the person fixed a capability to, with the name it had then:
/// what there is to show while it is away.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PinnedDevice {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// Which computer takes what, where the person said so. `None` leaves it to
/// [`Inner::pick`].
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostChoices {
    /// For browser calls.
    #[serde(default)]
    pub browser: Option<PinnedDevice>,
    /// For `ssh desktop`.
    #[serde(default)]
    pub shell: Option<PinnedDevice>,
}

impl HostChoices {
    fn of(&self, capability: &str) -> Option<&PinnedDevice> {
        match capability {
            CAPABILITY_BROWSER => self.browser.as_ref(),
            CAPABILITY_SHELL => self.shell.as_ref(),
            _ => None,
        }
    }

    fn slot(&mut self, capability: &str) -> Option<&mut Option<PinnedDevice>> {
        match capability {
            CAPABILITY_BROWSER => Some(&mut self.browser),
            CAPABILITY_SHELL => Some(&mut self.shell),
            _ => None,
        }
    }
}

/// Why a choice was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChooseError {
    /// Not something a computer is chosen for.
    NoSuchCapability,
    /// No app registered now is on that computer.
    NoSuchDevice,
}

/// One computer with an app registered here, and what it lends.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LendingDevice {
    /// What [`HostDevices::browser_now`] and `shell_now` name it by: its
    /// id, or one of the socket's for an app that names no computer.
    pub key: String,
    /// What a choice names it by. `None` for an app from before computers
    /// had ids: it takes calls, but cannot be fixed on.
    pub id: Option<String>,
    pub name: String,
    pub browser: bool,
    /// Its person lets this server's agents use their own Chrome there.
    pub chrome: bool,
    pub shell: bool,
}

/// The computers registered, the person's choices, and where the next call
/// of each kind goes: what the chooser shows (`web::host_choice`).
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct HostDevices {
    /// The one used last first.
    pub devices: Vec<LendingDevice>,
    pub choices: HostChoices,
    /// The [`LendingDevice::key`] a browser call goes to now, if anywhere.
    pub browser_now: Option<String>,
    /// The one `ssh desktop` reaches now.
    pub shell_now: Option<String>,
}

/// Why [`Inner::pick`] found nobody.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Missing {
    NoHost,
    PinnedAway,
}

impl From<Missing> for HostCallError {
    fn from(missing: Missing) -> Self {
        match missing {
            Missing::NoHost => Self::NoHost,
            Missing::PinnedAway => Self::PinnedAway,
        }
    }
}

/// What a tunnel's waiting end gets: the socket the host dialed, or the
/// host's reason for not dialing.
pub type TunnelReply = oneshot::Sender<Result<WebSocket, String>>;

struct Host {
    id: u64,
    tx: mpsc::Sender<ServerMsg>,
    capabilities: Vec<String>,
    window: Option<String>,
    /// The computer it is on, when the app says.
    device: Option<HostDevice>,
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

    /// Whether it is on the computer with this id.
    fn is_on(&self, device_id: &str) -> bool {
        self.device.as_ref().is_some_and(|d| d.id == device_id)
    }

    /// Chrome is reached through the tabs a host lends: nothing without them.
    fn lends_chrome(&self) -> bool {
        self.lends(CAPABILITY_BROWSER) && self.lends(CAPABILITY_CHROME)
    }

    /// Its [`LendingDevice::key`].
    fn key(&self) -> String {
        match &self.device {
            Some(device) => device.id.clone(),
            None => format!("host-{}", self.id),
        }
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
    /// The computers the person fixed things to.
    choices: HostChoices,
}

impl Inner {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The host that takes a call for `capability`.
    ///
    /// On the computer the person fixed it to, and on no other: with that
    /// one away the call fails and says so, because the next one in line is
    /// a different computer. Fixed to nothing, a browser call goes to a
    /// computer whose Chrome agents may use before one that lends only the
    /// built-in browser, and among equals to the one the person used last.
    fn pick(&self, capability: &str) -> Result<&Host, Missing> {
        let lending = self.hosts.iter().filter(|h| h.lends(capability));
        match self.choices.of(capability) {
            Some(pinned) => lending
                .filter(|h| h.is_on(&pinned.id))
                .max_by_key(|h| h.active_at)
                .ok_or(Missing::PinnedAway),
            None => lending
                .max_by_key(|h| {
                    (
                        capability == CAPABILITY_BROWSER && h.lends_chrome(),
                        h.active_at,
                    )
                })
                .ok_or(Missing::NoHost),
        }
    }

    /// The shells lent now, the one [`pick`](Self::pick) asks first.
    fn shells(&self) -> Vec<ShellHost> {
        let pinned = self.choices.of(CAPABILITY_SHELL);
        let mut hosts: Vec<&Host> = self
            .hosts
            .iter()
            .filter(|h| h.lends(CAPABILITY_SHELL))
            .collect();
        hosts.sort_by_key(|h| {
            std::cmp::Reverse((pinned.is_some_and(|p| h.is_on(&p.id)), h.active_at))
        });
        hosts.into_iter().filter_map(|h| h.shell.clone()).collect()
    }

    /// Every computer with an app registered, the one used last first; two
    /// sockets of one computer are one entry.
    fn devices(&self) -> HostDevices {
        let mut hosts: Vec<&Host> = self.hosts.iter().collect();
        hosts.sort_by_key(|h| std::cmp::Reverse(h.active_at));
        let mut devices: Vec<LendingDevice> = Vec::new();
        for host in hosts {
            let key = host.key();
            let browser = host.lends(CAPABILITY_BROWSER);
            let chrome = host.lends_chrome();
            let shell = host.lends(CAPABILITY_SHELL);
            match devices.iter_mut().find(|d| d.key == key) {
                Some(device) => {
                    device.browser |= browser;
                    device.chrome |= chrome;
                    device.shell |= shell;
                }
                None => devices.push(LendingDevice {
                    key,
                    id: host.device.as_ref().map(|d| d.id.clone()),
                    name: host
                        .device
                        .as_ref()
                        .map(|d| d.name.clone())
                        .unwrap_or_default(),
                    browser,
                    chrome,
                    shell,
                }),
            }
        }
        HostDevices {
            devices,
            choices: self.choices.clone(),
            browser_now: self.pick(CAPABILITY_BROWSER).ok().map(Host::key),
            shell_now: self.pick(CAPABILITY_SHELL).ok().map(Host::key),
        }
    }

    /// The name of the computer `capability` is fixed to; empty when it has
    /// none, or nothing is fixed.
    fn pinned_name(&self, capability: &str) -> String {
        self.choices
            .of(capability)
            .map(|pinned| pinned.name.clone())
            .unwrap_or_default()
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

/// A computer's id as the logs name it. Not its name: that is a person's
/// ("James's Mac mini"), and these lines leave the server
/// (`telemetry::config::INFO_LOG_TARGETS`).
fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
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
        self.register_on(tx, capabilities, window, shell, None)
    }

    /// [`register`](Self::register), for an app that says which computer it
    /// is on.
    pub fn register_on(
        self: &Arc<Self>,
        tx: mpsc::Sender<ServerMsg>,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
        device: Option<HostDevice>,
    ) -> HostRegistration {
        let device = device.and_then(HostDevice::sound);
        let mut inner = self.lock();
        inner.next_host += 1;
        let id = inner.next_host;
        let active_at = inner.tick();
        tracing::info!(
            "[host-registry] host {id} registered ({}; {}; computer {})",
            capabilities.join(","),
            window.as_deref().unwrap_or("?"),
            device.as_ref().map_or("?", |d| short(&d.id))
        );
        inner.hosts.push(Host {
            id,
            tx,
            capabilities,
            window,
            device,
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

    /// The computers registered, the choices, and where calls go now.
    pub fn devices(&self) -> HostDevices {
        self.lock().devices()
    }

    /// The choices as they were stored, when the server starts
    /// (`web::host_choice::restore`).
    pub fn set_choices(&self, choices: HostChoices) {
        let mut inner = self.lock();
        inner.choices = choices;
        self.publish_shells(&inner);
    }

    /// Fix `capability` (`browser` or `shell`) to the computer `device_id`
    /// — one with an app registered now, so that its name is known — or to
    /// none. The choices as they are afterwards, for keeping.
    pub fn choose(
        &self,
        capability: &str,
        device_id: Option<&str>,
    ) -> Result<HostChoices, ChooseError> {
        let mut inner = self.lock();
        let pinned = match device_id {
            None => None,
            Some(id) => Some(
                inner
                    .hosts
                    .iter()
                    .filter_map(|h| h.device.as_ref())
                    .find(|d| d.id == id)
                    .map(|d| PinnedDevice {
                        id: d.id.clone(),
                        name: d.name.clone(),
                    })
                    .ok_or(ChooseError::NoSuchDevice)?,
            ),
        };
        let slot = inner
            .choices
            .slot(capability)
            .ok_or(ChooseError::NoSuchCapability)?;
        tracing::info!(
            "[host-registry] {capability} fixed to computer {}",
            pinned.as_ref().map_or("(none)", |p| short(&p.id))
        );
        *slot = pinned;
        self.publish_shells(&inner);
        Ok(inner.choices.clone())
    }

    /// The name of the computer `capability` is fixed to, for a note to an
    /// agent; empty when it has none.
    pub fn pinned_name(&self, capability: &str) -> String {
        self.lock().pinned_name(capability)
    }

    fn update(
        &self,
        id: u64,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
        device: Option<HostDevice>,
    ) {
        let mut inner = self.lock();
        let now = inner.tick();
        if let Some(host) = inner.hosts.iter_mut().find(|h| h.id == id) {
            if host.capabilities != capabilities {
                tracing::info!(
                    "[host-registry] host {id} now lends ({})",
                    capabilities.join(",")
                );
            }
            host.capabilities = capabilities;
            host.window = window;
            host.shell = sound(shell);
            host.device = device.and_then(HostDevice::sound);
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

    /// Ask the host lending its shell that [`Inner::pick`] names for a
    /// tunnel that lets `client_key` in, and wait up to `timeout` for it to
    /// dial back ([`claim_tunnel`](Self::claim_tunnel)).
    pub async fn open_tunnel(
        &self,
        client_key: &str,
        timeout: Duration,
    ) -> Result<WebSocket, TunnelError> {
        let (tunnel_id, tx, rx) = {
            let mut inner = self.lock();
            let host = match inner.pick(CAPABILITY_SHELL) {
                Ok(host) => host,
                Err(Missing::NoHost) => return Err(TunnelError::NoHost),
                Err(Missing::PinnedAway) => {
                    return Err(TunnelError::PinnedAway(
                        inner.pinned_name(CAPABILITY_SHELL),
                    ))
                }
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

    /// Send `call` to the host [`Inner::pick`] names for `capability` and
    /// wait for its outcome.
    pub async fn call(
        &self,
        capability: &str,
        call: BridgeCall,
        timeout: Duration,
    ) -> Result<serde_json::Value, HostCallError> {
        let (call_id, tx, rx) = {
            let mut inner = self.lock();
            let host = inner.pick(capability)?;
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
        self.update_on(capabilities, window, shell, None);
    }

    /// [`update`](Self::update), for an app that says which computer it is
    /// on.
    pub fn update_on(
        &self,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
        device: Option<HostDevice>,
    ) {
        self.registry
            .update(self.id, capabilities, window, shell, device);
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
/// call goes to the registered desktop app [`Inner::pick`] names.
pub struct RemoteHostBrowser {
    hosts: Arc<HostRegistry>,
}

impl RemoteHostBrowser {
    pub fn new(hosts: Arc<HostRegistry>) -> Self {
        Self { hosts }
    }

    /// The host's outcome; or, when there is none to give, the note the
    /// caller answers with as a runtime without a browser would.
    async fn ask<T: DeserializeOwned>(
        &self,
        call: BrowserCall,
        timeout: Duration,
    ) -> Result<T, String> {
        match self
            .hosts
            .call(CAPABILITY_BROWSER, BridgeCall::Browser(call), timeout)
            .await
        {
            Ok(outcome) => serde_json::from_value(outcome).map_err(|e| {
                tracing::warn!("[host-registry] a host answered something unreadable: {e}");
                NO_DESKTOP_NOTE.to_string()
            }),
            Err(HostCallError::NoHost) => Err(NO_DESKTOP_NOTE.to_string()),
            Err(HostCallError::PinnedAway) => Err(browser_away_note(
                &self.hosts.pinned_name(CAPABILITY_BROWSER),
            )),
            Err(e) => {
                tracing::warn!("[host-registry] browser call failed: {e:?}");
                Err(NO_DESKTOP_NOTE.to_string())
            }
        }
    }
}

#[async_trait]
impl BrowserToolAccess for RemoteHostBrowser {
    async fn list_tabs(&self) -> BrowserTabsOutcome {
        self.ask(BrowserCall::ListTabs, CALL_TIMEOUT)
            .await
            .unwrap_or_else(|note| BrowserTabsOutcome::unavailable(&note))
    }

    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        let call = BrowserCall::Snapshot {
            tab_id: tab_id.to_string(),
            max_chars,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|note| {
            BrowserSnapshotOutcome::refused(tab_id, ERROR_UNAVAILABLE, note)
        })
    }

    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome {
        let call = BrowserCall::Act {
            tab_id: tab_id.to_string(),
            request,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|note| {
            BrowserActOutcome::refused(tab_id, ERROR_UNAVAILABLE, note)
        })
    }

    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome {
        let call = BrowserCall::Console {
            tab_id: tab_id.to_string(),
            query,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|note| {
            BrowserConsoleOutcome::refused(tab_id, ERROR_UNAVAILABLE, note)
        })
    }

    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome {
        let call = BrowserCall::Capture {
            tab_id: tab_id.to_string(),
            request,
        };
        self.ask(call, CALL_TIMEOUT).await.unwrap_or_else(|note| {
            BrowserCaptureOutcome::refused(tab_id, ERROR_UNAVAILABLE, note)
        })
    }

    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome {
        let call = BrowserCall::Eval {
            tab_id: tab_id.to_string(),
            request,
        };
        self.ask(call, EVAL_TIMEOUT).await.unwrap_or_else(|note| {
            BrowserEvalOutcome::refused(tab_id, ERROR_UNAVAILABLE, note)
        })
    }

    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        let named = op.tab_id().map(str::to_string);
        self.ask(BrowserCall::TabOp { op }, CALL_TIMEOUT)
            .await
            .unwrap_or_else(|note| {
                BrowserTabOutcome::refused(named.as_deref(), ERROR_UNAVAILABLE, note)
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

    fn device(id: &str, name: &str) -> HostDevice {
        HostDevice {
            id: format!("{id}-0123456789"),
            name: name.to_string(),
        }
    }

    fn lends_chrome() -> Vec<String> {
        vec![
            CAPABILITY_BROWSER.to_string(),
            CAPABILITY_CHROME.to_string(),
        ]
    }

    /// Who a browser call is sent to: the receiver that gets a `host_call`.
    async fn asked(registry: &Arc<HostRegistry>) -> Result<(), HostCallError> {
        registry
            .call(
                CAPABILITY_BROWSER,
                BridgeCall::Browser(BrowserCall::ListTabs),
                Duration::from_millis(20),
            )
            .await
            .map(|_| ())
    }

    /// With several computers lending their tabs, the one whose Chrome
    /// agents may use takes the call, whichever was used last.
    #[tokio::test]
    async fn a_computer_lending_its_chrome_goes_before_the_one_used_last() {
        let registry = Arc::new(HostRegistry::new());
        let (mini_tx, mut mini_rx) = mpsc::channel(8);
        let mini = registry.register_on(
            mini_tx,
            browser(),
            None,
            None,
            Some(device("mini", "Mac mini")),
        );
        let (book_tx, mut book_rx) = mpsc::channel(8);
        let book = registry.register_on(
            book_tx,
            lends_chrome(),
            None,
            None,
            Some(device("book", "MacBook")),
        );
        mini.focus();
        assert_eq!(asked(&registry).await, Err(HostCallError::TimedOut));
        assert!(matches!(
            book_rx.try_recv(),
            Ok(ServerMsg::HostCall { .. })
        ));
        assert!(mini_rx.try_recv().is_err());
        let now = registry.devices();
        assert_eq!(now.browser_now, Some(device("book", "").id));
        assert_eq!(
            now.devices.iter().map(|d| d.name.as_str()).collect::<Vec<_>>(),
            ["Mac mini", "MacBook"],
            "the one used last first"
        );
        assert!(now.devices[1].chrome && !now.devices[0].chrome);

        // The switch off again: back to the one used last.
        book.update_on(browser(), None, None, Some(device("book", "MacBook")));
        mini.focus();
        assert_eq!(asked(&registry).await, Err(HostCallError::TimedOut));
        assert!(matches!(
            mini_rx.try_recv(),
            Ok(ServerMsg::HostCall { .. })
        ));
    }

    /// `chrome` without `browser` is a switch on a computer that lends no
    /// tabs: nothing to prefer.
    #[tokio::test]
    async fn chrome_counts_only_with_the_tabs_it_is_reached_through() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(8);
        let _only_chrome = registry.register_on(
            tx,
            vec![CAPABILITY_CHROME.to_string()],
            None,
            None,
            Some(device("book", "MacBook")),
        );
        assert_eq!(asked(&registry).await, Err(HostCallError::NoHost));
        let now = registry.devices();
        assert!(!now.devices[0].chrome && !now.devices[0].browser);
        assert_eq!(now.browser_now, None);
    }

    /// A computer the person fixed the browser to takes every call, and
    /// while it is away nobody does.
    #[tokio::test]
    async fn a_fixed_computer_takes_the_calls_and_nobody_stands_in_for_it() {
        let registry = Arc::new(HostRegistry::new());
        let (mini_tx, mut mini_rx) = mpsc::channel(8);
        let mini = registry.register_on(
            mini_tx,
            browser(),
            None,
            None,
            Some(device("mini", "Mac mini")),
        );
        let (book_tx, mut book_rx) = mpsc::channel(8);
        let _book = registry.register_on(
            book_tx,
            lends_chrome(),
            None,
            None,
            Some(device("book", "MacBook")),
        );
        let mini_id = device("mini", "").id;
        let choices = registry
            .choose(CAPABILITY_BROWSER, Some(&mini_id))
            .expect("a computer that is here");
        assert_eq!(
            choices.browser,
            Some(PinnedDevice {
                id: mini_id.clone(),
                name: "Mac mini".into()
            })
        );
        assert_eq!(choices.shell, None);
        assert_eq!(asked(&registry).await, Err(HostCallError::TimedOut));
        assert!(matches!(
            mini_rx.try_recv(),
            Ok(ServerMsg::HostCall { .. })
        ));
        assert!(book_rx.try_recv().is_err());

        // Its app closes: the MacBook is not asked in its place.
        drop(mini);
        assert_eq!(asked(&registry).await, Err(HostCallError::PinnedAway));
        assert!(book_rx.try_recv().is_err());
        assert_eq!(registry.devices().browser_now, None);
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));
        let note = tools.list_tabs().await.note.unwrap_or_default();
        assert!(note.contains("\"Mac mini\""), "{note}");
        let refused = tools.snapshot("t1", None).await;
        assert_eq!(refused.error.as_deref(), Some(ERROR_UNAVAILABLE));
        assert_eq!(refused.note.as_deref(), Some(note.as_str()));

        // Back to whoever is there.
        registry.choose(CAPABILITY_BROWSER, None).unwrap();
        assert_eq!(asked(&registry).await, Err(HostCallError::TimedOut));
        assert!(matches!(
            book_rx.try_recv(),
            Ok(ServerMsg::HostCall { .. })
        ));
    }

    #[tokio::test]
    async fn only_a_computer_that_is_here_can_be_chosen_and_only_for_what_is_lent() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(8);
        let _unnamed = registry.register(tx, browser(), None, None);
        let (named_tx, _named_rx) = mpsc::channel(8);
        let _named = registry.register_on(
            named_tx,
            browser(),
            None,
            None,
            Some(device("book", "MacBook")),
        );
        let book_id = device("book", "").id;
        assert_eq!(
            registry.choose(CAPABILITY_BROWSER, Some("nobody-0123456789")),
            Err(ChooseError::NoSuchDevice)
        );
        assert_eq!(
            registry.choose("computer", Some(&book_id)),
            Err(ChooseError::NoSuchCapability)
        );
        assert_eq!(registry.devices().choices, HostChoices::default());
        // An app that names no computer is listed, and cannot be chosen.
        let now = registry.devices();
        assert_eq!(now.devices.len(), 2);
        let unnamed = now.devices.iter().find(|d| d.id.is_none()).unwrap();
        assert!(unnamed.key.starts_with("host-") && unnamed.browser);
        // An id an app made up is not kept.
        let (odd_tx, _odd_rx) = mpsc::channel(8);
        let _odd = registry.register_on(
            odd_tx,
            browser(),
            None,
            None,
            Some(HostDevice {
                id: "two words".into(),
                name: "Odd".into(),
            }),
        );
        assert_eq!(
            registry.choose(CAPABILITY_BROWSER, Some("two words")),
            Err(ChooseError::NoSuchDevice)
        );
    }

    /// Two sockets of one computer — a window for the tabs, a reconnect —
    /// are one computer, lending what either lends.
    #[tokio::test]
    async fn two_sockets_of_one_computer_are_one_entry() {
        let registry = Arc::new(HostRegistry::new());
        let (a_tx, _a_rx) = mpsc::channel(8);
        let _a = registry.register_on(
            a_tx,
            browser(),
            None,
            None,
            Some(device("book", "MacBook")),
        );
        let (b_tx, _b_rx) = mpsc::channel(8);
        let _b = registry.register_on(
            b_tx,
            lends_shell(),
            None,
            Some(shell_host("me")),
            Some(device("book", "MacBook")),
        );
        let now = registry.devices();
        assert_eq!(now.devices.len(), 1);
        assert!(now.devices[0].browser && now.devices[0].shell);
        assert_eq!(now.browser_now, now.shell_now);
    }

    /// `ssh desktop` follows the computer the shell is fixed to: asked,
    /// listed first for the server's ssh files, and not replaced while away.
    #[tokio::test]
    async fn a_fixed_shell_is_asked_listed_first_and_not_stood_in_for() {
        let registry = Arc::new(HostRegistry::new());
        let mut shells = registry.watch_shells();
        let (a_tx, mut a_rx) = mpsc::channel(8);
        let a = registry.register_on(
            a_tx,
            lends_shell(),
            None,
            Some(shell_host("a")),
            Some(device("mini", "Mac mini")),
        );
        let (b_tx, mut b_rx) = mpsc::channel(8);
        let _b = registry.register_on(
            b_tx,
            lends_shell(),
            None,
            Some(shell_host("b")),
            Some(device("book", "MacBook")),
        );
        assert_eq!(*shells.borrow_and_update(), vec![shell_host("b"), shell_host("a")]);
        let mini_id = device("mini", "").id;
        registry.choose(CAPABILITY_SHELL, Some(&mini_id)).unwrap();
        assert!(shells.has_changed().unwrap(), "the ssh files follow");
        assert_eq!(*shells.borrow_and_update(), vec![shell_host("a"), shell_host("b")]);
        assert_eq!(registry.devices().shell_now, Some(mini_id.clone()));
        let r = Arc::clone(&registry);
        tokio::spawn(async move {
            let _ = r
                .open_tunnel("ssh-ed25519 KEY", Duration::from_secs(5))
                .await;
        });
        tunnel_order(&mut a_rx).await;
        assert!(b_rx.try_recv().is_err());

        drop(a);
        assert_eq!(
            registry
                .open_tunnel("ssh-ed25519 KEY", Duration::from_secs(5))
                .await
                .err(),
            Some(TunnelError::PinnedAway("Mac mini".into()))
        );
        assert!(b_rx.try_recv().is_err());
        // The browser was never fixed: it goes on as before.
        assert_eq!(registry.devices().choices.browser, None);
    }

    /// What was stored comes back when the server starts, before any app
    /// has registered.
    #[tokio::test]
    async fn stored_choices_hold_before_their_computer_is_back() {
        let registry = Arc::new(HostRegistry::new());
        let stored: HostChoices = serde_json::from_str(
            r#"{"browser":{"id":"mini-0123456789","name":"Mac mini"}}"#,
        )
        .unwrap();
        assert_eq!(stored.shell, None);
        registry.set_choices(stored.clone());
        assert_eq!(registry.devices().choices, stored);
        let (tx, mut rx) = mpsc::channel(8);
        let _book = registry.register_on(
            tx,
            browser(),
            None,
            None,
            Some(device("book", "MacBook")),
        );
        assert_eq!(asked(&registry).await, Err(HostCallError::PinnedAway));
        assert!(rx.try_recv().is_err());
        let (mini_tx, mut mini_rx) = mpsc::channel(8);
        let _mini = registry.register_on(
            mini_tx,
            browser(),
            None,
            None,
            Some(device("mini", "Mac mini")),
        );
        assert_eq!(asked(&registry).await, Err(HostCallError::TimedOut));
        assert!(matches!(
            mini_rx.try_recv(),
            Ok(ServerMsg::HostCall { .. })
        ));
    }
}
