//! Cowork integration for the standalone `codeg-server`.
//!
//! Cowork (an enterprise deployment that runs one `codeg-server` per employee
//! behind a portal + nginx SSO) configures the server through environment
//! variables only. Everything Cowork-specific lives in this module so upstream
//! merges keep touching a handful of call sites:
//!
//! * `bin/codeg_server.rs` calls [`init_process_env`] once, single-threaded,
//!   before anything else reads the environment, and takes the access token
//!   from [`token_override`] instead of `CODEG_TOKEN`.
//! * `web/router.rs` merges [`api_routes`] into the authenticated API.
//! * The self-update handlers call [`ensure_update_allowed`] /
//!   [`ensure_reexec_allowed`].
//! * In cowork mode (`CODEG_COWORK_PORTAL`), a few read handlers pass their
//!   response through the `redact_*` filters and the matching write handlers
//!   through the `restore_*` helpers (access token, agent env, grok API key,
//!   model provider API key); see "Secret redaction" below.
//! * `bin/codeg_server.rs` calls [`secure_db_files`] around
//!   `db::init_database` so `codeg.db` and its sidecars are 0600.
//!
//! Environment contract (`COWORK_<X>` is an alias of `CODEG_<X>`; the
//! `CODEG_` name wins when both are set):
//!
//! | variable | effect |
//! |---|---|
//! | `CODEG_TOKEN_FILE` | read the access token from this file (trimmed). Wins over `CODEG_TOKEN` and the persisted token, and is never persisted. `-` or `/dev/stdin` reads it from fd 0 (e.g. systemd `StandardInput=file:`), after which fd 0 is pointed at `/dev/null`. Unreadable or empty file = fatal. |
//! | `CODEG_PROJECTS_ROOT` | directory new projects are created in; `mkdir -p` at startup. |
//! | `CODEG_UPDATE_DISABLED` | truthy: self-update / update checks answer with an error. |
//! | `CODEG_COWORK_PORTAL` | truthy: the web UI runs behind the Cowork portal (account menu). |
//! | `CODEG_HOST`, `CODEG_PORT`, `CODEG_DATA_DIR`, `CODEG_STATIC_DIR` | upstream meaning; only the `COWORK_` alias is added. |
//! | `CODEG_LISTEN` / `COWORK_LISTEN` / `PASEO_LISTEN` | `host:port` fallback for whichever of host/port is still unset. |
//! | `CODEG_PUBLIC_ORIGIN` | portal mode: extra browser origins (comma-separated) allowed besides the request's own. |
//!
//! In portal mode `CODEG_BRIDGE_PORTS` defaults to `off` (the ports after
//! ours are the neighbouring employees' servers), and `/api` + `/ws` requests
//! from a foreign `Origin` are refused ([`origin_guard`]): nginx injects the
//! employee's token from the portal cookie, so authentication is ambient.
//!
//! After reading, the secrets are removed from the process environment so no
//! child (ACP agents, terminals, `codeg-mcp`, git helpers) inherits them:
//! `CODEG_TOKEN`, `CODEG_TOKEN_FILE`, every `COWORK_TOKEN*`, `PASEO_PASSWORD`,
//! `COWORK_PASSWORD`. When the token came from a file or any of those was set,
//! the process is also marked non-dumpable on Linux, so another process of the
//! same user (an agent) cannot read the server's `/proc/<pid>/environ` (which
//! still holds the original environment block) or its memory.
//!
//! The token is never printed when it is hidden ([`hide_token`]: cowork mode,
//! or supplied through `CODEG_TOKEN_FILE` / `CODEG_TOKEN`); in-place restarts
//! (self-update, restart, rollback) are refused when it came from a file,
//! since the stripped `CODEG_TOKEN_FILE` would not survive the re-exec.

use std::collections::{BTreeMap, HashMap};
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, OnceLock};

use axum::{extract::Extension, routing::post, Json, Router};
use serde::{Deserialize, Serialize};

use crate::acp::types::ConnectionStatus;
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::models::FolderDetail;
use crate::web::shutdown::ShutdownSignal;

/// User-visible product name reported to the web UI.
pub const PRODUCT_NAME: &str = "Cowork";

/// What the web UI shows in place of the real token (settings page) and what
/// the SSO'd browser sends; Cowork's nginx overwrites it with the real one.
pub const SSO_PLACEHOLDER_TOKEN: &str = "cowork-sso";

/// Variables with a `COWORK_` alias.
const ALIASED: &[&str] = &[
    "HOST",
    "PORT",
    "DATA_DIR",
    "STATIC_DIR",
    "PROJECTS_ROOT",
    "TOKEN_FILE",
    "UPDATE_DISABLED",
    "PUBLIC_ORIGIN",
];

/// Exact names removed from the process environment after startup.
const SECRET_VARS: &[&str] = &[
    "CODEG_TOKEN",
    "CODEG_TOKEN_FILE",
    "PASEO_PASSWORD",
    "COWORK_PASSWORD",
];

/// Name prefixes removed from the process environment after startup.
const SECRET_PREFIXES: &[&str] = &["COWORK_TOKEN"];

/// Where the access token came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenSource {
    /// `CODEG_TOKEN_FILE` (or its alias).
    File,
    /// `CODEG_TOKEN`.
    Env,
    /// Neither: upstream behavior (persisted or generated).
    Default,
}

/// Cowork settings resolved once at startup.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CoworkSettings {
    pub projects_root: Option<PathBuf>,
    pub portal: bool,
    pub update_disabled: bool,
    /// `CODEG_PUBLIC_ORIGIN`: extra allowed browser origins (normalized).
    pub public_origins: Vec<String>,
    token_file: Option<String>,
    env_token: Option<String>,
}

struct Resolved {
    settings: CoworkSettings,
    token: Option<String>,
    source: TokenSource,
}

static RESOLVED: OnceLock<Resolved> = OnceLock::new();

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

/// `1`, `true`, `yes`, `on` (any case) — anything else, unset included, is no.
pub fn truthy(value: Option<&str>) -> bool {
    value.is_some_and(|v| {
        matches!(
            v.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes" | "on"
        )
    })
}

/// `CODEG_<key>`, else `COWORK_<key>`, empty treated as unset.
fn lookup(env: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    non_empty(env(&format!("CODEG_{key}"))).or_else(|| non_empty(env(&format!("COWORK_{key}"))))
}

/// Split a `host:port` (`[::1]:6801` too) listen address.
pub fn split_listen(listen: &str) -> Option<(String, u16)> {
    let (host, port) = listen.trim().rsplit_once(':')?;
    let port = port.parse::<u16>().ok()?;
    let host = host.trim_start_matches('[').trim_end_matches(']');
    if host.is_empty() {
        return None;
    }
    Some((host.to_string(), port))
}

/// The `CODEG_<X>` values the alias / listen rules add, as (name, value)
/// pairs to export. Pure so it can be tested without touching the process env.
pub fn alias_exports(env: &dyn Fn(&str) -> Option<String>) -> Vec<(String, String)> {
    let mut out = Vec::new();
    for key in ALIASED {
        let codeg = format!("CODEG_{key}");
        if non_empty(env(&codeg)).is_none() {
            if let Some(value) = non_empty(env(&format!("COWORK_{key}"))) {
                out.push((codeg, value));
            }
        }
    }
    let have = |name: &str| non_empty(env(name)).is_some() || out.iter().any(|(n, _)| n == name);
    let listen = ["CODEG_LISTEN", "COWORK_LISTEN", "PASEO_LISTEN"]
        .iter()
        .find_map(|name| non_empty(env(name)))
        .and_then(|l| split_listen(&l));
    let (have_host, have_port) = (have("CODEG_HOST"), have("CODEG_PORT"));
    if let Some((host, port)) = listen {
        if !have_host {
            out.push(("CODEG_HOST".to_string(), host));
        }
        if !have_port {
            out.push(("CODEG_PORT".to_string(), port.to_string()));
        }
    }
    out
}

/// Variables portal mode sets when the operator left them unset: the dev-server
/// port bridge is off, because by default it claims the 10 ports after ours,
/// and in Cowork those are the neighbouring employees' servers (a bridge that
/// grabs one while its owner restarts keeps that owner from binding).
pub fn portal_env_defaults(
    env: &dyn Fn(&str) -> Option<String>,
    portal: bool,
) -> Vec<(String, String)> {
    let mut out = Vec::new();
    if portal
        && env("CODEG_BRIDGE_PORTS").is_none()
        && non_empty(env("CODEG_BRIDGE_HOST_PATTERN")).is_none()
    {
        out.push(("CODEG_BRIDGE_PORTS".to_string(), "off".to_string()));
    }
    out
}

/// `codeg-server --supervise` (the upstream Docker supervisor) returns before
/// [`init_process_env`]: it keeps its environment and stays dumpable, and a
/// stdin token could be read only once. So refuse it whenever Cowork secrets
/// or cowork mode are configured; with a plain `CODEG_TOKEN` (upstream Docker)
/// it runs, but non-dumpable so agents cannot read its `/proc/<pid>/environ`.
pub fn supervise_preflight() -> Result<(), String> {
    let env = |k: &str| std::env::var(k).ok();
    let secret: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| is_secret_var(k) && k != "CODEG_TOKEN")
        .collect();
    let portal =
        truthy(env("CODEG_COWORK_PORTAL").as_deref()) || truthy(env("COWORK_PORTAL").as_deref());
    if portal || !secret.is_empty() {
        let mut what = secret;
        if portal {
            what.push("CODEG_COWORK_PORTAL".to_string());
        }
        return Err(format!(
            "--supervise is not supported with {}: run codeg-server directly (systemd restarts it)",
            what.join(", ")
        ));
    }
    if non_empty(env("CODEG_TOKEN")).is_some() {
        make_non_dumpable();
    }
    Ok(())
}

/// Resolve the Cowork settings from an environment lookup (after aliases have
/// been applied). Pure; relative projects roots are resolved against `cwd`.
pub fn resolve_settings(env: &dyn Fn(&str) -> Option<String>, cwd: &Path) -> CoworkSettings {
    let projects_root = lookup(env, "PROJECTS_ROOT").map(|root| {
        let root = PathBuf::from(root);
        let root = if root.is_absolute() {
            root
        } else {
            cwd.join(root)
        };
        normalize(&root)
    });
    CoworkSettings {
        projects_root,
        // `CODEG_COWORK_PORTAL`; `COWORK_PORTAL` is its alias.
        portal: truthy(env("CODEG_COWORK_PORTAL").as_deref())
            || truthy(env("COWORK_PORTAL").as_deref()),
        update_disabled: truthy(lookup(env, "UPDATE_DISABLED").as_deref()),
        public_origins: lookup(env, "PUBLIC_ORIGIN")
            .map(|raw| raw.split(',').filter_map(normalize_origin).collect())
            .unwrap_or_default(),
        token_file: lookup(env, "TOKEN_FILE"),
        env_token: non_empty(env("CODEG_TOKEN")),
    }
}

/// Lexically drop `.` and `..` components (no filesystem access).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for c in path.components() {
        match c {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn reads_stdin(path: &str) -> bool {
    path == "-" || path == "/dev/stdin" || path == "/dev/fd/0" || path == "/proc/self/fd/0"
}

/// Read and trim a token from `path` (`-` / `/dev/stdin` = fd 0).
pub fn read_token_file(path: &str) -> Result<String, String> {
    let raw = if reads_stdin(path) {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
            .map_err(|e| format!("cannot read the access token from stdin: {e}"))?;
        buf
    } else {
        std::fs::read_to_string(path)
            .map_err(|e| format!("cannot read CODEG_TOKEN_FILE {path}: {e}"))?
    };
    let token = raw.trim().to_string();
    if token.is_empty() {
        return Err(format!("CODEG_TOKEN_FILE {path} is empty"));
    }
    Ok(token)
}

/// Whether `name` is one of the secrets stripped from the environment.
pub fn is_secret_var(name: &str) -> bool {
    SECRET_VARS.contains(&name) || SECRET_PREFIXES.iter().any(|p| name.starts_with(p))
}

/// Remove every secret variable from this process's environment, so children
/// spawned afterwards cannot inherit them. Returns the names removed.
///
/// Must run while the process is still single-threaded.
pub fn strip_secret_env() -> Vec<String> {
    let names: Vec<String> = std::env::vars_os()
        .filter_map(|(k, _)| k.into_string().ok())
        .filter(|k| is_secret_var(k))
        .collect();
    for name in &names {
        std::env::remove_var(name);
    }
    names
}

#[cfg(unix)]
fn detach_stdin() {
    // SAFETY: plain libc calls on fds we own; failure leaves fd 0 as it was.
    unsafe {
        let devnull = libc::open(c"/dev/null".as_ptr(), libc::O_RDONLY | libc::O_CLOEXEC);
        if devnull >= 0 {
            libc::dup2(devnull, 0);
            libc::close(devnull);
        }
    }
}

#[cfg(not(unix))]
fn detach_stdin() {}

#[cfg(target_os = "linux")]
fn make_non_dumpable() {
    // Same-user processes (the agents this server spawns) can otherwise read
    // `/proc/<server pid>/environ` and `/proc/<server pid>/mem`. Not inherited
    // across exec, so children are unaffected.
    // SAFETY: prctl(PR_SET_DUMPABLE) has no memory-safety preconditions.
    let rc = unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) };
    if rc != 0 {
        eprintln!(
            "[cowork] WARN: prctl(PR_SET_DUMPABLE, 0) failed: {}",
            std::io::Error::last_os_error()
        );
    }
}

#[cfg(not(target_os = "linux"))]
fn make_non_dumpable() {}

/// One-shot startup for `codeg-server`: apply `COWORK_*` aliases, read the
/// token file, create the projects root, strip secrets from the environment.
///
/// Call from `main` before any thread is spawned and before anything else
/// reads `CODEG_*`. An `Err` is fatal (fail closed: a configured token file
/// that cannot be read must not fall back to a generated token).
pub fn init_process_env() -> Result<(), String> {
    let env = |k: &str| std::env::var(k).ok();
    for (name, value) in alias_exports(&env) {
        std::env::set_var(name, value);
    }
    let cwd = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("/"));
    let mut settings = resolve_settings(&env, &cwd);
    // The token is kept once, in `Resolved::token`, not in the settings that
    // `settings()` hands out.
    let env_token = settings.env_token.take();

    let (token, source) = match settings.token_file.as_deref() {
        Some(path) => {
            let token = read_token_file(path)?;
            if reads_stdin(path) {
                detach_stdin();
            }
            (Some(token), TokenSource::File)
        }
        None => match env_token {
            Some(t) => (Some(t), TokenSource::Env),
            None => (None, TokenSource::Default),
        },
    };

    for (name, value) in portal_env_defaults(&env, settings.portal) {
        std::env::set_var(name, value);
    }

    if let Some(root) = settings.projects_root.as_deref() {
        std::fs::create_dir_all(root)
            .map_err(|e| format!("cannot create CODEG_PROJECTS_ROOT {}: {e}", root.display()))?;
    }

    let stripped = strip_secret_env();
    // The original environment block stays readable at /proc/<pid>/environ
    // after `remove_var`; hide it (and our memory) from same-user processes
    // whenever it held a secret or the token came from a file.
    if source == TokenSource::File || !stripped.is_empty() {
        make_non_dumpable();
    }

    let _ = RESOLVED.set(Resolved {
        settings,
        token,
        source,
    });
    Ok(())
}

fn resolved() -> Option<&'static Resolved> {
    RESOLVED.get()
}

/// Settings resolved by [`init_process_env`]; defaults (all off) when it never
/// ran (desktop app, tests).
pub fn settings() -> CoworkSettings {
    resolved().map(|r| r.settings.clone()).unwrap_or_default()
}

/// The token override for `resolve_persisted_server_token`: the token file's
/// content, else `CODEG_TOKEN` (captured before it was stripped). Falls back to
/// reading `CODEG_TOKEN` when [`init_process_env`] never ran.
pub fn token_override() -> Option<String> {
    match resolved() {
        Some(r) => r.token.clone(),
        None => std::env::var("CODEG_TOKEN").ok(),
    }
}

/// Where the token came from (for startup logging).
pub fn token_source() -> TokenSource {
    resolved().map(|r| r.source).unwrap_or(TokenSource::Default)
}

/// What `codeg-server` prints for the token on stderr at startup: never the
/// value when it is hidden (cowork mode, or supplied by the operator).
pub fn token_for_log(token: &str) -> String {
    if hide_token() {
        "(hidden)".to_string()
    } else {
        token.to_string()
    }
}

/// One info line with the resolved Cowork settings (never the token).
pub fn log_startup() {
    let Some(r) = resolved() else { return };
    let s = &r.settings;
    if s.projects_root.is_none() && !s.portal && !s.update_disabled && r.source != TokenSource::File
    {
        return;
    }
    tracing::info!(
        "[cowork] projects_root={} portal={} update_disabled={} token_source={:?}",
        s.projects_root
            .as_deref()
            .map(|p| p.display().to_string())
            .unwrap_or_else(|| "-".into()),
        s.portal,
        s.update_disabled,
        r.source
    );
}

// ---- 优雅停机 ----

/// 正在跑 turn 的连接 ID。看每个连接的 `SessionState.status`：v0.40 起 `list_connections()` 回的 `AgentConnection.status`
/// 是建连接时的值（`Connecting`），之后不再更新，拿它筛 `Prompting` 永远是空的。
async fn prompting_connections(cm: &crate::acp::manager::ConnectionManager) -> Vec<String> {
    let mut out = Vec::new();
    for c in cm.list_connections().await {
        if let Some(st) = cm.get_state(&c.id).await {
            if st.read().await.status == ConnectionStatus::Prompting {
                out.push(c.id);
            }
        }
    }
    out
}

/// Cowork 升级 / `systemctl restart codeg@…` 时 systemd 发 SIGTERM。上游的 server 直接退出，正在跑的 turn 没头没尾地断在
/// transcript 里，重连后要靠事后收敛。这里：先对每个 `prompting` 的连接发 cancel（和用户点「停止」一样，行记成 cancelled），
/// 等 agent 应答最多 5 秒，再 `disconnect_all`（它自带 500ms 宽限和兜底 kill 进程树），最后触发 WebSocket 任务退出、
/// axum 停收新连接。给 `axum::serve(...).with_graceful_shutdown`。
/// 兜底：触发后 8 秒还没退就 `process::exit(0)`（systemd 单元那边另有 TimeoutStopSec）。
pub async fn graceful_shutdown(state: Arc<AppState>, shutdown: Arc<ShutdownSignal>) {
    wait_for_stop_signal().await;
    tracing::info!("[cowork] stop signal: cancelling running turns, disconnecting agents");
    let cm = &state.connection_manager;
    let prompting = prompting_connections(cm).await;
    for id in &prompting {
        if let Err(e) = cm.cancel(&state.db.conn, id).await {
            tracing::warn!("[cowork] cancel {id} on shutdown: {e}");
        }
    }
    if !prompting.is_empty() {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while std::time::Instant::now() < deadline {
            if prompting_connections(cm).await.is_empty() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        }
    }
    let n = cm.disconnect_all().await;
    tracing::info!(
        "[cowork] stop: cancelled {} turn(s), disconnected {n} agent connection(s)",
        prompting.len()
    );
    shutdown.trigger();
    tokio::spawn(async {
        tokio::time::sleep(std::time::Duration::from_secs(8)).await;
        tracing::warn!("[cowork] stop: connections still open after 8s, exiting anyway");
        std::process::exit(0);
    });
}

async fn wait_for_stop_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};
        let mut term = signal(SignalKind::terminate()).expect("install SIGTERM handler");
        let mut int = signal(SignalKind::interrupt()).expect("install SIGINT handler");
        let mut hup = signal(SignalKind::hangup()).expect("install SIGHUP handler");
        tokio::select! {
            _ = term.recv() => {}
            _ = int.recv() => {}
            _ = hup.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// Error for every self-update entry point when `CODEG_UPDATE_DISABLED` is on.
pub fn update_disabled_error() -> AppCommandError {
    AppCommandError::permission_denied(
        "Updates are disabled on this server (CODEG_UPDATE_DISABLED): Cowork manages the codeg version",
    )
}

/// `Err` when updates are disabled; call first in each update handler.
pub fn ensure_update_allowed() -> Result<(), AppCommandError> {
    if settings().update_disabled {
        Err(update_disabled_error())
    } else {
        Ok(())
    }
}

/// `Err` for anything that re-execs the server (update, restart, rollback):
/// updates disabled, or the token came from `CODEG_TOKEN_FILE` / `CODEG_TOKEN`,
/// which were stripped from the environment and so would be lost by a re-exec
/// (the new image would fall back to another token: lockout). Under the
/// upstream supervisor a restart is a relaunch with the supervisor's own
/// environment, which still holds `CODEG_TOKEN`, so that case is allowed.
pub fn ensure_reexec_allowed() -> Result<(), AppCommandError> {
    ensure_update_allowed()?;
    reexec_allowed_for(token_source(), crate::update::runtime::is_supervised())
}

fn reexec_allowed_for(source: TokenSource, supervised: bool) -> Result<(), AppCommandError> {
    match source {
        TokenSource::File => Err(AppCommandError::permission_denied(
            "Restarting in place is disabled when the token comes from CODEG_TOKEN_FILE; restart the service instead",
        )),
        TokenSource::Env if !supervised => Err(AppCommandError::permission_denied(
            "Restarting in place is disabled when the token comes from CODEG_TOKEN (it is removed from the environment at startup); restart the service instead",
        )),
        _ => Ok(()),
    }
}

/// Whether the web UI may offer an in-place self-update.
pub fn self_update_allowed() -> bool {
    ensure_reexec_allowed().is_ok()
}

// ─── HTTP API ────────────────────────────────────────────────────────────

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoworkInfo {
    pub product: String,
    pub projects_root: Option<String>,
    pub portal: bool,
    pub update_disabled: bool,
}

impl From<&CoworkSettings> for CoworkInfo {
    fn from(s: &CoworkSettings) -> Self {
        Self {
            product: PRODUCT_NAME.to_string(),
            projects_root: s
                .projects_root
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            portal: s.portal,
            update_disabled: s.update_disabled,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateProjectParams {
    pub name: String,
}

/// Validate a project name: one plain path component.
pub fn validate_project_name(name: &str) -> Result<&str, AppCommandError> {
    let name = name.trim();
    if name.is_empty() {
        return Err(AppCommandError::invalid_input("Project name is empty"));
    }
    if name.starts_with('.') {
        // Also covers "." and "..": no hidden directories (".git", ".ssh"
        // when the root is $HOME).
        return Err(AppCommandError::invalid_input(
            "Project name cannot start with \".\"",
        ));
    }
    if name.contains(['/', '\\']) {
        return Err(AppCommandError::invalid_input(
            "Project name cannot contain path separators",
        ));
    }
    if name.chars().any(|c| c.is_control()) {
        return Err(AppCommandError::invalid_input(
            "Project name cannot contain control characters",
        ));
    }
    if name.len() > 255 {
        return Err(AppCommandError::invalid_input("Project name is too long"));
    }
    Ok(name)
}

/// `i18n_key` of the "a project with this name already exists" error (its
/// `name` param is the project name). The web UI matches it to show its own
/// localized message; keep in sync with `PROJECT_EXISTS_I18N_KEY` in
/// `src/lib/cowork/info.ts`.
pub const PROJECT_EXISTS_I18N_KEY: &str = "cowork.projectExists";

/// Create `<root>/<name>` and return its path. `Ok` means this call created
/// the directory: anything already there is an `already_exists` error (HTTP
/// 409) and is left alone — an existing project directory (the error carries
/// [`PROJECT_EXISTS_I18N_KEY`]) as much as a file or a symlink, even one to a
/// directory. The result must resolve inside the root.
pub fn prepare_project_dir(root: &Path, name: &str) -> Result<PathBuf, AppCommandError> {
    let name = validate_project_name(name)?;
    std::fs::create_dir_all(root).map_err(AppCommandError::io)?;
    let dir = root.join(name);
    match std::fs::create_dir(&dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            let real_dir = std::fs::symlink_metadata(&dir)
                .map(|m| m.file_type().is_dir())
                .unwrap_or(false);
            if !real_dir {
                return Err(AppCommandError::already_exists(format!(
                    "{} already exists and is not a directory",
                    dir.display()
                )));
            }
            // Never reuse it silently: the caller asked for a new project and
            // would end up in somebody's existing files.
            return Err(AppCommandError::already_exists(format!(
                "A project named \"{name}\" already exists"
            ))
            .with_i18n(
                PROJECT_EXISTS_I18N_KEY,
                BTreeMap::from([("name".to_string(), name.to_string())]),
            ));
        }
        Err(e) => return Err(AppCommandError::io(e)),
    }
    let canon_root = std::fs::canonicalize(root).map_err(AppCommandError::io)?;
    let canon_dir = std::fs::canonicalize(&dir).map_err(AppCommandError::io)?;
    if canon_dir.parent() != Some(canon_root.as_path()) {
        return Err(AppCommandError::invalid_input(format!(
            "{} is outside the projects root",
            dir.display()
        )));
    }
    Ok(dir)
}

pub async fn cowork_info() -> Json<CoworkInfo> {
    Json(CoworkInfo::from(&settings()))
}

// A new project is a git repository from the start (branch `main`, one empty
// first commit), so `git rev-parse HEAD`, tasks and worktrees work right away.

/// How long the git bootstrap of a new project may take before it is given
/// up (a hook or a prompt waiting for a terminal that is not there).
const PROJECT_GIT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// The name of the system user this server runs as.
fn os_user_name() -> Option<String> {
    ["USER", "LOGNAME", "USERNAME"]
        .iter()
        .find_map(|name| non_empty(std::env::var(name).ok()))
}

/// The Cowork domain, when `request_host` (`Host` / `X-Forwarded-Host`, port
/// allowed) is this employee's own subdomain `<employee>.<domain>`.
fn employee_domain(employee: &str, request_host: &str) -> Option<String> {
    let lower = request_host.trim().to_ascii_lowercase();
    let host = match lower.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) => host,
        _ => lower.as_str(),
    };
    let prefix = employee.to_ascii_lowercase();
    let domain = host.strip_prefix(prefix.as_str())?.strip_prefix('.')?;
    let labels_ok = domain
        .split('.')
        .all(|l| !l.is_empty() && l.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'));
    // A numeric last label is an IP address, not a domain.
    let named = domain
        .rsplit('.')
        .next()
        .is_some_and(|tld| tld.chars().any(|c| c.is_ascii_alphabetic()));
    (labels_ok && named).then(|| domain.to_string())
}

/// Author `(name, email)` for the first commit of a new project when git has
/// no identity of its own for it. Cowork's system users are `cw-<employee>`
/// and each employee is served at `<employee>.<domain>`, so a request that
/// came in through that subdomain gives `<employee>` / `<employee>@<domain>`
/// (what the Cowork platform configures in shared projects). Otherwise (a
/// call on 127.0.0.1, not a Cowork deployment) it is the system user and
/// `<user>@localhost`.
pub fn fallback_git_identity(os_user: Option<&str>, request_hosts: &[&str]) -> (String, String) {
    let user = os_user
        .map(str::trim)
        .filter(|u| {
            !u.is_empty()
                && u.chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.'))
        })
        .unwrap_or("cowork");
    let employee = user
        .strip_prefix("cw-")
        .filter(|name| !name.is_empty())
        .unwrap_or(user);
    let domain = request_hosts
        .iter()
        .find_map(|host| employee_domain(employee, host));
    match domain {
        Some(domain) => (employee.to_string(), format!("{employee}@{domain}")),
        None => (user.to_string(), format!("{user}@localhost")),
    }
}

/// One git command in a new project's directory, spawned like the other git
/// helpers (`commands/folders.rs`). Never prompts or reads stdin, and dies
/// with the caller's timeout.
async fn project_git(dir: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    crate::process::tokio_command("git")
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(std::process::Stdio::null())
        .kill_on_drop(true)
        .output()
        .await
        .map_err(|e| format!("cannot run git: {e}"))
}

fn project_git_failure(step: &str, output: &std::process::Output) -> String {
    format!(
        "git {step} failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    )
}

/// `git init` on branch `main` plus one empty "Initial commit" in `dir`.
async fn init_project_repo(dir: &Path, fallback: &(String, String)) -> Result<(), String> {
    // `-b` needs git 2.28; older ones get HEAD pointed at `main` by hand.
    let init = project_git(dir, &["init", "-b", "main"]).await?;
    if !init.status.success() {
        let plain = project_git(dir, &["init"]).await?;
        if !plain.status.success() {
            return Err(project_git_failure("init", &plain));
        }
        let head = project_git(dir, &["symbolic-ref", "HEAD", "refs/heads/main"]).await?;
        if !head.status.success() {
            return Err(project_git_failure("symbolic-ref", &head));
        }
    }
    // The identity git already resolves for this directory is used as it is.
    // Only what is missing is filled in, for this one commit: no config file
    // is written.
    let mut args: Vec<String> = Vec::new();
    for (key, value) in [("user.name", &fallback.0), ("user.email", &fallback.1)] {
        let configured = project_git(dir, &["config", "--get", key]).await?;
        let resolved = configured.status.success()
            && !String::from_utf8_lossy(&configured.stdout)
                .trim()
                .is_empty();
        if !resolved {
            args.push("-c".to_string());
            args.push(format!("{key}={value}"));
        }
    }
    // Not signed: nobody is there to unlock a key, and the commit is ours.
    // No hooks either: a global pre-commit / commit-msg hook that turns this
    // empty commit down would leave the project without a HEAD.
    args.extend(
        [
            "-c",
            "commit.gpgsign=false",
            "commit",
            "--allow-empty",
            "--no-verify",
            "-m",
            "Initial commit",
        ]
        .map(String::from),
    );
    let argv: Vec<&str> = args.iter().map(String::as_str).collect();
    let commit = project_git(dir, &argv).await?;
    if !commit.status.success() {
        return Err(project_git_failure("commit", &commit));
    }
    Ok(())
}

/// Create the project directory ([`prepare_project_dir`]) and make it a git
/// repository. Git is best effort: when it is missing, fails or hangs, the
/// project is still created (a warning is logged, and the UI's "No branch"
/// menu still offers to initialize it).
async fn create_project_dir(
    root: &Path,
    name: &str,
    fallback: &(String, String),
) -> Result<PathBuf, AppCommandError> {
    // `Ok` = created by this call, so git never touches an existing directory.
    let dir = prepare_project_dir(root, name)?;
    match tokio::time::timeout(PROJECT_GIT_TIMEOUT, init_project_repo(&dir, fallback)).await {
        Ok(Ok(())) => {}
        Ok(Err(reason)) => tracing::warn!(
            "[cowork] new project {}: {reason}; created without a git repository or first commit",
            dir.display()
        ),
        Err(_) => tracing::warn!(
            "[cowork] new project {}: git did not finish in {}s; created without a git repository or first commit",
            dir.display(),
            PROJECT_GIT_TIMEOUT.as_secs()
        ),
    }
    Ok(dir)
}

pub async fn cowork_create_project(
    Extension(state): Extension<Arc<AppState>>,
    headers: axum::http::HeaderMap,
    Json(params): Json<CreateProjectParams>,
) -> Result<Json<FolderDetail>, AppCommandError> {
    let root = settings().projects_root.ok_or_else(|| {
        AppCommandError::configuration_missing("No projects root configured (CODEG_PROJECTS_ROOT)")
    })?;
    let hosts: Vec<&str> = ["host", "x-forwarded-host"]
        .iter()
        .filter_map(|name| first_header(&headers, name))
        .collect();
    let fallback = fallback_git_identity(os_user_name().as_deref(), &hosts);
    let dir = create_project_dir(&root, &params.name, &fallback).await?;
    let path = dir.to_string_lossy().into_owned();
    Ok(Json(
        crate::commands::folders::open_folder_core(&state.db, path).await?,
    ))
}

/// Cowork endpoints, merged into the authenticated `/api` router.
pub fn api_routes() -> Router {
    Router::new()
        .route("/cowork_info", post(cowork_info))
        .route("/cowork_create_project", post(cowork_create_project))
}

// ─── Secret redaction (cowork mode) ──────────────────────────────────────
//
// Behind the Cowork portal every authenticated browser of the employee can call
// the API, and the browser only ever holds the SSO placeholder token. So in
// cowork mode the read endpoints that would hand out secrets (the access token,
// agent env values, provider API keys) answer with [`REDACTED`] instead, and the
// matching write endpoints put the stored value back wherever the client echoes
// [`REDACTED`], so "load the form, change one field, save" keeps working.

/// Placeholder returned instead of a secret value in cowork mode.
pub const REDACTED: &str = "********";

/// Whether API responses must not carry secrets (cowork portal mode).
pub fn redact_enabled() -> bool {
    settings().portal
}

/// Name fragments that mark a secret, the same list upstream's own
/// `redact_secret` (commands/acp.rs) uses.
const SECRET_NEEDLES: &[&str] = &[
    "key",
    "token",
    "secret",
    "password",
    "passwd",
    "auth",
    "credential",
];

/// Env-style names that hold a secret: contains one of [`SECRET_NEEDLES`]
/// (any case).
pub fn is_secret_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    SECRET_NEEDLES.iter().any(|w| lower.contains(w))
}

/// Config-file (TOML / JSON) keys that hold a secret: as [`is_secret_key`],
/// minus keys that only *name* an env var (`env_key = "XAI_API_KEY"`) or pick
/// a kind of auth (`auth_mode = "chatgpt"`, `preferred_auth_method`,
/// `token_type`), which the settings UI reads.
fn is_secret_toml_key(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    is_secret_key(name)
        && !["env", "mode", "method", "type"]
            .iter()
            .any(|w| lower.contains(w))
}

/// Mask every non-empty secret value of an env map.
pub fn redact_env(env: &mut BTreeMap<String, String>) {
    for (k, v) in env.iter_mut() {
        if is_secret_key(k) && !v.is_empty() {
            *v = REDACTED.to_string();
        }
    }
}

fn placeholder_error(what: &str) -> AppCommandError {
    AppCommandError::invalid_input(format!(
        "{what} is the redaction placeholder \"{REDACTED}\" and there is no stored value to keep; enter the real value"
    ))
}

/// Where a [`REDACTED`] value coming back from the client is restored from.
#[derive(Debug, Default, Clone)]
pub struct SecretSource {
    /// The bound model provider's API key and the names it goes under (the
    /// agent's API-key env var, e.g. `ANTHROPIC_AUTH_TOKEN`, plus `apiKey` /
    /// `api_key`). Wins over the stored value: the settings UI copies the
    /// provider's (redacted) key into the agent's env and config when a
    /// provider is bound or re-bound, and the provider is authoritative then.
    pub provider_key: Option<(Vec<String>, String)>,
}

impl SecretSource {
    fn provider_value(&self, name: &str) -> Option<&str> {
        self.provider_key
            .as_ref()
            .filter(|(names, _)| names.iter().any(|n| n == name))
            .map(|(_, key)| key.as_str())
            .filter(|key| !key.is_empty())
    }
}

/// Put real values back where the client echoed [`REDACTED`]: the bound
/// provider's key for the agent's API-key name, else the stored value of the
/// same name. A placeholder with neither is refused, never persisted.
pub fn restore_env(
    incoming: BTreeMap<String, String>,
    current: Option<&BTreeMap<String, String>>,
    source: &SecretSource,
) -> Result<BTreeMap<String, String>, AppCommandError> {
    incoming
        .into_iter()
        .map(|(k, v)| {
            if v != REDACTED {
                return Ok((k, v));
            }
            let value = source
                .provider_value(&k)
                .or_else(|| {
                    current
                        .and_then(|c| c.get(&k))
                        .map(String::as_str)
                        .filter(|c| !c.is_empty() && *c != REDACTED)
                })
                .ok_or_else(|| placeholder_error(&format!("env {k}")))?;
            Ok((k, value.to_string()))
        })
        .collect()
}

/// `Some(REDACTED)` for a non-empty secret.
fn redact_opt(value: &mut Option<String>) {
    if value.as_deref().is_some_and(|v| !v.is_empty()) {
        *value = Some(REDACTED.to_string());
    }
}

/// An optional secret coming back from the client: [`REDACTED`] means "keep".
pub fn restore_opt(incoming: Option<String>, current: Option<&str>) -> Option<String> {
    match incoming {
        Some(v) if v == REDACTED => current.map(str::to_string),
        other => other,
    }
}

fn walk_toml(
    item: &mut toml_edit::Item,
    path: &mut Vec<String>,
    f: &mut dyn FnMut(&[String], &mut toml_edit::Item),
) {
    if let Some(table) = item.as_table_like_mut() {
        for (key, child) in table.iter_mut() {
            path.push(key.get().to_string());
            walk_toml(child, path, f);
            path.pop();
        }
    } else {
        f(path, item);
    }
}

fn walk_toml_doc(
    doc: &mut toml_edit::Document,
    f: &mut dyn FnMut(&[String], &mut toml_edit::Item),
) {
    let mut path = Vec::new();
    for (key, child) in doc.as_table_mut().iter_mut() {
        path.push(key.get().to_string());
        walk_toml(child, &mut path, f);
        path.pop();
    }
}

fn set_toml_string(item: &mut toml_edit::Item, value: &str) {
    if let Some(v) = item.as_value_mut() {
        let decor = v.decor().clone();
        *v = toml_edit::Value::from(value);
        *v.decor_mut() = decor;
    }
}

/// Mask string values under secret-looking keys of a TOML document (e.g.
/// `[model.x] api_key = "..."`). Unparseable text is returned unchanged.
pub fn redact_toml(text: &str) -> String {
    let Ok(mut doc) = text.parse::<toml_edit::Document>() else {
        return text.to_string();
    };
    let mut changed = false;
    walk_toml_doc(&mut doc, &mut |path, item| {
        let secret = path.last().is_some_and(|k| is_secret_toml_key(k));
        if secret && item.as_str().is_some_and(|s| !s.is_empty()) {
            set_toml_string(item, REDACTED);
            changed = true;
        }
    });
    if changed {
        doc.to_string()
    } else {
        text.to_string()
    }
}

/// The quoted placeholder in a text this module cannot parse.
fn contains_quoted_placeholder(text: &str) -> bool {
    text.contains(&format!("\"{REDACTED}\"")) || text.contains(&format!("'{REDACTED}'"))
}

/// Inverse of [`redact_toml`]: every string equal to [`REDACTED`] gets the
/// bound provider's key (for its key names), else the value at the same path
/// in `current`. A placeholder with neither is refused.
pub fn restore_toml(
    incoming: &str,
    current: Option<&str>,
    source: &SecretSource,
    what: &str,
) -> Result<String, AppCommandError> {
    if !incoming.contains(REDACTED) {
        return Ok(incoming.to_string());
    }
    let Ok(mut doc) = incoming.parse::<toml_edit::Document>() else {
        if contains_quoted_placeholder(incoming) {
            return Err(placeholder_error(what));
        }
        return Ok(incoming.to_string());
    };
    let mut stored: HashMap<Vec<String>, String> = HashMap::new();
    if let Some(Ok(mut cur)) = current.map(|c| c.parse::<toml_edit::Document>()) {
        walk_toml_doc(&mut cur, &mut |path, item| {
            if let Some(s) = item.as_str().filter(|s| *s != REDACTED) {
                stored.insert(path.to_vec(), s.to_string());
            }
        });
    }
    let mut missing: Option<String> = None;
    walk_toml_doc(&mut doc, &mut |path, item| {
        if item.as_str() == Some(REDACTED) {
            let leaf = path.last().map(String::as_str).unwrap_or_default();
            match source
                .provider_value(leaf)
                .or(stored.get(path).map(String::as_str))
            {
                Some(value) => set_toml_string(item, value),
                None => missing = Some(path.join(".")),
            }
        }
    });
    match missing {
        Some(path) => Err(placeholder_error(&format!("{what} {path}"))),
        None => Ok(doc.to_string()),
    }
}

fn walk_json(
    value: &mut serde_json::Value,
    path: &mut Vec<String>,
    f: &mut dyn FnMut(&[String], &mut serde_json::Value),
) {
    match value {
        serde_json::Value::Object(map) => {
            for (key, child) in map.iter_mut() {
                path.push(key.clone());
                walk_json(child, path, f);
                path.pop();
            }
        }
        serde_json::Value::Array(items) => {
            for (i, child) in items.iter_mut().enumerate() {
                path.push(i.to_string());
                walk_json(child, path, f);
                path.pop();
            }
        }
        _ => f(path, value),
    }
}

/// Mask string values under secret-looking keys of a JSON document (agent
/// config files: `env.ANTHROPIC_AUTH_TOKEN`, auth.json keys, ...). Text that is
/// not JSON, or has nothing to mask, is returned unchanged.
pub fn redact_json(text: &str) -> String {
    let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(text) else {
        return text.to_string();
    };
    let mut changed = false;
    walk_json(&mut doc, &mut Vec::new(), &mut |path, value| {
        let secret = path
            .last()
            .is_some_and(|k| k.parse::<usize>().is_err() && is_secret_toml_key(k));
        if secret && value.as_str().is_some_and(|s| !s.is_empty()) {
            *value = serde_json::Value::String(REDACTED.to_string());
            changed = true;
        }
    });
    if !changed {
        return text.to_string();
    }
    serde_json::to_string_pretty(&doc).unwrap_or_else(|_| text.to_string())
}

/// Inverse of [`redact_json`], with the same rules as [`restore_toml`].
pub fn restore_json(
    incoming: &str,
    current: Option<&str>,
    source: &SecretSource,
    what: &str,
) -> Result<String, AppCommandError> {
    if !incoming.contains(REDACTED) {
        return Ok(incoming.to_string());
    }
    let Ok(mut doc) = serde_json::from_str::<serde_json::Value>(incoming) else {
        if contains_quoted_placeholder(incoming) {
            return Err(placeholder_error(what));
        }
        return Ok(incoming.to_string());
    };
    let mut stored: HashMap<Vec<String>, String> = HashMap::new();
    if let Some(Ok(mut cur)) = current.map(serde_json::from_str::<serde_json::Value>) {
        walk_json(&mut cur, &mut Vec::new(), &mut |path, value| {
            if let Some(s) = value.as_str().filter(|s| *s != REDACTED) {
                stored.insert(path.to_vec(), s.to_string());
            }
        });
    }
    let mut changed = false;
    let mut missing: Option<String> = None;
    walk_json(&mut doc, &mut Vec::new(), &mut |path, value| {
        if value.as_str() == Some(REDACTED) {
            let leaf = path.last().map(String::as_str).unwrap_or_default();
            match source
                .provider_value(leaf)
                .or(stored.get(path).map(String::as_str))
            {
                Some(real) => {
                    *value = serde_json::Value::String(real.to_string());
                    changed = true;
                }
                None => missing = Some(path.join(".")),
            }
        }
    });
    if let Some(path) = missing {
        return Err(placeholder_error(&format!("{what} {path}")));
    }
    if !changed {
        return Ok(incoming.to_string());
    }
    serde_json::to_string_pretty(&doc)
        .map_err(|e| AppCommandError::invalid_input(format!("{what}: {e}")))
}

/// Redact one agent as returned by `acp_list_agents`.
pub fn redact_agent(info: &mut crate::acp::types::AcpAgentInfo) {
    redact_env(&mut info.env);
    if let Some(grok) = info.grok_settings.as_mut() {
        redact_opt(&mut grok.custom_api_key);
    }
    for toml in [&mut info.grok_config_toml, &mut info.codex_config_toml]
        .into_iter()
        .flatten()
    {
        *toml = redact_toml(toml);
    }
    for json in [
        &mut info.config_json,
        &mut info.codex_auth_json,
        &mut info.opencode_auth_json,
        &mut info.cursor_cli_config_json,
        &mut info.cline_secrets_json,
    ]
    .into_iter()
    .flatten()
    {
        *json = redact_json(json);
    }
}

/// `acp_list_agents` response filter.
pub fn redact_agents(
    mut agents: Vec<crate::acp::types::AcpAgentInfo>,
) -> Vec<crate::acp::types::AcpAgentInfo> {
    if redact_enabled() {
        agents.iter_mut().for_each(redact_agent);
    }
    agents
}

/// The stored (unredacted) settings of one agent, for the write paths.
pub async fn stored_agent(
    db: &crate::db::AppDatabase,
    agent_type: crate::models::agent::AgentType,
) -> Option<crate::acp::types::AcpAgentInfo> {
    crate::commands::acp::acp_list_agents_core(db)
        .await
        .ok()?
        .into_iter()
        .find(|a| a.agent_type == agent_type)
}

/// The agent's stored settings plus the restore source for its secrets.
/// `provider_id`: `Some(id)` is the provider the request binds (the
/// `acp_update_agent_env` parameter); `None` falls back to the stored binding.
async fn agent_restore_context(
    db: &crate::db::AppDatabase,
    agent_type: crate::models::agent::AgentType,
    provider_id: Option<Option<i32>>,
) -> (Option<crate::acp::types::AcpAgentInfo>, SecretSource) {
    let stored = stored_agent(db, agent_type).await;
    let pid = match provider_id {
        Some(explicit) => explicit,
        None => stored.as_ref().and_then(|a| a.model_provider_id),
    };
    let mut source = SecretSource::default();
    if let Some(pid) = pid {
        if let Ok(Some(provider)) =
            crate::db::service::model_provider_service::get_by_id(&db.conn, pid).await
        {
            let names = vec![
                crate::commands::acp::agent_env_keys(agent_type)
                    .1
                    .to_string(),
                "apiKey".to_string(),
                "api_key".to_string(),
            ];
            source.provider_key = Some((names, provider.api_key));
        }
    }
    (stored, source)
}

/// Everything `acp_update_agent_env` / `_preferences` / `_config` may write that
/// can carry an echoed [`REDACTED`], restored in place (cowork mode only).
#[derive(Default)]
pub struct AgentWrite<'a> {
    pub env: Option<&'a mut BTreeMap<String, String>>,
    pub config_json: Option<&'a mut Option<String>>,
    pub opencode_auth_json: Option<&'a mut Option<String>>,
    pub codex_auth_json: Option<&'a mut Option<String>>,
    pub codex_config_toml: Option<&'a mut Option<String>>,
    pub codex_model_catalog: Option<&'a mut Option<String>>,
    pub grok_config_toml: Option<&'a mut Option<String>>,
    pub grok_structured: Option<&'a mut Option<crate::acp::types::GrokStructuredConfig>>,
    pub cursor_cli_config_json: Option<&'a mut Option<String>>,
}

fn write_mentions_placeholder(w: &AgentWrite<'_>) -> bool {
    let text = |t: &Option<&mut Option<String>>| {
        t.as_deref()
            .and_then(Option::as_deref)
            .is_some_and(|s| s.contains(REDACTED))
    };
    w.env
        .as_deref()
        .is_some_and(|e| e.values().any(|v| v == REDACTED))
        || text(&w.config_json)
        || text(&w.opencode_auth_json)
        || text(&w.codex_auth_json)
        || text(&w.codex_config_toml)
        || text(&w.codex_model_catalog)
        || text(&w.grok_config_toml)
        || text(&w.cursor_cli_config_json)
        || w.grok_structured
            .as_deref()
            .and_then(Option::as_ref)
            .is_some_and(|s| s.custom_api_key.as_deref() == Some(REDACTED))
}

/// Restore every echoed [`REDACTED`] of an agent write from the bound provider
/// or the stored settings; `Err` (400) when one cannot be restored, so the
/// literal placeholder is never persisted. No-op outside cowork mode.
pub async fn restore_agent_write(
    db: &crate::db::AppDatabase,
    agent_type: crate::models::agent::AgentType,
    provider_id: Option<Option<i32>>,
    mut w: AgentWrite<'_>,
) -> Result<(), AppCommandError> {
    if !redact_enabled() || !write_mentions_placeholder(&w) {
        return Ok(());
    }
    let (stored, source) = agent_restore_context(db, agent_type, provider_id).await;
    let stored = stored.as_ref();
    if let Some(env) = w.env.take() {
        let incoming = std::mem::take(env);
        *env = restore_env(incoming, stored.map(|a| &a.env), &source)?;
    }
    type Pick = fn(&crate::acp::types::AcpAgentInfo) -> Option<&String>;
    let json_fields: [(&str, Option<&mut Option<String>>, Pick); 4] = [
        ("configJson", w.config_json.take(), |a| {
            a.config_json.as_ref()
        }),
        ("opencodeAuthJson", w.opencode_auth_json.take(), |a| {
            a.opencode_auth_json.as_ref()
        }),
        ("codexAuthJson", w.codex_auth_json.take(), |a| {
            a.codex_auth_json.as_ref()
        }),
        (
            "cursorCliConfigJson",
            w.cursor_cli_config_json.take(),
            |a| a.cursor_cli_config_json.as_ref(),
        ),
    ];
    for (what, field, pick) in json_fields {
        if let Some(Some(text)) = field {
            let current = stored.and_then(pick).map(String::as_str);
            *text = restore_json(text, current, &source, what)?;
        }
    }
    let toml_fields: [(&str, Option<&mut Option<String>>, Pick); 2] = [
        ("codexConfigToml", w.codex_config_toml.take(), |a| {
            a.codex_config_toml.as_ref()
        }),
        ("grokConfigToml", w.grok_config_toml.take(), |a| {
            a.grok_config_toml.as_ref()
        }),
    ];
    for (what, field, pick) in toml_fields {
        if let Some(Some(text)) = field {
            let current = stored.and_then(pick).map(String::as_str);
            *text = restore_toml(text, current, &source, what)?;
        }
    }
    if let Some(Some(text)) = w.codex_model_catalog.take() {
        if contains_quoted_placeholder(text) {
            return Err(placeholder_error("codexModelCatalog"));
        }
    }
    if let Some(Some(structured)) = w.grok_structured.take() {
        if structured.custom_api_key.as_deref() == Some(REDACTED) {
            let current = stored
                .and_then(|a| a.grok_settings.as_ref())
                .and_then(|g| g.custom_api_key.as_deref())
                .filter(|k| !k.is_empty());
            match current {
                Some(key) => structured.custom_api_key = Some(key.to_string()),
                None => return Err(placeholder_error("grokStructured.customApiKey")),
            }
        }
    }
    Ok(())
}

/// The API key a Cursor / Qoder settings probe sends: the panel shows the
/// stored key as [`REDACTED`], which means "use the stored one" (`None`).
pub fn probe_key(api_key: Option<String>) -> Option<String> {
    api_key.filter(|k| !(redact_enabled() && k.trim() == REDACTED))
}

/// `Err` (403) in portal mode for endpoints that hand out codeg.db or the
/// stored secrets wholesale (config export / WebDAV upload / backup download):
/// they would undo the redaction above in one call.
pub fn ensure_not_portal(what: &str) -> Result<(), AppCommandError> {
    if redact_enabled() {
        Err(AppCommandError::permission_denied(format!(
            "{what} is disabled behind the Cowork portal: it would export the stored API keys"
        )))
    } else {
        Ok(())
    }
}

/// `list_model_providers` / `update_model_provider` response filter:
/// `api_key` is masked, `api_key_masked` stays as upstream computes it.
pub fn redact_model_provider(
    mut info: crate::models::model_provider::ModelProviderInfo,
) -> crate::models::model_provider::ModelProviderInfo {
    if redact_enabled() && !info.api_key.is_empty() {
        info.api_key = REDACTED.to_string();
    }
    info
}

/// `api_key` sent to `update_model_provider`: [`REDACTED`] means unchanged.
pub fn restore_provider_key(api_key: Option<String>) -> Option<String> {
    api_key.filter(|k| !(redact_enabled() && k == REDACTED))
}

/// `api_key` sent to `create_model_provider`: [`REDACTED`] is not a key.
pub fn check_new_provider_key(api_key: &str) -> Result<(), AppCommandError> {
    if redact_enabled() && api_key == REDACTED {
        Err(AppCommandError::invalid_input(
            "The API key is the redaction placeholder; enter the real key",
        ))
    } else {
        Ok(())
    }
}

// ─── Origin check (portal mode) ──────────────────────────────────────────
//
// Behind the portal, nginx swaps the browser's placeholder for the employee's
// real token based on the portal cookie, which the browser also sends from
// sibling subdomains (same-site). Without this check a page on any of them
// could open /ws/events or POST to /api as the employee. Requests without an
// `Origin` (curl, cowork-root's server-side calls on 127.0.0.1) pass.

/// `scheme://host[:port]`, lowercase, default port dropped; `None` when it is
/// not an http(s)/ws(s) origin (`null`, garbage).
pub fn normalize_origin(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/');
    let (scheme, authority) = raw.split_once("://")?;
    let scheme = scheme.to_ascii_lowercase();
    let default_port = match scheme.as_str() {
        "http" | "ws" => "80",
        "https" | "wss" => "443",
        _ => return None,
    };
    let authority = authority.to_ascii_lowercase();
    if authority.is_empty() || authority.contains(['/', '@', '?', '#', ' ']) {
        return None;
    }
    // Split the port off, minding IPv6 literals ("[::1]:8080").
    let (host, port) = match authority.rfind(':') {
        Some(i) if !authority[i..].contains(']') => (&authority[..i], Some(&authority[i + 1..])),
        _ => (authority.as_str(), None),
    };
    if host.is_empty() {
        return None;
    }
    let scheme = match scheme.as_str() {
        "ws" => "http",
        "wss" => "https",
        other => other,
    };
    match port {
        Some(p) if !p.is_empty() && p != default_port => {
            p.parse::<u16>().ok()?;
            Some(format!("{scheme}://{host}:{p}"))
        }
        _ => Some(format!("{scheme}://{host}")),
    }
}

fn first_header<'a>(headers: &'a axum::http::HeaderMap, name: &str) -> Option<&'a str> {
    headers
        .get(name)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next())
        .map(str::trim)
        .filter(|v| !v.is_empty())
}

/// Whether a request may reach `/api` or `/ws` in portal mode. Its `Origin`
/// must be the request's own (scheme from `X-Forwarded-Proto`, else http;
/// host from `Host` or `X-Forwarded-Host`) or one of `extra` (normalized
/// `CODEG_PUBLIC_ORIGIN`). Without `Origin` it passes unless
/// `Sec-Fetch-Site` says the request comes from another site.
pub fn origin_allowed(headers: &axum::http::HeaderMap, extra: &[String]) -> Result<(), String> {
    let Some(origin) = headers.get(axum::http::header::ORIGIN) else {
        return match first_header(headers, "sec-fetch-site") {
            Some(site @ ("cross-site" | "same-site")) => Err(format!("Sec-Fetch-Site {site}")),
            _ => Ok(()),
        };
    };
    let origin_str = origin.to_str().unwrap_or("");
    let Some(origin) = normalize_origin(origin_str) else {
        return Err(format!("Origin {origin_str:?}"));
    };
    if extra.contains(&origin) {
        return Ok(());
    }
    let proto = first_header(headers, "x-forwarded-proto").unwrap_or("http");
    let own = [
        first_header(headers, "host"),
        first_header(headers, "x-forwarded-host"),
    ];
    if own
        .into_iter()
        .flatten()
        .filter_map(|host| normalize_origin(&format!("{proto}://{host}")))
        .any(|o| o == origin)
    {
        Ok(())
    } else {
        Err(format!("Origin {origin}"))
    }
}

fn guarded_path(path: &str) -> bool {
    ["/api", "/ws"]
        .iter()
        .any(|p| path == *p || path.starts_with(&format!("{p}/")))
}

/// Router middleware: in portal mode, 403 for `/api` and `/ws` requests from a
/// foreign origin (see [`origin_allowed`]). A no-op otherwise.
pub async fn origin_guard(
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    use axum::response::IntoResponse;
    let s = settings();
    if s.portal && guarded_path(req.uri().path()) {
        if let Err(reason) = origin_allowed(req.headers(), &s.public_origins) {
            tracing::warn!(
                "[cowork] refused cross-origin request to {} ({reason})",
                req.uri().path()
            );
            return (
                axum::http::StatusCode::FORBIDDEN,
                Json(serde_json::json!({
                    "code": "permission_denied",
                    "message": "Cross-origin request refused",
                })),
            )
                .into_response();
        }
    }
    next.run(req).await
}

/// Whether the access token must be hidden from API responses and logs: in
/// cowork mode, and whenever the operator supplied it (file or env).
pub fn hide_token() -> bool {
    redact_enabled() || token_source() != TokenSource::Default
}

/// `get_web_server_status` response filter.
pub fn redact_web_server_info(
    info: Option<crate::web::WebServerInfo>,
) -> Option<crate::web::WebServerInfo> {
    info.map(|mut i| {
        if hide_token() {
            i.token = SSO_PLACEHOLDER_TOKEN.to_string();
        }
        i
    })
}

/// `get_web_service_config` / `update_web_service_config` response filter
/// (the persisted desktop token).
pub fn redact_web_service_config(
    mut config: crate::web::WebServiceConfig,
) -> crate::web::WebServiceConfig {
    if hide_token() {
        redact_opt(&mut config.token);
    }
    config
}

/// Whether a token sent to `update_web_service_config` is one of the two
/// placeholders the read endpoints answer with instead of a real token:
/// [`REDACTED`] (the persisted token) or [`SSO_PLACEHOLDER_TOKEN`] (the status
/// response, which the settings page copies into its token field and saves
/// back without anyone editing it).
pub fn is_web_token_placeholder(token: Option<&str>) -> bool {
    token.is_some_and(|t| {
        let t = t.trim();
        t == REDACTED || t == SSO_PLACEHOLDER_TOKEN
    })
}

/// A placeholder coming back from the client means "keep": it is never what
/// gets stored.
fn keep_web_token(incoming: Option<String>, current: Option<&str>) -> Option<String> {
    if is_web_token_placeholder(incoming.as_deref()) {
        current.map(str::to_string)
    } else {
        incoming
    }
}

/// `update_web_service_config` input: an echoed placeholder (see
/// [`is_web_token_placeholder`]) keeps the persisted token.
pub fn restore_web_service_token(
    incoming: Option<String>,
    current: Option<&str>,
) -> Option<String> {
    if hide_token() {
        keep_web_token(incoming, current)
    } else {
        incoming
    }
}

// ─── Data file permissions ───────────────────────────────────────────────

/// Keep `codeg.db` (agent env, provider keys, tokens) private to the user:
/// create it 0600 before SQLite opens it (SQLite gives `-wal` / `-shm` the
/// main file's mode) and tighten any existing file. Call before and after
/// `db::init_database` (a pending backup restore swaps the file in).
#[cfg(unix)]
pub fn secure_db_files(data_dir: &Path) {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let name = crate::db::database_file_name();
    let db = data_dir.join(name);
    if std::fs::create_dir_all(data_dir).is_ok() && !db.exists() {
        let _ = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&db);
    }
    for suffix in ["", "-wal", "-shm", "-journal"] {
        let path = data_dir.join(format!("{name}{suffix}"));
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.permissions().mode() & 0o077 != 0 {
                let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
            }
        }
    }
}

#[cfg(not(unix))]
pub fn secure_db_files(_data_dir: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use std::collections::HashMap;

    // 停机找「正在跑的 turn」要看 SessionState：list_connections() 的状态是建连接时的值，不跟着变
    #[tokio::test]
    async fn prompting_connections_reads_live_session_state() {
        use crate::acp::manager::ConnectionManager;
        use crate::models::agent::AgentType;
        use crate::web::event_bridge::EventEmitter;
        let cm = ConnectionManager::new();
        for id in ["busy", "idle"] {
            cm.insert_test_connection(id, AgentType::ClaudeCode, None, EventEmitter::Noop)
                .await;
        }
        let busy = cm.get_state("busy").await.unwrap();
        busy.write().await.status = ConnectionStatus::Prompting;

        assert!(cm
            .list_connections()
            .await
            .iter()
            .all(|c| c.status != ConnectionStatus::Prompting));
        assert_eq!(prompting_connections(&cm).await, vec!["busy".to_string()]);
    }

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k: &str| map.get(k).cloned()
    }

    #[test]
    fn cowork_aliases_fill_unset_codeg_vars_only() {
        let env = env_of(&[
            ("COWORK_PORT", "6801"),
            ("CODEG_HOST", "127.0.0.1"),
            ("COWORK_HOST", "0.0.0.0"),
            ("COWORK_DATA_DIR", "/home/x/.codeg"),
            ("CODEG_STATIC_DIR", ""),
            ("COWORK_STATIC_DIR", "/web"),
            ("COWORK_UPDATE_DISABLED", "1"),
            ("COWORK_UNKNOWN", "x"),
        ]);
        let mut out = alias_exports(&env);
        out.sort();
        assert_eq!(
            out,
            vec![
                ("CODEG_DATA_DIR".into(), "/home/x/.codeg".into()),
                ("CODEG_PORT".into(), "6801".into()),
                ("CODEG_STATIC_DIR".into(), "/web".into()),
                ("CODEG_UPDATE_DISABLED".into(), "1".into()),
            ]
        );
    }

    #[test]
    fn listen_fills_host_and_port_when_unset() {
        let env = env_of(&[("PASEO_LISTEN", "127.0.0.1:6812")]);
        let mut out = alias_exports(&env);
        out.sort();
        assert_eq!(
            out,
            vec![
                ("CODEG_HOST".into(), "127.0.0.1".into()),
                ("CODEG_PORT".into(), "6812".into()),
            ]
        );
        // An explicit port (either name) wins over the listen address.
        let env = env_of(&[("COWORK_LISTEN", "10.0.0.2:6812"), ("COWORK_PORT", "7000")]);
        let mut out = alias_exports(&env);
        out.sort();
        assert_eq!(
            out,
            vec![
                ("CODEG_HOST".into(), "10.0.0.2".into()),
                ("CODEG_PORT".into(), "7000".into()),
            ]
        );
        assert_eq!(split_listen("[::1]:80"), Some(("::1".into(), 80)));
        assert_eq!(split_listen("nohost"), None);
        assert_eq!(split_listen(":80"), None);
        assert_eq!(split_listen("h:99999"), None);
    }

    #[test]
    fn settings_resolve_from_env() {
        let env = env_of(&[
            ("COWORK_PROJECTS_ROOT", "/home/cw-a/work/"),
            ("CODEG_COWORK_PORTAL", "true"),
            ("CODEG_UPDATE_DISABLED", "1"),
            ("CODEG_TOKEN_FILE", "/run/x/token"),
            ("CODEG_TOKEN", "  "),
        ]);
        let s = resolve_settings(&env, Path::new("/cwd"));
        assert_eq!(
            s.projects_root.as_deref(),
            Some(Path::new("/home/cw-a/work"))
        );
        assert!(s.portal);
        assert!(s.update_disabled);
        assert_eq!(s.token_file.as_deref(), Some("/run/x/token"));
        assert_eq!(s.env_token, None);

        let s = resolve_settings(
            &env_of(&[("CODEG_PROJECTS_ROOT", "rel/../work")]),
            Path::new("/cwd"),
        );
        assert_eq!(s.projects_root.as_deref(), Some(Path::new("/cwd/work")));
        assert!(!s.portal);
        assert!(!s.update_disabled);

        assert_eq!(
            resolve_settings(&env_of(&[]), Path::new("/")),
            CoworkSettings::default()
        );
    }

    #[test]
    fn info_serializes_in_the_contract_shape() {
        let s = CoworkSettings {
            projects_root: Some(PathBuf::from("/home/cw-a/work")),
            portal: true,
            update_disabled: true,
            ..Default::default()
        };
        let json = serde_json::to_value(CoworkInfo::from(&s)).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "product": "Cowork",
                "projectsRoot": "/home/cw-a/work",
                "portal": true,
                "updateDisabled": true
            })
        );
        let json = serde_json::to_value(CoworkInfo::from(&CoworkSettings::default())).unwrap();
        assert_eq!(json["projectsRoot"], serde_json::Value::Null);
        assert_eq!(json["portal"], false);
    }

    #[test]
    fn token_file_is_trimmed_and_must_not_be_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("token");
        std::fs::write(&file, "  s3cret-value\n").unwrap();
        assert_eq!(
            read_token_file(file.to_str().unwrap()).unwrap(),
            "s3cret-value"
        );
        std::fs::write(&file, "\n \n").unwrap();
        assert!(read_token_file(file.to_str().unwrap()).is_err());
        assert!(read_token_file(dir.path().join("missing").to_str().unwrap()).is_err());
    }

    #[test]
    fn secret_names() {
        for yes in [
            "CODEG_TOKEN",
            "CODEG_TOKEN_FILE",
            "COWORK_TOKEN",
            "COWORK_TOKEN_FILE",
            "PASEO_PASSWORD",
            "COWORK_PASSWORD",
        ] {
            assert!(is_secret_var(yes), "{yes}");
        }
        for no in [
            "CODEG_PORT",
            "CODEG_DATA_DIR",
            "PASEO_LISTEN",
            "TOKEN",
            "HOME",
        ] {
            assert!(!is_secret_var(no), "{no}");
        }
    }

    /// The point of stripping: a child spawned after startup (an ACP agent, a
    /// terminal, a git helper — all plain `Command`s inheriting the process
    /// env) cannot see any of the secrets.
    #[cfg(unix)]
    #[test]
    fn children_spawned_after_strip_cannot_see_secrets() {
        let secrets = [
            ("CODEG_TOKEN", "tok-a"),
            ("CODEG_TOKEN_FILE", "/run/tok"),
            ("COWORK_TOKEN", "tok-b"),
            ("COWORK_TOKEN_FILE", "/run/tok2"),
            ("PASEO_PASSWORD", "pw-c"),
            ("COWORK_PASSWORD", "pw-d"),
        ];
        let mut vars: Vec<(&str, Option<&str>)> =
            secrets.iter().map(|(k, v)| (*k, Some(*v))).collect();
        vars.push(("CODEG_COWORK_TEST_KEEP", Some("kept")));
        temp_env::with_vars(vars, || {
            let before = std::process::Command::new("env").output().unwrap();
            let before = String::from_utf8_lossy(&before.stdout).into_owned();
            assert!(
                before.contains("PASEO_PASSWORD=pw-c"),
                "sanity: child sees it before"
            );

            let mut removed = strip_secret_env();
            removed.sort();
            let mut expected: Vec<String> = secrets.iter().map(|(k, _)| k.to_string()).collect();
            expected.sort();
            assert_eq!(removed, expected);

            let after = std::process::Command::new("env").output().unwrap();
            let after = String::from_utf8_lossy(&after.stdout).into_owned();
            for (name, value) in secrets {
                assert!(
                    !after.contains(&format!("{name}=")),
                    "{name} leaked to child"
                );
                assert!(!after.contains(value), "value of {name} leaked to child");
            }
            assert!(after.contains("CODEG_COWORK_TEST_KEEP=kept"));
        });
    }

    #[test]
    fn project_names_are_one_plain_component() {
        for bad in ["", "  ", ".", "..", "a/b", "/abs", "a\\b", "../up", "a\nb"] {
            assert!(validate_project_name(bad).is_err(), "{bad:?}");
        }
        assert_eq!(validate_project_name(" demo ").unwrap(), "demo");
        assert_eq!(validate_project_name("项目-1.2").unwrap(), "项目-1.2");
        assert_eq!(validate_project_name("v1..2").unwrap(), "v1..2");
        assert!(validate_project_name(&"a".repeat(256)).is_err());
    }

    #[test]
    fn prepare_project_dir_creates_and_rejects_what_is_already_there() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("work");
        let dir = prepare_project_dir(&root, "demo").unwrap();
        assert_eq!(dir, root.join("demo"));
        assert!(dir.is_dir());
        // Existing directory: a name conflict the UI can explain, never reused.
        let err = prepare_project_dir(&root, " demo ").unwrap_err();
        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
        assert_eq!(PROJECT_EXISTS_I18N_KEY, "cowork.projectExists");
        assert_eq!(err.i18n_key.as_deref(), Some(PROJECT_EXISTS_I18N_KEY));
        assert_eq!(
            err.i18n_params
                .as_ref()
                .and_then(|params| params.get("name"))
                .map(String::as_str),
            Some("demo")
        );
        // Existing file: rejected too, but it is not a project.
        std::fs::write(root.join("file"), b"x").unwrap();
        let err = prepare_project_dir(&root, "file").unwrap_err();
        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
        assert!(err.i18n_key.is_none());
        assert!(prepare_project_dir(&root, "../escape").is_err());
        assert!(!tmp.path().join("escape").exists());
    }

    fn identity(name: &str, email: &str) -> (String, String) {
        (name.to_string(), email.to_string())
    }

    #[test]
    fn fallback_git_identity_is_the_employee_at_the_cowork_domain() {
        // Served at the employee's own subdomain (port and case do not matter;
        // `X-Forwarded-Host` is looked at after `Host`).
        assert_eq!(
            fallback_git_identity(Some("cw-erin"), &["erin.work.example.com"]),
            identity("erin", "erin@work.example.com")
        );
        assert_eq!(
            fallback_git_identity(
                Some("cw-erin"),
                &["127.0.0.1:6801", "Erin.Work.Example.com:443"]
            ),
            identity("erin", "erin@work.example.com")
        );
        // Somebody else's subdomain, an IP address, a bare host: the system user.
        assert_eq!(
            fallback_git_identity(
                Some("cw-erin"),
                &[
                    "bob.work.example.com",
                    "127.0.0.1:6801",
                    "erin",
                    "erin.10.0.0.7"
                ]
            ),
            identity("cw-erin", "cw-erin@localhost")
        );
        assert_eq!(
            fallback_git_identity(Some("tester"), &[]),
            identity("tester", "tester@localhost")
        );
        // No usable system user name at all.
        assert_eq!(
            fallback_git_identity(None, &["erin.work.example.com"]),
            identity("cowork", "cowork@localhost")
        );
        assert_eq!(
            fallback_git_identity(Some("a b"), &[]),
            identity("cowork", "cowork@localhost")
        );
    }

    /// Trimmed stdout of a git command that must succeed in `dir`.
    async fn git_stdout(dir: &Path, args: &[&str]) -> String {
        let output = project_git(dir, args).await.unwrap();
        assert!(
            output.status.success(),
            "git {args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    // Needs git on the PATH (CI has it). Works with or without a git identity
    // configured on the machine: the fallback fills in whatever is missing.
    #[tokio::test]
    async fn new_project_is_a_git_repo_on_main_with_one_empty_commit() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("work");
        let fallback = identity("erin", "erin@work.example.com");
        let dir = create_project_dir(&root, "demo", &fallback).await.unwrap();
        assert_eq!(dir, root.join("demo"));
        assert!(dir.join(".git").is_dir());
        assert_eq!(
            git_stdout(&dir, &["symbolic-ref", "--short", "HEAD"]).await,
            "main"
        );
        assert_eq!(
            git_stdout(&dir, &["rev-list", "--count", "HEAD"]).await,
            "1"
        );
        assert_eq!(
            git_stdout(&dir, &["log", "-1", "--format=%s"]).await,
            "Initial commit"
        );
        assert!(!git_stdout(&dir, &["log", "-1", "--format=%an <%ae>"])
            .await
            .starts_with(" <"));
        // Nothing but `.git` in the directory, and the identity was passed
        // for that one commit only: no config was written.
        assert!(git_stdout(&dir, &["status", "--porcelain"])
            .await
            .is_empty());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        for key in ["user.name", "user.email"] {
            let local = project_git(&dir, &["config", "--local", "--get", key])
                .await
                .unwrap();
            assert!(!local.status.success(), "{key} written to .git/config");
        }
    }

    #[tokio::test]
    async fn existing_project_dir_is_a_conflict_and_left_untouched() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("work");
        let existing = root.join("demo");
        std::fs::create_dir_all(&existing).unwrap();
        std::fs::write(existing.join("notes.txt"), "mine").unwrap();
        let fallback = identity("erin", "erin@work.example.com");
        let err = create_project_dir(&root, "demo", &fallback)
            .await
            .unwrap_err();
        assert!(matches!(err.code, AppErrorCode::AlreadyExists));
        assert_eq!(err.i18n_key.as_deref(), Some(PROJECT_EXISTS_I18N_KEY));
        // Not turned into a repository, nothing added or changed.
        assert!(!existing.join(".git").exists());
        assert_eq!(std::fs::read_dir(&existing).unwrap().count(), 1);
        assert_eq!(
            std::fs::read_to_string(existing.join("notes.txt")).unwrap(),
            "mine"
        );
    }

    #[test]
    fn update_guard_is_off_without_init() {
        assert!(ensure_update_allowed().is_ok());
        assert!(ensure_reexec_allowed().is_ok());
        assert_eq!(token_source(), TokenSource::Default);
        assert_eq!(token_for_log("abc"), "abc");
        assert!(!redact_enabled());
    }

    #[test]
    fn env_secrets_are_masked_and_restored() {
        let mut env: BTreeMap<String, String> = [
            ("XAI_API_KEY", "xai-real"),
            ("GROK_MODELS_BASE_URL", "https://x/v1"),
            ("GH_TOKEN", "ghp"),
            ("db_password", "pw"),
            ("EMPTY_SECRET", ""),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        let stored = env.clone();
        redact_env(&mut env);
        assert_eq!(env["XAI_API_KEY"], REDACTED);
        assert_eq!(env["GH_TOKEN"], REDACTED);
        assert_eq!(env["db_password"], REDACTED);
        assert_eq!(env["EMPTY_SECRET"], "");
        assert_eq!(env["GROK_MODELS_BASE_URL"], "https://x/v1");
        assert!(!format!("{env:?}").contains("xai-real"));

        // The client edits one field and echoes the rest back.
        env.insert("GROK_MODELS_BASE_URL".into(), "https://y/v1".into());
        env.insert("GH_TOKEN".into(), "ghp-new".into());
        let none = SecretSource::default();
        let out = restore_env(env.clone(), Some(&stored), &none).unwrap();
        assert_eq!(out["XAI_API_KEY"], "xai-real");
        assert_eq!(out["GH_TOKEN"], "ghp-new");
        assert_eq!(out["db_password"], "pw");
        assert_eq!(out["GROK_MODELS_BASE_URL"], "https://y/v1");
        // A placeholder with nothing to restore is refused, never persisted.
        env.insert("NEW_API_KEY".into(), REDACTED.into());
        assert!(restore_env(env, Some(&stored), &none).is_err());

        assert_eq!(
            restore_opt(Some(REDACTED.into()), Some("k")),
            Some("k".into())
        );
        assert_eq!(restore_opt(Some(REDACTED.into()), None), None);
        assert_eq!(
            restore_opt(Some("new".into()), Some("k")),
            Some("new".into())
        );
        assert_eq!(restore_opt(None, Some("k")), None);
    }

    #[test]
    fn toml_secrets_are_masked_and_restored() {
        let stored = "# grok\n[endpoints]\nxai_api_base_url = \"https://x/v1\"\n\n\
                      [model.\"grok-4.5\"]\nmodel = \"grok-4.5\"\nenv_key = \"XAI_API_KEY\"\n\
                      api_key = \"xai-real\" # inline\ncontext_window = 500000\n\n\
                      [auth]\npreferred_method = \"api_key\"\nproxy = { token = \"t-real\" }\n";
        let redacted = redact_toml(stored);
        assert!(!redacted.contains("xai-real"));
        assert!(!redacted.contains("t-real"));
        assert!(redacted.contains("env_key = \"XAI_API_KEY\""), "{redacted}");
        assert!(redacted.contains("preferred_method = \"api_key\""));
        assert!(redacted.contains("# inline"));
        assert_eq!(redacted.matches(REDACTED).count(), 2);

        // Round trip with an unrelated edit.
        let none = SecretSource::default();
        let edited = redacted.replace("500000", "400000");
        let restored = restore_toml(&edited, Some(stored), &none, "grokConfigToml").unwrap();
        assert!(restored.contains("api_key = \"xai-real\""), "{restored}");
        assert!(restored.contains("t-real"));
        assert!(restored.contains("400000"));
        assert!(!restored.contains(REDACTED), "{restored}");
        // A redacted key without a stored counterpart is refused.
        let extra = edited + "\n[model.other]\napi_key = \"********\"\n";
        assert!(restore_toml(&extra, Some(stored), &none, "grokConfigToml").is_err());
        // An http header carrying a bearer token is a secret too.
        let headers = "[mcp.x.http_headers]\nAuthorization = \"Bearer abc\"\n";
        assert!(!redact_toml(headers).contains("abc"));

        // Not TOML / nothing redacted: unchanged.
        assert_eq!(redact_toml("not = = toml"), "not = = toml");
        assert_eq!(redact_toml("a = 1\n"), "a = 1\n");
        assert_eq!(
            restore_toml("a = 1\n", None, &none, "x").unwrap(),
            "a = 1\n"
        );
    }

    #[cfg(unix)]
    #[test]
    fn db_files_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("data");
        let name = crate::db::database_file_name();
        secure_db_files(&dir);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir.join(name)), 0o600);
        let wal = dir.join(format!("{name}-wal"));
        std::fs::write(&wal, b"").unwrap();
        std::fs::set_permissions(&wal, std::fs::Permissions::from_mode(0o644)).unwrap();
        secure_db_files(&dir);
        assert_eq!(mode(&wal), 0o600);
    }

    #[test]
    fn redaction_is_off_outside_cowork_mode() {
        let info = crate::models::model_provider::ModelProviderInfo {
            id: 1,
            name: "p".into(),
            api_url: "u".into(),
            api_key: "k".into(),
            api_key_masked: "*".into(),
            agent_type: "grok".into(),
            model: None,
            created_at: String::new(),
            updated_at: String::new(),
        };
        assert_eq!(redact_model_provider(info).api_key, "k");
        assert_eq!(
            restore_provider_key(Some(REDACTED.into())),
            Some(REDACTED.into())
        );
        assert!(check_new_provider_key(REDACTED).is_ok());
        assert_eq!(probe_key(Some(REDACTED.into())), Some(REDACTED.into()));
        assert!(ensure_not_portal("Config export").is_ok());
        assert!(is_secret_key("anthropic_auth_token"));
        assert!(!is_secret_toml_key("env_key"));
        assert!(!is_secret_key("HOME"));
    }

    #[test]
    fn web_token_placeholders_are_never_stored() {
        // The settings page fills its token field from `get_web_server_status`
        // (`cowork-sso`) and auto-saves it; the config read answers `********`.
        for placeholder in [REDACTED, SSO_PLACEHOLDER_TOKEN] {
            assert!(is_web_token_placeholder(Some(placeholder)));
            assert_eq!(
                keep_web_token(Some(placeholder.into()), Some("real")),
                Some("real".into())
            );
            // Nothing persisted: still nothing, not the placeholder.
            assert_eq!(keep_web_token(Some(placeholder.into()), None), None);
        }
        // `update_web_service_config_core` trims before it stores.
        assert!(is_web_token_placeholder(Some(" cowork-sso ")));
        assert!(!is_web_token_placeholder(Some("real")));
        assert!(!is_web_token_placeholder(Some("")));
        assert!(!is_web_token_placeholder(None));
        // A real token replaces the stored one; no token clears it.
        assert_eq!(
            keep_web_token(Some("new".into()), Some("real")),
            Some("new".into())
        );
        assert_eq!(keep_web_token(None, Some("real")), None);
        // Outside cowork mode nothing is hidden, so nothing is a placeholder.
        assert_eq!(
            restore_web_service_token(Some(SSO_PLACEHOLDER_TOKEN.into()), Some("real")),
            Some(SSO_PLACEHOLDER_TOKEN.into())
        );
    }

    #[test]
    fn secret_needles_match_upstream() {
        for yes in [
            "XAI_API_KEY",
            "GH_TOKEN",
            "db_password",
            "SMTP_PASSWD",
            "PROXY_AUTH",
            "Authorization",
            "GOOGLE_APPLICATION_CREDENTIALS",
            "client_secret",
        ] {
            assert!(is_secret_key(yes), "{yes}");
        }
        for no in ["HOME", "GROK_MODELS_BASE_URL", "ANTHROPIC_MODEL", "PATH"] {
            assert!(!is_secret_key(no), "{no}");
        }
    }

    fn provider(names: &[&str], key: &str) -> SecretSource {
        SecretSource {
            provider_key: Some((names.iter().map(|n| n.to_string()).collect(), key.into())),
        }
    }

    /// The settings UI copies the bound provider's (redacted) key into the
    /// agent env: on a first bind there is no stored value, on a re-bind the
    /// stored one is the old provider's. Both must end up with the provider's.
    #[test]
    fn provider_key_wins_for_the_agent_key_name() {
        let src = provider(&["ANTHROPIC_AUTH_TOKEN", "apiKey", "api_key"], "sk-new");
        let incoming: BTreeMap<String, String> = [
            ("ANTHROPIC_AUTH_TOKEN", REDACTED),
            ("ANTHROPIC_BASE_URL", "https://new/v1"),
            ("GH_TOKEN", REDACTED),
        ]
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect();
        // First bind: no stored env at all, GH_TOKEN cannot be restored.
        assert!(restore_env(incoming.clone(), None, &src).is_err());
        // Re-bind: stored token is the old provider's.
        let stored: BTreeMap<String, String> =
            [("ANTHROPIC_AUTH_TOKEN", "sk-old"), ("GH_TOKEN", "ghp")]
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect();
        let out = restore_env(incoming, Some(&stored), &src).unwrap();
        assert_eq!(out["ANTHROPIC_AUTH_TOKEN"], "sk-new");
        assert_eq!(out["GH_TOKEN"], "ghp", "other secrets come from the store");
        assert_eq!(out["ANTHROPIC_BASE_URL"], "https://new/v1");
    }

    #[test]
    fn json_secrets_are_masked_and_restored() {
        let stored = r#"{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-old",
    "ANTHROPIC_BASE_URL": "https://old/v1",
    "GH_TOKEN": "ghp"
  },
  "permissions": { "allow": ["Bash(ls)"] },
  "apiKeyHelper": ""
}"#;
        let redacted = redact_json(stored);
        assert!(!redacted.contains("sk-old") && !redacted.contains("ghp"));
        assert!(redacted.contains("https://old/v1"));
        assert!(redacted.contains("Bash(ls)"));
        // Nothing secret: byte-identical (no reformatting).
        let plain = "{\"a\":1,  \"model\":\"x\"}";
        assert_eq!(redact_json(plain), plain);
        assert_eq!(redact_json("not json"), "not json");

        // Claude bound to a new provider: the UI writes the provider's
        // redacted key into config.env next to the new URL.
        let incoming = redacted.replace("https://old/v1", "https://new/v1");
        let src = provider(&["ANTHROPIC_AUTH_TOKEN", "apiKey", "api_key"], "sk-new");
        let out = restore_json(&incoming, Some(stored), &src, "configJson").unwrap();
        let v: serde_json::Value = serde_json::from_str(&out).unwrap();
        assert_eq!(v["env"]["ANTHROPIC_AUTH_TOKEN"], "sk-new");
        assert_eq!(v["env"]["GH_TOKEN"], "ghp");
        assert_eq!(v["env"]["ANTHROPIC_BASE_URL"], "https://new/v1");
        assert!(!out.contains(REDACTED));
        // Unbound: the stored value at the same path.
        let out = restore_json(&incoming, Some(stored), &SecretSource::default(), "c").unwrap();
        assert!(out.contains("sk-old"));
        // Nothing to restore from: refused.
        assert!(restore_json(&incoming, None, &SecretSource::default(), "c").is_err());
        // Unparseable text with the quoted placeholder: refused.
        assert!(restore_json("{\"k\": \"********\"", None, &src, "c").is_err());
        // Codex auth.json: the mode stays readable, the tokens do not.
        let codex = r#"{"auth_mode":"chatgpt","OPENAI_API_KEY":null,"tokens":{"id_token":"idt","account_id":"acc"}}"#;
        let red = redact_json(codex);
        assert!(red.contains("\"chatgpt\"") && red.contains("acc") && !red.contains("idt"));
        assert!(!redact_toml("preferred_auth_method = \"apikey\"\n").contains(REDACTED));
        // Arrays and non-secret paths are walked too.
        let arr = r#"{"servers":[{"name":"a","token":"t1"}]}"#;
        let red = redact_json(arr);
        assert!(!red.contains("t1"));
        let back = restore_json(&red, Some(arr), &SecretSource::default(), "c").unwrap();
        assert!(back.contains("t1"));
    }

    #[test]
    fn origins_are_normalized() {
        assert_eq!(
            normalize_origin("https://A.Example.com"),
            Some("https://a.example.com".into())
        );
        assert_eq!(
            normalize_origin("https://a.example.com:443/"),
            Some("https://a.example.com".into())
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:6801"),
            Some("http://127.0.0.1:6801".into())
        );
        assert_eq!(normalize_origin("http://h:80"), Some("http://h".into()));
        assert_eq!(normalize_origin("wss://h:443"), Some("https://h".into()));
        assert_eq!(
            normalize_origin("http://[::1]:8080"),
            Some("http://[::1]:8080".into())
        );
        assert_eq!(
            normalize_origin("http://[::1]"),
            Some("http://[::1]".into())
        );
        for bad in [
            "null",
            "",
            "file:///x",
            "https://",
            "https://h:99999",
            "https://u@h",
        ] {
            assert_eq!(normalize_origin(bad), None, "{bad}");
        }
    }

    fn headers(pairs: &[(&str, &str)]) -> axum::http::HeaderMap {
        let mut h = axum::http::HeaderMap::new();
        for (k, v) in pairs {
            h.append(
                axum::http::HeaderName::from_bytes(k.as_bytes()).unwrap(),
                v.parse().unwrap(),
            );
        }
        h
    }

    #[test]
    fn origin_check_behind_cowork_nginx() {
        // cowork nginx: `Host $cowork_host:443`, `X-Forwarded-Proto https`.
        let nginx = [
            ("host", "alice.example.com:443"),
            ("x-forwarded-proto", "https"),
        ];
        let with = |origin: &str| {
            let mut h = nginx.to_vec();
            h.push(("origin", origin));
            origin_allowed(&headers(&h), &[])
        };
        assert!(with("https://alice.example.com").is_ok());
        assert!(with("https://ALICE.example.com:443").is_ok());
        assert!(
            with("https://bob.example.com").is_err(),
            "sibling subdomain"
        );
        assert!(with("https://portal.example.com").is_err());
        assert!(with("http://alice.example.com").is_err(), "scheme differs");
        assert!(with("null").is_err());
        // `proxy_set_header Host $host; X-Forwarded-Proto $scheme`.
        let h = headers(&[
            ("host", "alice.example.com"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://alice.example.com"),
        ]);
        assert!(origin_allowed(&h, &[]).is_ok());
        // X-Forwarded-Host (another proxy in front).
        let h = headers(&[
            ("host", "127.0.0.1:6801"),
            ("x-forwarded-host", "alice.example.com"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://alice.example.com"),
        ]);
        assert!(origin_allowed(&h, &[]).is_ok());
        // Direct (ssh tunnel) access: plain http, own host:port.
        let h = headers(&[
            ("host", "127.0.0.1:6801"),
            ("origin", "http://127.0.0.1:6801"),
        ]);
        assert!(origin_allowed(&h, &[]).is_ok());
        // CODEG_PUBLIC_ORIGIN adds origins (e.g. a public port nginx does not pass on).
        let h = headers(&[
            ("host", "alice.example.com:443"),
            ("x-forwarded-proto", "https"),
            ("origin", "https://alice.example.com:8443"),
        ]);
        assert!(origin_allowed(&h, &[]).is_err());
        assert!(origin_allowed(&h, &["https://alice.example.com:8443".into()]).is_ok());
        // No Origin (curl, cowork-root on 127.0.0.1): allowed, unless the
        // browser says it is a cross-site / same-site request.
        assert!(origin_allowed(&headers(&[("host", "127.0.0.1:6801")]), &[]).is_ok());
        assert!(origin_allowed(&headers(&[("sec-fetch-site", "same-origin")]), &[]).is_ok());
        assert!(origin_allowed(&headers(&[("sec-fetch-site", "same-site")]), &[]).is_err());
        assert!(origin_allowed(&headers(&[("sec-fetch-site", "cross-site")]), &[]).is_err());
        assert!(guarded_path("/api/health") && guarded_path("/ws/events") && guarded_path("/api"));
        assert!(!guarded_path("/") && !guarded_path("/apikeys") && !guarded_path("/login"));
    }

    #[test]
    fn public_origin_setting_is_normalized() {
        let s = resolve_settings(
            &env_of(&[(
                "COWORK_PUBLIC_ORIGIN",
                "https://A.example.com:443, bogus ,http://b:8080",
            )]),
            Path::new("/"),
        );
        assert_eq!(
            s.public_origins,
            vec!["https://a.example.com", "http://b:8080"]
        );
    }

    #[test]
    fn portal_mode_turns_the_port_bridge_off_by_default() {
        let get = |pairs: &[(&str, &str)], portal| portal_env_defaults(&env_of(pairs), portal);
        assert_eq!(
            get(&[], true),
            vec![("CODEG_BRIDGE_PORTS".into(), "off".into())]
        );
        assert!(get(&[], false).is_empty());
        assert!(get(&[("CODEG_BRIDGE_PORTS", "3081-3090")], true).is_empty());
        assert!(get(&[("CODEG_BRIDGE_PORTS", "")], true).is_empty());
        assert!(get(&[("CODEG_BRIDGE_HOST_PATTERN", "*.dev.x")], true).is_empty());
    }

    #[test]
    fn reexec_needs_the_token_to_survive() {
        assert!(reexec_allowed_for(TokenSource::Default, false).is_ok());
        assert!(reexec_allowed_for(TokenSource::File, false).is_err());
        assert!(reexec_allowed_for(TokenSource::File, true).is_err());
        assert!(reexec_allowed_for(TokenSource::Env, false).is_err());
        // The supervisor relaunches with its own env, which still has it.
        assert!(reexec_allowed_for(TokenSource::Env, true).is_ok());
    }

    #[cfg(unix)]
    #[test]
    fn project_dirs_must_be_real_dirs_inside_the_root() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("work");
        std::fs::create_dir_all(&root).unwrap();
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::os::unix::fs::symlink(&outside, root.join("link")).unwrap();
        assert!(
            prepare_project_dir(&root, "link").is_err(),
            "symlink to a dir"
        );
        for hidden in [".git", ".ssh", ".x"] {
            assert!(validate_project_name(hidden).is_err(), "{hidden}");
        }
        // A symlinked root itself is fine (resolved on both sides).
        let alias = tmp.path().join("alias");
        std::os::unix::fs::symlink(&root, &alias).unwrap();
        assert_eq!(prepare_project_dir(&alias, "p").unwrap(), alias.join("p"));
        assert!(root.join("p").is_dir());
    }
}
