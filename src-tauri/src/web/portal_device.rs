//! Cowork fork: 门户「我的设备」的设备编号，和按设备断开长连接（#387）。
//!
//! 员工在门户里吊销一台设备以后，nginx 只能挡住它的新请求，已经开着的
//! WebSocket 不会再经过鉴权。nginx 凭设备 token 放行的请求上会带
//! `X-Cowork-Device: <12 位小写十六进制编号>`（nginx 用自己的值覆盖客户端
//! 带来的同名头），这里把带编号的长连接登记下来；cowork-web 吊销设备以后直连
//! daemon 调 `POST /api/cowork_disconnect_device`，这台设备登记着的连接就都
//! 结束，之后再带这个编号来的长连接握手回 401。
//!
//! 头只当标签用，不放开任何东西：只在已经过了主令牌检查的请求上读
//! （三个 WebSocket 路由和 `/api` 都在 `auth::require_auth` 后面）。没有这个头
//! 的部署（非 Cowork、cowork 那一半还没上线）行为和以前一样。

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};

use axum::{
    http::{header, HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::Deserialize;
use tokio_util::sync::CancellationToken;

use crate::app_error::AppCommandError;

/// 设备编号所在的请求头（nginx 发给 daemon）。
pub const DEVICE_HEADER: &str = "x-cowork-device";

/// 记住断开过的编号最多多少个，满了先丢最早的。
pub const REMEMBERED_LIMIT: usize = 1000;

/// 断开的连接用的 WebSocket 关闭代码（policy violation）和原因。
pub const CLOSE_CODE: u16 = 1008;
pub const CLOSE_REASON: &str = "device disconnected";

// 和 `web/auth.rs` 的 `CODEG_CHALLENGE` 同一个值（那边是私有常量）：客户端靠它
// 认出这是 codeg 自己回的 401。
const CODEG_CHALLENGE: &str = r#"Bearer realm="codeg""#;

/// 编号的格式：恰好 12 位小写十六进制。
pub fn is_device_id(value: &str) -> bool {
    value.len() == 12
        && value
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

/// 这个请求是哪台门户设备的：恰好一个合格式的 `X-Cowork-Device` 值才算。
/// 没有这个头是 `None`；值不合格式或者有好几个，也当作没有，打一行 `warn`
/// （不写值本身）。
pub fn device_from_headers(headers: &HeaderMap) -> Option<String> {
    let mut values = headers.get_all(DEVICE_HEADER).iter();
    let first = values.next()?;
    if values.next().is_some() {
        tracing::warn!("[portal-device] several {DEVICE_HEADER} values, ignored");
        return None;
    }
    match first.to_str() {
        Ok(value) if is_device_id(value) => Some(value.to_string()),
        _ => {
            tracing::warn!("[portal-device] malformed {DEVICE_HEADER} value, ignored");
            None
        }
    }
}

/// 断开过的编号来握手：回答是和 `web/auth.rs` 一样的 401。
#[derive(Debug)]
pub struct Refused;

impl IntoResponse for Refused {
    fn into_response(self) -> Response {
        (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, CODEG_CHALLENGE)],
            "device disconnected",
        )
            .into_response()
    }
}

#[derive(Default)]
struct Book {
    next_id: u64,
    /// 编号 → 这台设备每条登记着的连接（连接号 → 它的取消标记）。
    live: HashMap<String, HashMap<u64, CancellationToken>>,
    /// 断开过的编号，先来的在前。
    gone_order: VecDeque<String>,
    gone: HashSet<String>,
}

/// 带编号的长连接的登记表。进程里用 [`global`] 那一个；类型本身能单独建出来
/// 给测试用。
#[derive(Default)]
pub struct PortalDevices {
    book: Mutex<Book>,
}

impl PortalDevices {
    pub fn new() -> Arc<Self> {
        Arc::new(Self::default())
    }

    fn book(&self) -> MutexGuard<'_, Book> {
        self.book.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// 登记一条带编号 `device` 的连接。这个编号断开过就是 `None`（握手该回 401）。
    pub fn register(self: &Arc<Self>, device: &str) -> Option<ConnectionLease> {
        let mut book = self.book();
        if book.gone.contains(device) {
            return None;
        }
        let id = book.next_id;
        book.next_id += 1;
        let token = CancellationToken::new();
        book.live
            .entry(device.to_string())
            .or_default()
            .insert(id, token.clone());
        Some(ConnectionLease {
            token,
            entry: Some(LeaseEntry {
                devices: Arc::clone(self),
                device: device.to_string(),
                id,
            }),
        })
    }

    /// 握手时调：按请求头登记这条长连接。没有编号的给一个永远不会被断开的
    /// 标记；编号断开过的是 [`Refused`]（握手回 401）。
    pub fn admit(self: &Arc<Self>, headers: &HeaderMap) -> Result<ConnectionLease, Refused> {
        match device_from_headers(headers) {
            None => Ok(ConnectionLease::unmarked()),
            Some(device) => match self.register(&device) {
                Some(lease) => Ok(lease),
                None => {
                    tracing::info!(
                        "[portal-device] refused a connection of disconnected device {device}"
                    );
                    Err(Refused)
                }
            },
        }
    }

    /// 让编号 `device` 现在登记着的所有连接结束，返回条数；并记住这个编号，
    /// 之后再带它来的连接被拒。
    pub fn disconnect(&self, device: &str) -> usize {
        let mut book = self.book();
        let tokens = book.live.remove(device).unwrap_or_default();
        if book.gone.insert(device.to_string()) {
            book.gone_order.push_back(device.to_string());
            while book.gone_order.len() > REMEMBERED_LIMIT {
                if let Some(oldest) = book.gone_order.pop_front() {
                    book.gone.remove(&oldest);
                }
            }
        }
        drop(book);
        for token in tokens.values() {
            token.cancel();
        }
        tokens.len()
    }

    /// 这个编号是不是断开过（还记着）。
    pub fn is_disconnected(&self, device: &str) -> bool {
        self.book().gone.contains(device)
    }

    /// 现在登记着的连接条数（所有编号加起来）。
    pub fn live_count(&self) -> usize {
        self.book().live.values().map(HashMap::len).sum()
    }

    fn release(&self, device: &str, id: u64) {
        let mut book = self.book();
        if let Some(conns) = book.live.get_mut(device) {
            conns.remove(&id);
            if conns.is_empty() {
                book.live.remove(device);
            }
        }
    }
}

struct LeaseEntry {
    devices: Arc<PortalDevices>,
    device: String,
    id: u64,
}

/// 一条长连接的登记：随连接任务带走，丢掉（连接不管怎么结束）就注销。
/// 取消标记一旦取消就一直是取消，所以登记之后、任务开始跑之前被断开的，
/// 任务一开始就能看到。
pub struct ConnectionLease {
    token: CancellationToken,
    entry: Option<LeaseEntry>,
}

impl ConnectionLease {
    /// 没有设备编号的连接：永远不会被断开。
    pub fn unmarked() -> Self {
        Self {
            token: CancellationToken::new(),
            entry: None,
        }
    }

    /// 这条连接的设备编号。
    pub fn device(&self) -> Option<&str> {
        self.entry.as_ref().map(|e| e.device.as_str())
    }

    /// 已经被断开了。
    pub fn is_disconnected(&self) -> bool {
        self.token.is_cancelled()
    }

    /// 等到被断开（没编号的永远等不到）。
    pub async fn disconnected(&self) {
        self.token.cancelled().await
    }
}

impl Drop for ConnectionLease {
    fn drop(&mut self) {
        if let Some(entry) = self.entry.take() {
            entry.devices.release(&entry.device, entry.id);
        }
    }
}

static DEVICES: OnceLock<Arc<PortalDevices>> = OnceLock::new();

/// 进程里的那一个登记表。
pub fn global() -> &'static Arc<PortalDevices> {
    DEVICES.get_or_init(PortalDevices::new)
}

#[derive(Debug, Deserialize)]
pub struct DisconnectDeviceRequest {
    #[serde(default)]
    pub device: Option<String>,
}

/// `POST /api/cowork_disconnect_device`（`web/router.rs`）：cowork-web 吊销
/// 设备以后直连 daemon 调。请求本身带着设备编号头的（经 nginx 从设备来的）
/// 回 403，什么都不断开。
pub async fn cowork_disconnect_device(
    headers: HeaderMap,
    Json(body): Json<DisconnectDeviceRequest>,
) -> Result<Json<serde_json::Value>, AppCommandError> {
    disconnect_core(global(), &headers, body)
}

fn disconnect_core(
    devices: &PortalDevices,
    headers: &HeaderMap,
    body: DisconnectDeviceRequest,
) -> Result<Json<serde_json::Value>, AppCommandError> {
    if headers.contains_key(DEVICE_HEADER) {
        return Err(AppCommandError::permission_denied(
            "a device cannot disconnect devices",
        ));
    }
    let device = body
        .device
        .filter(|d| is_device_id(d))
        .ok_or_else(|| AppCommandError::invalid_input("device must be 12 lowercase hex digits"))?;
    let closed = devices.disconnect(&device);
    tracing::info!("[portal-device] disconnected device {device}: {closed} connection(s)");
    Ok(Json(serde_json::json!({ "closed": closed })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use axum::http::HeaderValue;
    use std::time::Duration;

    const A: &str = "0123456789ab";
    const B: &str = "fedcba987654";

    fn headers(values: &[&str]) -> HeaderMap {
        let mut h = HeaderMap::new();
        for v in values {
            h.append(DEVICE_HEADER, HeaderValue::from_str(v).unwrap());
        }
        h
    }

    #[test]
    fn reads_exactly_one_well_formed_device() {
        assert_eq!(device_from_headers(&headers(&[A])), Some(A.to_string()));
        assert_eq!(device_from_headers(&HeaderMap::new()), None);
        // 大写、长短不对、不是十六进制、空串
        for bad in [
            "0123456789AB",
            "0123456789a",
            "0123456789abc",
            "0123456789xg",
            "",
        ] {
            assert_eq!(device_from_headers(&headers(&[bad])), None, "{bad:?}");
        }
        // 两个以上的值，哪怕都合格式
        assert_eq!(device_from_headers(&headers(&[A, A])), None);
        assert_eq!(device_from_headers(&headers(&[A, B])), None);
    }

    #[test]
    fn disconnect_ends_only_that_device() {
        let devices = PortalDevices::new();
        let a1 = devices.admit(&headers(&[A])).ok().unwrap();
        let a2 = devices.admit(&headers(&[A])).ok().unwrap();
        let b = devices.admit(&headers(&[B])).ok().unwrap();
        let plain = devices.admit(&HeaderMap::new()).ok().unwrap();
        assert_eq!(a1.device(), Some(A));
        assert_eq!(plain.device(), None);
        assert_eq!(devices.live_count(), 3);

        assert_eq!(devices.disconnect(A), 2);
        assert!(a1.is_disconnected() && a2.is_disconnected());
        assert!(!b.is_disconnected() && !plain.is_disconnected());
        assert_eq!(devices.disconnect(A), 0, "second call closes nothing");

        drop((a1, a2, b, plain));
        assert_eq!(devices.live_count(), 0, "nothing leaks");
    }

    #[test]
    fn a_lease_dropped_without_disconnect_unregisters() {
        let devices = PortalDevices::new();
        let a = devices.register(A).unwrap();
        assert_eq!(devices.live_count(), 1);
        drop(a);
        assert_eq!(devices.live_count(), 0);
        assert_eq!(devices.disconnect(A), 0);
    }

    #[tokio::test]
    async fn disconnect_before_the_task_runs_ends_it_at_once() {
        let devices = PortalDevices::new();
        let lease = devices.register(A).unwrap();
        devices.disconnect(A);
        // 断开发生在登记之后、任务开始之前：任务一开始就看到。
        let task = tokio::spawn(async move { lease.disconnected().await });
        tokio::time::timeout(Duration::from_secs(1), task)
            .await
            .expect("ended at once")
            .unwrap();
    }

    #[tokio::test]
    async fn unmarked_is_never_disconnected() {
        let lease = ConnectionLease::unmarked();
        let waited = tokio::time::timeout(Duration::from_millis(50), lease.disconnected()).await;
        assert!(waited.is_err());
    }

    #[test]
    fn a_disconnected_device_is_refused_others_admitted() {
        let devices = PortalDevices::new();
        devices.disconnect(A);
        let refused = devices
            .admit(&headers(&[A]))
            .err()
            .expect("refused")
            .into_response();
        assert_eq!(refused.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(
            refused.headers().get(header::WWW_AUTHENTICATE).unwrap(),
            r#"Bearer realm="codeg""#
        );
        let b = devices.admit(&headers(&[B])).expect("B admitted");
        let plain = devices.admit(&HeaderMap::new()).expect("plain admitted");
        assert_eq!(b.device(), Some(B));
        assert_eq!(plain.device(), None);
        assert_eq!(devices.live_count(), 1, "only B is registered");
    }

    #[test]
    fn remembers_at_most_a_thousand_devices() {
        let devices = PortalDevices::new();
        let ids: Vec<String> = (0..=REMEMBERED_LIMIT)
            .map(|i| format!("{i:012x}"))
            .collect();
        for id in &ids {
            devices.disconnect(id);
        }
        // 第 1001 个进来时，最早的那个被丢掉。
        assert!(!devices.is_disconnected(&ids[0]));
        assert!(devices.register(&ids[0]).is_some());
        for id in &ids[1..] {
            assert!(devices.is_disconnected(id), "{id}");
        }
        assert_eq!(devices.book().gone.len(), REMEMBERED_LIMIT);
        assert_eq!(devices.book().gone_order.len(), REMEMBERED_LIMIT);
    }

    #[test]
    fn the_endpoint_checks_header_and_format() {
        let devices = PortalDevices::new();
        let _a = devices.register(A).unwrap();
        let body = |d: &str| DisconnectDeviceRequest {
            device: Some(d.to_string()),
        };
        let err = disconnect_core(&devices, &headers(&[B]), body(A)).unwrap_err();
        assert!(matches!(err.code, AppErrorCode::PermissionDenied));
        assert_eq!(devices.live_count(), 1, "a 403 disconnects nothing");
        let err = disconnect_core(&devices, &HeaderMap::new(), body("ABC")).unwrap_err();
        assert!(matches!(err.code, AppErrorCode::InvalidInput));
        let err = disconnect_core(
            &devices,
            &HeaderMap::new(),
            DisconnectDeviceRequest { device: None },
        )
        .unwrap_err();
        assert!(matches!(err.code, AppErrorCode::InvalidInput));
        let ok = disconnect_core(&devices, &HeaderMap::new(), body(A)).unwrap();
        assert_eq!(ok.0, serde_json::json!({ "closed": 1 }));
    }
}
