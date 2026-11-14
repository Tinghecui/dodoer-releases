//! The tunnel a server's `ssh` reaches a lent computer through
//! (`docs/host-ssh.md` 5.2–5.3): what its three ends share.
//!
//! One SSH connection, one WebSocket of binary messages carrying its bytes
//! as they are. When a server's `ssh desktop` runs, its `ProxyCommand`
//! (`codeg-cli desktop proxy`) opens the server's own end
//! ([`CLI_TUNNEL_ROUTE`], on the CLI's loopback listener); the server asks
//! the lending desktop app for a tunnel over the app's event socket
//! (`host_tunnel`); the app dials [`TUNNEL_PATH`] back out to the server and
//! joins it to its loopback `sshd`; the server joins the two WebSockets.
//! Every connection is dialed from the desktop's side, so a computer behind
//! any router can be reached.

use std::future::Future;
use std::io;

use futures_util::{Sink, SinkExt, Stream, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

/// The `server_info` feature a desktop app looks for before it registers a
/// shell (`compat::FEATURES`).
pub const FEATURE: &str = "host_ssh";

/// The capability a host names when it lends its shell; registered with a
/// [`ShellHost`].
pub const CAPABILITY: &str = "shell";

/// Where the desktop app dials each tunnel, with `?id=<tunnel_id>`. Behind
/// the server's token like `/ws/events`.
pub const TUNNEL_PATH: &str = "/ws/host-tunnel";

/// The WebSocket subprotocol both tunnel ends speak.
pub const TUNNEL_PROTOCOL: &str = "codeg-host-tunnel";

/// The server's end for `codeg-cli desktop proxy`, under `/api/`. On the
/// loopback listener (the CLI's own token) and the main router (the main
/// token) alike, as every `/api/cli_*` route.
pub const CLI_TUNNEL_ROUTE: &str = "cli_host_tunnel";

/// What `ssh desktop` prints when nothing lends a shell. No product name
/// for the server (it runs under either brand); the desktop app is dodoer's.
pub const NO_DESKTOP_NOTE: &str =
    "No dodoer desktop app lends this workspace its command line right now. Ask the user to \
     open this workspace in the dodoer desktop app and to lend the computer from the laptop \
     icon at the foot of the sidebar, then try again.";

/// How many tunnels a server opens in a minute at most. Cowork's nginx lets
/// 20 new `/ws/` connections a minute through and bans an address over it;
/// `ssh desktop` keeps one connection for ten minutes (`ControlMaster`), so a
/// working agent needs a handful.
pub const TUNNELS_PER_MINUTE: usize = 6;

/// What a desktop app says about the shell it lends, with its `shell`
/// capability: enough for the server's `ssh` to know it is talking to that
/// computer and to log in as the right person.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ShellHost {
    /// The SSH service's host key (`ssh-ed25519 AAAA…`), made for this
    /// lending.
    pub host_key: String,
    /// The login name sessions run as.
    pub user: String,
    /// `macos`, …; for the agent's benefit.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
}

impl ShellHost {
    /// Whether what a desktop sent can go into an `ssh` configuration and a
    /// `known_hosts` line as it is: one bare public key, a plain login name.
    pub fn is_sound(&self) -> bool {
        let user_ok = !self.user.is_empty()
            && self.user.len() <= 64
            && self
                .user
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'));
        user_ok && super::sshd::one_public_key(&self.host_key).as_deref() == Some(self.host_key.trim())
    }
}

/// How much of a byte stream goes into one message.
const CHUNK: usize = 32 * 1024;

/// Carry bytes between the WebSocket `ws` and a byte stream (`reader` into
/// the socket, the socket into `writer`) until either side ends or `stop`
/// resolves. Each binary message is a run of the stream's bytes; a text
/// message is not something a tunnel carries and ends it.
///
/// What ends one direction ends both: SSH says goodbye inside its own
/// stream, so whichever side closes first has nothing more to hear.
pub async fn relay<S, R, W>(
    ws: S,
    mut reader: R,
    mut writer: W,
    stop: impl Future<Output = ()>,
) -> io::Result<()>
where
    S: Stream<Item = Result<Message, WsError>> + Sink<Message, Error = WsError> + Unpin,
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let (mut sink, mut incoming) = ws.split();
    let outward = async {
        let mut buf = vec![0u8; CHUNK];
        loop {
            let n = reader.read(&mut buf).await?;
            if n == 0 {
                break;
            }
            sink.send(Message::Binary(buf[..n].to_vec().into()))
                .await
                .map_err(ws_io)?;
        }
        let _ = sink.send(Message::Close(None)).await;
        Ok::<(), io::Error>(())
    };
    let inward = async {
        while let Some(message) = incoming.next().await {
            match message.map_err(ws_io)? {
                Message::Binary(bytes) => {
                    writer.write_all(&bytes).await?;
                    writer.flush().await?;
                }
                Message::Close(_) => break,
                // tungstenite answers pings itself.
                Message::Ping(_) | Message::Pong(_) | Message::Frame(_) => {}
                Message::Text(_) => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "a text message on a tunnel",
                    ))
                }
            }
        }
        let _ = writer.shutdown().await;
        Ok::<(), io::Error>(())
    };
    tokio::select! {
        done = outward => done,
        done = inward => done,
        _ = stop => Ok(()),
    }
}

fn ws_io(err: WsError) -> io::Error {
    match err {
        WsError::Io(io) => io,
        WsError::ConnectionClosed | WsError::AlreadyClosed => {
            io::Error::new(io::ErrorKind::ConnectionAborted, "the tunnel closed")
        }
        other => io::Error::other(other.to_string()),
    }
}

/// A tunnel's WebSocket, as `codeg-cli` opens it.
pub type DialedTunnel = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Open the CLI's end of a tunnel on the runtime at `base_url`, with its
/// `token`. `Err` is what the runtime answered instead, in its own words
/// (it says what the person can do).
pub async fn dial_cli_end(base_url: &str, token: &str) -> Result<DialedTunnel, String> {
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::{header, HeaderValue};

    let url = ws_url(base_url, &format!("/api/{CLI_TUNNEL_ROUTE}"));
    let mut request = url
        .into_client_request()
        .map_err(|e| format!("not an address to dial: {e}"))?;
    let headers = request.headers_mut();
    headers.insert(
        header::SEC_WEBSOCKET_PROTOCOL,
        HeaderValue::from_static(TUNNEL_PROTOCOL),
    );
    headers.insert(
        header::AUTHORIZATION,
        HeaderValue::from_str(&format!("Bearer {}", token.trim()))
            .map_err(|_| "the token cannot go into a header".to_string())?,
    );
    match tokio_tungstenite::connect_async(request).await {
        Ok((socket, _)) => Ok(socket),
        Err(WsError::Http(response)) => {
            let said = response
                .body()
                .as_deref()
                .map(String::from_utf8_lossy)
                .unwrap_or_default()
                .trim()
                .to_string();
            // The words arrive with the status unless they missed the read
            // that ended the headers; the one refusal with a fixed answer
            // still gets it.
            Err(if !said.is_empty() {
                said
            } else if response.status() == 503 {
                NO_DESKTOP_NOTE.to_string()
            } else {
                format!("the runtime answered HTTP {}", response.status())
            })
        }
        Err(e) => Err(format!("could not reach the runtime: {e}")),
    }
}

/// The `ws://` / `wss://` address of `path` on the server at `base_url`
/// (`http://…`, `https://…`).
pub fn ws_url(base_url: &str, path: &str) -> String {
    let trimmed = base_url.trim().trim_end_matches('/');
    if let Some(rest) = trimmed.strip_prefix("https://") {
        format!("wss://{rest}{path}")
    } else if let Some(rest) = trimmed.strip_prefix("http://") {
        format!("ws://{rest}{path}")
    } else {
        format!("{trimmed}{path}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn shell(host_key: &str, user: &str) -> ShellHost {
        ShellHost {
            host_key: host_key.to_string(),
            user: user.to_string(),
            platform: Some("macos".into()),
        }
    }

    #[test]
    fn only_a_bare_key_and_a_plain_name_are_sound() {
        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIH8f";
        assert!(shell(key, "some_one").is_sound());
        assert!(shell(key, "a.b-c").is_sound());
        assert!(!shell(key, "").is_sound());
        assert!(!shell(key, "two words").is_sound());
        assert!(!shell(key, "x\"y").is_sound());
        assert!(!shell(&format!("{key} comment"), "a").is_sound());
        assert!(!shell(&format!("{key}\nssh-ed25519 AAAA"), "a").is_sound());
        assert!(!shell("command=\"x\" ssh-ed25519 AAAA", "a").is_sound());
    }

    #[test]
    fn the_shell_host_is_the_documented_json() {
        let host = shell("ssh-ed25519 AAAA", "me");
        assert_eq!(
            serde_json::to_value(&host).unwrap(),
            serde_json::json!({"host_key": "ssh-ed25519 AAAA", "user": "me", "platform": "macos"})
        );
        let without: ShellHost =
            serde_json::from_str(r#"{"host_key":"ssh-ed25519 AAAA","user":"me"}"#).unwrap();
        assert_eq!(without.platform, None);
    }

    #[test]
    fn ws_urls_follow_the_base_url() {
        assert_eq!(
            ws_url("https://a.example/", TUNNEL_PATH),
            "wss://a.example/ws/host-tunnel"
        );
        assert_eq!(
            ws_url("http://127.0.0.1:9", "/api/cli_host_tunnel"),
            "ws://127.0.0.1:9/api/cli_host_tunnel"
        );
    }

    /// Bytes go through both ways, and the far side closing ends it.
    #[tokio::test]
    async fn relay_carries_bytes_both_ways_and_ends_with_the_socket() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        // The far end: a WebSocket that echoes one message upper-cased, then
        // closes.
        let far = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            let Some(Ok(Message::Binary(bytes))) = socket.next().await else {
                panic!("a binary message first");
            };
            socket
                .send(Message::Binary(bytes.to_ascii_uppercase().into()))
                .await
                .unwrap();
            socket.close(None).await.unwrap();
        });
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        let (mut near, local) = tokio::io::duplex(1024);
        let (reader, writer) = tokio::io::split(local);
        let relaying = tokio::spawn(relay(ws, reader, writer, std::future::pending()));
        near.write_all(b"hello").await.unwrap();
        let mut answer = Vec::new();
        near.read_to_end(&mut answer).await.unwrap();
        assert_eq!(answer, b"HELLO");
        relaying.await.unwrap().unwrap();
        far.await.unwrap();
    }

    /// `stop` ends a relay nobody else would end.
    #[tokio::test]
    async fn relay_ends_when_told_to() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let far = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(_)) = socket.next().await {}
        });
        let (ws, _) = tokio_tungstenite::connect_async(format!("ws://{address}/"))
            .await
            .unwrap();
        let (_near, local) = tokio::io::duplex(1024);
        let (reader, writer) = tokio::io::split(local);
        let (stop, stopped) = tokio::sync::oneshot::channel::<()>();
        let relaying = tokio::spawn(relay(ws, reader, writer, async move {
            let _ = stopped.await;
        }));
        stop.send(()).unwrap();
        relaying.await.unwrap().unwrap();
        far.await.unwrap();
    }
}
