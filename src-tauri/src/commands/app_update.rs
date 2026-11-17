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

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use tauri_plugin_updater::UpdaterExt;

use crate::app_error::AppCommandError;
use crate::update::journal::{self, ApplyHow, Journal, Outcome, Trigger};
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
}

static JOURNAL_HOME: OnceLock<JournalHome> = OnceLock::new();
/// Around every read-change-write of the journal.
static JOURNAL_LOCK: Mutex<()> = Mutex::new(());

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

/// At start, from `setup` (once the crash reports have started, so an
/// outcome found here is queued): read the journal, count this boot of a
/// version being applied ([`Journal::on_boot`]), and check once a minute
/// whether a downloaded update has been waiting too long.
pub fn start_journal(app: &tauri::AppHandle, data_dir: &Path) {
    let home = JournalHome {
        path: journal::path(data_dir),
        running: app.package_info().version.to_string(),
    };
    if JOURNAL_HOME.set(home).is_err() {
        return;
    }
    journal_event(|j, running| j.on_boot(running, now()));
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
        return;
    }
    tauri::async_runtime::spawn(async move {
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
    });
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
    let emitter = EventEmitter::Tauri(app.clone());
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
        journal_event(|j, running| j.download_failed(running, trigger, &message, now()));
        transition(&handle, || {
            update_state::set_error(&handle, &emitter, message)
        });
    }
}

/// Where the updater checks, when it is a GitHub repository's latest release
/// (the only kind of update source with older releases to go back to).
fn rollback_source(app: &tauri::AppHandle) -> Option<ReleaseSource> {
    let endpoints: Vec<String> = app
        .config()
        .plugins
        .0
        .get("updater")?
        .get("endpoints")?
        .as_array()?
        .iter()
        .filter_map(|endpoint| endpoint.as_str().map(str::to_string))
        .collect();
    ReleaseSource::from_endpoints(&endpoints)
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
    rollback::find_target(&source, &app.package_info().version).await
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
    let target = rollback::find_target(&source, &app.package_info().version)
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
    let emitter = EventEmitter::Tauri(app.clone());
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
fn stored_install(app: &tauri::AppHandle) -> Option<StagedInstall> {
    if !STORES_PACKAGE {
        return None;
    }
    let root = STAGED_ROOT.get()?;
    let stored = staged::read(root)?;
    let quit = Arc::new(AtomicBool::new(false));
    // `Ok(None)`: the plugin restored it and found it no newer than this
    // version.
    let restore = match &stored.manifest {
        Some(manifest) => updater(app, quit.clone(), None)
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
        j.package_reused(running, &version, trigger, bytes, now());
        None
    });
    tracing::info!("[update] using the stored package {version}, no download");
    transition(handle, || {
        update_state::set_ready(handle, emitter, Some(version), None, None, None)
    });
}

/// At start, from `setup` before the local daemon starts (macOS): when a
/// package downloaded by an earlier run is stored and still good, the update
/// is `ReadyToRestart` at once, without going to the network.
pub fn restore_staged_at_start(app: &tauri::AppHandle, data_dir: &Path) {
    let _ = STAGED_ROOT.set(staged::root(data_dir));
    let Some(install) = stored_install(app) else {
        return;
    };
    let handle = {
        use tauri::Manager;
        app.state::<AppUpdateStateHandle>().inner().clone()
    };
    let emitter = EventEmitter::Tauri(app.clone());
    // Fresh from start the state is `Idle`; `try_begin` claims it the way a
    // download would, so nothing else can be started meanwhile.
    let (started, _) = transition(&handle, || update_state::try_begin(&handle, &emitter));
    if started {
        use_stored_install(install, &handle, &emitter, Trigger::Auto);
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
fn updater(
    app: &tauri::AppHandle,
    quit: Arc<AtomicBool>,
    downgrade: Option<&Downgrade>,
) -> tauri_plugin_updater::Result<tauri_plugin_updater::Updater> {
    let quitting = app.clone();
    let mut builder = app.updater_builder().on_before_exit(move || {
        quit.store(true, Ordering::SeqCst);
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
            tauri::async_runtime::spawn_blocking(move || stored_install(&reuse)).await
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
    let updater = updater(&app, quit.clone(), downgrade.as_ref()).map_err(|e| e.to_string())?;
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
        j.begin_download(running, &version, trigger, now());
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
    // The desktop app relaunches itself, so there is no supervisor trial or
    // restart-delay metadata to carry (those are server-only).
    transition(&handle, || {
        update_state::set_ready(&handle, &emitter, Some(version), None, None, None)
    });
    Ok(())
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
    let handle = state.inner().clone();
    let emitter = EventEmitter::Tauri(app.clone());
    // Atomically claim the relaunch (flips to `Restarting`) only if an update is
    // genuinely staged — same authority check as the server `restart_impl`.
    // Guards a stale window / direct IPC call from relaunching during
    // idle/error/downloading/installing, and serializes concurrent clicks.
    if !transition(&handle, || {
        update_state::try_claim_restart(&handle, &emitter)
    }) {
        return Err(AppCommandError::invalid_input(
            "No staged update to restart into",
        ));
    }
    journal_event(|j, _| {
        j.apply_started(ApplyHow::Click, now());
        None
    });
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
        app.request_restart();
    });
    Ok(())
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
    let outcome = tauri::async_runtime::spawn_blocking(move || update.install(bytes))
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
    tracing::error!("[update] the update could not be installed: {message}");
    transition(&handle, || {
        update_state::set_error(&handle, &emitter, message.clone())
    });
    Err(AppCommandError::task_execution_failed(message))
}
