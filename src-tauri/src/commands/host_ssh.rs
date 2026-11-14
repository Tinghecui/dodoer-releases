//! The windows' side of lending this computer's shell to a remote
//! workspace's agents (`crate::host_ssh`, `docs/host-ssh.md`).
//!
//! Cowork fork. A remote window shows one switch, for its own server; the
//! answer is kept in `app_metadata` by the server's address and outlives the
//! app. Off until a person turns it on: on, that server's agents are meant
//! to run commands here as that person.

use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::DatabaseConnection;
use tauri::{Manager, State};

use crate::app_error::AppCommandError;
use crate::db::service::{app_metadata_service, remote_workspace_connection_service};
use crate::db::AppDatabase;
use crate::host_ssh::{Lending, LendingStatus, OpenWindow, SelfTest, Sshd};
use crate::local_daemon::LOCAL_CONNECTION_ID;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// The servers this computer is lent to: a JSON list of their addresses.
pub const KEY_LENT_SERVERS: &str = "host_ssh.lent_servers";

/// Sent to every window whenever a lending or the service changed; a window
/// asks again for what its own server's status is now.
pub const HOST_SSH_CHANGED_EVENT: &str = "host-ssh://changed";

/// How long quitting waits for the service to stop. Past it the app goes
/// anyway, and the service's watcher ends it (`host_ssh::sshd`).
const EXIT_TIMEOUT: Duration = Duration::from_secs(3);

/// One write of the stored list at a time: two switches flipped together
/// must not store them in the other order than they were applied.
static STORE_LOCK: std::sync::LazyLock<tokio::sync::Mutex<()>> =
    std::sync::LazyLock::new(|| tokio::sync::Mutex::new(()));

/// The stored list; nothing lent for a missing or unreadable one.
async fn load_lent_servers(conn: &DatabaseConnection) -> BTreeSet<String> {
    match app_metadata_service::get_value(conn, KEY_LENT_SERVERS).await {
        Ok(Some(raw)) => serde_json::from_str(&raw).unwrap_or_default(),
        _ => BTreeSet::new(),
    }
}

/// At launch, before any window: clear away what an earlier run left, and
/// take up the lendings as stored. Nothing starts here — the service follows
/// the remote windows (`window_opened`).
pub fn start(app: &tauri::AppHandle, conn: &DatabaseConnection, data_dir: &Path) {
    let lent = tauri::async_runtime::block_on(async {
        crate::host_ssh::stop_survivor(data_dir).await;
        load_lent_servers(conn).await
    });
    let lending = Lending::new(Sshd::new(data_dir.to_path_buf()), lent);
    let mut changes = lending.subscribe();
    let emitter = EventEmitter::Tauri(app.clone());
    tauri::async_runtime::spawn(async move {
        while changes.changed().await.is_ok() {
            emit_event(&emitter, HOST_SSH_CHANGED_EVENT, ());
        }
    });
    app.manage(lending);
}

/// A remote window's event socket is starting; hold the answer for as long
/// as it runs. `None` for the app's own daemon, which is on this computer
/// already and is never lent it.
pub async fn window_opened(
    app: &tauri::AppHandle,
    connection_id: i32,
    base_url: &str,
) -> Option<OpenWindow> {
    if connection_id == LOCAL_CONNECTION_ID {
        return None;
    }
    let lending = Arc::clone(app.try_state::<Arc<Lending>>()?.inner());
    Some(lending.window_opened(base_url).await)
}

/// Stop the service on the way out (`shut_down`).
pub fn stop_on_exit(app: &tauri::AppHandle) {
    if let Some(lending) = app.try_state::<Arc<Lending>>() {
        let lending = Arc::clone(lending.inner());
        tauri::async_runtime::block_on(async move {
            let _ = tokio::time::timeout(EXIT_TIMEOUT, lending.shut_down()).await;
        });
    }
}

/// The address of the server behind a remote window's connection.
async fn server_of(
    conn: &DatabaseConnection,
    connection_id: i32,
) -> Result<String, AppCommandError> {
    if connection_id == LOCAL_CONNECTION_ID {
        return Err(AppCommandError::invalid_input(
            "this computer is not lent to its own workspace",
        ));
    }
    remote_workspace_connection_service::get(conn, connection_id)
        .await
        .map_err(AppCommandError::db)?
        .map(|connection| connection.base_url)
        .ok_or_else(|| {
            AppCommandError::not_found(format!("Remote connection {connection_id} not found"))
        })
}

#[tauri::command]
pub async fn host_ssh_status(
    db: State<'_, AppDatabase>,
    lending: State<'_, Arc<Lending>>,
    connection_id: i32,
) -> Result<LendingStatus, AppCommandError> {
    let server = server_of(&db.conn, connection_id).await?;
    Ok(lending.status(&server).await)
}

/// Lend this computer to the server of `connection_id`, or stop.
#[tauri::command]
pub async fn host_ssh_set_lent(
    db: State<'_, AppDatabase>,
    lending: State<'_, Arc<Lending>>,
    connection_id: i32,
    lent: bool,
) -> Result<LendingStatus, AppCommandError> {
    let server = server_of(&db.conn, connection_id).await?;
    let _stored_in_order = STORE_LOCK.lock().await;
    let servers = lending.set_lent(&server, lent).await;
    let stored = serde_json::to_string(&servers)
        .map_err(|e| AppCommandError::io_error(e.to_string()))?;
    if let Err(e) = app_metadata_service::upsert_value(&db.conn, KEY_LENT_SERVERS, &stored).await {
        // Not kept, so not left in force either: a lending that the next
        // launch would not know of is one nobody could see to take back.
        lending.set_lent(&server, !lent).await;
        return Err(AppCommandError::from(e));
    }
    Ok(lending.status(&server).await)
}

/// Log in to the running service once, the way a lent connection will.
#[tauri::command]
pub async fn host_ssh_self_test(
    lending: State<'_, Arc<Lending>>,
) -> Result<SelfTest, AppCommandError> {
    lending
        .self_test()
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}
