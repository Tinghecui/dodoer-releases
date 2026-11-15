//! The connection to the person's own Chrome (`browser::chrome`), as the
//! settings page and the Chrome panel drive it. The app's alone: Chrome is on
//! the computer the app runs on, whichever server a window's workspace lives
//! on.

use std::collections::HashMap;
use std::sync::Once;

use serde::Serialize;
use tauri::{AppHandle, State};

use crate::app_error::AppCommandError;
use crate::browser::agent::GrantLevel;
use crate::browser::chrome::activity::ActivityEntry;
use crate::browser::chrome::sensitive::{self, SiteEdits, DEFAULT_SITES};
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

/// What agents did to each of the connected Chrome's tabs, oldest first, by
/// tab id (`chrome::activity`); empty when not connected. For the panel, which
/// asks once when it opens and again on each `browser://agent-activity`.
/// Never handed to agents: it is a record kept for the person.
#[tauri::command]
pub async fn browser_chrome_activity(
    app: AppHandle,
    link: State<'_, ChromeLink>,
) -> Result<HashMap<String, Vec<ActivityEntry>>, AppCommandError> {
    announce(&app, &link);
    Ok(link.activity().all())
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
    // A server choosing among several computers goes by this
    // (`CAPABILITY_CHROME`): tell the ones this app is registered with.
    crate::commands::remote_proxy::refresh_host_registrations(&app);
    Ok(on)
}

/// Whether agents may run their own code (`browser_eval`) in the Chrome tabs
/// they may act on (`docs/agent-chrome.md` 13.5). One switch for this
/// computer's Chrome, whichever window asks.
#[tauri::command]
pub async fn browser_chrome_eval(
    lending: State<'_, ChromeLending>,
) -> Result<bool, AppCommandError> {
    Ok(lending.eval_allowed())
}

/// The person's switch for running code in their Chrome. Kept in memory
/// only; the windows remember it and hand it back when the app starts. The
/// app's own shell is the only way here: no server route, no agent tool.
#[tauri::command]
pub async fn browser_chrome_set_eval(
    lending: State<'_, ChromeLending>,
    on: bool,
) -> Result<bool, AppCommandError> {
    lending.set_eval(on);
    Ok(on)
}

/// The sites agents are kept off in the person's Chrome, for the settings
/// page: the default list, and the person's edits to it
/// (`chrome::sensitive`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeSites {
    pub defaults: Vec<String>,
    pub blocked: Vec<String>,
    pub allowed: Vec<String>,
}

impl From<SiteEdits> for ChromeSites {
    fn from(edits: SiteEdits) -> Self {
        ChromeSites {
            defaults: DEFAULT_SITES.iter().map(|site| site.to_string()).collect(),
            blocked: edits.blocked,
            allowed: edits.allowed,
        }
    }
}

/// The sensitive sites and the person's edits to them. The list is this
/// computer's, whichever window asks; only the app's own shell answers it,
/// and no agent tool reaches it.
#[tauri::command]
pub async fn browser_chrome_sites() -> Result<ChromeSites, AppCommandError> {
    Ok(sensitive::current().into())
}

/// The person's edits: sites added (`blocked`) and default entries let go of
/// (`allowed`). Kept in the data directory and in force at once; a Chrome tab
/// agents have on a site now kept off is let go of. The settings page asks
/// the person before it lets go of a default entry; an agent cannot reach
/// this.
#[tauri::command]
pub async fn browser_chrome_set_sites(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    blocked: Vec<String>,
    allowed: Vec<String>,
) -> Result<ChromeSites, AppCommandError> {
    let edits = SiteEdits { blocked, allowed };
    Ok(chrome_share::set_sites(&app, &registry, &edits)?.into())
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
