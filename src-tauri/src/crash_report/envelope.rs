//! A report as a Sentry error event, in the envelope the server's
//! `/api/telemetry_envelope` forwards (`telemetry::forward_envelope`). The
//! server takes it when the envelope names its web DSN, which is the one its
//! `cowork_info` hands out; nothing else in it is checked.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Map, Value};

use super::report::{Kind, Report};

/// What the server said to report under (`cowork_info.telemetry`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub dsn: String,
    pub environment: String,
    pub user: String,
}

impl Target {
    /// From `cowork_info`'s answer, when it carries a telemetry config.
    pub fn from_cowork_info(info: &Value) -> Option<Self> {
        let telemetry = info.get("telemetry")?;
        let text = |key: &str| {
            telemetry
                .get(key)
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let dsn = text("dsn").filter(|d| !d.trim().is_empty())?;
        Some(Self {
            dsn,
            environment: text("environment").unwrap_or_else(|| "production".to_string()),
            user: text("user").unwrap_or_default(),
        })
    }
}

/// Every report's tag `surface`.
pub const SURFACE: &str = "desktop-native";

/// The release a report is filed under: the desktop app's version in the run
/// it happened in.
pub fn release(version: &str) -> String {
    format!("dodoer-desktop@{version}")
}

fn level(report: &Report) -> &'static str {
    if report.kind == Kind::Update {
        // Cowork fork: a successful update is a record, not a problem.
        return match report.tags.get("update_result").map(String::as_str) {
            Some("applied") => "info",
            Some("waiting_long") => "warning",
            // The network between this machine and the release host, not the
            // app: it tries again at the next check.
            Some("download_failed") if download_blocked_by_network(report) => "warning",
            _ => "error",
        };
    }
    match (report.kind, report.fatal) {
        (_, true) => "fatal",
        (Kind::Panic, false) => "error",
        (_, false) => "warning",
    }
}

/// A download (or the check before it) that failed on the way to the release
/// host: `error_kind` is `network` or `source_unreachable`.
fn download_blocked_by_network(report: &Report) -> bool {
    matches!(
        report.details.get("error_kind").and_then(Value::as_str),
        Some("network" | "source_unreachable")
    )
}

fn exception_type(kind: Kind) -> &'static str {
    match kind {
        Kind::Panic => "Panic",
        Kind::Hang => "Hang",
        Kind::UncleanExit => "UncleanExit",
        Kind::Update => "Update",
    }
}

/// The stack of the hang a report is about (`details.hang.stack`,
/// `report::with_stack`), taken out of the details and turned into the frames
/// of a Sentry stack trace: outermost first, as it was sampled.
fn take_hang_stack(details: &mut Map<String, Value>) -> Option<Value> {
    let stack = details.get_mut("hang")?.as_object_mut()?.remove("stack")?;
    let frames: Vec<Value> = stack
        .as_array()?
        .iter()
        .map(|frame| json!({ "function": frame["function"], "package": frame["image"] }))
        .collect();
    (!frames.is_empty()).then(|| json!({ "frames": frames }))
}

/// The event's JSON.
pub fn event(report: &Report, target: &Target) -> Value {
    let mut details = report.details.clone();
    let stacktrace = take_hang_stack(&mut details);
    let mut event = json!({
        "event_id": report.event_id,
        "timestamp": report.at,
        "platform": "native",
        "level": level(report),
        "logger": SURFACE,
        "release": release(&report.version),
        "environment": target.environment,
        "exception": {
            "values": [{
                "type": exception_type(report.kind),
                "value": report.message,
                "mechanism": { "type": report.kind.as_str(), "handled": !report.fatal },
            }],
        },
        "fingerprint": report.fingerprint,
        "tags": {
            "surface": SURFACE,
            "kind": report.kind.as_str(),
            "fatal": report.fatal.to_string(),
            "os": report.os,
        },
        "contexts": {
            "os": { "name": report.os },
            "app": { "app_version": report.version },
            "desktop": details,
        },
    });
    if let Some(stacktrace) = stacktrace {
        event["exception"]["values"][0]["stacktrace"] = stacktrace;
    }
    // The tags of this kind (only update reports have any) go beside the
    // fixed four, which they never replace.
    if let Some(tags) = event["tags"].as_object_mut() {
        for (key, value) in &report.tags {
            tags.entry(key.clone())
                .or_insert_with(|| Value::String(value.clone()));
        }
    }
    if !target.user.is_empty() {
        event["user"] = json!({ "id": target.user });
    }
    event
}

/// The envelope: a header naming the DSN, then one `event` item.
pub fn envelope(report: &Report, target: &Target, sent_at: DateTime<Utc>) -> String {
    let payload = event(report, target).to_string();
    let header = json!({
        "event_id": report.event_id,
        "dsn": target.dsn,
        "sent_at": sent_at.to_rfc3339_opts(SecondsFormat::Secs, true),
    });
    let item = json!({ "type": "event", "length": payload.len() });
    format!("{header}\n{item}\n{payload}\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSN: &str = "https://abc@o1.ingest.example.com/2";

    fn target() -> Target {
        Target {
            dsn: DSN.to_string(),
            environment: "ai-qa".to_string(),
            user: "pat".to_string(),
        }
    }

    fn report() -> Report {
        let mut details = serde_json::Map::new();
        details.insert("run_secs".to_string(), json!(300));
        Report {
            event_id: "0123456789abcdef0123456789abcdef".to_string(),
            kind: Kind::Hang,
            fatal: true,
            at: 1_763_200_000,
            version: "1.6.11".to_string(),
            os: "macos".to_string(),
            message: "the tokio thread did not answer for 45 s".to_string(),
            fingerprint: vec!["desktop-native".to_string(), "hang".to_string()],
            details,
            tags: Default::default(),
        }
    }

    #[test]
    fn the_target_comes_from_cowork_info() {
        let info = json!({
            "product": "Cowork",
            "telemetry": { "dsn": DSN, "environment": "ai-qa", "user": "pat", "release": "x" },
        });
        assert_eq!(Target::from_cowork_info(&info), Some(target()));
        assert_eq!(
            Target::from_cowork_info(&json!({ "product": "Cowork" })),
            None
        );
        let blank = json!({ "telemetry": { "dsn": " " } });
        assert_eq!(Target::from_cowork_info(&blank), None);
        let bare = json!({ "telemetry": { "dsn": DSN } });
        let bare = Target::from_cowork_info(&bare).unwrap();
        assert_eq!(bare.environment, "production");
        assert_eq!(bare.user, "");
    }

    #[test]
    fn the_event_is_tagged_and_filed_under_the_version_that_failed() {
        let event = event(&report(), &target());
        assert_eq!(event["release"], "dodoer-desktop@1.6.11");
        assert_eq!(event["environment"], "ai-qa");
        assert_eq!(event["level"], "fatal");
        assert_eq!(event["platform"], "native");
        assert_eq!(event["tags"]["surface"], "desktop-native");
        assert_eq!(event["tags"]["kind"], "hang");
        assert_eq!(event["tags"]["fatal"], "true");
        assert_eq!(event["user"]["id"], "pat");
        assert_eq!(event["exception"]["values"][0]["type"], "Hang");
        assert_eq!(
            event["exception"]["values"][0]["mechanism"]["handled"].as_bool(),
            Some(false)
        );
        assert_eq!(event["contexts"]["desktop"]["run_secs"], 300);
        assert_eq!(event["fingerprint"][1], "hang");

        let mut recovered = report();
        recovered.fatal = false;
        assert_eq!(super::event(&recovered, &target())["level"], "warning");
        recovered.kind = Kind::Panic;
        assert_eq!(super::event(&recovered, &target())["level"], "error");
        let anonymous = Target {
            user: String::new(),
            ..target()
        };
        assert!(super::event(&report(), &anonymous).get("user").is_none());
    }

    #[test]
    fn a_sampled_hang_shows_its_stack_as_the_stack_trace() {
        let mut hang = report();
        hang.details.insert(
            "hang".to_string(),
            json!({
                "side": "main",
                "stuck_secs": 15,
                "stack": [
                    { "function": "main", "image": "codeg" },
                    { "function": "mach_msg2_trap", "image": "libsystem_kernel.dylib" },
                ],
            }),
        );
        let event = event(&hang, &target());
        let frames = &event["exception"]["values"][0]["stacktrace"]["frames"];
        assert_eq!(frames.as_array().unwrap().len(), 2);
        assert_eq!(frames[0]["function"], "main");
        assert_eq!(frames[0]["package"], "codeg");
        assert_eq!(frames[1]["function"], "mach_msg2_trap");
        // Shown once: not in the details as well.
        assert_eq!(event["contexts"]["desktop"]["hang"]["stuck_secs"], 15);
        assert!(event["contexts"]["desktop"]["hang"].get("stack").is_none());

        // A hang that was not sampled has no stack trace.
        let plain = super::event(&report(), &target());
        assert!(plain["exception"]["values"][0].get("stacktrace").is_none());
    }

    #[test]
    fn an_update_report_carries_its_tags_and_its_level() {
        let mut update = report();
        update.kind = Kind::Update;
        update.fatal = false;
        update.version = "1.6.41".to_string();
        for (result, level) in [
            ("applied", "info"),
            ("waiting_long", "warning"),
            ("download_failed", "error"),
            ("install_failed", "error"),
            ("boot_unconfirmed", "error"),
            ("rolled_back", "error"),
        ] {
            update.tags = [
                ("update_result".to_string(), result.to_string()),
                ("update_to".to_string(), "1.6.41".to_string()),
                ("install".to_string(), "0123456789ab".to_string()),
            ]
            .into_iter()
            .collect();
            let event = event(&update, &target());
            assert_eq!(event["level"], level, "{result}");
            assert_eq!(event["tags"]["update_result"], result);
            assert_eq!(event["tags"]["update_to"], "1.6.41");
            assert_eq!(event["tags"]["install"], "0123456789ab");
            assert_eq!(event["tags"]["kind"], "update");
            assert_eq!(event["tags"]["surface"], "desktop-native");
            assert_eq!(event["release"], "dodoer-desktop@1.6.41");
            assert_eq!(event["exception"]["values"][0]["type"], "Update");
        }
        // A download the network stopped is a warning; one that failed for
        // any other reason, or for none that was recognised, stays an error.
        update.tags = [("update_result".to_string(), "download_failed".to_string())]
            .into_iter()
            .collect();
        for (error_kind, level) in [
            ("network", "warning"),
            ("source_unreachable", "warning"),
            ("signature", "error"),
            ("disk", "error"),
            ("unknown", "error"),
        ] {
            update
                .details
                .insert("error_kind".to_string(), json!(error_kind));
            assert_eq!(event(&update, &target())["level"], level, "{error_kind}");
        }
        // The network failing an install is not excused.
        update.tags = [("update_result".to_string(), "install_failed".to_string())]
            .into_iter()
            .collect();
        update
            .details
            .insert("error_kind".to_string(), json!("network"));
        assert_eq!(event(&update, &target())["level"], "error");
        // Other kinds carry the four fixed tags only.
        let tags = event(&report(), &target())["tags"].clone();
        assert_eq!(tags.as_object().unwrap().len(), 4);
    }

    #[test]
    fn the_server_takes_the_envelope() {
        let sent_at = DateTime::from_timestamp(1_763_200_100, 0).unwrap();
        let envelope = envelope(&report(), &target(), sent_at);
        // What `forward_envelope` checks before it forwards.
        assert!(crate::telemetry::check_envelope(&envelope, DSN).is_ok());
        assert!(crate::telemetry::envelope_carries_error(&envelope));

        let lines: Vec<&str> = envelope.lines().collect();
        assert_eq!(lines.len(), 3);
        let header: Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(header["sent_at"], "2025-11-15T09:48:20Z");
        assert_eq!(header["event_id"], "0123456789abcdef0123456789abcdef");
        let item: Value = serde_json::from_str(lines[1]).unwrap();
        assert_eq!(item["type"], "event");
        assert_eq!(item["length"].as_u64(), Some(lines[2].len() as u64));
        let payload: Value = serde_json::from_str(lines[2]).unwrap();
        assert_eq!(payload["event_id"], header["event_id"]);
    }
}
