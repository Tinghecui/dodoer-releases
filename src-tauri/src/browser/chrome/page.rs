//! One tab of the person's Chrome that they handed to agents: a session on
//! the connection (`Target.attachToTarget`, flattened), and what the agent
//! tools need from it — script in an isolated world, real mouse events,
//! screenshots, navigation — plus what the page says back.
//!
//! Only a tab that was handed over is ever attached to; the rest are listed
//! (`tabs`) and nothing more. Attaching turns on focus emulation, so the page
//! believes it is in front and takes real clicks even while it is a
//! background tab or its window is minimized (measured, `docs/agent-chrome.md`
//! section 10). It ends with the session: detaching hands the tab back
//! exactly as it was.
//!
//! The world scripts run in is named `codeg`, as on every other surface, and
//! answers in the same envelope (`{"ok":true,"value":…}`), so the agent cores
//! cannot tell this tab from a built-in one.

use std::collections::HashMap;
use std::sync::{Arc, Mutex, MutexGuard};

use base64::Engine as _;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::cdp::{CdpClient, CdpError, CdpEvent};
use crate::browser::console;

/// The isolated world's name on every surface.
pub const WORLD_NAME: &str = "codeg";

/// What the page said, for the tab's registry entry to follow.
#[derive(Debug, Clone, PartialEq)]
pub enum PageEvent {
    /// A new document committed in the main frame.
    Committed { url: String },
    /// The main frame's document finished loading.
    Loaded { url: String },
    /// The address changed and the document did not (history API, fragment).
    SameDocument { url: String },
    Title(String),
    /// A console line, as the envelope `browser::channel` reads, and whether
    /// the main frame printed it.
    Console { envelope: String, main_frame: bool },
    /// The tab closed, the person detached it in DevTools, or the connection
    /// ended. Nothing more will come.
    Gone,
}

/// Where a mouse gesture stopped. `step` is the index of the event that
/// failed: nothing reached the page if it is 0 (the move before any button).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MouseFailure {
    pub step: usize,
    pub error: String,
}

#[derive(Default)]
struct PageState {
    url: String,
    title: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    main_frame: Option<String>,
    /// The `codeg` world of the main frame's current document.
    world: Option<i64>,
    /// The page's own world in each frame, with its origin: what a console
    /// line is attributed by. Another isolated world prints nothing an agent
    /// should read.
    page_contexts: HashMap<i64, (String, Option<String>)>,
}

struct Inner {
    client: CdpClient,
    target: String,
    session: String,
    state: Mutex<PageState>,
    /// Ends the follow task: this page detached itself.
    detached: CancellationToken,
}

/// Cheap to clone; every clone is the same attached tab.
#[derive(Clone)]
pub struct ChromePage {
    inner: Arc<Inner>,
}

impl ChromePage {
    /// Attach to the tab `target` on `client`, and start following it. The
    /// events come on the receiver until the tab is gone or [`Self::detach`]
    /// is called.
    pub async fn attach(
        client: &CdpClient,
        target: &str,
        url: &str,
        title: &str,
    ) -> Result<(Self, mpsc::UnboundedReceiver<PageEvent>), CdpError> {
        let attached = client
            .call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None)
            .await?;
        let Some(session) = attached["sessionId"].as_str() else {
            return Err(CdpError::Refused {
                method: "Target.attachToTarget".to_string(),
                code: 0,
                message: "no session in the answer".to_string(),
            });
        };
        let page = Self {
            inner: Arc::new(Inner {
                client: client.clone(),
                target: target.to_string(),
                session: session.to_string(),
                state: Mutex::new(PageState {
                    url: url.to_string(),
                    title: title.to_string(),
                    ..PageState::default()
                }),
                detached: CancellationToken::new(),
            }),
        };
        // Before the domains are enabled: enabling `Runtime` announces every
        // context the page already has, and those are what console lines are
        // attributed by.
        let (events, received) = mpsc::unbounded_channel();
        tokio::spawn(page.clone().follow(client.events(), events));
        if let Err(err) = page.start().await {
            page.detach();
            return Err(err);
        }
        Ok((page, received))
    }

    async fn start(&self) -> Result<(), CdpError> {
        self.call("Page.enable", json!({})).await?;
        self.call("Runtime.enable", json!({})).await?;
        self.call("Emulation.setFocusEmulationEnabled", json!({ "enabled": true }))
            .await?;
        let tree = self.call("Page.getFrameTree", json!({})).await?;
        let frame = &tree["frameTree"]["frame"];
        {
            let mut state = self.state();
            if let Some(id) = frame["id"].as_str() {
                state.main_frame = Some(id.to_string());
            }
            if let Some(url) = frame["url"].as_str() {
                state.url = format!("{url}{}", frame["urlFragment"].as_str().unwrap_or_default());
            }
        }
        self.refresh_history().await;
        Ok(())
    }

    /// Hand the tab back: the session ends and focus emulation with it. The
    /// tab itself stays open — it is the person's.
    pub fn detach(&self) {
        if self.inner.detached.is_cancelled() {
            return;
        }
        self.inner.detached.cancel();
        // Not waited for: called from wherever a tab is let go of, which is
        // not always somewhere that can wait.
        self.inner.client.send(
            "Target.detachFromTarget",
            json!({ "sessionId": self.inner.session }),
            None,
        );
    }

    pub fn url(&self) -> String {
        self.state().url.clone()
    }

    pub fn is_loading(&self) -> bool {
        self.state().loading
    }

    pub fn can_go_back(&self) -> bool {
        self.state().can_go_back
    }

    pub fn can_go_forward(&self) -> bool {
        self.state().can_go_forward
    }

    pub async fn navigate(&self, url: &str) -> Result<(), CdpError> {
        let answer = self.call("Page.navigate", json!({ "url": url })).await?;
        match answer["errorText"].as_str() {
            Some(error) if !error.is_empty() => Err(CdpError::Refused {
                method: "Page.navigate".to_string(),
                code: 0,
                message: error.to_string(),
            }),
            _ => Ok(()),
        }
    }

    pub async fn reload(&self) -> Result<(), CdpError> {
        self.call("Page.reload", json!({})).await.map(drop)
    }

    pub async fn stop(&self) -> Result<(), CdpError> {
        self.call("Page.stopLoading", json!({})).await.map(drop)
    }

    /// One step back (`-1`) or forward (`1`) in the tab's history; nothing
    /// when there is no such entry.
    pub async fn go(&self, delta: i64) -> Result<(), CdpError> {
        let history = self.call("Page.getNavigationHistory", json!({})).await?;
        let entries = history["entries"].as_array().map(Vec::as_slice).unwrap_or_default();
        let wanted = history["currentIndex"].as_i64().unwrap_or(0) + delta;
        let entry = usize::try_from(wanted).ok().and_then(|index| entries.get(index));
        if let Some(id) = entry.and_then(|entry| entry["id"].as_i64()) {
            self.call("Page.navigateToHistoryEntry", json!({ "entryId": id })).await?;
        }
        Ok(())
    }

    /// Evaluate `expression` in the `codeg` world of the main frame; the
    /// JSON envelope the agent cores read, or why there is none.
    pub async fn eval_in_world(&self, expression: &str) -> Result<String, String> {
        let wrapped = format!(
            "(function(){{try{{return JSON.stringify({{ok:true,value:(function(){{return ({expression});}})()}})}}catch(e){{return JSON.stringify({{ok:false,error:String(e&&e.stack||e)}})}}}})()"
        );
        // A world remembered for a document that has since been replaced is
        // refused; the second try builds one for the document there now.
        let mut last = String::new();
        for _ in 0..2 {
            let context = self.world().await?;
            let params = json!({ "expression": wrapped, "contextId": context, "returnByValue": true });
            match self.call("Runtime.evaluate", params).await {
                Ok(answer) => return envelope_of(&answer),
                Err(CdpError::Refused { message, .. }) => {
                    let mut state = self.state();
                    if state.world == Some(context) {
                        state.world = None;
                    }
                    last = message;
                }
                Err(err) => return Err(err.to_string()),
            }
        }
        Err(last)
    }

    async fn world(&self) -> Result<i64, String> {
        let frame = {
            let state = self.state();
            if let Some(world) = state.world {
                return Ok(world);
            }
            state.main_frame.clone().ok_or("the page has no document yet")?
        };
        let made = self
            .call(
                "Page.createIsolatedWorld",
                json!({ "frameId": frame, "worldName": WORLD_NAME }),
            )
            .await
            .map_err(|err| err.to_string())?;
        let world = made["executionContextId"]
            .as_i64()
            .ok_or("Chrome made no world")?;
        let mut state = self.state();
        if state.main_frame.as_deref() == Some(frame.as_str()) {
            state.world = Some(world);
        }
        Ok(world)
    }

    /// Deliver mouse events (`Input.dispatchMouseEvent` parameters), each
    /// once the one before it has been taken.
    pub async fn mouse(&self, steps: &[Value]) -> Result<(), MouseFailure> {
        for (step, params) in steps.iter().enumerate() {
            if let Err(err) = self.call("Input.dispatchMouseEvent", params.clone()).await {
                return Err(MouseFailure {
                    step,
                    error: err.to_string(),
                });
            }
        }
        Ok(())
    }

    /// The viewport as PNG bytes.
    pub async fn screenshot_png(&self) -> Result<Vec<u8>, String> {
        let shot = self
            .call("Page.captureScreenshot", json!({ "format": "png" }))
            .await
            .map_err(|err| err.to_string())?;
        let data = shot["data"].as_str().ok_or("Chrome sent no image")?;
        base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|err| format!("unreadable image: {err}"))
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value, CdpError> {
        self.inner
            .client
            .call(method, params, Some(self.inner.session.as_str()))
            .await
    }

    fn state(&self) -> MutexGuard<'_, PageState> {
        self.inner.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn refresh_history(&self) {
        let Ok(history) = self.call("Page.getNavigationHistory", json!({})).await else {
            return;
        };
        let count = history["entries"].as_array().map_or(0, Vec::len) as i64;
        let current = history["currentIndex"].as_i64().unwrap_or(0);
        let mut state = self.state();
        state.can_go_back = current > 0;
        state.can_go_forward = current + 1 < count;
    }

    async fn follow(
        self,
        mut incoming: tokio::sync::broadcast::Receiver<CdpEvent>,
        events: mpsc::UnboundedSender<PageEvent>,
    ) {
        loop {
            let event = tokio::select! {
                _ = self.inner.detached.cancelled() => return,
                _ = self.inner.client.closed() => {
                    let _ = events.send(PageEvent::Gone);
                    return;
                }
                event = incoming.recv() => event,
            };
            let event = match event {
                Ok(event) => event,
                Err(RecvError::Lagged(missed)) => {
                    tracing::warn!("[chrome] a shared tab missed {missed} events");
                    continue;
                }
                Err(RecvError::Closed) => return,
            };
            let mut gone = false;
            let mut history = false;
            for said in self.take_in(&event) {
                gone |= said == PageEvent::Gone;
                history |= matches!(said, PageEvent::Committed { .. } | PageEvent::SameDocument { .. } | PageEvent::Loaded { .. });
                if events.send(said).is_err() {
                    return;
                }
            }
            if gone {
                return;
            }
            if history {
                self.refresh_history().await;
            }
        }
    }

    /// What `event` means for this tab; mostly nothing.
    fn take_in(&self, event: &CdpEvent) -> Vec<PageEvent> {
        let params = &event.params;
        let Some(session) = event.session.as_deref() else {
            // The browser's own events: about this tab only by its target id.
            return match event.method.as_str() {
                "Target.targetDestroyed" if params["targetId"].as_str() == Some(self.inner.target.as_str()) => {
                    vec![PageEvent::Gone]
                }
                "Target.detachedFromTarget"
                    if params["sessionId"].as_str() == Some(self.inner.session.as_str()) =>
                {
                    vec![PageEvent::Gone]
                }
                "Target.targetInfoChanged"
                    if params["targetInfo"]["targetId"].as_str() == Some(self.inner.target.as_str()) =>
                {
                    let title = params["targetInfo"]["title"].as_str().unwrap_or_default();
                    let mut state = self.state();
                    if state.title == title {
                        return Vec::new();
                    }
                    state.title = title.to_string();
                    vec![PageEvent::Title(title.to_string())]
                }
                _ => Vec::new(),
            };
        };
        if session != self.inner.session {
            return Vec::new();
        }
        let mut state = self.state();
        match event.method.as_str() {
            "Page.frameNavigated" => {
                let frame = &params["frame"];
                if !frame["parentId"].is_null() {
                    return Vec::new();
                }
                let url = format!(
                    "{}{}",
                    frame["url"].as_str().unwrap_or_default(),
                    frame["urlFragment"].as_str().unwrap_or_default()
                );
                state.main_frame = frame["id"].as_str().map(str::to_string);
                state.url = url.clone();
                vec![PageEvent::Committed { url }]
            }
            "Page.navigatedWithinDocument" if is_main(&state, params["frameId"].as_str()) => {
                let url = params["url"].as_str().unwrap_or_default().to_string();
                state.url = url.clone();
                vec![PageEvent::SameDocument { url }]
            }
            "Page.frameStartedLoading" if is_main(&state, params["frameId"].as_str()) => {
                state.loading = true;
                Vec::new()
            }
            "Page.frameStoppedLoading" if is_main(&state, params["frameId"].as_str()) => {
                state.loading = false;
                Vec::new()
            }
            "Page.loadEventFired" => {
                state.loading = false;
                vec![PageEvent::Loaded {
                    url: state.url.clone(),
                }]
            }
            "Inspector.detached" => vec![PageEvent::Gone],
            "Runtime.executionContextCreated" => {
                let context = &params["context"];
                let (Some(id), Some(frame)) = (context["id"].as_i64(), context["auxData"]["frameId"].as_str())
                else {
                    return Vec::new();
                };
                if context["name"].as_str() == Some(WORLD_NAME) {
                    if is_main(&state, Some(frame)) {
                        state.world = Some(id);
                    }
                } else if context["auxData"]["isDefault"].as_bool() == Some(true) {
                    let origin = console::cdp_context_origin(context["origin"].as_str());
                    state.page_contexts.insert(id, (frame.to_string(), origin));
                }
                Vec::new()
            }
            "Runtime.executionContextDestroyed" => {
                if let Some(id) = params["executionContextId"].as_i64() {
                    state.page_contexts.remove(&id);
                    if state.world == Some(id) {
                        state.world = None;
                    }
                }
                Vec::new()
            }
            "Runtime.executionContextsCleared" => {
                state.page_contexts.clear();
                state.world = None;
                Vec::new()
            }
            "Runtime.consoleAPICalled" | "Runtime.exceptionThrown" => {
                let api = event.method == "Runtime.consoleAPICalled";
                let context = if api {
                    params["executionContextId"].as_i64()
                } else {
                    params["exceptionDetails"]["executionContextId"].as_i64()
                };
                let Some((frame, origin)) = context.and_then(|id| state.page_contexts.get(&id).cloned())
                else {
                    return Vec::new();
                };
                let main_frame = is_main(&state, Some(frame.as_str()));
                drop(state);
                console_envelope(params, api, main_frame, origin)
                    .map(|envelope| vec![PageEvent::Console { envelope, main_frame }])
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        }
    }
}

/// Whether `frame` is the main frame's.
fn is_main(state: &PageState, frame: Option<&str>) -> bool {
    frame.is_some() && frame == state.main_frame.as_deref()
}

/// The line as the envelope `browser::channel` reads from every surface.
fn console_envelope(params: &Value, api: bool, main_frame: bool, origin: Option<String>) -> Option<String> {
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or_default();
    let line = if api {
        console::cdp_console_line(params, at, main_frame, origin.clone())
    } else {
        console::cdp_exception_line(params, at, main_frame, origin.clone())
    }?;
    Some(
        json!({
            "kind": "console",
            "top": main_frame,
            "payload": {
                "level": line.level.as_str(),
                "source": serde_json::to_value(line.source).unwrap_or(Value::Null),
                "text": line.text,
                "url": line.url,
                "line": line.line,
                "column": line.column,
                "href": origin,
            },
        })
        .to_string(),
    )
}

/// The world's envelope out of a `Runtime.evaluate` answer.
fn envelope_of(answer: &Value) -> Result<String, String> {
    if let Some(details) = answer["exceptionDetails"].as_object() {
        return Err(details
            .get("text")
            .and_then(Value::as_str)
            .unwrap_or("evaluation failed")
            .to_string());
    }
    answer["result"]["value"]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| "non-string result".to_string())
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use super::super::cdp::testing::{chrome, FakeChrome};
    use super::*;

    const URL: &str = "https://example.com/form";

    /// Answers the calls a page makes while attaching, in order.
    async fn serve_attach(chrome: &mut FakeChrome) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.attachToTarget");
        assert_eq!(call["params"], json!({ "targetId": "T", "flatten": true }));
        assert!(call.get("sessionId").is_none());
        chrome.answer(&call, json!({ "sessionId": "S" })).await;
        for method in ["Page.enable", "Runtime.enable", "Emulation.setFocusEmulationEnabled"] {
            let call = chrome.next_call().await;
            assert_eq!(call["method"], method);
            assert_eq!(call["sessionId"], "S");
            chrome.answer(&call, json!({})).await;
        }
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Page.getFrameTree");
        chrome
            .answer(&call, json!({ "frameTree": { "frame": { "id": "F", "url": URL } } }))
            .await;
        serve_history(chrome, 1, 2).await;
    }

    async fn serve_history(chrome: &mut FakeChrome, current: i64, count: usize) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Page.getNavigationHistory");
        let entries: Vec<Value> = (0..count).map(|id| json!({ "id": id, "url": URL })).collect();
        chrome
            .answer(&call, json!({ "currentIndex": current, "entries": entries }))
            .await;
    }

    async fn attached() -> (ChromePage, mpsc::UnboundedReceiver<PageEvent>, FakeChrome) {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let attaching = tokio::spawn(async move { ChromePage::attach(&client, "T", URL, "Form").await });
        serve_attach(&mut chrome).await;
        let (page, events) = attaching.await.unwrap().unwrap();
        (page, events, chrome)
    }

    async fn next(events: &mut mpsc::UnboundedReceiver<PageEvent>) -> PageEvent {
        tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("nothing was said")
            .unwrap()
    }

    #[tokio::test]
    async fn attaching_turns_on_what_the_tools_need_and_reads_the_page() {
        let (page, _events, _chrome) = attached().await;
        assert_eq!(page.url(), URL);
        assert!(page.can_go_back());
        assert!(!page.can_go_forward());
        assert!(!page.is_loading());
    }

    #[tokio::test]
    async fn scripts_run_in_the_codeg_world_and_answer_in_the_envelope() {
        let (page, _events, mut chrome) = attached().await;
        let running = {
            let page = page.clone();
            tokio::spawn(async move { page.eval_in_world("1 + 1").await })
        };
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Page.createIsolatedWorld");
        assert_eq!(call["params"], json!({ "frameId": "F", "worldName": "codeg" }));
        chrome.answer(&call, json!({ "executionContextId": 7 })).await;
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Runtime.evaluate");
        assert_eq!(call["params"]["contextId"], 7);
        assert!(call["params"]["expression"].as_str().unwrap().contains("return (1 + 1);"));
        chrome
            .answer(&call, json!({ "result": { "type": "string", "value": "{\"ok\":true,\"value\":2}" } }))
            .await;
        assert_eq!(running.await.unwrap(), Ok("{\"ok\":true,\"value\":2}".to_string()));

        // The world is kept for the next script…
        let running = {
            let page = page.clone();
            tokio::spawn(async move { page.eval_in_world("2").await })
        };
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Runtime.evaluate");
        // …until Chrome no longer knows it: then one is built again.
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32000, "message": "Cannot find context with specified id" } }))
            .await;
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Page.createIsolatedWorld");
        chrome.answer(&call, json!({ "executionContextId": 8 })).await;
        let call = chrome.next_call().await;
        assert_eq!(call["params"]["contextId"], 8);
        chrome
            .answer(&call, json!({ "result": { "type": "string", "value": "{\"ok\":true,\"value\":2}" } }))
            .await;
        assert!(running.await.unwrap().is_ok());
    }

    #[tokio::test]
    async fn follows_navigations_titles_and_the_console() {
        let (page, mut events, mut chrome) = attached().await;
        chrome
            .say(json!({ "method": "Runtime.executionContextCreated", "sessionId": "S", "params": { "context": {
                "id": 3, "origin": "https://example.com", "name": "", "auxData": { "frameId": "F", "isDefault": true } } } }))
            .await;
        chrome
            .say(json!({ "method": "Runtime.consoleAPICalled", "sessionId": "S", "params": {
                "type": "error", "executionContextId": 3, "timestamp": 1.0, "args": [{ "type": "string", "value": "boom" }] } }))
            .await;
        match next(&mut events).await {
            PageEvent::Console { envelope, main_frame } => {
                assert!(main_frame);
                let envelope: Value = serde_json::from_str(&envelope).unwrap();
                assert_eq!(envelope["kind"], "console");
                assert_eq!(envelope["payload"]["text"], "boom");
            }
            other => panic!("not a console line: {other:?}"),
        }
        // Another tab's session is not this one.
        chrome
            .say(json!({ "method": "Page.frameNavigated", "sessionId": "OTHER", "params": { "frame": { "id": "X", "url": "https://other.example/" } } }))
            .await;
        chrome
            .say(json!({ "method": "Page.frameNavigated", "sessionId": "S", "params": { "frame": { "id": "F2", "url": "https://example.com/next", "urlFragment": "#top" } } }))
            .await;
        assert_eq!(
            next(&mut events).await,
            PageEvent::Committed { url: "https://example.com/next#top".to_string() }
        );
        serve_history(&mut chrome, 2, 3).await;
        chrome
            .say(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": { "targetId": "T", "type": "page", "title": "Next", "url": "https://example.com/next" } } }))
            .await;
        assert_eq!(next(&mut events).await, PageEvent::Title("Next".to_string()));
        chrome
            .say(json!({ "method": "Page.navigatedWithinDocument", "sessionId": "S", "params": { "frameId": "F2", "url": "https://example.com/next?step=2" } }))
            .await;
        assert_eq!(
            next(&mut events).await,
            PageEvent::SameDocument { url: "https://example.com/next?step=2".to_string() }
        );
        assert_eq!(page.url(), "https://example.com/next?step=2");
        serve_history(&mut chrome, 2, 3).await;

        chrome
            .say(json!({ "method": "Target.targetDestroyed", "params": { "targetId": "T" } }))
            .await;
        assert_eq!(next(&mut events).await, PageEvent::Gone);
    }

    #[tokio::test]
    async fn real_clicks_stop_at_the_first_refusal() {
        let (page, _events, mut chrome) = attached().await;
        let steps = vec![
            json!({ "type": "mouseMoved", "x": 1, "y": 2 }),
            json!({ "type": "mousePressed", "x": 1, "y": 2, "button": "left", "clickCount": 1 }),
            json!({ "type": "mouseReleased", "x": 1, "y": 2, "button": "left", "clickCount": 1 }),
        ];
        let clicking = {
            let page = page.clone();
            tokio::spawn(async move { page.mouse(&steps).await })
        };
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Input.dispatchMouseEvent");
        assert_eq!(call["params"]["type"], "mouseMoved");
        chrome.answer(&call, json!({})).await;
        let call = chrome.next_call().await;
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32000, "message": "no" } }))
            .await;
        let failure = clicking.await.unwrap().unwrap_err();
        assert_eq!(failure.step, 1);
    }

    #[tokio::test]
    async fn a_screenshot_is_png_bytes() {
        let (page, _events, mut chrome) = attached().await;
        let shooting = {
            let page = page.clone();
            tokio::spawn(async move { page.screenshot_png().await })
        };
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Page.captureScreenshot");
        assert_eq!(call["params"], json!({ "format": "png" }));
        chrome.answer(&call, json!({ "data": "iVBORw==" })).await;
        assert_eq!(shooting.await.unwrap().unwrap(), vec![0x89, b'P', b'N', b'G']);
    }

    #[tokio::test]
    async fn detaching_hands_the_tab_back_without_closing_it() {
        let (page, mut events, mut chrome) = attached().await;
        page.detach();
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.detachFromTarget");
        assert_eq!(call["params"], json!({ "sessionId": "S" }));
        // The follow task stopped quietly: no "gone" for a tab still open.
        assert!(tokio::time::timeout(Duration::from_secs(10), events.recv())
            .await
            .expect("the follow task did not end")
            .is_none());
    }

    #[tokio::test]
    async fn the_connection_ending_is_the_tab_going() {
        let (_page, mut events, chrome) = attached().await;
        drop(chrome);
        assert_eq!(next(&mut events).await, PageEvent::Gone);
    }
}
