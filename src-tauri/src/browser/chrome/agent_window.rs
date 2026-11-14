//! The window of the person's Chrome that agents open their pages in
//! (`docs/agent-chrome.md` section 5.6).
//!
//! Chrome cannot be told to open a tab in a given window: a new target goes
//! wherever Chrome likes, often among the person's own tabs. A tab that a page
//! opens, though, lands in that page's window (measured, section 10). So the
//! window is opened once per connection, around a start page of the app's
//! own, and every page after that is opened from the start page with
//! `window.open`. The start page stays; the agents' pages go wherever they go.
//!
//! Opening the window brings Chrome to the front, which cannot be helped
//! (section 10). It is left in front: the person sees agents start working
//! in their Chrome, and can take over at any point.

use std::fmt::Write as _;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::sync::Mutex;

use super::cdp::{CdpClient, CdpError};

/// How long Chrome may take to say it opened the tab asked for.
const OPEN_WAIT: Duration = Duration::from_secs(10);

/// The start page, which says whose window this is.
const START_HTML: &str = concat!(
    "<!doctype html><meta charset=\"utf-8\"><title>dodoer · 智能体的窗口</title>",
    "<body style=\"font:15px/1.6 -apple-system,system-ui,sans-serif;color:#555;",
    "max-width:34em;margin:20vh auto;padding:0 1em\">",
    "<h1 style=\"font-size:18px;color:#222\">这个窗口是 dodoer 的智能体在用</h1>",
    "<p>智能体打开的网页都在这个窗口里，你随时可以看、可以接手。",
    "要让它停下，在 dodoer 左下角的 Chrome 图标里关掉「让智能体用我的 Chrome」。</p>",
    "<p lang=\"en\">dodoer's agents open their pages in this window. ",
    "To stop them, turn agents off from the Chrome icon in dodoer.</p>",
    "<p>这个标签关掉也没关系，智能体下次开网页时会再开一个窗口。</p>",
);

/// [`START_HTML`] as an address Chrome opens. Everything but letters and
/// digits is escaped, so no character of the page can end the address early.
pub fn start_page() -> String {
    let mut address = String::from("data:text/html;charset=utf-8,");
    for byte in START_HTML.bytes() {
        if byte.is_ascii_alphanumeric() {
            address.push(byte as char);
        } else {
            let _ = write!(address, "%{byte:02X}");
        }
    }
    address
}

/// A tab Chrome opened for an agent.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opened {
    /// Chrome's target id.
    pub target: String,
    /// Where it was when Chrome announced it: often still nothing, the page
    /// asked for having not committed yet.
    pub url: String,
    pub title: String,
}

/// The start page of the window, on the connection it was opened on.
struct Start {
    client: CdpClient,
    target: String,
    session: String,
}

/// Why a page was not opened.
enum Failure {
    /// The start page would not run the script: it is no longer there to
    /// open anything from.
    Script(String),
    /// Anything after the script ran. Never retried: the tab may well be
    /// open already.
    Other(String),
}

/// The agents' window, opened on first use. One per app: the connection it
/// was opened on is remembered, and a new connection opens a new window.
#[derive(Default)]
pub struct AgentWindow {
    /// Held across a whole open, so that two agents' first pages do not open
    /// two windows.
    start: Mutex<Option<Start>>,
}

impl AgentWindow {
    /// Open `url` in a new tab of the agents' window on `client`, opening the
    /// window first if there is none. The tab is Chrome's to load; this
    /// returns once Chrome has said the tab exists.
    pub async fn open(&self, client: &CdpClient, url: &str) -> Result<Opened, String> {
        let mut start = self.start.lock().await;
        // Another connection's window, or a start page the person closed.
        let gone = match start.as_ref() {
            Some(current) => {
                !current.client.same(client)
                    || client
                        .call("Target.getTargetInfo", json!({ "targetId": current.target }), None)
                        .await
                        .is_err()
            }
            None => false,
        };
        if gone {
            *start = None;
        }
        let reused = start.is_some();
        let current = match start.take() {
            Some(current) => current,
            None => open_window(client).await.map_err(|err| format!("could not open a window for agents: {err}"))?,
        };
        let first = open_from(client, start.insert(current), url).await;
        match first {
            Ok(opened) => Ok(opened),
            // The session to the start page ended while the page stayed:
            // the person detached it in DevTools, say. A window of its own
            // again, once.
            Err(Failure::Script(_)) if reused => {
                let fresh = open_window(client)
                    .await
                    .map_err(|err| format!("could not open a window for agents: {err}"))?;
                open_from(client, start.insert(fresh), url)
                    .await
                    .map_err(Failure::into_message)
            }
            Err(failure) => Err(failure.into_message()),
        }
    }
}

impl Failure {
    fn into_message(self) -> String {
        match self {
            Failure::Script(message) | Failure::Other(message) => message,
        }
    }
}

async fn open_window(client: &CdpClient) -> Result<Start, CdpError> {
    let made = client
        .call(
            "Target.createTarget",
            json!({ "url": start_page(), "newWindow": true }),
            None,
        )
        .await?;
    let target = answered(&made, "targetId", "Target.createTarget")?;
    let attached = client
        .call("Target.attachToTarget", json!({ "targetId": target, "flatten": true }), None)
        .await?;
    let session = answered(&attached, "sessionId", "Target.attachToTarget")?;
    Ok(Start {
        client: client.clone(),
        target,
        session,
    })
}

fn answered(answer: &Value, field: &str, method: &str) -> Result<String, CdpError> {
    answer[field]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| CdpError::Refused {
            method: method.to_string(),
            code: 0,
            message: format!("no {field} in the answer"),
        })
}

async fn open_from(client: &CdpClient, start: &Start, url: &str) -> Result<Opened, Failure> {
    // Subscribed before asking, so that the new tab cannot be announced
    // before anybody listens.
    let mut events = client.events();
    // The new page is cut off from the start page at once: it is the
    // agent's, and has no business with the window it was opened from.
    // `noopener` would do the same and may leave Chrome unable to say which
    // page opened the tab, which is how it is recognized below.
    let expression = format!(
        "(() => {{ const opened = window.open({}, \"_blank\"); \
         if (opened) {{ try {{ opened.opener = null }} catch (_) {{}} }} \
         return opened ? 1 : 0 }})()",
        serde_json::to_string(url).unwrap_or_else(|_| "\"about:blank\"".to_string())
    );
    let ran = client
        .call(
            "Runtime.evaluate",
            // As if the person had clicked: a script with no gesture behind
            // it gets its window blocked as a popup.
            json!({ "expression": expression, "userGesture": true, "returnByValue": true }),
            Some(&start.session),
        )
        .await
        .map_err(|err| Failure::Script(err.to_string()))?;
    if ran["result"]["value"].as_i64() != Some(1) {
        return Err(Failure::Other("Chrome blocked the new tab".to_string()));
    }
    let announced = tokio::time::timeout(OPEN_WAIT, async {
        loop {
            match events.recv().await {
                Ok(event) if event.session.is_none() && event.method == "Target.targetCreated" => {
                    let info = &event.params["targetInfo"];
                    if info["type"].as_str() == Some("page")
                        && info["openerId"].as_str() == Some(start.target.as_str())
                    {
                        let text = |field: &str| info[field].as_str().unwrap_or_default().to_string();
                        if let Some(target) = info["targetId"].as_str() {
                            return Some(Opened {
                                target: target.to_string(),
                                url: text("url"),
                                title: text("title"),
                            });
                        }
                    }
                }
                Ok(_) | Err(RecvError::Lagged(_)) => {}
                Err(RecvError::Closed) => return None,
            }
        }
    })
    .await;
    match announced {
        Ok(Some(opened)) => Ok(opened),
        Ok(None) => Err(Failure::Other("the connection to Chrome ended".to_string())),
        Err(_) => Err(Failure::Other("Chrome did not say it opened the tab".to_string())),
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::super::cdp::testing::{chrome, FakeChrome};
    use super::*;

    const URL: &str = "https://example.com/form";

    async fn connected() -> (CdpClient, FakeChrome) {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let chrome = connections.recv().await.unwrap();
        (client, chrome)
    }

    async fn serve_window(chrome: &mut FakeChrome, target: &str, session: &str) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.createTarget");
        assert_eq!(call["params"]["newWindow"], true);
        assert_eq!(call["params"]["url"], start_page());
        chrome.answer(&call, json!({ "targetId": target })).await;
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.attachToTarget");
        assert_eq!(call["params"], json!({ "targetId": target, "flatten": true }));
        chrome.answer(&call, json!({ "sessionId": session })).await;
    }

    /// Answers the script on `session`, then announces a tab opened from
    /// `opener` — after another one opened by somebody else.
    async fn serve_open(chrome: &mut FakeChrome, session: &str, opener: &str, opened: &str) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Runtime.evaluate");
        assert_eq!(call["sessionId"], session);
        assert_eq!(call["params"]["userGesture"], true);
        let expression = call["params"]["expression"].as_str().unwrap();
        assert!(expression.contains("window.open(\"https://example.com/form\""));
        chrome.answer(&call, json!({ "result": { "type": "number", "value": 1 } })).await;
        chrome
            .say(json!({ "method": "Target.targetCreated", "params": { "targetInfo": {
                "targetId": "PERSONS", "type": "page", "url": "https://other.example/", "title": "" } } }))
            .await;
        chrome
            .say(json!({ "method": "Target.targetCreated", "params": { "targetInfo": {
                "targetId": opened, "type": "page", "openerId": opener, "url": "", "title": "" } } }))
            .await;
    }

    #[test]
    fn the_start_page_is_one_address() {
        let page = start_page();
        assert!(page.starts_with("data:text/html;charset=utf-8,"));
        assert!(!page.contains(['#', ' ', '"', '<']));
    }

    #[tokio::test]
    async fn the_first_page_opens_the_window_and_the_next_ones_go_into_it() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let opening = {
            let (window, client) = (window.clone(), client.clone());
            tokio::spawn(async move { window.open(&client, URL).await })
        };
        serve_window(&mut chrome, "W", "WS").await;
        serve_open(&mut chrome, "WS", "W", "N1").await;
        let opened = opening.await.unwrap().unwrap();
        assert_eq!(opened.target, "N1");

        let opening = {
            let (window, client) = (window.clone(), client.clone());
            tokio::spawn(async move { window.open(&client, URL).await })
        };
        // The window is still there: no second one.
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.getTargetInfo");
        assert_eq!(call["params"]["targetId"], "W");
        chrome.answer(&call, json!({ "targetInfo": { "targetId": "W" } })).await;
        serve_open(&mut chrome, "WS", "W", "N2").await;
        assert_eq!(opening.await.unwrap().unwrap().target, "N2");
    }

    #[tokio::test]
    async fn a_window_the_person_closed_is_opened_again() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let opening = {
            let (window, client) = (window.clone(), client.clone());
            tokio::spawn(async move { window.open(&client, URL).await })
        };
        serve_window(&mut chrome, "W", "WS").await;
        serve_open(&mut chrome, "WS", "W", "N1").await;
        opening.await.unwrap().unwrap();

        let opening = {
            let (window, client) = (window.clone(), client.clone());
            tokio::spawn(async move { window.open(&client, URL).await })
        };
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.getTargetInfo");
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32602, "message": "No target with given id found" } }))
            .await;
        serve_window(&mut chrome, "W2", "WS2").await;
        serve_open(&mut chrome, "WS2", "W2", "N2").await;
        assert_eq!(opening.await.unwrap().unwrap().target, "N2");
    }

    #[tokio::test]
    async fn a_blocked_tab_is_said_to_be() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let opening = {
            let (window, client) = (window.clone(), client.clone());
            tokio::spawn(async move { window.open(&client, URL).await })
        };
        serve_window(&mut chrome, "W", "WS").await;
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Runtime.evaluate");
        chrome.answer(&call, json!({ "result": { "type": "number", "value": 0 } })).await;
        let failed = opening.await.unwrap().unwrap_err();
        assert!(failed.contains("blocked"), "{failed}");
    }
}
