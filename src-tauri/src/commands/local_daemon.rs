//! The windows' side of the app's child daemon (`crate::local_daemon`).
//!
//! Cowork fork. Every window learns at load which daemon it has — the child
//! process, or the one inside the app — from `window.__CODEG_LOCAL_DAEMON__`,
//! set by [`init_script_plugin`] before any of the page's code runs. The
//! frontend's transport (`src/lib/transport/local-daemon-transport.ts`)
//! decides from it, synchronously, where a command goes: to the child through
//! the remote-workspace proxy (connection [`LOCAL_CONNECTION_ID`]), or to the
//! app itself.
//!
//! [`LOCAL_CONNECTION_ID`]: crate::local_daemon::LOCAL_CONNECTION_ID

use std::sync::Arc;

use serde::Serialize;
use tauri::{Manager, State, WebviewWindow};

use crate::commands::remote_proxy::RemoteProxyState;
use crate::local_daemon::{LocalDaemon, Mode, CLIENT_ONLY_BUILD, LOCAL_CONNECTION_ID};

/// The child daemon, managed when it runs.
pub struct LocalDaemonState(pub LocalDaemon);

/// The mode the app settled on at launch (`local_daemon::decide_mode`, and
/// the fall-back from child to embedded), managed in every mode.
pub struct DaemonModeState(pub Mode);

/// `codeg --desktop-edition`: which edition this binary is — full, or the
/// client-only one without a daemon (`CLIENT_ONLY_BUILD`) — and where it
/// updates from, as one line of JSON on stdout. The desktop build checks the
/// bundle it just made with it (`scripts/cowork-desktop-build.sh`): the
/// edition comes from a Cargo feature and the update line from a Tauri config
/// file, and a bundle made with one but not the other would update itself
/// into the other edition.
pub fn edition_report(config: &tauri::Config) -> serde_json::Value {
    let endpoints = config
        .plugins
        .0
        .get("updater")
        .and_then(|updater| updater.get("endpoints"))
        .cloned()
        .unwrap_or_else(|| serde_json::Value::Array(Vec::new()));
    serde_json::json!({
        "edition": if CLIENT_ONLY_BUILD { "client" } else { "full" },
        "clientOnly": CLIENT_ONLY_BUILD,
        "productName": config.product_name,
        "identifier": config.identifier,
        "version": config.version,
        "updaterEndpoints": endpoints,
    })
}

/// Sets `window.__CODEG_LOCAL_DAEMON__ = { mode, connectionId }` in every
/// webview created after it is registered (setup registers it before the
/// first window).
pub fn init_script_plugin<R: tauri::Runtime>(mode: Mode) -> tauri::plugin::TauriPlugin<R> {
    // Only in the app's own pages: the built-in browser's tabs are webviews
    // too, and a web page has no business knowing (`tauri:` on macOS/Linux,
    // `http://tauri.localhost` on Windows; the dev server in a debug build).
    let own_page = if cfg!(debug_assertions) {
        "location.protocol === 'tauri:' || location.hostname === 'tauri.localhost' || location.hostname === 'localhost'"
    } else {
        "location.protocol === 'tauri:' || location.hostname === 'tauri.localhost'"
    };
    let script = format!(
        "if ({own_page}) {{ Object.defineProperty(window, '__CODEG_LOCAL_DAEMON__', {{ value: Object.freeze({{ mode: '{}', connectionId: {} }}), configurable: false }}); }}",
        mode.as_str(),
        LOCAL_CONNECTION_ID
    );
    tauri::plugin::Builder::new("codeg-local-daemon")
        .js_init_script(script)
        .build()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalDaemonStatus {
    pub mode: &'static str,
    pub connection_id: i32,
    /// Where the child answers now; `None` while it restarts, and always in
    /// embedded mode.
    pub base_url: Option<String>,
    pub pid: Option<u32>,
}

/// For the settings page and diagnostics.
#[tauri::command]
pub fn local_daemon_status(app: tauri::AppHandle) -> LocalDaemonStatus {
    let child = app.try_state::<LocalDaemonState>();
    let mode = app
        .try_state::<DaemonModeState>()
        .map(|m| m.0)
        .unwrap_or(if child.is_some() {
            Mode::Child
        } else {
            Mode::Embedded
        });
    let endpoint = child.and_then(|state| state.0.endpoint());
    LocalDaemonStatus {
        mode: mode.as_str(),
        connection_id: LOCAL_CONNECTION_ID,
        base_url: endpoint.as_ref().map(|e| e.base_url.clone()),
        pid: endpoint.map(|e| e.pid),
    }
}

/// A window's transport to the child, starting: tombstone its event
/// subscriptions when the window goes, as the proxy does for a remote
/// window from the moment it is built.
#[tauri::command]
pub fn local_daemon_attach_window(
    window: WebviewWindow,
    proxy: State<'_, Arc<RemoteProxyState>>,
    window_instance_id: String,
) {
    proxy.register_window_instance_cleanup(&window, window_instance_id);
}

/// Stop the child on the way out (`shut_down`).
pub fn stop_on_exit(app: &tauri::AppHandle) {
    if let Some(state) = app.try_state::<LocalDaemonState>() {
        tauri::async_runtime::block_on(state.0.stop());
    }
    if let Some(bridge) = app.try_state::<crate::host_bridge::HostBridgeServer>() {
        bridge.shutdown();
    }
}
