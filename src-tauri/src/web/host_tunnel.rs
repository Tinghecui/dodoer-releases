//! Cowork fork: the server's two ends of a tunnel to a lent shell
//! (`host_ssh::tunnel`, `docs/host-ssh.md` 5.2–5.3).
//!
//! `codeg-cli desktop proxy --device <id>` — the `ProxyCommand` of the
//! `ssh <device>` this server's agents run — opens the CLI end
//! (`/api/cli_host_tunnel?device=`). The server asks the app on that device
//! lending its shell for a tunnel (`HostRegistry::open_tunnel`), never
//! another device's; the app dials the desktop end (`/ws/host-tunnel?id=`),
//! and from then on the two sockets are joined, binary message for binary
//! message, until either closes. When it cannot, the CLI hears why, and the
//! status says which case it is (`docs/devices.md` 5.3).
//!
//! Alongside, the files the server's `ssh` reads (`host_ssh::client`) follow
//! the book of devices and the shells lent: an entry per device, the keys
//! taken away a while after the last shell goes.

use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Extension, Query};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;

use super::host_devices::now_ms;
use super::host_registry::{HostRegistry, ShellTarget, TunnelError};
use super::shutdown::ShutdownSignal;
use crate::cli_run::CliRunService;
use crate::host_ssh::client::ClientFiles;
use crate::host_ssh::tunnel::{NO_DESKTOP_NOTE, TUNNELS_PER_MINUTE, TUNNEL_PROTOCOL};

/// How long the desktop app has to dial back.
const DIAL_TIMEOUT: Duration = Duration::from_secs(15);

/// How long the keys outlast the last shell lent: an app between two event
/// sockets registers again at once, and should find the same key let in.
const FORGET_AFTER: Duration = Duration::from_secs(30);

/// A server's tunnels to lent shells, and the files its `ssh` needs for them.
pub struct HostTunnels {
    registry: Arc<HostRegistry>,
    files: ClientFiles,
    /// The server stopping ends every tunnel; `None` in tests.
    shutdown: Option<Arc<ShutdownSignal>>,
}

impl HostTunnels {
    pub fn new(
        registry: Arc<HostRegistry>,
        data_dir: &Path,
        shutdown: Option<Arc<ShutdownSignal>>,
    ) -> Arc<Self> {
        Self::with_files(registry, ClientFiles::new(data_dir), shutdown)
    }

    pub fn with_files(
        registry: Arc<HostRegistry>,
        files: ClientFiles,
        shutdown: Option<Arc<ShutdownSignal>>,
    ) -> Arc<Self> {
        Arc::new(Self {
            registry,
            files,
            shutdown,
        })
    }

    pub fn files(&self) -> &ClientFiles {
        &self.files
    }

    /// Keep the files to the devices and the shells lent, for as long as
    /// the server runs.
    pub fn spawn_file_sync(self: &Arc<Self>) {
        let tunnels = Arc::clone(self);
        let mut plans = self.registry.watch_ssh();
        tokio::spawn(async move {
            loop {
                let plan = plans.borrow_and_update().clone();
                if let Err(e) = tunnels.files.prepare(&plan).await {
                    tracing::warn!("[host-tunnel] the ssh files: {e}");
                }
                if !plan.lends() {
                    tokio::select! {
                        changed = plans.changed() => {
                            if changed.is_err() {
                                return;
                            }
                            continue;
                        }
                        _ = tokio::time::sleep(FORGET_AFTER) => tunnels.files.forget().await,
                    }
                }
                if plans.changed().await.is_err() {
                    return;
                }
            }
        });
    }

    /// A tunnel for one `ssh` to `device` (none: the old `ssh desktop`): the
    /// files ready, and the socket that device dialed. `Err` is the status
    /// and the words for the CLI to print.
    pub async fn open(&self, device: Option<&str>) -> Result<WebSocket, (StatusCode, String)> {
        let target = match device {
            Some(id) => ShellTarget::Device(id),
            None => ShellTarget::Default,
        };
        // Why it cannot be reached is said before anything is written.
        self.registry.check_shell(target).map_err(refusal)?;
        let failed = |e: String| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("The server could not prepare its side of `ssh`: {e}"),
            )
        };
        self.files
            .prepare(&self.registry.ssh_plan())
            .await
            .map_err(failed)?;
        let key = self.files.public_key().map_err(failed)?;
        self.registry
            .open_tunnel(&key, target, DIAL_TIMEOUT)
            .await
            .map_err(refusal)
    }
}

/// What the CLI is answered when a tunnel does not open: a status of its
/// own for each case, and what the agent can do. Never "use another device
/// instead".
fn refusal(error: TunnelError) -> (StatusCode, String) {
    let lend_hint = "lend its command line from the laptop icon at the foot of the sidebar \
                     in the dodoer desktop app on that computer";
    match error {
        TunnelError::NoHost => (StatusCode::SERVICE_UNAVAILABLE, NO_DESKTOP_NOTE.to_string()),
        TunnelError::UnknownDevice { names } => (
            StatusCode::NOT_FOUND,
            format!(
                "That device is no longer in this server's list of devices (the user removed \
                 it). {}",
                devices_line(&names)
            ),
        ),
        TunnelError::Offline { name, last_seen } => (
            StatusCode::SERVICE_UNAVAILABLE,
            format!(
                "`{name}` is offline (last online {}). Ask the user to open the dodoer desktop \
                 app on that computer and to {lend_hint}, then try again. Do not use another \
                 device instead unless the user says so.",
                ago(last_seen, now_ms())
            ),
        ),
        TunnelError::NotLent { name } => (
            StatusCode::FORBIDDEN,
            format!(
                "`{name}` is online but does not lend its command line. Ask the user to \
                 {lend_hint}, then try again. Do not use another device instead unless the user \
                 says so."
            ),
        ),
        TunnelError::Ambiguous { names } => (
            StatusCode::CONFLICT,
            format!(
                "`ssh desktop` no longer means one computer: the user has several devices ({}). \
                 Ask the user which one they mean, then run `ssh <name>`.",
                names.join(", ")
            ),
        ),
        TunnelError::Busy => (
            StatusCode::TOO_MANY_REQUESTS,
            format!(
                "More than {TUNNELS_PER_MINUTE} connections to this device were opened in the \
                 last minute. `ssh` keeps one open for ten minutes and reuses it; wait a moment, \
                 or run commands through one connection."
            ),
        ),
        TunnelError::Refused(why) => (
            StatusCode::BAD_GATEWAY,
            format!("The desktop app could not open the connection: {why}"),
        ),
        TunnelError::Gone => (
            StatusCode::BAD_GATEWAY,
            "The desktop app went away before the connection was made.".to_string(),
        ),
        TunnelError::TimedOut => (
            StatusCode::GATEWAY_TIMEOUT,
            format!(
                "The desktop app did not connect back within {} s. It may have lost its \
                 network, or the computer is asleep.",
                DIAL_TIMEOUT.as_secs()
            ),
        ),
    }
}

/// The devices there are, for an agent to pick the one the user means.
fn devices_line(names: &[String]) -> String {
    if names.is_empty() {
        "No device has connected to this server since.".to_string()
    } else {
        format!(
            "The user's devices: {}. Run `ssh <name>` with the one the user means.",
            names.join(", ")
        )
    }
}

/// How long ago `then` was, both in milliseconds since 1970, in words.
fn ago(then: i64, now: i64) -> String {
    if then <= 0 {
        return "a long time ago".to_string();
    }
    let minutes = (now - then).max(0) / 60_000;
    match minutes {
        0 => "just now".to_string(),
        1 => "a minute ago".to_string(),
        2..=59 => format!("{minutes} minutes ago"),
        60..=119 => "an hour ago".to_string(),
        120..=1439 => format!("{} hours ago", minutes / 60),
        1440..=2879 => "a day ago".to_string(),
        _ => format!("{} days ago", minutes / 1440),
    }
}

/// The CLI end, given the server's tunnels: answered with a refusal the CLI
/// prints, or upgraded and joined to the device's socket.
pub async fn serve_cli_end(
    ws: WebSocketUpgrade,
    tunnels: Arc<HostTunnels>,
    device: Option<String>,
) -> Response {
    match tunnels.open(device.as_deref()).await {
        Ok(desktop) => {
            let shutdown = tunnels.shutdown.clone();
            ws.protocols([TUNNEL_PROTOCOL])
                .on_upgrade(move |cli| join(cli, desktop, shutdown))
                .into_response()
        }
        Err((status, message)) => (status, message).into_response(),
    }
}

#[derive(Debug, Default, Deserialize)]
pub struct CliTunnelQuery {
    /// The device `ssh <name>` means (`desktop proxy --device`); none from
    /// a configuration that names none.
    #[serde(default)]
    device: Option<String>,
}

/// `GET /api/cli_host_tunnel?device=`, among the CLI's routes
/// (`cli_run::http`).
pub async fn cli_end(
    ws: WebSocketUpgrade,
    Query(query): Query<CliTunnelQuery>,
    Extension(service): Extension<Arc<CliRunService>>,
) -> Response {
    match service.host_tunnels() {
        Some(tunnels) => serve_cli_end(ws, tunnels, query.device).await,
        None => (
            StatusCode::NOT_FOUND,
            "This codeg runtime does not reach any desktop's command line.",
        )
            .into_response(),
    }
}

#[derive(Debug, Deserialize)]
pub struct TunnelQuery {
    id: String,
}

/// `GET /ws/host-tunnel?id=`: a desktop app dialing the tunnel it was asked
/// for. The id is the secret — random, and sent only down that app's own
/// event socket — and good once.
pub async fn desktop_end(
    ws: WebSocketUpgrade,
    Query(query): Query<TunnelQuery>,
    Extension(registry): Extension<Arc<HostRegistry>>,
) -> Response {
    let Some(reply) = registry.claim_tunnel(&query.id) else {
        return (StatusCode::NOT_FOUND, "No tunnel waits on that id.").into_response();
    };
    ws.protocols([TUNNEL_PROTOCOL])
        .on_upgrade(move |socket| async move {
            let _ = reply.send(Ok(socket));
        })
        .into_response()
}

/// Carry each side's binary messages to the other until one closes.
async fn join(cli: WebSocket, desktop: WebSocket, shutdown: Option<Arc<ShutdownSignal>>) {
    let (cli_out, cli_in) = cli.split();
    let (desktop_out, desktop_in) = desktop.split();
    let stopping = async {
        match &shutdown {
            Some(signal) => signal.wait().await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        _ = pass(cli_in, desktop_out) => {}
        _ = pass(desktop_in, cli_out) => {}
        _ = stopping => {}
    }
    tracing::debug!("[host-tunnel] a tunnel closed");
}

async fn pass(mut from: SplitStream<WebSocket>, mut to: SplitSink<WebSocket, Message>) {
    while let Some(Ok(message)) = from.next().await {
        match message {
            Message::Binary(bytes) => {
                if to.send(Message::Binary(bytes)).await.is_err() {
                    break;
                }
            }
            // axum answers pings itself.
            Message::Ping(_) | Message::Pong(_) => {}
            Message::Close(_) | Message::Text(_) => break,
        }
    }
    let _ = to.send(Message::Close(None)).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    use axum::routing::get;
    use axum::Router;
    use tokio::sync::mpsc;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;

    use crate::host_ssh::tunnel::{self, ShellHost, CAPABILITY, TUNNEL_PATH};
    use crate::host_ssh::{supported, Sshd};
    use crate::web::ws_attach::ServerMsg;

    /// A server with the two ends and nothing else, on a loopback port.
    async fn serve(tunnels: Arc<HostTunnels>, registry: Arc<HostRegistry>) -> String {
        let cli_end = move |ws: WebSocketUpgrade, Query(query): Query<CliTunnelQuery>| {
            serve_cli_end(ws, Arc::clone(&tunnels), query.device)
        };
        let app = Router::new()
            .route(
                TUNNEL_PATH,
                get(desktop_end).layer(Extension(Arc::clone(&registry))),
            )
            .route("/api/cli_host_tunnel", get(cli_end));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("http://{address}")
    }

    fn tunnels_in(dir: &Path, registry: &Arc<HostRegistry>) -> Arc<HostTunnels> {
        HostTunnels::with_files(
            Arc::clone(registry),
            ClientFiles::with(
                dir.join("data").join("host-ssh"),
                Some(dir.join("home").join(".ssh").join("config")),
                Some(PathBuf::from("/opt/codeg/codeg-cli")),
            ),
            None,
        )
    }

    #[test]
    fn the_cli_route_is_the_one_the_cli_dials() {
        assert_eq!(crate::host_ssh::tunnel::CLI_TUNNEL_ROUTE, "cli_host_tunnel");
    }

    /// With no shell lent, the CLI hears what the person can do — before
    /// anything is upgraded.
    #[tokio::test]
    async fn with_no_shell_lent_the_cli_hears_why() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(HostRegistry::new());
        let base = serve(tunnels_in(dir.path(), &registry), Arc::clone(&registry)).await;
        let refused = tunnel::dial_cli_end(&base, "t", None).await.unwrap_err();
        assert_eq!(refused, NO_DESKTOP_NOTE);
    }

    /// A device the book does not have: the CLI hears so, and which there
    /// are. Not a device id at all: not even asked.
    #[tokio::test]
    async fn a_device_not_in_the_book_is_said_so() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(HostRegistry::new());
        let base = serve(tunnels_in(dir.path(), &registry), Arc::clone(&registry)).await;
        let refused = tunnel::dial_cli_end(&base, "t", Some("0123456789abcdef"))
            .await
            .unwrap_err();
        // The words, unless they missed the read that ended the headers.
        assert!(
            refused.contains("no longer in this server's list") || refused.contains("404"),
            "{refused}"
        );
        assert!(tunnel::dial_cli_end(&base, "t", Some("not an id"))
            .await
            .is_err());
    }

    /// Each case its own status, so that the proxy can tell them apart
    /// without the words; and never "use another device".
    #[test]
    fn each_refusal_has_its_own_status() {
        let cases = [
            TunnelError::NoHost,
            TunnelError::UnknownDevice {
                names: vec!["imac".into()],
            },
            TunnelError::NotLent {
                name: "imac".into(),
            },
            TunnelError::Ambiguous {
                names: vec!["imac".into(), "laptop".into()],
            },
            TunnelError::Busy,
        ];
        let statuses: Vec<StatusCode> = cases.into_iter().map(|e| refusal(e).0).collect();
        assert_eq!(
            statuses,
            vec![
                StatusCode::SERVICE_UNAVAILABLE,
                StatusCode::NOT_FOUND,
                StatusCode::FORBIDDEN,
                StatusCode::CONFLICT,
                StatusCode::TOO_MANY_REQUESTS,
            ]
        );
        let (status, offline) = refusal(TunnelError::Offline {
            name: "laptop".into(),
            last_seen: now_ms() - 3 * 3_600_000,
        });
        assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
        assert!(offline.contains("`laptop` is offline (last online 3 hours ago)"), "{offline}");
        assert!(offline.contains("Do not use another device"));
        let (_, several) = refusal(TunnelError::Ambiguous {
            names: vec!["imac".into(), "laptop".into()],
        });
        assert!(several.contains("(imac, laptop)"), "{several}");
    }

    #[test]
    fn how_long_ago_reads() {
        let now = 1_000_000_000_000;
        assert_eq!(ago(now - 10_000, now), "just now");
        assert_eq!(ago(now - 60_000, now), "a minute ago");
        assert_eq!(ago(now - 5 * 60_000, now), "5 minutes ago");
        assert_eq!(ago(now - 90 * 60_000, now), "an hour ago");
        assert_eq!(ago(now - 5 * 3_600_000, now), "5 hours ago");
        assert_eq!(ago(now - 30 * 3_600_000, now), "a day ago");
        assert_eq!(ago(now - 3 * 86_400_000, now), "3 days ago");
        assert_eq!(ago(0, now), "a long time ago");
    }

    /// A made-up id is turned away, and nothing waits on it.
    #[tokio::test]
    async fn a_desktop_end_without_its_order_is_turned_away() {
        let dir = tempfile::tempdir().unwrap();
        let registry = Arc::new(HostRegistry::new());
        let base = serve(tunnels_in(dir.path(), &registry), Arc::clone(&registry)).await;
        let mut request = tunnel::ws_url(&base, &format!("{TUNNEL_PATH}?id=made-up"))
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(TUNNEL_PROTOCOL),
        );
        match tokio_tungstenite::connect_async(request).await {
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                assert_eq!(response.status(), 404)
            }
            other => panic!("refused with 404, not {:?}", other.map(|_| ())),
        }
    }

    /// The whole way, as the acceptance test runs it: an `ssh` on the
    /// server, its proxy's socket, the server joining it to the socket the
    /// lending desktop dials, and that desktop's real `sshd` — logged in to
    /// with the key and host key the server wrote.
    #[tokio::test]
    async fn ssh_reaches_a_lent_sshd_through_the_tunnel() {
        if !supported() {
            assert!(!crate::host_ssh::test_needs_sshd(), "no sshd on this machine");
            return;
        }
        let dir = tempfile::tempdir().unwrap();

        // The lent computer.
        let sshd = Arc::new(Sshd::new(dir.path().to_path_buf()));
        let endpoint = sshd.start(None).await.expect("sshd starts");

        // The server.
        let registry = Arc::new(HostRegistry::new());
        let tunnels = tunnels_in(dir.path(), &registry);
        let base = serve(Arc::clone(&tunnels), Arc::clone(&registry)).await;

        // The desktop app: registered with its shell, and doing what
        // `DesktopWsHost::open_tunnel` does with each order.
        let (tx, mut orders) = mpsc::channel(8);
        let shell = ShellHost {
            host_key: endpoint.host_key.clone(),
            user: endpoint.user.clone(),
            platform: Some(std::env::consts::OS.to_string()),
        };
        let device = crate::host_device::HostDevice {
            id: "0123456789abcdef0123456789abcdef".into(),
            name: "Study iMac".into(),
            model: "iMac".into(),
            kind: Some("desktop".into()),
        };
        let _registration = registry.register_on(
            tx,
            vec![CAPABILITY.to_string()],
            None,
            Some(shell.clone()),
            Some(device.clone()),
            None,
        );
        let desktop_sshd = Arc::clone(&sshd);
        let desktop_base = base.clone();
        let port = endpoint.port;
        tokio::spawn(async move {
            while let Some(order) = orders.recv().await {
                let ServerMsg::HostTunnel {
                    tunnel_id,
                    client_key,
                } = order
                else {
                    continue;
                };
                desktop_sshd.authorize(&client_key).await.unwrap();
                let mut request =
                    tunnel::ws_url(&desktop_base, &format!("{TUNNEL_PATH}?id={tunnel_id}"))
                        .into_client_request()
                        .unwrap();
                request.headers_mut().insert(
                    "sec-websocket-protocol",
                    HeaderValue::from_static(TUNNEL_PROTOCOL),
                );
                let (socket, _) = tokio_tungstenite::connect_async(request).await.unwrap();
                let tcp = tokio::net::TcpStream::connect(("127.0.0.1", port))
                    .await
                    .unwrap();
                let (reader, writer) = tcp.into_split();
                tokio::spawn(tunnel::relay(
                    socket,
                    reader,
                    writer,
                    std::future::pending(),
                ));
            }
        });

        // The server's files, before `ssh` reads them (in use, the desktop
        // registering writes them long before an agent runs `ssh desktop`).
        tunnels.files().prepare(&registry.ssh_plan()).await.unwrap();
        let files = tunnels.files().dir().to_path_buf();

        // Standing in for `codeg-cli desktop proxy --device`: a port whose
        // every connection opens the CLI end and relays to it.
        let proxy = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_port = proxy.local_addr().unwrap().port();
        let proxy_base = base.clone();
        let proxy_device = device.id.clone();
        tokio::spawn(async move {
            while let Ok((stream, _)) = proxy.accept().await {
                let base = proxy_base.clone();
                let device = proxy_device.clone();
                tokio::spawn(async move {
                    let socket = tunnel::dial_cli_end(&base, "t", Some(&device))
                        .await
                        .unwrap();
                    let (reader, writer) = stream.into_split();
                    let _ = tunnel::relay(socket, reader, writer, std::future::pending()).await;
                });
            }
        });

        let mut ssh = tokio::process::Command::new("/usr/bin/ssh");
        ssh.args(["-F", "/dev/null", "-n", "-T"])
            .args(["-o", "BatchMode=yes"])
            .args(["-o", "IdentitiesOnly=yes"])
            .args(["-o", "IdentityAgent=none"])
            .args(["-o", "StrictHostKeyChecking=yes"])
            .arg("-o")
            .arg(format!(
                "UserKnownHostsFile={}",
                files.join("known_hosts").display()
            ))
            .args(["-o", "HostKeyAlias=dodoer-01234567"])
            .args(["-o", "ConnectTimeout=10"])
            .arg("-i")
            .arg(files.join("id_ed25519"))
            .arg("-p")
            .arg(proxy_port.to_string())
            .arg("-l")
            .arg(&endpoint.user)
            .arg("127.0.0.1")
            .arg("echo through-the-tunnel")
            .stdin(std::process::Stdio::null())
            .kill_on_drop(true);
        let output = tokio::time::timeout(Duration::from_secs(60), ssh.output())
            .await
            .expect("ssh finishes")
            .expect("ssh runs");
        assert!(
            String::from_utf8_lossy(&output.stdout).contains("through-the-tunnel"),
            "ssh said: {}",
            String::from_utf8_lossy(&output.stderr)
        );

        // And the configuration the server wrote reads as `ssh` should take
        // it (`-G` prints it resolved, connecting nowhere): under the
        // device's name, and — the only device — the old name too.
        for name in ["study-imac", "desktop"] {
            let resolved = std::process::Command::new("/usr/bin/ssh")
                .arg("-G")
                .arg("-F")
                .arg(files.join("config"))
                .arg(name)
                .output()
                .unwrap();
            let resolved = String::from_utf8_lossy(&resolved.stdout).to_lowercase();
            assert!(resolved.contains(&format!("user {}", endpoint.user.to_lowercase())));
            assert!(resolved.contains("hostkeyalias dodoer-01234567"), "{name}");
            assert!(resolved.contains(&format!(
                "proxycommand '/opt/codeg/codeg-cli' desktop proxy --device {}",
                device.id
            )));
        }

        sshd.stop().await;
    }
}
