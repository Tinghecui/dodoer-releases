use std::sync::atomic::{AtomicBool, Ordering};
use tokio::sync::Notify;

/// Shutdown coordinator for the embedded web server. Combines a sticky
/// `AtomicBool` with a `Notify` so that:
///
/// - Currently awaiting tasks wake up promptly (`Notify`)
/// - Tasks that *start* awaiting after shutdown was triggered see the
///   flag and exit immediately, instead of waiting forever for a signal
///   that already fired (`AtomicBool`)
///
/// Without the sticky flag, a WebSocket handshake that completes during
/// the narrow window between `notify_waiters()` and the listener being
/// torn down would create a fresh `notified()` future after the wakeup
/// already happened — leaking an orphan task into the runtime.
pub struct ShutdownSignal {
    flag: AtomicBool,
    notify: Notify,
}

impl Default for ShutdownSignal {
    fn default() -> Self {
        Self::new()
    }
}

impl ShutdownSignal {
    pub fn new() -> Self {
        Self {
            flag: AtomicBool::new(false),
            notify: Notify::new(),
        }
    }

    /// Set the sticky flag and wake all currently waiting `wait()` futures.
    pub fn trigger(&self) {
        self.flag.store(true, Ordering::Release);
        self.notify.notify_waiters();
    }

    /// Clear the flag for the next server cycle. Must be called before
    /// any task subscribes to `wait()` for the new cycle, otherwise that
    /// task would see the leftover signal from the previous cycle.
    pub fn reset(&self) {
        self.flag.store(false, Ordering::Release);
    }

    pub fn is_triggered(&self) -> bool {
        self.flag.load(Ordering::Acquire)
    }

    /// Resolves when shutdown is triggered. Returns immediately if the
    /// flag is already set. Race-safe across `trigger()` happening at
    /// any point: the `notified()` future is created *before* the second
    /// flag check, so a `trigger()` interleaved between the two checks
    /// still wakes us via the future.
    pub async fn wait(&self) {
        if self.is_triggered() {
            return;
        }
        let notified = self.notify.notified();
        if self.is_triggered() {
            return;
        }
        notified.await;
    }
}

/// 等 stdin 关闭的通知（`CODEG_EXIT_ON_STDIN_EOF=1` 时读 stdin 的线程发来）。
/// 收到发来的值就返回；`None`（没设这个变量），或者发送端没发就被丢掉了，
/// 就永远不返回——那样只剩停机信号能让 server 停下。
pub async fn stdin_closed(rx: Option<tokio::sync::oneshot::Receiver<()>>) {
    if let Some(rx) = rx {
        if rx.await.is_ok() {
            return;
        }
    }
    std::future::pending::<()>().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn stdin_closed_returns_once_notified() {
        let (tx, rx) = tokio::sync::oneshot::channel();
        tx.send(()).unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(1), stdin_closed(Some(rx)))
                .await
                .is_ok(),
            "stdin_closed did not return after the notification"
        );
    }

    #[tokio::test]
    async fn stdin_closed_never_returns_without_a_receiver() {
        assert!(
            tokio::time::timeout(Duration::from_millis(200), stdin_closed(None))
                .await
                .is_err(),
            "stdin_closed returned with no receiver"
        );
    }

    #[tokio::test]
    async fn stdin_closed_never_returns_when_the_sender_is_dropped() {
        let (tx, rx) = tokio::sync::oneshot::channel::<()>();
        drop(tx);
        assert!(
            tokio::time::timeout(Duration::from_millis(200), stdin_closed(Some(rx)))
                .await
                .is_err(),
            "stdin_closed returned although nothing was sent"
        );
    }
}
