//! Cowork fork: the desktop app's own crashes and hangs, reported at the next
//! start through the Cowork server the app is connected to
//! (docs/telemetry.md §5.11). Off unless the person turns on "Send desktop
//! crash and hang reports" (`preferences.json` → `crash_reports`); while off
//! nothing is written and nothing is sent.
//!
//! A crash or a hang cannot report itself, so a run leaves files behind
//! instead ([`store`]), and the next start turns them into reports
//! ([`report`]) and sends them ([`send`]):
//!
//! * a "running" marker, written at start and removed at the end of a normal
//!   quit (`shut_down` calls [`note_clean_exit`]);
//! * a "hung" marker while the main thread or the tokio runtime has not
//!   answered the [`watchdog`]'s heartbeat for 10 s, and a record of each hang
//!   that ended on its own;
//! * a record of each panic, from a hook chained after
//!   `logging::panic_hook`'s.
//!
//! On macOS the next start also takes a few header fields of the system's own
//! hang and crash reports of the app ([`macos_reports`]).
//!
//! The hook and the watchdog are installed whatever the switch says, so
//! turning it on takes effect at once; while it is off they write nothing.

mod envelope;
mod macos_reports;
mod report;
mod send;
mod store;
mod watchdog;

use std::panic::PanicHookInfo;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Mutex, MutexGuard, OnceLock};
use std::thread::ThreadId;

use serde::{Deserialize, Serialize};

use self::store::{HangMarker, PanicRecord, Phase, Record, RecoveredHang, RunMarker};
use crate::app_error::AppCommandError;

/// Under the data directory. A debug build keeps its own, so a `cargo run`
/// beside the installed app never reads the other's markers.
const DIR_NAME: &str = if cfg!(debug_assertions) {
    "crash-reports-dev"
} else {
    "crash-reports"
};

/// The longest panic message the hook writes down.
const MAX_PANIC_MESSAGE_BYTES: usize = 2048;

/// The switch.
static ENABLED: AtomicBool = AtomicBool::new(false);
/// The quit has finished: nothing more is written.
static STOPPED: AtomicBool = AtomicBool::new(false);
/// The quit (`shut_down`) has begun.
static QUITTING: AtomicBool = AtomicBool::new(false);
/// Panics of this run so far.
static PANICS: AtomicUsize = AtomicUsize::new(0);
/// Hangs of this run that ended on their own, so far.
static RECOVERED: AtomicUsize = AtomicUsize::new(0);
/// Taken around every write but the panic hook's, and around the removal at
/// the quit, so a marker removed then is never written back. The hook never
/// takes it: a panic while it is held would wait on itself.
static WRITE: Mutex<()> = Mutex::new(());
static RUN: OnceLock<Run> = OnceLock::new();

/// This run of the app.
struct Run {
    /// `<start in ms>-<pid>`.
    id: String,
    version: String,
    started_at: i64,
    dir: PathBuf,
    /// The thread `setup` runs on, which runs the event loop.
    main_thread: ThreadId,
}

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

fn enabled() -> bool {
    ENABLED.load(Ordering::SeqCst)
}

fn stopped() -> bool {
    STOPPED.load(Ordering::SeqCst)
}

fn quitting() -> bool {
    QUITTING.load(Ordering::SeqCst)
}

fn lock() -> MutexGuard<'static, ()> {
    WRITE.lock().unwrap_or_else(|p| p.into_inner())
}

/// `crash-reports/` in the data directory `run()` exported (as the other
/// `paths::codeg_*_root`s fall back, `~/.codeg` without one).
fn reports_dir() -> PathBuf {
    std::env::var_os("CODEG_DATA_DIR")
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| dirs::home_dir().map(|h| h.join(".codeg")))
        .unwrap_or_else(|| PathBuf::from(".codeg"))
        .join(DIR_NAME)
}

/// Run `f` with this run's files, unless the switch is off or the quit has
/// finished.
fn with_files<R>(f: impl FnOnce(&Run) -> R) -> Option<R> {
    if !enabled() || stopped() {
        return None;
    }
    let run = RUN.get()?;
    let _guard = lock();
    if !enabled() || stopped() {
        return None;
    }
    Some(f(run))
}

fn log_write_error(what: &str, result: std::io::Result<()>) {
    if let Err(e) = result {
        tracing::debug!("[crash-report] could not write the {what}: {e}");
    }
}

/// Start: called from `setup`, on the main thread, once the database is
/// managed. Not earlier: the single-instance plugin ends a second launch
/// before `setup`, and that launch would take the running app's marker for one
/// left by a crash.
pub fn start(app: &tauri::AppHandle) {
    let run = Run {
        id: format!(
            "{}-{}",
            chrono::Utc::now().timestamp_millis(),
            std::process::id()
        ),
        version: app.package_info().version.to_string(),
        started_at: now(),
        dir: reports_dir(),
        main_thread: std::thread::current().id(),
    };
    if RUN.set(run).is_err() {
        return;
    }
    install_panic_hook();
    let on = crate::preferences::load().crash_reports;
    ENABLED.store(on, Ordering::SeqCst);
    if !on {
        // Nothing is kept while the switch is off.
        if let Some(run) = RUN.get() {
            store::clear(&run.dir);
        }
    }
    write_run_marker(&Phase::default());
    watchdog::spawn(app.clone());
    if on {
        send::spawn(app.clone());
    }
}

/// The quit has begun (`shut_down`).
pub fn note_quitting() {
    QUITTING.store(true, Ordering::SeqCst);
}

/// The quit has finished (the end of `shut_down`): this run ended normally.
pub fn note_clean_exit() {
    let Some(run) = RUN.get() else {
        return;
    };
    let _guard = lock();
    STOPPED.store(true, Ordering::SeqCst);
    store::remove(&run.dir, &store::run_file(&run.id));
}

fn write_run_marker(phase: &Phase) {
    with_files(|run| {
        let marker = Record::Run(RunMarker {
            run: run.id.clone(),
            version: run.version.clone(),
            started_at: run.started_at,
            alive_at: now(),
            phase: phase.clone(),
        });
        log_write_error(
            "running marker",
            store::write(&run.dir, &store::run_file(&run.id), &marker),
        );
    });
}

fn write_hang_marker(sides: Vec<String>, stuck_secs: u64, phase: &Phase) {
    with_files(|run| {
        let marker = Record::Hang(HangMarker {
            run: run.id.clone(),
            version: run.version.clone(),
            since: now() - i64::try_from(stuck_secs).unwrap_or(0),
            sides,
            stuck_secs,
            phase: phase.clone(),
        });
        log_write_error(
            "hang marker",
            store::write(&run.dir, &store::hang_file(&run.id), &marker),
        );
    });
}

fn remove_hang_marker() {
    with_files(|run| store::remove(&run.dir, &store::hang_file(&run.id)));
}

fn write_recovered(side: &str, stuck_secs: u64, phase: &Phase) {
    with_files(|run| {
        let n = RECOVERED.fetch_add(1, Ordering::SeqCst);
        if n >= report::MAX_PER_RUN {
            return;
        }
        let record = Record::Recovered(RecoveredHang {
            run: run.id.clone(),
            version: run.version.clone(),
            since: now() - i64::try_from(stuck_secs).unwrap_or(0),
            side: side.to_string(),
            stuck_secs,
            phase: phase.clone(),
        });
        log_write_error(
            "hang record",
            store::write(&run.dir, &store::recovered_file(&run.id, n), &record),
        );
    });
}

/// Turn what earlier runs left into reports waiting to be sent, and remove
/// it. Off the main thread (`send::spawn`): it reads directories.
fn collect_previous() {
    with_files(|run| {
        let records = store::read_all(&run.dir);
        let mut done = Vec::new();
        let mut earlier = Vec::new();
        for (path, record) in records {
            if record.run() != run.id {
                done.push(path);
                earlier.push(record);
            }
        }
        let os_reports = os_reports_since_last_look(&run.dir);
        let reports = report::collect(earlier, &run.id, &os_reports, std::env::consts::OS);
        for report in &reports {
            log_write_error(
                "pending report",
                store::push_pending(&run.dir, report, now()),
            );
        }
        for path in done {
            let _ = std::fs::remove_file(path);
        }
        store::prune_pending(&run.dir, now());
    });
}

/// macOS's reports of the app since the last look. The first look only notes
/// the time: reports from before the switch was on are not sent.
#[cfg(target_os = "macos")]
fn os_reports_since_last_look(dir: &std::path::Path) -> Vec<macos_reports::OsReport> {
    let seen = store::os_reports_seen_until(dir);
    log_write_error("state", store::set_os_reports_seen_until(dir, now()));
    seen.map(macos_reports::scan).unwrap_or_default()
}

#[cfg(not(target_os = "macos"))]
fn os_reports_since_last_look(_dir: &std::path::Path) -> Vec<macos_reports::OsReport> {
    Vec::new()
}

fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        record_panic(info);
        previous(info);
    }));
}

/// Write the panic down, raw (it is scrubbed when the report is made). Nothing
/// here may panic, and it takes no lock.
fn record_panic(info: &PanicHookInfo<'_>) {
    if !enabled() || stopped() {
        return;
    }
    let Some(run) = RUN.get() else {
        return;
    };
    let n = PANICS.fetch_add(1, Ordering::SeqCst);
    if n >= report::MAX_PER_RUN {
        return;
    }
    let thread = std::thread::current();
    let record = Record::Panic(PanicRecord {
        run: run.id.clone(),
        version: run.version.clone(),
        at: now(),
        thread: thread.name().unwrap_or("<unnamed>").to_string(),
        main_thread: thread.id() == run.main_thread,
        location: info
            .location()
            .map(|l| format!("{}:{}:{}", l.file(), l.line(), l.column()))
            .unwrap_or_default(),
        message: panic_message(info),
    });
    let _ = store::write(&run.dir, &store::panic_file(&run.id, n), &record);
}

fn panic_message(info: &PanicHookInfo<'_>) -> String {
    let payload = info.payload();
    let text = if let Some(s) = payload.downcast_ref::<&str>() {
        *s
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.as_str()
    } else {
        "<non-string panic payload>"
    };
    cut(text, MAX_PANIC_MESSAGE_BYTES).to_string()
}

/// `text` cut to at most `max` bytes, on a character boundary.
fn cut(text: &str, max: usize) -> &str {
    let mut end = max.min(text.len());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

/// The switch, as the settings page reads and writes it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CrashReportSettings {
    pub enabled: bool,
}

#[tauri::command]
pub async fn get_crash_report_settings() -> Result<CrashReportSettings, AppCommandError> {
    Ok(CrashReportSettings {
        enabled: crate::preferences::load().crash_reports,
    })
}

/// Turn the switch on or off. Off forgets everything kept so far.
#[tauri::command]
pub async fn update_crash_report_settings(
    settings: CrashReportSettings,
) -> Result<CrashReportSettings, AppCommandError> {
    let mut prefs = crate::preferences::load();
    prefs.crash_reports = settings.enabled;
    crate::preferences::save(&prefs).map_err(|err| {
        AppCommandError::io_error("Failed to save the crash report setting")
            .with_detail(err.to_string())
    })?;
    set_enabled(settings.enabled);
    Ok(settings)
}

/// The watchdog writes the running marker on its next tick.
fn set_enabled(on: bool) {
    let Some(run) = RUN.get() else {
        return;
    };
    let _guard = lock();
    if stopped() {
        return;
    }
    ENABLED.store(on, Ordering::SeqCst);
    if !on {
        store::clear(&run.dir);
    } else if store::os_reports_seen_until(&run.dir).is_none() {
        // macOS reports from before now are not this switch's to send.
        log_write_error("state", store::set_os_reports_seen_until(&run.dir, now()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn messages_are_cut_on_a_character_boundary() {
        assert_eq!(cut("abc", 10), "abc");
        assert_eq!(cut("abc", 2), "ab");
        // "é" is two bytes: cutting inside it keeps the "a" only.
        assert_eq!(cut("aé", 2), "a");
        assert_eq!(cut("", 0), "");
    }
}
