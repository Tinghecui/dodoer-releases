//! The host bridge: the desktop app's built-in browser and computer use,
//! served to the agents of its child daemon.
//!
//! Cowork fork (daemon/client split, step 2, see `local_daemon`). When the
//! daemon ran inside the app, its delegation service called the app's
//! browser tabs (`commands::browser::McpBrowserTools`) and its computer-use
//! service (`commands::computer::McpComputerTools`) directly. Both need the
//! app — native webviews, the screen-sharing panel, the permission prompts —
//! so they stay in the app, and the child reaches them over this bridge: a
//! loopback HTTP endpoint the app listens on, with a token of its own,
//! handed to the child in `CODEG_HOST_BRIDGE_URL` / `CODEG_HOST_BRIDGE_TOKEN`.
//!
//! One call is one JSON body: which tool, which method, its arguments — the
//! same request and outcome types the delegation listener already speaks, so
//! an agent sees exactly what it saw in-process. When the bridge cannot be
//! reached the client answers what a runtime without a browser / desktop
//! answers (`NoBrowserTabs`, `NoComputerDesktop`), never an error the agent
//! would not know.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use axum::{Json, Router};
use serde::{Deserialize, Serialize};

use crate::acp::browser_tools::{
    BrowserActOutcome, BrowserCaptureOutcome, BrowserConsoleOutcome, BrowserEvalOutcome,
    BrowserSnapshotOutcome, BrowserTabOp, BrowserTabOutcome, BrowserTabsOutcome, BrowserToolAccess,
    NoBrowserTabs,
};
use crate::acp::computer_tools::{
    ClipboardOp, ComputerActOutcome, ComputerAppsOutcome, ComputerCaptureOutcome,
    ComputerClipboardOutcome, ComputerLaunchOutcome, ComputerSnapshotOutcome, ComputerToolAccess,
    ComputerVerifyOutcome, ComputerWindowsOutcome, NoComputerDesktop, SnapshotRequest,
};
use crate::browser::agent::ActionRequest;
use crate::browser::capture::CaptureRequest;
use crate::browser::console::ConsoleQuery;
use crate::browser::eval::EvalRequest;
use crate::computer::types::{ActDelivery, ComputerActRequest, VerifyRequest};

pub const CALL_PATH: &str = "/host-bridge/call";

/// One browser-tool call, as `BrowserToolAccess` takes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "args", rename_all = "snake_case")]
pub enum BrowserCall {
    ListTabs,
    Snapshot {
        tab_id: String,
        max_chars: Option<usize>,
    },
    Act {
        tab_id: String,
        request: ActionRequest,
    },
    Console {
        tab_id: String,
        query: ConsoleQuery,
    },
    Capture {
        tab_id: String,
        request: CaptureRequest,
    },
    Eval {
        tab_id: String,
        request: EvalRequest,
    },
    TabOp {
        op: BrowserTabOp,
    },
}

/// One computer-use call, as `ComputerToolAccess` takes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "method", content = "args", rename_all = "snake_case")]
pub enum ComputerCall {
    ListApps,
    ListWindows {
        pid: Option<u32>,
    },
    Capture {
        target_id: String,
        max_dimension: Option<u32>,
    },
    Snapshot {
        target_id: String,
        request: SnapshotRequest,
    },
    Verify {
        target_id: String,
        request: VerifyRequest,
    },
    Act {
        target_id: String,
        request: ComputerActRequest,
        delivery: Option<ActDelivery>,
    },
    LaunchApp {
        name: Option<String>,
        key: Option<String>,
    },
    Clipboard {
        op: ClipboardOp,
    },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "tool", content = "call", rename_all = "snake_case")]
pub enum BridgeCall {
    Browser(BrowserCall),
    Computer(ComputerCall),
}

/// What the app serves: its own browser and computer-use tools.
#[derive(Clone)]
pub struct HostTools {
    pub browser: Arc<dyn BrowserToolAccess>,
    pub computer: Arc<dyn ComputerToolAccess>,
}

fn to_value<T: Serialize>(outcome: T) -> serde_json::Value {
    serde_json::to_value(outcome).unwrap_or(serde_json::Value::Null)
}

/// Run one call against the app's tools; the outcome as JSON.
pub async fn dispatch(tools: &HostTools, call: BridgeCall) -> serde_json::Value {
    match call {
        BridgeCall::Browser(call) => {
            let b = &tools.browser;
            match call {
                BrowserCall::ListTabs => to_value(b.list_tabs().await),
                BrowserCall::Snapshot { tab_id, max_chars } => {
                    to_value(b.snapshot(&tab_id, max_chars).await)
                }
                BrowserCall::Act { tab_id, request } => to_value(b.act(&tab_id, request).await),
                BrowserCall::Console { tab_id, query } => to_value(b.console(&tab_id, query).await),
                BrowserCall::Capture { tab_id, request } => {
                    to_value(b.capture(&tab_id, request).await)
                }
                BrowserCall::Eval { tab_id, request } => to_value(b.eval(&tab_id, request).await),
                BrowserCall::TabOp { op } => to_value(b.tab_op(op).await),
            }
        }
        BridgeCall::Computer(call) => {
            let c = &tools.computer;
            match call {
                ComputerCall::ListApps => to_value(c.list_apps().await),
                ComputerCall::ListWindows { pid } => to_value(c.list_windows(pid).await),
                ComputerCall::Capture {
                    target_id,
                    max_dimension,
                } => to_value(c.capture(&target_id, max_dimension).await),
                ComputerCall::Snapshot { target_id, request } => {
                    to_value(c.snapshot(&target_id, request).await)
                }
                ComputerCall::Verify { target_id, request } => {
                    to_value(c.verify(&target_id, request).await)
                }
                ComputerCall::Act {
                    target_id,
                    request,
                    delivery,
                } => to_value(c.act(&target_id, request, delivery).await),
                ComputerCall::LaunchApp { name, key } => to_value(c.launch_app(name, key).await),
                ComputerCall::Clipboard { op } => to_value(c.clipboard(op).await),
            }
        }
    }
}

#[derive(Clone)]
struct ServeState {
    tools: Arc<std::sync::OnceLock<HostTools>>,
    token: Arc<String>,
}

/// Tools set once the app has them; until then (and in a test) every call
/// is answered as by a runtime without them.
fn null_tools() -> HostTools {
    HostTools {
        browser: Arc::new(NoBrowserTabs),
        computer: Arc::new(NoComputerDesktop),
    }
}

fn token_matches(headers: &HeaderMap, token: &str) -> bool {
    let Some(given) = headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
    else {
        return false;
    };
    // Constant-time: the length leaks nothing worth having (it is fixed).
    given.len() == token.len()
        && given
            .bytes()
            .zip(token.bytes())
            .fold(0u8, |acc, (a, b)| acc | (a ^ b))
            == 0
}

async fn handle_call(
    State(state): State<ServeState>,
    headers: HeaderMap,
    Json(call): Json<BridgeCall>,
) -> Response {
    if !token_matches(&headers, &state.token) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let tools = state.tools.get().cloned().unwrap_or_else(null_tools);
    Json(dispatch(&tools, call).await).into_response()
}

/// The app's side, listening.
pub struct HostBridgeServer {
    pub url: String,
    pub token: String,
    tools: Arc<std::sync::OnceLock<HostTools>>,
    task: tokio::task::JoinHandle<()>,
}

impl HostBridgeServer {
    /// Listen on a loopback port of the OS's choosing, with a fresh token.
    pub async fn bind() -> std::io::Result<HostBridgeServer> {
        let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let token = crate::cli_run::hello::random_hex(32);
        let tools = Arc::new(std::sync::OnceLock::new());
        let state = ServeState {
            tools: Arc::clone(&tools),
            token: Arc::new(token.clone()),
        };
        let app = Router::new()
            .route(CALL_PATH, post(handle_call))
            .with_state(state);
        let task = tokio::spawn(async move {
            if let Err(e) = axum::serve(listener, app).await {
                tracing::warn!("[host-bridge] stopped: {e}");
            }
        });
        Ok(HostBridgeServer {
            url: format!("http://{addr}"),
            token,
            tools,
            task,
        })
    }

    /// The tools to serve from now on. Only the first call counts.
    pub fn serve(&self, tools: HostTools) {
        let _ = self.tools.set(tools);
    }

    pub fn env(&self) -> crate::local_daemon::HostBridgeEnv {
        crate::local_daemon::HostBridgeEnv {
            url: self.url.clone(),
            token: self.token.clone(),
        }
    }

    pub fn shutdown(&self) {
        self.task.abort();
    }
}

/// The child's side: the agent tools, answered by the app.
#[derive(Clone)]
pub struct HostBridgeClient {
    url: String,
    token: String,
    http: reqwest::Client,
}

impl HostBridgeClient {
    pub fn new(url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            url: url.into(),
            token: token.into(),
            // No overall timeout: `eval` waits on a person, `tab_op` on a
            // page load. Never through a proxy: the app is on loopback.
            http: reqwest::Client::builder()
                .no_proxy()
                .connect_timeout(Duration::from_secs(5))
                .build()
                .unwrap_or_default(),
        }
    }

    /// From `CODEG_HOST_BRIDGE_URL` / `CODEG_HOST_BRIDGE_TOKEN`, when both
    /// are set (a desktop app's own daemon).
    pub fn from_env() -> Option<Self> {
        let url = std::env::var(crate::local_daemon::HOST_BRIDGE_URL_ENV).ok()?;
        let token = std::env::var(crate::local_daemon::HOST_BRIDGE_TOKEN_ENV).ok()?;
        (!url.trim().is_empty() && !token.trim().is_empty()).then(|| Self::new(url, token))
    }

    async fn call<T: serde::de::DeserializeOwned>(&self, call: BridgeCall) -> Result<T, String> {
        let response = self
            .http
            .post(format!("{}{CALL_PATH}", self.url.trim_end_matches('/')))
            .bearer_auth(&self.token)
            .json(&call)
            .send()
            .await
            .map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("host bridge answered {}", response.status()));
        }
        response.json::<T>().await.map_err(|e| e.to_string())
    }

    async fn browser<T: serde::de::DeserializeOwned>(
        &self,
        call: BrowserCall,
    ) -> Result<T, String> {
        let result = self.call(BridgeCall::Browser(call)).await;
        if let Err(e) = &result {
            tracing::warn!("[host-bridge] browser call failed: {e}");
        }
        result
    }

    async fn computer<T: serde::de::DeserializeOwned>(
        &self,
        call: ComputerCall,
    ) -> Result<T, String> {
        let result = self.call(BridgeCall::Computer(call)).await;
        if let Err(e) = &result {
            tracing::warn!("[host-bridge] computer-use call failed: {e}");
        }
        result
    }
}

#[async_trait]
impl BrowserToolAccess for HostBridgeClient {
    async fn list_tabs(&self) -> BrowserTabsOutcome {
        match self.browser(BrowserCall::ListTabs).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.list_tabs().await,
        }
    }

    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        let call = BrowserCall::Snapshot {
            tab_id: tab_id.to_string(),
            max_chars,
        };
        match self.browser(call).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.snapshot(tab_id, max_chars).await,
        }
    }

    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome {
        let call = BrowserCall::Act {
            tab_id: tab_id.to_string(),
            request: request.clone(),
        };
        match self.browser(call).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.act(tab_id, request).await,
        }
    }

    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome {
        let call = BrowserCall::Console {
            tab_id: tab_id.to_string(),
            query: query.clone(),
        };
        match self.browser(call).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.console(tab_id, query).await,
        }
    }

    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome {
        let call = BrowserCall::Capture {
            tab_id: tab_id.to_string(),
            request: request.clone(),
        };
        match self.browser(call).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.capture(tab_id, request).await,
        }
    }

    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome {
        let call = BrowserCall::Eval {
            tab_id: tab_id.to_string(),
            request: request.clone(),
        };
        match self.browser(call).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.eval(tab_id, request).await,
        }
    }

    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        match self.browser(BrowserCall::TabOp { op: op.clone() }).await {
            Ok(o) => o,
            Err(_) => NoBrowserTabs.tab_op(op).await,
        }
    }
}

#[async_trait]
impl ComputerToolAccess for HostBridgeClient {
    async fn list_apps(&self) -> ComputerAppsOutcome {
        match self.computer(ComputerCall::ListApps).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.list_apps().await,
        }
    }

    async fn list_windows(&self, pid: Option<u32>) -> ComputerWindowsOutcome {
        match self.computer(ComputerCall::ListWindows { pid }).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.list_windows(pid).await,
        }
    }

    async fn capture(&self, target_id: &str, max_dimension: Option<u32>) -> ComputerCaptureOutcome {
        let call = ComputerCall::Capture {
            target_id: target_id.to_string(),
            max_dimension,
        };
        match self.computer(call).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.capture(target_id, max_dimension).await,
        }
    }

    async fn snapshot(&self, target_id: &str, request: SnapshotRequest) -> ComputerSnapshotOutcome {
        let call = ComputerCall::Snapshot {
            target_id: target_id.to_string(),
            request: request.clone(),
        };
        match self.computer(call).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.snapshot(target_id, request).await,
        }
    }

    async fn verify(&self, target_id: &str, request: VerifyRequest) -> ComputerVerifyOutcome {
        let call = ComputerCall::Verify {
            target_id: target_id.to_string(),
            request: request.clone(),
        };
        match self.computer(call).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.verify(target_id, request).await,
        }
    }

    async fn act(
        &self,
        target_id: &str,
        request: ComputerActRequest,
        delivery: Option<ActDelivery>,
    ) -> ComputerActOutcome {
        let call = ComputerCall::Act {
            target_id: target_id.to_string(),
            request: request.clone(),
            delivery,
        };
        match self.computer(call).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.act(target_id, request, delivery).await,
        }
    }

    async fn launch_app(&self, name: Option<String>, key: Option<String>) -> ComputerLaunchOutcome {
        let call = ComputerCall::LaunchApp {
            name: name.clone(),
            key: key.clone(),
        };
        match self.computer(call).await {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.launch_app(name, key).await,
        }
    }

    async fn clipboard(&self, op: ClipboardOp) -> ComputerClipboardOutcome {
        match self
            .computer(ComputerCall::Clipboard { op: op.clone() })
            .await
        {
            Ok(o) => o,
            Err(_) => NoComputerDesktop.clipboard(op).await,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn calls_round_trip_as_tagged_json() {
        let call = BridgeCall::Browser(BrowserCall::Snapshot {
            tab_id: "t1".into(),
            max_chars: Some(10),
        });
        let json = serde_json::to_value(&call).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "tool": "browser",
                "call": {"method": "snapshot", "args": {"tab_id": "t1", "max_chars": 10}}
            })
        );
        assert_eq!(serde_json::from_value::<BridgeCall>(json).unwrap(), call);
        let list = serde_json::to_value(BridgeCall::Computer(ComputerCall::ListApps)).unwrap();
        assert_eq!(
            list,
            serde_json::json!({"tool": "computer", "call": {"method": "list_apps"}})
        );
    }

    #[test]
    fn only_the_bridge_token_is_let_in() {
        let mut headers = HeaderMap::new();
        assert!(!token_matches(&headers, "abc"));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer abd".parse().unwrap(),
        );
        assert!(!token_matches(&headers, "abc"));
        headers.insert(
            axum::http::header::AUTHORIZATION,
            "Bearer abc".parse().unwrap(),
        );
        assert!(token_matches(&headers, "abc"));
        assert!(!token_matches(&headers, "abcd"));
    }

    #[tokio::test]
    async fn a_served_call_reaches_the_tools_and_a_wrong_token_does_not() {
        let server = HostBridgeServer::bind().await.unwrap();
        server.serve(null_tools());
        let client = HostBridgeClient::new(&server.url, &server.token);
        // NoBrowserTabs' own answer, carried across the bridge.
        let tabs = BrowserToolAccess::list_tabs(&client).await;
        assert_eq!(tabs, NoBrowserTabs.list_tabs().await);
        let wrong = HostBridgeClient::new(&server.url, "wrong");
        let refused: Result<BrowserTabsOutcome, String> =
            wrong.call(BridgeCall::Browser(BrowserCall::ListTabs)).await;
        assert!(refused.unwrap_err().contains("401"));
        server.shutdown();
    }

    #[tokio::test]
    async fn an_unreachable_bridge_answers_as_no_browser() {
        let port = crate::local_daemon::free_loopback_port().unwrap();
        let client = HostBridgeClient::new(format!("http://127.0.0.1:{port}"), "t");
        assert_eq!(
            BrowserToolAccess::list_tabs(&client).await,
            NoBrowserTabs.list_tabs().await
        );
        assert_eq!(
            ComputerToolAccess::list_apps(&client).await,
            NoComputerDesktop.list_apps().await
        );
    }
}
