//! The connection to the person's own Chrome (`browser::chrome`), as the
//! settings page and the Chrome panel drive it. The app's alone: Chrome is on
//! the computer the app runs on, whichever server a window's workspace lives
//! on.

use std::sync::Once;

use tauri::{AppHandle, State};

use crate::app_error::AppCommandError;
use crate::browser::agent::GrantLevel;
use crate::browser::chrome::{ChromeLending, ChromeLink, ChromeStatus, ChromeTab, STATUS_EVENT, TABS_EVENT};
use crate::browser::{chrome_share, BrowserRegistry};
use crate::web::event_bridge::{emit_event, EventEmitter};

/// macOS's list of which app may read which other app's files — where the
/// person lets this app read where Chrome listens.
const FILES_AND_FOLDERS_PANE: &str =
    "x-apple.systempreferences:com.apple.preference.security?Privacy_FilesAndFolders";

static ANNOUNCING: Once = Once::new();

/// Start telling the frontend about every change of state and of the tab
/// list. Called by each command before it does anything, so the first of
/// them starts it and no change can come before it: Chrome quitting is a
/// change nobody asked for, and the page showing "connected" has no other
/// way to hear of it.
fn announce(app: &AppHandle, link: &ChromeLink) {
    ANNOUNCING.call_once(|| {
        let emitter = EventEmitter::Tauri(app.clone());
        let mut changes = link.changes();
        let to_status = emitter.clone();
        tauri::async_runtime::spawn(async move {
            while changes.changed().await.is_ok() {
                let status = changes.borrow_and_update().clone();
                emit_event(&to_status, STATUS_EVENT, status);
            }
        });
        let mut tab_changes = link.tab_changes();
        tauri::async_runtime::spawn(async move {
            while tab_changes.changed().await.is_ok() {
                let tabs = tab_changes.borrow_and_update().clone();
                emit_event(&emitter, TABS_EVENT, tabs);
            }
        });
    });
}

#[tauri::command]
pub async fn browser_chrome_status(
    app: AppHandle,
    link: State<'_, ChromeLink>,
) -> Result<ChromeStatus, AppCommandError> {
    announce(&app, &link);
    Ok(link.status())
}

/// The connected Chrome's web pages, for the panel; empty when not
/// connected. Never handed to agents: it is what the person has open.
#[tauri::command]
pub async fn browser_chrome_tabs(
    app: AppHandle,
    link: State<'_, ChromeLink>,
) -> Result<Vec<ChromeTab>, AppCommandError> {
    announce(&app, &link);
    Ok(link.tabs())
}

/// Hand the Chrome tab `tab_id` (an id from the tab list) to agents at
/// `level`, or take it back with `none`. The person's doing, from the panel:
/// no agent can reach this.
#[tauri::command]
pub async fn browser_chrome_share(
    app: AppHandle,
    link: State<'_, ChromeLink>,
    registry: State<'_, BrowserRegistry>,
    tab_id: String,
    level: GrantLevel,
) -> Result<(), AppCommandError> {
    announce(&app, &link);
    chrome_share::share(&app, &link, &registry, &tab_id, level).await
}

/// Whether the agents of the calling window may use the person's Chrome
/// (`chrome::lending`): the app's own agents for a local window, that
/// server's for a remote one.
#[tauri::command]
pub async fn browser_chrome_agents(
    window: tauri::WebviewWindow,
    lending: State<'_, ChromeLending>,
) -> Result<bool, AppCommandError> {
    Ok(lending.is_lent(&chrome_share::scope_of_window(window.label())))
}

/// The person's switch for the calling window's agents. A window sets its
/// own and nobody else's; turning it off lets go of the pages those agents
/// opened in Chrome, which stay open there.
#[tauri::command]
pub async fn browser_chrome_set_agents(
    app: AppHandle,
    window: tauri::WebviewWindow,
    registry: State<'_, BrowserRegistry>,
    lending: State<'_, ChromeLending>,
    on: bool,
) -> Result<bool, AppCommandError> {
    let scope = chrome_share::scope_of_window(window.label());
    chrome_share::set_lent(&app, &registry, &lending, &scope, on);
    Ok(on)
}

/// Bring the Chrome tab `tab_id` (an id from the tab list) to the front.
#[tauri::command]
pub async fn browser_chrome_activate(
    app: AppHandle,
    link: State<'_, ChromeLink>,
    tab_id: String,
) -> Result<(), AppCommandError> {
    announce(&app, &link);
    chrome_share::activate(&link, &tab_id).await
}

/// Connect, and answer once that has ended one way or the other — which is
/// when the person has answered Chrome's dialog, so it can take minutes.
/// `endpoint` is what they pasted when the app could not read Chrome's file
/// itself. Why a connection was not made is in the status, not an error:
/// each reason is something for the person to do, and the page says what.
#[tauri::command]
pub async fn browser_chrome_connect(
    app: AppHandle,
    link: State<'_, ChromeLink>,
    endpoint: Option<String>,
) -> Result<ChromeStatus, AppCommandError> {
    announce(&app, &link);
    Ok(link.connect(endpoint.as_deref()).await)
}

#[tauri::command]
pub async fn browser_chrome_disconnect(
    app: AppHandle,
    link: State<'_, ChromeLink>,
) -> Result<ChromeStatus, AppCommandError> {
    announce(&app, &link);
    Ok(link.disconnect())
}

/// Open System Settings where the read of Chrome's file is allowed. Nothing
/// to open off macOS, where nothing refuses it.
#[tauri::command]
pub async fn browser_chrome_open_privacy_settings(app: AppHandle) -> Result<(), AppCommandError> {
    if !cfg!(target_os = "macos") {
        return Ok(());
    }
    use tauri_plugin_opener::OpenerExt;
    app.opener()
        .open_url(FILES_AND_FOLDERS_PANE, None::<&str>)
        .map_err(|e| AppCommandError::configuration_invalid(e.to_string()))
}
