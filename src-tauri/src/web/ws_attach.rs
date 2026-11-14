//! WS attach protocol — Phase 1 of the Subscribe-with-Snapshot redesign.
//!
//! Replaces the legacy "subscribe to a global firehose + fetch HTTP snapshot
//! separately" flow. A client expressing interest in a specific connection
//! sends an `attach` message; the server atomically (under the SessionState
//! read lock) decides between a `snapshot` or `replay` response and
//! registers a per-connection broadcast receiver. After the response, live
//! events from that connection are delivered as `event` frames over the
//! same WebSocket.
//!
//! The legacy global `acp://event` channel remains active during Phase 1-3
//! for backward compatibility; Phase 4 retires it.

use std::sync::atomic::Ordering;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio::task::JoinHandle;

use crate::acp::internal_bus::EventBusMetrics;
use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::LiveSessionSnapshot;
use crate::acp::types::EventEnvelope;

/// Maximum number of events delivered in a single `replay` response. Larger
/// gaps fall through to a `snapshot` even when the ring buffer can satisfy
/// them — past this many events, snapshot serialization is comparable in
/// size and avoids forcing the client to apply the events one-by-one.
pub const REPLAY_BATCH_THRESHOLD: usize = 32;

/// Capacity of the per-WS-connection outbound mpsc channel. Backpressure
/// from a slow WS write naturally throttles per-subscription forwarders;
/// 64 in-flight messages is enough for short bursts without making
/// memory blow up if the client stops reading.
pub const OUTBOUND_CAPACITY: usize = 64;

// Cowork fork: the optional handshake (`crate::compat`). MUST match
// `WS_HELLO_ACTION` / `WS_SERVER_INFO_TYPE` in `src/lib/transport/constants.ts`;
// the tests below hold the serde names to these.
pub const WS_HELLO_ACTION: &str = "hello";
pub const WS_SERVER_INFO_TYPE: &str = "server_info";

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "action", rename_all = "snake_case")]
pub enum ClientMsg {
    /// Subscribe this WebSocket to a specific connection's event stream.
    /// `since_seq` allows incremental catch-up after a brief disconnect;
    /// `None` requests a full snapshot.
    Attach {
        subscription_id: String,
        connection_id: String,
        #[serde(default)]
        since_seq: Option<u64>,
    },
    /// Cancel a prior `attach` by `subscription_id`.
    Detach { subscription_id: String },
    /// Liveness check. Server replies with `pong`.
    Ping,
    /// Cowork fork: optional handshake, answered with `server_info`. Nothing
    /// requires it and nothing else changes with it: a client that never sends
    /// one (upstream codeg's desktop, iOS and Android clients) never sees a
    /// `server_info`. The fields only say who is asking (logged); all are
    /// optional and unknown ones are ignored, so a client may say more later.
    /// A server from before this ignores the frame as malformed.
    Hello {
        #[serde(default)]
        client: Option<String>,
        #[serde(default)]
        version: Option<String>,
        /// The newest server API version this client knows.
        #[serde(default)]
        api_version: Option<u32>,
    },
    /// Cowork fork: a desktop app lending this server its built-in browser
    /// (`web::host_registry`). Sent after a `server_info` naming
    /// `host_bridge_ws`; again whenever its capabilities change. Empty
    /// capabilities leave the socket registered but never asked.
    HostRegister {
        #[serde(default)]
        capabilities: Vec<String>,
        /// The app window behind this socket (`remote-workspace-<id>`), for
        /// the logs.
        #[serde(default)]
        window: Option<String>,
        /// The shell the app lends, with the `shell` capability
        /// (`host_ssh::tunnel`, `docs/host-ssh.md` 5.2). Sent only to a
        /// server whose `server_info` names `host_ssh`.
        #[serde(default)]
        shell: Option<crate::host_ssh::tunnel::ShellHost>,
    },
    /// Cowork fork: a host's answer to `host_call` — the host bridge's
    /// outcome for that call, as `host_bridge::dispatch` returns it.
    HostResult {
        call_id: u64,
        #[serde(default)]
        outcome: serde_json::Value,
    },
    /// Cowork fork: the host's window got focus, so it is the one the person
    /// is in front of — the next call goes to it.
    HostFocus,
    /// Cowork fork: the host could not open the tunnel `host_tunnel` asked
    /// for, and why. A tunnel it opens it dials instead (`/ws/host-tunnel`).
    HostTunnelResult {
        tunnel_id: String,
        #[serde(default)]
        error: Option<String>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ServerMsg {
    /// Initial state for `attach` (cold start, large gap, or cursor invalid).
    /// `event_seq` is the high-water mark; subsequent `event` frames carry
    /// `seq > event_seq`. The snapshot is `Box`'d so the enum variant size
    /// doesn't dominate every other (small) variant.
    Snapshot {
        subscription_id: String,
        connection_id: String,
        snapshot: Box<LiveSessionSnapshot>,
        event_seq: u64,
    },
    /// Batched catch-up for a small gap. `high_water_seq` is the largest
    /// seq in `events`; subsequent `event` frames carry `seq > high_water_seq`.
    Replay {
        subscription_id: String,
        connection_id: String,
        events: Vec<Arc<EventEnvelope>>,
        high_water_seq: u64,
    },
    /// Live event delivered after the initial Snapshot/Replay frame.
    Event {
        subscription_id: String,
        envelope: Arc<EventEnvelope>,
    },
    /// Subscription was terminated by the server. `reason` is a stable code
    /// the client maps to UX (re-attach vs. drop the conversation).
    Detached {
        subscription_id: String,
        reason: DetachReason,
    },
    /// Liveness response.
    Pong,
    /// Cowork fork: answer to `hello`. The same contract `/api/health`
    /// carries (`crate::compat`), flattened next to `type`.
    ServerInfo(crate::compat::ServerInfo),
    /// Cowork fork: a browser-tool call for the desktop app registered on
    /// this socket (`web::host_registry`). Answered by `host_result` with the
    /// same `call_id`.
    HostCall {
        call_id: u64,
        call: crate::host_bridge::BridgeCall,
    },
    /// Cowork fork: a tunnel to the shell the host lends (`host_ssh`): let
    /// `client_key` in, then dial `/ws/host-tunnel?id=<tunnel_id>` and join
    /// it to the SSH service; or answer `host_tunnel_result` with why not.
    HostTunnel {
        tunnel_id: String,
        client_key: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DetachReason {
    /// `connection_id` is unknown to the manager (possibly GC'd, possibly
    /// never existed). Client should treat this as a terminal state for
    /// the conversation.
    ConnectionGone,
    /// The per-connection broadcast channel dropped events because this
    /// subscriber couldn't keep up. Client must re-attach with its
    /// `lastAppliedSeq` to resync.
    Lagged,
    /// Server is shutting down. Reconnect after the next handshake.
    ServerShutdown,
}

/// Decision returned by the attach handler describing what frame to send
/// back to the client and which `broadcast::Receiver` to forward live
/// events from.
pub struct AttachOutcome {
    pub initial_msg: ServerMsg,
    pub receiver: tokio::sync::broadcast::Receiver<Arc<EventEnvelope>>,
}

/// Decide-and-subscribe under a single `SessionState` read lock. The
/// returned receiver is registered before the lock releases, so any event
/// fired after this function returns is delivered (no race against
/// `emit_with_state`'s write lock).
///
/// `metrics` records which response shape was returned (cold snapshot vs.
/// resumed replay vs. snapshot fallback) so operators can spot when the
/// `REPLAY_BATCH_THRESHOLD` / ring-buffer caps need tuning.
pub async fn handle_attach(
    manager: &ConnectionManager,
    metrics: &EventBusMetrics,
    subscription_id: String,
    connection_id: String,
    since_seq: Option<u64>,
) -> Result<AttachOutcome, DetachReason> {
    let state_arc = manager
        .get_state(&connection_id)
        .await
        .ok_or(DetachReason::ConnectionGone)?;

    let s = state_arc.read().await;

    // Decide response shape. Order of checks matters:
    //   - explicit None → snapshot (fresh attach; client has no state yet)
    //   - cursor at or past head → snapshot anyway, defends against client
    //     bugs where lastAppliedSeq was advanced past an event we never
    //     actually broadcast (not currently possible, but cheap to guard)
    //   - cursor in ring buffer with small gap → replay
    //   - cursor in ring buffer with large gap → snapshot (cheaper)
    //   - cursor older than ring buffer → snapshot (only choice)
    let snapshot_msg = || ServerMsg::Snapshot {
        subscription_id: subscription_id.clone(),
        connection_id: connection_id.clone(),
        snapshot: Box::new(s.to_snapshot()),
        event_seq: s.event_seq,
    };

    let initial_msg = match since_seq {
        None => {
            metrics.snapshot_cold_count.fetch_add(1, Ordering::Relaxed);
            snapshot_msg()
        }
        Some(cursor) if cursor >= s.event_seq => {
            // Cursor at-or-past head — treat as fresh attach. Doesn't bump
            // `snapshot_fallback_count` because there's no gap-too-large
            // semantic; this is just a defensive equivalent of cold start.
            metrics.snapshot_cold_count.fetch_add(1, Ordering::Relaxed);
            snapshot_msg()
        }
        Some(cursor) => match s.recent_events_after(cursor) {
            Some(events) if events.len() <= REPLAY_BATCH_THRESHOLD && !events.is_empty() => {
                let event_count = events.len() as u64;
                let high_water_seq = events.last().expect("non-empty checked above").seq;
                metrics.replay_count.fetch_add(1, Ordering::Relaxed);
                metrics
                    .replay_event_total
                    .fetch_add(event_count, Ordering::Relaxed);
                ServerMsg::Replay {
                    subscription_id: subscription_id.clone(),
                    connection_id: connection_id.clone(),
                    events,
                    high_water_seq,
                }
            }
            // Either too many to batch, or buffer doesn't cover the cursor.
            _ => {
                metrics
                    .snapshot_fallback_count
                    .fetch_add(1, Ordering::Relaxed);
                snapshot_msg()
            }
        },
    };

    let receiver = s.event_stream().subscribe();
    drop(s);

    Ok(AttachOutcome {
        initial_msg,
        receiver,
    })
}

/// Spawn a forwarding task that drains the per-connection broadcast receiver
/// and sends `Event` frames to the shared outbound channel. Exits on
/// receiver close (connection went away) or `Lagged` (slow consumer); in
/// both cases sends a `Detached` frame so the client knows to re-attach.
///
/// `cleanup_tx` carries `(subscription_id, epoch)` back to the WS main loop
/// on every self-exit path so the loop can drop the now-completed
/// `JoinHandle` from its `subscriptions` map. The `epoch` is critical: a
/// stale signal arriving after the client has re-attached (which replaces
/// the handle) would otherwise orphan the fresh forwarder. The main loop
/// only removes when the stored epoch matches the signal's epoch — re-attach
/// stamps a new epoch so old signals become no-ops. Without epoch matching,
/// `JoinHandle::is_finished()` is racy on multi-threaded runtimes (the
/// runtime may not have updated the JoinHandle slot yet when the cleanup
/// signal is consumed).
///
/// Send is `try_send` so a saturated cleanup channel never blocks the
/// exiting task; the socket-close `subscriptions.drain()` is the safety net.
///
/// `metrics` records `Lagged` exits so operators can correlate attach
/// re-attachment storms with per-connection broadcast pressure.
pub fn spawn_forwarder(
    subscription_id: String,
    epoch: u64,
    metrics: Arc<EventBusMetrics>,
    mut receiver: tokio::sync::broadcast::Receiver<Arc<EventEnvelope>>,
    outbound: mpsc::Sender<ServerMsg>,
    cleanup_tx: mpsc::Sender<(String, u64)>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let signal_cleanup = || {
            let _ = cleanup_tx.try_send((subscription_id.clone(), epoch));
        };
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    let msg = ServerMsg::Event {
                        subscription_id: subscription_id.clone(),
                        envelope,
                    };
                    if outbound.send(msg).await.is_err() {
                        // WS closed; nothing to forward to. Map cleanup
                        // is handled by the main loop's drain on exit,
                        // but the signal is harmless either way.
                        signal_cleanup();
                        return;
                    }
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    tracing::warn!(
                        "[WS attach] subscription {} lagged ({} events dropped); detaching",
                        subscription_id, n
                    );
                    metrics
                        .forwarder_lagged_count
                        .fetch_add(1, Ordering::Relaxed);
                    let _ = outbound
                        .send(ServerMsg::Detached {
                            subscription_id: subscription_id.clone(),
                            reason: DetachReason::Lagged,
                        })
                        .await;
                    signal_cleanup();
                    return;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    let _ = outbound
                        .send(ServerMsg::Detached {
                            subscription_id: subscription_id.clone(),
                            reason: DetachReason::ConnectionGone,
                        })
                        .await;
                    signal_cleanup();
                    return;
                }
            }
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hello_parses_with_any_subset_of_fields() {
        for text in [
            r#"{"action":"hello"}"#,
            r#"{"action":"hello","client":"dodoer-desktop","version":"1.2.5","api_version":1}"#,
            r#"{"action":"hello","client":"x","some_future_field":{"a":1}}"#,
        ] {
            let msg: ClientMsg = serde_json::from_str(text).unwrap();
            assert!(matches!(msg, ClientMsg::Hello { .. }), "{text}");
        }
        let hello = format!(r#"{{"action":"{WS_HELLO_ACTION}"}}"#);
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(&hello).unwrap(),
            ClientMsg::Hello { .. }
        ));
    }

    #[test]
    fn upstream_client_messages_parse_as_before() {
        let attach: ClientMsg = serde_json::from_str(
            r#"{"action":"attach","subscription_id":"s","connection_id":"c","since_seq":3}"#,
        )
        .unwrap();
        assert!(matches!(
            attach,
            ClientMsg::Attach {
                since_seq: Some(3),
                ..
            }
        ));
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(r#"{"action":"ping"}"#).unwrap(),
            ClientMsg::Ping
        ));
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(r#"{"action":"detach","subscription_id":"s"}"#)
                .unwrap(),
            ClientMsg::Detach { .. }
        ));
    }

    #[test]
    fn host_messages_parse_and_serialize_as_documented() {
        let register: ClientMsg = serde_json::from_str(
            r#"{"action":"host_register","capabilities":["browser"],"window":"remote-workspace-3"}"#,
        )
        .unwrap();
        assert!(matches!(
            register,
            ClientMsg::HostRegister { ref capabilities, window: Some(ref w), shell: None }
                if capabilities == &["browser"] && w == "remote-workspace-3"
        ));
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(r#"{"action":"host_register"}"#).unwrap(),
            ClientMsg::HostRegister { ref capabilities, window: None, shell: None }
                if capabilities.is_empty()
        ));
        let shell: ClientMsg = serde_json::from_str(
            r#"{"action":"host_register","capabilities":["browser","shell"],"window":"remote-workspace-3",
                "shell":{"host_key":"ssh-ed25519 AAAA","user":"me","platform":"macos"}}"#,
        )
        .unwrap();
        assert!(matches!(
            shell,
            ClientMsg::HostRegister { shell: Some(ref s), .. }
                if s.host_key == "ssh-ed25519 AAAA" && s.user == "me"
        ));
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(
                r#"{"action":"host_tunnel_result","tunnel_id":"t1","error":"not lent"}"#
            )
            .unwrap(),
            ClientMsg::HostTunnelResult { ref tunnel_id, error: Some(ref e) }
                if tunnel_id == "t1" && e == "not lent"
        ));
        assert_eq!(
            serde_json::to_value(ServerMsg::HostTunnel {
                tunnel_id: "t1".into(),
                client_key: "ssh-ed25519 BBBB".into(),
            })
            .unwrap(),
            serde_json::json!({"type": "host_tunnel", "tunnel_id": "t1", "client_key": "ssh-ed25519 BBBB"})
        );
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(
                r#"{"action":"host_result","call_id":7,"outcome":{"tabs":[]}}"#
            )
            .unwrap(),
            ClientMsg::HostResult { call_id: 7, .. }
        ));
        assert!(matches!(
            serde_json::from_str::<ClientMsg>(r#"{"action":"host_focus"}"#).unwrap(),
            ClientMsg::HostFocus
        ));
        let call = ServerMsg::HostCall {
            call_id: 7,
            call: crate::host_bridge::BridgeCall::Browser(
                crate::host_bridge::BrowserCall::Snapshot {
                    tab_id: "t1".into(),
                    max_chars: None,
                },
            ),
        };
        assert_eq!(
            serde_json::to_value(call).unwrap(),
            serde_json::json!({
                "type": "host_call",
                "call_id": 7,
                "call": {
                    "tool": "browser",
                    "call": {"method": "snapshot", "args": {"tab_id": "t1", "max_chars": null}}
                }
            })
        );
    }

    #[test]
    fn server_info_frame_is_the_contract_next_to_its_type() {
        let frame =
            serde_json::to_value(ServerMsg::ServerInfo(crate::compat::server_info())).unwrap();
        let mut expected = crate::compat::health_fields();
        expected.insert("type".into(), WS_SERVER_INFO_TYPE.into());
        assert_eq!(frame, serde_json::Value::Object(expected));
        assert_eq!(
            serde_json::to_value(ServerMsg::Pong).unwrap(),
            serde_json::json!({ "type": "pong" })
        );
    }
}
