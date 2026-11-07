//! Cowork fork: the optional `hello` → `server_info` handshake on
//! `/ws/events` (`web/ws.rs`, `crate::compat`).
//!
//! Upstream codeg clients never send `hello`, so the part that matters most is
//! that a socket without one goes exactly as before: `__ready__`, then only
//! answers to what the client asked. The harness mirrors `tests/ws_attach.rs`.

use std::sync::Arc;
use std::time::Duration;

use axum_test::TestServer;
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use codeg_lib::app_state::AppState;
use codeg_lib::db::test_helpers::fresh_in_memory_db;
use codeg_lib::web::router::build_router;
use codeg_lib::web::shutdown::ShutdownSignal;
use serde_json::{json, Value};

const TEST_TOKEN: &str = "ws-hello-test-token";

async fn build_ws_server() -> (TestServer, tempfile::TempDir, tempfile::TempDir) {
    let data_dir = tempfile::tempdir().expect("data dir");
    let static_dir = tempfile::tempdir().expect("static dir");
    let db = fresh_in_memory_db().await;
    let state = Arc::new(AppState::new_for_test(db, data_dir.path().to_path_buf()));
    let router = build_router(
        state,
        TEST_TOKEN.to_string(),
        static_dir.path().to_path_buf(),
        Arc::new(ShutdownSignal::new()),
    );
    let server = TestServer::builder()
        .http_transport()
        .build(router)
        .expect("test server");
    (server, data_dir, static_dir)
}

async fn open_ws(server: &TestServer) -> axum_test::TestWebSocket {
    let protocol = format!(
        "codeg-events, codeg-token.{}",
        URL_SAFE_NO_PAD.encode(TEST_TOKEN)
    );
    let mut ws = server
        .get_websocket("/ws/events")
        .add_header("sec-websocket-protocol", protocol)
        .await
        .into_websocket()
        .await;
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

/// The fields `/api/health` carries for clients, i.e. what `server_info` must
/// repeat.
async fn health_contract(server: &TestServer) -> Value {
    let health: Value = server
        .post("/api/health")
        .add_header("authorization", format!("Bearer {TEST_TOKEN}"))
        .json(&json!({}))
        .await
        .json();
    json!({
        "api_version": health["api_version"],
        "min_desktop_version": health["min_desktop_version"],
        "features": health["features"],
    })
}

#[tokio::test]
async fn without_hello_the_socket_goes_as_before() {
    let (server, _d, _s) = build_ws_server().await;
    let mut ws = open_ws(&server).await;

    // Nothing is pushed unasked after `__ready__`...
    let quiet = tokio::time::timeout(Duration::from_millis(300), ws.receive_text()).await;
    assert!(quiet.is_err(), "unexpected frame without hello: {quiet:?}");

    // ...and the first answer to a ping is the pong, not a `server_info`.
    ws.send_json(&json!({ "action": "ping" })).await;
    assert_eq!(next_json(&mut ws).await, json!({ "type": "pong" }));
}

#[tokio::test]
async fn hello_is_answered_with_the_health_contract() {
    let (server, _d, _s) = build_ws_server().await;
    let contract = health_contract(&server).await;
    assert_eq!(
        contract["api_version"],
        json!(1),
        "health carries the contract"
    );

    let mut ws = open_ws(&server).await;
    ws.send_json(&json!({
        "action": "hello",
        "client": "dodoer-desktop",
        "version": "1.2.5",
        "api_version": 1,
    }))
    .await;
    let info = next_json(&mut ws).await;
    assert_eq!(info["type"], "server_info");
    assert_eq!(info["api_version"], contract["api_version"]);
    assert_eq!(info["min_desktop_version"], contract["min_desktop_version"]);
    assert_eq!(info["features"], contract["features"]);

    // The socket carries on as usual afterwards.
    ws.send_json(&json!({ "action": "ping" })).await;
    assert_eq!(next_json(&mut ws).await, json!({ "type": "pong" }));
}

#[tokio::test]
async fn bare_or_extended_hello_is_answered_each_time() {
    let (server, _d, _s) = build_ws_server().await;
    let mut ws = open_ws(&server).await;
    for hello in [
        json!({ "action": "hello" }),
        json!({ "action": "hello", "client": "x", "capabilities": ["later"] }),
    ] {
        ws.send_json(&hello).await;
        assert_eq!(next_json(&mut ws).await["type"], "server_info", "{hello}");
    }
}
