//! The desktop app's own daemon, run as a child process.
//!
//! Cowork fork (daemon/client split, step 2). The desktop app used to start
//! the daemon — database, agents, engines, everything `boot` starts — inside
//! its own process. It now starts the `codeg-server` it ships beside itself
//! (`bundle.externalBin`, `Contents/MacOS/codeg-server` on macOS) on its own
//! data directory, listening on loopback only, and its windows reach it the
//! way they reach any remote codeg-server. The app is left with what only it
//! can do: windows, tray, dialogs, the built-in browser, computer use, the
//! updater.
//!
//! What this module owns:
//!
//! - [`Mode`]: child (the default), embedded (the old in-process start,
//!   kept for one release as the way back — `CODEG_DESKTOP_DAEMON=embedded`,
//!   and taken on its own when the child cannot be started), or client: no
//!   daemon of its own at all. That last one is an edition of the app
//!   ([`CLIENT_ONLY_BUILD`], the `client-only` feature, step 3 of the split):
//!   built without `codeg-server`, for people whose work is on a Cowork
//!   server. [`decide_mode`] picks between them.
//! - [`ChildSpec`]: the environment the child is started with. Same data
//!   directory (and `CODEG_HOME`) as the embedded daemon had, so every local
//!   conversation, setting and session file is where it was.
//! - [`LocalDaemon`]: start, wait for `/api/health`, restart with
//!   [`Backoff`] when it dies, stop gracefully (SIGTERM, then kill).
//!
//! The child can never outlive the app: its stdin is a pipe from here and it
//! is started with `CODEG_EXIT_ON_STDIN_EOF=1`, so a crashed or killed app
//! takes it along. A child left from an earlier run that somehow survived is
//! recognised by the pid file and stopped before a new one starts.
//!
//! Nothing here depends on Tauri: the smoke test (`codeg --local-daemon-smoke`)
//! and the unit tests drive it without a window.

use std::collections::VecDeque;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::watch;
use tokio::time::Instant;

/// `child`, `embedded` or `client`; unset means [`DEFAULT_MODE`]. Not read
/// by a client-only build, which is always [`Mode::Client`].
pub const MODE_ENV: &str = "CODEG_DESKTOP_DAEMON";

/// Whether this binary is the client-only edition (Cargo feature
/// `client-only`): it ships no `codeg-server` and runs no daemon of its own,
/// in-process or otherwise. Decided at compile time so a client-only app can
/// never be talked into starting a daemon, and a full app never mistakes a
/// missing sidecar for being one (that one falls back to embedded).
pub const CLIENT_ONLY_BUILD: bool = cfg!(feature = "client-only");

/// Set on the child: it is a desktop app's own daemon. Lets the server take
/// its desktop-only defaults (the host bridge below) without guessing.
pub const CHILD_ENV: &str = "CODEG_DESKTOP_CHILD";

/// The app's host bridge (browser and computer-use tools served by the app
/// to the child's agents), handed to the child.
pub const HOST_BRIDGE_URL_ENV: &str = "CODEG_HOST_BRIDGE_URL";
pub const HOST_BRIDGE_TOKEN_ENV: &str = "CODEG_HOST_BRIDGE_TOKEN";

/// The executable's bare name.
pub const SERVER_BIN: &str = if cfg!(windows) {
    "codeg-server.exe"
} else {
    "codeg-server"
};

/// The child's pid, for the next start to find a survivor by.
const PID_FILE: &str = "desktop-daemon.pid";

/// How long a start may take: database migrations included.
pub const START_TIMEOUT: Duration = Duration::from_secs(90);
/// How long a SIGTERM'd child has to shut down (it cancels running turns,
/// up to 5 s, then closes; `codeg-server` gives itself 8 s in all).
pub const STOP_TIMEOUT: Duration = Duration::from_secs(10);
/// A child that stayed up this long starts the backoff over.
const STABLE_AFTER: Duration = Duration::from_secs(60);
/// Lines of the child's stderr kept for a failure to quote.
const STDERR_LINES: usize = 40;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// `codeg-server` as a child process; windows connect to it.
    Child,
    /// The daemon inside the app's own process, as before.
    Embedded,
    /// No daemon of its own: the windows open saved remote workspaces only,
    /// and the local one shows how to connect. The client-only edition is
    /// always in this mode; a full build takes it on request
    /// (`CODEG_DESKTOP_DAEMON=client`), to try that edition's windows.
    Client,
}

pub const DEFAULT_MODE: Mode = Mode::Child;

impl Mode {
    /// The mode `CODEG_DESKTOP_DAEMON` asks for. Anything unrecognised is
    /// the default, logged by the caller.
    pub fn parse(value: Option<&str>) -> Mode {
        match value.map(str::trim).map(str::to_ascii_lowercase).as_deref() {
            Some("embedded") | Some("in-process") | Some("0") | Some("off") => Mode::Embedded,
            Some("child") | Some("1") | Some("on") => Mode::Child,
            Some("client") | Some("none") => Mode::Client,
            _ => DEFAULT_MODE,
        }
    }

    pub fn from_env() -> Mode {
        Mode::parse(std::env::var(MODE_ENV).ok().as_deref())
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Mode::Child => "child",
            Mode::Embedded => "embedded",
            Mode::Client => "client",
        }
    }

    /// Whether the app runs a daemon of its own in this mode (a child or
    /// in-process), as opposed to connecting to servers only.
    pub fn has_local_daemon(self) -> bool {
        !matches!(self, Mode::Client)
    }
}

/// The mode the app starts in. `requested` is `CODEG_DESKTOP_DAEMON`;
/// `web_auto_start` whether the web service (LAN / phone access to the
/// desktop) is set to start with the app — that one is served by the
/// in-process daemon, which a child cannot stand in for.
///
/// A client-only build is `Client` whatever the environment or settings say:
/// there is no `codeg-server` to start and the in-process daemon is not to be
/// used (the web-service setting is left over from a full edition and is
/// ignored, logged by the caller). A full build honours the web service
/// first, then the variable.
pub fn decide_mode(client_only_build: bool, requested: Option<&str>, web_auto_start: bool) -> Mode {
    if client_only_build {
        Mode::Client
    } else if web_auto_start {
        Mode::Embedded
    } else {
        Mode::parse(requested)
    }
}

/// `codeg-server` beside the running executable: where `externalBin` puts it
/// in a bundle (`Contents/MacOS/`, the install dir on Windows/Linux) and where
/// `tauri dev` copies it (`target/debug/`).
pub fn server_beside(exe: &Path) -> Option<PathBuf> {
    let candidate = exe.parent()?.join(SERVER_BIN);
    candidate
        .metadata()
        .is_ok_and(|m| m.is_file() && m.len() > 0)
        .then_some(candidate)
}

/// A loopback port free right now. The child binds it moments later; should
/// something take it in between, the child fails to bind, exits, and the
/// restart picks another.
pub fn free_loopback_port() -> std::io::Result<u16> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0))?;
    Ok(listener.local_addr()?.port())
}

/// Where the app's host bridge listens, for the child.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostBridgeEnv {
    pub url: String,
    pub token: String,
}

/// Everything the child is started with.
#[derive(Debug, Clone)]
pub struct ChildSpec {
    pub server: PathBuf,
    /// The desktop's effective data directory: the embedded daemon's.
    pub data_dir: PathBuf,
    pub port: u16,
    /// Random per app launch; the child accepts nothing else.
    pub token: String,
    pub host_bridge: Option<HostBridgeEnv>,
}

impl ChildSpec {
    /// Variables set on the child. The rest of the app's environment is
    /// inherited as the embedded daemon saw it (`CODEG_HOME`, the proxy
    /// variables, PATH as `fix-path-env` fixed it).
    pub fn envs(&self) -> Vec<(&'static str, OsString)> {
        let mut envs: Vec<(&'static str, OsString)> = vec![
            ("CODEG_DATA_DIR", self.data_dir.clone().into_os_string()),
            ("CODEG_HOST", "127.0.0.1".into()),
            ("CODEG_PORT", self.port.to_string().into()),
            ("CODEG_TOKEN", self.token.clone().into()),
            // The app updates itself, and the child with it (it is the copy
            // inside the bundle); the child's own self-update would replace
            // a file inside a signed bundle.
            ("CODEG_UPDATE_DISABLED", "1".into()),
            // The port bridge serves dev servers to a browser that cannot
            // reach this machine's loopback; the app's windows are on it.
            ("CODEG_BRIDGE_PORTS", "off".into()),
            (crate::runtime_lock::EXIT_ON_STDIN_EOF_ENV, "1".into()),
            (CHILD_ENV, "1".into()),
        ];
        if let Some(bridge) = &self.host_bridge {
            envs.push((HOST_BRIDGE_URL_ENV, bridge.url.clone().into()));
            envs.push((HOST_BRIDGE_TOKEN_ENV, bridge.token.clone().into()));
        }
        envs
    }

    /// Variables the child must not inherit from the app.
    pub const REMOVED_ENVS: &'static [&'static str] = &[
        // Its own discovery file, not the app's.
        crate::cli_run::discovery::ENDPOINT_FILE_ENV,
        // Not under the self-update supervisor.
        crate::update::runtime::ENV_SUPERVISED,
        // Only `codeg-cli --standalone` takes a data directory alone.
        crate::runtime_lock::EXCLUSIVE_ENV,
        // The web build's static files: the app's windows bring their own.
        "CODEG_STATIC_DIR",
        // Behind no portal.
        "COWORK_PORTAL",
        "CODEG_PORTAL",
    ];

    pub fn base_url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

/// Exponential restart delay: 0.5 s doubling to 30 s.
#[derive(Debug, Default, Clone)]
pub struct Backoff {
    attempt: u32,
}

impl Backoff {
    pub const FIRST: Duration = Duration::from_millis(500);
    pub const MAX: Duration = Duration::from_secs(30);

    pub fn next_delay(&mut self) -> Duration {
        let delay = Self::FIRST
            .saturating_mul(1u32 << self.attempt.min(16))
            .min(Self::MAX);
        self.attempt = self.attempt.saturating_add(1);
        delay
    }

    pub fn reset(&mut self) {
        self.attempt = 0;
    }

    pub fn attempts(&self) -> u32 {
        self.attempt
    }
}

/// Where the running child answers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Endpoint {
    pub base_url: String,
    pub token: String,
    pub pid: u32,
}

#[derive(Debug)]
pub enum StartError {
    /// No `codeg-server` beside the app.
    NoServer,
    Spawn(String),
    /// It ended before answering (exit status, last stderr lines).
    Exited(String),
    /// It did not answer `/api/health` within [`START_TIMEOUT`].
    Timeout(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            StartError::NoServer => write!(f, "no {SERVER_BIN} beside the app"),
            StartError::Spawn(e) => write!(f, "cannot start {SERVER_BIN}: {e}"),
            StartError::Exited(e) => write!(f, "{SERVER_BIN} ended at startup: {e}"),
            StartError::Timeout(e) => write!(f, "{SERVER_BIN} did not come up: {e}"),
        }
    }
}

impl std::error::Error for StartError {}

/// What a start needs besides the port, which each start picks anew.
#[derive(Debug, Clone)]
pub struct LaunchConfig {
    pub server: PathBuf,
    pub data_dir: PathBuf,
    pub token: String,
    pub host_bridge: Option<HostBridgeEnv>,
    /// How long one start may take before it counts as failed.
    pub start_timeout: Duration,
}

impl LaunchConfig {
    fn spec(&self, port: u16) -> ChildSpec {
        ChildSpec {
            server: self.server.clone(),
            data_dir: self.data_dir.clone(),
            port,
            token: self.token.clone(),
            host_bridge: self.host_bridge.clone(),
        }
    }
}

struct Running {
    child: Child,
    /// Held so the child lives; dropped (closed) only once it is to go.
    stdin: Option<ChildStdin>,
    endpoint: Endpoint,
    started: Instant,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
}

struct Inner {
    config: LaunchConfig,
    http: reqwest::Client,
    endpoint_tx: watch::Sender<Option<Endpoint>>,
    stopping: std::sync::atomic::AtomicBool,
    running: tokio::sync::Mutex<Option<Running>>,
    supervisor: Mutex<Option<tokio::task::JoinHandle<()>>>,
}

/// The app's child daemon. Cheap to clone.
#[derive(Clone)]
pub struct LocalDaemon {
    inner: Arc<Inner>,
}

impl LocalDaemon {
    /// Start the child and wait until it answers; then keep it running
    /// (restart with backoff) until [`stop`](Self::stop).
    pub async fn start(config: LaunchConfig) -> Result<LocalDaemon, StartError> {
        stop_survivor(&config.data_dir).await;
        let http = loopback_client();
        let (endpoint_tx, _) = watch::channel(None);
        let inner = Arc::new(Inner {
            config,
            http,
            endpoint_tx,
            stopping: std::sync::atomic::AtomicBool::new(false),
            running: tokio::sync::Mutex::new(None),
            supervisor: Mutex::new(None),
        });
        let first = launch(&inner).await?;
        inner.endpoint_tx.send_replace(Some(first.endpoint.clone()));
        *inner.running.lock().await = Some(first);
        let supervisor = tokio::spawn(supervise(Arc::clone(&inner)));
        *inner.supervisor.lock().expect("supervisor slot") = Some(supervisor);
        Ok(LocalDaemon { inner })
    }

    /// Where it answers now; `None` while it is being restarted.
    pub fn endpoint(&self) -> Option<Endpoint> {
        self.inner.endpoint_tx.borrow().clone()
    }

    /// Follow the endpoint across restarts.
    pub fn subscribe(&self) -> watch::Receiver<Option<Endpoint>> {
        self.inner.endpoint_tx.subscribe()
    }

    pub fn token(&self) -> &str {
        &self.inner.config.token
    }

    pub fn data_dir(&self) -> &Path {
        &self.inner.config.data_dir
    }

    /// Wait until it answers again (after a restart), up to `timeout`.
    pub async fn wait_endpoint(&self, timeout: Duration) -> Option<Endpoint> {
        let mut rx = self.subscribe();
        let wait = async {
            loop {
                if let Some(endpoint) = rx.borrow_and_update().clone() {
                    return Some(endpoint);
                }
                if rx.changed().await.is_err() {
                    return None;
                }
            }
        };
        tokio::time::timeout(timeout, wait).await.ok().flatten()
    }

    /// SIGTERM, give it [`STOP_TIMEOUT`], then kill. No restart afterwards.
    pub async fn stop(&self) {
        self.inner
            .stopping
            .store(true, std::sync::atomic::Ordering::SeqCst);
        if let Some(handle) = self
            .inner
            .supervisor
            .lock()
            .expect("supervisor slot")
            .take()
        {
            handle.abort();
        }
        self.inner.endpoint_tx.send_replace(None);
        let running = self.inner.running.lock().await.take();
        if let Some(running) = running {
            shut_down(running).await;
        }
        let _ = std::fs::remove_file(self.inner.config.data_dir.join(PID_FILE));
    }

    /// The same, from a thread outside any runtime (the app's exit hook).
    pub fn stop_blocking(&self) {
        let daemon = self.clone();
        let _ = std::thread::spawn(move || {
            match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(rt) => rt.block_on(daemon.stop()),
                Err(e) => tracing::warn!("[local-daemon] no runtime to stop the child: {e}"),
            }
        })
        .join();
    }

    /// Test / smoke hook: kill the child as a crash would.
    pub async fn kill_for_test(&self) -> Option<u32> {
        let mut guard = self.inner.running.lock().await;
        let running = guard.as_mut()?;
        let pid = running.endpoint.pid;
        let _ = running.child.start_kill();
        Some(pid)
    }
}

/// The connection id the app's windows use for their own daemon, through the
/// same remote-workspace proxy as any remote codeg-server
/// (`commands::remote_proxy`). Never a database row: those start at 1.
pub const LOCAL_CONNECTION_ID: i32 = -1;

/// How long a request waits for a restarting child before it fails.
pub const RESTART_WAIT: Duration = Duration::from_secs(15);

static REGISTERED: std::sync::OnceLock<LocalDaemon> = std::sync::OnceLock::new();

/// The app's child daemon, once started (see `lib.rs` setup).
pub fn register(daemon: LocalDaemon) {
    let _ = REGISTERED.set(daemon);
}

pub fn registered() -> Option<&'static LocalDaemon> {
    REGISTERED.get()
}

/// The local daemon as a remote-workspace connection, for the proxy.
/// `Ok(None)`: no child daemon (embedded mode). `Err`: it is restarting and
/// did not come back within [`RESTART_WAIT`].
pub async fn connection_info(
) -> Result<Option<crate::models::remote_workspace_connection::RemoteWorkspaceConnectionInfo>, String>
{
    let Some(daemon) = registered() else {
        return Ok(None);
    };
    let endpoint = match daemon.endpoint() {
        Some(e) => e,
        None => daemon
            .wait_endpoint(RESTART_WAIT)
            .await
            .ok_or_else(|| format!("the local {SERVER_BIN} is restarting"))?,
    };
    let now = chrono::Utc::now();
    Ok(Some(
        crate::models::remote_workspace_connection::RemoteWorkspaceConnectionInfo {
            id: LOCAL_CONNECTION_ID,
            name: "local".to_string(),
            base_url: endpoint.base_url,
            token: endpoint.token,
            headers: Vec::new(),
            sort_order: 0,
            created_at: now,
            updated_at: now,
        },
    ))
}

/// A client for loopback only: never through the user's proxy settings
/// (`HTTP_PROXY` would otherwise send `127.0.0.1` to the proxy).
pub fn loopback_client() -> reqwest::Client {
    reqwest::Client::builder()
        .no_proxy()
        .connect_timeout(Duration::from_secs(2))
        .timeout(Duration::from_secs(5))
        .build()
        .unwrap_or_default()
}

/// One start: spawn on a fresh port and wait for `/api/health`.
async fn launch(inner: &Inner) -> Result<Running, StartError> {
    let server = &inner.config.server;
    if !server.is_file() {
        return Err(StartError::NoServer);
    }
    let port = free_loopback_port().map_err(|e| StartError::Spawn(format!("no free port: {e}")))?;
    let spec = inner.config.spec(port);
    let mut command = Command::new(&spec.server);
    for name in ChildSpec::REMOVED_ENVS {
        command.env_remove(name);
    }
    command
        .envs(spec.envs())
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW: no console flashing up behind the app.
        command.creation_flags(0x0800_0000);
    }
    let mut child = command
        .spawn()
        .map_err(|e| StartError::Spawn(e.to_string()))?;
    let pid = child.id().unwrap_or_default();
    let _ = std::fs::write(inner.config.data_dir.join(PID_FILE), pid.to_string());
    let stdin = child.stdin.take();
    let stderr_tail = Arc::new(Mutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        // Drained all along: a full pipe would stall the child. Its own log
        // file has everything; this keeps the tail for a failure to quote.
        let tail = Arc::clone(&stderr_tail);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut tail = tail.lock().expect("stderr tail");
                if tail.len() == STDERR_LINES {
                    tail.pop_front();
                }
                tail.push_back(line);
            }
        });
    }
    let endpoint = Endpoint {
        base_url: spec.base_url(),
        token: spec.token.clone(),
        pid,
    };
    let mut running = Running {
        child,
        stdin,
        endpoint,
        started: Instant::now(),
        stderr_tail,
    };
    let give_up = Instant::now() + inner.config.start_timeout;
    loop {
        if let Ok(Some(status)) = running.child.try_wait() {
            return Err(StartError::Exited(format!(
                "{status}{}",
                last_lines(&running.stderr_tail)
            )));
        }
        if health_ok(&inner.http, &running.endpoint).await {
            tracing::info!(
                "[local-daemon] {} up at {} (pid {pid})",
                SERVER_BIN,
                running.endpoint.base_url
            );
            running.started = Instant::now();
            return Ok(running);
        }
        if Instant::now() >= give_up {
            let detail = format!(
                "no answer from {} within {} s{}",
                running.endpoint.base_url,
                inner.config.start_timeout.as_secs(),
                last_lines(&running.stderr_tail)
            );
            shut_down(running).await;
            return Err(StartError::Timeout(detail));
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
}

/// `POST /api/health` with the token answers 2xx.
pub async fn health_ok(http: &reqwest::Client, endpoint: &Endpoint) -> bool {
    http.post(format!("{}/api/health", endpoint.base_url))
        .bearer_auth(&endpoint.token)
        .json(&serde_json::json!({}))
        .send()
        .await
        .is_ok_and(|r| r.status().is_success())
}

/// Wait on the child; when it dies, restart it with backoff, for as long as
/// the app runs.
async fn supervise(inner: Arc<Inner>) {
    let mut backoff = Backoff::default();
    loop {
        // Wait for the current child to end, without holding the lock (stop
        // needs it).
        loop {
            if inner.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let mut guard = inner.running.lock().await;
            let Some(running) = guard.as_mut() else {
                break;
            };
            match running.child.try_wait() {
                Ok(Some(status)) => {
                    let lived = running.started.elapsed();
                    tracing::warn!(
                        "[local-daemon] {} (pid {}) ended after {} s: {status}{}",
                        SERVER_BIN,
                        running.endpoint.pid,
                        lived.as_secs(),
                        last_lines(&running.stderr_tail)
                    );
                    if lived >= STABLE_AFTER {
                        backoff.reset();
                    }
                    *guard = None;
                    break;
                }
                Ok(None) => {}
                Err(e) => tracing::warn!("[local-daemon] cannot wait on the child: {e}"),
            }
            drop(guard);
            tokio::time::sleep(Duration::from_millis(500)).await;
        }
        inner.endpoint_tx.send_replace(None);
        // Start it again until one start holds.
        loop {
            if inner.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            let delay = backoff.next_delay();
            tokio::time::sleep(delay).await;
            if inner.stopping.load(std::sync::atomic::Ordering::SeqCst) {
                return;
            }
            match launch(&inner).await {
                Ok(running) => {
                    inner
                        .endpoint_tx
                        .send_replace(Some(running.endpoint.clone()));
                    *inner.running.lock().await = Some(running);
                    break;
                }
                Err(e) => {
                    tracing::error!("[local-daemon] restart {} failed: {e}", backoff.attempts())
                }
            }
        }
    }
}

/// SIGTERM (graceful: running turns are cancelled first), then kill.
async fn shut_down(mut running: Running) {
    #[cfg(unix)]
    if let Some(pid) = running.child.id().and_then(|p| i32::try_from(p).ok()) {
        // SAFETY: a signal to our own child.
        unsafe {
            libc::kill(pid, libc::SIGTERM);
        }
    }
    #[cfg(not(unix))]
    {
        // No SIGTERM: a closed stdin is how it is told to go.
        drop(running.stdin.take());
    }
    if tokio::time::timeout(STOP_TIMEOUT, running.child.wait())
        .await
        .is_err()
    {
        tracing::warn!(
            "[local-daemon] {} did not stop within {} s; killing it",
            SERVER_BIN,
            STOP_TIMEOUT.as_secs()
        );
        let _ = running.child.kill().await;
    }
    drop(running.stdin.take());
}

/// A child of an earlier run still alive (it should have gone with its
/// stdin): stopped, so two daemons never serve one data directory from this
/// app.
async fn stop_survivor(data_dir: &Path) {
    let file = data_dir.join(PID_FILE);
    let Some(pid) = std::fs::read_to_string(&file)
        .ok()
        .and_then(|s| s.trim().parse::<u32>().ok())
    else {
        return;
    };
    let _ = std::fs::remove_file(&file);
    if crate::cli_run::discovery::pid_is_dead(pid) || !is_codeg_server(pid) {
        return;
    }
    tracing::warn!("[local-daemon] stopping {SERVER_BIN} pid {pid} left from an earlier run");
    #[cfg(unix)]
    {
        if let Ok(raw) = i32::try_from(pid) {
            // SAFETY: checked above to be a codeg-server of ours.
            unsafe {
                libc::kill(raw, libc::SIGTERM);
            }
            let give_up = Instant::now() + STOP_TIMEOUT;
            while Instant::now() < give_up && !crate::cli_run::discovery::pid_is_dead(pid) {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            if !crate::cli_run::discovery::pid_is_dead(pid) {
                unsafe {
                    libc::kill(raw, libc::SIGKILL);
                }
            }
        }
    }
}

/// Whether `pid` runs a `codeg-server` (a reused pid must not be killed).
fn is_codeg_server(pid: u32) -> bool {
    #[cfg(unix)]
    {
        std::process::Command::new("ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .ok()
            .is_some_and(|out| {
                String::from_utf8_lossy(&out.stdout)
                    .trim()
                    .ends_with("codeg-server")
            })
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        false
    }
}

fn last_lines(tail: &Arc<Mutex<VecDeque<String>>>) -> String {
    let tail = tail.lock().expect("stderr tail");
    if tail.is_empty() {
        String::new()
    } else {
        format!("\n{}", tail.iter().cloned().collect::<Vec<_>>().join("\n"))
    }
}

/// `codeg --local-daemon-smoke [--server <path>]`: start the bundled
/// codeg-server the way the app does, on a throwaway data directory; check
/// `/api/health`; kill it as a crash would and wait for the restart; stop it.
/// For CI on the machine the app is built on. Prints one line per step;
/// returns the process exit code.
pub fn run_smoke(args: &[String]) -> i32 {
    let server = args
        .iter()
        .position(|a| a == "--server")
        .and_then(|i| args.get(i + 1))
        .map(PathBuf::from)
        .or_else(|| std::env::current_exe().ok().and_then(|e| server_beside(&e)));
    let Some(server) = server else {
        eprintln!("[smoke] FAIL: no {SERVER_BIN} beside this executable (or --server <path>)");
        return 1;
    };
    let rt = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(rt) => rt,
        Err(e) => {
            eprintln!("[smoke] FAIL: no runtime: {e}");
            return 1;
        }
    };
    rt.block_on(async move {
        let data = match tempfile::Builder::new().prefix("codeg-smoke-").tempdir() {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[smoke] FAIL: no temporary data directory: {e}");
                return 1;
            }
        };
        println!("[smoke] server {}", server.display());
        let config = LaunchConfig {
            server,
            data_dir: data.path().to_path_buf(),
            token: crate::cli_run::hello::random_hex(32),
            host_bridge: None,
            start_timeout: START_TIMEOUT,
        };
        let daemon = match LocalDaemon::start(config).await {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[smoke] FAIL: start: {e}");
                return 1;
            }
        };
        let first = daemon.endpoint().expect("endpoint after start");
        println!("[smoke] up at {} (pid {})", first.base_url, first.pid);
        let http = loopback_client();
        if !health_ok(&http, &first).await {
            eprintln!("[smoke] FAIL: /api/health");
            daemon.stop().await;
            return 1;
        }
        let refused = http
            .post(format!("{}/api/health", first.base_url))
            .bearer_auth("not-the-token")
            .json(&serde_json::json!({}))
            .send()
            .await
            .map(|r| r.status().as_u16())
            .unwrap_or(0);
        println!("[smoke] /api/health ok; with a wrong token: {refused}");
        daemon.kill_for_test().await;
        let mut rx = daemon.subscribe();
        // Seen gone, then back on a new pid.
        let back = tokio::time::timeout(Duration::from_secs(60), async {
            loop {
                if rx.changed().await.is_err() {
                    return None;
                }
                if let Some(e) = rx.borrow_and_update().clone() {
                    if e.pid != first.pid {
                        return Some(e);
                    }
                }
            }
        })
        .await
        .ok()
        .flatten();
        let Some(second) = back else {
            eprintln!("[smoke] FAIL: not restarted after a kill");
            daemon.stop().await;
            return 1;
        };
        println!(
            "[smoke] restarted at {} (pid {})",
            second.base_url, second.pid
        );
        daemon.stop().await;
        if !crate::cli_run::discovery::pid_is_dead(second.pid) {
            eprintln!("[smoke] FAIL: pid {} still alive after stop", second.pid);
            return 1;
        }
        println!("[smoke] stopped; OK");
        0
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mode_defaults_to_child_and_reads_embedded() {
        assert_eq!(Mode::parse(None), Mode::Child);
        assert_eq!(Mode::parse(Some("")), Mode::Child);
        assert_eq!(Mode::parse(Some("whatever")), Mode::Child);
        assert_eq!(Mode::parse(Some("embedded")), Mode::Embedded);
        assert_eq!(Mode::parse(Some(" Embedded ")), Mode::Embedded);
        assert_eq!(Mode::parse(Some("0")), Mode::Embedded);
        assert_eq!(Mode::parse(Some("child")), Mode::Child);
        assert_eq!(Mode::parse(Some("client")), Mode::Client);
        assert_eq!(Mode::parse(Some("NONE")), Mode::Client);
    }

    #[test]
    fn client_only_build_is_client_whatever_is_asked() {
        assert_eq!(decide_mode(true, None, false), Mode::Client);
        assert_eq!(decide_mode(true, Some("embedded"), false), Mode::Client);
        assert_eq!(decide_mode(true, Some("child"), false), Mode::Client);
        // A web-service setting left over from a full edition does not bring
        // the in-process daemon back.
        assert_eq!(decide_mode(true, None, true), Mode::Client);
        assert!(!Mode::Client.has_local_daemon());
    }

    #[test]
    fn full_build_honours_the_web_service_then_the_variable() {
        assert_eq!(decide_mode(false, None, false), Mode::Child);
        assert_eq!(decide_mode(false, Some("embedded"), false), Mode::Embedded);
        assert_eq!(decide_mode(false, Some("client"), false), Mode::Client);
        assert_eq!(decide_mode(false, None, true), Mode::Embedded);
        assert_eq!(decide_mode(false, Some("child"), true), Mode::Embedded);
        assert_eq!(decide_mode(false, Some("client"), true), Mode::Embedded);
        assert!(Mode::Child.has_local_daemon());
        assert!(Mode::Embedded.has_local_daemon());
    }

    #[test]
    fn child_env_keeps_the_data_dir_and_loopback_only() {
        let spec = ChildSpec {
            server: PathBuf::from("/app/codeg-server"),
            data_dir: PathBuf::from("/Users/me/Library/Application Support/app.dodoer"),
            port: 43123,
            token: "t0k".into(),
            host_bridge: None,
        };
        let envs: std::collections::HashMap<_, _> = spec.envs().into_iter().collect();
        assert_eq!(
            envs["CODEG_DATA_DIR"],
            OsString::from("/Users/me/Library/Application Support/app.dodoer")
        );
        assert_eq!(envs["CODEG_HOST"], OsString::from("127.0.0.1"));
        assert_eq!(envs["CODEG_PORT"], OsString::from("43123"));
        assert_eq!(envs["CODEG_TOKEN"], OsString::from("t0k"));
        assert_eq!(envs["CODEG_UPDATE_DISABLED"], OsString::from("1"));
        assert_eq!(
            envs[crate::runtime_lock::EXIT_ON_STDIN_EOF_ENV],
            OsString::from("1")
        );
        assert_eq!(envs[CHILD_ENV], OsString::from("1"));
        assert!(!envs.contains_key(HOST_BRIDGE_URL_ENV));
        assert_eq!(spec.base_url(), "http://127.0.0.1:43123");
    }

    #[test]
    fn child_env_carries_the_host_bridge() {
        let spec = ChildSpec {
            server: PathBuf::from("/app/codeg-server"),
            data_dir: PathBuf::from("/d"),
            port: 1,
            token: "t".into(),
            host_bridge: Some(HostBridgeEnv {
                url: "http://127.0.0.1:5000".into(),
                token: "b".into(),
            }),
        };
        let envs: std::collections::HashMap<_, _> = spec.envs().into_iter().collect();
        assert_eq!(
            envs[HOST_BRIDGE_URL_ENV],
            OsString::from("http://127.0.0.1:5000")
        );
        assert_eq!(envs[HOST_BRIDGE_TOKEN_ENV], OsString::from("b"));
    }

    #[test]
    fn removed_envs_cover_what_would_mislead_the_child() {
        let removed = ChildSpec::REMOVED_ENVS;
        assert!(removed.contains(&crate::cli_run::discovery::ENDPOINT_FILE_ENV));
        assert!(removed.contains(&crate::runtime_lock::EXCLUSIVE_ENV));
        assert!(removed.contains(&"CODEG_STATIC_DIR"));
    }

    #[test]
    fn backoff_doubles_to_a_cap_and_resets() {
        let mut b = Backoff::default();
        assert_eq!(b.next_delay(), Duration::from_millis(500));
        assert_eq!(b.next_delay(), Duration::from_secs(1));
        assert_eq!(b.next_delay(), Duration::from_secs(2));
        for _ in 0..20 {
            assert!(b.next_delay() <= Backoff::MAX);
        }
        assert_eq!(b.next_delay(), Backoff::MAX);
        b.reset();
        assert_eq!(b.next_delay(), Duration::from_millis(500));
    }

    #[test]
    fn server_beside_finds_only_a_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let exe = dir.path().join("codeg");
        assert_eq!(server_beside(&exe), None);
        std::fs::write(dir.path().join(SERVER_BIN), b"").unwrap();
        assert_eq!(server_beside(&exe), None, "an empty file is not a server");
        std::fs::write(dir.path().join(SERVER_BIN), b"#!").unwrap();
        assert_eq!(server_beside(&exe), Some(dir.path().join(SERVER_BIN)));
    }

    #[test]
    fn free_loopback_port_is_nonzero() {
        assert!(free_loopback_port().unwrap() > 0);
    }

    #[tokio::test]
    async fn start_without_a_server_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let err = LocalDaemon::start(LaunchConfig {
            server: dir.path().join(SERVER_BIN),
            data_dir: dir.path().to_path_buf(),
            token: "t".into(),
            host_bridge: None,
            start_timeout: Duration::from_secs(5),
        })
        .await
        .err()
        .expect("no server");
        assert!(matches!(err, StartError::NoServer), "{err}");
    }

    /// The whole smoke against a real `codeg-server`, where one is built:
    /// `CODEG_SMOKE_SERVER=<path> cargo test --lib local_daemon -- --ignored`.
    #[test]
    #[ignore = "needs a built codeg-server (CODEG_SMOKE_SERVER)"]
    fn smoke_against_a_real_server() {
        let server = std::env::var("CODEG_SMOKE_SERVER").expect("CODEG_SMOKE_SERVER");
        let args = vec!["--server".to_string(), server];
        assert_eq!(run_smoke(&args), 0);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_child_that_exits_at_once_is_reported_with_its_stderr() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join(SERVER_BIN);
        std::fs::write(&fake, "#!/bin/sh\necho 'bind failed' >&2\nexit 3\n").unwrap();
        std::fs::set_permissions(&fake, std::fs::Permissions::from_mode(0o755)).unwrap();
        let err = LocalDaemon::start(LaunchConfig {
            server: fake,
            data_dir: dir.path().to_path_buf(),
            token: "t".into(),
            host_bridge: None,
            start_timeout: Duration::from_secs(5),
        })
        .await
        .err()
        .expect("exits");
        match err {
            StartError::Exited(detail) => {
                assert!(detail.contains('3'), "{detail}");
            }
            other => panic!("expected Exited, got {other}"),
        }
    }
}
