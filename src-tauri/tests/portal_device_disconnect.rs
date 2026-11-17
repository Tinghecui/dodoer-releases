//! Cowork fork（#387）：门户吊销一台设备以后，daemon 断开这台设备开着的
//! `/ws/events`（`web/portal_device.rs`、`web/ws.rs`），之后它再来握手回 401。
//! 写法照 `tests/ws_hello.rs`。
//!
//! 登记表是进程里的一个实例，几个测试共用：每个测试用自己的设备编号。

use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::http::StatusCode;
use axum_test::TestServer;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TEST_TOKEN: &str = "portal-device-test-token";
const DEVICE: &str = "x-cowork-device";

/// 这个文件的测试一个一个跑：收日志的那个测试用 `set_default` 只装在自己的
/// 线程上，别的线程同时打到同一行日志时，tracing 缓存的「这行要不要记」会让
/// 它漏记。
async fn serial() -> tokio::sync::MutexGuard<'static, ()> {
    static LOCK: std::sync::OnceLock<tokio::sync::Mutex<()>> = std::sync::OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await
}

async fn build_server() -> (
    TestServer,
    Arc<AppState>,
    tempfile::TempDir,
    tempfile::TempDir,
) {
    let data_dir = tempfile::tempdir().expect("data dir");
    let static_dir = tempfile::tempdir().expect("static dir");
    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
    let router = build_router(
        Arc::clone(&state),
        TEST_TOKEN.to_string(),
        static_dir.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    );
    let server = TestServer::builder()
        .http_transport()
        .build(router)
        .expect("test server");
    (server, state, data_dir, static_dir)
}

fn ws_protocol() -> String {
    format!(
        "codeg-events, codeg-token.{}",
        URL_SAFE_NO_PAD.encode(TEST_TOKEN)
    )
}

fn ws_request(server: &TestServer, device: Option<&str>) -> axum_test::TestRequest {
    let mut request = server
        .get_websocket("/ws/events")
        .add_header("sec-websocket-protocol", ws_protocol());
    if let Some(device) = device {
        request = request.add_header(DEVICE, device.to_string());
    }
    request
}

async fn open_ws(server: &TestServer, device: Option<&str>) -> axum_test::TestWebSocket {
    let mut ws = ws_request(server, device).await.into_websocket().await;
    let ready = next_json(&mut ws).await;
    assert_eq!(ready["channel"], "__ready__");
    ws
}

async fn next_json(ws: &mut axum_test::TestWebSocket) -> Value {
    let text = tokio::time::timeout(Duration::from_secs(3), ws.receive_text())
        .await
        .expect("ws frame within 3s");
    serde_json::from_str(&text).expect("frame is valid json")
}

async fn assert_alive(ws: &mut axum_test::TestWebSocket) {
    ws.send_json(&json!({ "action": "ping" })).await;
    assert_eq!(next_json(ws).await, json!({ "type": "pong" }));
}

/// 3 秒内等到关闭帧，返回它的代码。
async fn close_code(ws: &mut axum_test::TestWebSocket) -> u16 {
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        let message = tokio::time::timeout(left, ws.receive_message())
            .await
            .expect("close frame within 3s");
        if let axum_test::WsMessage::Close(frame) = message {
            return frame.map(|f| u16::from(f.code)).unwrap_or(0);
        }
    }
}

async fn disconnect(server: &TestServer, body: Value) -> axum_test::TestResponse {
    server
        .post("/api/cowork_disconnect_device")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&body)
        .await
}

async fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while !ok() {
        assert!(Instant::now() < deadline, "{what} within 3s");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn disconnecting_a_device_closes_only_its_events_socket() {
    let _serial = serial().await;
    let (server, state, _d, _s) = build_server().await;
    let a = "a1a1a1a1a1a1";
    let b = "b1b1b1b1b1b1";

    let mut ws_a = open_ws(&server, Some(a)).await;
    let mut ws_b = open_ws(&server, Some(b)).await;
    let mut ws_plain = open_ws(&server, None).await;

    // A 这台桌面版借出了它的浏览器。
    ws_a.send_json(&json!({ "action": "host_register", "capabilities": ["browser"] }))
        .await;
    let registry = Arc::clone(&state.host_registry);
    wait_until("host registered", || registry.has_host("browser")).await;

    let response = disconnect(&server, json!({ "device": a })).await;
    response.assert_status_ok();
    assert_eq!(response.json::<Value>(), json!({ "closed": 1 }));

    assert_eq!(close_code(&mut ws_a).await, 1008);
    wait_until("host unregistered", || !registry.has_host("browser")).await;

    assert_alive(&mut ws_b).await;
    assert_alive(&mut ws_plain).await;
}

#[tokio::test]
async fn a_disconnected_device_is_refused_at_the_handshake() {
    let _serial = serial().await;
    let (server, _state, _d, _s) = build_server().await;
    let a = "a2a2a2a2a2a2";
    let b = "b2b2b2b2b2b2";

    let response = disconnect(&server, json!({ "device": a })).await;
    response.assert_status_ok();
    assert_eq!(response.json::<Value>(), json!({ "closed": 0 }));

    let refused = ws_request(&server, Some(a)).await;
    refused.assert_status(StatusCode::UNAUTHORIZED);
    assert_eq!(
        refused.header("www-authenticate"),
        r#"Bearer realm="codeg""#
    );

    let mut ws_b = open_ws(&server, Some(b)).await;
    assert_alive(&mut ws_b).await;
    let mut ws_plain = open_ws(&server, None).await;
    assert_alive(&mut ws_plain).await;
}

#[tokio::test]
async fn the_endpoint_answers() {
    let _serial = serial().await;
    let (server, _state, _d, _s) = build_server().await;
    let a = "a3a3a3a3a3a3";
    let mut ws_a = open_ws(&server, Some(a)).await;

    // 不带主令牌、主令牌不对：现有的 401。
    server
        .post("/api/cowork_disconnect_device")
        .json(&json!({ "device": a }))
        .await
        .assert_status(StatusCode::UNAUTHORIZED);
    server
        .post("/api/cowork_disconnect_device")
        .add_header("authorization", "Bearer wrong-token")
        .json(&json!({ "device": a }))
        .await
        .assert_status(StatusCode::UNAUTHORIZED);

    // 编号格式不对：400。
    for bad in ["A3A3A3A3A3A3", "a3a3", "", "zzzzzzzzzzzz"] {
        disconnect(&server, json!({ "device": bad }))
            .await
            .assert_status(StatusCode::BAD_REQUEST);
    }

    // 请求本身带着设备编号头：403，什么都不断开。
    server
        .post("/api/cowork_disconnect_device")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .add_header(DEVICE, "c3c3c3c3c3c3")
        .json(&json!({ "device": a }))
        .await
        .assert_status(StatusCode::FORBIDDEN);
    assert_alive(&mut ws_a).await;

    // 对的：200，断开一条。
    let response = disconnect(&server, json!({ "device": a })).await;
    response.assert_status_ok();
    assert_eq!(response.json::<Value>(), json!({ "closed": 1 }));
    assert_eq!(close_code(&mut ws_a).await, 1008);

    // 再调一次：0 条。
    let again = disconnect(&server, json!({ "device": a })).await;
    assert_eq!(again.json::<Value>(), json!({ "closed": 0 }));
}

/// 收日志的地方（`tracing::subscriber::set_default` 只管这个线程，
/// `#[tokio::test]` 的 runtime 是单线程的，服务器的任务也跑在这里）。
#[derive(Clone, Default)]
struct Captured(Arc<std::sync::Mutex<Vec<u8>>>);

impl std::io::Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn each_call_is_logged_without_any_token() {
    let _serial = serial().await;
    let log = Captured::default();
    let sink = log.clone();
    let _guard = tracing::subscriber::set_default(
        tracing_subscriber::fmt()
            .with_writer(move || sink.clone())
            .with_ansi(false)
            .with_max_level(tracing::Level::DEBUG)
            .finish(),
    );

    let (server, _state, _d, _s) = build_server().await;
    let a = "a4a4a4a4a4a4";
    let mut ws_a = open_ws(&server, Some(a)).await;
    let response = disconnect(&server, json!({ "device": a })).await;
    assert_eq!(response.json::<Value>(), json!({ "closed": 1 }));
    assert_eq!(close_code(&mut ws_a).await, 1008);
    ws_request(&server, Some(a))
        .await
        .assert_status(StatusCode::UNAUTHORIZED);

    let text = String::from_utf8(log.0.lock().unwrap().clone()).unwrap();
    assert!(
        text.contains(&format!("disconnected device {a}: 1 connection")),
        "{text}"
    );
    assert!(!text.contains(TEST_TOKEN), "{text}");
    assert!(
        !text.contains(&URL_SAFE_NO_PAD.encode(TEST_TOKEN)),
        "{text}"
    );
}
