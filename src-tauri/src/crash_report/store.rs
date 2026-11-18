//! The files under `crash-reports/`: what a run leaves behind for the next
//! start (markers and raw records), and the finished reports waiting to be
//! sent (`pending/`). Every write goes to a temporary file first and is renamed
//! into place, so a reader never sees half a record.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::report::{Kind, Report};
use super::stack::Frame;

/// Finished reports waiting to be sent, one file each.
const PENDING_DIR: &str = "pending";
/// When macOS's own reports were last looked at.
const STATE_FILE: &str = "state.json";

/// At most this many reports wait to be sent; the oldest go first.
pub const MAX_PENDING: usize = 5;
/// Update reports (`Kind::Update`) wait apart: at most this many, the
/// oldest go first, and they never take the place of a crash report.
pub const MAX_PENDING_UPDATES: usize = 3;
/// A report not sent within this long is dropped.
pub const PENDING_MAX_AGE_SECS: i64 = 7 * 24 * 60 * 60;

/// What the app was doing, from state that exists anyway: the update
/// lifecycle (`update::state`) when it is not idle, and whether the quit in
/// `shut_down` has begun.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Phase {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub update: Option<String>,
    pub quitting: bool,
}

impl Phase {
    /// A short label for grouping (`quitting`, `update:restarting`, `running`).
    pub fn label(&self) -> String {
        match (&self.update, self.quitting) {
            (Some(update), true) => format!("quitting+update:{update}"),
            (Some(update), false) => format!("update:{update}"),
            (None, true) => "quitting".to_string(),
            (None, false) => "running".to_string(),
        }
    }
}

/// "Running": written at start, kept fresh while the app runs, removed at the
/// end of a normal quit. Still there at the next start = that run ended some
/// other way.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunMarker {
    pub run: String,
    pub version: String,
    pub started_at: i64,
    /// Last time the watchdog saw the app alive.
    pub alive_at: i64,
    #[serde(default)]
    pub phase: Phase,
}

/// "Hung": one side or both have not answered for a while. Still there at the
/// next start = the app was ended while hung.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HangMarker {
    pub run: String,
    pub version: String,
    /// When the oldest unanswered heartbeat was sent.
    pub since: i64,
    /// `main` and / or `tokio`.
    pub sides: Vec<String>,
    pub stuck_secs: u64,
    #[serde(default)]
    pub phase: Phase,
    /// The main thread's stack while it hung, outermost frame first; empty
    /// when it was not the main thread, or it could not be sampled.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stack: Vec<Frame>,
}

/// A hang that ended on its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RecoveredHang {
    pub run: String,
    pub version: String,
    pub since: i64,
    pub side: String,
    pub stuck_secs: u64,
    #[serde(default)]
    pub phase: Phase,
    /// As [`HangMarker::stack`].
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub stack: Vec<Frame>,
}

/// A panic, as the hook saw it. Not scrubbed yet: that happens when the report
/// is made (`report::collect`), so the hook runs as little as possible.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PanicRecord {
    pub run: String,
    pub version: String,
    pub at: i64,
    pub thread: String,
    /// On the thread that runs the event loop, where a panic ends the app.
    pub main_thread: bool,
    pub location: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Record {
    Run(RunMarker),
    Hang(HangMarker),
    Recovered(RecoveredHang),
    Panic(PanicRecord),
}

impl Record {
    pub fn run(&self) -> &str {
        match self {
            Record::Run(r) => &r.run,
            Record::Hang(r) => &r.run,
            Record::Recovered(r) => &r.run,
            Record::Panic(r) => &r.run,
        }
    }
}

pub fn run_file(run: &str) -> String {
    format!("run-{run}.json")
}

pub fn hang_file(run: &str) -> String {
    format!("hang-{run}.json")
}

pub fn recovered_file(run: &str, n: usize) -> String {
    format!("recovered-{run}-{n}.json")
}

pub fn panic_file(run: &str, n: usize) -> String {
    format!("panic-{run}-{n}.json")
}

/// Write `value` as `dir/name`, through a temporary file.
fn write_json<T: Serialize>(dir: &Path, name: &str, value: &T) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let bytes = serde_json::to_vec(value).map_err(io::Error::other)?;
    let tmp = dir.join(format!("{name}.tmp"));
    fs::write(&tmp, bytes)?;
    fs::rename(&tmp, dir.join(name))
}

pub fn write(dir: &Path, name: &str, record: &Record) -> io::Result<()> {
    write_json(dir, name, record)
}

pub fn remove(dir: &Path, name: &str) {
    let _ = fs::remove_file(dir.join(name));
}

/// The `*.json` files directly in `dir`, by name.
fn json_files(dir: &Path) -> Vec<PathBuf> {
    let Ok(entries) = fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.is_file() && p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    files
}

/// Every record in `dir`, with its file. A file that does not parse is
/// deleted: nothing would ever read it.
pub fn read_all(dir: &Path) -> Vec<(PathBuf, Record)> {
    let mut out = Vec::new();
    for path in json_files(dir) {
        if path.file_name().is_some_and(|n| n == STATE_FILE) {
            continue;
        }
        match fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Record>(&b).ok())
        {
            Some(record) => out.push((path, record)),
            None => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    out
}

fn pending_dir(dir: &Path) -> PathBuf {
    dir.join(PENDING_DIR)
}

/// Reports waiting to be sent, oldest first. Unreadable ones are deleted.
pub fn list_pending(dir: &Path) -> Vec<(PathBuf, Report)> {
    let mut out: Vec<(PathBuf, Report)> = Vec::new();
    for path in json_files(&pending_dir(dir)) {
        match fs::read(&path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Report>(&b).ok())
        {
            Some(report) => out.push((path, report)),
            None => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    out.sort_by_key(|(_, report)| report.at);
    out
}

/// Queue `report`, then keep only what may wait ([`prune_pending`]).
pub fn push_pending(dir: &Path, report: &Report, now: i64) -> io::Result<()> {
    write_json(
        &pending_dir(dir),
        &format!("{}.json", report.event_id),
        report,
    )?;
    prune_pending(dir, now);
    Ok(())
}

/// Drop reports older than [`PENDING_MAX_AGE_SECS`], then the oldest beyond
/// [`MAX_PENDING`] crash reports and, apart from those, the oldest beyond
/// [`MAX_PENDING_UPDATES`] update reports.
pub fn prune_pending(dir: &Path, now: i64) {
    let mut crashes = Vec::new();
    let mut updates = Vec::new();
    for (path, report) in list_pending(dir) {
        if now - report.at > PENDING_MAX_AGE_SECS {
            let _ = fs::remove_file(&path);
        } else if report.kind == Kind::Update {
            updates.push(path);
        } else {
            crashes.push(path);
        }
    }
    for (kept, max) in [(crashes, MAX_PENDING), (updates, MAX_PENDING_UPDATES)] {
        let excess = kept.len().saturating_sub(max);
        for path in kept.iter().take(excess) {
            let _ = fs::remove_file(path);
        }
    }
}

#[derive(Debug, Default, Serialize, Deserialize)]
struct State {
    /// macOS reports modified up to this time (Unix seconds) have been seen.
    os_reports_seen_until: Option<i64>,
}

fn read_state(dir: &Path) -> State {
    fs::read(dir.join(STATE_FILE))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

/// Up to when macOS's reports have been looked at; `None` before the first
/// look.
pub fn os_reports_seen_until(dir: &Path) -> Option<i64> {
    read_state(dir).os_reports_seen_until
}

pub fn set_os_reports_seen_until(dir: &Path, at: i64) -> io::Result<()> {
    let mut state = read_state(dir);
    state.os_reports_seen_until = Some(at);
    write_json(dir, STATE_FILE, &state)
}

/// Forget everything: the switch was turned off.
pub fn clear(dir: &Path) {
    let _ = fs::remove_dir_all(dir);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn report(id: &str, at: i64) -> Report {
        Report {
            event_id: id.to_string(),
            kind: Kind::UncleanExit,
            fatal: true,
            at,
            version: "1.6.12".to_string(),
            os: "macos".to_string(),
            message: "the app ended".to_string(),
            fingerprint: vec!["desktop-native".to_string()],
            details: serde_json::Map::new(),
            tags: Default::default(),
        }
    }

    #[test]
    fn records_round_trip_and_garbage_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let marker = Record::Run(RunMarker {
            run: "1-2".to_string(),
            version: "1.6.12".to_string(),
            started_at: 10,
            alive_at: 70,
            phase: Phase {
                update: Some("restarting".to_string()),
                quitting: true,
            },
        });
        write(dir.path(), &run_file("1-2"), &marker).unwrap();
        fs::write(dir.path().join("broken.json"), b"{not json").unwrap();
        // A temporary file is never read as a record.
        fs::write(dir.path().join("run-3-4.json.tmp"), b"{}").unwrap();

        let all = read_all(dir.path());
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].1, marker);
        assert_eq!(all[0].1.run(), "1-2");
        assert!(!dir.path().join("broken.json").exists());

        remove(dir.path(), &run_file("1-2"));
        assert!(read_all(dir.path()).is_empty());
    }

    #[test]
    fn records_are_tagged_by_type() {
        let record = Record::Panic(PanicRecord {
            run: "1-2".to_string(),
            version: "1.6.12".to_string(),
            at: 5,
            thread: "main".to_string(),
            main_thread: true,
            location: "src/lib.rs:1:1".to_string(),
            message: "boom".to_string(),
        });
        let value = serde_json::to_value(&record).unwrap();
        assert_eq!(value["type"], "panic");
        assert_eq!(value["main_thread"].as_bool(), Some(true));
    }

    #[test]
    fn pending_keeps_the_newest_five_within_a_week() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_000_000_000;
        // One a day for eight days, the oldest pushed first.
        for day in 0..8 {
            let at = now - (7 - day) * 24 * 60 * 60 - 60;
            push_pending(dir.path(), &report(&format!("id{day}"), at), now).unwrap();
        }
        let left: Vec<String> = list_pending(dir.path())
            .into_iter()
            .map(|(_, r)| r.event_id)
            .collect();
        assert_eq!(left, ["id3", "id4", "id5", "id6", "id7"]);

        // A week later, all of them are too old.
        prune_pending(dir.path(), now + PENDING_MAX_AGE_SECS + 1);
        assert!(list_pending(dir.path()).is_empty());
    }

    #[test]
    fn update_reports_and_crash_reports_do_not_crowd_each_other_out() {
        let dir = tempfile::tempdir().unwrap();
        let now = 1_000_000_000;
        for n in 0..5 {
            push_pending(
                dir.path(),
                &report(&format!("crash{n}"), now - 100 + n),
                now,
            )
            .unwrap();
        }
        for n in 0..4 {
            let mut update = report(&format!("update{n}"), now - 50 + n);
            update.kind = Kind::Update;
            push_pending(dir.path(), &update, now).unwrap();
        }
        let left: Vec<String> = list_pending(dir.path())
            .into_iter()
            .map(|(_, r)| r.event_id)
            .collect();
        assert_eq!(
            left,
            ["crash0", "crash1", "crash2", "crash3", "crash4", "update1", "update2", "update3"]
        );
        // A sixth crash report pushes out the oldest crash report, not an update.
        push_pending(dir.path(), &report("crash5", now - 10), now).unwrap();
        let left: Vec<String> = list_pending(dir.path())
            .into_iter()
            .map(|(_, r)| r.event_id)
            .collect();
        assert_eq!(
            left,
            ["crash1", "crash2", "crash3", "crash4", "update1", "update2", "update3", "crash5"]
        );
    }

    #[test]
    fn the_os_report_watermark_is_kept_and_clear_forgets_all() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("crash-reports");
        assert_eq!(os_reports_seen_until(&root), None);
        set_os_reports_seen_until(&root, 42).unwrap();
        assert_eq!(os_reports_seen_until(&root), Some(42));
        // The state file is not a record.
        assert!(read_all(&root).is_empty());
        clear(&root);
        assert!(!root.exists());
    }

    #[test]
    fn phases_have_short_labels() {
        assert_eq!(Phase::default().label(), "running");
        let quitting = Phase {
            update: None,
            quitting: true,
        };
        assert_eq!(quitting.label(), "quitting");
        let restarting = Phase {
            update: Some("restarting".to_string()),
            quitting: true,
        };
        assert_eq!(restarting.label(), "quitting+update:restarting");
    }
}
