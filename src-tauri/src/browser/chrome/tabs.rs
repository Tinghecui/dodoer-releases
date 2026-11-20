//! Which tabs the connected Chrome has open, for the person to see.
//!
//! Chrome is only asked to say when tabs come, go and change
//! (`Target.setDiscoverTargets`). No tab is attached to and nothing runs in
//! any page: a page cannot tell it is being listed.
//!
//! The list is the person's alone. These tabs are not in the browser
//! registry (`browser::registry`), so no agent tool can name one, let alone
//! read it; a tab gets there only once the person hands it over, or when an
//! agent opened it (`browser::chrome_share`).
//!
//! What leaves this module is the least the panel needs — a title and a host
//! name. Paths and queries stay here: they are where sign-in links and
//! tokens live.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::broadcast::error::RecvError;
use tokio::time::Instant;

use super::cdp::CdpClient;
use crate::browser::agent::GrantLevel;

/// The app's name for the tab that is Chrome's target `target`: the same
/// every time it is asked, so that the list and whoever opened the tab agree
/// on it without asking each other, and a tab keeps its name when the list
/// starts over. Derived one way: the name does not give the target id away.
pub fn tab_id(target: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("codeg-chrome-tab:{target}").as_bytes());
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    uuid::Uuid::from_bytes(bytes).to_string()
}

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
    /// What agents may do there, from the browser registry
    /// (`chrome_share::panel_tabs`): a window that never heard the tab's
    /// state shows it from here. `None` as Chrome lists it.
    pub level: GrantLevel,
    /// Whether an agent opened it (owner `chrome@<scope>`), from the same
    /// place.
    pub opened_by_agent: bool,
}

/// A listed tab with what the backend keeps of it: what attaching to it
/// takes, and the address the panel is not given.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Listed {
    pub tab: ChromeTab,
    /// Chrome's target id.
    pub target: String,
    pub url: String,
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
        self.listed().into_iter().map(|listed| listed.tab).collect()
    }

    /// [`Self::tabs`], each with its target and address.
    pub(super) fn listed(&self) -> Vec<Listed> {
        let mut listed: Vec<(&String, &Known, String)> = self
            .known
            .iter()
            .filter(|(_, known)| known.subtype.is_none())
            .filter_map(|(target, known)| host_of(&known.url).map(|host| (target, known, host)))
            .collect();
        listed.sort_by_key(|(_, known, _)| known.seen);
        listed
            .into_iter()
            .map(|(target, known, host)| Listed {
                tab: ChromeTab {
                    id: known.id.clone(),
                    title: known.title.clone(),
                    host,
                    level: GrantLevel::None,
                    opened_by_agent: false,
                },
                target: target.clone(),
                url: known.url.clone(),
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
                        id: tab_id(target),
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

/// 页面开了或换了地址之后，隔多久回头问一遍 Chrome 全部的标签
/// （`Target.getTargets`）：Chrome 不附加调试的标签在 <title> 设好时
/// 不一定再发 `targetInfoChanged`，不问的话列表一直停在地址样子的标题上。
/// 从事件那一刻算起；慢的页面靠后几次。不管问到的标题像不像地址都照问：
/// 有的页面先显示「Loading」这类临时标题，过几秒才设好真正的。
const RECHECKS: [Duration; 4] = [
    Duration::from_millis(1500),
    Duration::from_secs(5),
    Duration::from_secs(15),
    Duration::from_secs(30),
];

/// `RECHECKS` 问完以后，连着 Chrome 就一直每隔这么久再问一遍：临时标题
/// 停多久、什么时候才换成真正的标题，从列表上看不出来，Chrome 又不一定
/// 发事件；`Target.getTargets` 不附加调试，页面察觉不到，问得也很轻。
const LATE_RECHECK: Duration = Duration::from_secs(10);

/// Follow Chrome's tabs on `client`, handing every changed list to
/// `publish`. Returns only if Chrome will not say what it has open; the
/// caller stops it when the connection ends.
pub(super) async fn follow(client: &CdpClient, mut publish: impl FnMut(Vec<Listed>)) {
    // Subscribed before asking: Chrome answers by describing every target it
    // already has, and those must not be missed.
    let mut events = client.events();
    if let Err(err) = client.call("Target.setDiscoverTargets", json!({ "discover": true }), None).await {
        tracing::warn!("[chrome] could not follow Chrome's tabs: {err}");
        return;
    }
    let mut list = TabList::default();
    // 下一次回头问 Chrome 的时间，和这是第几次（`RECHECKS` 的下标）。
    let mut recheck: Option<(Instant, usize)> = None;
    loop {
        let due_at = recheck.map(|(at, _)| at);
        let due = async move {
            match due_at {
                Some(at) => tokio::time::sleep_until(at).await,
                None => std::future::pending().await,
            }
        };
        let received = tokio::select! {
            received = events.recv() => received,
            () = due => {
                let Some((_, step)) = recheck.take() else { continue };
                // 固定的几次（`RECHECKS`）照排，过了就每 `LATE_RECHECK` 问一次。
                recheck = Some(match (RECHECKS.get(step), RECHECKS.get(step + 1)) {
                    (Some(now), Some(next)) => (Instant::now() + (*next - *now), step + 1),
                    _ => (Instant::now() + LATE_RECHECK, RECHECKS.len()),
                });
                // 问不到（连接断了）就等下一次，断开由 Closed 收尾。
                if let Ok(all) = client.call("Target.getTargets", json!({}), None).await {
                    let before = list.listed();
                    list.reset(&all["targetInfos"]);
                    let after = list.listed();
                    if after != before {
                        publish(after);
                    }
                }
                continue;
            }
        };
        match received {
            Ok(event) => {
                if event.session.is_none() && list.apply(&event.method, &event.params) {
                    publish(list.listed());
                }
                // 页面开了或换了地址：标题多半还没设好，过一会儿再问。
                // 第一次已经排着的就不再往后推，连着来的事件合成一次。
                if event.session.is_none()
                    && matches!(
                        event.method.as_str(),
                        "Target.targetCreated" | "Target.targetInfoChanged"
                    )
                    && event.params["targetInfo"]["type"].as_str() == Some("page")
                    && !matches!(recheck, Some((_, 0)))
                {
                    recheck = Some((Instant::now() + RECHECKS[0], 0));
                }
            }
            // Fell behind and missed some: which, is unknown, so ask for all.
            Err(RecvError::Lagged(_)) => {
                let Ok(all) = client.call("Target.getTargets", json!({}), None).await else {
                    return;
                };
                list.reset(&all["targetInfos"]);
                publish(list.listed());
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
    fn the_backend_keeps_the_target_and_address_of_each_tab() {
        let mut list = TabList::default();
        let (method, params) = created(info("T", "https://a.example/path?q=1", "A"));
        list.apply(method, &params);
        let listed = list.listed();
        assert_eq!(listed[0].target, "T");
        assert_eq!(listed[0].url, "https://a.example/path?q=1");
        assert_eq!(listed[0].tab, list.tabs()[0]);
    }

    /// Whoever opened a tab names it without asking the list, and the list
    /// calls it the same.
    #[test]
    fn a_tab_is_named_after_its_target_and_nothing_else() {
        let mut list = TabList::default();
        let (method, params) = created(info("T", "https://a.example/", "A"));
        list.apply(method, &params);
        assert_eq!(list.tabs()[0].id, tab_id("T"));
        assert_ne!(tab_id("T"), tab_id("U"));
        assert!(uuid::Uuid::parse_str(&tab_id("T")).is_ok());
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
        let (lists, mut heard) = mpsc::unbounded_channel::<Vec<ChromeTab>>();
        let following = {
            let client = client.clone();
            tokio::spawn(async move {
                follow(&client, |listed| {
                    lists.send(listed.into_iter().map(|listed| listed.tab).collect()).unwrap()
                })
                .await
            })
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

    /// 页面刚开始加载时 Chrome 报的标题就是地址，加载完设好 <title> 后
    /// 不一定再发事件：过一会儿要回头再问一遍。
    #[tokio::test]
    async fn asks_again_after_a_page_changes_to_pick_up_its_title() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let (lists, mut heard) = mpsc::unbounded_channel::<Vec<ChromeTab>>();
        let following = {
            let client = client.clone();
            tokio::spawn(async move {
                follow(&client, |listed| {
                    lists
                        .send(listed.into_iter().map(|listed| listed.tab).collect())
                        .unwrap()
                })
                .await
            })
        };

        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.setDiscoverTargets");
        chrome.answer(&call, json!({})).await;
        let loading = info(
            "A",
            "https://www.example.org/help/domains",
            "example.org/help/domains",
        );
        chrome
            .say(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": loading } }))
            .await;
        assert_eq!(next(&mut heard).await[0].title, "example.org/help/domains");

        // Chrome 不再说话；列表自己回头问。
        let call = tokio::time::timeout(Duration::from_secs(10), chrome.next_call())
            .await
            .expect("the list never asked again");
        assert_eq!(call["method"], "Target.getTargets");
        chrome
            .answer(
                &call,
                json!({ "targetInfos": [info("A", "https://www.example.org/help/domains", "Example Domains")] }),
            )
            .await;
        let tabs = next(&mut heard).await;
        assert_eq!(tabs[0].title, "Example Domains");
        assert_eq!(tabs[0].host, "www.example.org");

        client.close();
        drop(chrome);
        following.abort();
    }

    /// 标题在 5 秒以后才设好的慢页面：前两次回头问拿到的还是地址，
    /// 只要还有标签的标题像地址，就隔一阵接着问，直到拿到真正的标题。
    #[tokio::test]
    async fn keeps_asking_while_a_title_still_looks_like_its_address() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let (lists, mut heard) = mpsc::unbounded_channel::<Vec<ChromeTab>>();
        let following = {
            let client = client.clone();
            tokio::spawn(async move {
                follow(&client, |listed| {
                    lists
                        .send(listed.into_iter().map(|listed| listed.tab).collect())
                        .unwrap()
                })
                .await
            })
        };

        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.setDiscoverTargets");
        chrome.answer(&call, json!({})).await;
        let address = "https://www.example.org/slow";
        let loading = info("A", address, "example.org/slow");
        chrome
            .say(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": loading.clone() } }))
            .await;
        assert_eq!(next(&mut heard).await[0].title, "example.org/slow");

        // 1.5 秒、5 秒那两次：Chrome 报的还是地址。
        for _ in 0..2 {
            let call = tokio::time::timeout(Duration::from_secs(10), chrome.next_call())
                .await
                .expect("the list did not ask again");
            assert_eq!(call["method"], "Target.getTargets");
            chrome
                .answer(&call, json!({ "targetInfos": [loading.clone()] }))
                .await;
        }
        // 之后还要再问；这一次标题设好了。
        let call = tokio::time::timeout(Duration::from_secs(20), chrome.next_call())
            .await
            .expect("the list gave up while the title still looked like the address");
        assert_eq!(call["method"], "Target.getTargets");
        chrome
            .answer(
                &call,
                json!({ "targetInfos": [info("A", address, "Slow Page")] }),
            )
            .await;
        assert_eq!(next(&mut heard).await[0].title, "Slow Page");

        client.close();
        drop(chrome);
        following.abort();
    }

    /// 先显示一个临时标题（不像地址，比如「Loading」）、过了 5 秒才设好
    /// 真正标题的页面：Chrome 不再发事件时，5 秒以后也还要回头问。
    #[tokio::test]
    async fn keeps_asking_after_a_placeholder_title() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let (lists, mut heard) = mpsc::unbounded_channel::<Vec<ChromeTab>>();
        let following = {
            let client = client.clone();
            tokio::spawn(async move {
                follow(&client, |listed| {
                    lists
                        .send(listed.into_iter().map(|listed| listed.tab).collect())
                        .unwrap()
                })
                .await
            })
        };

        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.setDiscoverTargets");
        chrome.answer(&call, json!({})).await;
        let address = "https://www.example.org/late";
        chrome
            .say(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": info("A", address, "example.org/late") } }))
            .await;
        assert_eq!(next(&mut heard).await[0].title, "example.org/late");

        // 1.5 秒、5 秒那两次：页面只显示着临时标题。
        for _ in 0..2 {
            let call = tokio::time::timeout(Duration::from_secs(10), chrome.next_call())
                .await
                .expect("the list did not ask again");
            assert_eq!(call["method"], "Target.getTargets");
            chrome
                .answer(
                    &call,
                    json!({ "targetInfos": [info("A", address, "Loading")] }),
                )
                .await;
        }
        assert_eq!(next(&mut heard).await[0].title, "Loading");
        // 临时标题不像地址，也还要再问；这一次真正的标题设好了。
        let call = tokio::time::timeout(Duration::from_secs(20), chrome.next_call())
            .await
            .expect("the list gave up on a placeholder title");
        assert_eq!(call["method"], "Target.getTargets");
        chrome
            .answer(
                &call,
                json!({ "targetInfos": [info("A", address, "Late Page")] }),
            )
            .await;
        assert_eq!(next(&mut heard).await[0].title, "Late Page");

        client.close();
        drop(chrome);
        following.abort();
    }

    /// 临时标题停得比固定的几次（到 30 秒）还久、之后才换成真正标题，
    /// Chrome 又不发事件：固定几次问完以后也要每 10 秒接着问，列表不变也照问。
    #[tokio::test]
    async fn keeps_asking_after_the_fixed_rechecks() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&format!("ws://127.0.0.1:{port}/devtools/browser/test"))
            .await
            .unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let (lists, mut heard) = mpsc::unbounded_channel::<Vec<ChromeTab>>();
        let following = {
            let client = client.clone();
            tokio::spawn(async move {
                follow(&client, |listed| {
                    lists
                        .send(listed.into_iter().map(|listed| listed.tab).collect())
                        .unwrap()
                })
                .await
            })
        };

        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.setDiscoverTargets");
        chrome.answer(&call, json!({})).await;
        let address = "https://www.example.org/later";
        let placeholder = info("A", address, "Loading");
        chrome
            .say(json!({ "method": "Target.targetInfoChanged", "params": { "targetInfo": placeholder.clone() } }))
            .await;
        assert_eq!(next(&mut heard).await[0].title, "Loading");

        // 1.5、5、15、30 秒那四次，加上之后的第一次：都还是临时标题。
        for _ in 0..RECHECKS.len() + 1 {
            let call = tokio::time::timeout(Duration::from_secs(20), chrome.next_call())
                .await
                .expect("the list gave up on a title that never changed");
            assert_eq!(call["method"], "Target.getTargets");
            chrome
                .answer(&call, json!({ "targetInfos": [placeholder.clone()] }))
                .await;
        }
        // 再过 10 秒还问；这一次真正的标题设好了。
        let call = tokio::time::timeout(Duration::from_secs(20), chrome.next_call())
            .await
            .expect("the list stopped asking after the fixed rechecks");
        assert_eq!(call["method"], "Target.getTargets");
        chrome
            .answer(
                &call,
                json!({ "targetInfos": [info("A", address, "Later Page")] }),
            )
            .await;
        assert_eq!(next(&mut heard).await[0].title, "Later Page");

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
