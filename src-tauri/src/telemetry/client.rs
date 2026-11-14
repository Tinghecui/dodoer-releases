//! The Sentry side, compiled with the `telemetry` feature only: the client
//! and its transport, the tracing layer, request tracing and the envelope
//! forwarder.

use std::borrow::Cow;
use std::cell::Cell;
use std::collections::BTreeMap;
use std::future::Future;
use std::sync::mpsc::{sync_channel, Receiver, SyncSender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};

use axum::extract::Request;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use sentry_core::protocol::{
    Breadcrumb, Context as SentryContext, Envelope, Event, Level as SentryLevel, Log, LogAttribute,
    LogLevel, SpanStatus, User,
};
use sentry_core::types::Dsn;
use sentry_core::{Client, ClientOptions, Hub, SentryFutureExt, TransactionContext, Transport};
use sentry_tracing::{BreadcrumbLayer, ErrorLayer, LogLayer};
use tracing::{Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};
use tracing_subscriber::registry::LookupSpan;

use super::config::{self, TelemetryConfig};
use super::{
    scrub, ApiError, ClientTelemetry, EnvelopeParams, EnvelopeResult, ENVELOPES_PER_MINUTE,
    ENVELOPE_COMMAND,
};
use crate::app_error::AppCommandError;

/// Errors reported per minute; more are dropped.
const ERRORS_PER_MINUTE: u32 = 60;
/// Logs per minute; more are dropped.
const LOGS_PER_MINUTE: u32 = 600;
/// Envelopes waiting to be sent; more are dropped.
const QUEUE: usize = 64;
const SEND_TIMEOUT: Duration = Duration::from_secs(10);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);
/// Rate limits from Sentry are honoured up to this long.
const MAX_BACKOFF_SECS: u64 = 3600;
const USER_AGENT: &str = concat!("codeg-server/", env!("CARGO_PKG_VERSION"));
/// This module's own lines never go to Sentry (they are about sending to it).
const OWN_TARGET: &str = "codeg_lib::telemetry";

struct Active {
    /// The server half is reporting.
    server: bool,
    client_config: Option<ClientTelemetry>,
    web: Option<Target>,
    http: reqwest::Client,
    envelopes: Budget,
}

static ACTIVE: OnceLock<Active> = OnceLock::new();

thread_local! {
    /// Set on the sender thread: what the HTTP stack logs while sending is
    /// not reported (it would be sent by the same thread, and so on).
    static QUIET: Cell<bool> = const { Cell::new(false) };
}

/// Where envelopes of one project go.
struct Target {
    /// As configured: what the web UI stamps its envelopes with.
    dsn: String,
    url: String,
    auth: String,
}

impl Target {
    fn new(raw: &str) -> Result<Self, String> {
        let dsn: Dsn = raw.parse().map_err(|e| format!("{e}"))?;
        Ok(Self::of(&dsn, raw))
    }

    fn of(dsn: &Dsn, raw: &str) -> Self {
        Self {
            dsn: raw.to_string(),
            url: dsn.envelope_api_url().to_string(),
            auth: dsn.to_auth(Some(USER_AGENT)).to_string(),
        }
    }
}

/// So many per minute, then nothing until the minute is over.
struct Budget {
    per_minute: u32,
    window: Mutex<(Instant, u32)>,
}

impl Budget {
    fn new(per_minute: u32) -> Self {
        Self {
            per_minute,
            window: Mutex::new((Instant::now(), 0)),
        }
    }

    fn take(&self) -> bool {
        let mut window = self.window.lock().unwrap_or_else(|e| e.into_inner());
        if window.0.elapsed() >= Duration::from_secs(60) {
            *window = (Instant::now(), 0);
        }
        if window.1 >= self.per_minute {
            return false;
        }
        window.1 += 1;
        true
    }
}

/// Closes the client on drop, sending what is queued.
pub(in crate::telemetry) struct ClientGuard(Arc<Client>);

impl Drop for ClientGuard {
    fn drop(&mut self) {
        self.0.close(Some(SHUTDOWN_TIMEOUT));
    }
}

pub(in crate::telemetry) fn init(config: TelemetryConfig) -> Option<ClientGuard> {
    for problem in &config.problems {
        tracing::warn!("[telemetry] {problem}");
    }
    if !config.enabled() {
        return None;
    }
    let cowork_version = std::fs::read_to_string(
        crate::update::runtime::self_exe().with_file_name("COWORK-VERSION"),
    )
    .ok();
    let release = config::release_from(cowork_version.as_deref());

    let server = match config.dsn.as_deref().map(str::parse::<Dsn>) {
        None => None,
        Some(Ok(dsn)) => Some(dsn),
        Some(Err(e)) => {
            tracing::warn!(
                "[telemetry] CODEG_TELEMETRY_DSN is not a DSN ({e}); server reports off"
            );
            None
        }
    };
    let web = match config.web_dsn.as_deref().map(Target::new) {
        None => None,
        Some(Ok(target)) => Some(target),
        Some(Err(e)) => {
            tracing::warn!(
                "[telemetry] CODEG_TELEMETRY_WEB_DSN is not a DSN ({e}); web reports off"
            );
            None
        }
    };
    let client_config = web.as_ref().map(|target| ClientTelemetry {
        dsn: target.dsn.clone(),
        environment: config.environment.clone(),
        release: release.clone(),
        traces_sample_rate: config.traces_sample_rate,
        command_sample_rates: config::POLLED_COMMANDS
            .iter()
            .map(|(command, _)| {
                (
                    command.to_string(),
                    config::command_sample_rate(command, config.traces_sample_rate),
                )
            })
            .collect(),
        user: config.user.clone(),
    });
    let http = reqwest::Client::builder()
        .timeout(SEND_TIMEOUT)
        .build()
        .unwrap_or_default();

    let guard = server.map(|dsn| start_client(dsn, &config, &release));
    let _ = ACTIVE.set(Active {
        server: guard.is_some(),
        client_config,
        web,
        http,
        envelopes: Budget::new(ENVELOPES_PER_MINUTE),
    });
    let active = ACTIVE.get();
    tracing::info!(
        "[telemetry] on: server={} web={} environment={} release={release} user={} traces={}",
        guard.is_some(),
        active.is_some_and(|a| a.web.is_some()),
        config.environment,
        config.user,
        config.traces_sample_rate
    );
    if config.self_test && guard.is_some() {
        Hub::main().capture_message("telemetry self-test from codeg-server", SentryLevel::Error);
        tracing::info!("[telemetry] self-test error queued");
    }
    guard
}

fn start_client(dsn: Dsn, config: &TelemetryConfig, release: &str) -> ClientGuard {
    let default_rate = config.traces_sample_rate;
    let errors = Budget::new(ERRORS_PER_MINUTE);
    let logs = Budget::new(LOGS_PER_MINUTE);
    let transport = Arc::new(HttpTransport::start(Target::of(&dsn, "")));
    let mut options = ClientOptions::new()
        .release(release.to_string())
        .environment(config.environment.clone())
        .max_breadcrumbs(50)
        .send_default_pii(false)
        .shutdown_timeout(SHUTDOWN_TIMEOUT)
        // A trace the browser started keeps its decision; otherwise the
        // command's rate (the polled ones are sampled down).
        .traces_sampler(move |ctx| {
            let command = ctx.name().rsplit('/').next().unwrap_or("");
            let rate = config::command_sample_rate(command, default_rate);
            ctx.sampled().map_or(rate, f32::from)
        })
        .before_send(move |event| errors.take().then(|| scrub_event(event)))
        .before_breadcrumb(|crumb| Some(scrub_breadcrumb(crumb)))
        .before_send_log(move |log| logs.take().then(|| scrub_log(log)))
        .transport(transport);
    options.dsn = Some(dsn);
    let client = Arc::new(Client::with_options(options));
    // The process hub, before the runtime's threads exist: each thread's hub
    // starts as a copy of it.
    let hub = Hub::main();
    hub.bind_client(Some(client.clone()));
    hub.configure_scope(|scope| {
        scope.set_user(Some(User {
            id: Some(config.user.clone()),
            ..Default::default()
        }));
        scope.set_tag("service", "codeg-server");
    });
    ClientGuard(client)
}

// ─── Scrubbing ───────────────────────────────────────────────────────────

fn scrub_event(mut event: Event<'static>) -> Event<'static> {
    event.message = event.message.as_deref().map(scrub::scrub_text);
    if let Some(entry) = event.logentry.as_mut() {
        entry.message = scrub::scrub_text(&entry.message);
        entry.params = std::mem::take(&mut entry.params)
            .into_iter()
            .map(scrub::scrub_value)
            .collect();
    }
    for exception in event.exception.values.iter_mut() {
        exception.value = exception.value.as_deref().map(scrub::scrub_text);
    }
    event.breadcrumbs.values = std::mem::take(&mut event.breadcrumbs.values)
        .into_iter()
        .map(scrub_breadcrumb)
        .collect();
    event.tags = std::mem::take(&mut event.tags)
        .into_iter()
        .filter(|(key, _)| !scrub::drops_field(key))
        .map(|(key, value)| {
            let value = scrub::scrub_text(&value);
            (key, value)
        })
        .collect();
    event.extra = scrub::scrub_map(std::mem::take(&mut event.extra));
    for context in event.contexts.values_mut() {
        if let SentryContext::Other(map) = context {
            *map = scrub::scrub_map(std::mem::take(map));
        }
    }
    event.request = None;
    event.server_name = None;
    if let Some(user) = event.user.as_mut() {
        user.email = None;
        user.ip_address = None;
        user.username = None;
        user.other.clear();
    }
    event
}

fn scrub_breadcrumb(mut crumb: Breadcrumb) -> Breadcrumb {
    crumb.message = crumb.message.as_deref().map(scrub::scrub_text);
    crumb.data = scrub::scrub_map(std::mem::take(&mut crumb.data));
    crumb
}

fn scrub_log(mut log: Log) -> Log {
    log.body = scrub::scrub_text(&log.body);
    log.attributes = std::mem::take(&mut log.attributes)
        .into_iter()
        .filter(|(key, _)| !scrub::drops_field(key))
        .map(|(key, LogAttribute(value))| (key, LogAttribute(scrub::scrub_value(value))))
        .collect();
    log
}

// ─── Transport ───────────────────────────────────────────────────────────

enum Task {
    // Boxed: an envelope is hundreds of bytes, a flush a pointer.
    Send(Box<Envelope>),
    Flush(SyncSender<()>),
}

/// Sends envelopes from a thread of its own (with the reqwest the crate
/// already has, not the SDK's own transport and its second HTTP stack).
/// Never blocks the caller: a full queue drops the envelope.
struct HttpTransport {
    queue: Mutex<Option<SyncSender<Task>>>,
}

impl HttpTransport {
    fn start(target: Target) -> Self {
        let (queue, tasks) = sync_channel(QUEUE);
        let started = std::thread::Builder::new()
            .name("telemetry-send".into())
            .spawn(move || send_loop(tasks, target));
        if let Err(e) = &started {
            tracing::warn!("[telemetry] cannot start the sender thread: {e}");
        }
        Self {
            queue: Mutex::new(started.ok().map(|_| queue)),
        }
    }

    fn queue(&self) -> Option<SyncSender<Task>> {
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}

impl Transport for HttpTransport {
    fn send_envelope(&self, envelope: Envelope) {
        if let Some(queue) = self.queue() {
            let _ = queue.try_send(Task::Send(Box::new(envelope)));
        }
    }

    fn flush(&self, timeout: Duration) -> bool {
        let Some(queue) = self.queue() else {
            return true;
        };
        let (ack, done) = sync_channel(1);
        if queue.try_send(Task::Flush(ack)).is_err() {
            return false;
        }
        done.recv_timeout(timeout).is_ok()
    }

    fn shutdown(&self, timeout: Duration) -> bool {
        let flushed = self.flush(timeout);
        // The sender thread ends once the queue is closed and drained.
        self.queue.lock().unwrap_or_else(|e| e.into_inner()).take();
        flushed
    }
}

fn send_loop(tasks: Receiver<Task>, target: Target) {
    QUIET.with(|quiet| quiet.set(true));
    let runtime = match tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            tracing::warn!("[telemetry] cannot start the sender runtime: {e}");
            return;
        }
    };
    let http = reqwest::Client::builder()
        .timeout(SEND_TIMEOUT)
        .build()
        .unwrap_or_default();
    let mut paused_until: Option<Instant> = None;
    let mut failing = false;
    for task in tasks {
        let envelope = match task {
            Task::Flush(ack) => {
                let _ = ack.send(());
                continue;
            }
            Task::Send(envelope) => envelope,
        };
        if paused_until.is_some_and(|until| Instant::now() < until) {
            continue;
        }
        let mut body = Vec::new();
        if envelope.to_writer(&mut body).is_err() {
            continue;
        }
        let sent = runtime.block_on(
            http.post(&target.url)
                .header("X-Sentry-Auth", &target.auth)
                .header("Content-Type", "application/x-sentry-envelope")
                .body(body)
                .send(),
        );
        match sent {
            Ok(response) => {
                if failing {
                    tracing::info!("[telemetry] sending works again");
                    failing = false;
                }
                let header = |name: &str| {
                    response
                        .headers()
                        .get(name)
                        .and_then(|v| v.to_str().ok())
                        .map(str::to_string)
                };
                if let Some(secs) = backoff_secs(
                    response.status().as_u16(),
                    header("x-sentry-rate-limits").as_deref(),
                    header("retry-after").as_deref(),
                ) {
                    paused_until = Some(Instant::now() + Duration::from_secs(secs));
                }
            }
            Err(e) => {
                if !failing {
                    tracing::warn!("[telemetry] cannot reach Sentry: {e}");
                    failing = true;
                }
            }
        }
    }
}

/// How long to stop sending after Sentry's answer. Any limit pauses
/// everything (simpler than per category, and a limit means the month's
/// quota or a burst — either way less is better).
fn backoff_secs(status: u16, rate_limits: Option<&str>, retry_after: Option<&str>) -> Option<u64> {
    if let Some(header) = rate_limits {
        let secs = header
            .split(',')
            .filter_map(|group| group.trim().split(':').next()?.parse::<f64>().ok())
            .fold(0.0_f64, f64::max);
        if secs > 0.0 {
            return Some((secs.ceil() as u64).min(MAX_BACKOFF_SECS));
        }
    }
    if status == 429 {
        let secs = retry_after
            .and_then(|v| v.trim().parse::<u64>().ok())
            .unwrap_or(60);
        return Some(secs.min(MAX_BACKOFF_SECS));
    }
    None
}

// ─── Tracing layer ───────────────────────────────────────────────────────

/// ERROR → Sentry error; INFO / WARN → breadcrumb (sent only along with a
/// later error); WARN / ERROR and the INFO of [`config::INFO_LOG_TARGETS`] →
/// Sentry log. Spans are not turned into traces (a connection's span lives
/// for hours and carries its working directory); requests get transactions
/// in [`trace_request`].
pub struct TelemetryLayer {
    errors: ErrorLayer,
    breadcrumbs: BreadcrumbLayer,
    logs: LogLayer,
}

impl TelemetryLayer {
    pub(in crate::telemetry) fn new() -> Self {
        Self {
            errors: ErrorLayer::new(),
            breadcrumbs: BreadcrumbLayer::new(),
            logs: LogLayer::new(),
        }
    }
}

impl<S> Layer<S> for TelemetryLayer
where
    S: Subscriber + for<'a> LookupSpan<'a>,
{
    fn on_event(&self, event: &tracing::Event<'_>, ctx: Context<'_, S>) {
        if !ACTIVE.get().is_some_and(|a| a.server) || QUIET.with(|quiet| quiet.get()) {
            return;
        }
        let meta = event.metadata();
        if meta.target().starts_with(OWN_TARGET) {
            return;
        }
        let level = *meta.level();
        if level == Level::ERROR {
            self.errors.on_event(event, ctx.clone());
        } else if level == Level::WARN || level == Level::INFO {
            self.breadcrumbs.on_event(event, ctx.clone());
        }
        if level == Level::ERROR
            || level == Level::WARN
            || (level == Level::INFO && config::info_log_target(meta.target()))
        {
            self.logs.on_event(event, ctx);
        }
    }
}

// ─── API requests ────────────────────────────────────────────────────────

pub(in crate::telemetry) async fn trace_request<F, Fut>(
    req: Request,
    request_id: uuid::Uuid,
    run: F,
) -> Response
where
    F: FnOnce(Request) -> Fut,
    Fut: Future<Output = Response>,
{
    if !ACTIVE.get().is_some_and(|a| a.server) {
        return run(req).await;
    }
    let command = super::command_of(req.uri().path()).to_string();
    if command == ENVELOPE_COMMAND {
        return run(req).await;
    }
    let method = req.method().as_str().to_string();
    let name = format!("{method} /api/{command}");
    let incoming: Vec<(&str, String)> = ["sentry-trace", "baggage"]
        .into_iter()
        .filter_map(|header| {
            Some((
                header,
                req.headers().get(header)?.to_str().ok()?.to_string(),
            ))
        })
        .collect();
    let ctx = TransactionContext::continue_from_headers(
        &name,
        "http.server",
        incoming.iter().map(|(k, v)| (*k, v.as_str())),
    );
    // A hub per request: concurrent requests' scopes do not mix.
    let hub = Arc::new(Hub::new_from_top(Hub::main()));
    let transaction = hub.start_transaction(ctx);
    transaction.set_tag("request_id", request_id);
    hub.configure_scope(|scope| {
        scope.set_span(Some(transaction.clone().into()));
        scope.set_tag("request_id", request_id);
        scope.set_tag("command", &command);
    });

    let response = run(req).bind_hub(hub.clone()).await;

    let status = response.status();
    transaction.set_status(span_status(status.as_u16()));
    transaction.set_data("http.response.status_code", status.as_u16().into());
    if status == StatusCode::NOT_IMPLEMENTED {
        report_unimplemented(&hub, &command);
    } else if status.is_server_error() {
        report_server_error(
            &hub,
            &method,
            &command,
            status.as_u16(),
            response.extensions().get::<ApiError>(),
        );
    }
    Hub::run(hub, || transaction.finish());
    response
}

fn span_status(status: u16) -> SpanStatus {
    match status {
        400 => SpanStatus::InvalidArgument,
        401 => SpanStatus::Unauthenticated,
        403 => SpanStatus::PermissionDenied,
        404 => SpanStatus::NotFound,
        409 => SpanStatus::AlreadyExists,
        429 => SpanStatus::ResourceExhausted,
        499 => SpanStatus::Cancelled,
        501 => SpanStatus::Unimplemented,
        503 => SpanStatus::Unavailable,
        504 => SpanStatus::DeadlineExceeded,
        _ if status < 400 => SpanStatus::Ok,
        _ if status < 500 => SpanStatus::FailedPrecondition,
        _ => SpanStatus::InternalError,
    }
}

/// A 5xx is an error, grouped by command and error code — whether or not
/// the handler also logged an ERROR (#201 did not).
fn report_server_error(
    hub: &Hub,
    method: &str,
    command: &str,
    status: u16,
    error: Option<&ApiError>,
) {
    let code = error.map_or("unknown", |e| e.code.as_str());
    let mut message = format!("{method} /api/{command} → {status} {code}");
    if let Some(error) = error {
        message.push_str(": ");
        message.push_str(&error.message);
    }
    let mut event = Event {
        level: SentryLevel::Error,
        message: Some(message),
        logger: Some("codeg_lib::web::api".to_string()),
        fingerprint: Cow::Owned(vec![
            Cow::Borrowed("api-5xx"),
            Cow::Owned(command.to_string()),
            Cow::Owned(code.to_string()),
        ]),
        ..Default::default()
    };
    event.tags.insert("command".into(), command.into());
    event.tags.insert("status".into(), status.to_string());
    event.tags.insert("error_code".into(), code.into());
    hub.capture_event(event);
}

/// A 501 is a client asking for an endpoint this server does not have: an
/// old or new client across a release. A log, to count them.
fn report_unimplemented(hub: &Hub, command: &str) {
    let command: String = command.chars().take(64).collect();
    let mut attributes = BTreeMap::new();
    attributes.insert("command".to_string(), LogAttribute(command.clone().into()));
    hub.capture_log(Log {
        level: LogLevel::Warn,
        body: format!("unimplemented API endpoint {command}"),
        trace_id: None,
        timestamp: SystemTime::now(),
        severity_number: None,
        attributes,
    });
}

pub(in crate::telemetry) fn client_config() -> Option<ClientTelemetry> {
    ACTIVE.get()?.client_config.clone()
}

// ─── Forwarding the web UI's envelopes ───────────────────────────────────

pub(in crate::telemetry) async fn forward_envelope(params: EnvelopeParams) -> Response {
    let Some((active, web)) = ACTIVE.get().and_then(|a| Some((a, a.web.as_ref()?))) else {
        return AppCommandError::not_found("telemetry is off").into_response();
    };
    if let Err(err) = super::check_envelope(&params.envelope, &web.dsn) {
        return err.into_response();
    }
    if !active.envelopes.take() {
        return Json(EnvelopeResult {
            status_code: 429,
            rate_limits: None,
            retry_after: Some("60".to_string()),
        })
        .into_response();
    }
    let sent = active
        .http
        .post(&web.url)
        .header("X-Sentry-Auth", &web.auth)
        .header("Content-Type", "application/x-sentry-envelope")
        .body(params.envelope)
        .send()
        .await;
    match sent {
        Ok(response) => {
            let header = |name: &str| {
                response
                    .headers()
                    .get(name)
                    .and_then(|v| v.to_str().ok())
                    .map(str::to_string)
            };
            Json(EnvelopeResult {
                status_code: response.status().as_u16(),
                rate_limits: header("x-sentry-rate-limits"),
                retry_after: header("retry-after"),
            })
            .into_response()
        }
        Err(e) => {
            tracing::warn!("[telemetry] forwarding an envelope failed: {e}");
            (
                StatusCode::BAD_GATEWAY,
                Json(AppCommandError::network("could not reach Sentry")),
            )
                .into_response()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn budgets_stop_at_the_limit() {
        let budget = Budget::new(2);
        assert!(budget.take());
        assert!(budget.take());
        assert!(!budget.take());
    }

    #[test]
    fn sentry_rate_limits_pause_sending() {
        assert_eq!(
            backoff_secs(200, Some("60:error:org, 120:transaction:key"), None),
            Some(120)
        );
        assert_eq!(backoff_secs(200, Some("0.5::org"), None), Some(1));
        assert_eq!(backoff_secs(429, None, Some("30")), Some(30));
        assert_eq!(backoff_secs(429, None, None), Some(60));
        assert_eq!(
            backoff_secs(429, None, Some("99999")),
            Some(MAX_BACKOFF_SECS)
        );
        assert_eq!(backoff_secs(200, None, None), None);
        assert_eq!(backoff_secs(500, None, Some("30")), None);
    }

    #[test]
    fn statuses_map_to_span_statuses() {
        assert_eq!(span_status(200), SpanStatus::Ok);
        assert_eq!(span_status(404), SpanStatus::NotFound);
        assert_eq!(span_status(422), SpanStatus::FailedPrecondition);
        assert_eq!(span_status(500), SpanStatus::InternalError);
        assert_eq!(span_status(501), SpanStatus::Unimplemented);
    }

    #[test]
    fn events_lose_paths_and_content_fields() {
        let mut event = Event {
            message: Some("open /home/cw-a/p/x failed".into()),
            ..Default::default()
        };
        event.tags.insert("prompt".into(), "hi".into());
        event.tags.insert("command".into(), "acp_prompt".into());
        let mut fields = BTreeMap::new();
        fields.insert("working_dir".to_string(), "/srv/p".into());
        fields.insert("count".to_string(), 2.into());
        event
            .contexts
            .insert("Rust Tracing Fields".into(), SentryContext::Other(fields));
        event.user = Some(User {
            id: Some("james".into()),
            email: Some("j@example.com".into()),
            ..Default::default()
        });
        let event = scrub_event(event);
        assert_eq!(event.message.as_deref(), Some("open ~/<redacted> failed"));
        assert!(!event.tags.contains_key("prompt"));
        assert_eq!(event.tags["command"], "acp_prompt");
        let SentryContext::Other(fields) = &event.contexts["Rust Tracing Fields"] else {
            panic!("context kept its kind");
        };
        assert!(!fields.contains_key("working_dir"));
        assert_eq!(fields["count"], 2);
        let user = event.user.unwrap();
        assert_eq!(user.id.as_deref(), Some("james"));
        assert!(user.email.is_none());
    }

    #[test]
    fn logs_lose_source_paths_and_content_fields() {
        let mut attributes = BTreeMap::new();
        attributes.insert(
            "code.file.path".to_string(),
            LogAttribute("src/web/ws.rs".into()),
        );
        attributes.insert(
            "code.module.name".to_string(),
            LogAttribute("codeg_lib::web::ws".into()),
        );
        attributes.insert("cwd".to_string(), LogAttribute("/srv/p".into()));
        let log = scrub_log(Log {
            level: LogLevel::Info,
            body: "token=abc closed".into(),
            trace_id: None,
            timestamp: SystemTime::now(),
            severity_number: None,
            attributes,
        });
        assert_eq!(log.body, "token=<redacted> closed");
        assert_eq!(log.attributes.len(), 1);
        assert!(log.attributes.contains_key("code.module.name"));
    }

    /// Nothing is reported, and requests pass straight through, while no
    /// client was started (tests never start one).
    #[tokio::test]
    async fn requests_pass_through_when_off() {
        let req = Request::builder()
            .uri("/acp_prompt")
            .body(axum::body::Body::empty())
            .unwrap();
        let response = trace_request(req, uuid::Uuid::new_v4(), |_req| async {
            StatusCode::INTERNAL_SERVER_ERROR.into_response()
        })
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        assert!(client_config().is_none());
        let off = forward_envelope(EnvelopeParams {
            envelope: String::new(),
        })
        .await;
        assert_eq!(off.status(), StatusCode::NOT_FOUND);
    }
}
