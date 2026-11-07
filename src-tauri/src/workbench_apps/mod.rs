//! Apps: the local web dashboards the "Apps" page shows in place.
//!
//! An app is an address plus, optionally, the command that serves it
//! ([`WorkbenchApp`]). The page itself is the built-in browser's — a native
//! webview on the desktop, the port bridge in a browser — so what this module
//! owns is the part a page cannot do: keeping the services up.
//!
//! **Launch.** An `auto` app's command runs when codeg starts ([`boot`]) and
//! again, with a backoff, when it stops on its own; a `manual` one runs only
//! when someone presses Start. Either way a command runs only when nothing
//! answers at the address yet, so a service launchd (or another codeg) already
//! keeps running is shown, never started twice.
//!
//! **Ownership.** A command runs in a process group of its own through the
//! user's login shell, so a `npm run dev` that forks a server can be stopped
//! as a whole. What codeg started, codeg stops: on Stop, when the app is
//! removed, and when codeg quits ([`stop_all`]). A service it did not start
//! it never signals — it does not know the process, and killing a launchd
//! KeepAlive job would only have launchd start it again.
//!
//! **Health.** Whether an app answers is one TCP connect to its address's
//! host and port, every few seconds (every 300 ms while one is starting). That
//! is the question the page needs answered before it loads, and it is the same
//! probe `browser::services` uses for the dev servers it finds.
//!
//! State is a process-wide `static` like `office_watch`'s: the desktop command
//! and the axum handler both reach it without new fields on `AppState`.

mod config;

use std::collections::{HashMap, VecDeque};
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, LazyLock, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use serde::Serialize;
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};
use tokio::process::Child;

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::terminal::shell_flavor::{append_cmd_line, shell_invocation, ShellInvocation};
use crate::web::event_bridge::{emit_event, EventEmitter};

pub use config::{
    authority_of, default_apps, expand_home, load_apps, normalize_apps, save_apps, AppLaunch,
    WorkbenchApp, APPS_KEY, MAX_APPS,
};

/// Every app's [`WorkbenchAppStatus`], sent whenever one of them changes.
pub const STATUS_EVENT: &str = "workbench-apps://status";
/// The saved list changed ([`WorkbenchAppsSnapshot`]), from any window.
pub const CHANGED_EVENT: &str = "workbench-apps://changed";

/// How long one health connect waits. Loopback answers or refuses at once; a
/// remote address gets the same short leash so one slow host cannot stall a
/// pass.
const PROBE_TIMEOUT: Duration = Duration::from_millis(500);
/// Health pass interval while every app is settled.
const HEALTH_INTERVAL: Duration = Duration::from_secs(5);
/// Readiness poll while a started service has not answered yet.
const READY_POLL: Duration = Duration::from_millis(300);
/// How long a started service may take to answer before it is reported as
/// running but not answering. It keeps running: some take this long to build.
const READY_TIMEOUT: Duration = Duration::from_secs(120);
/// SIGTERM, then this long, then SIGKILL.
const STOP_GRACE: Duration = Duration::from_secs(3);
/// A run shorter than this counts as a failed start for the restart backoff.
const QUICK_EXIT: Duration = Duration::from_secs(60);
/// Failed starts in a row after which an `auto` app is left stopped.
const MAX_QUICK_FAILURES: u32 = 5;
/// Lines of output kept per app, and the longest line kept whole.
const LOG_LINES: usize = 400;
const LOG_LINE_CHARS: usize = 2000;
/// A log file over this is rotated to `<id>.log.1` when its app next starts.
const LOG_FILE_ROTATE_BYTES: u64 = 1024 * 1024;

/// What codeg's own process for an app is doing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProcessPhase {
    /// codeg has no process for it (never started, or stopped by request).
    Idle,
    /// Started; the address has not answered yet.
    Starting,
    /// Started, and has answered at least once.
    Running,
    /// Ended on its own (see `exit_code`).
    Exited,
    /// Could not be started, or kept failing (see `problem`).
    Failed,
}

/// Why an app is not up, for the page to put in words.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppProblem {
    /// The command could not be spawned at all.
    #[serde(rename_all = "camelCase")]
    SpawnFailed { message: String },
    /// The working directory is not a directory on this machine.
    #[serde(rename_all = "camelCase")]
    WorkingDirMissing { path: String },
    /// The process ended without being asked to.
    #[serde(rename_all = "camelCase")]
    Exited { code: Option<i32> },
    /// An `auto` app ended quickly this many times in a row; no more retries.
    #[serde(rename_all = "camelCase")]
    GaveUp { attempts: u32 },
    /// The process runs, but its address still does not answer.
    NotAnswering,
}

/// One app's live state, as the page shows it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchAppStatus {
    pub id: String,
    /// Something answers at the app's address, whoever started it.
    pub reachable: bool,
    pub process: ProcessPhase,
    /// codeg holds a live process for this app — the one Stop would end —
    /// or is waiting out the backoff before restarting it, which Stop
    /// cancels (jenny fork).
    pub managed: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pid: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub started_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub problem: Option<AppProblem>,
}

/// The list and every app's status, in one answer.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchAppsSnapshot {
    pub apps: Vec<WorkbenchApp>,
    pub statuses: Vec<WorkbenchAppStatus>,
}

/// The output codeg kept for an app's process.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchAppLog {
    pub lines: Vec<String>,
    /// The file the output also goes to, when it could be opened.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
}

#[derive(Default)]
struct Runtime {
    reachable: bool,
    phase: Option<ProcessPhase>,
    /// Bumped per spawn; a task of an older spawn leaves the record alone.
    generation: u64,
    pid: Option<u32>,
    started_at: Option<DateTime<Utc>>,
    spawned_at: Option<Instant>,
    problem: Option<AppProblem>,
    quick_failures: u32,
    /// An `auto` app that ended on its own waits out its backoff before the
    /// restart; Stop during that wait cancels it.
    restart_pending: bool,
    /// Asks the owning task to stop the process (dropping it asks too).
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    log: VecDeque<String>,
    log_path: Option<PathBuf>,
}

impl Runtime {
    fn live(&self) -> bool {
        self.stop.is_some()
    }
}

#[derive(Default)]
struct Registry {
    emitter: Option<EventEmitter>,
    apps: Vec<WorkbenchApp>,
    runtimes: HashMap<String, Runtime>,
    next_generation: u64,
    /// Apps a start is in progress for ([`StartClaim`]).
    starting: std::collections::HashSet<String>,
    quitting: bool,
    health_running: bool,
}

static REGISTRY: LazyLock<Mutex<Registry>> = LazyLock::new(|| Mutex::new(Registry::default()));

/// Saves run one at a time from the write through the broadcast, so two
/// windows saving at once cannot leave the stored list and the last broadcast
/// disagreeing (the branch tag's reasoning).
static SAVE_LOCK: LazyLock<tokio::sync::Mutex<()>> =
    LazyLock::new(|| tokio::sync::Mutex::new(()));

fn registry() -> MutexGuard<'static, Registry> {
    REGISTRY.lock().unwrap_or_else(|p| p.into_inner())
}

fn status_of(id: &str, runtime: Option<&Runtime>) -> WorkbenchAppStatus {
    let Some(rt) = runtime else {
        return WorkbenchAppStatus {
            id: id.to_string(),
            reachable: false,
            process: ProcessPhase::Idle,
            managed: false,
            pid: None,
            started_at: None,
            problem: None,
        };
    };
    WorkbenchAppStatus {
        id: id.to_string(),
        reachable: rt.reachable,
        process: rt.phase.unwrap_or(ProcessPhase::Idle),
        managed: rt.live() || rt.restart_pending,
        pid: rt.pid,
        started_at: rt.started_at,
        problem: rt.problem.clone(),
    }
}

fn statuses_locked(reg: &Registry) -> Vec<WorkbenchAppStatus> {
    reg.apps
        .iter()
        .map(|app| status_of(&app.id, reg.runtimes.get(&app.id)))
        .collect()
}

/// Every configured app's status, in list order.
pub fn statuses() -> Vec<WorkbenchAppStatus> {
    statuses_locked(&registry())
}

fn status(id: &str) -> WorkbenchAppStatus {
    let reg = registry();
    status_of(id, reg.runtimes.get(id))
}

/// Tell every window. Read under the lock, sent outside it.
fn broadcast_statuses() {
    let (emitter, statuses) = {
        let reg = registry();
        (reg.emitter.clone(), statuses_locked(&reg))
    };
    if let Some(emitter) = emitter {
        emit_event(&emitter, STATUS_EVENT, statuses);
    }
}

/// Start the service side: remember who to tell, load the list, start the
/// health loop and every `auto` app. Called once per process at startup (the
/// desktop's `setup` and `codeg-server`'s `main`).
pub async fn boot(db: AppDatabase, emitter: EventEmitter) {
    let apps = match load_apps(&db).await {
        Ok(apps) => apps,
        Err(err) => {
            tracing::error!("[apps] could not load the app list: {err}");
            Vec::new()
        }
    };
    {
        let mut reg = registry();
        reg.emitter = Some(emitter);
        reg.apps = apps.clone();
    }
    ensure_health_loop();
    for app in apps {
        if app.launch == AppLaunch::Auto && app.startable() {
            tokio::spawn(async move {
                if let Err(err) = start_app(&app.id).await {
                    tracing::warn!("[apps] auto-start of {} failed: {err}", app.id);
                }
            });
        }
    }
}

/// Make the registry's copy of the list the stored one (the page may be the
/// first to ask, before or without a boot — tests, a server built without it).
pub async fn refresh_apps(db: &AppDatabase) -> Result<Vec<WorkbenchApp>, AppCommandError> {
    // Behind any save in flight: a read that began before a save's write
    // must not put the older list back after the save has set the new one.
    let _after_saves = SAVE_LOCK.lock().await;
    let apps = load_apps(db).await?;
    registry().apps = apps.clone();
    Ok(apps)
}

/// The saved list and every app's status.
pub async fn snapshot(db: &AppDatabase) -> Result<WorkbenchAppsSnapshot, AppCommandError> {
    let apps = refresh_apps(db).await?;
    // A first look should not have to wait a health interval to be right.
    probe_all().await;
    Ok(WorkbenchAppsSnapshot {
        apps,
        statuses: statuses(),
    })
}

/// Store `apps` and bring the running services in line: an app that is gone
/// has its process stopped, a running one whose command or directory changed
/// is restarted on the new one, and an `auto` app that is new (or just
/// switched to `auto`, or given a command) is started.
pub async fn save(
    db: &AppDatabase,
    apps: Vec<WorkbenchApp>,
) -> Result<WorkbenchAppsSnapshot, AppCommandError> {
    let _one_at_a_time = SAVE_LOCK.lock().await;
    let saved = save_apps(db, apps).await?;
    let (to_stop, to_restart, to_start, emitter) = {
        let mut reg = registry();
        let previous = std::mem::replace(&mut reg.apps, saved.clone());
        let to_stop: Vec<String> = previous
            .iter()
            .filter(|old| !saved.iter().any(|app| app.id == old.id))
            .map(|old| old.id.clone())
            .collect();
        let command_changed = |app: &WorkbenchApp| {
            previous.iter().find(|old| old.id == app.id).is_some_and(|old| {
                old.start_command != app.start_command || old.working_dir != app.working_dir
            })
        };
        let to_restart: Vec<String> = saved
            .iter()
            .filter(|app| app.startable() && command_changed(app))
            .filter(|app| reg.runtimes.get(&app.id).is_some_and(Runtime::live))
            .map(|app| app.id.clone())
            .collect();
        let to_start: Vec<String> = saved
            .iter()
            .filter(|app| app.launch == AppLaunch::Auto && app.startable())
            .filter(|app| !to_restart.contains(&app.id))
            .filter(|app| {
                previous.iter().find(|old| old.id == app.id).is_none_or(|old| {
                    old.launch != AppLaunch::Auto || old.start_command != app.start_command
                })
            })
            .map(|app| app.id.clone())
            .collect();
        (to_stop, to_restart, to_start, reg.emitter.clone())
    };
    for id in &to_stop {
        stop_process(id).await;
        registry().runtimes.remove(id);
    }
    ensure_health_loop();
    for id in to_restart {
        tokio::spawn(async move {
            if let Err(err) = restart_app(&id).await {
                tracing::warn!("[apps] restart of {id} on its new command failed: {err}");
            }
        });
    }
    for id in to_start {
        tokio::spawn(async move {
            if let Err(err) = start_app(&id).await {
                tracing::warn!("[apps] start of {id} after save failed: {err}");
            }
        });
    }
    probe_all().await;
    let snapshot = WorkbenchAppsSnapshot {
        apps: saved,
        statuses: statuses(),
    };
    if let Some(emitter) = emitter {
        emit_event(&emitter, CHANGED_EVENT, snapshot.clone());
    }
    Ok(snapshot)
}

fn app_url(id: &str) -> Option<String> {
    registry()
        .apps
        .iter()
        .find(|app| app.id == id)
        .map(|app| app.url.clone())
}

fn app_by_id(id: &str) -> Result<WorkbenchApp, AppCommandError> {
    registry()
        .apps
        .iter()
        .find(|app| app.id == id)
        .cloned()
        .ok_or_else(|| AppCommandError::not_found(format!("no app with id {id:?}")))
}

/// A start in progress for an app, so a second one (boot and a click, two
/// windows) waits its turn instead of spawning a second service in the gap
/// between the first one's probe and its spawn. Released on drop.
struct StartClaim(String);

impl StartClaim {
    fn take(id: &str) -> Option<Self> {
        registry()
            .starting
            .insert(id.to_string())
            .then(|| Self(id.to_string()))
    }
}

impl Drop for StartClaim {
    fn drop(&mut self) {
        registry().starting.remove(&self.0);
    }
}

/// Start `id`'s service unless it is up already. Returns once the command is
/// running (not once it answers: the status events say when it does).
pub async fn start_app(id: &str) -> Result<WorkbenchAppStatus, AppCommandError> {
    // A start the user asks for begins a fresh count of quick exits, so an
    // app that gave up gets its full set of retries again.
    if let Some(rt) = registry().runtimes.get_mut(id) {
        if !rt.live() {
            rt.quick_failures = 0;
        }
    }
    start_app_inner(id).await
}

/// [`start_app`] without the reset: the automatic restart after a backoff.
async fn start_app_inner(id: &str) -> Result<WorkbenchAppStatus, AppCommandError> {
    let app = app_by_id(id)?;
    let Some(command) = app.start_command.clone() else {
        return Err(AppCommandError::invalid_input(format!(
            "app {id:?} has no start command"
        )));
    };
    if registry().runtimes.get(id).is_some_and(Runtime::live) {
        return Ok(status(id));
    }
    let Some(_claim) = StartClaim::take(id) else {
        // Another start of this app is on its way; its events will say how
        // it went.
        return Ok(status(id));
    };
    // Something already serves the address: show it, start nothing.
    if probe(&app.url).await {
        let mut reg = registry();
        let rt = reg.runtimes.entry(id.to_string()).or_default();
        rt.reachable = true;
        if !rt.live() {
            rt.problem = None;
        }
        drop(reg);
        broadcast_statuses();
        return Ok(status(id));
    }
    if let Some(dir) = app.working_dir.as_deref() {
        if !expand_home(dir).is_dir() {
            fail(id, AppProblem::WorkingDirMissing { path: dir.to_string() });
            return Err(AppCommandError::invalid_input(format!(
                "the working directory {dir:?} does not exist"
            )));
        }
    }
    spawn_service(&app, &command)
}

fn fail(id: &str, problem: AppProblem) {
    {
        let mut reg = registry();
        let rt = reg.runtimes.entry(id.to_string()).or_default();
        rt.phase = Some(ProcessPhase::Failed);
        rt.problem = Some(problem);
    }
    broadcast_statuses();
}

fn spawn_service(app: &WorkbenchApp, command: &str) -> Result<WorkbenchAppStatus, AppCommandError> {
    let shell = crate::terminal::manager::resolve_shell();
    let mut cmd = tokio::process::Command::new(&shell);
    match shell_invocation(&shell, command) {
        ShellInvocation::Args(args) => {
            cmd.args(args);
        }
        ShellInvocation::CmdLine(line) => {
            append_cmd_line(&mut cmd, line)?;
        }
    }
    let dir = app
        .working_dir
        .as_deref()
        .map(expand_home)
        .or_else(dirs::home_dir);
    if let Some(dir) = &dir {
        cmd.current_dir(dir);
    }
    cmd.env("CODEG_CMD", command)
        .env("CODEG_APP_ID", &app.id)
        .env("CODEG_APP_URL", &app.url)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        // A second net only: the group is signalled on stop and on quit.
        .kill_on_drop(true);
    #[cfg(unix)]
    cmd.process_group(0);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
    }

    let log_path = open_log_path(&app.id);
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(err) => {
            let message = format!("{shell}: {err}");
            fail(&app.id, AppProblem::SpawnFailed { message: message.clone() });
            return Err(AppCommandError::external_command(
                "Failed to start the app's service",
                message,
            ));
        }
    };
    let pid = child.id();
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel();
    let generation = {
        let mut reg = registry();
        if reg.quitting {
            drop(reg);
            terminate_group_now(pid);
            return Err(AppCommandError::invalid_input("codeg is quitting"));
        }
        reg.next_generation += 1;
        let generation = reg.next_generation;
        let rt = reg.runtimes.entry(app.id.clone()).or_default();
        rt.generation = generation;
        rt.phase = Some(ProcessPhase::Starting);
        rt.pid = pid;
        rt.started_at = Some(Utc::now());
        rt.spawned_at = Some(Instant::now());
        rt.problem = None;
        rt.reachable = false;
        rt.restart_pending = false;
        rt.stop = Some(stop_tx);
        rt.log.clear();
        rt.log_path = log_path.clone();
        push_log_line(rt, format!("$ {command}"));
        generation
    };
    let file = log_path.as_ref().and_then(|path| {
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .ok()
            .map(|f| Arc::new(Mutex::new(f)))
    });
    if let Some(file) = &file {
        write_log_file(
            file,
            &format!("--- {} started: {command}", Utc::now().to_rfc3339()),
        );
    }
    if let Some(out) = child.stdout.take() {
        tokio::spawn(drain_output(app.id.clone(), generation, out, file.clone()));
    }
    if let Some(err) = child.stderr.take() {
        tokio::spawn(drain_output(app.id.clone(), generation, err, file.clone()));
    }
    tokio::spawn(own_process(app.id.clone(), generation, child, stop_rx));
    tokio::spawn(await_ready(app.id.clone(), app.url.clone(), generation));
    broadcast_statuses();
    Ok(status(&app.id))
}

/// `<logs>/apps/<id>.log`, rotated to `.log.1` once it has grown past the cap.
fn open_log_path(id: &str) -> Option<PathBuf> {
    let dir = crate::paths::codeg_logs_root().join("apps");
    std::fs::create_dir_all(&dir).ok()?;
    let path = dir.join(format!("{id}.log"));
    if std::fs::metadata(&path).is_ok_and(|m| m.len() > LOG_FILE_ROTATE_BYTES) {
        let _ = std::fs::rename(&path, dir.join(format!("{id}.log.1")));
    }
    Some(path)
}

fn write_log_file(file: &Mutex<std::fs::File>, line: &str) {
    use std::io::Write;
    let mut file = file.lock().unwrap_or_else(|p| p.into_inner());
    let _ = writeln!(file, "{line}");
}

fn push_log_line(rt: &mut Runtime, line: String) {
    let line = if line.chars().count() > LOG_LINE_CHARS {
        line.chars().take(LOG_LINE_CHARS).collect()
    } else {
        line
    };
    if rt.log.len() == LOG_LINES {
        rt.log.pop_front();
    }
    rt.log.push_back(line);
}

/// Keep reading the pipe — a full pipe would stall the service — into the
/// app's tail and its log file. Lines that are not UTF-8 are kept lossily.
async fn drain_output<R: AsyncRead + Unpin>(
    id: String,
    generation: u64,
    stream: R,
    file: Option<Arc<Mutex<std::fs::File>>>,
) {
    let mut reader = BufReader::new(stream);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf).await {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        let line = String::from_utf8_lossy(&buf)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        if let Some(file) = &file {
            write_log_file(file, &line);
        }
        let mut reg = registry();
        if let Some(rt) = reg.runtimes.get_mut(&id) {
            if rt.generation == generation {
                push_log_line(rt, line);
            }
        }
    }
}

/// Wait for the address to answer, then mark the service running.
async fn await_ready(id: String, url: String, generation: u64) {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let reachable = probe(&url).await;
        let mut changed = false;
        {
            let mut reg = registry();
            let Some(rt) = reg.runtimes.get_mut(&id) else {
                return;
            };
            if rt.generation != generation || rt.phase != Some(ProcessPhase::Starting) {
                return;
            }
            if reachable {
                rt.reachable = true;
                rt.phase = Some(ProcessPhase::Running);
                changed = true;
            } else if Instant::now() >= deadline {
                rt.phase = Some(ProcessPhase::Running);
                rt.problem = Some(AppProblem::NotAnswering);
                changed = true;
            }
        }
        if changed {
            broadcast_statuses();
            return;
        }
        tokio::time::sleep(READY_POLL).await;
    }
}

/// The one owner of a service process: waits for it to end, or for a stop
/// request, and records how it ended. An `auto` app that ended on its own is
/// started again after a backoff, until it fails [`MAX_QUICK_FAILURES`] times
/// in a row.
async fn own_process(
    id: String,
    generation: u64,
    mut child: Child,
    stop_rx: tokio::sync::oneshot::Receiver<()>,
) {
    let pid = child.id();
    let (exit_code, requested) = tokio::select! {
        status = child.wait() => (status.ok().and_then(|s| s.code()), false),
        _ = stop_rx => {
            terminate_group(pid, &mut child).await;
            (None, true)
        }
    };
    // A command that finished cleanly while its address answers was a
    // launcher: the service it started runs on its own now (a detached
    // server, as `start.mjs` scripts leave). Nothing failed, and nothing of
    // codeg's is left to restart or to stop.
    let handed_off = !requested && exit_code == Some(0) && {
        let url = app_url(&id);
        match url {
            Some(url) => probe(&url).await,
            None => false,
        }
    };
    let restart_after = {
        let mut reg = registry();
        let quitting = reg.quitting;
        let launch = reg
            .apps
            .iter()
            .find(|app| app.id == id)
            .map(|app| (app.launch, app.startable()));
        let Some(rt) = reg.runtimes.get_mut(&id) else {
            return;
        };
        if rt.generation != generation {
            return;
        }
        let lived = rt.spawned_at.map(|t| t.elapsed()).unwrap_or_default();
        rt.stop = None;
        rt.pid = None;
        rt.spawned_at = None;
        push_log_line(
            rt,
            match exit_code {
                Some(code) => format!("--- exited with code {code}"),
                None if requested => "--- stopped".to_string(),
                None => "--- ended by a signal".to_string(),
            },
        );
        if requested {
            rt.phase = Some(ProcessPhase::Idle);
            rt.problem = None;
            rt.quick_failures = 0;
            None
        } else if handed_off {
            rt.phase = Some(ProcessPhase::Idle);
            rt.problem = None;
            rt.quick_failures = 0;
            rt.reachable = true;
            None
        } else {
            rt.quick_failures = if lived < QUICK_EXIT {
                rt.quick_failures + 1
            } else {
                0
            };
            let auto = matches!(launch, Some((AppLaunch::Auto, true)));
            if auto && !quitting && rt.quick_failures < MAX_QUICK_FAILURES {
                rt.phase = Some(ProcessPhase::Exited);
                rt.problem = Some(AppProblem::Exited { code: exit_code });
                rt.restart_pending = true;
                Some(restart_backoff(rt.quick_failures))
            } else if auto && rt.quick_failures >= MAX_QUICK_FAILURES {
                rt.phase = Some(ProcessPhase::Failed);
                rt.problem = Some(AppProblem::GaveUp {
                    attempts: rt.quick_failures,
                });
                None
            } else {
                rt.phase = Some(ProcessPhase::Exited);
                rt.problem = Some(AppProblem::Exited { code: exit_code });
                // Only `auto` apps restart, so only they count quick exits;
                // a manual app switched to auto later starts from zero.
                if !auto {
                    rt.quick_failures = 0;
                }
                None
            }
        }
    };
    broadcast_statuses();
    if let Some(delay) = restart_after {
        tokio::time::sleep(delay).await;
        let still_wanted = {
            let mut reg = registry();
            // Still `auto`: a switch to manual during the wait cancels it.
            let auto = reg
                .apps
                .iter()
                .any(|app| app.id == id && matches!(app.launch, AppLaunch::Auto));
            let quitting = reg.quitting;
            match reg.runtimes.get_mut(&id) {
                Some(rt) if rt.generation == generation && rt.restart_pending => {
                    rt.restart_pending = false;
                    auto && !quitting && !rt.live()
                }
                _ => false,
            }
        };
        if still_wanted {
            if let Err(err) = start_app_inner(&id).await {
                tracing::warn!("[apps] restart of {id} failed: {err}");
            }
        }
    }
}

/// 2 s, 4 s, 8 s, … for the 1st, 2nd, 3rd quick failure, capped at a minute.
fn restart_backoff(quick_failures: u32) -> Duration {
    let exp = quick_failures.saturating_sub(1).min(5);
    Duration::from_secs((2u64 << exp).min(60))
}

/// SIGTERM the process group, give it [`STOP_GRACE`], then SIGKILL it.
async fn terminate_group(pid: Option<u32>, child: &mut Child) {
    #[cfg(unix)]
    {
        if let Some(pid) = pid {
            signal_group(pid, libc::SIGTERM);
            if tokio::time::timeout(STOP_GRACE, child.wait()).await.is_ok() {
                // The leader is gone; anything left in its group goes too.
                signal_group(pid, libc::SIGKILL);
                return;
            }
            signal_group(pid, libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
    #[cfg(not(unix))]
    {
        if let Some(pid) = pid {
            let _ = kill_tree::tokio::kill_tree(pid).await;
        }
        let _ = child.kill().await;
    }
}

#[cfg(unix)]
fn signal_group(pgid: u32, signal: libc::c_int) {
    // SAFETY: `killpg` takes plain integers and touches no memory of ours.
    // The group is the one `process_group(0)` made for this spawn: its id is
    // the leader's pid, which our un-reaped `Child` keeps from being reused.
    unsafe {
        libc::killpg(pgid as libc::pid_t, signal);
    }
}

/// Kill a group at once, for a spawn that raced a quit.
fn terminate_group_now(pid: Option<u32>) {
    #[cfg(unix)]
    if let Some(pid) = pid {
        signal_group(pid, libc::SIGKILL);
    }
    #[cfg(not(unix))]
    if let Some(pid) = pid {
        let _ = kill_tree::blocking::kill_tree(pid);
    }
}

/// Ask the owner of `id`'s process to stop it, and wait until it has.
async fn stop_process(id: &str) {
    let stop = registry().runtimes.get_mut(id).and_then(|rt| rt.stop.take());
    let Some(stop) = stop else {
        return;
    };
    let _ = stop.send(());
    // The owner clears `pid` once the process is gone.
    let deadline = Instant::now() + STOP_GRACE + Duration::from_secs(2);
    while Instant::now() < deadline {
        if registry().runtimes.get(id).is_none_or(|rt| rt.pid.is_none()) {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

/// Stop the process codeg started for `id`. Refused for a service codeg did
/// not start: it has no process of it to signal.
pub async fn stop_app(id: &str) -> Result<WorkbenchAppStatus, AppCommandError> {
    app_by_id(id)?;
    // Waiting to restart after it ended on its own: Stop cancels the restart.
    let cancelled = {
        let mut reg = registry();
        reg.next_generation += 1;
        let next = reg.next_generation;
        match reg.runtimes.get_mut(id) {
            Some(rt) if !rt.live() && rt.restart_pending => {
                rt.restart_pending = false;
                rt.generation = next;
                rt.phase = Some(ProcessPhase::Idle);
                rt.problem = None;
                rt.quick_failures = 0;
                true
            }
            _ => false,
        }
    };
    if cancelled {
        broadcast_statuses();
        return Ok(status(id));
    }
    if !registry().runtimes.get(id).is_some_and(Runtime::live) {
        return Err(AppCommandError::invalid_input(format!(
            "codeg did not start app {id:?}, so it cannot stop it"
        )));
    }
    stop_process(id).await;
    probe_all().await;
    broadcast_statuses();
    Ok(status(id))
}

/// Stop `id`'s process if codeg runs one, then start it again.
pub async fn restart_app(id: &str) -> Result<WorkbenchAppStatus, AppCommandError> {
    app_by_id(id)?;
    stop_process(id).await;
    // Wait for the port to be let go of, or the start would see the old
    // process still answering and start nothing.
    let url = app_by_id(id)?.url;
    let deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < deadline && probe(&url).await {
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    start_app(id).await
}

/// The output kept for `id`'s process.
pub fn read_log(id: &str) -> Result<WorkbenchAppLog, AppCommandError> {
    app_by_id(id)?;
    let reg = registry();
    let rt = reg.runtimes.get(id);
    Ok(WorkbenchAppLog {
        lines: rt.map(|rt| rt.log.iter().cloned().collect()).unwrap_or_default(),
        path: rt
            .and_then(|rt| rt.log_path.as_ref())
            .map(|p| p.display().to_string()),
    })
}

/// Whether something accepts a connection at `url`'s host and port.
async fn probe(url: &str) -> bool {
    let Some((host, port)) = authority_of(url) else {
        return false;
    };
    matches!(
        tokio::time::timeout(PROBE_TIMEOUT, tokio::net::TcpStream::connect((host.as_str(), port)))
            .await,
        Ok(Ok(_))
    )
}

/// Probe every app once and record the answers; true when any changed.
async fn probe_all() -> bool {
    let targets: Vec<(String, String)> = registry()
        .apps
        .iter()
        .map(|app| (app.id.clone(), app.url.clone()))
        .collect();
    let answers = futures::future::join_all(targets.into_iter().map(|(id, url)| async move {
        let reachable = probe(&url).await;
        (id, reachable)
    }))
    .await;
    let mut changed = false;
    let mut reg = registry();
    for (id, reachable) in answers {
        let rt = reg.runtimes.entry(id).or_default();
        if rt.reachable != reachable {
            rt.reachable = reachable;
            changed = true;
        }
        // Whatever went wrong before, the address answers now: a service
        // that is slow to come up, or one a launcher command started and
        // left running on its own (the launcher's exit is not the service's).
        if reachable && rt.problem.is_some() {
            rt.problem = None;
            changed = true;
        }
        if reachable
            && !rt.live()
            && matches!(rt.phase, Some(ProcessPhase::Exited | ProcessPhase::Failed))
        {
            rt.phase = Some(ProcessPhase::Idle);
            changed = true;
        }
        if reachable && rt.live() && rt.phase == Some(ProcessPhase::Starting) {
            rt.phase = Some(ProcessPhase::Running);
            changed = true;
        }
    }
    changed
}

/// One health loop per process, started by whichever of boot / save / the
/// first status request comes first.
fn ensure_health_loop() {
    {
        let mut reg = registry();
        if reg.health_running || tokio::runtime::Handle::try_current().is_err() {
            return;
        }
        reg.health_running = true;
    }
    tokio::spawn(async move {
        loop {
            if registry().quitting {
                return;
            }
            if probe_all().await {
                broadcast_statuses();
            }
            tokio::time::sleep(HEALTH_INTERVAL).await;
        }
    });
}

/// Stop every service codeg started, before the process exits. Synchronous:
/// on the desktop it runs from `shut_down`, where nothing handed to a task is
/// sure to run. SIGTERM to each group, a moment, then SIGKILL.
pub fn stop_all() {
    let pids: Vec<u32> = {
        let mut reg = registry();
        reg.quitting = true;
        reg.runtimes
            .values_mut()
            .filter_map(|rt| {
                // Taking the sender makes the owner treat the end as asked for.
                rt.stop.take();
                rt.pid
            })
            .collect()
    };
    if pids.is_empty() {
        return;
    }
    #[cfg(unix)]
    {
        for &pid in &pids {
            signal_group(pid, libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(500));
        for &pid in &pids {
            signal_group(pid, libc::SIGKILL);
        }
    }
    #[cfg(not(unix))]
    for &pid in &pids {
        let _ = kill_tree::blocking::kill_tree(pid);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backoff_doubles_and_caps() {
        assert_eq!(restart_backoff(1), Duration::from_secs(2));
        assert_eq!(restart_backoff(2), Duration::from_secs(4));
        assert_eq!(restart_backoff(3), Duration::from_secs(8));
        assert_eq!(restart_backoff(10), Duration::from_secs(60));
    }

    #[test]
    fn log_tail_is_bounded() {
        let mut rt = Runtime::default();
        for i in 0..(LOG_LINES + 10) {
            push_log_line(&mut rt, format!("line {i}"));
        }
        assert_eq!(rt.log.len(), LOG_LINES);
        assert_eq!(rt.log.front().map(String::as_str), Some("line 10"));
        push_log_line(&mut rt, "x".repeat(LOG_LINE_CHARS + 50));
        assert_eq!(rt.log.back().map(|l| l.chars().count()), Some(LOG_LINE_CHARS));
    }

    #[test]
    fn a_pending_restart_offers_stop() {
        let mut rt = Runtime::default();
        assert!(!status_of("a", Some(&rt)).managed);
        rt.restart_pending = true;
        assert!(status_of("a", Some(&rt)).managed);
    }

    #[test]
    fn problems_serialize_tagged() {
        let value = serde_json::to_value(AppProblem::Exited { code: Some(1) }).unwrap();
        assert_eq!(value, serde_json::json!({"kind": "exited", "code": 1}));
        let value = serde_json::to_value(AppProblem::NotAnswering).unwrap();
        assert_eq!(value, serde_json::json!({"kind": "notAnswering"}));
    }
}
