//! What macOS itself recorded about the app: the `codeg*.hang` (spindump) and
//! `codeg*.ips` (crash) reports under `/Library/Logs/DiagnosticReports/` and
//! `~/Library/Logs/DiagnosticReports/`. Only a few header fields are taken —
//! the files themselves carry paths, the user name and the host name (the
//! file name has the host name too, so nothing is taken from it but the type).
//!
//! Only macOS looks ([`scan`]); elsewhere only the tests use the parsers.
#![cfg_attr(not(target_os = "macos"), allow(dead_code))]

use std::collections::BTreeMap;

/// One report of macOS's, reduced to what may leave the machine.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OsReport {
    /// `hang` or `ips`.
    pub kind: String,
    /// When the file was written (Unix seconds).
    pub modified: i64,
    pub fields: BTreeMap<String, String>,
}

/// Fields of an `.ips` file's first line (a JSON header) that are kept.
const IPS_FIELDS: &[&str] = &["bug_type", "app_version", "os_version", "timestamp"];
/// `Key: value` lines at the top of a `.hang` file that are kept.
const HANG_FIELDS: &[&str] = &[
    "Date/Time",
    "Duration",
    "Steps",
    "Event",
    "OS Version",
    "Version",
];
/// How far into a `.hang` file its header is looked for.
const HANG_HEADER_LINES: usize = 60;
/// The longest value kept.
const MAX_VALUE_CHARS: usize = 80;
/// At most this many reports go with one start's reports.
pub const MAX_OS_REPORTS: usize = 5;

/// The kind of report `name` is, when it is one of the app's.
pub fn report_kind(name: &str) -> Option<&'static str> {
    if !name.starts_with("codeg") {
        return None;
    }
    if name.ends_with(".hang") {
        Some("hang")
    } else if name.ends_with(".ips") {
        Some("ips")
    } else {
        None
    }
}

fn keep(value: &str) -> String {
    value.trim().chars().take(MAX_VALUE_CHARS).collect()
}

/// The kept fields of an `.ips` file, from its first line.
pub fn parse_ips_header(first_line: &str) -> BTreeMap<String, String> {
    let Ok(serde_json::Value::Object(header)) = serde_json::from_str(first_line.trim()) else {
        return BTreeMap::new();
    };
    IPS_FIELDS
        .iter()
        .filter_map(|name| {
            let value = match header.get(*name)? {
                serde_json::Value::String(s) => s.clone(),
                serde_json::Value::Number(n) => n.to_string(),
                _ => return None,
            };
            Some((name.to_string(), keep(&value)))
        })
        .collect()
}

/// The kept fields of a `.hang` file: the first of each wanted `Key: value`
/// line near the top (later sections repeat some keys for other processes).
pub fn parse_hang_header(text: &str) -> BTreeMap<String, String> {
    let mut fields = BTreeMap::new();
    for line in text.lines().take(HANG_HEADER_LINES) {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let key = key.trim();
        if HANG_FIELDS.contains(&key) && !fields.contains_key(key) {
            fields.insert(key.to_string(), keep(value));
        }
    }
    fields
}

/// The app's reports in both directories written after `after` (Unix
/// seconds), newest first, at most [`MAX_OS_REPORTS`]. Anything unreadable is
/// skipped.
#[cfg(target_os = "macos")]
pub fn scan(after: i64) -> Vec<OsReport> {
    use std::io::Read;

    let mut dirs = vec![std::path::PathBuf::from("/Library/Logs/DiagnosticReports")];
    if let Some(home) = dirs::home_dir() {
        dirs.push(home.join("Library/Logs/DiagnosticReports"));
    }
    let mut found: Vec<(i64, String, std::path::PathBuf)> = Vec::new();
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let Some(kind) = report_kind(&name) else {
                continue;
            };
            let Some(modified) = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .and_then(|d| i64::try_from(d.as_secs()).ok())
            else {
                continue;
            };
            if modified > after {
                found.push((modified, kind.to_string(), entry.path()));
            }
        }
    }
    found.sort_by_key(|a| std::cmp::Reverse(a.0));
    found.truncate(MAX_OS_REPORTS);
    found
        .into_iter()
        .filter_map(|(modified, kind, path)| {
            let mut head = Vec::new();
            std::fs::File::open(&path)
                .ok()?
                .take(16 * 1024)
                .read_to_end(&mut head)
                .ok()?;
            let head = String::from_utf8_lossy(&head);
            let fields = if kind == "ips" {
                parse_ips_header(head.lines().next().unwrap_or(""))
            } else {
                parse_hang_header(&head)
            };
            Some(OsReport {
                kind,
                modified,
                fields,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_apps_reports_count() {
        assert_eq!(
            report_kind("codeg_2026-11-15-103012_some-host.hang"),
            Some("hang")
        );
        assert_eq!(report_kind("codeg-2026-11-15-103012.ips"), Some("ips"));
        assert_eq!(report_kind("Safari-2026-11-15-103012.ips"), None);
        assert_eq!(report_kind("codeg_2026-11-15.diag"), None);
    }

    #[test]
    fn an_ips_header_keeps_four_fields() {
        let line = r#"{"app_name":"codeg","timestamp":"2026-11-15 10:30:12.00 +0800","app_version":"1.6.11","slice_uuid":"x","build_version":"1.6.11","platform":1,"bundleID":"app.codeg","bug_type":"309","os_version":"macOS 26.1 (25B78)","incident_id":"y","name":"codeg"}"#;
        let fields = parse_ips_header(line);
        assert_eq!(fields.len(), 4);
        assert_eq!(fields["bug_type"], "309");
        assert_eq!(fields["app_version"], "1.6.11");
        assert_eq!(fields["os_version"], "macOS 26.1 (25B78)");
        assert!(!fields.contains_key("incident_id"));
        assert!(parse_ips_header("not json").is_empty());
    }

    #[test]
    fn a_hang_header_keeps_the_first_of_each_wanted_line() {
        let text = "Date/Time:        2026-11-15 10:31:01.123 +0800\n\
                    End time:         2026-11-15 10:31:48.456 +0800\n\
                    OS Version:       macOS 26.1 (Build 25B78)\n\
                    Architecture:     arm64e\n\
                    Duration:         47.33s\n\
                    Steps:            474 (100ms sampling interval)\n\
                    Command:          codeg\n\
                    Path:             /Applications/dodoer.app/Contents/MacOS/codeg\n\
                    Version:          1.6.11 (1.6.11)\n\
                    Event:            hang\n\
                    \n\
                    Process:          WindowServer [123]\n\
                    Version:          27.0 (27.0)\n";
        let fields = parse_hang_header(text);
        assert_eq!(fields["Duration"], "47.33s");
        assert_eq!(fields["Event"], "hang");
        assert_eq!(fields["Version"], "1.6.11 (1.6.11)");
        assert_eq!(fields["Date/Time"], "2026-11-15 10:31:01.123 +0800");
        assert!(!fields.contains_key("Path"));
        assert!(!fields.contains_key("Command"));
        assert_eq!(fields.len(), 6);
    }
}
