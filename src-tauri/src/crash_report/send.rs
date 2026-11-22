//! Sending: after the start has turned earlier runs' records into reports,
//! find a saved remote connection whose server reports to Sentry (its
//! `cowork_info` names a web DSN) and forward each report through that
//! server's `/api/telemetry_envelope`, with the call the remote windows'
//! proxy makes (`remote_proxy::call_api`: the same token, custom headers and
//! redirect rules). When none does, the app's own daemon (the `codeg-server`
//! child, `local_daemon`) is asked the same way: a release build reports
//! with the DSNs built into it, unless diagnostics are off.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, OnceLock};
use std::time::Duration;

use sea_orm::DatabaseConnection;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use tokio::sync::Notify;

use super::envelope::{self, Target};
use super::store;
use crate::app_error::{AppCommandError, AppErrorCode};
use crate::commands::remote_proxy::{call_api, RemoteProxyState};
use crate::db::service::remote_workspace_connection_service;
use crate::db::AppDatabase;
use crate::models::RemoteWorkspaceConnectionInfo;

/// After the start, so the windows and the network come up first.
const FIRST_TRY: Duration = Duration::from_secs(30);
/// While reports are left, tried again this often.
const RETRY_EVERY: Duration = Duration::from_secs(10 * 60);
/// Each call to a server.
const CALL_TIMEOUT_MS: u64 = 15_000;

/// The app, for [`wake`] to start the sending with.
///
/// Behind an `Arc` and never dropped: `AppHandle::clone`/`drop` off the main
/// thread race `tao`'s non-atomic `Rc<EventLoopRunner>` (see
/// `web::event_bridge::EventEmitter`), and [`wake`] runs on whatever thread
/// queued the report. The one clone is taken on the main thread, in `start`.
static APP: OnceLock<Arc<AppHandle>> = OnceLock::new();
/// The sending loop is running (it waits for [`wake`] once nothing is left).
static RUNNING: AtomicBool = AtomicBool::new(false);
/// A report was queued: send now rather than at the next retry.
static WAKE: Notify = Notify::const_new();

pub fn remember(app: &AppHandle) -> Arc<AppHandle> {
    Arc::clone(APP.get_or_init(|| Arc::new(app.clone())))
}

/// Start the sending: earlier runs' records are turned into reports first,
/// then what is pending goes out, again every [`RETRY_EVERY`] while some is
/// left. Once nothing is, the loop waits for [`wake`] (a report queued in this
/// run), so that one goes out within a minute, not at the next start. It ends
/// when the switch is turned off or the quit has finished.
pub fn spawn(app: Arc<AppHandle>) {
    if RUNNING.swap(true, Ordering::SeqCst) {
        WAKE.notify_one();
        return;
    }
    tauri::async_runtime::spawn(async move {
        let _ = tauri::async_runtime::spawn_blocking(super::collect_previous).await;
        tokio::time::sleep(FIRST_TRY).await;
        while super::enabled() && !super::stopped() {
            if send_pending(&app).await {
                WAKE.notified().await;
            } else {
                let _ = tokio::time::timeout(RETRY_EVERY, WAKE.notified()).await;
            }
        }
        RUNNING.store(false, Ordering::SeqCst);
    });
}

/// A report was just queued (`push_update`): send it in this run.
pub fn wake() {
    if RUNNING.load(Ordering::SeqCst) {
        WAKE.notify_one();
    } else if let Some(app) = APP.get() {
        spawn(Arc::clone(app));
    }
}

/// What became of one report.
#[derive(Debug, PartialEq, Eq)]
enum Verdict {
    /// Sentry took it.
    Delivered,
    /// The server or Sentry refused it: sending it again would not help.
    Refused,
    /// Not delivered (network, Sentry unreachable, a rate limit): kept.
    Retry,
}

fn verdict(outcome: &Result<Value, AppCommandError>) -> Verdict {
    match outcome {
        Ok(result) => match result.get("statusCode").and_then(Value::as_u64) {
            Some(200..=299) => Verdict::Delivered,
            Some(429) => Verdict::Retry,
            Some(400..=499) => Verdict::Refused,
            _ => Verdict::Retry,
        },
        Err(e) if matches!(e.code, AppErrorCode::InvalidInput) => Verdict::Refused,
        Err(_) => Verdict::Retry,
    }
}

/// Where `conn`'s server says to report, if it does.
async fn target_of(
    proxy: &RemoteProxyState,
    conn: &RemoteWorkspaceConnectionInfo,
) -> Option<Target> {
    let info = call_api(proxy, conn, "cowork_info", None, Some(CALL_TIMEOUT_MS)).await;
    info.ok().as_ref().and_then(Target::from_cowork_info)
}

/// The first saved connection whose server says where to report; else the
/// app's own daemon, when it reports.
async fn find_server(
    db: &DatabaseConnection,
    proxy: &RemoteProxyState,
) -> Option<(RemoteWorkspaceConnectionInfo, Target)> {
    let connections = remote_workspace_connection_service::list(db)
        .await
        .unwrap_or_default();
    for conn in connections {
        if let Some(target) = target_of(proxy, &conn).await {
            return Some((conn, target));
        }
    }
    let Ok(Some(local)) = crate::local_daemon::connection_info().await else {
        return None;
    };
    let target = target_of(proxy, &local).await?;
    Some((local, target))
}

/// One round. True when nothing is left to send (or nothing may be sent).
async fn send_pending(app: &AppHandle) -> bool {
    let Some(dir) = super::RUN.get().map(|run| run.dir.clone()) else {
        return true;
    };
    store::prune_pending(&dir, super::now());
    let pending = store::list_pending(&dir);
    if pending.is_empty() {
        return true;
    }
    let Some(db) = app.try_state::<AppDatabase>().map(|db| db.conn.clone()) else {
        return false;
    };
    let Some(proxy) = app
        .try_state::<Arc<RemoteProxyState>>()
        .map(|proxy| proxy.inner().clone())
    else {
        return false;
    };
    let Some((conn, target)) = find_server(&db, &proxy).await else {
        return false;
    };
    for (path, report) in pending {
        if !super::enabled() {
            return true;
        }
        let body = json!({
            "envelope": envelope::envelope(&report, &target, chrono::Utc::now()),
        });
        let outcome = call_api(
            &proxy,
            &conn,
            crate::telemetry::ENVELOPE_COMMAND,
            Some(body),
            Some(CALL_TIMEOUT_MS),
        )
        .await;
        match verdict(&outcome) {
            Verdict::Delivered => {
                tracing::info!(
                    "[crash-report] sent a {} report of {}",
                    report.kind.as_str(),
                    report.version
                );
                let _ = std::fs::remove_file(&path);
            }
            Verdict::Refused => {
                tracing::warn!("[crash-report] a report was refused: {outcome:?}");
                let _ = std::fs::remove_file(&path);
            }
            Verdict::Retry => return false,
        }
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    fn answered(status: u64) -> Result<Value, AppCommandError> {
        Ok(json!({ "statusCode": status }))
    }

    #[test]
    fn what_is_kept_for_another_try() {
        assert_eq!(verdict(&answered(200)), Verdict::Delivered);
        assert_eq!(verdict(&answered(202)), Verdict::Delivered);
        // Sentry's limit, or ours (`telemetry::over_budget`).
        assert_eq!(verdict(&answered(429)), Verdict::Retry);
        assert_eq!(verdict(&answered(413)), Verdict::Refused);
        assert_eq!(verdict(&answered(503)), Verdict::Retry);
        assert_eq!(verdict(&Ok(json!({}))), Verdict::Retry);
        // The server's own checks (size, DSN): 400.
        let refused = Err(AppCommandError::invalid_input(
            "envelope is for another Sentry project",
        ));
        assert_eq!(verdict(&refused), Verdict::Refused);
        // Sentry unreachable from the server (502), or the server from here.
        let unreachable = Err(AppCommandError::network("could not reach Sentry"));
        assert_eq!(verdict(&unreachable), Verdict::Retry);
        let off = Err(AppCommandError::not_found("telemetry is off"));
        assert_eq!(verdict(&off), Verdict::Retry);
    }
}
