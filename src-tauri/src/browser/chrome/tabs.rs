//! Which tabs the connected Chrome has open, for the person to see.
//!
//! Chrome is only asked to say when tabs come, go and change
//! (`Target.setDiscoverTargets`). No tab is attached to and nothing runs in
//! any page: a page cannot tell it is being listed.
//!
//! The list is the person's alone. These tabs are not in the browser
//! registry (`browser::registry`), so no agent tool can name one, let alone
//! read it; a tab gets there only once the person hands it over (a later
//! step, `docs/agent-chrome.md` section 7).
//!
//! What leaves this module is the least the panel needs — a title and a host
//! name. Paths and queries stay here: they are where sign-in links and
//! tokens live.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;

use super::cdp::CdpClient;

/// Mirrored by `ChromeTab` in `src/lib/browser/chrome-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeTab {
    /// The app's own name for the tab. Chrome's target id never leaves the
    /// backend.
    pub id: String,
    /// What Chrome shows on the tab; the address itself when the page has no
    /// title.
    pub title: String,
    pub host: String,
}

/// A page target as Chrome last described it.
struct Known {
    id: String,
    /// When it was first seen: the list keeps that order, so a tab that
    /// changes does not jump about in it.
    seen: u64,
    url: String,
    title: String,
    /// Set for a page Chrome is loading ahead of time, which is not a tab
    /// (yet).
    subtype: Option<String>,
}

#[derive(Default)]
pub(super) struct TabList {
    /// By Chrome's target id.
    known: HashMap<String, Known>,
    seen: u64,
}

impl TabList {
    /// Take in one of Chrome's target events; whether the list changed.
    pub(super) fn apply(&mut self, method: &str, params: &Value) -> bool {
        let before = self.tabs();
        match method {
            "Target.targetCreated" | "Target.targetInfoChanged" => self.learn(&params["targetInfo"]),
            "Target.targetDestroyed" => {
                if let Some(target) = params["targetId"].as_str() {
                    self.known.remove(target);
                }
            }
            _ => return false,
        }
        self.tabs() != before
    }

    /// Start over from Chrome's whole list (`Target.getTargets`), keeping
    /// the names of the tabs still there.
    pub(super) fn reset(&mut self, infos: &Value) {
        let infos = infos.as_array().map(Vec::as_slice).unwrap_or_default();
        let present: HashSet<&str> = infos.iter().filter_map(|info| info["targetId"].as_str()).collect();
        self.known.retain(|target, _| present.contains(target.as_str()));
        for info in infos {
            self.learn(info);
        }
    }

    /// The web pages among the tabs, oldest first. Chrome's own pages
    /// (`chrome://`, extensions, DevTools) are not listed.
    pub(super) fn tabs(&self) -> Vec<ChromeTab> {
        let mut listed: Vec<(&Known, String)> = self
            .known
            .values()
            .filter(|known| known.subtype.is_none())
            .filter_map(|known| host_of(&known.url).map(|host| (known, host)))
            .collect();
        listed.sort_by_key(|(known, _)| known.seen);
        listed
            .into_iter()
            .map(|(known, host)| ChromeTab {
                id: known.id.clone(),
                title: known.title.clone(),
                host,
            })
            .collect()
    }

    fn learn(&mut self, info: &Value) {
        let Some(target) = info["targetId"].as_str() else {
            return;
        };
        // Workers, frames, the browser itself: not tabs.
        if info["type"].as_str() != Some("page") {
            return;
        }
        let text = |field: &str| info[field].as_str().unwrap_or_default().to_string();
        let subtype = info["subtype"].as_str().filter(|subtype| !subtype.is_empty()).map(str::to_string);
        match self.known.get_mut(target) {
            Some(known) => {
                known.url = text("url");
                known.title = text("title");
                known.subtype = subtype;
            }
            None => {
                self.seen += 1;
                self.known.insert(
                    target.to_string(),
                    Known {
                        id: uuid::Uuid::new_v4().to_string(),
                        seen: self.seen,
                        url: text("url"),
                        title: text("title"),
                        subtype,
                    },
                );
            }
        }
    }
}

fn host_of(address: &str) -> Option<String> {
    let url = url::Url::parse(address).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    url.host_str().map(str::to_string)
}

/// Follow Chrome's tabs on `client`, handing every changed list to
/// `publish`. Returns only if Chrome will not say what it has open; the
/// caller stops it when the connection ends.
pub(super) async fn follow(client: &CdpClient, mut publish: impl FnMut(Vec<ChromeTab>)) {
    // Subscribed before asking: Chrome answers by describing every target it
    // already has, and those must not be missed.
    let mut events = client.events();
    if let Err(err) = client.call("Target.setDiscoverTargets", json!({ "discover": true }), None).await {
        tracing::warn!("[chrome] could not follow Chrome's tabs: {err}");
        return;
    }
    let mut list = TabList::default();
    loop {
        match events.recv().await {
            Ok(event) => {
                if event.session.is_none() && list.apply(&event.method, &event.params) {
                    publish(list.tabs());
                }
            }
            // Fell behind and missed some: which, is unknown, so ask for all.
            Err(RecvError::Lagged(_)) => {
                let Ok(all) = client.call("Target.getTargets", json!({}), None).await else {
                    return;
                };
                list.reset(&all["targetInfos"]);
                publish(list.tabs());
            }
            Err(RecvError::Closed) => return,
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::sync::mpsc;

    use super::super::cdp::testing::chrome;
    use super::*;

    fn info(target: &str, url: &str, title: &str) -> Value {
        json!({ "targetId": target, "type": "page", "url": url, "title": title, "attached": false })
    }

    fn created(info: Value) -> (&'static str, Value) {
        ("Target.targetCreated", json!({ "targetInfo": info }))
    }

    fn changed(info: Value) -> (&'static str, Value) {
        ("Target.targetInfoChanged", json!({ "targetInfo": info }))
    }

    fn titles(list: &TabList) -> Vec<(String, String)> {
        list.tabs().into_iter().map(|tab| (tab.title, tab.host)).collect()
    }

    fn pair(title: &str, host: &str) -> (String, String) {
        (title.to_string(), host.to_string())
    }

    #[test]
    fn lists_web_pages_in_the_order_they_were_opened() {
        let mut list = TabList::default();
        for (method, params) in [
            created(info("B", "https://mail.example.com/inbox?token=secret", "Inbox")),
            created(info("A", "http://localhost:3000/", "Dev server")),
        ] {
            assert!(list.apply(method, &params));
        }
        assert_eq!(
            titles(&list),
            vec![pair("Inbox", "mail.example.com"), pair("Dev server", "localhost")]
        );
        // Nothing past the host leaves the list.
        let wire = serde_json::to_string(&list.tabs()).unwrap();
        assert!(!wire.contains("token") && !wire.contains("inbox?"));
        assert!(!wire.contains("\"B\""), "Chrome's target id stays in the backend");
    }

    #[test]
    fn leaves_out_what_is_not_a_web_page_tab() {
        let mut list = TabList::default();
        for (method, params) in [
            created(info("newtab", "chrome://newtab/", "New Tab")),
            created(info("ext", "chrome-extension://abc/popup.html", "Popup")),
            created(info("tools", "devtools://devtools/bundled/inspector.html", "DevTools")),
            created(json!({ "targetId": "sw", "type": "service_worker", "url": "https://a.example/sw.js", "title": "" })),
            created(json!({ "targetId": "frame", "type": "iframe", "url": "https://ads.example/", "title": "" })),
            created(json!({ "targetId": "pre", "type": "page", "subtype": "prerender", "url": "https://next.example/", "title": "Next" })),
        ] {
            assert!(!list.apply(method, &params), "{params}");
        }
        assert!(list.tabs().is_empty());

        // The new-tab page becomes a web page once something is typed in it,
        // and a page loaded ahead becomes a tab once it is shown.
        let (method, params) = changed(info("newtab", "https://example.com/", "Example"));
        assert!(list.apply(method, &params));
        let (method, params) = changed(info("pre", "https://next.example/", "Next"));
        assert!(list.apply(method, &params));
        assert_eq!(titles(&list), vec![pair("Example", "example.com"), pair("Next", "next.example")]);
    }

    #[test]
    fn a_tab_keeps_its_name_and_place_as_it_changes() {
        let mut list = TabList::default();
        for (method, params) in [
            created(info("A", "https://a.example/", "A")),
            created(info("B", "https://b.example/", "B")),
        ] {
            list.apply(method, &params);
        }
        let before = list.tabs();
        let (method, params) = changed(info("A", "https://c.example/page", "C"));
        assert!(list.apply(method, &params));
        let after = list.tabs();
        assert_eq!(after[0].id, before[0].id);
        assert_eq!(titles(&list), vec![pair("C", "c.example"), pair("B", "b.example")]);

        // Chrome repeating itself is not a change.
        assert!(!list.apply(method, &params));
        // Neither is an event about something else.
        assert!(!list.apply("Target.attachedToTarget", &json!({})));
    }

    #[test]
    fn a_closed_tab_leaves_the_list() {
        let mut list = TabList::default();
        let (method, params) = created(info("A", "https://a.example/", "A"));
        list.apply(method, &params);
        assert!(list.apply("Target.targetDestroyed", &json!({ "targetId": "A" })));
        assert!(list.tabs().is_empty());
        assert!(!list.apply("Target.targetDestroyed", &json!({ "targetId": "A" })));
    }

    #[test]
    fn starting_over_keeps_the_tabs_still_open() {
        let mut list = TabList::default();
        for (method, params) in [
            created(info("A", "https://a.example/", "A")),
            created(info("B", "https://b.example/", "B")),
        ] {
            list.apply(method, &params);
        }
        let kept = list.tabs()[1].id.clone();
        list.reset(&json!([info("B", "https://b.example/", "B2"), info("C", "https://c.example/", "C")]));
        let tabs = list.tabs();
        assert_eq!(titles(&list), vec![pair("B2", "b.example"), pair("C", "c.example")]);
        assert_eq!(tabs[0].id, kept);
    }

    async fn next(heard: &mut mpsc::UnboundedReceiver<Vec<ChromeTab>>) -> Vec<ChromeTab> {
        tokio::time::timeout(Duration::from_secs(10), heard.recv())
            .await
            .expect("no list came")
            .unwrap()
    }

    #[tokio::test]
    async fn follows_what_chrome_says_about_its_tabs() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let (lists, mut heard) = mpsc::unbounded_channel();
        let following = {
            let client = client.clone();
            tokio::spawn(async move { follow(&client, |tabs| lists.send(tabs).unwrap()).await })
        };

        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.setDiscoverTargets");
        assert_eq!(call["params"], json!({ "discover": true }));
        // Chrome describes what it has before it answers.
        chrome
            .say(json!({ "method": "Target.targetCreated", "params": { "targetInfo": info("A", "https://a.example/", "A") } }))
            .await;
        chrome.answer(&call, json!({})).await;
        let tabs = next(&mut heard).await;
        assert_eq!(tabs.len(), 1);
        assert_eq!(tabs[0].host, "a.example");

        // A tab's own session talking is not about the list.
        chrome
            .say(json!({ "method": "Target.targetInfoChanged", "sessionId": "S", "params": { "targetInfo": info("A", "https://x.example/", "X") } }))
            .await;
        chrome
            .say(json!({ "method": "Target.targetDestroyed", "params": { "targetId": "A" } }))
            .await;
        assert!(next(&mut heard).await.is_empty());

        client.close();
        drop(chrome);
        following.abort();
    }

    #[tokio::test]
    async fn a_chrome_that_will_not_say_leaves_the_list_empty() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let following = {
            let client = client.clone();
            tokio::spawn(async move { follow(&client, |_| panic!("nothing to publish")).await })
        };
        let call = chrome.next_call().await;
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32601, "message": "not allowed" } }))
            .await;
        tokio::time::timeout(Duration::from_secs(10), following)
            .await
            .expect("it gave up")
            .unwrap();
    }
}
