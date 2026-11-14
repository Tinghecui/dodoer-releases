//! The app's one connection to the person's Chrome, and what state it is in.
//!
//! Made only when the person asks for it, never on its own: every connection
//! raises a dialog in Chrome, and a dialog nobody was expecting is one to
//! refuse. So there is no connecting at startup and no reconnecting when the
//! connection is lost — the state says so and waits to be asked again.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tokio::sync::watch;
use tokio_util::sync::CancellationToken;

use super::cdp::{CdpClient, ConnectError};
use super::endpoint::{self, Endpoint, EndpointError};
use super::tabs::{self, ChromeTab, Listed};

/// How long the person has to answer Chrome's dialog. They were sent there by
/// the button they just pressed, so this is generous rather than tight.
pub const ALLOW_WAIT: Duration = Duration::from_secs(120);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "kebab-case")]
pub enum ChromeState {
    #[default]
    Disconnected,
    /// Dialed; Chrome is asking the person whether to allow it.
    Waiting,
    Connected,
}

/// Why there is no connection, when the person did not end it themselves.
/// Each is a different thing for them to do, which is why they are apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ChromeProblem {
    /// Chrome has not written where it listens: the switch is off (or this
    /// Chrome is older than the switch).
    SwitchOff,
    /// The system kept the app from reading where Chrome listens.
    FileDenied,
    FileUnreadable,
    /// What was pasted is not an endpoint of a Chrome on this computer.
    BadEndpoint,
    /// Nothing answers there: Chrome is not running.
    NotRunning,
    /// Chrome answered and did not let the app in.
    Rejected,
    /// Nobody answered Chrome's dialog.
    TimedOut,
    /// There was a connection and Chrome ended it.
    Lost,
}

/// Mirrored by `ChromeStatus` in `src/lib/browser/chrome-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ChromeStatus {
    pub state: ChromeState,
    pub problem: Option<ChromeProblem>,
    /// The underlying error's own words, for a report; never shown as the
    /// explanation.
    pub detail: Option<String>,
    /// `Chrome/154.0.8037.98`, once connected.
    pub product: Option<String>,
    /// The file Chrome writes its endpoint to, as an address Chrome itself
    /// can open — the way round a system that keeps the app from reading it.
    pub port_file_url: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct Failure {
    problem: ChromeProblem,
    detail: Option<String>,
}

impl Failure {
    fn of(problem: ChromeProblem) -> Self {
        Self {
            problem,
            detail: None,
        }
    }
}

impl From<EndpointError> for Failure {
    fn from(err: EndpointError) -> Self {
        match err {
            EndpointError::Missing => Self::of(ChromeProblem::SwitchOff),
            EndpointError::Denied => Self::of(ChromeProblem::FileDenied),
            EndpointError::Malformed => Self::of(ChromeProblem::FileUnreadable),
            EndpointError::Unreadable(detail) => Self {
                problem: ChromeProblem::FileUnreadable,
                detail: Some(detail),
            },
        }
    }
}

/// What a change of state publishes.
#[derive(Default)]
struct Step {
    state: ChromeState,
    failure: Option<Failure>,
    product: Option<String>,
}

impl Step {
    fn failed(failure: Failure) -> Self {
        Self {
            failure: Some(failure),
            ..Self::default()
        }
    }
}

#[derive(Default)]
struct Slot {
    /// Counts connects and disconnects. Whatever finishes late — a dial the
    /// person cancelled, the watch on a connection since replaced — finds a
    /// different number here and leaves the state alone.
    generation: u64,
    attempt: Option<CancellationToken>,
    client: Option<CdpClient>,
}

struct Shared {
    port_file: Option<PathBuf>,
    port_file_url: Option<String>,
    allow_wait: Duration,
    slot: Mutex<Slot>,
    status: watch::Sender<ChromeStatus>,
    /// The connected Chrome's web pages; empty whenever it is not connected.
    tabs: watch::Sender<Vec<ChromeTab>>,
    /// The same tabs by id, with what attaching to one takes.
    listed: Mutex<HashMap<String, Listed>>,
}

/// Cheap to clone; every clone is the same link.
#[derive(Clone)]
pub struct ChromeLink {
    shared: Arc<Shared>,
}

impl ChromeLink {
    /// The link to the Chrome this computer's user installed for themselves.
    pub fn for_this_computer() -> Self {
        Self::new(endpoint::port_file(), ALLOW_WAIT)
    }

    pub fn new(port_file: Option<PathBuf>, allow_wait: Duration) -> Self {
        let port_file_url = port_file
            .as_deref()
            .and_then(|path| url::Url::from_file_path(path).ok())
            .map(|url| url.to_string());
        let (status, _) = watch::channel(ChromeStatus {
            port_file_url: port_file_url.clone(),
            ..ChromeStatus::default()
        });
        let (tabs, _) = watch::channel(Vec::new());
        Self {
            shared: Arc::new(Shared {
                port_file,
                port_file_url,
                allow_wait,
                slot: Mutex::new(Slot::default()),
                status,
                tabs,
                listed: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub fn status(&self) -> ChromeStatus {
        self.shared.status.borrow().clone()
    }

    /// Every later state, for whoever shows it.
    pub fn changes(&self) -> watch::Receiver<ChromeStatus> {
        self.shared.status.subscribe()
    }

    /// The connected Chrome's web pages, oldest first, for the person to see
    /// (`tabs`).
    pub fn tabs(&self) -> Vec<ChromeTab> {
        self.shared.tabs.borrow().clone()
    }

    /// Every later list of tabs.
    pub fn tab_changes(&self) -> watch::Receiver<Vec<ChromeTab>> {
        self.shared.tabs.subscribe()
    }

    /// The listed tab `id`, with its target and full address — what handing
    /// it to agents takes. Never sent to the frontend.
    pub fn listed(&self, id: &str) -> Option<Listed> {
        self.listed_tabs().get(id).cloned()
    }

    fn listed_tabs(&self) -> MutexGuard<'_, HashMap<String, Listed>> {
        self.shared.listed.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The connection, while there is one.
    pub fn client(&self) -> Option<CdpClient> {
        self.slot().client.clone().filter(|client| !client.is_closed())
    }

    /// Connect to Chrome — at the endpoint its file names, or at `pasted`
    /// when the person read the file themselves — and return where that
    /// ended. Asked again while connected or connecting, it changes nothing:
    /// a second dial would be a second dialog.
    pub async fn connect(&self, pasted: Option<&str>) -> ChromeStatus {
        let Some((generation, cancel)) = self.begin() else {
            return self.status();
        };
        let outcome = match self.endpoint(pasted) {
            Err(failure) => Err(failure),
            Ok(endpoint) => {
                self.settle(generation, |_| Step {
                    state: ChromeState::Waiting,
                    ..Step::default()
                });
                dial(&endpoint, &cancel, self.shared.allow_wait).await
            }
        };
        match outcome {
            Ok((client, product)) => {
                let held = client.clone();
                let connected = self.settle(generation, move |slot| {
                    slot.attempt = None;
                    slot.client = Some(held);
                    Step {
                        state: ChromeState::Connected,
                        product,
                        ..Step::default()
                    }
                });
                match connected {
                    Some(status) => {
                        self.watch(generation, client);
                        status
                    }
                    // The person disconnected while Chrome was answering.
                    None => {
                        client.close();
                        self.status()
                    }
                }
            }
            Err(failure) => self
                .settle(generation, |slot| {
                    slot.attempt = None;
                    Step::failed(failure)
                })
                .unwrap_or_else(|| self.status()),
        }
    }

    /// End the connection, or the attempt at one. The person's own doing, so
    /// the state it leaves names no problem.
    pub fn disconnect(&self) -> ChromeStatus {
        let mut slot = self.slot();
        slot.generation += 1;
        if let Some(attempt) = slot.attempt.take() {
            attempt.cancel();
        }
        if let Some(client) = slot.client.take() {
            client.close();
        }
        self.publish(Step::default())
    }

    fn slot(&self) -> MutexGuard<'_, Slot> {
        self.shared.slot.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn begin(&self) -> Option<(u64, CancellationToken)> {
        let mut slot = self.slot();
        // A connection Chrome has ended, whose watch has not yet said so.
        if slot.client.as_ref().is_some_and(CdpClient::is_closed) {
            slot.client = None;
        }
        if slot.attempt.is_some() || slot.client.is_some() {
            return None;
        }
        slot.generation += 1;
        let attempt = CancellationToken::new();
        slot.attempt = Some(attempt.clone());
        Some((slot.generation, attempt))
    }

    fn endpoint(&self, pasted: Option<&str>) -> Result<Endpoint, Failure> {
        if let Some(text) = pasted.map(str::trim).filter(|text| !text.is_empty()) {
            return endpoint::parse_pasted(text).map_err(|_| Failure::of(ChromeProblem::BadEndpoint));
        }
        match &self.shared.port_file {
            Some(path) => endpoint::read_port_file(path).map_err(Failure::from),
            None => Err(Failure::of(ChromeProblem::SwitchOff)),
        }
    }

    /// Apply `change` and publish what it says — unless the link has moved
    /// on since `generation`, in which case nothing happens and the answer
    /// is `None`.
    fn settle(&self, generation: u64, change: impl FnOnce(&mut Slot) -> Step) -> Option<ChromeStatus> {
        let mut slot = self.slot();
        if slot.generation != generation {
            return None;
        }
        let step = change(&mut slot);
        Some(self.publish(step))
    }

    /// Callers hold the slot, so states are published in the order they
    /// were decided.
    fn publish(&self, step: Step) -> ChromeStatus {
        let (problem, detail) = match step.failure {
            Some(failure) => (Some(failure.problem), failure.detail),
            None => (None, None),
        };
        let status = ChromeStatus {
            state: step.state,
            problem,
            detail,
            product: step.product,
            port_file_url: self.shared.port_file_url.clone(),
        };
        // Not connected, nothing open: a list kept past the connection would
        // show tabs that may since have closed. Emptied first, so whoever
        // hears "not connected" finds no tabs.
        if status.state != ChromeState::Connected {
            self.listed_tabs().clear();
            self.shared.tabs.send_if_modified(|tabs| {
                let had = !tabs.is_empty();
                tabs.clear();
                had
            });
        }
        self.shared.status.send_replace(status.clone());
        status
    }

    /// Publish `list` — unless the connection it came from has been replaced
    /// or has ended since.
    fn publish_tabs(&self, generation: u64, listed: Vec<Listed>) {
        let slot = self.slot();
        if slot.generation != generation || slot.client.is_none() {
            return;
        }
        let list: Vec<ChromeTab> = listed.iter().map(|listed| listed.tab.clone()).collect();
        *self.listed_tabs() = listed
            .into_iter()
            .map(|listed| (listed.tab.id.clone(), listed))
            .collect();
        self.shared.tabs.send_if_modified(|tabs| {
            let changed = *tabs != list;
            *tabs = list;
            changed
        });
    }

    /// Follow the connection's tabs for as long as it lasts, and say so when
    /// Chrome ends it.
    fn watch(&self, generation: u64, client: CdpClient) {
        let link = self.clone();
        tokio::spawn(async move {
            let following = tabs::follow(&client, |list| link.publish_tabs(generation, list));
            tokio::select! {
                _ = client.closed() => {}
                // A Chrome that would not list its tabs is still connected.
                _ = following => client.closed().await,
            }
            link.settle(generation, |slot| {
                slot.client = None;
                Step::failed(Failure::of(ChromeProblem::Lost))
            });
        });
    }
}

async fn dial(
    endpoint: &Endpoint,
    cancel: &CancellationToken,
    allow_wait: Duration,
) -> Result<(CdpClient, Option<String>), Failure> {
    let url = endpoint.ws_url();
    let dialed = tokio::select! {
        // Dropping the dial closes its socket, which takes Chrome's dialog
        // down with it. What is returned here is never published: the
        // disconnect that cancelled has already moved the link on.
        _ = cancel.cancelled() => return Err(Failure::of(ChromeProblem::Rejected)),
        dialed = tokio::time::timeout(allow_wait, CdpClient::connect(&url)) => dialed,
    };
    let client = match dialed {
        Err(_) => return Err(Failure::of(ChromeProblem::TimedOut)),
        Ok(Err(ConnectError::NotListening)) => return Err(Failure::of(ChromeProblem::NotRunning)),
        Ok(Err(ConnectError::Rejected(detail))) => {
            return Err(Failure {
                problem: ChromeProblem::Rejected,
                detail: Some(detail),
            })
        }
        Ok(Ok(client)) => client,
    };
    // Which Chrome answered, for the person to recognise as theirs. A Chrome
    // that will not say is still connected.
    let product = client
        .call("Browser.getVersion", json!({}), None)
        .await
        .ok()
        .and_then(|version| version.get("product").and_then(Value::as_str).map(str::to_string));
    Ok((client, product))
}

#[cfg(test)]
mod tests {
    use tempfile::TempDir;

    use tokio::sync::mpsc;

    use super::super::cdp::testing::{chrome, listen, FakeChrome};
    use super::*;

    const PRODUCT: &str = "Chrome/154.0.8037.98";

    fn port_file(dir: &TempDir) -> PathBuf {
        dir.path().join("DevToolsActivePort")
    }

    fn write_port_file(dir: &TempDir, port: u16) {
        std::fs::write(port_file(dir), format!("{port}\n/devtools/browser/test\n")).unwrap();
    }

    fn link(dir: &TempDir) -> ChromeLink {
        ChromeLink::new(Some(port_file(dir)), Duration::from_secs(10))
    }

    fn connecting(link: &ChromeLink, pasted: Option<String>) -> tokio::task::JoinHandle<ChromeStatus> {
        let link = link.clone();
        tokio::spawn(async move { link.connect(pasted.as_deref()).await })
    }

    async fn state(changes: &mut watch::Receiver<ChromeStatus>, state: ChromeState) -> ChromeStatus {
        tokio::time::timeout(
            Duration::from_secs(10),
            changes.wait_for(move |status| status.state == state),
        )
        .await
        .expect("the state was never reached")
        .unwrap()
        .clone()
    }

    /// A port that takes connections and never answers them: Chrome with its
    /// dialog up and nobody at the screen.
    async fn unanswered() -> u16 {
        let (listener, port) = listen().await;
        tokio::spawn(async move {
            let mut held = Vec::new();
            while let Ok((stream, _)) = listener.accept().await {
                held.push(stream);
            }
        });
        port
    }

    #[tokio::test]
    async fn connects_to_the_endpoint_chrome_wrote() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        assert_eq!(link.status().state, ChromeState::Disconnected);
        assert!(link.status().port_file_url.unwrap().starts_with("file://"));

        let connect = connecting(&link, None);
        let mut chrome = connections.recv().await.unwrap();
        // Chrome has the connection and has not been asked anything yet:
        // this is the stretch the person spends at its dialog.
        assert_eq!(link.status().state, ChromeState::Waiting);
        assert!(link.client().is_none());
        chrome.greet(PRODUCT).await;

        let status = connect.await.unwrap();
        assert_eq!(status.state, ChromeState::Connected);
        assert_eq!(status.product.as_deref(), Some(PRODUCT));
        assert_eq!(status.problem, None);
        assert_eq!(link.status(), status);
        assert!(link.client().is_some());
    }

    #[tokio::test]
    async fn asked_again_while_connected_it_does_not_dial_again() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        let connect = connecting(&link, None);
        let mut chrome = connections.recv().await.unwrap();
        chrome.greet(PRODUCT).await;
        let status = connect.await.unwrap();

        assert_eq!(link.connect(None).await, status);
        assert!(connections.try_recv().is_err());
    }

    #[tokio::test]
    async fn chrome_ending_the_connection_is_noticed_and_not_redialed() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        let mut changes = link.changes();
        let connect = connecting(&link, None);
        let mut chrome = connections.recv().await.unwrap();
        chrome.greet(PRODUCT).await;
        connect.await.unwrap();

        drop(chrome);
        let status = state(&mut changes, ChromeState::Disconnected).await;
        assert_eq!(status.problem, Some(ChromeProblem::Lost));
        assert_eq!(status.product, None);
        assert!(link.client().is_none());
        assert!(connections.try_recv().is_err());

        // Asked, it connects again.
        let connect = connecting(&link, None);
        let mut chrome = connections.recv().await.unwrap();
        chrome.greet(PRODUCT).await;
        assert_eq!(connect.await.unwrap().state, ChromeState::Connected);
    }

    #[tokio::test]
    async fn disconnecting_closes_the_connection_and_names_no_problem() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        let connect = connecting(&link, None);
        let mut chrome = connections.recv().await.unwrap();
        chrome.greet(PRODUCT).await;
        connect.await.unwrap();
        let client = link.client().unwrap();

        let status = link.disconnect();
        assert_eq!(status.state, ChromeState::Disconnected);
        assert_eq!(status.problem, None);
        client.closed().await;
        assert!(link.client().is_none());
        // The watch on the closed connection must not turn that into "lost".
        tokio::task::yield_now().await;
        assert_eq!(link.status().problem, None);
    }

    #[tokio::test]
    async fn disconnecting_while_chrome_is_asking_gives_the_attempt_up() {
        let port = unanswered().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        let mut changes = link.changes();
        let connect = connecting(&link, None);
        state(&mut changes, ChromeState::Waiting).await;

        link.disconnect();
        let status = connect.await.unwrap();
        assert_eq!(status.state, ChromeState::Disconnected);
        assert_eq!(status.problem, None);
        assert_eq!(link.status(), status);
    }

    #[tokio::test]
    async fn a_dialog_nobody_answers_times_out() {
        let port = unanswered().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = ChromeLink::new(Some(port_file(&dir)), Duration::from_millis(100));

        let status = link.connect(None).await;
        assert_eq!(status.state, ChromeState::Disconnected);
        assert_eq!(status.problem, Some(ChromeProblem::TimedOut));
    }

    #[tokio::test]
    async fn no_file_means_the_switch_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let link = link(&dir);
        let mut changes = link.changes();

        let status = link.connect(None).await;
        assert_eq!(status.state, ChromeState::Disconnected);
        assert_eq!(status.problem, Some(ChromeProblem::SwitchOff));
        // Nothing was dialed, so nothing was ever waiting.
        assert_eq!(changes.borrow_and_update().state, ChromeState::Disconnected);
        assert_eq!(
            ChromeLink::new(None, ALLOW_WAIT).connect(None).await.problem,
            Some(ChromeProblem::SwitchOff)
        );
    }

    #[tokio::test]
    async fn a_file_left_by_a_chrome_that_quit_means_chrome_is_not_running() {
        let (listener, port) = listen().await;
        drop(listener);
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);

        let status = link(&dir).connect(None).await;
        assert_eq!(status.problem, Some(ChromeProblem::NotRunning));
    }

    #[tokio::test]
    async fn a_pasted_endpoint_stands_in_for_a_file_out_of_reach() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        let link = link(&dir);

        let connect = connecting(&link, Some(format!("{port}\n/devtools/browser/test")));
        let mut chrome = connections.recv().await.unwrap();
        chrome.greet(PRODUCT).await;
        assert_eq!(connect.await.unwrap().state, ChromeState::Connected);

        link.disconnect();
        let status = link.connect(Some("ws://example.com:9222/devtools/browser/test")).await;
        assert_eq!(status.problem, Some(ChromeProblem::BadEndpoint));
    }

    /// Connects to the fake Chrome, which then says it has one tab open.
    async fn connected_with_a_tab(
        link: &ChromeLink,
        connections: &mut mpsc::UnboundedReceiver<FakeChrome>,
    ) -> FakeChrome {
        let mut tab_changes = link.tab_changes();
        let connect = connecting(link, None);
        let mut chrome = connections.recv().await.unwrap();
        chrome.greet(PRODUCT).await;
        connect.await.unwrap();
        let call = chrome.next_call().await;
        assert_eq!(call["method"], "Target.setDiscoverTargets");
        chrome
            .say(json!({
                "method": "Target.targetCreated",
                "params": { "targetInfo": { "targetId": "T", "type": "page", "url": "https://example.com/", "title": "Example" } },
            }))
            .await;
        chrome.answer(&call, json!({})).await;
        tokio::time::timeout(Duration::from_secs(10), tab_changes.wait_for(|tabs| tabs.len() == 1))
            .await
            .expect("the tab was never listed")
            .unwrap();
        chrome
    }

    #[tokio::test]
    async fn lists_the_tabs_of_the_connected_chrome_until_it_is_disconnected() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        assert!(link.tabs().is_empty());

        let _chrome = connected_with_a_tab(&link, &mut connections).await;
        let tab = link.tabs()[0].clone();
        assert_eq!(tab.host, "example.com");
        let listed = link.listed(&tab.id).unwrap();
        assert_eq!(listed.target, "T");
        assert_eq!(listed.url, "https://example.com/");

        link.disconnect();
        assert!(link.tabs().is_empty());
        assert!(link.listed(&tab.id).is_none());
    }

    #[tokio::test]
    async fn a_lost_connection_takes_its_tabs_with_it() {
        let (mut connections, port) = chrome().await;
        let dir = tempfile::tempdir().unwrap();
        write_port_file(&dir, port);
        let link = link(&dir);
        let mut changes = link.changes();

        let chrome = connected_with_a_tab(&link, &mut connections).await;
        drop(chrome);
        state(&mut changes, ChromeState::Disconnected).await;
        assert!(link.tabs().is_empty());
    }

    #[test]
    fn a_refused_read_is_its_own_problem() {
        assert_eq!(
            Failure::from(EndpointError::Denied),
            Failure::of(ChromeProblem::FileDenied)
        );
        assert_eq!(
            Failure::from(EndpointError::Missing),
            Failure::of(ChromeProblem::SwitchOff)
        );
        assert_eq!(
            Failure::from(EndpointError::Unreadable("disk".to_string())),
            Failure {
                problem: ChromeProblem::FileUnreadable,
                detail: Some("disk".to_string()),
            }
        );
    }

    #[test]
    fn the_wire_names_are_the_ones_the_frontend_reads() {
        let status = ChromeStatus {
            state: ChromeState::Disconnected,
            problem: Some(ChromeProblem::FileDenied),
            detail: None,
            product: None,
            port_file_url: Some("file:///x".to_string()),
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            json!({
                "state": "disconnected",
                "problem": "file-denied",
                "detail": null,
                "product": null,
                "portFileUrl": "file:///x",
            })
        );
        for (problem, name) in [
            (ChromeProblem::SwitchOff, "switch-off"),
            (ChromeProblem::FileUnreadable, "file-unreadable"),
            (ChromeProblem::BadEndpoint, "bad-endpoint"),
            (ChromeProblem::NotRunning, "not-running"),
            (ChromeProblem::Rejected, "rejected"),
            (ChromeProblem::TimedOut, "timed-out"),
            (ChromeProblem::Lost, "lost"),
        ] {
            assert_eq!(serde_json::to_value(problem).unwrap(), json!(name));
        }
        assert_eq!(serde_json::to_value(ChromeState::Waiting).unwrap(), json!("waiting"));
        assert_eq!(serde_json::to_value(ChromeState::Connected).unwrap(), json!("connected"));
    }
}
