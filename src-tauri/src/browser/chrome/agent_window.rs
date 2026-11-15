//! The window of the person's Chrome that agents open their pages in
//! (`docs/agent-chrome.md` section 5.6).
//!
//! Chrome cannot be told to open a tab in a given window: a new target goes
//! to the window of Chrome used last, often among the person's own tabs. So
//! the window is opened once per connection, around a start page of the
//! app's own, and before each page the start page is brought to the front:
//! its window is then the one used last, and the new tab lands there
//! (measured, section 10, fourth round). Should the person click into
//! another window of Chrome in between, the page lands there instead; it is
//! the agents' all the same, marked so in the panel.
//!
//! Pages used to be opened from the start page with `window.open`, which on
//! the person's own Chrome crashed Chrome every time, in a check of Chrome's
//! own about the page that opened the new one (section 10, fourth round). A
//! tab DevTools asks for is opened by Chrome itself, with no page behind it,
//! and never reaches that check.
//!
//! Opening the window brings Chrome to the front, which cannot be helped
//! (section 10), and so does every page after it, its window being brought
//! up first. Chrome is left in front: the person sees agents working in
//! their Chrome, and can take over at any point.

use std::fmt::Write as _;
use std::time::Duration;

use serde_json::{json, Value};
use tokio::sync::Mutex;

use super::cdp::{CdpClient, CdpError};

/// How long Chrome is given, once it says it brought the agents' window up,
/// to count that window as the one used last. What the fourth round waited
/// (section 10); shorter was not tried.
const SETTLE: Duration = Duration::from_millis(300);

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
}

/// The agents' window, opened on first use. One per app: the connection it
/// was opened on is remembered, and a new connection opens a new window.
#[derive(Default)]
pub struct AgentWindow {
    /// Held across a whole open, so that two agents' first pages do not open
    /// two windows, and one agent's page does not land in the window another
    /// is bringing up.
    start: Mutex<Option<Start>>,
}

impl AgentWindow {
    /// Open `url` in a new tab of the agents' window on `client`, opening the
    /// window first if there is none. The tab is Chrome's to load; this
    /// returns once Chrome has said the tab exists.
    pub async fn open(&self, client: &CdpClient, url: &str) -> Result<Opened, String> {
        let mut start = self.start.lock().await;
        if start.as_ref().is_some_and(|current| !current.client.same(client)) {
            *start = None;
        }
        // Bringing the window up is also how a start page the person closed
        // is found out: there is no window to bring up any more.
        let up = match start.as_ref() {
            Some(current) => bring_up(client, &current.target).await.is_ok(),
            None => false,
        };
        if !up {
            *start = None;
            let fresh = open_window(client)
                .await
                .map_err(|err| format!("could not open a window for agents: {err}"))?;
            bring_up(client, &fresh.target)
                .await
                .map_err(|err| format!("could not bring the agents' window up: {err}"))?;
            *start = Some(fresh);
        }
        tokio::time::sleep(SETTLE).await;
        let current = start.as_ref().expect("a window was brought up above");
        open_page(client, current, url).await.map_err(|err| err.to_string())
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
    Ok(Start {
        client: client.clone(),
        target: answered(&made, "targetId", "Target.createTarget")?,
    })
}

async fn bring_up(client: &CdpClient, start: &str) -> Result<(), CdpError> {
    client
        .call("Target.activateTarget", json!({ "targetId": start }), None)
        .await
        .map(drop)
}

async fn open_page(client: &CdpClient, start: &Start, url: &str) -> Result<Opened, CdpError> {
    let made = client
        .call("Target.createTarget", json!({ "url": url }), None)
        .await?;
    let target = answered(&made, "targetId", "Target.createTarget")?;
    if let (Some(ours), Some(its)) = (window_of(client, &start.target).await, window_of(client, &target).await) {
        if ours != its {
            // Nothing to be done about it — Chrome does not move tabs — but
            // it is how to find out how often it happens.
            tracing::warn!("[chrome] an agent's page opened outside the agents' window");
        }
    }
    // Where it is as Chrome opened it: often still nothing, the page asked
    // for having not committed yet.
    let info = client
        .call("Target.getTargetInfo", json!({ "targetId": target }), None)
        .await
        .ok();
    let text = |field: &str| {
        info.as_ref()
            .and_then(|info| info["targetInfo"][field].as_str())
            .unwrap_or_default()
            .to_string()
    };
    Ok(Opened {
        url: text("url"),
        title: text("title"),
        target,
    })
}

async fn window_of(client: &CdpClient, target: &str) -> Option<i64> {
    client
        .call("Browser.getWindowForTarget", json!({ "targetId": target }), None)
        .await
        .ok()?["windowId"]
        .as_i64()
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

    fn opening(window: &Arc<AgentWindow>, client: &CdpClient) -> tokio::task::JoinHandle<Result<Opened, String>> {
        let (window, client) = (window.clone(), client.clone());
        tokio::spawn(async move { window.open(&client, URL).await })
    }

    async fn serve_window(chrome: &mut FakeChrome, start: &str) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.createTarget");
        assert_eq!(call["params"], json!({ "url": start_page(), "newWindow": true }));
        chrome.answer(&call, json!({ "targetId": start })).await;
        serve_bring_up(chrome, start).await;
    }

    async fn serve_bring_up(chrome: &mut FakeChrome, start: &str) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.activateTarget");
        assert_eq!(call["params"]["targetId"], start);
        chrome.answer(&call, json!({})).await;
    }

    /// Opens the page as `opened`, in window `landed_in`; the start page is
    /// in window 1.
    async fn serve_page(chrome: &mut FakeChrome, start: &str, opened: &str, landed_in: i64) {
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.createTarget");
        // Not a new window, and nothing that would keep it out of the one
        // used last.
        assert_eq!(call["params"], json!({ "url": URL }));
        chrome.answer(&call, json!({ "targetId": opened })).await;
        for (target, window) in [(start, 1), (opened, landed_in)] {
            let call = chrome.next_call().await;
            assert_eq!(call["method"], "Browser.getWindowForTarget");
            assert_eq!(call["params"]["targetId"], target);
            chrome.answer(&call, json!({ "windowId": window })).await;
        }
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.getTargetInfo");
        assert_eq!(call["params"]["targetId"], opened);
        chrome
            .answer(&call, json!({ "targetInfo": {
                "targetId": opened, "type": "page", "url": "about:blank", "title": "about:blank" } }))
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
        let first = opening(&window, &client);
        serve_window(&mut chrome, "W").await;
        serve_page(&mut chrome, "W", "N1", 1).await;
        let opened = first.await.unwrap().unwrap();
        assert_eq!(opened.target, "N1");
        assert_eq!(opened.url, "about:blank");

        // The window is still there: brought up, and no second one.
        let second = opening(&window, &client);
        serve_bring_up(&mut chrome, "W").await;
        serve_page(&mut chrome, "W", "N2", 1).await;
        assert_eq!(second.await.unwrap().unwrap().target, "N2");
    }

    #[tokio::test]
    async fn a_window_the_person_closed_is_opened_again() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let first = opening(&window, &client);
        serve_window(&mut chrome, "W").await;
        serve_page(&mut chrome, "W", "N1", 1).await;
        first.await.unwrap().unwrap();

        let second = opening(&window, &client);
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.activateTarget");
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32602, "message": "No target with given id found" } }))
            .await;
        serve_window(&mut chrome, "W2").await;
        serve_page(&mut chrome, "W2", "N2", 1).await;
        assert_eq!(second.await.unwrap().unwrap().target, "N2");
    }

    #[tokio::test]
    async fn a_page_that_landed_in_another_window_is_still_the_agents() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let first = opening(&window, &client);
        serve_window(&mut chrome, "W").await;
        serve_page(&mut chrome, "W", "N1", 2).await;
        assert_eq!(first.await.unwrap().unwrap().target, "N1");
    }

    #[tokio::test]
    async fn a_page_chrome_would_not_open_is_said_to_be() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let first = opening(&window, &client);
        serve_window(&mut chrome, "W").await;
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.createTarget");
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32000, "message": "Failed to open a new tab" } }))
            .await;
        let failed = first.await.unwrap().unwrap_err();
        assert!(failed.contains("Failed to open a new tab"), "{failed}");
    }

    /// The crash this replaces: no page of the agents' window is ever asked
    /// to run a script, `window.open` least of all.
    #[tokio::test]
    async fn nothing_is_run_in_a_page() {
        let (client, mut chrome) = connected().await;
        let window = Arc::new(AgentWindow::default());
        let first = opening(&window, &client);
        let mut seen = Vec::new();
        loop {
            let call = chrome.next_call().await;
            assert!(call.get("sessionId").is_none(), "asked of a page: {call}");
            seen.push(call["method"].as_str().unwrap().to_string());
            let answer = match call["method"].as_str().unwrap() {
                "Target.createTarget" if call["params"]["newWindow"] == true => json!({ "targetId": "W" }),
                "Target.createTarget" => json!({ "targetId": "N1" }),
                "Browser.getWindowForTarget" => json!({ "windowId": 1 }),
                "Target.getTargetInfo" => json!({ "targetInfo": { "targetId": "N1", "url": "", "title": "" } }),
                _ => json!({}),
            };
            let last = call["method"] == "Target.getTargetInfo";
            chrome.answer(&call, answer).await;
            if last {
                break;
            }
        }
        first.await.unwrap().unwrap();
        assert!(!seen.iter().any(|method| method.starts_with("Runtime.")), "{seen:?}");
    }
}
