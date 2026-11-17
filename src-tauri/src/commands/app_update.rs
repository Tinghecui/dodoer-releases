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

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};

use tauri_plugin_updater::UpdaterExt;

use crate::app_error::AppCommandError;
use crate::update::restart_install::{self, RestartInstallOutcome};
use crate::update::rollback::{self, AppRollbackTarget, ReleaseSource};
use crate::update::state::{self as update_state, AppUpdateState, AppUpdateStateHandle};
use crate::web::event_bridge::EventEmitter;

/// Current update snapshot, for the renderer to re-sync on mount.
#[tauri::command]
pub fn app_update_state(state: tauri::State<'_, AppUpdateStateHandle>) -> AppUpdateState {
    update_state::snapshot(state.inner())
}

/// Begin (or attach to) a download+install of the available update. Returns
/// immediately with the current snapshot; the work runs detached and reports
/// progress via the `app_update_state` event.
#[tauri::command]
pub async fn perform_app_update(
    app: tauri::AppHandle,
    state: tauri::State<'_, AppUpdateStateHandle>,
) -> Result<AppUpdateState, AppCommandError> {
    let handle = state.inner().clone();
    let emitter = EventEmitter::Tauri(app.clone());

    let (started, snap) = update_state::try_begin(&handle, &emitter);
    if !started {
        // A download is already in flight (or staged) — attach to it.
        return Ok(snap);
    }

    tauri::async_runtime::spawn(async move {
        if let Err(message) = run_download(app, handle.clone(), emitter.clone(), None).await {
            update_state::set_error(&handle, &emitter, message);
        }
    });

    Ok(snap)
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
    let (started, snap) = update_state::try_begin(&handle, &emitter);
    if !started {
        // An update is already downloading or staged; leave it be.
        return Err(AppCommandError::invalid_input(
            "An update is already in progress",
        ));
    }
    tauri::async_runtime::spawn(async move {
        if let Err(message) =
            run_download(app, handle.clone(), emitter.clone(), Some(downgrade)).await
        {
            update_state::set_error(&handle, &emitter, message);
        }
    });

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
) -> Result<(), String> {
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

    let pe = Arc::new(update_state::ProgressEmitter::new(
        handle.clone(),
        emitter.clone(),
    ));
    let pe_chunk = pe.clone();
    let mut downloaded: u64 = 0;
    let on_chunk = move |chunk_len: usize, content_len: Option<u64>| {
        downloaded += chunk_len as u64;
        pe_chunk.downloading(downloaded, content_len);
    };
    if INSTALL_AT_RESTART {
        // Nothing gets installed until the restart, so there is no
        // `Installing` phase: the download runs to its end, then the restart
        // button takes over.
        let bytes = update
            .download(on_chunk, || {})
            .await
            .map_err(|e| e.to_string())?;
        *staged_install() = Some(StagedInstall {
            update,
            bytes,
            quit,
        });
    } else {
        let pe_finish = pe.clone();
        update
            .download_and_install(on_chunk, move || pe_finish.installing())
            .await
            .map_err(|e| e.to_string())?;
    }

    // The desktop app relaunches itself, so there is no supervisor trial or
    // restart-delay metadata to carry (those are server-only).
    update_state::set_ready(&handle, &emitter, Some(version), None, None, None);
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
    if !update_state::try_claim_restart(&handle, &emitter) {
        return Err(AppCommandError::invalid_input(
            "No staged update to restart into",
        ));
    }
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
///   carries on. The downloaded package is dropped either way; the next
///   update downloads it again.
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
        update_state::set_error(&handle, &emitter, message);
        return Err(AppCommandError::invalid_input(message));
    };
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
            // Not `restart()`, which would park this tokio worker for good (see
            // `restart_app`).
            tracing::info!("[update] relaunching into the installed update");
            app.request_restart();
            return Ok(());
        }
        RestartInstallOutcome::Failed(message) => message,
    };
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
    update_state::set_error(&handle, &emitter, message.clone());
    Err(AppCommandError::task_execution_failed(message))
}
