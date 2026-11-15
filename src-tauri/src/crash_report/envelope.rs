//! A report as a Sentry error event, in the envelope the server's
//! `/api/telemetry_envelope` forwards (`telemetry::forward_envelope`). The
//! server takes it when the envelope names its web DSN, which is the one its
//! `cowork_info` hands out; nothing else in it is checked.

use chrono::{DateTime, SecondsFormat, Utc};
use serde_json::{json, Value};

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
    match (report.kind, report.fatal) {
        (_, true) => "fatal",
        (Kind::Panic, false) => "error",
        (_, false) => "warning",
    }
}

fn exception_type(kind: Kind) -> &'static str {
    match kind {
        Kind::Panic => "Panic",
        Kind::Hang => "Hang",
        Kind::UncleanExit => "UncleanExit",
    }
}

/// The event's JSON.
pub fn event(report: &Report, target: &Target) -> Value {
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
            "desktop": report.details,
        },
    });
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
