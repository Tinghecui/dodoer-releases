//! The browser tunnel: how a remote-workspace window's built-in browser
//! reaches this host.
//!
//! A desktop app connected to this codeg-server renders pages locally, but the
//! addresses those pages come from — `localhost:3000` printed by an agent
//! here, a container at `172.17.0.2` — only exist from this host's side. The
//! desktop runs a SOCKS5 listener for a browser profile of its own and carries
//! every connection that profile makes over one WebSocket to this endpoint,
//! which connects to the destination from here. The page is then exactly the
//! page it would be on this host, with nothing rewritten in between: the
//! tunnel moves TCP bytes, and TLS, WebSockets and HTTP/2 go through
//! untouched.
//!
//! One WebSocket, many streams (`frame`); per-stream flow control and
//! half-close (`pump`); where a stream may go (`policy`). The endpoint sits
//! behind codeg's token like `/ws/events`.

pub mod frame;
pub mod policy;
pub mod pump;

use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Extension;
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;

use self::frame::{CloseCode, Frame, TUNNEL_PROTOCOL};
use self::policy::TunnelPolicy;
use self::pump::{pump, StreamEvent};
use super::portal_device::{self, ConnectionLease};
use super::shutdown::ShutdownSignal;

/// Frames waiting for the WebSocket: control frames and at most a window of
/// data per stream (the pumps wait for credit), so this only bounds bursts.
const OUTGOING_QUEUE: usize = 256;

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Extension(shutdown): Extension<Arc<ShutdownSignal>>,
) -> Response {
    let policy = TunnelPolicy::current();
    if policy == TunnelPolicy::Off {
        return (StatusCode::FORBIDDEN, "the browser tunnel is off on this server").into_response();
    }
    // Cowork fork（#387）：门户设备的隧道在握手时登记（`web::portal_device`），
    // 登记随连接任务带走；断开过的设备在这里就回 401，不升级。
    let lease = match portal_device::global().admit(&headers) {
        Ok(lease) => lease,
        Err(refused) => return refused.into_response(),
    };
    ws.protocols([TUNNEL_PROTOCOL])
        .on_upgrade(move |socket| session(socket, policy, shutdown, lease))
}

async fn session(
    socket: WebSocket,
    policy: TunnelPolicy,
    shutdown: Arc<ShutdownSignal>,
    lease: ConnectionLease,
) {
    // Cowork fork（#387）：登记之后、任务开始之前就被断开的，一开始就结束。
    if shutdown.is_triggered() || lease.is_disconnected() {
        return;
    }
    let (mut sink, mut incoming) = socket.split();
    let (frames, mut outgoing) = mpsc::channel::<Frame>(OUTGOING_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(frame) = outgoing.recv().await {
            if sink.send(Message::Binary(frame.encode().into())).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    // Open streams, by id: where the peer's frames for each one go.
    let mut streams: HashMap<u32, mpsc::UnboundedSender<StreamEvent>> = HashMap::new();
    let (ended, mut ended_rx) = mpsc::unbounded_channel::<u32>();

    loop {
        tokio::select! {
            _ = shutdown.wait() => break,
            // Cowork fork（#387）：门户吊销了这台设备。
            _ = lease.disconnected() => {
                tracing::info!("[browser-tunnel] closed: its portal device was disconnected");
                break;
            }
            Some(id) = ended_rx.recv() => {
                streams.remove(&id);
            }
            message = incoming.next() => {
                let bytes = match message {
                    Some(Ok(Message::Binary(bytes))) => bytes,
                    // axum answers pings itself; nothing else is expected.
                    Some(Ok(Message::Ping(_) | Message::Pong(_))) => continue,
                    Some(Ok(Message::Text(_))) => {
                        tracing::debug!("[browser-tunnel] text message; closing");
                        break;
                    }
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                };
                let frame = match Frame::decode(&bytes) {
                    Ok(frame) => frame,
                    Err(err) => {
                        tracing::debug!("[browser-tunnel] {err}; closing");
                        break;
                    }
                };
                match frame {
                    Frame::Open { stream: id, host, port } => {
                        if id == 0 || streams.contains_key(&id) || host.is_empty() || port == 0 {
                            let refusal = frames.send(Frame::Close {
                                stream: id,
                                code: CloseCode::BadRequest,
                                message: "not a stream that can be opened".into(),
                            });
                            // Cowork fork（#387）：设备不读时队列是满的，这里会一直等；
                            // 等的时候被门户断开也要马上结束。
                            tokio::select! {
                                _ = refusal => {}
                                _ = lease.disconnected() => {
                                    tracing::info!("[browser-tunnel] closed: its portal device was disconnected");
                                    break;
                                }
                            }
                            continue;
                        }
                        let (to_stream, events) = mpsc::unbounded_channel();
                        streams.insert(id, to_stream);
                        tokio::spawn(open_stream(
                            id,
                            host,
                            port,
                            policy,
                            events,
                            frames.clone(),
                            ended.clone(),
                        ));
                    }
                    // Only this side answers an OPEN.
                    Frame::Opened { .. } => {
                        tracing::debug!("[browser-tunnel] peer sent OPENED; closing");
                        break;
                    }
                    frame => {
                        let id = frame.stream();
                        // A stream that is not open any more (it ended while
                        // this frame was on its way) has nothing to say.
                        if let (Some(to_stream), Some(event)) =
                            (streams.get(&id), StreamEvent::from_frame(frame))
                        {
                            let _ = to_stream.send(event);
                        }
                    }
                }
            }
        }
    }
    // Every pump sees its event channel close and lets its connection go.
    drop(streams);
    drop(frames);
    // Cowork fork（#387）：被门户断开的（之前或者在等写的那一半收尾时），排队的
    // 数据不再送给这台设备，也不等它读：设备不读时写入会一直堵着。直接停掉写的
    // 那一半，socket 随之关掉。
    let mut writer = writer;
    tokio::select! {
        _ = &mut writer => {}
        _ = lease.disconnected() => {
            writer.abort();
            let _ = writer.await;
        }
    }
}

/// Connect stream `id` and pump it until it is over. The peer does not send
/// data before OPENED (its SOCKS client waits for the reply), so anything
/// but a CLOSE while connecting is a broken peer.
async fn open_stream(
    id: u32,
    host: String,
    port: u16,
    policy: TunnelPolicy,
    mut events: mpsc::UnboundedReceiver<StreamEvent>,
    frames: mpsc::Sender<Frame>,
    ended: mpsc::UnboundedSender<u32>,
) {
    let connected = tokio::select! {
        result = policy::dial(&host, port, policy) => Some(result),
        event = events.recv() => {
            if !matches!(event, Some(StreamEvent::Close(..)) | None) {
                let _ = frames
                    .send(Frame::Close {
                        stream: id,
                        code: CloseCode::Protocol,
                        message: "sent before the stream was open".into(),
                    })
                    .await;
            }
            None
        }
    };
    match connected {
        Some(Ok(connection)) => {
            if frames.send(Frame::Opened { stream: id }).await.is_ok() {
                let end = pump(connection, id, events, frames).await;
                tracing::debug!("[browser-tunnel] stream {id} to {host}:{port} ended: {end:?}");
            }
        }
        Some(Err((code, message))) => {
            tracing::debug!("[browser-tunnel] stream {id} to {host}:{port}: {message}");
            let _ = frames.send(Frame::Close { stream: id, code, message }).await;
        }
        None => {}
    }
    let _ = ended.send(id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    use axum::routing::get;
    use axum::Router;
    use tokio_tungstenite::tungstenite::client::IntoClientRequest;
    use tokio_tungstenite::tungstenite::http::HeaderValue;
    use tokio_tungstenite::tungstenite::Message as WsMessage;

    use super::frame::TUNNEL_PATH;
    use crate::web::portal_device;

    type Client = tokio_tungstenite::WebSocketStream<
        tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
    >;

    /// 只有隧道这一个端点的服务器。
    async fn serve() -> String {
        let app = Router::new().route(
            TUNNEL_PATH,
            get(ws_handler).layer(Extension(Arc::new(ShutdownSignal::new()))),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        format!("ws://{address}{TUNNEL_PATH}")
    }

    /// 带着门户设备编号 `device`（没有就不带）拨隧道：接上的 socket，或者被回的状态码。
    async fn dial(url: &str, device: Option<&'static str>) -> Result<Client, u16> {
        let mut request = url.into_client_request().unwrap();
        let headers = request.headers_mut();
        headers.insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(TUNNEL_PROTOCOL),
        );
        if let Some(device) = device {
            headers.insert(
                portal_device::DEVICE_HEADER,
                HeaderValue::from_static(device),
            );
        }
        match tokio_tungstenite::connect_async(request).await {
            Ok((socket, _)) => Ok(socket),
            Err(tokio_tungstenite::tungstenite::Error::Http(response)) => {
                Err(response.status().as_u16())
            }
            Err(e) => panic!("dial: {e}"),
        }
    }

    /// 还开着：发 ping 收得到 pong。
    async fn alive(socket: &mut Client) -> bool {
        if socket
            .send(WsMessage::Ping(b"hi".to_vec().into()))
            .await
            .is_err()
        {
            return false;
        }
        matches!(
            tokio::time::timeout(Duration::from_secs(3), socket.next()).await,
            Ok(Some(Ok(WsMessage::Pong(_))))
        )
    }

    /// Cowork fork（#387）：门户吊销一台设备，它的浏览器隧道 3 秒内结束，算进
    /// 断开的条数；之后它再来握手回 401。别的设备、没编号的照常。
    #[tokio::test]
    async fn disconnecting_a_portal_device_ends_its_tunnel() {
        const A: &str = "b7a000000a01";
        const B: &str = "b7a000000b02";
        let url = serve().await;
        let mut a = dial(&url, Some(A)).await.expect("A connects");
        let mut b = dial(&url, Some(B)).await.expect("B connects");
        let mut plain = dial(&url, None).await.expect("unmarked connects");
        assert!(alive(&mut a).await);

        assert_eq!(portal_device::global().disconnect(A), 1);
        tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                match a.next().await {
                    None | Some(Err(_)) | Some(Ok(WsMessage::Close(_))) => return,
                    Some(Ok(_)) => {}
                }
            }
        })
        .await
        .expect("A's tunnel ended within 3 s");

        assert!(alive(&mut b).await, "B is still connected");
        assert!(
            alive(&mut plain).await,
            "the unmarked one is still connected"
        );

        assert_eq!(dial(&url, Some(A)).await.err(), Some(401));
        assert!(dial(&url, Some(B)).await.is_ok());
        assert!(dial(&url, None).await.is_ok());
    }

    /// 一台带门户设备编号 `device`、接收缓冲很小的设备：开了一堆流、拉的是一直往外灌
    /// 数据的本机服务，然后一个字节都不读，直到服务器的发送缓冲也满了、写入堵住。
    /// 回登记表（隧道用它自己的）、隧道任务结束时收得到通知的那一头和设备的 socket。
    async fn a_device_that_stopped_reading(
        device: &'static str,
    ) -> (
        Arc<portal_device::PortalDevices>,
        mpsc::UnboundedReceiver<()>,
        tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>,
    ) {
        const STREAMS: u32 = 64;
        // 一直往外灌数据的本机服务。
        let flood = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let flood_port = flood.local_addr().unwrap().port();
        tokio::spawn(async move {
            while let Ok((mut conn, _)) = flood.accept().await {
                tokio::spawn(async move {
                    use tokio::io::AsyncWriteExt;
                    let chunk = vec![7u8; 64 * 1024];
                    while conn.write_all(&chunk).await.is_ok() {}
                });
            }
        });

        // 只有隧道一个端点，用自己的登记表；隧道任务结束时通知测试。
        let devices = portal_device::PortalDevices::new();
        let (ended_tx, ended_rx) = mpsc::unbounded_channel::<()>();
        let handler = {
            let devices = devices.clone();
            move |ws: WebSocketUpgrade, headers: HeaderMap| {
                let devices = devices.clone();
                let ended_tx = ended_tx.clone();
                async move {
                    let lease = match devices.admit(&headers) {
                        Ok(lease) => lease,
                        Err(refused) => return refused.into_response(),
                    };
                    let shutdown = Arc::new(ShutdownSignal::new());
                    ws.protocols([TUNNEL_PROTOCOL])
                        .on_upgrade(move |socket| async move {
                            session(socket, TunnelPolicy::All, shutdown, lease).await;
                            let _ = ended_tx.send(());
                        })
                }
            }
        };
        let app = Router::new().route(TUNNEL_PATH, get(handler));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let socket = tokio::net::TcpSocket::new_v4().unwrap();
        socket.set_recv_buffer_size(4096).unwrap();
        let stream = socket.connect(address).await.unwrap();
        let mut request = format!("ws://{address}{TUNNEL_PATH}")
            .into_client_request()
            .unwrap();
        request.headers_mut().insert(
            "sec-websocket-protocol",
            HeaderValue::from_static(TUNNEL_PROTOCOL),
        );
        request.headers_mut().insert(
            portal_device::DEVICE_HEADER,
            HeaderValue::from_static(device),
        );
        let (mut client, _) = tokio_tungstenite::client_async(request, stream)
            .await
            .expect("the device connects");
        for stream in 1..=STREAMS {
            let open = Frame::Open {
                stream,
                host: "127.0.0.1".into(),
                port: flood_port,
            };
            client
                .send(WsMessage::Binary(open.encode().into()))
                .await
                .unwrap();
        }
        // 等数据灌满：设备的接收缓冲、服务器的发送缓冲都满了，写入堵住。
        tokio::time::sleep(Duration::from_millis(1500)).await;
        (devices, ended_rx, client)
    }

    /// 断开 `device`，它的隧道任务要在 3 秒内结束，登记表随之清空。
    async fn disconnect_and_expect_the_end(
        devices: &portal_device::PortalDevices,
        ended_rx: &mut mpsc::UnboundedReceiver<()>,
        device: &str,
        why: &str,
    ) {
        assert_eq!(devices.disconnect(device), 1, "{why}: counted");
        tokio::time::timeout(Duration::from_secs(3), ended_rx.recv())
            .await
            .unwrap_or_else(|_| panic!("{why}: the tunnel ended within 3 s"));
        assert_eq!(devices.live_count(), 0, "{why}: nothing left registered");
    }

    /// Cowork fork（#387）：隧道正在往设备送数据、设备却不读了（写入堵住）时
    /// 被断开，隧道照样 3 秒内结束，不等排队的数据送完。
    #[tokio::test]
    async fn a_disconnected_tunnel_ends_even_when_the_device_stops_reading() {
        const A: &str = "b7a000000c03";
        let (devices, mut ended_rx, client) = a_device_that_stopped_reading(A).await;
        disconnect_and_expect_the_end(&devices, &mut ended_rx, A, "not reading").await;
        drop(client);
    }

    /// Cowork fork（#387）：发送队列满了以后设备再发一个打不开的流（服务器要回它
    /// 一个关闭帧，可队列塞不进去），之后被断开，隧道照样 3 秒内结束。
    #[tokio::test]
    async fn a_disconnected_tunnel_ends_while_answering_a_bad_open() {
        const A: &str = "b7a000000d04";
        let (devices, mut ended_rx, mut client) = a_device_that_stopped_reading(A).await;
        // 流号 0 打不开，服务器要回关闭帧；再发几个，保证有一个卡在排队上。
        for _ in 0..8 {
            let open = Frame::Open {
                stream: 0,
                host: "127.0.0.1".into(),
                port: 1,
            };
            client
                .send(WsMessage::Binary(open.encode().into()))
                .await
                .unwrap();
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
        disconnect_and_expect_the_end(&devices, &mut ended_rx, A, "bad open").await;
        drop(client);
    }

    /// Cowork fork（#387）：设备不读、写入堵住时它先发了关闭帧（隧道在等写的那一半
    /// 收尾），之后才被断开，隧道照样 3 秒内结束。
    #[tokio::test]
    async fn a_disconnected_tunnel_ends_after_the_device_said_goodbye() {
        const A: &str = "b7a000000e05";
        let (devices, mut ended_rx, mut client) = a_device_that_stopped_reading(A).await;
        client.send(WsMessage::Close(None)).await.unwrap();
        tokio::time::sleep(Duration::from_millis(500)).await;
        assert!(
            ended_rx.try_recv().is_err(),
            "the tunnel is still waiting for its writer"
        );
        disconnect_and_expect_the_end(&devices, &mut ended_rx, A, "after close").await;
        drop(client);
    }
}
