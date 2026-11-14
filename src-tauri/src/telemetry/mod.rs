//! Cowork: diagnostics to Sentry — errors, API timings and the connection
//! logs that tell whose problem a failure was. Design: `docs/telemetry.md`.
//!
//! Off unless `CODEG_TELEMETRY_DSN` / `CODEG_TELEMETRY_WEB_DSN` are set
//! ([`config`]), and compiled in only with the `telemetry` feature, which
//! `server-bin` turns on; without it every function here passes through. The
//! touch points, a line or two each:
//!
//! * `cowork::init_process_env` calls [`take_env`], which reads the variables
//!   and removes them from the environment (agents and terminals never see
//!   the DSNs).
//! * `bin/codeg_server.rs` calls [`init_server`] once the logging subscriber
//!   is up, and holds the guard until it exits (the queue is flushed then).
//! * `logging/init.rs` adds [`tracing_layers`]: ERROR lines become Sentry
//!   errors, INFO / WARN breadcrumbs, WARN+ and a few modules' INFO logs.
//! * `web/router.rs` runs each API request through [`trace_request`]: one
//!   transaction per request, continuing the browser's trace; a 5xx is
//!   reported as an error by command, a 501 as a log.
//! * `web/handlers/error.rs` leaves an [`ApiError`] in the response for it.
//! * `cowork::api_routes` serves [`forward_envelope`] (the web UI reports
//!   through the server, never to Sentry directly); `cowork_info` carries
//!   [`client_config`], which is how the web UI knows to report at all.

use axum::response::Response;
use axum::Json;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::sync::OnceLock;

use crate::app_error::AppCommandError;

#[cfg(feature = "telemetry")]
mod client;
pub mod config;
pub mod scrub;

/// The forwarding endpoint, which is not itself traced.
pub const ENVELOPE_COMMAND: &str = "telemetry_envelope";
/// Its route in the API router.
pub const ENVELOPE_PATH: &str = "/telemetry_envelope";

/// The largest envelope the web UI may forward.
pub const MAX_ENVELOPE_BYTES: usize = 256 * 1024;

/// Envelopes forwarded per minute, per server process.
pub const ENVELOPES_PER_MINUTE: u32 = 60;

static TAKEN: OnceLock<config::TelemetryConfig> = OnceLock::new();

/// Read the `CODEG_TELEMETRY_*` variables and remove them from the process
/// environment. Call while still single-threaded (`cowork::init_process_env`).
pub fn take_env() {
    let config = config::resolve(&|k| std::env::var(k).ok());
    for name in config::env_names() {
        std::env::remove_var(name);
    }
    let _ = TAKEN.set(config);
}

/// What the web UI is told in `cowork_info.telemetry`.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ClientTelemetry {
    /// The web project's DSN. The UI never sends to it: it only stamps it on
    /// envelopes, which the server checks before forwarding.
    pub dsn: String,
    pub environment: String,
    pub release: String,
    pub traces_sample_rate: f32,
    /// Per-command trace rates below `traces_sample_rate` (the polled ones).
    pub command_sample_rates: BTreeMap<String, f32>,
    pub user: String,
}

/// An API error's code and message, left in the response extensions by
/// `IntoResponse for AppCommandError` so [`trace_request`] can report a 5xx
/// by what failed.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub code: String,
    pub message: String,
}

impl ApiError {
    pub fn of(err: &AppCommandError) -> Self {
        let code = serde_json::to_value(err.code)
            .ok()
            .and_then(|v| v.as_str().map(str::to_string))
            .unwrap_or_else(|| "unknown".to_string());
        Self {
            code,
            message: err.message.clone(),
        }
    }
}

/// Holds the Sentry client; dropping it sends what is queued (up to 2 s).
#[must_use = "telemetry stops when the guard is dropped"]
pub struct TelemetryGuard {
    #[cfg(feature = "telemetry")]
    _client: Option<client::ClientGuard>,
}

fn taken_config() -> config::TelemetryConfig {
    TAKEN
        .get()
        .cloned()
        .unwrap_or_else(|| config::resolve(&|k| std::env::var(k).ok()))
}

/// Start reporting, when configured. After the logging subscriber is
/// installed (it logs what it did) and before the tokio runtime is built
/// (threads started later inherit the client).
#[cfg(feature = "telemetry")]
pub fn init_server() -> TelemetryGuard {
    TelemetryGuard {
        _client: client::init(taken_config()),
    }
}

#[cfg(not(feature = "telemetry"))]
pub fn init_server() -> TelemetryGuard {
    if taken_config().enabled() {
        tracing::warn!("[telemetry] CODEG_TELEMETRY_* is set but this build has no telemetry");
    }
    TelemetryGuard {}
}

#[cfg(feature = "telemetry")]
pub use client::TelemetryLayer;

/// Without the feature, a layer that does nothing.
#[cfg(not(feature = "telemetry"))]
pub type TelemetryLayer = tracing_subscriber::layer::Identity;

/// The layer `build_subscriber` adds. It does nothing until [`init_server`]
/// has started a client, so it can be installed first.
#[cfg(feature = "telemetry")]
pub fn tracing_layers() -> Option<TelemetryLayer> {
    Some(client::TelemetryLayer::new())
}

#[cfg(not(feature = "telemetry"))]
pub fn tracing_layers() -> Option<TelemetryLayer> {
    None
}

/// Run one API request (`run` is the rest of the stack) inside a Sentry
/// transaction; reports a 5xx / 501. Passes straight through when off.
#[cfg(feature = "telemetry")]
pub async fn trace_request<F, Fut>(
    req: axum::extract::Request,
    request_id: uuid::Uuid,
    run: F,
) -> Response
where
    F: FnOnce(axum::extract::Request) -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    client::trace_request(req, request_id, run).await
}

#[cfg(not(feature = "telemetry"))]
pub async fn trace_request<F, Fut>(
    req: axum::extract::Request,
    _request_id: uuid::Uuid,
    run: F,
) -> Response
where
    F: FnOnce(axum::extract::Request) -> Fut,
    Fut: std::future::Future<Output = Response>,
{
    run(req).await
}

/// `cowork_info.telemetry`: `None` unless the web half is configured.
#[cfg(feature = "telemetry")]
pub fn client_config() -> Option<ClientTelemetry> {
    client::client_config()
}

#[cfg(not(feature = "telemetry"))]
pub fn client_config() -> Option<ClientTelemetry> {
    None
}

#[derive(Debug, Deserialize)]
pub struct EnvelopeParams {
    /// The envelope as the browser SDK serialized it.
    pub envelope: String,
}

/// What Sentry answered, for the web UI's transport (its SDK backs off on
/// these). Our own rate limit answers 429 the same way.
#[derive(Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct EnvelopeResult {
    pub status_code: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rate_limits: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<String>,
}

/// `POST /api/telemetry_envelope`: forward one envelope of the web UI to the
/// web project. 404 when not configured; 400 when the envelope is too large
/// or stamped with another DSN (this is not an open relay).
#[cfg(feature = "telemetry")]
pub async fn forward_envelope(Json(params): Json<EnvelopeParams>) -> Response {
    client::forward_envelope(params).await
}

#[cfg(not(feature = "telemetry"))]
pub async fn forward_envelope(Json(_params): Json<EnvelopeParams>) -> Response {
    axum::response::IntoResponse::into_response(AppCommandError::not_found("telemetry is off"))
}

/// The `dsn` an envelope's header names (the first line, JSON).
pub fn envelope_dsn(envelope: &str) -> Option<String> {
    let header = envelope.lines().next()?;
    let header: serde_json::Value = serde_json::from_str(header).ok()?;
    header.get("dsn")?.as_str().map(str::to_string)
}

/// Whether two DSN strings name the same project (a trailing `/` aside).
pub fn same_dsn(a: &str, b: &str) -> bool {
    a.trim().trim_end_matches('/') == b.trim().trim_end_matches('/')
}

/// Why an envelope is refused before it is forwarded, if it is.
pub fn check_envelope(envelope: &str, web_dsn: &str) -> Result<(), AppCommandError> {
    if envelope.len() > MAX_ENVELOPE_BYTES {
        return Err(AppCommandError::invalid_input(format!(
            "envelope is {} bytes, more than {MAX_ENVELOPE_BYTES}",
            envelope.len()
        )));
    }
    match envelope_dsn(envelope) {
        Some(dsn) if same_dsn(&dsn, web_dsn) => Ok(()),
        Some(_) => Err(AppCommandError::invalid_input(
            "envelope is for another Sentry project",
        )),
        None => Err(AppCommandError::invalid_input("envelope names no dsn")),
    }
}

/// The first segment of an API path (`/workspace_download/<ticket>` →
/// `workspace_download`), so a transaction is named by its command and never
/// carries a ticket or a port.
pub fn command_of(path: &str) -> &str {
    path.trim_start_matches('/').split('/').next().unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    const DSN: &str = "https://abc@o1.ingest.example.com/2";

    fn envelope(dsn: &str) -> String {
        format!("{{\"dsn\":\"{dsn}\",\"sent_at\":\"2026-11-14T00:00:00Z\"}}\n{{\"type\":\"event\"}}\n{{}}\n")
    }

    #[test]
    fn envelopes_for_the_configured_project_pass() {
        assert!(check_envelope(&envelope(DSN), DSN).is_ok());
        assert!(check_envelope(&envelope(&format!("{DSN}/")), DSN).is_ok());
    }

    #[test]
    fn other_projects_and_unstamped_envelopes_are_refused() {
        let err = check_envelope(&envelope("https://abc@evil.example.com/2"), DSN).unwrap_err();
        assert!(err.message.contains("another"));
        assert!(check_envelope("{\"sent_at\":\"x\"}\n{}\n", DSN).is_err());
        assert!(check_envelope("not json", DSN).is_err());
        assert!(check_envelope("", DSN).is_err());
    }

    #[test]
    fn oversized_envelopes_are_refused() {
        let mut big = envelope(DSN);
        big.push_str(&"x".repeat(MAX_ENVELOPE_BYTES));
        let err = check_envelope(&big, DSN).unwrap_err();
        assert!(err.message.contains("bytes"));
    }

    #[test]
    fn commands_are_the_first_path_segment() {
        assert_eq!(command_of("/acp_prompt"), "acp_prompt");
        assert_eq!(
            command_of("/workspace_download/secret-ticket"),
            "workspace_download"
        );
        assert_eq!(
            command_of("/office-watch-proxy/5173/a/b"),
            "office-watch-proxy"
        );
        assert_eq!(command_of("/"), "");
    }

    #[test]
    fn api_errors_carry_the_wire_code() {
        let err = AppCommandError::database_error("disk full");
        let api = ApiError::of(&err);
        assert_eq!(api.code, "database_error");
        assert_eq!(api.message, "disk full");
    }

    #[cfg(not(feature = "telemetry"))]
    #[test]
    fn without_the_feature_nothing_is_offered() {
        assert!(client_config().is_none());
        assert!(tracing_layers().is_none());
    }
}
