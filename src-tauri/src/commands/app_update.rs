//! Desktop (Tauri) self-update commands.
//!
//! The download is driven from Rust through `tauri-plugin-updater` — not from
//! a renderer callback — so its progress lives in the shared
//! [`crate::update::state`] handle and survives the settings page unmounting,
//! a tab switch, or a reload. The renderer is a pure subscriber: it kicks off
//! `perform_app_update`, then reflects whatever the `app_update_state`
//! event/snapshot reports, exactly like the standalone-server path.
//!
//! These mirror the server-mode axum handlers in
//! `web::handlers::app_update` (same command names, so the transport layer
//! routes `perform_app_update` / `restart_app` / `app_update_state` to the
//! right place per runtime), but drive the platform updater instead of the
//! in-place tarball swap.
//!
//! `perform_app_rollback` goes back to the release before this one the same
//! way: that release's own manifest is the endpoint and the version check
//! takes the older version ([`crate::update::rollback`]).
//!
//! Every platform downloads first and switches over only when the user asks
//! for the restart. Windows and macOS keep the downloaded package in memory
//! until the restart and install it then; Linux puts the new version in place
//! at the end of the download. On Windows running the installer is what ends
//! the app. On macOS installing swaps the app bundle, and the old version
//! keeps starting things from that bundle while it runs (`codeg-server` for
//! the local workspace, restarted whenever it dies, and the `codeg-mcp`
//! companion of every new conversation), so swapping it at the end of the
//! download would have those come up as the new version under the old app —
//! a new server migrating the database the old app has open. The rules are
//! plain functions in [`crate::update::restart_install`].
//!
//! `perform_app_rollback` goes through the same `run_download`, so on macOS a
//! rollback, too, only downloads and waits for the restart to install.
//!
//! Cowork fork: every update leaves its steps in the update journal
//! ([`crate::update::journal`], `<data dir>/update/journal.json`): when it
//! started and how, the download, the install, and at the next start whether
//! the new version came up. Each outcome is reported through the crash
//! report channel (`crash_report::push_update`), and every change of the
//! update state is a line in the log.
//!
//! Cowork fork: on macOS the downloaded package is also stored on disk
//! ([`crate::update::staged`], `<data dir>/update/staged/<version>/`), so an
//! app quit before the restart does not download it again: the next start,
//! and the next `perform_app_update`, take it back once the plugin has
//! restored the update from its manifest and checked the package's signature.
//! A rollback stores nothing and removes what was stored: the older release
//! may not know to clean it up.
//!
//! Cowork fork: on macOS, with "Automatic updates" at "Install automatically"
//! (the `update_mode` preference, [`crate::update::idle::UpdateMode`]), a
//! downloaded update is put in place on its own once the Mac has been idle
//! for two checks a minute apart ([`start_idle_restart`]): the same way as
//! the restart button, then reopened in the background (`open -g`).
//!
//! Cowork fork (issue #413, row 3): on macOS, before a new version is put in
//! place (the restart button, the idle restart, the launch; not a rollback),
//! the running app bundle is copied to `<data dir>/update/previous/`
//! ([`crate::update::previous`]). When the new version then fails to be
//! confirmed on two boots in a row, the third boot puts the copy back and
//! relaunches into it ([`roll_back_at_launch`]); that version is no longer
//! downloaded or installed on its own (the journal's `bad_versions`), though
//! the user can still install it by hand.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tauri_plugin_updater::UpdaterExt;

use crate::app_error::AppCommandError;
use crate::update::channel::{self, UpdateChannel};
use crate::update::idle::{self, IdleSnapshot, IdleStreak, IdleTries, IdleVerdict, UpdateMode};
use crate::update::journal::{self, Announcement, ApplyHow, Journal, Outcome, Trigger};
use crate::update::previous::{self, AutoRollback, RollbackCheck};
use crate::update::restart_install::{self, RestartInstallOutcome};
use crate::update::rollback::{self, AppRollbackTarget, ReleaseSource};
use crate::update::staged::{self, Check, Restored, Verdict};
use crate::update::state::{
    self as update_state, AppUpdateLifecycle, AppUpdateState, AppUpdateStateHandle,
};
use crate::web::event_bridge::EventEmitter;

/// Current update snapshot, for the renderer to re-sync on mount.
#[tauri::command]
pub fn app_update_state(state: tauri::State<'_, AppUpdateStateHandle>) -> AppUpdateState {
    update_state::snapshot(state.inner())
}

/// Where the update journal is, and the version this process runs
/// ([`start_journal`]).
struct JournalHome {
    path: PathBuf,
    running: String,
    /// The data directory: the local daemon's too (`restart-intent.json`).
    data_dir: PathBuf,
}

static JOURNAL_HOME: OnceLock<JournalHome> = OnceLock::new();
/// Around every read-change-write of the journal.
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

/// 本进程为更新重启写的重启意图，从认领到退出（[`journal::RestartIntentFlow`]）。
static RESTART_INTENT: journal::RestartIntentFlow =
    journal::RestartIntentFlow::new(restart_install::CURRENT_PLATFORM);
/// Opened once the start confirmation of this run is over
/// ([`confirm_when_running`]); [`take_update_announcement`] waits for it.
static CONFIRM_GATE: journal::ConfirmGate = journal::ConfirmGate::new();
/// The longest [`take_update_announcement`] waits for the confirmation: the
/// local daemon gets up to 5 minutes, then [`journal::CONFIRM_AFTER_SECS`].
const ANNOUNCE_WAIT: std::time::Duration =
    std::time::Duration::from_secs(5 * 60 + journal::CONFIRM_AFTER_SECS + 60);

/// Read the journal, let `f` change it, write it back when it changed. None
/// before [`start_journal`].
fn with_journal<R>(f: impl FnOnce(&mut Journal, &str) -> R) -> Option<R> {
    let home = JOURNAL_HOME.get()?;
    let _guard = JOURNAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut journal = journal::load(&home.path, &home.running);
    let before = journal.clone();
    let result = f(&mut journal, &home.running);
    if journal != before {
        if let Err(e) = journal::save(&home.path, &journal) {
            tracing::warn!("[update] could not write the update journal: {e}");
        }
    }
    Some(result)
}

/// Change the journal; an outcome it ends with is logged and reported.
fn journal_event(f: impl FnOnce(&mut Journal, &str) -> Option<Outcome>) {
    if let Some(Some(outcome)) = with_journal(f) {
        report(&outcome);
    }
}

fn report(outcome: &Outcome) {
    let line = format!(
        "[update] {} {} -> {}{}",
        outcome.result.as_str(),
        outcome.from,
        outcome.to,
        outcome
            .error_kind
            .map(|kind| format!(" ({})", kind.as_str()))
            .unwrap_or_default()
    );
    if outcome.error_kind.is_some() {
        tracing::warn!("{line}");
    } else {
        tracing::info!("{line}");
    }
    crate::crash_report::push_update(outcome);
}

fn now() -> chrono::DateTime<chrono::Utc> {
    chrono::Utc::now()
}

/// Run `f`, which may change the update state, and log the change: one info
/// line, a warning with the message when it ends in `Error`.
fn transition<R>(handle: &AppUpdateStateHandle, f: impl FnOnce() -> R) -> R {
    let before = update_state::snapshot(handle).status;
    let result = f();
    let after = update_state::snapshot(handle);
    if after.status != before {
        let line = journal::transition_line(
            before.as_str(),
            after.status.as_str(),
            after.version.as_deref(),
        );
        if after.status == AppUpdateLifecycle::Error {
            tracing::warn!("{line} error={}", after.error.as_deref().unwrap_or("-"));
        } else {
            tracing::info!("{line}");
        }
    }
    result
}

/// Outcomes found before the crash reports have started ([`apply_at_launch`]
/// runs ahead of them), reported by [`start_journal`].
static EARLY_OUTCOMES: Mutex<Vec<Outcome>> = Mutex::new(Vec::new());
/// The minute timer of [`start_journal`] runs once.
static JOURNAL_TIMER: AtomicBool = AtomicBool::new(false);

fn early_outcomes() -> MutexGuard<'static, Vec<Outcome>> {
    EARLY_OUTCOMES.lock().unwrap_or_else(|p| p.into_inner())
}

/// Where the journal is, and this boot of a version being applied counted
/// ([`Journal::on_boot`]), once: by [`apply_at_launch`] when it runs, else by
/// [`start_journal`]. What `on_boot` ends with waits in [`EARLY_OUTCOMES`].
fn init_journal(app: &tauri::AppHandle, data_dir: &Path) {
    let home = JournalHome {
        path: journal::path(data_dir),
        running: app.package_info().version.to_string(),
        data_dir: data_dir.to_path_buf(),
    };
    if JOURNAL_HOME.set(home).is_err() {
        return;
    }
    // 自动退回的那条是没起来的那一版留下的，退回到的这一版启动时补报。
    let found = with_journal(|j, running| {
        let unreported = j.take_unreported();
        (unreported, j.on_boot(running, now()))
    });
    if let Some((unreported, booted)) = found {
        early_outcomes().extend(unreported.into_iter().chain(booted));
    }
}

/// At start, from `setup` (once the crash reports have started, so an
/// outcome found here is queued): read the journal, count this boot of a
/// version being applied ([`Journal::on_boot`]), report what was found before
/// the crash reports started, and check once a minute whether a downloaded
/// update has been waiting too long.
pub fn start_journal(app: &tauri::AppHandle, data_dir: &Path) {
    init_journal(app, data_dir);
    let early = std::mem::take(&mut *early_outcomes());
    for outcome in &early {
        report(outcome);
    }
    if JOURNAL_TIMER.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async {
        let mut every_minute = tokio::time::interval(std::time::Duration::from_secs(60));
        // The first tick is at once.
        every_minute.tick().await;
        loop {
            every_minute.tick().await;
            let _ = tauri::async_runtime::spawn_blocking(|| {
                journal_event(|j, running| j.check_waiting_long(running, now()))
            })
            .await;
        }
    });
}

/// The start confirmation, from `setup` once the main window is built: when
/// this process is the version an update was putting in place, wait for the
/// local daemon (a child: its endpoint, which it has once `/api/health`
/// answered; the in-process one is up by now; client mode has none), then
/// 60 s more, and if the process is still alive by then the update is
/// `applied`. A tokio timer, off the main thread the crash report watchdog
/// watches.
pub fn confirm_when_running(mode: crate::local_daemon::Mode) {
    if with_journal(|j, running| j.awaiting_confirmation(running)) != Some(true) {
        CONFIRM_GATE.settle();
        return;
    }
    tauri::async_runtime::spawn(async move {
        confirm_after_start(mode).await;
        // 确认了或没确认，「已更新到…」都不用再等了。
        CONFIRM_GATE.settle();
    });
}

async fn confirm_after_start(mode: crate::local_daemon::Mode) {
    if mode == crate::local_daemon::Mode::Child {
        let mut up = false;
        // Up to 5 minutes.
        for _ in 0..60 {
            if matches!(crate::local_daemon::connection_info().await, Ok(Some(_))) {
                up = true;
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        if !up {
            tracing::warn!("[update] the local daemon did not come up; not confirmed");
            return;
        }
    }
    tokio::time::sleep(std::time::Duration::from_secs(journal::CONFIRM_AFTER_SECS)).await;
    let confirmed = tauri::async_runtime::spawn_blocking(|| {
        with_journal(|j, running| j.confirm(running, now()))
    })
    .await;
    if let Ok(Some(Some(outcome))) = confirmed {
        tracing::info!("[update] confirmed running {}", outcome.to);
        report(&outcome);
        // The update (or the rollback) is in place: what was stored for
        // it has done its job.
        if let Some(root) = STAGED_ROOT.get() {
            if let Err(e) = staged::clear(root) {
                tracing::warn!("[update] could not remove the stored package: {e}");
            }
        }
    }
}

/// Begin (or attach to) a download+install of the available update. Returns
/// immediately with the current snapshot; the work runs detached and reports
/// progress via the `app_update_state` event.
///
/// `trigger` is `"auto"` when the window started it on its own (the
/// background download after a check), else absent: the journal reports a
/// failed download only for those ([`Journal::download_failed`]).
#[tauri::command]
pub async fn perform_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateStateHandle>,
    trigger: Option<String>,
) -> Result<AppUpdateState, AppCommandError> {
    let handle = state.inner().clone();
    let emitter = EventEmitter::from_app(&app);
    let trigger = Trigger::from_param(trigger.as_deref());

    let (started, snap) = transition(&handle, || update_state::try_begin(&handle, &emitter));
    if !started {
        // A download is already in flight (or staged) — attach to it.
        return Ok(snap);
    }

    tauri::async_runtime::spawn(download(app, handle, emitter, None, trigger));

    Ok(snap)
}

/// [`run_download`], and what a failure leaves: the `Error` state, a warning
/// in the log and the journal's `download_failed`.
async fn download(
    app: tauri::AppHandle,
    handle: AppUpdateStateHandle,
    emitter: EventEmitter,
    downgrade: Option<Downgrade>,
    trigger: Trigger,
) {
    if let Err(message) =
        run_download(app, handle.clone(), emitter.clone(), downgrade, trigger).await
    {
        journal_event(|j, running| {
            j.download_failed(running, trigger, current_channel(), &message, now())
        });
        transition(&handle, || {
            update_state::set_error(&handle, &emitter, message)
        });
    }
}

/// The updater endpoints in the app's configuration
/// (`plugins.updater.endpoints`). An `e2e` test build can be pointed at a
/// fake feed instead (`crate::e2e::updater_endpoints`).
fn config_endpoints(app: &tauri::AppHandle) -> Vec<String> {
    #[cfg(feature = "e2e")]
    if let Some(endpoints) = crate::e2e::updater_endpoints() {
        return endpoints;
    }
    app.config()
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .and_then(|endpoints| endpoints.as_array())
        .map(|endpoints| {
            endpoints
                .iter()
                .filter_map(|endpoint| endpoint.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

/// Where the updater checks, when it is a GitHub repository's latest release
/// (the only kind of update source with older releases to go back to).
fn rollback_source(app: &tauri::AppHandle) -> Option<ReleaseSource> {
    ReleaseSource::from_endpoints(&config_endpoints(app))
}

/// Cowork fork (issue #413): the update channel the person chose, stable
/// until they pick early. Read at each check, download and rollback lookup.
fn current_channel() -> UpdateChannel {
    crate::preferences::load().update_channel()
}

/// The release `perform_app_rollback` would go back to, and whether it can
/// open this app's database. None when there is no older release, or no
/// update source to have one.
#[tauri::command]
pub async fn app_rollback_target(
    app: tauri::AppHandle,
) -> Result<Option<AppRollbackTarget>, AppCommandError> {
    let Some(source) = rollback_source(&app) else {
        return Ok(None);
    };
    rollback::find_target(&source, &app.package_info().version, current_channel()).await
}

/// Begin a download of `version`, the release before this one, like an
/// update: progress arrives as `app_update_state`, and `restart_app` switches
/// over. It shares `run_download` with the update, so where the update
/// installs at the restart ([`INSTALL_AT_RESTART`], Windows and macOS), the
/// rollback does too. Looks the release up again, so that only the previous release, and
/// only one that opens this app's database, is ever installed.
#[tauri::command]
pub async fn perform_app_rollback(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateStateHandle>,
    version: String,
) -> Result<AppUpdateState, AppCommandError> {
    let source = rollback_source(&app).ok_or_else(|| {
        AppCommandError::configuration_missing("This build has no releases to roll back to")
    })?;
    let target = rollback::find_target(&source, &app.package_info().version, current_channel())
        .await?
        .filter(|target| target.version == version)
        .ok_or_else(|| {
            AppCommandError::invalid_input(format!("{version} is not the release before this one"))
        })?;
    if !target.unknown_migrations.is_empty() {
        return Err(AppCommandError::invalid_input(format!(
            "{version} cannot open this app's database (it lacks {})",
            target.unknown_migrations.join(", ")
        )));
    }
    let downgrade = Downgrade {
        manifest: url::Url::parse(&source.manifest_url(&target.tag))
            .map_err(|e| AppCommandError::invalid_input(e.to_string()))?,
        version: semver::Version::parse(&target.version)
            .map_err(|e| AppCommandError::invalid_input(e.to_string()))?,
    };

    let handle = state.inner().clone();
    let emitter = EventEmitter::from_app(&app);
    let (started, snap) = transition(&handle, || update_state::try_begin(&handle, &emitter));
    if !started {
        // An update is already downloading or staged; leave it be.
        return Err(AppCommandError::invalid_input(
            "An update is already in progress",
        ));
    }
    tauri::async_runtime::spawn(download(
        app,
        handle,
        emitter,
        Some(downgrade),
        Trigger::Rollback,
    ));

    Ok(snap)
}

/// Where a rollback goes: the older release's own manifest, and its version,
/// the only one the check then takes.
struct Downgrade {
    manifest: url::Url,
    version: semver::Version,
}

/// Bound on the pre-download manifest re-check. `tauri-plugin-updater` applies
/// no timeout of its own, and `try_begin` has already flipped the shared state
/// to `Downloading` by the time we get here — so a black-holed network would
/// pin the UI at "downloading, 0 bytes" forever, with `try_begin` refusing
/// every retry until the app is restarted. Only the check is bounded; the
/// download itself must stay unbounded so a slow-but-progressing transfer is
/// never killed mid-stream.
const CHECK_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(20);

/// Whether the download stops short of installing and leaves that to the
/// restart, which is the case on Windows and macOS.
///
/// On Windows the install is the restart: the plugin starts the installer and
/// ends the app (see [`updater`]). Run at the end of the download, it closed
/// the app the moment the download finished, without waiting for the user to
/// restart.
///
/// On macOS the install swaps the app bundle in place. Done at the end of the
/// download, the old version went on running for hours or days from a bundle
/// that already held the new one, and whatever it started from there in the
/// meantime was the new version: the `codeg-mcp` of every new conversation
/// (found beside the running executable, `Contents/MacOS`), connecting to the
/// old app, and the local workspace's `codeg-server`, restarted whenever it
/// dies, which opened — and first migrated — the database under the old app.
/// So the restart installs it, and then relaunches ([`install_and_quit`]).
///
/// `cfg!` rather than `#[cfg]` (inside [`restart_install::CURRENT_PLATFORM`]),
/// so that both paths compile on every platform.
const INSTALL_AT_RESTART: bool =
    restart_install::installs_at_restart(restart_install::CURRENT_PLATFORM);

/// Whether a successful install ends the app itself, so that `install`
/// returning at all means it failed: Windows, where the plugin starts the
/// installer and exits. On macOS `install` returns once the new bundle is in
/// place, and the relaunch is ours to ask for.
const INSTALL_ENDS_APP: bool =
    restart_install::installer_ends_app(restart_install::CURRENT_PLATFORM);

/// A downloaded update that the restart installs ([`INSTALL_AT_RESTART`]).
struct StagedInstall {
    update: tauri_plugin_updater::Update,
    /// The package, already checked against the update's signature.
    bytes: Vec<u8>,
    /// Set once the app has shut down for the installer; see [`updater`].
    quit: Arc<AtomicBool>,
}

/// The update a download leaves for the restart. `update_state` keeps the
/// two from overlapping: a download stores it before it reports
/// `ReadyToRestart`, and only a restart claimed from `ReadyToRestart` takes it.
static STAGED_INSTALL: Mutex<Option<StagedInstall>> = Mutex::new(None);

fn staged_install() -> MutexGuard<'static, Option<StagedInstall>> {
    STAGED_INSTALL.lock().unwrap_or_else(|p| p.into_inner())
}

/// Whether the downloaded package is also stored on disk: macOS only
/// ([`staged::stores_package`]). `cfg!`, so both paths compile everywhere.
const STORES_PACKAGE: bool = staged::stores_package(restart_install::CURRENT_PLATFORM);

/// `<data dir>/update/staged`, set by [`restore_staged_at_start`].
static STAGED_ROOT: OnceLock<PathBuf> = OnceLock::new();

/// The package stored on disk, when it can be used: the plugin restores the
/// update from the stored manifest (`restore_update`, by the same rules as a
/// check, so only one newer than this version) and the package passes its
/// signature (`verify`). Anything else is removed ([`staged::verdict`]).
/// Reads the package (well over 100 MB) and checks it: call it off the
/// runtime's workers. Never goes to the network.
///
/// Cowork fork (issue #413): with `skip_bad` (the launch, and the start
/// making it ready to restart into), a stored version that was rolled back
/// here before (`bad_versions`) is removed instead: it is not put in place on
/// its own. `perform_app_update` takes it as it is.
fn stored_install(app: &tauri::AppHandle, skip_bad: bool) -> Option<StagedInstall> {
    if !STORES_PACKAGE {
        return None;
    }
    let root = STAGED_ROOT.get()?;
    let stored = staged::read(root)?;
    if skip_bad && with_journal(|j, _| j.is_bad(&stored.version)) == Some(true) {
        tracing::info!(
            "[update] removing the stored package {} (bad_version)",
            stored.version
        );
        if let Err(e) = staged::clear(root) {
            tracing::warn!("[update] could not remove the stored package: {e}");
        }
        return None;
    }
    let quit = Arc::new(AtomicBool::new(false));
    // `Ok(None)`: the plugin restored it and found it no newer than this
    // version.
    let restore = match &stored.manifest {
        Some(manifest) => updater(app, quit.clone(), None, current_channel())
            .and_then(|updater| updater.restore_update(manifest.clone()))
            .map_err(|e| {
                tracing::warn!("[update] the stored update could not be restored: {e}");
            }),
        None => Err(()),
    };
    let restored = match &restore {
        Ok(Some(update)) => Restored::Newer(&update.version),
        Ok(None) => Restored::NotNewer,
        Err(()) => Restored::Failed,
    };
    let update = restore.as_ref().ok().and_then(Option::as_ref);
    let verified = match (update, &stored.package) {
        (Some(update), Some(bytes)) => match update.verify(bytes) {
            Ok(()) => true,
            Err(e) => {
                tracing::warn!("[update] the stored package failed its signature: {e}");
                false
            }
        },
        _ => false,
    };
    let verdict = staged::verdict(Check {
        stored: &stored.version,
        running: &app.package_info().version.to_string(),
        manifest_read: stored.manifest.is_some(),
        package_read: stored.package.is_some(),
        restored,
        verified,
    });
    match (verdict, restore, stored.package) {
        (Verdict::Use, Ok(Some(update)), Some(bytes)) => Some(StagedInstall {
            update,
            bytes,
            quit,
        }),
        (verdict, _, _) => {
            let why = match verdict {
                Verdict::Discard(why) => why,
                Verdict::Use => "incomplete",
            };
            tracing::info!(
                "[update] removing the stored package {} ({why})",
                stored.version
            );
            if let Err(e) = staged::clear(root) {
                tracing::warn!("[update] could not remove the stored package: {e}");
            }
            None
        }
    }
}

/// Put a package [`stored_install`] took back in place of a download: it
/// becomes the staged install, the journal marks the package reused, and the
/// state goes to `ReadyToRestart` for its version.
fn use_stored_install(
    install: StagedInstall,
    handle: &AppUpdateStateHandle,
    emitter: &EventEmitter,
    trigger: Trigger,
) {
    let version = install.update.version.clone();
    let bytes = install.bytes.len() as u64;
    *staged_install() = Some(install);
    journal_event(|j, running| {
        j.package_reused(running, &version, trigger, current_channel(), bytes, now());
        forgive_on_manual(j, trigger, &version);
        None
    });
    tracing::info!("[update] using the stored package {version}, no download");
    // 存着的包只会是升级的，回退不存盘。
    READY_IS_ROLLBACK.store(false, Ordering::SeqCst);
    transition(handle, || {
        update_state::set_ready(handle, emitter, Some(version), None, None, None)
    });
}

/// At start, from `setup` before the local daemon starts (macOS): when a
/// package downloaded by an earlier run is stored and still good, the update
/// is `ReadyToRestart` at once, without going to the network. The one
/// [`apply_at_launch`] already took back and left is used as it is, without
/// reading and checking it again.
pub fn restore_staged_at_start(app: &tauri::AppHandle, data_dir: &Path) {
    let _ = STAGED_ROOT.set(staged::root(data_dir));
    let left = launch_leftover().take();
    let Some(install) = left.or_else(|| stored_install(app, true)) else {
        return;
    };
    let handle = {
        use tauri::Manager;
        app.state::<AppUpdateStateHandle>().inner().clone()
    };
    let emitter = EventEmitter::from_app(app);
    // Fresh from start the state is `Idle`; `try_begin` claims it the way a
    // download would, so nothing else can be started meanwhile.
    let (started, _) = transition(&handle, || update_state::try_begin(&handle, &emitter));
    if started {
        use_stored_install(install, &handle, &emitter, Trigger::Auto);
    }
}

/// The stored package [`apply_at_launch`] took back and did not install, for
/// [`restore_staged_at_start`].
static LAUNCH_LEFTOVER: Mutex<Option<StagedInstall>> = Mutex::new(None);

fn launch_leftover() -> MutexGuard<'static, Option<StagedInstall>> {
    LAUNCH_LEFTOVER.lock().unwrap_or_else(|p| p.into_inner())
}

/// Cowork fork (issue #413): the user asked for `version` themselves (the
/// "Update to vX" button): a version rolled back here before is theirs to try
/// again, and put in place like any other from here on.
fn forgive_on_manual(j: &mut Journal, trigger: Trigger, version: &str) {
    if trigger == Trigger::Manual && j.forgive(version) {
        tracing::info!("[update] {version} is installed by hand; no longer held back");
    }
}

/// Whether the previous app bundle is kept before a new version goes in
/// place: macOS only ([`previous::keeps_previous`]).
const KEEPS_PREVIOUS: bool = previous::keeps_previous(restart_install::CURRENT_PLATFORM);

/// The `.app` bundle this process runs from (macOS); None elsewhere, or when
/// it is not running from one.
fn running_bundle(app: &tauri::AppHandle) -> Option<PathBuf> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let exe = tauri::process::current_binary(&app.env()).ok()?;
        crate::relaunch::app_bundle(&exe).map(Path::to_path_buf)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        None
    }
}

/// Cowork fork (issue #413): before a new version goes in place, copy the
/// running bundle to `<data dir>/update/previous/<this version>.app`
/// ([`previous::keep_previous`]), and record in the journal whether that
/// worked (`previous_kept`). A failure is only a warning: the update goes on.
/// Blocking (`cp`): call it off the runtime's workers.
fn keep_previous_bundle(app: &tauri::AppHandle) {
    let Some(home) = JOURNAL_HOME.get() else {
        return;
    };
    let kept = match running_bundle(app) {
        Some(bundle) => match previous::keep_previous(
            Path::new(previous::CP),
            &bundle,
            &previous::root(&home.data_dir),
            &home.running,
        ) {
            Ok(path) => {
                tracing::info!("[update] kept the previous version at {}", path.display());
                true
            }
            Err(e) => {
                tracing::warn!("[update] could not keep the previous version: {e}");
                false
            }
        },
        None => {
            tracing::warn!("[update] could not keep the previous version: not in an app bundle");
            false
        }
    };
    journal_event(|j, _| {
        j.note_previous_kept(kept);
        None
    });
}

/// Cowork fork (issue #413): at launch, on macOS, before the launch apply
/// (once the runtime lock is held, before the database): when this process is
/// the new version an update put in place and its last two boots were neither
/// confirmed nor clean exits ([`journal::ROLL_BACK_AFTER_BOOTS`]), put the
/// bundle kept before the update back ([`previous::swap_back`]), record
/// `rolled_back` (the version goes to `bad_versions`, the report waits for the
/// version rolled back to) and relaunch into it, without `shut_down`. When it
/// cannot (no kept bundle, the folder not writable, the swap failing), it
/// starts as it is and the journal's rules of #412 carry on.
fn roll_back_at_launch(app: &tauri::AppHandle, data_dir: &Path, sole_instance: bool) {
    let path = journal::path(data_dir);
    let running = app.package_info().version.to_string();
    let guard = JOURNAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
    let mut journal = journal::load(&path, &running);
    let Some(attempt) = journal.applying() else {
        return;
    };
    let (from, to, boots) = (attempt.from.clone(), attempt.to.clone(), attempt.boots);
    let previous_kept = attempt.previous_kept == Some(true);
    let kept = previous::bundle_name(&from).map(|name| previous::root(data_dir).join(name));
    let bundle = running_bundle(app);
    let decision = previous::auto_rollback(RollbackCheck {
        platform: restart_install::CURRENT_PLATFORM,
        running: &running,
        applying_to: Some(&to),
        boots,
        previous_kept,
        previous_present: kept.as_deref().is_some_and(Path::is_dir),
        bundle_writable: bundle.as_deref().is_some_and(staged::bundle_writable),
        sole_instance,
    });
    if let AutoRollback::Skip(why) = decision {
        if to == running && boots >= journal::ROLL_BACK_AFTER_BOOTS {
            tracing::warn!("[update] {to} did not start {boots} times; not rolling back ({why})");
        }
        return;
    }
    let (Some(kept), Some(bundle)) = (kept, bundle) else {
        return;
    };
    // 先存 rolled_back 再换包：存不上就不换（不然退回到的那一版读到的还是
    // applying，会再自动装没起来的这一版）；换不回去就把日志恢复原样。
    if let Err(e) = journal::roll_back_saved(
        &mut journal,
        &running,
        now(),
        |j| journal::save(&path, j),
        || {
            previous::swap_back(
                Path::new(previous::CP),
                &bundle,
                &kept,
                &previous::failed_root(data_dir),
                &to,
            )
        },
    ) {
        tracing::warn!("[update] {to} did not start {boots} times; not rolled back: {e}");
        return;
    }
    drop(guard);
    tracing::warn!("[update] {to} did not start {boots} times, rolled back to {from}");
    #[cfg(target_os = "macos")]
    {
        // The process ends without dropping the log guard: give the log
        // writer a moment to get the lines above out.
        std::thread::sleep(std::time::Duration::from_millis(200));
        // `relaunch_now` 只在起不来时才返回，返回的一定是错误。
        let Err(e) = crate::relaunch::relaunch_now(app);
        tracing::error!("[update] cannot start the relauncher ({e}); tauri restarts instead");
    }
    // The previous bundle is in place: this process must not go on as the
    // version that did not start. On the main thread `restart()` relaunches
    // straight away.
    app.restart();
}

/// Cowork fork (issue #413): the end of `lib::shut_down`. A clean exit of the
/// new version before its start confirmation takes back the boot counted for
/// it ([`Journal::on_clean_exit`]), so opening and closing it at once is not a
/// failed start.
pub(crate) fn note_clean_exit() {
    if with_journal(|j, running| j.on_clean_exit(running)) == Some(true) {
        tracing::info!("[update] quit before the start confirmation; this boot does not count");
    }
}

/// Whether the app bundle this process runs from, and the folder it is in,
/// are writable by the user ([`staged::bundle_writable`]). If not, the plugin
/// asks for an administrator password on the main thread, which at launch
/// has no event loop yet to show it.
fn launch_bundle_writable(app: &tauri::AppHandle) -> bool {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        let Ok(exe) = tauri::process::current_binary(&app.env()) else {
            return false;
        };
        crate::relaunch::app_bundle(&exe).is_some_and(staged::bundle_writable)
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        false
    }
}

/// Cowork fork (issue #412): at launch, on macOS, put the package an earlier
/// run downloaded and stored in place, then relaunch into it, before the
/// database, the crash reports, the tray, the local daemon and the first
/// window. From `setup`, once the runtime lock is held (`sole_instance`: not
/// a second instance). Never goes to the network.
///
/// Only when [`staged::launch_apply`] says so: the stored package restores and
/// passes its signature, this version has not been tried at launch before
/// (`launch_apply_tried`, written before trying), the bundle is writable. A
/// success relaunches through [`crate::relaunch::relaunch_now`], not
/// `request_restart()` and `shut_down`, with nothing started yet. A failure
/// is `install_failed` (reported once the crash reports start) and the app
/// starts as it is; the stored package stays, and the restart button takes
/// it from there.
pub fn apply_at_launch(app: &tauri::AppHandle, data_dir: &Path, sole_instance: bool) {
    let platform = restart_install::CURRENT_PLATFORM;
    if !staged::applies_at_launch(platform) {
        return;
    }
    // 先看要不要自动退回（issue #413）：要的话不会回来。
    roll_back_at_launch(app, data_dir, sole_instance);
    init_journal(app, data_dir);
    let _ = STAGED_ROOT.set(staged::root(data_dir));
    let install = stored_install(app, true);
    let tried = with_journal(|j, _| j.launch_apply_tried.clone()).flatten();
    let earlier_outcome = !early_outcomes().is_empty();
    let decision = staged::launch_apply(staged::LaunchCheck {
        platform,
        // 自动更新是「关闭」时不在启动时换上。
        mode_allows: crate::preferences::load().update_mode().applies_at_launch(),
        stored: install.as_ref().map(|i| i.update.version.as_str()),
        tried: tried.as_deref(),
        bundle_writable: install.is_some() && launch_bundle_writable(app),
        sole_instance,
        earlier_outcome,
    });
    if let staged::LaunchApply::Skip(why) = decision {
        if let Some(install) = &install {
            tracing::info!(
                "[update] not installing the stored package {} at launch ({why})",
                install.update.version
            );
        }
        *launch_leftover() = install;
        return;
    }
    let Some(install) = install else {
        return;
    };
    let version = install.update.version.clone();
    let size = install.bytes.len() as u64;
    // 「试过了、正在换上」必须先落到文件里再换：写不进去（数据目录只读、
    // 磁盘满）就不换，不然换失败了每次启动都会再试，换成功了新版本也没有
    // 这一条可确认、可上报。存着的包留给「重启以更新」。
    let recorded = JOURNAL_HOME.get().map(|home| {
        let _guard = JOURNAL_LOCK.lock().unwrap_or_else(|p| p.into_inner());
        journal::record_launch_apply(
            &home.path,
            &home.running,
            &version,
            current_channel(),
            size,
            now(),
        )
    });
    if let Err(e) = recorded.unwrap_or_else(|| Err(std::io::Error::other("no journal"))) {
        tracing::warn!(
            "[update] not installing the stored package {version} at launch \
             (journal_unwritable: {e})"
        );
        *launch_leftover() = Some(install);
        return;
    }
    let StagedInstall { update, bytes, .. } = install;
    // 换上之前留一份正在运行的应用包（issue #413）。
    if KEEPS_PREVIOUS {
        keep_previous_bundle(app);
    }
    tracing::info!("[update] installing {version} at launch");
    // On the main thread, before the event loop: the bundle is writable, so
    // the plugin swaps it without asking for a password (which it would show
    // through the main thread, and wait for here).
    match update.install(bytes) {
        Ok(()) => {
            journal_event(|j, _| {
                j.install_done(now());
                None
            });
            tracing::info!("[update] installed {version} at launch, relaunching");
            #[cfg(target_os = "macos")]
            {
                // The process ends without dropping the log guard: give the
                // log writer a moment to get the lines above out.
                std::thread::sleep(std::time::Duration::from_millis(200));
                // `relaunch_now` 只在起不来时才返回，返回的一定是错误。
                let Err(e) = crate::relaunch::relaunch_now(app);
                tracing::error!(
                    "[update] cannot start the relauncher ({e}); tauri restarts instead"
                );
            }
            // The new bundle is in place, and this process must not go on as
            // the old version from it. On the main thread `restart()`
            // relaunches straight away.
            app.restart();
        }
        Err(e) => {
            let message = e.to_string();
            tracing::warn!(
                "[update] could not install {version} at launch: {message}; starting as it is"
            );
            if let Some(Some(outcome)) =
                with_journal(|j, running| j.install_failed(running, &message, now()))
            {
                early_outcomes().push(outcome);
            }
        }
    }
}

/// Store the downloaded package on disk ([`STORES_PACKAGE`]): a failure (a
/// full disk, say) is a warning, the copy in memory is used all the same.
/// Hands the bytes back.
async fn store_package(update: &tauri_plugin_updater::Update, bytes: Vec<u8>) -> Vec<u8> {
    let Some(root) = STAGED_ROOT.get().filter(|_| STORES_PACKAGE).cloned() else {
        return bytes;
    };
    let version = update.version.clone();
    let manifest = update.raw_json.clone();
    let stored = tauri::async_runtime::spawn_blocking(move || {
        let result = staged::save(&root, &version, &manifest, &bytes);
        (bytes, version, result)
    })
    .await;
    match stored {
        Ok((bytes, version, Ok(()))) => {
            tracing::info!("[update] stored the package {version} on disk");
            bytes
        }
        Ok((bytes, version, Err(e))) => {
            tracing::warn!("[update] could not store the package {version} on disk: {e}");
            bytes
        }
        // The blocking task panicked and took the bytes with it.
        Err(e) => {
            tracing::warn!("[update] storing the package failed: {e}");
            Vec::new()
        }
    }
}

/// `app.updater()`, except that the app quits properly before a Windows
/// installer takes over.
///
/// On Windows a successful install never returns: the plugin launches the
/// installer and ends the process with `std::process::exit(0)` right away, so
/// no `RunEvent::Exit` arrives and the quit in `shut_down` never runs. The
/// agents would outlive the app, and with them the codeg-mcp companions they
/// run from the folder the installer is about to write, along with terminals
/// and office watches; the open workspace windows would not be remembered for
/// the relaunch either. The plugin calls this hook just before it launches the
/// installer, in place of its default one, which only did
/// `cleanup_before_exit`. `quit` records that it ran.
///
/// With a `downgrade`, the updater checks that release's manifest instead,
/// and takes its (older) version, where it otherwise only takes a newer one.
///
/// Cowork fork (issue #413): otherwise it checks the manifest of
/// `update_channel` ([`channel::channel_endpoints`]).
fn updater(
    app: &tauri::AppHandle,
    quit: Arc<AtomicBool>,
    downgrade: Option<&Downgrade>,
    update_channel: UpdateChannel,
) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let quitting = app.clone();
    let mut builder = app.updater_builder().on_before_exit(move || {
        quit.store(true, Ordering::SeqCst);
        // 安装器接手的退出是更新的：重启意图换成算数的，留给 daemon。
        restart_intent_upgrade_exit();
        // `install` runs on a blocking thread (see `install_and_quit`),
        // where this is a plain call. On a runtime worker it would not
        // be, and `shut_down`'s `block_on`s would panic.
        tokio::task::block_in_place(|| crate::shut_down(&quitting));
        quitting.cleanup_before_exit();
    });
    if let Some(downgrade) = downgrade {
        let version = downgrade.version.clone();
        builder = builder
            .endpoints(vec![downgrade.manifest.clone()])?
            .version_comparator(move |current, release| {
                release.version == version && release.version < current
            });
    } else {
        let endpoints = channel::channel_endpoints(update_channel, &config_endpoints(app));
        if !endpoints.is_empty() {
            builder = builder.endpoints(endpoints)?;
        }
    }
    // An `e2e` test build checks the fake feed's packages against the run's
    // test key (`crate::e2e::updater_pubkey`).
    #[cfg(feature = "e2e")]
    if let Some(pubkey) = crate::e2e::updater_pubkey() {
        builder = builder.pubkey(pubkey);
    }
    builder.build()
}

/// Re-check and download the update, driving progress into the shared handle,
/// and install it unless that waits for the restart ([`INSTALL_AT_RESTART`]).
/// On success leaves the state at `ReadyToRestart`. Returns the error message
/// (already stringified) so the caller can record it.
async fn run_download(
    app: tauri::AppHandle,
    handle: AppUpdateStateHandle,
    emitter: EventEmitter,
    downgrade: Option<Downgrade>,
    trigger: Trigger,
) -> Result<(), String> {
    // A package stored by an earlier download is used as it is, without a
    // check or a download. Not for a rollback, which wants an older release.
    if STORES_PACKAGE && downgrade.is_none() {
        let reuse = app.clone();
        if let Ok(Some(install)) =
            tauri::async_runtime::spawn_blocking(move || stored_install(&reuse, false)).await
        {
            use_stored_install(install, &handle, &emitter, trigger);
            return Ok(());
        }
    }
    // A rollback goes to an older release, which may have no code to clean up
    // what is stored here (one from before this was added), so it leaves
    // nothing on disk: the newer package stored before is removed, and the
    // older one is not stored ([`staged::stores_download`]).
    if STORES_PACKAGE && downgrade.is_some() {
        if let Some(root) = STAGED_ROOT.get().cloned() {
            if let Ok(Err(e)) =
                tauri::async_runtime::spawn_blocking(move || staged::clear(&root)).await
            {
                tracing::warn!("[update] could not remove the stored package: {e}");
            }
        }
    }
    let quit = Arc::new(AtomicBool::new(false));
    let update_channel = current_channel();
    let updater = updater(&app, quit.clone(), downgrade.as_ref(), update_channel)
        .map_err(|e| e.to_string())?;
    let update = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        // "timed out" is what the frontend's `normalizeAppUpdateError` keys on
        // to report this as a network problem rather than a generic failure.
        .map_err(|_| "Update check timed out".to_string())?
        .map_err(|e| e.to_string())?
        // The renderer only enables the button when a check found an update,
        // but a release could vanish between check and click.
        .ok_or_else(|| match &downgrade {
            Some(downgrade) => format!("Release {} is no longer available", downgrade.version),
            None => "No update available".to_string(),
        })?;
    let version = update.version.clone();
    journal_event(|j, running| {
        j.begin_download(running, &version, trigger, update_channel, now());
        forgive_on_manual(j, trigger, &version);
        None
    });

    let pe = Arc::new(update_state::ProgressEmitter::new(
        handle.clone(),
        emitter.clone(),
    ));
    let pe_chunk = pe.clone();
    let downloaded = Arc::new(AtomicU64::new(0));
    let counted = downloaded.clone();
    let on_chunk = move |chunk_len: usize, content_len: Option<u64>| {
        let so_far = counted.fetch_add(chunk_len as u64, Ordering::Relaxed) + chunk_len as u64;
        pe_chunk.downloading(so_far, content_len);
    };
    if INSTALL_AT_RESTART {
        // Nothing gets installed until the restart, so there is no
        // `Installing` phase: the download runs to its end, then the restart
        // button takes over.
        let bytes = update
            .download(on_chunk, || {})
            .await
            .map_err(|e| e.to_string())?;
        downloaded.store(bytes.len() as u64, Ordering::Relaxed);
        let bytes =
            if staged::stores_download(restart_install::CURRENT_PLATFORM, downgrade.is_some()) {
                store_package(&update, bytes).await
            } else {
                bytes
            };
        if bytes.is_empty() {
            return Err("The downloaded package was lost while storing it".to_string());
        }
        *staged_install() = Some(StagedInstall {
            update,
            bytes,
            quit,
        });
    } else {
        let pe_finish = pe.clone();
        let installing = version.clone();
        update
            .download_and_install(on_chunk, move || {
                pe_finish.installing();
                tracing::info!(
                    "{}",
                    journal::transition_line("downloading", "installing", Some(&installing))
                );
            })
            .await
            .map_err(|e| e.to_string())?;
    }

    let bytes = downloaded.load(Ordering::Relaxed);
    journal_event(|j, _| {
        j.download_done(bytes, now());
        None
    });
    READY_IS_ROLLBACK.store(downgrade.is_some(), Ordering::SeqCst);
    // The desktop app relaunches itself, so there is no supervisor trial or
    // restart-delay metadata to carry (those are server-only).
    transition(&handle, || {
        update_state::set_ready(&handle, &emitter, Some(version), None, None, None)
    });
    Ok(())
}

/// Cowork fork (issue #413): what [`check_app_update`] answers.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateCheck {
    pub current_version: String,
    pub channel: UpdateChannel,
    /// The newer release on the channel, or null when there is none.
    pub update: Option<CheckedUpdate>,
    /// The release found is one that did not start here before and was rolled
    /// back (the journal's `bad_versions`, issue #413): not downloaded or
    /// installed on its own, though the user may still install it by hand.
    pub blocked: bool,
}

#[derive(Debug, Clone, serde::Serialize)]
pub struct CheckedUpdate {
    pub version: String,
    pub notes: String,
    pub date: Option<String>,
}

/// Cowork fork (issue #413): check the current update channel for a newer
/// release, the way the download will ([`updater`] with the channel's
/// manifest), within [`CHECK_TIMEOUT`]. Replaces the JS plugin's `check()`,
/// which cannot change the endpoint. A failure is the plugin's message, for
/// the window to classify.
#[tauri::command]
pub async fn check_app_update(app: tauri::AppHandle) -> Result<AppUpdateCheck, AppCommandError> {
    let update_channel = current_channel();
    let updater = updater(&app, Arc::new(AtomicBool::new(false)), None, update_channel)
        .map_err(|e| AppCommandError::network(e.to_string()))?;
    let update = tokio::time::timeout(CHECK_TIMEOUT, updater.check())
        .await
        // "timed out" is what `normalizeAppUpdateError` keys on.
        .map_err(|_| AppCommandError::network("Update check timed out"))?
        .map_err(|e| AppCommandError::network(e.to_string()))?;
    let found = update.as_ref().map(|update| update.version.clone());
    let blocked = tauri::async_runtime::spawn_blocking(move || {
        with_journal(|j, _| j.blocked(found.as_deref())).unwrap_or(false)
    })
    .await
    .unwrap_or(false);
    Ok(AppUpdateCheck {
        current_version: app.package_info().version.to_string(),
        channel: update_channel,
        update: update.map(|update| CheckedUpdate {
            version: update.version.clone(),
            notes: update.body.clone().unwrap_or_default(),
            // The manifest's own `pub_date`, as the window got it from the
            // JS plugin.
            date: update
                .raw_json
                .get("pub_date")
                .and_then(|date| date.as_str())
                .map(str::to_string),
        }),
        blocked,
    })
}

/// Relaunch into the freshly-installed bytes. Flips the shared snapshot to
/// `Restarting` first so the UI (and any other window) reflects it, then
/// asks for the restart after a short flush delay and returns.
///
/// On Windows and macOS the install happens here instead
/// ([`INSTALL_AT_RESTART`]); see [`install_and_quit`].
#[tauri::command]
pub async fn restart_app(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateStateHandle>,
) -> Result<(), AppCommandError> {
    restart_into_update(app, state.inner().clone(), ApplyHow::Click).await
}

/// [`restart_app`], and the idle restart ([`start_idle_restart`]): `how` is
/// what the journal records.
async fn restart_into_update(
    app: tauri::AppHandle,
    handle: AppUpdateStateHandle,
    how: ApplyHow,
) -> Result<(), AppCommandError> {
    let emitter = EventEmitter::from_app(&app);
    // Atomically claim the relaunch (flips to `Restarting`) only if an update is
    // genuinely staged — same authority check as the server `restart_impl`.
    // Guards a stale window / direct IPC call from relaunching during
    // idle/error/downloading/installing, and serializes concurrent clicks.
    // The claim clears the staged version from the snapshot: take it from
    // the claim itself, for the restart intent.
    let Some(claimed) = transition(&handle, || {
        update_state::try_claim_restart_version(&handle, &emitter)
    }) else {
        return Err(AppCommandError::invalid_input(
            "No staged update to restart into",
        ));
    };
    journal_event(|j, _| {
        j.apply_started(how, now());
        // 用户自己点了「重启以更新」：之前退回过的这一版也照装（issue #413）。
        if let (ApplyHow::Click, Some(version)) = (how, claimed.version.as_deref()) {
            forgive_on_manual(j, Trigger::Manual, version);
        }
        None
    });
    restart_intent_claimed(claimed.version.as_deref());
    if INSTALL_AT_RESTART {
        return install_and_quit(app, handle, emitter).await;
    }
    // Off the main thread on purpose: from here the restart goes through
    // `RunEvent::ExitRequested` and `RunEvent::Exit`. At `Exit` the
    // single-instance plugin removes its socket, and on macOS
    // `crate::relaunch` takes the restart over. On the main thread tauri
    // relaunches straight away, without either event, and on macOS (tauri
    // 2.12.2+ relaunches through LaunchServices and waits for the launch) the
    // new instance finds the old one still listening, hands it its arguments
    // and quits — nothing is left running.
    //
    // On macOS the new instance must also not be a plain child of this one.
    // A codeg started at login runs as the job of
    // `~/Library/LaunchAgents/codeg.plist`, and when the job's process exits,
    // launchd sends SIGTERM to everything left in its process group. tauri
    // 2.11 spawned the new instance as such a child, and it died there,
    // still in `exec` while Gatekeeper checked the bundle the update had just
    // put in place: the kernel logged "ASP: Sleep interrupted" and "Security
    // policy would not allow process", nothing came back, and the macOS 27
    // Dock showed codeg as running in the background. `crate::relaunch`
    // launches it through LaunchServices (`open -n`), which makes it a job of
    // its own, from a relauncher in a process group of its own, and only once
    // this process is gone — earlier, the Dock gives it a second icon.
    //
    // `request_restart`, not `restart`: off the main thread `restart()` asks
    // for the exit and then sleeps forever, and here that is a tokio worker.
    // When that is the worker driving the runtime's timers and I/O, nothing
    // drives them any more, and `lib::shut_down` on the main thread blocks
    // on futures that need them (the 3 s timeout around stopping the lent
    // sshd never fires): the app hung after "[host-ssh] stopping sshd" on
    // both updates of 2026-11-15 and had to be force quit.
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        tracing::info!("[update] relaunching into the installed update");
        restart_intent_upgrade_exit();
        app.request_restart();
    });
    Ok(())
}

/// Cowork fork (issue #412): restarting for an update on macOS and Windows,
/// leave the local daemon a restart intent (`crate::restart_resume`), so the
/// turns this restart interrupts carry on by themselves in the new version.
/// Only this exit makes it count: quitting, a crash and the launch apply do
/// not. A failure is only a warning.
///
/// Once the restart is claimed, before the install starts, the intent is
/// written as not counting yet ([`journal::RestartIntentFlow::claimed`]): a
/// crash during the install leaves the turns marked interrupted only.
fn restart_intent_claimed(to: Option<&str>) {
    let Some(home) = JOURNAL_HOME.get() else {
        return;
    };
    match RESTART_INTENT.claimed(&home.data_dir, &home.running, to, now()) {
        Ok(true) => tracing::info!("[update] restart intent written, pending the upgrade exit"),
        Ok(false) => {}
        Err(e) => tracing::warn!("[update] could not write the restart intent: {e}"),
    }
}

/// The exit that follows is the update's own (the install worked and the
/// restart is asked for, or the Windows installer takes over): the restart
/// intent counts from here, with a fresh time.
fn restart_intent_upgrade_exit() {
    let Some(home) = JOURNAL_HOME.get() else {
        return;
    };
    match RESTART_INTENT.upgrade_exit(&home.data_dir, now()) {
        Ok(true) => tracing::info!("[update] restart intent armed for the upgrade restart"),
        Ok(false) => {}
        Err(e) => tracing::warn!("[update] could not write the restart intent: {e}"),
    }
}

/// The install failed and the app carries on: the restart intent must not
/// make a later restart look planned.
fn restart_intent_install_failed() {
    let Some(home) = JOURNAL_HOME.get() else {
        return;
    };
    if let Err(e) = RESTART_INTENT.install_failed(&home.data_dir) {
        tracing::warn!("[update] could not remove the restart intent: {e}");
    }
}

/// 从 `lib::shut_down` 最前面调（daemon 停机读意图之前）：本进程为更新写过重启意图，
/// 这次退出却不是更新要的（比如 macOS 安装停在管理员密码框时用户自己退出），
/// 就把意图删掉，被打断的回合照常等人点「继续」（完成标准 34）。
pub(crate) fn forget_restart_intent_on_quit() {
    let Some(home) = JOURNAL_HOME.get() else {
        return;
    };
    match RESTART_INTENT.quitting(&home.data_dir) {
        Ok(true) => tracing::info!(
            "[update] quitting outside the update restart; removed the restart intent"
        ),
        Ok(false) => {}
        Err(e) => tracing::warn!("[update] could not remove the restart intent: {e}"),
    }
}

/// The restart on Windows and macOS: installs the package the download left.
///
/// - Windows: runs the installer, which ends the app and, once it has
///   installed the new version, starts it (the plugin passes it `/R`).
///   Returns only if that failed.
/// - macOS: swaps the app bundle for the new one (the plugin puts the old one
///   back if the swap fails), then asks for the restart, which relaunches
///   into it through `RunEvent::Exit` and `crate::relaunch`. Installing comes
///   first and the app only shuts down (in `ExitRequested` / `Exit`) once it
///   worked: when it fails, nothing has been stopped and the old version
///   carries on. The package in memory is dropped either way; the copy
///   stored on disk ([`STORES_PACKAGE`]) is what the next attempt uses, and
///   is removed once the new version is confirmed running.
///
/// On failure the state is at `Error`, with the plugin's message.
async fn install_and_quit(
    app: tauri::AppHandle,
    handle: AppUpdateStateHandle,
    emitter: EventEmitter,
) -> Result<(), AppCommandError> {
    let Some(StagedInstall {
        update,
        bytes,
        quit,
    }) = staged_install().take()
    else {
        let message = "No downloaded update to install";
        journal_event(|j, running| j.install_failed(running, message, now()));
        restart_intent_install_failed();
        transition(&handle, || {
            update_state::set_error(&handle, &emitter, message)
        });
        return Err(AppCommandError::invalid_input(message));
    };
    let version = update.version.clone();
    // Lets the windows show `Restarting` before the app shuts down.
    tokio::time::sleep(std::time::Duration::from_millis(300)).await;
    tracing::info!("[update] installing the downloaded update");
    // On a blocking thread. On Windows it writes the installer out and shuts
    // the app down, and if the installer starts it ends the process right
    // there. On macOS it may need an administrator password: the plugin then
    // shows the prompt on the main thread and waits for it on this one, so
    // this can be neither the main thread nor a runtime worker.
    // 换上之前留一份正在运行的应用包（issue #413）；回退下的那一版不留。
    let keep = KEEPS_PREVIOUS && !READY_IS_ROLLBACK.load(Ordering::SeqCst);
    let keeping = app.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        if keep {
            keep_previous_bundle(&keeping);
        }
        update.install(bytes)
    })
    .await
        .map_err(|e| e.to_string())
        .and_then(|r| r.map_err(|e| e.to_string()));
    let message = match restart_install::restart_install_outcome(outcome, INSTALL_ENDS_APP) {
        RestartInstallOutcome::Relaunch => {
            journal_event(|j, _| {
                j.install_done(now());
                None
            });
            // Not `restart()`, which would park this tokio worker for good (see
            // `restart_app`).
            tracing::info!("[update] installed {version}, relaunching into it");
            restart_intent_upgrade_exit();
            app.request_restart();
            return Ok(());
        }
        RestartInstallOutcome::Failed(message) => message,
    };
    journal_event(|j, running| j.install_failed(running, &message, now()));
    if quit.load(Ordering::SeqCst) {
        // The installer failed to start after the app had already shut down
        // for it: its agents, terminals and web service are gone. Come back up
        // as the version still installed rather than carry on half torn down.
        tracing::error!("[update] the installer did not start: {message}; relaunching");
        // Not `restart()`, which would park this tokio worker for good (see
        // `restart_app`).
        app.request_restart();
        return Ok(());
    }
    restart_intent_install_failed();
    tracing::error!("[update] the update could not be installed: {message}");
    transition(&handle, || {
        update_state::set_error(&handle, &emitter, message.clone())
    });
    Err(AppCommandError::task_execution_failed(message))
}

/// The "Automatic updates" setting, as the settings page reads and writes it:
/// `"auto"`, `"download"` or `"off"`.
///
/// Cowork fork (issue #413): and the update channel, `"stable"` or
/// `"early"`. Saving, either may be left out to keep what is saved;
/// `channels_available` is only read: false when this build's update source
/// has no channels ([`channel::channels_available`]).
#[derive(Debug, Clone, Default, serde::Serialize, serde::Deserialize)]
pub struct UpdatePreferences {
    #[serde(default)]
    pub mode: Option<String>,
    #[serde(default)]
    pub update_channel: Option<String>,
    #[serde(default)]
    pub channels_available: bool,
}

/// What the settings page is shown of the saved preferences.
fn update_preferences_of(
    prefs: &crate::preferences::AppPreferences,
    channels_available: bool,
) -> UpdatePreferences {
    UpdatePreferences {
        mode: Some(prefs.update_mode().as_str().to_string()),
        update_channel: Some(prefs.update_channel().as_str().to_string()),
        channels_available,
    }
}

#[tauri::command]
pub async fn get_update_preferences(
    app: tauri::AppHandle,
) -> Result<UpdatePreferences, AppCommandError> {
    Ok(update_preferences_of(
        &crate::preferences::load(),
        channel::channels_available(&config_endpoints(&app)),
    ))
}

/// Save the "Automatic updates" setting and the update channel; a value it
/// does not know is saved as `"auto"` / `"stable"`, one left out stays as it
/// was. The idle restart reads the mode at each check, the launch at the next
/// start; the channel is read at the next check. Switching the channel
/// removes nothing: a package stored for the other channel stays.
#[tauri::command]
pub async fn update_update_preferences(
    app: tauri::AppHandle,
    settings: UpdatePreferences,
) -> Result<UpdatePreferences, AppCommandError> {
    let mut prefs = crate::preferences::load();
    if let Some(mode) = settings.mode.as_deref() {
        let mode = UpdateMode::parse(Some(mode));
        prefs.update_mode = Some(mode.as_str().to_string());
        tracing::info!("[update] automatic updates: {}", mode.as_str());
    }
    if let Some(update_channel) = settings.update_channel.as_deref() {
        let update_channel = UpdateChannel::parse(Some(update_channel));
        prefs.update_channel = Some(update_channel.as_str().to_string());
        tracing::info!("[update] update channel: {}", update_channel.as_str());
    }
    crate::preferences::save(&prefs).map_err(|err| {
        AppCommandError::io_error("Failed to save the update setting").with_detail(err.to_string())
    })?;
    Ok(update_preferences_of(
        &prefs,
        channel::channels_available(&config_endpoints(&app)),
    ))
}

/// "Updated to …": the version the last update put in place, the first time
/// a window asks after it was confirmed; `null` after that and for any other
/// outcome. Asked while this run is still being confirmed, it answers once
/// the confirmation is over (at most [`ANNOUNCE_WAIT`]). Read and marked under the journal's lock, so of several windows
/// asking at once only one gets it.
#[tauri::command]
pub async fn take_update_announcement() -> Result<Option<Announcement>, AppCommandError> {
    Ok(tauri::async_runtime::spawn_blocking(|| {
        // 写回成功才算提示过（[`journal::take_announcement_at`]）：日志写
        // 不进去时不提示，免得别的窗口、下次启动再提示一遍。
        // 新版本刚起来、还在等启动确认时，先等确认有了结果再拿
        // （[`journal::take_announcement_once_confirmed`]）：确认要跑满一分钟，
        // 早拿只会拿到上一次的结果。
        let home = JOURNAL_HOME.get()?;
        journal::take_announcement_once_confirmed(
            &home.path,
            &home.running,
            &JOURNAL_LOCK,
            &CONFIRM_GATE,
            ANNOUNCE_WAIT,
        )
    })
    .await
    .ok()
    .flatten())
}

/// Wait until this run's start confirmation is over (at most
/// [`ANNOUNCE_WAIT`]; at once when nothing is awaited), without taking the
/// "Updated to …" announcement. Windows call this first and only then
/// [`take_update_announcement`], so a window closed during the minutes of
/// waiting leaves the announcement for another one.
#[tauri::command]
pub async fn await_update_confirmation() -> Result<(), AppCommandError> {
    let _ = tauri::async_runtime::spawn_blocking(|| {
        if let Some(home) = JOURNAL_HOME.get() {
            journal::await_confirmation(
                &home.path,
                &home.running,
                &JOURNAL_LOCK,
                &CONFIRM_GATE,
                ANNOUNCE_WAIT,
            );
        }
    })
    .await;
    Ok(())
}

/// How long to wait for each of the local daemon's answers.
const IDLE_QUERY_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(idle::QUERY_TIMEOUT_SECS);

/// The idle restart's minute timer runs once.
static IDLE_TIMER: AtomicBool = AtomicBool::new(false);

/// 现在下好、等重启的这一版是不是回退下的。下载走到 `ReadyToRestart` 时写
/// （[`run_download`]、[`use_stored_install`]），不靠升级日志：日志丢了、坏了，
/// 空闲检查也知道这是回退，不会自己重启装上它（回退要等人点）。
static READY_IS_ROLLBACK: AtomicBool = AtomicBool::new(false);

/// Cowork fork (issue #412): on macOS, from `setup` once the windows are on
/// their way, check once a minute whether a downloaded update can be put in
/// place on its own. Only while it may happen ([`idle::should_watch`]: the
/// mode is "Install automatically", the update is `ReadyToRestart`, it is not
/// a rollback, this version has not been tried twice) is the Mac looked at
/// ([`idle_snapshot`]); otherwise nothing is asked of the local daemon. A
/// check that finds it busy counts why in the journal; two idle checks in a
/// row restart the way the button does, reopening in the background.
pub fn start_idle_restart(app: &tauri::AppHandle) {
    if !idle::restarts_when_idle_on(restart_install::CURRENT_PLATFORM)
        || IDLE_TIMER.swap(true, Ordering::SeqCst)
    {
        return;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let handle = {
            use tauri::Manager;
            app.state::<AppUpdateStateHandle>().inner().clone()
        };
        let mut streak = IdleStreak::default();
        let mut every_minute =
            tokio::time::interval(std::time::Duration::from_secs(idle::CHECK_EVERY_SECS));
        // The first tick is at once.
        every_minute.tick().await;
        loop {
            every_minute.tick().await;
            let state = update_state::snapshot(&handle);
            let ready = state.status == AppUpdateLifecycle::ReadyToRestart;
            let Some(version) = state.version.filter(|_| ready) else {
                streak.reset();
                continue;
            };
            let mode = crate::preferences::load().update_mode();
            let (rollback, tries) = idle_watch_facts(&version);
            if !idle::should_watch(mode, ready, rollback, tries) {
                streak.reset();
                continue;
            }
            let snapshot = idle_snapshot(&app).await;
            let verdict = idle::idle_verdict(&snapshot);
            if let IdleVerdict::Blocked(reason) = verdict {
                tracing::debug!("[update] not idle ({}): {snapshot:?}", reason.as_str());
                journal_event(|j, _| {
                    j.note_blocked(reason);
                    None
                });
            }
            if !streak.observe(verdict) {
                continue;
            }
            idle_tried_here(|here| here.note(&version, tries));
            journal_event(|j, _| {
                j.note_idle_try(&version);
                None
            });
            tracing::info!("[update] idle, restarting into {version}");
            #[cfg(target_os = "macos")]
            crate::relaunch::set_background(true);
            if let Err(e) = restart_into_update(app.clone(), handle.clone(), ApplyHow::Idle).await {
                // The install failed (the state is `Error` and the button
                // is the user's to press) or the update was no longer
                // ready: the next restart is a front one again.
                #[cfg(target_os = "macos")]
                crate::relaunch::set_background(false);
                tracing::warn!("[update] the idle restart did not happen: {e}");
            }
        }
    });
}

/// 本进程里记的、这一版自动重启试过几次（[`IdleTries`]）：空闲检查记，
/// [`update_restarts_when_idle`] 也要看。
static IDLE_TRIED_HERE: std::sync::Mutex<IdleTries> = std::sync::Mutex::new(IdleTries::new());

fn idle_tried_here<R>(f: impl FnOnce(&mut IdleTries) -> R) -> R {
    let mut here = IDLE_TRIED_HERE
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    f(&mut here)
}

/// 下好的 `version` 是不是回退下的、自动重启试过几次（[`idle::watch_facts`]）。
/// 升级日志丢了、坏了也不把回退当成普通升级，次数也照样数：内存里那份和日志
/// 里的合起来看。
///
/// Cowork fork (issue #413): a version rolled back here before
/// (`bad_versions`) counts as a rollback here, so it is not put in place on
/// its own either.
fn idle_watch_facts(version: &str) -> (bool, u32) {
    let journal = with_journal(|j, _| {
        let rollback = j
            .attempt
            .as_ref()
            .is_some_and(|a| a.trigger == Trigger::Rollback)
            || j.is_bad(version);
        (rollback, j.idle_tries(version))
    });
    idle::watch_facts(
        READY_IS_ROLLBACK.load(Ordering::SeqCst),
        journal,
        idle_tried_here(|here| here.count(version)),
    )
}

/// Will the downloaded update still be put in place on its own when the Mac
/// is idle: the same test the idle check makes each minute
/// ([`idle::should_watch`]: macOS, "Install automatically", `ReadyToRestart`,
/// not a rollback, this version not yet tried [`idle::MAX_IDLE_TRIES`] times).
/// The status bar only says "It restarts by itself when idle" when this is
/// true; after two failed tries the button is the user's to press.
#[tauri::command]
pub async fn update_restarts_when_idle(
    state: tauri::State<'_, AppUpdateStateHandle>,
) -> Result<bool, AppCommandError> {
    if !idle::restarts_when_idle_on(restart_install::CURRENT_PLATFORM) {
        return Ok(false);
    }
    let snapshot = update_state::snapshot(state.inner());
    let ready = snapshot.status == AppUpdateLifecycle::ReadyToRestart;
    let Some(version) = snapshot.version.filter(|_| ready) else {
        return Ok(false);
    };
    Ok(tauri::async_runtime::spawn_blocking(move || {
        let mode = crate::preferences::load().update_mode();
        let (rollback, tries) = idle_watch_facts(&version);
        idle::should_watch(mode, ready, rollback, tries)
    })
    .await
    .unwrap_or(false))
}

/// What [`idle::idle_verdict`] looks at, now. The local daemon's turns,
/// background tasks and terminals: through its HTTP API when it is a child
/// (each answer within [`IDLE_QUERY_TIMEOUT`]), from this process when it is
/// in it, none in client mode; any of them not answered is
/// `daemon_reachable = false`. The lent shell tunnels and the last lent
/// browser or computer-use call ([`crate::host_bridge::lent`]), and how long
/// the keyboard and the mouse have been left alone.
async fn idle_snapshot(app: &tauri::AppHandle) -> IdleSnapshot {
    use tauri::Manager;
    let mode = app
        .try_state::<crate::commands::local_daemon::DaemonModeState>()
        .map(|state| state.0);
    let local = match mode {
        Some(crate::local_daemon::Mode::Client) => Some((0, 0, 0)),
        Some(crate::local_daemon::Mode::Child) => child_daemon_activity(app).await,
        Some(crate::local_daemon::Mode::Embedded) => in_process_activity(app).await,
        None => None,
    };
    let (local_turns, local_background, local_terminals) = local.unwrap_or_default();
    IdleSnapshot {
        local_turns,
        local_background,
        local_terminals,
        lent_tunnels: crate::host_bridge::lent::open_tunnels(),
        lent_last_call_secs: crate::host_bridge::lent::last_call_secs(),
        user_idle_secs: user_idle_secs(),
        daemon_reachable: local.is_some(),
    }
}

async fn child_daemon_activity(app: &tauri::AppHandle) -> Option<(u32, u32, u32)> {
    use tauri::Manager;
    let conn = tokio::time::timeout(IDLE_QUERY_TIMEOUT, crate::local_daemon::connection_info())
        .await
        .ok()?
        .ok()??;
    let proxy = app
        .try_state::<Arc<crate::commands::remote_proxy::RemoteProxyState>>()?
        .inner()
        .clone();
    let ask = |command: &'static str| {
        let proxy = proxy.clone();
        let conn = conn.clone();
        async move {
            tokio::time::timeout(
                IDLE_QUERY_TIMEOUT,
                crate::commands::remote_proxy::call_api(
                    &proxy,
                    &conn,
                    command,
                    None,
                    Some(idle::QUERY_TIMEOUT_SECS * 1000),
                ),
            )
            .await
            .ok()?
            .ok()
        }
    };
    let pets = ask("pet_list_active_sessions").await?;
    let background = ask("acp_list_background_pending").await?;
    let terminals = ask("terminal_list").await?;
    idle::count_activity(&pets, &background, &terminals)
}

async fn in_process_activity(app: &tauri::AppHandle) -> Option<(u32, u32, u32)> {
    use tauri::Manager;
    let manager = app.try_state::<crate::acp::manager::ConnectionManager>()?;
    let db = app.try_state::<crate::db::AppDatabase>()?;
    let web = app.try_state::<Arc<crate::web::event_bridge::WebEventBroadcaster>>()?;
    let terminals = app.try_state::<crate::terminal::manager::TerminalManager>()?;
    let pets = tokio::time::timeout(
        IDLE_QUERY_TIMEOUT,
        crate::commands::pet::pet_list_active_sessions_core(&manager, &db.conn),
    )
    .await
    .ok()?
    .ok()?;
    let background = tokio::time::timeout(
        IDLE_QUERY_TIMEOUT,
        manager.list_background_pending_with_uncertain(&web),
    )
    .await
    .ok()?;
    let live_terminals = terminals.list_with_exit_check(None);
    idle::count_activity(
        &serde_json::to_value(pets).ok()?,
        &serde_json::to_value(background).ok()?,
        &serde_json::to_value(live_terminals).ok()?,
    )
}

/// Seconds since the last keyboard or mouse input in this session (macOS:
/// CoreGraphics). Elsewhere, where nothing restarts when idle, 0.
fn user_idle_secs() -> u64 {
    #[cfg(target_os = "macos")]
    {
        /// `kCGEventSourceStateCombinedSessionState`.
        const COMBINED_SESSION_STATE: i32 = 0;
        /// `kCGAnyInputEventType`.
        const ANY_INPUT_EVENT_TYPE: u32 = !0;
        #[link(name = "CoreGraphics", kind = "framework")]
        extern "C" {
            fn CGEventSourceSecondsSinceLastEventType(state: i32, event_type: u32) -> f64;
        }
        // SAFETY: a pure query of the session's input state.
        let secs = unsafe {
            CGEventSourceSecondsSinceLastEventType(COMBINED_SESSION_STATE, ANY_INPUT_EVENT_TYPE)
        };
        if secs.is_finite() && secs > 0.0 {
            secs as u64
        } else {
            0
        }
    }
    #[cfg(not(target_os = "macos"))]
    {
        0
    }
}
