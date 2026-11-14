//! The DevTools protocol over one WebSocket.
//!
//! Chrome asks the person to allow every new connection, so there is one for
//! the whole browser and it is kept: each tab is a session on it
//! (`Target.attachToTarget` with `flatten`), told apart by the `sessionId`
//! its frames carry. A call is a frame with an id and waits for the frame
//! that answers that id; everything else Chrome sends is an event, handed to
//! whoever subscribed.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use tokio::net::TcpStream;
use tokio::sync::{broadcast, mpsc, oneshot};
use tokio_tungstenite::tungstenite::protocol::WebSocketConfig;
use tokio_tungstenite::tungstenite::{Error as WsError, Message};
use tokio_tungstenite::{MaybeTlsStream, WebSocketStream};
use tokio_util::sync::CancellationToken;

/// Longest a call waits for its answer. Chrome answers in milliseconds; a
/// call still open after this is a page that will not answer at all.
const CALL_TIMEOUT: Duration = Duration::from_secs(30);

/// A screenshot of a long page arrives as one frame of base64, well past the
/// library's 16 MiB default.
const MAX_MESSAGE_BYTES: usize = 256 << 20;

/// Events a slow subscriber may fall behind by before it starts losing them.
const EVENT_BACKLOG: usize = 1024;

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CdpError {
    #[error("the connection to Chrome is closed")]
    Closed,
    #[error("Chrome did not answer {0} in time")]
    TimedOut(String),
    #[error("Chrome refused {method}: {message}")]
    Refused {
        method: String,
        code: i64,
        message: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConnectError {
    /// Nothing answers at the port: Chrome is not running, or the address is
    /// one a Chrome that has since quit left behind.
    #[error("nothing is listening at Chrome's debugging port")]
    NotListening,
    /// Something answered and the connection was not made: the person said
    /// no, or the address belongs to an earlier run of Chrome.
    #[error("Chrome did not accept the connection: {0}")]
    Rejected(String),
}

/// Something Chrome said without being asked.
#[derive(Debug, Clone, PartialEq)]
pub struct CdpEvent {
    pub method: String,
    pub params: Value,
    /// The tab it is about; `None` for the browser itself.
    pub session: Option<String>,
}

#[derive(Deserialize)]
struct Incoming {
    id: Option<u64>,
    method: Option<String>,
    #[serde(default)]
    params: Value,
    result: Option<Value>,
    error: Option<Refusal>,
    #[serde(rename = "sessionId")]
    session: Option<String>,
}

#[derive(Deserialize)]
struct Refusal {
    #[serde(default)]
    code: i64,
    #[serde(default)]
    message: String,
}

type Answer = oneshot::Sender<Result<Value, Refusal>>;
type Socket = WebSocketStream<MaybeTlsStream<TcpStream>>;

struct Inner {
    outgoing: mpsc::UnboundedSender<String>,
    waiting: Mutex<HashMap<u64, Answer>>,
    last_id: AtomicU64,
    events: broadcast::Sender<CdpEvent>,
    closed: CancellationToken,
}

impl Inner {
    fn waiting(&self) -> MutexGuard<'_, HashMap<u64, Answer>> {
        self.waiting.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn take_in(&self, text: &str) {
        let Ok(frame) = serde_json::from_str::<Incoming>(text) else {
            tracing::debug!("[chrome] a frame that is not the protocol's was dropped");
            return;
        };
        if let Some(id) = frame.id {
            // Nobody waiting is a call that gave up; its answer has no reader.
            if let Some(answer) = self.waiting().remove(&id) {
                let _ = answer.send(match frame.error {
                    Some(refusal) => Err(refusal),
                    None => Ok(frame.result.unwrap_or(Value::Null)),
                });
            }
        } else if let Some(method) = frame.method {
            // An event with no subscriber is one nobody asked to hear.
            let _ = self.events.send(CdpEvent {
                method,
                params: frame.params,
                session: frame.session,
            });
        }
    }
}

/// One connection to a Chrome. Cheap to clone; every clone is the same
/// connection, and it lasts until [`Self::close`] or until Chrome ends it.
#[derive(Clone)]
pub struct CdpClient {
    inner: Arc<Inner>,
}

impl CdpClient {
    /// Dial `url`. Chrome holds the handshake open while it asks the person
    /// whether to allow it, so this takes as long as their answer does — the
    /// caller decides how long that may be.
    pub async fn connect(url: &str) -> Result<Self, ConnectError> {
        let config = WebSocketConfig::default()
            .max_message_size(Some(MAX_MESSAGE_BYTES))
            .max_frame_size(Some(MAX_MESSAGE_BYTES));
        let (socket, _) = tokio_tungstenite::connect_async_with_config(url, Some(config), true)
            .await
            .map_err(|err| match err {
                WsError::Io(io) if io.kind() == std::io::ErrorKind::ConnectionRefused => {
                    ConnectError::NotListening
                }
                other => ConnectError::Rejected(other.to_string()),
            })?;
        let (outgoing, queued) = mpsc::unbounded_channel();
        let (events, _) = broadcast::channel(EVENT_BACKLOG);
        let inner = Arc::new(Inner {
            outgoing,
            waiting: Mutex::new(HashMap::new()),
            last_id: AtomicU64::new(0),
            events,
            closed: CancellationToken::new(),
        });
        tokio::spawn(run(socket, inner.clone(), queued));
        Ok(Self { inner })
    }

    /// Ask Chrome for `method` — of the tab behind `session`, or of the
    /// browser itself — and wait for what it says.
    pub async fn call(
        &self,
        method: &str,
        params: Value,
        session: Option<&str>,
    ) -> Result<Value, CdpError> {
        let id = self.inner.last_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            frame["sessionId"] = json!(session);
        }
        let (answer, answered) = oneshot::channel();
        self.inner.waiting().insert(id, answer);
        // Checked after the insert: the socket's task marks the connection
        // closed and only then empties the table, so a call that got in
        // behind that sweep sees the mark here instead of waiting forever.
        if self.inner.closed.is_cancelled() || self.inner.outgoing.send(frame.to_string()).is_err() {
            self.inner.waiting().remove(&id);
            return Err(CdpError::Closed);
        }
        match tokio::time::timeout(CALL_TIMEOUT, answered).await {
            Ok(Ok(Ok(result))) => Ok(result),
            Ok(Ok(Err(refusal))) => Err(CdpError::Refused {
                method: method.to_string(),
                code: refusal.code,
                message: refusal.message,
            }),
            Ok(Err(_)) => Err(CdpError::Closed),
            Err(_) => {
                self.inner.waiting().remove(&id);
                Err(CdpError::TimedOut(method.to_string()))
            }
        }
    }

    /// Ask Chrome for `method` without waiting for its answer, which is
    /// dropped when it comes: for what is said on the way out (letting a tab
    /// go), from places that cannot wait.
    pub fn send(&self, method: &str, params: Value, session: Option<&str>) {
        let id = self.inner.last_id.fetch_add(1, Ordering::Relaxed) + 1;
        let mut frame = json!({ "id": id, "method": method, "params": params });
        if let Some(session) = session {
            frame["sessionId"] = json!(session);
        }
        let _ = self.inner.outgoing.send(frame.to_string());
    }

    /// Everything Chrome says from now on, for every tab; a subscriber picks
    /// out its own by [`CdpEvent::session`].
    pub fn events(&self) -> broadcast::Receiver<CdpEvent> {
        self.inner.events.subscribe()
    }

    pub fn close(&self) {
        self.inner.closed.cancel();
    }

    pub fn is_closed(&self) -> bool {
        self.inner.closed.is_cancelled()
    }

    /// Whether `other` is a clone of this very connection.
    pub fn same(&self, other: &CdpClient) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }

    /// Returns once the connection is over, whoever ended it.
    pub async fn closed(&self) {
        self.inner.closed.cancelled().await;
    }
}

async fn run(mut socket: Socket, inner: Arc<Inner>, mut queued: mpsc::UnboundedReceiver<String>) {
    loop {
        tokio::select! {
            _ = inner.closed.cancelled() => break,
            frame = queued.recv() => {
                let Some(frame) = frame else { break };
                if socket.send(Message::Text(frame.into())).await.is_err() {
                    break;
                }
            }
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => inner.take_in(text.as_str()),
                // The protocol is text; pings are answered by the library.
                Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                Some(Ok(_)) => {}
            },
        }
    }
    let _ = socket.close(None).await;
    inner.closed.cancel();
    // Dropping the senders is what tells each waiting call the connection
    // went away.
    inner.waiting().clear();
}

#[cfg(test)]
pub(crate) mod testing {
    //! A stand-in for Chrome's end of the socket.

    use futures_util::{SinkExt, StreamExt};
    use serde_json::{json, Value};
    use tokio::net::{TcpListener, TcpStream};
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::Message;
    use tokio_tungstenite::WebSocketStream;

    /// One accepted connection, driven frame by frame from the test.
    pub struct FakeChrome {
        socket: WebSocketStream<TcpStream>,
    }

    impl FakeChrome {
        /// The next call the client made.
        pub async fn next_call(&mut self) -> Value {
            loop {
                let message = self.socket.next().await.expect("the client hung up").unwrap();
                if let Message::Text(text) = message {
                    return serde_json::from_str(text.as_str()).unwrap();
                }
            }
        }

        pub async fn say(&mut self, frame: Value) {
            self.socket
                .send(Message::Text(frame.to_string().into()))
                .await
                .unwrap();
        }

        pub async fn answer(&mut self, call: &Value, result: Value) {
            self.say(json!({ "id": call["id"], "result": result })).await;
        }

        /// Answers `Browser.getVersion` the way a connecting client asks it.
        pub async fn greet(&mut self, product: &str) {
            let call = self.next_call().await;
            assert_eq!(call["method"], "Browser.getVersion");
            self.answer(&call, json!({ "product": product })).await;
        }
    }

    /// A listener on a free loopback port, and the port.
    pub async fn listen() -> (TcpListener, u16) {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        (listener, port)
    }

    /// Accepts connections like a Chrome whose person allows each one, and
    /// hands them to the test.
    pub async fn chrome() -> (mpsc::UnboundedReceiver<FakeChrome>, u16) {
        let (listener, port) = listen().await;
        let (accepted, connections) = mpsc::unbounded_channel();
        tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let Ok(socket) = tokio_tungstenite::accept_async(stream).await else {
                    continue;
                };
                if accepted.send(FakeChrome { socket }).is_err() {
                    break;
                }
            }
        });
        (connections, port)
    }
}

#[cfg(test)]
mod tests {
    use super::testing::{chrome, listen};
    use super::*;

    fn url(port: u16) -> String {
        format!("ws://127.0.0.1:{port}/devtools/browser/test")
    }

    #[tokio::test]
    async fn each_call_gets_the_answer_to_its_own_id() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&url(port)).await.unwrap();
        let mut chrome = connections.recv().await.unwrap();

        let first = client.clone();
        let first = tokio::spawn(async move { first.call("Target.getTargets", json!({}), None).await });
        let one = chrome.next_call().await;
        let second = client.clone();
        let second = tokio::spawn(async move {
            second
                .call("Runtime.evaluate", json!({ "expression": "1" }), Some("tab-1"))
                .await
        });
        let two = chrome.next_call().await;

        assert_eq!(one["method"], "Target.getTargets");
        assert_eq!(one.get("sessionId"), None);
        assert_eq!(two["method"], "Runtime.evaluate");
        assert_eq!(two["params"]["expression"], "1");
        assert_eq!(two["sessionId"], "tab-1");
        assert_ne!(one["id"], two["id"]);

        // Answered in the other order.
        chrome.answer(&two, json!({ "from": "two" })).await;
        chrome.answer(&one, json!({ "from": "one" })).await;
        assert_eq!(first.await.unwrap(), Ok(json!({ "from": "one" })));
        assert_eq!(second.await.unwrap(), Ok(json!({ "from": "two" })));
    }

    #[tokio::test]
    async fn a_refusal_names_the_call_it_refused() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&url(port)).await.unwrap();
        let mut chrome = connections.recv().await.unwrap();

        let asking = client.clone();
        let asking = tokio::spawn(async move { asking.call("Page.navigate", json!({}), None).await });
        let call = chrome.next_call().await;
        chrome
            .say(json!({ "id": call["id"], "error": { "code": -32602, "message": "Invalid parameters" } }))
            .await;

        assert_eq!(
            asking.await.unwrap(),
            Err(CdpError::Refused {
                method: "Page.navigate".to_string(),
                code: -32602,
                message: "Invalid parameters".to_string(),
            })
        );
    }

    #[tokio::test]
    async fn events_reach_subscribers_with_the_tab_they_are_about() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&url(port)).await.unwrap();
        let mut chrome = connections.recv().await.unwrap();
        let mut events = client.events();

        chrome
            .say(json!({ "method": "Target.targetCreated", "params": { "targetInfo": { "type": "page" } } }))
            .await;
        chrome
            .say(json!({ "method": "Page.loadEventFired", "params": { "timestamp": 1 }, "sessionId": "tab-1" }))
            .await;
        chrome.say(json!("not a frame")).await;

        let browser = events.recv().await.unwrap();
        assert_eq!(browser.method, "Target.targetCreated");
        assert_eq!(browser.session, None);
        assert_eq!(browser.params["targetInfo"]["type"], "page");
        let tab = events.recv().await.unwrap();
        assert_eq!(tab.method, "Page.loadEventFired");
        assert_eq!(tab.session.as_deref(), Some("tab-1"));
    }

    #[tokio::test]
    async fn chrome_going_away_ends_the_calls_that_were_waiting() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&url(port)).await.unwrap();
        let mut chrome = connections.recv().await.unwrap();

        let asking = client.clone();
        let asking = tokio::spawn(async move { asking.call("Target.getTargets", json!({}), None).await });
        chrome.next_call().await;
        drop(chrome);

        assert_eq!(asking.await.unwrap(), Err(CdpError::Closed));
        client.closed().await;
        assert!(client.is_closed());
        assert_eq!(
            client.call("Target.getTargets", json!({}), None).await,
            Err(CdpError::Closed)
        );
    }

    #[tokio::test]
    async fn closing_is_seen_by_every_clone() {
        let (mut connections, port) = chrome().await;
        let client = CdpClient::connect(&url(port)).await.unwrap();
        let _chrome = connections.recv().await.unwrap();
        let other = client.clone();

        client.close();
        other.closed().await;
        assert_eq!(other.call("Browser.getVersion", json!({}), None).await, Err(CdpError::Closed));
    }

    #[tokio::test]
    async fn a_port_nobody_listens_on_is_not_a_refusal_by_the_person() {
        let (listener, port) = listen().await;
        drop(listener);
        assert_eq!(
            CdpClient::connect(&url(port)).await.err(),
            Some(ConnectError::NotListening)
        );
    }

    #[tokio::test]
    async fn a_connection_dropped_before_the_handshake_was_turned_down() {
        let (listener, port) = listen().await;
        tokio::spawn(async move {
            // Chrome with a person who says no: the socket opens and closes.
            while let Ok((stream, _)) = listener.accept().await {
                drop(stream);
            }
        });
        assert!(matches!(
            CdpClient::connect(&url(port)).await.err(),
            Some(ConnectError::Rejected(_))
        ));
    }
}
