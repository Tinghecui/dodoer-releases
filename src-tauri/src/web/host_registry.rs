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
//! Several apps may be registered at once — the same person on two
//! computers. Each names the computer it is on (`host_device`), and the
//! registry keeps the book of every computer that ever connected
//! ([`DeviceBook`], `web::host_devices`, `docs/devices.md`). A call names
//! the device it means: `ssh <name>` ([`ShellTarget`]), a browser tab by the
//! device in its id or the `device` a new one is opened on
//! (`web::host_browser`, [`HostRegistry::route_tab`]). Nothing here picks
//! a device by who was active last.

use std::collections::{BTreeSet, HashMap, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::extract::ws::WebSocket;
use tokio::sync::{mpsc, oneshot, watch};

use super::host_devices::{
    now_ms, DeviceBook, DeviceList, DeviceRecord, DeviceView, ForgetError, NameError, Presence,
    Seen,
};
use super::ws_attach::ServerMsg;
use crate::host_bridge::BridgeCall;
use crate::host_device::HostDevice;
use crate::host_ssh::client::{SshDevice, SshPlan, HOST_ALIAS};
use crate::host_ssh::tunnel::{ShellHost, CAPABILITY as CAPABILITY_SHELL, TUNNELS_PER_MINUTE};

/// The `server_info` feature a desktop app looks for before registering.
pub const FEATURE: &str = "host_bridge_ws";

/// The capability a host names to be lent browser calls.
pub const CAPABILITY_BROWSER: &str = "browser";

/// The capability a host names beside `browser` while the person lets this
/// server's agents use their own Chrome there (`browser::chrome::lending`).
/// Nothing is asked by it, and it chooses no device: the list of devices
/// shows it.
pub const CAPABILITY_CHROME: &str = "chrome";

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
    /// The host asked is not registered (any more).
    NoHost,
    /// The host's socket closed before it answered.
    Gone,
    /// The host did not answer in time.
    TimedOut,
}

/// Which computer an `ssh` means.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellTarget<'a> {
    /// `ssh <name>`: the device with this id (`desktop proxy --device`).
    Device(&'a str),
    /// A configuration that names no device: the old `ssh desktop` — the
    /// device called that, else the only one, else an app from before
    /// devices while the book is empty.
    Default,
}

/// Why a tunnel to a lent shell did not open.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TunnelError {
    /// Nothing in the book, and no app from before devices lends its shell.
    NoHost,
    /// The device asked for is not in the book (any more); the names there
    /// are.
    UnknownDevice { names: Vec<String> },
    /// It is in the book, and no app on it is connected.
    Offline { name: String, last_seen: i64 },
    /// An app on it is connected, and lends no shell.
    NotLent { name: String },
    /// The old name, with several devices and none called that.
    Ambiguous { names: Vec<String> },
    /// [`TUNNELS_PER_MINUTE`] opened to that device in the last minute
    /// already.
    Busy,
    /// The host answered that it cannot, and why.
    Refused(String),
    /// The host's socket closed, or its dial did not upgrade.
    Gone,
    /// The host did not dial back in time.
    TimedOut,
}

/// Where a browser call goes: one registered window, and the prefix its tab
/// ids carry for the agent (`<name>:`; none for an app from before
/// devices).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BrowserHost {
    pub host: u64,
    pub prefix: String,
}

/// Why a browser call has nowhere to go.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BrowserRouteError {
    /// Nothing lends its tabs.
    NoHost,
    /// No device by that name; the names there are.
    UnknownDevice { name: String, names: Vec<String> },
    /// In the book, and no app on it is connected.
    Offline { name: String, last_seen: i64 },
    /// An app on it is connected, and lends no tabs.
    NotLent { name: String },
    /// Several devices lend their tabs, and the call names none of them.
    ChooseDevice { names: Vec<String> },
    /// A tab id that names no device, and no device listed it.
    UnknownTab,
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
    /// The app's version, as its `hello` said.
    app_version: Option<String>,
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
    /// Which window each tab an agent was told of came from, by the tab's
    /// own id: a device with several windows has a set of tabs in each.
    tabs: HashMap<String, u64>,
    /// Tunnels asked for and not dialed yet, by their random id.
    tunnels: HashMap<String, PendingTunnel>,
    /// When the tunnels of the last minute were asked for, per device (an
    /// app from before devices under "").
    tunnel_starts: HashMap<String, VecDeque<Instant>>,
    next_host: u64,
    next_call: u64,
    clock: u64,
    /// Every computer that ever registered here.
    book: DeviceBook,
}

impl Inner {
    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    /// The windows lending their tabs: each device's in the book, or — with
    /// none in it — the apps from before devices.
    fn browser_lenders(&self) -> impl Iterator<Item = &Host> {
        let book_empty = self.book.records().is_empty();
        self.hosts.iter().filter(move |h| {
            h.lends(CAPABILITY_BROWSER) && (h.device.is_some() || book_empty)
        })
    }

    /// The prefix a host's tab ids carry: its device's name.
    fn prefix_of(&self, host: &Host) -> String {
        host.device
            .as_ref()
            .and_then(|d| self.book.get(&d.id))
            .map(|record| format!("{}:", record.name))
            .unwrap_or_default()
    }

    fn browser_host(&self, host: &Host) -> BrowserHost {
        BrowserHost {
            host: host.id,
            prefix: self.prefix_of(host),
        }
    }

    /// The device called `name`.
    fn named(&self, name: &str) -> Result<&DeviceRecord, BrowserRouteError> {
        let name = name.trim().to_ascii_lowercase();
        self.book
            .records()
            .iter()
            .find(|d| d.name == name)
            .ok_or_else(|| BrowserRouteError::UnknownDevice {
                name,
                names: self.names(),
            })
    }

    /// The window of `record` lending its tabs, the one used last.
    fn browser_on(&self, record: &DeviceRecord) -> Result<&Host, BrowserRouteError> {
        let mut on_it = self.hosts.iter().filter(|h| h.is_on(&record.id)).peekable();
        if on_it.peek().is_none() {
            return Err(BrowserRouteError::Offline {
                name: record.name.clone(),
                last_seen: record.last_seen,
            });
        }
        on_it
            .filter(|h| h.lends(CAPABILITY_BROWSER))
            .max_by_key(|h| h.active_at)
            .ok_or_else(|| BrowserRouteError::NotLent {
                name: record.name.clone(),
            })
    }

    /// Where a call that names no device goes: the one device lending its
    /// tabs; with none in the book, the app from before devices used last.
    fn only_browser(&self) -> Result<&Host, BrowserRouteError> {
        if self.book.records().is_empty() {
            return self
                .browser_lenders()
                .max_by_key(|h| h.active_at)
                .ok_or(BrowserRouteError::NoHost);
        }
        let mut devices: Vec<&str> = self
            .browser_lenders()
            .filter_map(|h| h.device.as_ref().map(|d| d.id.as_str()))
            .collect();
        devices.sort_unstable();
        devices.dedup();
        match devices.as_slice() {
            [] => Err(BrowserRouteError::NoHost),
            [only] => self
                .browser_lenders()
                .filter(|h| h.is_on(only))
                .max_by_key(|h| h.active_at)
                .ok_or(BrowserRouteError::NoHost),
            several => Err(BrowserRouteError::ChooseDevice {
                names: several
                    .iter()
                    .filter_map(|id| self.book.get(id).map(|d| d.name.clone()))
                    .collect(),
            }),
        }
    }

    fn browser_hosts(&self) -> Vec<BrowserHost> {
        self.browser_lenders()
            .map(|h| self.browser_host(h))
            .collect()
    }

    /// Where a new tab opens: on the device called `device`, else on the
    /// only one lending its tabs.
    fn route_open(&self, device: Option<&str>) -> Result<BrowserHost, BrowserRouteError> {
        let host = match device {
            Some(name) => self.browser_on(self.named(name)?)?,
            None => self.only_browser()?,
        };
        Ok(self.browser_host(host))
    }

    /// Where a call on the tab the agent calls `tab_id` goes, and the id the
    /// window knows it by. `<name>:<id>` is that device's; a bare id is
    /// whichever window listed it.
    fn route_tab(&self, tab_id: &str) -> Result<(BrowserHost, String), BrowserRouteError> {
        let listed = |raw: &str| {
            self.tabs
                .get(raw)
                .and_then(|id| self.hosts.iter().find(|h| h.id == *id))
                .filter(|h| h.lends(CAPABILITY_BROWSER))
        };
        if let Some((name, raw)) = tab_id.split_once(':') {
            let record = self.named(name)?;
            let host = match listed(raw).filter(|h| h.is_on(&record.id)) {
                Some(host) => host,
                None => self.browser_on(record)?,
            };
            return Ok((self.browser_host(host), raw.to_string()));
        }
        let host = match listed(tab_id) {
            Some(host) => host,
            None => self.only_browser().map_err(|e| match e {
                BrowserRouteError::ChooseDevice { .. } => BrowserRouteError::UnknownTab,
                other => other,
            })?,
        };
        Ok((self.browser_host(host), tab_id.to_string()))
    }

    /// The host lending its shell that `target` means, or why there is none.
    fn shell_for(&self, target: ShellTarget<'_>) -> Result<&Host, TunnelError> {
        let record = match target {
            ShellTarget::Device(id) => self
                .book
                .get(id)
                .ok_or_else(|| TunnelError::UnknownDevice { names: self.names() })?,
            ShellTarget::Default => match self.desktop_device()? {
                Some(record) => record,
                None => {
                    return self
                        .hosts
                        .iter()
                        .filter(|h| h.device.is_none() && h.lends(CAPABILITY_SHELL))
                        .max_by_key(|h| h.active_at)
                        .ok_or(TunnelError::NoHost)
                }
            },
        };
        let mut on_it = self.hosts.iter().filter(|h| h.is_on(&record.id)).peekable();
        if on_it.peek().is_none() {
            return Err(TunnelError::Offline {
                name: record.name.clone(),
                last_seen: record.last_seen,
            });
        }
        on_it
            .filter(|h| h.lends(CAPABILITY_SHELL))
            .max_by_key(|h| h.active_at)
            .ok_or_else(|| TunnelError::NotLent {
                name: record.name.clone(),
            })
    }

    /// The device the old name means: the one called that, else the only
    /// one; `None` with none in the book.
    fn desktop_device(&self) -> Result<Option<&DeviceRecord>, TunnelError> {
        let records = self.book.records();
        if let Some(called) = records.iter().find(|d| d.name == HOST_ALIAS) {
            return Ok(Some(called));
        }
        match records {
            [] => Ok(None),
            [only] => Ok(Some(only)),
            _ => Err(TunnelError::Ambiguous {
                names: self.names(),
            }),
        }
    }

    /// The names in the book.
    fn names(&self) -> Vec<String> {
        self.book.records().iter().map(|d| d.name.clone()).collect()
    }

    /// What the server's `ssh` configuration says now: an entry per device
    /// in the book, as [`shell_for`](Self::shell_for) finds them.
    fn ssh_plan(&self) -> SshPlan {
        let records = self.book.records();
        let devices = records
            .iter()
            .map(|record| {
                let lent = self
                    .hosts
                    .iter()
                    .filter(|h| h.is_on(&record.id) && h.lends(CAPABILITY_SHELL))
                    .max_by_key(|h| h.active_at)
                    .and_then(|h| h.shell.as_ref());
                SshDevice {
                    id: record.id.clone(),
                    name: record.name.clone(),
                    also_desktop: records.len() == 1 && record.name != HOST_ALIAS,
                    user: lent.map(|s| s.user.clone()).or_else(|| record.user.clone()),
                    host_key: lent.map(|s| s.host_key.clone()),
                }
            })
            .collect();
        let legacy = if records.is_empty() {
            self.hosts
                .iter()
                .filter(|h| h.device.is_none() && h.lends(CAPABILITY_SHELL))
                .max_by_key(|h| h.active_at)
                .and_then(|h| h.shell.clone())
        } else {
            None
        };
        SshPlan { devices, legacy }
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

    /// Every computer in the book, with what its apps lend now: online
    /// first, then the one seen last.
    fn device_list(&self) -> DeviceList {
        let mut devices: Vec<DeviceView> = self
            .book
            .records()
            .iter()
            .map(|record| {
                let mut presence = Presence::default();
                for host in self.hosts.iter().filter(|h| h.is_on(&record.id)) {
                    presence.online = true;
                    presence.shell |= host.lends(CAPABILITY_SHELL);
                    presence.browser |= host.lends(CAPABILITY_BROWSER);
                    presence.chrome |= host.lends_chrome();
                }
                DeviceView::new(record, presence)
            })
            .collect();
        devices.sort_by(|a, b| {
            b.online
                .cmp(&a.online)
                .then(b.last_seen.cmp(&a.last_seen))
                .then_with(|| a.name.cmp(&b.name))
        });
        DeviceList {
            devices,
            unnamed_hosts: self.hosts.iter().filter(|h| h.device.is_none()).count(),
        }
    }

    /// The computers with an app registered now.
    fn online_devices(&self) -> Vec<String> {
        let mut ids: Vec<String> = self
            .hosts
            .iter()
            .filter_map(|h| h.device.as_ref().map(|d| d.id.clone()))
            .collect();
        ids.sort();
        ids.dedup();
        ids
    }
}

/// The desktop apps registered on this server's event sockets.
pub struct HostRegistry {
    inner: Mutex<Inner>,
    /// What the server's `ssh` files say ([`Inner::ssh_plan`]), for
    /// `web::host_tunnel` to keep them so.
    ssh: watch::Sender<SshPlan>,
    /// Moved on whenever the book changes, for `web::host_devices` to write.
    book: watch::Sender<u64>,
}

impl Default for HostRegistry {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            ssh: watch::channel(SshPlan::default()).0,
            book: watch::channel(0).0,
        }
    }
}

/// A computer's id as the logs name it. Not its name: that is a person's
/// ("James's Mac mini"), and these lines leave the server
/// (`telemetry::config::INFO_LOG_TARGETS`).
fn short(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// What the book takes from a registration besides the device.
fn what_it_says<'a>(shell: Option<&'a ShellHost>, app_version: Option<&'a str>) -> Seen<'a> {
    Seen {
        platform: shell.and_then(|s| s.platform.as_deref()),
        user: shell.map(|s| s.user.as_str()),
        app_version,
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

    /// Tell the book's writer that there is something to write.
    fn note_book(&self) {
        self.book.send_modify(|version| *version = version.wrapping_add(1));
    }

    /// Tell whoever keeps the `ssh` files, when they would read differently.
    fn publish_ssh(&self, inner: &Inner) {
        let now = inner.ssh_plan();
        self.ssh.send_if_modified(|plan| {
            if *plan == now {
                false
            } else {
                *plan = now;
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
        self.register_on(tx, capabilities, window, shell, None, None)
    }

    /// [`register`](Self::register), for an app that says which computer it
    /// is on — which goes into the book — and its version.
    pub fn register_on(
        self: &Arc<Self>,
        tx: mpsc::Sender<ServerMsg>,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
        device: Option<HostDevice>,
        app_version: Option<String>,
    ) -> HostRegistration {
        let device = device.and_then(HostDevice::sound);
        let shell = sound(shell);
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
        let in_book = device.is_some();
        if let Some(device) = &device {
            let seen = what_it_says(shell.as_ref(), app_version.as_deref());
            inner.book.seen(device, seen, now_ms());
        }
        inner.hosts.push(Host {
            id,
            tx,
            capabilities,
            window,
            device,
            shell,
            app_version,
            active_at,
        });
        self.publish_ssh(&inner);
        drop(inner);
        if in_book {
            self.note_book();
        }
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

    /// The windows lending their tabs now, for a list of every tab.
    pub fn browser_hosts(&self) -> Vec<BrowserHost> {
        self.lock().browser_hosts()
    }

    /// Where a new tab opens (`Inner::route_open`).
    pub fn route_open(&self, device: Option<&str>) -> Result<BrowserHost, BrowserRouteError> {
        self.lock().route_open(device)
    }

    /// Where a call on a tab goes, and the id its window knows it by.
    pub fn route_tab(&self, tab_id: &str) -> Result<(BrowserHost, String), BrowserRouteError> {
        self.lock().route_tab(tab_id)
    }

    /// The window `host` told of these tabs: calls on them go back to it.
    pub fn remember_tabs(&self, host: u64, tab_ids: Vec<String>) {
        let mut inner = self.lock();
        if !inner.hosts.iter().any(|h| h.id == host) {
            return;
        }
        for tab_id in tab_ids {
            inner.tabs.insert(tab_id, host);
        }
    }

    /// What the server's `ssh` files say now.
    pub fn ssh_plan(&self) -> SshPlan {
        self.lock().ssh_plan()
    }

    /// Told whenever what the server's `ssh` files say changes.
    pub fn watch_ssh(&self) -> watch::Receiver<SshPlan> {
        self.ssh.subscribe()
    }

    /// Whether `target` could have a tunnel now; why not if not.
    pub fn check_shell(&self, target: ShellTarget<'_>) -> Result<(), TunnelError> {
        self.lock().shell_for(target).map(|_| ())
    }

    /// Every computer the server has heard of, and what each lends now.
    pub fn device_list(&self) -> DeviceList {
        self.lock().device_list()
    }

    /// Told whenever the book changes (`web::host_devices` writes it).
    pub fn watch_book(&self) -> watch::Receiver<u64> {
        self.book.subscribe()
    }

    /// The book, to write.
    pub fn book_records(&self) -> Vec<DeviceRecord> {
        self.lock().book.records().to_vec()
    }

    /// The book as it was kept, when the server starts.
    pub fn restore_book(&self, stored: Vec<DeviceRecord>) {
        let mut inner = self.lock();
        inner.book.restore(stored);
        self.publish_ssh(&inner);
        drop(inner);
        self.note_book();
    }

    /// The names the server's own `~/.ssh/config` gives a `Host` already.
    pub fn set_reserved_names(&self, names: BTreeSet<String>) {
        let mut inner = self.lock();
        let changed = inner.book.set_reserved(names);
        if changed {
            self.publish_ssh(&inner);
        }
        drop(inner);
        if changed {
            self.note_book();
        }
    }

    /// Call the computer `id` `name` from now on (`DeviceBook::rename`).
    pub fn rename_device(&self, id: &str, name: &str) -> Result<(), NameError> {
        let mut inner = self.lock();
        inner.book.rename(id, name)?;
        self.publish_ssh(&inner);
        drop(inner);
        tracing::info!("[host-registry] computer {} renamed", short(id));
        self.note_book();
        Ok(())
    }

    /// Take the computer `id` out of the book. Not while an app on it is
    /// connected: it would be back at once.
    pub fn forget_device(&self, id: &str) -> Result<(), ForgetError> {
        let mut inner = self.lock();
        if inner.hosts.iter().any(|h| h.is_on(id)) {
            return Err(ForgetError::Online);
        }
        if !inner.book.forget(id) {
            return Err(ForgetError::NoSuchDevice);
        }
        self.publish_ssh(&inner);
        drop(inner);
        tracing::info!("[host-registry] computer {} forgotten", short(id));
        self.note_book();
        Ok(())
    }

    /// The computers online now were last seen now.
    pub fn touch_online(&self) {
        let mut inner = self.lock();
        let ids = inner.online_devices();
        let touched = inner.book.touch(&ids, now_ms());
        drop(inner);
        if touched {
            self.note_book();
        }
    }

    fn update(
        &self,
        id: u64,
        capabilities: Vec<String>,
        window: Option<String>,
        shell: Option<ShellHost>,
        device: Option<HostDevice>,
    ) {
        let device = device.and_then(HostDevice::sound);
        let shell = sound(shell);
        let mut inner = self.lock();
        let now = inner.tick();
        let mut in_book = false;
        let Inner { hosts, book, .. } = &mut *inner;
        if let Some(host) = hosts.iter_mut().find(|h| h.id == id) {
            if host.capabilities != capabilities {
                tracing::info!(
                    "[host-registry] host {id} now lends ({})",
                    capabilities.join(",")
                );
            }
            if let Some(device) = &device {
                let seen = what_it_says(shell.as_ref(), host.app_version.as_deref());
                book.seen(device, seen, now_ms());
                in_book = true;
            }
            host.capabilities = capabilities;
            host.window = window;
            host.shell = shell;
            host.device = device;
            host.active_at = now;
        }
        self.publish_ssh(&inner);
        drop(inner);
        if in_book {
            self.note_book();
        }
    }

    fn focus(&self, id: u64) {
        let mut inner = self.lock();
        let now = inner.tick();
        if let Some(host) = inner.hosts.iter_mut().find(|h| h.id == id) {
            host.active_at = now;
        }
        self.publish_ssh(&inner);
    }

    fn unregister(&self, id: u64) {
        let mut inner = self.lock();
        let device = inner
            .hosts
            .iter()
            .find(|h| h.id == id)
            .and_then(|h| h.device.as_ref().map(|d| d.id.clone()));
        inner.hosts.retain(|h| h.id != id);
        // Dropping the senders fails the calls still waiting on this host
        // at once, instead of at their timeout.
        inner.pending.retain(|_, p| p.host != id);
        inner.tunnels.retain(|_, t| t.host != id);
        inner.tabs.retain(|_, host| *host != id);
        // Its computer's last app gone: it was last online now.
        let mut left = false;
        if let Some(device) = device {
            if !inner.hosts.iter().any(|h| h.is_on(&device)) {
                left = inner.book.left(&device, now_ms());
            }
        }
        self.publish_ssh(&inner);
        drop(inner);
        if left {
            self.note_book();
        }
        tracing::info!("[host-registry] host {id} gone");
    }

    /// Ask the host lending its shell that `target` means for a tunnel that
    /// lets `client_key` in, and wait up to `timeout` for it to dial back
    /// ([`claim_tunnel`](Self::claim_tunnel)). Never another device's
    /// instead.
    pub async fn open_tunnel(
        &self,
        client_key: &str,
        target: ShellTarget<'_>,
        timeout: Duration,
    ) -> Result<WebSocket, TunnelError> {
        let (tunnel_id, tx, rx) = {
            let mut inner = self.lock();
            let (host_id, tx, device) = {
                let host = inner.shell_for(target)?;
                let device = host.device.as_ref().map(|d| d.id.clone());
                (host.id, host.tx.clone(), device.unwrap_or_default())
            };
            let now = Instant::now();
            let starts = inner.tunnel_starts.entry(device).or_default();
            while starts
                .front()
                .is_some_and(|at| now.duration_since(*at) >= Duration::from_secs(60))
            {
                starts.pop_front();
            }
            if starts.len() >= TUNNELS_PER_MINUTE {
                return Err(TunnelError::Busy);
            }
            starts.push_back(now);
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

    /// Send `call` to the registered window `host` and wait for its
    /// outcome.
    pub async fn call_host(
        &self,
        host: u64,
        call: BridgeCall,
        timeout: Duration,
    ) -> Result<serde_json::Value, HostCallError> {
        let (call_id, tx, rx) = {
            let mut inner = self.lock();
            let target = inner
                .hosts
                .iter()
                .find(|h| h.id == host)
                .ok_or(HostCallError::NoHost)?;
            let tx = target.tx.clone();
            let window = target.window.clone();
            inner.next_call += 1;
            let call_id = inner.next_call;
            tracing::debug!(
                "[host-registry] call {call_id} to host {host} ({})",
                window.as_deref().unwrap_or("?")
            );
            let (reply, rx) = oneshot::channel();
            inner.pending.insert(call_id, Pending { host, reply });
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

#[cfg(test)]
mod tests {
    use super::*;

    fn browser() -> Vec<String> {
        vec![CAPABILITY_BROWSER.to_string()]
    }

    /// A call to one window, sent as is: the list asked of the host.
    fn list_call() -> BridgeCall {
        BridgeCall::Browser(crate::host_bridge::BrowserCall::ListTabs)
    }

    /// Of apps from before devices, with the book empty, a new tab goes to
    /// the one used last; a call goes to the window it is sent to, and only
    /// that window can answer it.
    #[tokio::test]
    async fn the_host_used_last_takes_a_new_tab_and_only_it_answers() {
        let registry = Arc::new(HostRegistry::new());
        let (first_tx, mut first_rx) = mpsc::channel(8);
        let first = registry.register(first_tx, browser(), None, None);
        let (second_tx, mut second_rx) = mpsc::channel(8);
        let second = registry.register(second_tx, browser(), None, None);
        // Registered last: the second takes it.
        let to = registry.route_open(None).unwrap();
        assert_eq!(
            to,
            BrowserHost {
                host: second.id(),
                prefix: String::new()
            }
        );
        let r = Arc::clone(&registry);
        let call = tokio::spawn(async move {
            r.call_host(to.host, list_call(), Duration::from_secs(5)).await
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
        assert_eq!(registry.route_open(None).unwrap().host, first.id());
        assert_eq!(registry.browser_hosts().len(), 2, "both are listed");
    }

    #[tokio::test]
    async fn a_host_without_the_capability_is_never_asked() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(8);
        let reg = registry.register(tx, Vec::new(), None, None);
        assert!(!registry.has_host(CAPABILITY_BROWSER));
        assert_eq!(registry.route_open(None), Err(BrowserRouteError::NoHost));
        assert!(registry.browser_hosts().is_empty());
        // The app's switch turned on: the same socket says so again.
        reg.update(browser(), None, None);
        assert!(registry.has_host(CAPABILITY_BROWSER));
        assert_eq!(registry.route_open(None).unwrap().host, reg.id());
    }

    #[tokio::test]
    async fn a_host_that_goes_away_fails_its_calls_at_once() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, browser(), None, None);
        let host = reg.id();
        let r = Arc::clone(&registry);
        let call = tokio::spawn(async move {
            r.call_host(host, list_call(), Duration::from_secs(600)).await
        });
        assert!(matches!(rx.recv().await, Some(ServerMsg::HostCall { .. })));
        drop(reg);
        assert_eq!(call.await.unwrap(), Err(HostCallError::Gone));
        assert!(!registry.has_host(CAPABILITY_BROWSER));
        assert_eq!(
            registry
                .call_host(host, list_call(), Duration::from_secs(5))
                .await,
            Err(HostCallError::NoHost),
            "gone: nothing to send to"
        );
    }

    #[tokio::test]
    async fn a_host_that_does_not_answer_times_out_and_a_late_answer_is_dropped() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, browser(), None, None);
        let err = registry
            .call_host(reg.id(), list_call(), Duration::from_millis(20))
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
                .open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_millis(1))
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
                .open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_secs(5))
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
            r.open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_secs(5))
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
            r.open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_secs(5))
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
        let mut plans = registry.watch_ssh();
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register(tx, lends_shell(), None, Some(shell_host("me")));
        assert!(plans.has_changed().unwrap());
        assert_eq!(plans.borrow_and_update().legacy, Some(shell_host("me")));
        let r = Arc::clone(&registry);
        let opening = tokio::spawn(async move {
            r.open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_secs(600))
                .await
                .err()
        });
        let (tunnel_id, _) = tunnel_order(&mut rx).await;
        drop(reg);
        assert_eq!(opening.await.unwrap(), Some(TunnelError::Gone));
        assert!(registry.claim_tunnel(&tunnel_id).is_none());
        assert!(plans.has_changed().unwrap());
        assert_eq!(*plans.borrow_and_update(), SshPlan::default());
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
                    .open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_millis(1))
                    .await
                    .err(),
                Some(TunnelError::TimedOut)
            );
        }
        assert_eq!(
            registry
                .open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_millis(1))
                .await
                .err(),
            Some(TunnelError::Busy)
        );
    }

    /// Of several apps from before devices, the one the person used last
    /// is asked, and comes first in the list.
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
        assert_eq!(registry.ssh_plan().legacy, Some(shell_host("a")));
        let r = Arc::clone(&registry);
        tokio::spawn(async move {
            let _ = r
                .open_tunnel("ssh-ed25519 KEY", ShellTarget::Default, Duration::from_secs(5))
                .await;
        });
        tunnel_order(&mut a_rx).await;
        assert!(b_rx.try_recv().is_err());
    }

    fn device(id: &str, name: &str) -> HostDevice {
        HostDevice {
            id: format!("{id}-0123456789"),
            name: name.to_string(),
            model: String::new(),
            kind: None,
        }
    }

    fn lends_chrome() -> Vec<String> {
        vec![
            CAPABILITY_BROWSER.to_string(),
            CAPABILITY_CHROME.to_string(),
        ]
    }

    fn browser_on(
        registry: &Arc<HostRegistry>,
        capabilities: Vec<String>,
        id: &str,
        name: &str,
    ) -> HostRegistration {
        let (tx, rx) = mpsc::channel(8);
        // Nothing reads it: a dropped receiver only fails a send.
        std::mem::forget(rx);
        registry.register_on(tx, capabilities, None, None, Some(device(id, name)), None)
    }

    /// With several devices lending their tabs, a new tab names its device;
    /// Chrome being lent from one of them chooses nothing.
    #[tokio::test]
    async fn several_devices_lending_tabs_make_a_new_tab_name_one() {
        let registry = Arc::new(HostRegistry::new());
        let imac = browser_on(&registry, browser(), "imac", "Study iMac");
        let book = browser_on(&registry, lends_chrome(), "book", "MacBook");
        imac.focus();
        assert_eq!(
            registry.route_open(None),
            Err(BrowserRouteError::ChooseDevice {
                names: vec!["macbook".into(), "study-imac".into()]
            })
        );
        assert_eq!(
            registry.route_open(Some(" MacBook ")).unwrap(),
            BrowserHost {
                host: book.id(),
                prefix: "macbook:".into()
            }
        );
        assert_eq!(registry.route_open(Some("study-imac")).unwrap().host, imac.id());
        assert_eq!(
            registry.route_open(Some("laptop")),
            Err(BrowserRouteError::UnknownDevice {
                name: "laptop".into(),
                names: vec!["study-imac".into(), "macbook".into()]
            })
        );
        let list = registry.device_list();
        let lends = |name: &str| {
            list.devices
                .iter()
                .find(|d| d.computer_name == name)
                .map(|d| (d.browser, d.chrome))
        };
        assert_eq!(lends("MacBook"), Some((true, true)));
        assert_eq!(lends("Study iMac"), Some((true, false)));

        // One of them stops lending: the other is the only one.
        book.update_on(Vec::new(), None, None, Some(device("book", "MacBook")));
        assert_eq!(registry.route_open(None).unwrap().host, imac.id());
        assert_eq!(
            registry.route_open(Some("macbook")),
            Err(BrowserRouteError::NotLent {
                name: "macbook".into()
            })
        );
    }

    /// `chrome` without `browser` is a switch on a computer that lends no
    /// tabs: nothing to send a tab to.
    #[tokio::test]
    async fn chrome_counts_only_with_the_tabs_it_is_reached_through() {
        let registry = Arc::new(HostRegistry::new());
        let _only_chrome = browser_on(
            &registry,
            vec![CAPABILITY_CHROME.to_string()],
            "book",
            "MacBook",
        );
        assert_eq!(registry.route_open(None), Err(BrowserRouteError::NoHost));
        let list = registry.device_list();
        assert!(list.devices[0].online);
        assert!(!list.devices[0].chrome && !list.devices[0].browser);
    }

    /// A tab id with its device's name goes to that device — to the window
    /// that told of it, else the one used last there; a bare id goes to the
    /// window that told of it, or to the only device lending its tabs.
    #[tokio::test]
    async fn a_tab_goes_to_the_device_and_window_it_came_from() {
        let registry = Arc::new(HostRegistry::new());
        let first = browser_on(&registry, browser(), "imac", "Study iMac");
        let second = browser_on(&registry, browser(), "imac", "Study iMac");
        let book = browser_on(&registry, browser(), "book", "MacBook");
        registry.remember_tabs(first.id(), vec!["tab-one".into()]);
        let (to, own) = registry.route_tab("study-imac:tab-one").unwrap();
        assert_eq!((to.host, own.as_str()), (first.id(), "tab-one"));
        assert_eq!(to.prefix, "study-imac:");
        // A tab nobody told of: the device's window used last.
        let (to, own) = registry.route_tab("study-imac:other").unwrap();
        assert_eq!((to.host, own.as_str()), (second.id(), "other"));
        // Told of by one device, named with another: the one named.
        let (to, _) = registry.route_tab("macbook:tab-one").unwrap();
        assert_eq!(to.host, book.id());
        // A bare id: the window that told of it.
        assert_eq!(registry.route_tab("tab-one").unwrap().0.host, first.id());
        assert_eq!(
            registry.route_tab("never-listed"),
            Err(BrowserRouteError::UnknownTab)
        );
        assert!(matches!(
            registry.route_tab("laptop:tab-one"),
            Err(BrowserRouteError::UnknownDevice { .. })
        ));

        // The window gone: its tabs with it; the device's other window
        // takes what is named with the device.
        drop(first);
        assert_eq!(
            registry.route_tab("study-imac:tab-one").unwrap().0.host,
            second.id()
        );
        assert_eq!(
            registry.route_tab("tab-one"),
            Err(BrowserRouteError::UnknownTab)
        );
        // A window that is gone is told of nothing.
        let gone = book.id();
        drop(book);
        registry.remember_tabs(gone, vec!["late".into()]);
        assert_eq!(registry.route_tab("late").unwrap().0.host, second.id(), "the only device");
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
            None,
        );
        let (b_tx, _b_rx) = mpsc::channel(8);
        let _b = registry.register_on(
            b_tx,
            lends_shell(),
            None,
            Some(shell_host("me")),
            Some(device("book", "MacBook")),
            None,
        );
        let list = registry.device_list();
        assert_eq!(list.devices.len(), 1);
        assert!(list.devices[0].browser && list.devices[0].shell);
        assert_eq!(list.devices[0].platform.as_deref(), Some("macos"));
        let kept = registry.book_records();
        assert_eq!(kept[0].user.as_deref(), Some("me"), "who `ssh` logs in as");
    }

    /// Every app that says which computer it is on puts it in the book,
    /// under a name nobody has, and it stays there, offline, once its last
    /// app is gone.
    #[tokio::test]
    async fn a_computer_stays_in_the_book_after_its_apps_are_gone() {
        let registry = Arc::new(HostRegistry::new());
        let mut changes = registry.watch_book();
        let (a_tx, _a_rx) = mpsc::channel(8);
        let a = registry.register_on(
            a_tx,
            Vec::new(),
            Some("remote-workspace-1".into()),
            None,
            Some(device("imac", "Study iMac")),
            Some("1.7.0".into()),
        );
        assert!(changes.has_changed().unwrap(), "a new computer is written");
        drop(changes.borrow_and_update());
        let (b_tx, _b_rx) = mpsc::channel(8);
        let b = registry.register_on(
            b_tx,
            browser(),
            Some("remote-workspace-2".into()),
            None,
            Some(device("imac", "Study iMac")),
            Some("1.7.0".into()),
        );
        let (old_tx, _old_rx) = mpsc::channel(8);
        let _old = registry.register(old_tx, browser(), None, None);
        let list = registry.device_list();
        assert_eq!(list.devices.len(), 1, "two windows of one computer");
        assert_eq!(list.unnamed_hosts, 1, "the app that names none");
        let only = &list.devices[0];
        assert_eq!(only.name, "study-imac");
        assert!(only.online && only.browser && !only.shell);
        assert_eq!(only.app_version.as_deref(), Some("1.7.0"));

        drop(a);
        assert!(
            registry.device_list().devices[0].online,
            "one window is still there"
        );
        drop(changes.borrow_and_update());
        drop(b);
        assert!(!registry.device_list().devices[0].online);
        assert!(changes.has_changed().unwrap(), "when it left is written");
        assert_eq!(registry.book_records().len(), 1);
    }

    /// A name is the person's to change, and a connected computer cannot be
    /// forgotten.
    #[tokio::test]
    async fn a_computer_is_renamed_and_forgotten_through_the_registry() {
        let registry = Arc::new(HostRegistry::new());
        let (tx, _rx) = mpsc::channel(8);
        let app = registry.register_on(
            tx,
            Vec::new(),
            None,
            None,
            Some(device("imac", "Study iMac")),
            None,
        );
        let id = device("imac", "").id;
        registry.set_reserved_names(BTreeSet::from(["prod".to_string()]));
        assert_eq!(registry.rename_device(&id, "prod"), Err(NameError::Reserved));
        assert_eq!(registry.rename_device(&id, "desktop"), Ok(()));
        let list = registry.device_list();
        assert_eq!(list.devices[0].name, "desktop");
        assert!(list.devices[0].named);
        assert_eq!(registry.forget_device(&id), Err(ForgetError::Online));
        drop(app);
        assert_eq!(registry.forget_device(&id), Ok(()));
        assert_eq!(registry.forget_device(&id), Err(ForgetError::NoSuchDevice));
        assert!(registry.device_list().devices.is_empty());
    }

    /// The book read back when the server starts lists its computers
    /// offline until their apps are back, under the names kept.
    #[tokio::test]
    async fn the_book_restored_lists_its_computers_offline() {
        let registry = Arc::new(HostRegistry::new());
        registry.restore_book(vec![DeviceRecord {
            id: device("imac", "").id,
            name: "desktop".into(),
            named: true,
            computer_name: "Study iMac".into(),
            model: "iMac".into(),
            kind: Some("desktop".into()),
            platform: Some("macos".into()),
            app_version: None,
            user: Some("me".into()),
            first_seen: 1,
            last_seen: 2,
        }]);
        let list = registry.device_list();
        assert_eq!(list.devices.len(), 1);
        assert!(!list.devices[0].online);
        assert_eq!(list.devices[0].last_seen, 2);
        let (tx, _rx) = mpsc::channel(8);
        let _app = registry.register_on(
            tx,
            lends_shell(),
            None,
            Some(shell_host("me")),
            Some(device("imac", "Study iMac")),
            None,
        );
        let list = registry.device_list();
        assert_eq!(list.devices[0].name, "desktop", "the name kept");
        assert!(list.devices[0].online && list.devices[0].shell);
    }

    /// A shell lent from a device, as its app registers it.
    fn lending(
        registry: &Arc<HostRegistry>,
        id: &str,
        name: &str,
        user: &str,
    ) -> (HostRegistration, mpsc::Receiver<ServerMsg>) {
        let (tx, rx) = mpsc::channel(8);
        let reg = registry.register_on(
            tx,
            lends_shell(),
            None,
            Some(shell_host(user)),
            Some(device(id, name)),
            None,
        );
        (reg, rx)
    }

    async fn tunnel_to(registry: &Arc<HostRegistry>, target: ShellTarget<'_>) -> TunnelError {
        match registry
            .open_tunnel("ssh-ed25519 KEY", target, Duration::from_millis(20))
            .await
        {
            Ok(_) => panic!("no one dials back in a test"),
            Err(e) => e,
        }
    }

    /// `ssh <name>` goes to that device, whichever the person used last, and
    /// never to another one.
    #[tokio::test]
    async fn ssh_goes_to_the_device_it_names() {
        let registry = Arc::new(HostRegistry::new());
        let (imac, mut imac_rx) = lending(&registry, "imac", "Study iMac", "me");
        let (_book, mut book_rx) = lending(&registry, "book", "MacBook", "me");
        imac.focus();
        let book_id = device("book", "").id;
        assert_eq!(
            tunnel_to(&registry, ShellTarget::Device(&book_id)).await,
            TunnelError::TimedOut
        );
        assert!(matches!(book_rx.try_recv(), Ok(ServerMsg::HostTunnel { .. })));
        assert!(imac_rx.try_recv().is_err());
    }

    /// A device that cannot take it says why, and nothing is asked of
    /// another.
    #[tokio::test]
    async fn a_device_that_cannot_be_reached_says_why() {
        let registry = Arc::new(HostRegistry::new());
        let (_imac, mut imac_rx) = lending(&registry, "imac", "Study iMac", "me");
        let (book_tx, _book_rx) = mpsc::channel(8);
        let _book = registry.register_on(
            book_tx,
            browser(),
            None,
            None,
            Some(device("book", "MacBook")),
            None,
        );
        let book_id = device("book", "").id;
        assert_eq!(
            tunnel_to(&registry, ShellTarget::Device(&book_id)).await,
            TunnelError::NotLent {
                name: "macbook".into()
            }
        );
        assert_eq!(
            tunnel_to(&registry, ShellTarget::Device("nobody-0123456789")).await,
            TunnelError::UnknownDevice {
                names: vec!["study-imac".into(), "macbook".into()]
            }
        );
        assert!(imac_rx.try_recv().is_err(), "nothing asked of another");

        let offline = Arc::new(HostRegistry::new());
        offline.restore_book(vec![DeviceRecord {
            id: book_id.clone(),
            name: "laptop".into(),
            named: true,
            computer_name: "MacBook".into(),
            model: String::new(),
            kind: None,
            platform: None,
            app_version: None,
            user: Some("me".into()),
            first_seen: 1,
            last_seen: 2,
        }]);
        assert_eq!(
            offline.check_shell(ShellTarget::Device(&book_id)),
            Err(TunnelError::Offline {
                name: "laptop".into(),
                last_seen: 2
            })
        );
    }

    /// The old name: the device called `desktop`, else the only one; with
    /// several and none called that, it says which there are.
    #[tokio::test]
    async fn the_old_name_means_the_device_called_desktop_or_the_only_one() {
        let registry = Arc::new(HostRegistry::new());
        let (_imac, mut imac_rx) = lending(&registry, "imac", "Study iMac", "me");
        assert_eq!(tunnel_to(&registry, ShellTarget::Default).await, TunnelError::TimedOut);
        assert!(matches!(imac_rx.try_recv(), Ok(ServerMsg::HostTunnel { .. })));
        assert!(registry.ssh_plan().devices[0].also_desktop);

        let (_book, mut book_rx) = lending(&registry, "book", "MacBook", "me");
        assert_eq!(
            registry.check_shell(ShellTarget::Default),
            Err(TunnelError::Ambiguous {
                names: vec!["study-imac".into(), "macbook".into()]
            })
        );
        assert!(registry.ssh_plan().devices.iter().all(|d| !d.also_desktop));

        let book_id = device("book", "").id;
        registry.rename_device(&book_id, "desktop").unwrap();
        assert_eq!(tunnel_to(&registry, ShellTarget::Default).await, TunnelError::TimedOut);
        assert!(matches!(book_rx.try_recv(), Ok(ServerMsg::HostTunnel { .. })));
        assert!(imac_rx.try_recv().is_err());
    }

    /// An app from before devices is no longer `desktop` once a device is
    /// in the book.
    #[tokio::test]
    async fn an_app_from_before_devices_gives_way_to_the_book() {
        let registry = Arc::new(HostRegistry::new());
        let (old_tx, _old_rx) = mpsc::channel(8);
        let _old = registry.register(old_tx, lends_shell(), None, Some(shell_host("old")));
        assert_eq!(registry.ssh_plan().legacy, Some(shell_host("old")));
        let (_imac, _imac_rx) = lending(&registry, "imac", "Study iMac", "me");
        let plan = registry.ssh_plan();
        assert_eq!(plan.legacy, None);
        assert_eq!(plan.devices.len(), 1);
    }

    /// What the `ssh` files say: every device in the book, its login name
    /// kept while it is away, its host key only while it lends.
    #[tokio::test]
    async fn the_ssh_plan_follows_the_book() {
        let registry = Arc::new(HostRegistry::new());
        let mut plans = registry.watch_ssh();
        let (imac, _imac_rx) = lending(&registry, "imac", "Study iMac", "me");
        assert!(plans.has_changed().unwrap());
        let plan = plans.borrow_and_update().clone();
        assert_eq!(plan.devices.len(), 1);
        let only = &plan.devices[0];
        assert_eq!(only.name, "study-imac");
        assert_eq!(only.user.as_deref(), Some("me"));
        assert_eq!(
            only.host_key.as_deref(),
            Some(shell_host("me").host_key.as_str())
        );

        drop(imac);
        assert!(plans.has_changed().unwrap());
        let away = plans.borrow_and_update().devices[0].clone();
        assert_eq!(away.host_key, None, "not lent now");
        assert_eq!(away.user.as_deref(), Some("me"), "who it logs in as");

        let id = device("imac", "").id;
        registry.rename_device(&id, "desktop").unwrap();
        assert!(plans.has_changed().unwrap());
        assert_eq!(plans.borrow_and_update().devices[0].name, "desktop");
        registry.forget_device(&id).unwrap();
        assert!(plans.has_changed().unwrap());
        assert!(plans.borrow_and_update().devices.is_empty());
    }

    /// The cap is per device: one device busy, another still opens.
    #[tokio::test]
    async fn tunnels_are_capped_per_device() {
        let registry = Arc::new(HostRegistry::new());
        let (_imac, _imac_rx) = lending(&registry, "imac", "Study iMac", "me");
        let (_book, _book_rx) = lending(&registry, "book", "MacBook", "me");
        let imac_id = device("imac", "").id;
        let book_id = device("book", "").id;
        for _ in 0..TUNNELS_PER_MINUTE {
            assert_eq!(
                tunnel_to(&registry, ShellTarget::Device(&imac_id)).await,
                TunnelError::TimedOut
            );
        }
        assert_eq!(
            tunnel_to(&registry, ShellTarget::Device(&imac_id)).await,
            TunnelError::Busy
        );
        assert_eq!(
            tunnel_to(&registry, ShellTarget::Device(&book_id)).await,
            TunnelError::TimedOut
        );
    }
}
