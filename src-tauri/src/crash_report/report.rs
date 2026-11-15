//! From what runs left behind to the reports that are sent: one report per
//! run that did not end normally, carrying everything else that run left, and
//! one per panic or hang of a run that did. Scrubbing happens here.

use std::collections::BTreeMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};

use super::macos_reports::OsReport;
use super::store::{HangMarker, PanicRecord, Phase, Record, RecoveredHang, RunMarker};
use crate::telemetry::scrub::scrub_text;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Panic,
    Hang,
    UncleanExit,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Panic => "panic",
            Kind::Hang => "hang",
            Kind::UncleanExit => "unclean-exit",
        }
    }
}

/// One event, ready to be put in an envelope: everything in it is scrubbed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Report {
    pub event_id: String,
    pub kind: Kind,
    /// It ended the app.
    pub fatal: bool,
    /// When it happened, as near as is known (Unix seconds).
    pub at: i64,
    /// The app's version in the run it happened in.
    pub version: String,
    pub os: String,
    pub message: String,
    pub fingerprint: Vec<String>,
    pub details: Map<String, Value>,
}

/// Runs leave at most this many of their panics and recovered hangs.
pub const MAX_PER_RUN: usize = 3;

/// The longest thread name kept.
const MAX_THREAD_CHARS: usize = 64;

/// Double-quoted text (with `\"` escapes, as `Debug` prints strings), and
/// text in Chinese / Japanese quotes. Single quotes are left alone: in English
/// they are mostly apostrophes, and Rust's own messages use them for thread
/// names.
static QUOTED: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r#""(?:[^"\\\n]|\\.)*"|“[^”\n]*”|「[^」\n]*」"#).expect("crash report quote pattern")
});

/// A message with what is quoted in it taken out, then scrubbed like
/// everything the server sends (`telemetry::scrub`).
pub fn scrub_message(text: &str) -> String {
    let unquoted = QUOTED.replace_all(text, |c: &regex::Captures| {
        let quoted = &c[0];
        let open = quoted.chars().next().unwrap_or('"');
        let close = quoted.chars().next_back().unwrap_or('"');
        format!("{open}…{close}")
    });
    scrub_text(&unquoted)
}

/// A panic location, `file:line:column`, reduced to where in which crate:
/// a dependency's `…/.cargo/registry/src/<index>/tokio-1.47.1/src/x.rs` keeps
/// `tokio-1.47.1/src/x.rs`, the standard library's `/rustc/<hash>/library/…`
/// keeps `library/…`, a relative path (this crate's own) stays, and any other
/// absolute path keeps its last three parts. The builder's home directory
/// never leaves.
pub fn scrub_location(location: &str) -> String {
    let mut parts = location.rsplitn(3, ':');
    let (col, line, file) = (parts.next(), parts.next(), parts.next());
    let numeric =
        |s: Option<&str>| s.is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
    let (file, suffix) = match (file, numeric(line), numeric(col)) {
        (Some(file), true, true) => (
            file,
            format!(":{}:{}", line.unwrap_or(""), col.unwrap_or("")),
        ),
        _ => (location, String::new()),
    };
    let file = file.replace('\\', "/");
    let short = if let Some((_, rest)) = file.split_once("/registry/src/") {
        rest.split_once('/')
            .map_or(rest, |(_, crate_path)| crate_path)
            .to_string()
    } else if let Some(at) = file
        .find("/library/")
        .filter(|_| file.starts_with("/rustc/"))
    {
        file[at + 1..].to_string()
    } else if !is_absolute(&file) {
        file.clone()
    } else {
        let mut tail: Vec<&str> = file.rsplit('/').take(3).collect();
        tail.reverse();
        format!("…/{}", tail.join("/"))
    };
    format!("{short}{suffix}")
}

fn is_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    path.starts_with('/') || (bytes.len() > 2 && bytes[1] == b':' && bytes[2] == b'/')
}

fn scrub_thread(name: &str) -> String {
    scrub_text(name).chars().take(MAX_THREAD_CHARS).collect()
}

fn new_event_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

/// What one run left behind.
#[derive(Default)]
struct RunLeft {
    run: Option<RunMarker>,
    hang: Option<HangMarker>,
    recovered: Vec<RecoveredHang>,
    panics: Vec<PanicRecord>,
}

fn phase_value(phase: &Phase) -> Value {
    serde_json::to_value(phase).unwrap_or(Value::Null)
}

fn panic_value(panic: &PanicRecord) -> Value {
    json!({
        "thread": scrub_thread(&panic.thread),
        "main_thread": panic.main_thread,
        "location": scrub_location(&panic.location),
        "message": scrub_message(&panic.message),
    })
}

fn recovered_value(hang: &RecoveredHang) -> Value {
    json!({
        "side": hang.side,
        "stuck_secs": hang.stuck_secs,
        "phase": phase_value(&hang.phase),
    })
}

fn os_report_value(report: &OsReport) -> Value {
    let fields: Map<String, Value> = report
        .fields
        .iter()
        .map(|(k, v)| (k.clone(), Value::String(scrub_message(v))))
        .collect();
    json!({ "type": report.kind, "modified": report.modified, "fields": fields })
}

fn panic_report(panic: &PanicRecord, fatal: bool, os: &str) -> Report {
    let location = scrub_location(&panic.location);
    let mut details = Map::new();
    details.insert("panic".to_string(), panic_value(panic));
    Report {
        event_id: new_event_id(),
        kind: Kind::Panic,
        fatal,
        at: panic.at,
        version: panic.version.clone(),
        os: os.to_string(),
        message: format!("panic at {location}: {}", scrub_message(&panic.message)),
        fingerprint: vec!["desktop-native".to_string(), "panic".to_string(), location],
        details,
    }
}

fn recovered_report(hang: &RecoveredHang, os: &str) -> Report {
    let mut details = Map::new();
    details.insert("hang".to_string(), recovered_value(hang));
    details.insert("recovered".to_string(), Value::Bool(true));
    Report {
        event_id: new_event_id(),
        kind: Kind::Hang,
        fatal: false,
        at: hang.since,
        version: hang.version.clone(),
        os: os.to_string(),
        message: format!(
            "the {} thread did not answer for {} s, then recovered",
            hang.side, hang.stuck_secs
        ),
        fingerprint: vec![
            "desktop-native".to_string(),
            "hang".to_string(),
            hang.side.clone(),
            hang.phase.label(),
            "recovered".to_string(),
        ],
        details,
    }
}

/// The one report of a run that did not end normally (its `run` marker was
/// still there). Its kind is what explains the end best: a hang the app was
/// ended in, else a panic on the main thread (which ends the app), else just
/// that it ended.
fn unclean_report(marker: &RunMarker, left: &RunLeft, os: &str) -> Report {
    let mut details = Map::new();
    details.insert(
        "run_secs".to_string(),
        json!((marker.alive_at - marker.started_at).max(0)),
    );
    details.insert("phase".to_string(), phase_value(&marker.phase));

    let fatal_panic = left.panics.iter().rev().find(|p| p.main_thread);
    let mut report = if let Some(hang) = &left.hang {
        details.insert(
            "hang".to_string(),
            json!({
                "sides": hang.sides,
                "stuck_secs": hang.stuck_secs,
                "phase": phase_value(&hang.phase),
            }),
        );
        Report {
            event_id: new_event_id(),
            kind: Kind::Hang,
            fatal: true,
            at: hang.since,
            version: hang.version.clone(),
            os: os.to_string(),
            message: format!(
                "the {} thread did not answer for {} s, and the app was ended while it hung",
                hang.sides.join(" and "),
                hang.stuck_secs
            ),
            fingerprint: vec![
                "desktop-native".to_string(),
                "hang".to_string(),
                hang.sides.join("+"),
                hang.phase.label(),
            ],
            details: Map::new(),
        }
    } else if let Some(panic) = fatal_panic {
        panic_report(panic, true, os)
    } else {
        Report {
            event_id: new_event_id(),
            kind: Kind::UncleanExit,
            fatal: true,
            at: marker.alive_at,
            version: marker.version.clone(),
            os: os.to_string(),
            message: format!(
                "the app ended without quitting (crash, kill or force quit) while {}",
                marker.phase.label()
            ),
            fingerprint: vec![
                "desktop-native".to_string(),
                "unclean-exit".to_string(),
                marker.phase.label(),
            ],
            details: Map::new(),
        }
    };
    // The panic the report is about is not listed again among the others.
    let reported = fatal_panic.filter(|_| report.kind == Kind::Panic);
    let panics: Vec<Value> = left
        .panics
        .iter()
        .filter(|p| reported.is_none_or(|r| !std::ptr::eq(*p, r)))
        .map(panic_value)
        .collect();
    if !panics.is_empty() {
        details.insert("panics".to_string(), Value::Array(panics));
    }
    if !left.recovered.is_empty() {
        let recovered = left.recovered.iter().map(recovered_value).collect();
        details.insert("recovered_hangs".to_string(), Value::Array(recovered));
    }
    report.details.extend(details);
    report
}

/// Turn the records of every run but `current` into reports, and attach the
/// macOS reports found since the last look to the newest report of a run that
/// did not end normally (or report them on their own when there is none).
pub fn collect(
    records: Vec<Record>,
    current: &str,
    os_reports: &[OsReport],
    os: &str,
) -> Vec<Report> {
    let mut runs: BTreeMap<String, RunLeft> = BTreeMap::new();
    for record in records {
        if record.run() == current {
            continue;
        }
        let left = runs.entry(record.run().to_string()).or_default();
        match record {
            Record::Run(r) => left.run = Some(r),
            Record::Hang(r) => left.hang = Some(r),
            Record::Recovered(r) => left.recovered.push(r),
            Record::Panic(r) => left.panics.push(r),
        }
    }

    let mut reports = Vec::new();
    let mut newest_unclean: Option<usize> = None;
    for left in runs.values_mut() {
        left.panics.sort_by_key(|p| p.at);
        left.panics.truncate(MAX_PER_RUN);
        left.recovered.sort_by_key(|h| h.since);
        left.recovered.truncate(MAX_PER_RUN);
        match &left.run {
            Some(marker) => {
                let report = unclean_report(marker, left, os);
                let newer = newest_unclean.is_none_or(|i| reports_at(&reports, i) <= report.at);
                reports.push(report);
                if newer {
                    newest_unclean = Some(reports.len() - 1);
                }
            }
            None => {
                // A hang still marked when the app quit normally: the quit
                // finished before the watchdog saw the answer.
                if let Some(hang) = &left.hang {
                    let side = hang.sides.join("+");
                    let recovered = RecoveredHang {
                        run: hang.run.clone(),
                        version: hang.version.clone(),
                        since: hang.since,
                        side,
                        stuck_secs: hang.stuck_secs,
                        phase: hang.phase.clone(),
                    };
                    reports.push(recovered_report(&recovered, os));
                }
                reports.extend(left.recovered.iter().map(|h| recovered_report(h, os)));
                reports.extend(left.panics.iter().map(|p| panic_report(p, false, os)));
            }
        }
    }

    if !os_reports.is_empty() {
        let values: Vec<Value> = os_reports.iter().map(os_report_value).collect();
        match newest_unclean {
            Some(i) => {
                reports[i]
                    .details
                    .insert("os_reports".to_string(), Value::Array(values));
            }
            None => reports.push(os_only_report(os_reports, values, os)),
        }
    }
    reports
}

fn reports_at(reports: &[Report], i: usize) -> i64 {
    reports.get(i).map_or(i64::MIN, |r| r.at)
}

/// macOS recorded a hang or a crash of the app, and the app itself left
/// nothing about it (its switch was on, so it would have; the run ended
/// normally after recovering, or the report came from a launch that never got
/// as far as `setup`).
fn os_only_report(os_reports: &[OsReport], values: Vec<Value>, os: &str) -> Report {
    let newest = os_reports.iter().max_by_key(|r| r.modified);
    let hang = os_reports.iter().any(|r| r.kind == "hang");
    let version = newest
        .and_then(|r| {
            r.fields
                .get("app_version")
                .or_else(|| r.fields.get("Version"))
        })
        .map(|v| v.split_whitespace().next().unwrap_or("").to_string())
        .unwrap_or_default();
    let (kind, message) = if hang {
        (Kind::Hang, "macOS recorded the app hanging")
    } else {
        (Kind::UncleanExit, "macOS recorded the app crashing")
    };
    let mut details = Map::new();
    details.insert("os_reports".to_string(), Value::Array(values));
    details.insert(
        "source".to_string(),
        Value::String("macos-report".to_string()),
    );
    Report {
        event_id: new_event_id(),
        kind,
        fatal: !hang,
        at: newest.map_or(0, |r| r.modified),
        version,
        os: os.to_string(),
        message: message.to_string(),
        fingerprint: vec![
            "desktop-native".to_string(),
            kind.as_str().to_string(),
            "macos-report".to_string(),
        ],
        details,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(run: &str, phase: Phase) -> Record {
        Record::Run(RunMarker {
            run: run.to_string(),
            version: "1.6.11".to_string(),
            started_at: 100,
            alive_at: 400,
            phase,
        })
    }

    fn panic(run: &str, at: i64, main_thread: bool) -> Record {
        Record::Panic(PanicRecord {
            run: run.to_string(),
            version: "1.6.11".to_string(),
            at,
            thread: if main_thread {
                "main"
            } else {
                "tokio-runtime-worker"
            }
            .to_string(),
            main_thread,
            location: "/Users/someone/work/app/src-tauri/src/acp/manager.rs:12:5".to_string(),
            message: "failed to open \"/Users/someone/secret project/notes.md\"".to_string(),
        })
    }

    fn quitting_for_update() -> Phase {
        Phase {
            update: Some("restarting".to_string()),
            quitting: true,
        }
    }

    #[test]
    fn quoted_text_and_home_paths_are_taken_out() {
        let scrubbed = scrub_message(
            "called `Result::unwrap()` on an `Err` value: Os { code: 2, message: \"No such \\\"file\\\"\" } at /Users/someone/x/y.rs",
        );
        assert!(scrubbed.contains("`Result::unwrap()`"), "{scrubbed}");
        assert!(scrubbed.contains("message: \"…\""), "{scrubbed}");
        assert!(!scrubbed.contains("someone"), "{scrubbed}");
        assert!(!scrubbed.contains("file"), "{scrubbed}");

        assert_eq!(scrub_message("名为“秘密项目”的项目"), "名为“…”的项目");
        assert_eq!(scrub_message("打不开「草稿」"), "打不开「…」");
        // Apostrophes and thread names stay.
        assert_eq!(
            scrub_message("thread 'main' can't go on"),
            "thread 'main' can't go on"
        );
    }

    #[test]
    fn locations_keep_only_where_in_which_crate() {
        assert_eq!(
            scrub_location("src/acp/manager.rs:12:5"),
            "src/acp/manager.rs:12:5"
        );
        assert_eq!(
            scrub_location(
                "/Users/runner/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/tokio-1.47.1/src/runtime/park.rs:200:9"
            ),
            "tokio-1.47.1/src/runtime/park.rs:200:9"
        );
        assert_eq!(
            scrub_location(
                "/rustc/90b35a6239c3d8bdabc530a6a0816f7ff89a0aaf/library/core/src/option.rs:2009:5"
            ),
            "library/core/src/option.rs:2009:5"
        );
        assert_eq!(
            scrub_location("/home/someone/work/app/src-tauri/src/lib.rs:7:1"),
            "…/src-tauri/src/lib.rs:7:1"
        );
        assert_eq!(
            scrub_location(
                "C:\\Users\\someone\\.cargo\\registry\\src\\idx\\tao-0.34.0\\src\\a.rs:1:2"
            ),
            "tao-0.34.0/src/a.rs:1:2"
        );
        assert_eq!(scrub_location(""), "");
    }

    #[test]
    fn a_hang_the_app_was_ended_in_is_one_report_with_the_rest_attached() {
        let records = vec![
            run("1-1", quitting_for_update()),
            Record::Hang(HangMarker {
                run: "1-1".to_string(),
                version: "1.6.11".to_string(),
                since: 390,
                sides: vec!["tokio".to_string()],
                stuck_secs: 45,
                phase: quitting_for_update(),
            }),
            panic("1-1", 200, false),
            Record::Recovered(RecoveredHang {
                run: "1-1".to_string(),
                version: "1.6.11".to_string(),
                since: 150,
                side: "main".to_string(),
                stuck_secs: 12,
                phase: Phase::default(),
            }),
        ];
        let reports = collect(records, "2-2", &[], "macos");
        assert_eq!(reports.len(), 1);
        let r = &reports[0];
        assert_eq!(r.kind, Kind::Hang);
        assert!(r.fatal);
        assert_eq!(r.at, 390);
        assert_eq!(r.version, "1.6.11");
        assert_eq!(r.fingerprint[3], "quitting+update:restarting");
        assert_eq!(r.details["hang"]["stuck_secs"], 45);
        assert_eq!(r.details["run_secs"], 300);
        assert_eq!(r.details["phase"]["update"], "restarting");
        assert_eq!(r.details["panics"].as_array().unwrap().len(), 1);
        assert_eq!(r.details["recovered_hangs"][0]["side"], "main");
        let text = serde_json::to_string(r).unwrap();
        assert!(!text.contains("someone"), "{text}");
        assert!(!text.contains("secret"), "{text}");
    }

    #[test]
    fn a_main_thread_panic_explains_an_unclean_exit() {
        let records = vec![
            run("1-1", Phase::default()),
            panic("1-1", 300, false),
            panic("1-1", 350, true),
        ];
        let reports = collect(records, "2-2", &[], "macos");
        assert_eq!(reports.len(), 1);
        let r = &reports[0];
        assert_eq!(r.kind, Kind::Panic);
        assert!(r.fatal);
        assert_eq!(r.at, 350);
        assert!(r.message.starts_with("panic at …/src/acp/manager.rs:12:5"));
        assert_eq!(r.details["panic"]["thread"], "main");
        // The other panic of that run rides along; the fatal one is not
        // listed twice.
        assert_eq!(r.details["panics"].as_array().unwrap().len(), 1);
        assert_eq!(r.details["panics"][0]["main_thread"].as_bool(), Some(false));
    }

    #[test]
    fn otherwise_it_is_an_unclean_exit() {
        let reports = collect(vec![run("1-1", Phase::default())], "2-2", &[], "linux");
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].kind, Kind::UncleanExit);
        assert_eq!(reports[0].at, 400);
        assert_eq!(reports[0].os, "linux");
    }

    #[test]
    fn a_normal_run_reports_its_panics_and_hangs_one_by_one() {
        let records = vec![
            panic("1-1", 10, false),
            panic("1-1", 20, false),
            Record::Recovered(RecoveredHang {
                run: "1-1".to_string(),
                version: "1.6.11".to_string(),
                since: 30,
                side: "main".to_string(),
                stuck_secs: 11,
                phase: Phase::default(),
            }),
            Record::Hang(HangMarker {
                run: "1-1".to_string(),
                version: "1.6.11".to_string(),
                since: 40,
                sides: vec!["main".to_string()],
                stuck_secs: 14,
                phase: Phase {
                    update: None,
                    quitting: true,
                },
            }),
        ];
        let reports = collect(records, "2-2", &[], "macos");
        assert_eq!(reports.len(), 4);
        assert!(reports.iter().all(|r| !r.fatal));
        let hangs: Vec<&Report> = reports.iter().filter(|r| r.kind == Kind::Hang).collect();
        assert_eq!(hangs.len(), 2);
        assert!(hangs
            .iter()
            .all(|r| r.details["recovered"].as_bool() == Some(true)));
    }

    #[test]
    fn the_current_run_is_left_alone() {
        let records = vec![run("2-2", Phase::default()), panic("2-2", 1, true)];
        assert!(collect(records, "2-2", &[], "macos").is_empty());
    }

    #[test]
    fn macos_reports_go_with_the_newest_unclean_run_or_alone() {
        let os_report = OsReport {
            kind: "hang".to_string(),
            modified: 395,
            fields: BTreeMap::from([
                ("Duration".to_string(), "47.12s".to_string()),
                ("Version".to_string(), "1.6.11 (1.6.11)".to_string()),
            ]),
        };
        let reports = collect(
            vec![run("1-1", Phase::default())],
            "2-2",
            std::slice::from_ref(&os_report),
            "macos",
        );
        assert_eq!(reports.len(), 1);
        assert_eq!(reports[0].details["os_reports"][0]["type"], "hang");
        assert_eq!(
            reports[0].details["os_reports"][0]["fields"]["Duration"],
            "47.12s"
        );

        let alone = collect(Vec::new(), "2-2", std::slice::from_ref(&os_report), "macos");
        assert_eq!(alone.len(), 1);
        assert_eq!(alone[0].kind, Kind::Hang);
        assert_eq!(alone[0].version, "1.6.11");
        assert_eq!(alone[0].at, 395);
        assert_eq!(alone[0].details["source"], "macos-report");
    }

    #[test]
    fn a_run_keeps_at_most_three_of_each() {
        let mut records = vec![];
        for at in 0..6 {
            records.push(panic("1-1", at, false));
        }
        assert_eq!(collect(records, "2-2", &[], "macos").len(), MAX_PER_RUN);
    }
}
