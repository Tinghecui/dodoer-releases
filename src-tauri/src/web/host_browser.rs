//! Cowork fork: the browser tools of a codeg-server with no desktop app of
//! its own (`docs/remote-browser.md`, `docs/devices.md` 5.2).
//!
//! Each call goes to one window of a desktop app registered on this server
//! (`web::host_registry`), and the agent says which: a tab id carries the
//! device it is on (`laptop:3f2a…`), and a new tab is opened on the `device`
//! the agent names — or, when only one device lends its tabs, on that one.
//! Nothing is sent to a device by who was active last.
//!
//! The windows know their tabs by their own ids; the agent is told them with
//! the device's name in front, in every `tabId` of an answer and in its
//! notes, and the server remembers which window told of each tab, so that a
//! call on it goes back there.
//!
//! A call goes only to a device its conversation has been given
//! (`web::working_device`, `docs/devices.md` 6.5): a new tab without a
//! `device` opens on the conversation's working device, a device it has not
//! been given is asked for on the person's card first, and the list shows
//! the tabs of the devices it has. Where the call's conversation is not known
//! — no caller, or no device tools here — it goes as it did before.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::host_devices::{ago, now_ms};
use super::host_registry::{BrowserHost, BrowserRouteError, HostCallError, HostRegistry, NO_DESKTOP_NOTE};
use super::working_device;
use crate::acp::browser_tools::{
    BrowserActOutcome, BrowserCaptureOutcome, BrowserConsoleOutcome, BrowserEvalOutcome,
    BrowserSnapshotOutcome, BrowserTabOp, BrowserTabOutcome, BrowserTabsOutcome, BrowserToolAccess,
    ERROR_UNAVAILABLE,
};
use crate::browser::agent::ActionRequest;
use crate::browser::capture::CaptureRequest;
use crate::browser::console::ConsoleQuery;
use crate::browser::eval::EvalRequest;
use crate::host_bridge::{BridgeCall, BrowserCall};

/// How long a call may take. `tab_op` waits on a page load.
const CALL_TIMEOUT: Duration = Duration::from_secs(60);

/// `browser_eval` waits on the person: the app's own prompt gives up after
/// 120 s (`browser::confirm`), so this outlasts it and the app's answer —
/// "declined" — is what the agent gets.
const EVAL_TIMEOUT: Duration = Duration::from_secs(150);

/// How long a window has to list its tabs: the list waits on the slowest.
const LIST_TIMEOUT: Duration = Duration::from_secs(15);

/// A tab id shorter than this is not looked for in a note's words: it could
/// be part of another word.
const NOTE_ID_MIN: usize = 6;

/// The browser tools, through the desktop apps registered on this server.
pub struct RemoteHostBrowser {
    hosts: Arc<HostRegistry>,
}

impl RemoteHostBrowser {
    pub fn new(hosts: Arc<HostRegistry>) -> Self {
        Self { hosts }
    }

    /// What window `host` answered `call`; or, when it gave none, the note
    /// the caller answers with.
    async fn ask_host(
        &self,
        host: &BrowserHost,
        call: BrowserCall,
        timeout: Duration,
    ) -> Result<Value, String> {
        // The conversation shows it uses this device's browser while the
        // call is out (`web::session_usage`).
        let _usage = super::session_usage::track_browser(
            device_name(host),
            Some(self.hosts.host_lends_chrome(host.host)),
        )
        .await;
        match self
            .hosts
            .call_host(host.host, BridgeCall::Browser(call), timeout)
            .await
        {
            Ok(outcome) => Ok(outcome),
            Err(HostCallError::TimedOut) => Err(format!(
                "{} did not answer within {} s. It may have lost its network, or the computer \
                 is asleep.",
                device_or_app(host),
                timeout.as_secs()
            )),
            Err(e) => {
                tracing::warn!("[host-browser] browser call failed: {e:?}");
                Err(format!(
                    "{} went away before it answered. Ask the user to open this workspace in \
                     the dodoer desktop app there, then try again.",
                    device_or_app(host)
                ))
            }
        }
    }

    /// `outcome` as the agent is to see it: its tab ids with the device's
    /// name in front, and those tabs remembered as `host`'s.
    fn localize<T: DeserializeOwned>(&self, host: &BrowserHost, mut outcome: Value) -> Result<T, String> {
        let mut told = Vec::new();
        prefix_tab_ids(&mut outcome, &host.prefix, &mut told);
        self.hosts.remember_tabs(host.host, told);
        serde_json::from_value(outcome).map_err(|e| {
            tracing::warn!("[host-browser] a host answered something unreadable: {e}");
            NO_DESKTOP_NOTE.to_string()
        })
    }

    /// A call on the tab the agent calls `tab_id`: sent to the window it is
    /// in, under the id that window knows it by.
    async fn on_tab<T: DeserializeOwned>(
        &self,
        tab_id: &str,
        call: impl FnOnce(String) -> BrowserCall,
        timeout: Duration,
    ) -> Result<T, String> {
        let (host, own) = self.hosts.route_tab(tab_id).map_err(|e| route_note(&e))?;
        if let Some(name) = host
            .prefix
            .strip_suffix(':')
            .filter(|name| !name.is_empty())
        {
            if let Some(chosen) = device_for(Some(name)).await? {
                if chosen != name {
                    return Err(format!(
                        "Tab {tab_id} is on `{name}`, and the user chose `{chosen}` for this \
                         conversation instead. Use a tab on `{chosen}`, or ask the user before \
                         using `{name}`."
                    ));
                }
            }
        }
        let outcome = self.ask_host(&host, call(own), timeout).await?;
        self.localize(&host, outcome)
    }
}

/// The device a call of the running agent goes to, for its conversation:
/// `name`, else its working device, one it has been given — asking the
/// person if need be. As given where nothing is to be checked.
async fn device_for(name: Option<&str>) -> Result<Option<String>, String> {
    match (working_device::caller(), working_device::installed()) {
        (Some(caller), Some(tools)) => tools.resolve(&caller, name).await,
        _ => Ok(name.map(str::to_string)),
    }
}

/// The name of the device `host` is on; none for an app from before devices.
fn device_name(host: &BrowserHost) -> Option<String> {
    host.prefix
        .strip_suffix(':')
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

/// "`laptop`", or what an app from before devices is.
fn device_or_app(host: &BrowserHost) -> String {
    match host.prefix.strip_suffix(':') {
        Some(name) if !name.is_empty() => format!("`{name}`"),
        _ => "The desktop app".to_string(),
    }
}

/// What the agent is told when a call has nowhere to go. Never "another
/// device instead".
fn route_note(error: &BrowserRouteError) -> String {
    match error {
        BrowserRouteError::NoHost => NO_DESKTOP_NOTE.to_string(),
        BrowserRouteError::UnknownDevice { name, names } => {
            if names.is_empty() {
                format!("There is no device called `{name}`: none has connected to this server.")
            } else {
                format!(
                    "There is no device called `{name}`. The user's devices: {}.",
                    names.join(", ")
                )
            }
        }
        BrowserRouteError::Offline { name, last_seen } => format!(
            "`{name}` is offline (last online {}). Ask the user to open this workspace in the \
             dodoer desktop app on that computer, then try again. Do not use another device \
             instead unless the user says so.",
            ago(*last_seen, now_ms())
        ),
        BrowserRouteError::NotLent { name } => format!(
            "`{name}` is online but does not lend its browser. Ask the user to open this \
             workspace in a remote window of the dodoer desktop app on that computer and to let \
             agents use its browser, then try again. Do not use another device instead unless \
             the user says so."
        ),
        BrowserRouteError::Stopped { name } => super::host_devices::stopped_note(name),
        BrowserRouteError::ChooseDevice { names } => format!(
            "Several of the user's devices lend their browser ({}). Pass `device` with the one \
             the user means; ask them if you do not know.",
            names.join(", ")
        ),
        BrowserRouteError::UnknownTab => "That tab id does not say which device it is on. Call \
             browser_list_tabs and use a tab id from there (they start with the device's name, \
             like `laptop:`)."
            .to_string(),
    }
}

/// Put `prefix` in front of every `tabId` in `value` and of the same ids in
/// its notes; the ids as the window gave them go into `told`.
fn prefix_tab_ids(value: &mut Value, prefix: &str, told: &mut Vec<String>) {
    collect_and_prefix(value, prefix, told);
    if !prefix.is_empty() {
        let long: Vec<String> = told
            .iter()
            .filter(|id| id.len() >= NOTE_ID_MIN)
            .cloned()
            .collect();
        if !long.is_empty() {
            prefix_in_notes(value, prefix, &long);
        }
    }
}

fn collect_and_prefix(value: &mut Value, prefix: &str, told: &mut Vec<String>) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                match item {
                    Value::String(id) if key == "tabId" => {
                        if id.contains(':') {
                            continue;
                        }
                        let own = id.clone();
                        if !prefix.is_empty() {
                            *id = format!("{prefix}{own}");
                        }
                        if !told.contains(&own) {
                            told.push(own);
                        }
                    }
                    other => collect_and_prefix(other, prefix, told),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_and_prefix(item, prefix, told);
            }
        }
        _ => {}
    }
}

fn prefix_in_notes(value: &mut Value, prefix: &str, ids: &[String]) {
    match value {
        Value::Object(map) => {
            for (key, item) in map.iter_mut() {
                match item {
                    Value::String(text) if key == "note" => {
                        for id in ids {
                            if text.contains(id.as_str()) {
                                *text = text.replace(id.as_str(), &format!("{prefix}{id}"));
                            }
                        }
                    }
                    other => prefix_in_notes(other, prefix, ids),
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                prefix_in_notes(item, prefix, ids);
            }
        }
        _ => {}
    }
}

#[async_trait]
impl BrowserToolAccess for RemoteHostBrowser {
    /// Every tab of every window lending its tabs, each with its device's
    /// name; what a window could not say, in the note.
    async fn list_tabs(&self) -> BrowserTabsOutcome {
        let mut hosts = self.hosts.browser_hosts();
        if hosts.is_empty() {
            return BrowserTabsOutcome::unavailable(NO_DESKTOP_NOTE);
        }
        if let (Some(caller), Some(tools)) = (working_device::caller(), working_device::installed())
        {
            if let Some(names) = tools.confirmed_names(&caller).await {
                hosts.retain(|host| match host.prefix.strip_suffix(':') {
                    Some(name) => names.iter().any(|n| n == name),
                    None => true,
                });
                if hosts.is_empty() {
                    return BrowserTabsOutcome::unavailable(&if names.is_empty() {
                        "This conversation has not been given any of the user's devices yet: \
                         call use_device first, then list the tabs again."
                            .to_string()
                    } else {
                        format!(
                            "None of the devices this conversation uses ({}) lends its browser \
                             now. Ask the user to let agents use the browser in the dodoer \
                             desktop app there; do not use another device instead.",
                            names.join(", ")
                        )
                    });
                }
            }
        }
        let answers = futures_util::future::join_all(
            hosts
                .iter()
                .map(|host| self.ask_host(host, BrowserCall::ListTabs, LIST_TIMEOUT)),
        )
        .await;
        let several = hosts.len() > 1;
        let mut tabs = Vec::new();
        let mut notes = Vec::new();
        for (host, answer) in hosts.iter().zip(answers) {
            let listed = answer.and_then(|outcome| self.localize::<BrowserTabsOutcome>(host, outcome));
            let note = match listed {
                Ok(outcome) => {
                    tabs.extend(outcome.tabs);
                    outcome.note
                }
                Err(note) => Some(note),
            };
            if let Some(note) = note {
                notes.push(if several && !host.prefix.is_empty() {
                    format!("{} {note}", host.prefix)
                } else {
                    note
                });
            }
        }
        BrowserTabsOutcome {
            tabs,
            note: (!notes.is_empty()).then(|| notes.join("\n")),
        }
    }

    async fn snapshot(&self, tab_id: &str, max_chars: Option<usize>) -> BrowserSnapshotOutcome {
        self.on_tab(
            tab_id,
            |tab_id| BrowserCall::Snapshot { tab_id, max_chars },
            CALL_TIMEOUT,
        )
        .await
        .unwrap_or_else(|note| BrowserSnapshotOutcome::refused(tab_id, ERROR_UNAVAILABLE, note))
    }

    async fn act(&self, tab_id: &str, request: ActionRequest) -> BrowserActOutcome {
        self.on_tab(
            tab_id,
            |tab_id| BrowserCall::Act { tab_id, request },
            CALL_TIMEOUT,
        )
        .await
        .unwrap_or_else(|note| BrowserActOutcome::refused(tab_id, ERROR_UNAVAILABLE, note))
    }

    async fn console(&self, tab_id: &str, query: ConsoleQuery) -> BrowserConsoleOutcome {
        self.on_tab(
            tab_id,
            |tab_id| BrowserCall::Console { tab_id, query },
            CALL_TIMEOUT,
        )
        .await
        .unwrap_or_else(|note| BrowserConsoleOutcome::refused(tab_id, ERROR_UNAVAILABLE, note))
    }

    async fn capture(&self, tab_id: &str, request: CaptureRequest) -> BrowserCaptureOutcome {
        self.on_tab(
            tab_id,
            |tab_id| BrowserCall::Capture { tab_id, request },
            CALL_TIMEOUT,
        )
        .await
        .unwrap_or_else(|note| BrowserCaptureOutcome::refused(tab_id, ERROR_UNAVAILABLE, note))
    }

    async fn eval(&self, tab_id: &str, request: EvalRequest) -> BrowserEvalOutcome {
        self.on_tab(
            tab_id,
            |tab_id| BrowserCall::Eval { tab_id, request },
            EVAL_TIMEOUT,
        )
        .await
        .unwrap_or_else(|note| BrowserEvalOutcome::refused(tab_id, ERROR_UNAVAILABLE, note))
    }

    async fn tab_op(&self, op: BrowserTabOp) -> BrowserTabOutcome {
        match op {
            BrowserTabOp::Open {
                url,
                device,
                new_tab,
            } => {
                let asked = device;
                let device = match device_for(asked.as_deref()).await {
                    Ok(device) => device,
                    Err(note) => return BrowserTabOutcome::refused(None, ERROR_UNAVAILABLE, note),
                };
                let host = match self.hosts.route_open(device.as_deref()) {
                    Ok(host) => host,
                    Err(e) => {
                        return BrowserTabOutcome::refused(None, ERROR_UNAVAILABLE, route_note(&e))
                    }
                };
                // The device is the server's business: the window opens it
                // on itself.
                let call = BrowserCall::TabOp {
                    op: BrowserTabOp::Open {
                        url,
                        device: None,
                        new_tab,
                    },
                };
                let answer = match self.ask_host(&host, call, CALL_TIMEOUT).await {
                    Ok(outcome) => self.localize::<BrowserTabOutcome>(&host, outcome),
                    Err(note) => Err(note),
                };
                let mut answer = answer.unwrap_or_else(|note| {
                    BrowserTabOutcome::refused(None, ERROR_UNAVAILABLE, note)
                });
                // The person picked another device than the agent named.
                if let (Some(asked), Some(used)) = (asked.as_deref(), device.as_deref()) {
                    if !asked.trim().eq_ignore_ascii_case(used) {
                        let chosen = format!(
                            "Opened on `{used}`: the user chose it for this conversation, not \
                             `{}`.",
                            asked.trim()
                        );
                        answer.note = Some(match answer.note.take() {
                            Some(note) => format!("{chosen} {note}"),
                            None => chosen,
                        });
                    }
                }
                answer
            }
            BrowserTabOp::Navigate { tab_id, url } => self
                .on_tab(
                    &tab_id,
                    |own| BrowserCall::TabOp {
                        op: BrowserTabOp::Navigate { tab_id: own, url },
                    },
                    CALL_TIMEOUT,
                )
                .await
                .unwrap_or_else(|note| {
                    BrowserTabOutcome::refused(Some(tab_id.as_str()), ERROR_UNAVAILABLE, note)
                }),
            BrowserTabOp::Close { tab_id } => self
                .on_tab(
                    &tab_id,
                    |own| BrowserCall::TabOp {
                        op: BrowserTabOp::Close { tab_id: own },
                    },
                    CALL_TIMEOUT,
                )
                .await
                .unwrap_or_else(|note| {
                    BrowserTabOutcome::refused(Some(tab_id.as_str()), ERROR_UNAVAILABLE, note)
                }),
            // Cowork fork: the answer to a page's dialog, to the device whose
            // Chrome has it open (`docs/agent-chrome.md` 13.2).
            BrowserTabOp::Dialog {
                tab_id,
                accept,
                prompt_text,
            } => self
                .on_tab(
                    &tab_id,
                    |own| BrowserCall::TabOp {
                        op: BrowserTabOp::Dialog {
                            tab_id: own,
                            accept,
                            prompt_text,
                        },
                    },
                    CALL_TIMEOUT,
                )
                .await
                .unwrap_or_else(|note| {
                    BrowserTabOutcome::refused(Some(tab_id.as_str()), ERROR_UNAVAILABLE, note)
                }),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::sync::mpsc;

    use crate::acp::browser_tools::NoBrowserTabs;
    use crate::host_device::HostDevice;
    use crate::web::host_registry::CAPABILITY_BROWSER;
    use crate::web::ws_attach::ServerMsg;

    fn device(id: &str, name: &str) -> HostDevice {
        HostDevice {
            id: format!("{id}-0123456789"),
            name: name.to_string(),
            model: String::new(),
            kind: None,
        }
    }

    /// A window lending its tabs that answers every call with
    /// `answer(call)`, on its own task; its id.
    fn answering(
        registry: &Arc<HostRegistry>,
        on: Option<HostDevice>,
        answer: impl Fn(&BridgeCall) -> Value + Send + 'static,
    ) -> u64 {
        let (tx, mut rx) = mpsc::channel(8);
        let reg = registry.register_on(
            tx,
            vec![CAPABILITY_BROWSER.to_string()],
            Some("remote-workspace-1".into()),
            None,
            on,
            None,
        );
        let id = reg.id();
        tokio::spawn(async move {
            while let Some(msg) = rx.recv().await {
                if let ServerMsg::HostCall { call_id, call } = msg {
                    reg.answer(call_id, answer(&call));
                }
            }
        });
        id
    }

    /// What a desktop answers: its tabs under its own ids, and a snapshot's
    /// refusal naming the tab it was asked about.
    fn desktop(tabs: &'static [&'static str]) -> impl Fn(&BridgeCall) -> Value + Send + 'static {
        move |call| match call {
            BridgeCall::Browser(BrowserCall::ListTabs) => json!({
                "tabs": tabs
                    .iter()
                    .map(|id| json!({"tabId": id, "origin": null, "level": "none"}))
                    .collect::<Vec<_>>()
            }),
            BridgeCall::Browser(BrowserCall::Snapshot { tab_id, .. }) => json!({
                "tabId": tab_id,
                "error": "browser_grant_required",
                "note": format!("Browser tab {tab_id} is not shared with you."),
            }),
            BridgeCall::Browser(BrowserCall::TabOp { op }) => {
                assert_eq!(
                    serde_json::to_value(op).unwrap().get("device"),
                    None,
                    "the device stays on the server"
                );
                json!({
                    "tabId": "opened-tab",
                    "tab": {"tabId": "opened-tab", "origin": "https://example.com", "level": "read"},
                })
            }
            other => panic!("not asked: {other:?}"),
        }
    }

    #[tokio::test]
    async fn with_no_host_the_tools_answer_as_no_browser_and_say_what_to_do() {
        let tools = RemoteHostBrowser::new(Arc::new(HostRegistry::new()));
        let tabs = tools.list_tabs().await;
        assert!(tabs.tabs.is_empty());
        assert_eq!(tabs.note.as_deref(), Some(NO_DESKTOP_NOTE));
        let refused = tools.snapshot("t1", None).await;
        let no_browser = NoBrowserTabs.snapshot("t1", None).await;
        assert_eq!(
            refused.error, no_browser.error,
            "the same slug as no browser"
        );
        assert_eq!(refused.note.as_deref(), Some(NO_DESKTOP_NOTE));
    }

    /// An app from before devices: its answer as it gave it, ids and all.
    #[tokio::test]
    async fn a_call_reaches_an_old_app_and_its_outcome_comes_back_as_is() {
        let registry = Arc::new(HostRegistry::new());
        answering(&registry, None, |call| {
            assert_eq!(
                serde_json::to_value(call).unwrap(),
                json!({"tool": "browser", "call": {"method": "list_tabs"}})
            );
            json!({"tabs": [{"tabId": "old-tab-1", "origin": null, "level": "none"}], "note": "from the host"})
        });
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));
        let listed = tools.list_tabs().await;
        assert_eq!(listed.note.as_deref(), Some("from the host"));
        assert_eq!(listed.tabs[0].tab_id, "old-tab-1");
    }

    /// Every device's tabs in one list, each with its device's name; a call
    /// on one goes to that device under the window's own id, and comes back
    /// named as the agent named it — notes too.
    #[tokio::test]
    async fn tab_ids_carry_their_device_and_calls_go_back_to_it() {
        let registry = Arc::new(HostRegistry::new());
        let imac = answering(
            &registry,
            Some(device("imac", "Study iMac")),
            desktop(&["imac-tab-1"]),
        );
        answering(
            &registry,
            Some(device("book", "MacBook")),
            desktop(&["book-tab-1"]),
        );
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));

        let listed = tools.list_tabs().await;
        let mut ids: Vec<&str> = listed.tabs.iter().map(|t| t.tab_id.as_str()).collect();
        ids.sort_unstable();
        assert_eq!(ids, ["macbook:book-tab-1", "study-imac:imac-tab-1"]);
        assert_eq!(listed.note, None);

        let refused = tools.snapshot("study-imac:imac-tab-1", None).await;
        assert_eq!(refused.tab_id, "study-imac:imac-tab-1");
        assert_eq!(
            refused.note.as_deref(),
            Some("Browser tab study-imac:imac-tab-1 is not shared with you.")
        );
        // A bare id from an older answer still finds its window.
        assert_eq!(
            registry.route_tab("imac-tab-1").unwrap().0.host,
            imac,
            "remembered from the list"
        );
        // A device that is not there: said so, nothing sent elsewhere.
        let nowhere = tools.snapshot("laptop:imac-tab-1", None).await;
        assert_eq!(nowhere.error.as_deref(), Some(ERROR_UNAVAILABLE));
        assert!(
            nowhere
                .note
                .as_deref()
                .unwrap()
                .contains("no device called `laptop`"),
            "{nowhere:?}"
        );
    }

    /// With several devices lending their tabs, a new tab names one; opened
    /// there, it comes back under that device's name.
    #[tokio::test]
    async fn a_new_tab_opens_on_the_device_it_names() {
        let registry = Arc::new(HostRegistry::new());
        answering(&registry, Some(device("imac", "Study iMac")), desktop(&[]));
        answering(&registry, Some(device("book", "MacBook")), desktop(&[]));
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));

        let unnamed = tools
            .tab_op(BrowserTabOp::Open {
                url: "https://example.com/".into(),
                device: None,
                new_tab: false,
            })
            .await;
        assert_eq!(unnamed.error.as_deref(), Some(ERROR_UNAVAILABLE));
        let why = unnamed.note.unwrap();
        assert!(why.contains("Pass `device`") && why.contains("study-imac"), "{why}");

        let opened = tools
            .tab_op(BrowserTabOp::Open {
                url: "https://example.com/".into(),
                device: Some("macbook".into()),
                new_tab: false,
            })
            .await;
        assert_eq!(opened.error, None, "{opened:?}");
        assert_eq!(opened.tab_id.as_deref(), Some("macbook:opened-tab"));
        assert_eq!(opened.tab.unwrap().tab_id, "macbook:opened-tab");
    }

    /// The answer to a page's dialog goes to the device the tab is on, under
    /// the window's own id, and comes back named as the agent named it.
    #[tokio::test]
    async fn a_dialog_answer_goes_to_the_tabs_device() {
        let registry = Arc::new(HostRegistry::new());
        answering(
            &registry,
            Some(device("book", "MacBook")),
            |call| match call {
                BridgeCall::Browser(BrowserCall::ListTabs) => json!({
                    "tabs": [{"tabId": "book-tab-1", "origin": null, "level": "control"}]
                }),
                BridgeCall::Browser(BrowserCall::TabOp { op }) => {
                    assert_eq!(
                        serde_json::to_value(op).unwrap(),
                        json!({"op": "dialog", "tab_id": "book-tab-1", "accept": true, "prompt_text": "Robin"})
                    );
                    json!({
                        "tabId": "book-tab-1",
                        "note": "Answered the prompt dialog on browser tab book-tab-1: OK.",
                    })
                }
                other => panic!("not asked: {other:?}"),
            },
        );
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));
        tools.list_tabs().await;
        let answered = tools
            .tab_op(BrowserTabOp::Dialog {
                tab_id: "macbook:book-tab-1".into(),
                accept: true,
                prompt_text: Some("Robin".into()),
            })
            .await;
        assert_eq!(answered.error, None, "{answered:?}");
        assert_eq!(answered.tab_id.as_deref(), Some("macbook:book-tab-1"));
        assert_eq!(
            answered.note.as_deref(),
            Some("Answered the prompt dialog on browser tab macbook:book-tab-1: OK.")
        );
    }

    /// A device the book has, with no app connected: when it was last
    /// online, and not another device instead.
    #[tokio::test]
    async fn an_offline_device_says_since_when() {
        let registry = Arc::new(HostRegistry::new());
        answering(&registry, Some(device("imac", "Study iMac")), desktop(&[]));
        let (tx, _rx) = mpsc::channel(8);
        let book = registry.register_on(
            tx,
            Vec::new(),
            None,
            None,
            Some(device("book", "MacBook")),
            None,
        );
        drop(book);
        let tools = RemoteHostBrowser::new(Arc::clone(&registry));
        let refused = tools
            .tab_op(BrowserTabOp::Open {
                url: "https://example.com/".into(),
                device: Some("macbook".into()),
                new_tab: false,
            })
            .await;
        let why = refused.note.unwrap();
        assert!(why.contains("`macbook` is offline (last online just now)"), "{why}");
        assert!(why.contains("Do not use another device"));
    }

    #[test]
    fn ids_get_the_prefix_in_fields_and_notes_alike() {
        let mut answer = json!({
            "tabId": "abcdef-1",
            "tab": {"tabId": "abcdef-1", "level": "read"},
            "note": "Call browser_snapshot on tab abcdef-1 again.",
            "others": [{"tabId": "t2", "note": "t2 stays as it is in words"}],
            "named": {"tabId": "laptop:abcdef-3"},
        });
        let mut told = Vec::new();
        prefix_tab_ids(&mut answer, "imac:", &mut told);
        told.sort_unstable();
        assert_eq!(told, ["abcdef-1", "t2"], "each once, as the window gave them");
        assert_eq!(answer["tabId"], "imac:abcdef-1");
        assert_eq!(answer["tab"]["tabId"], "imac:abcdef-1");
        assert_eq!(answer["note"], "Call browser_snapshot on tab imac:abcdef-1 again.");
        assert_eq!(answer["others"][0]["tabId"], "imac:t2");
        assert_eq!(answer["others"][0]["note"], "t2 stays as it is in words", "too short to look for");
        assert_eq!(answer["named"]["tabId"], "laptop:abcdef-3", "named already");

        // An app from before devices: told of, not renamed.
        let mut old = json!({"tabId": "abcdef-1"});
        let mut told = Vec::new();
        prefix_tab_ids(&mut old, "", &mut told);
        assert_eq!(old["tabId"], "abcdef-1");
        assert_eq!(told, ["abcdef-1"]);
    }
}
