//! The connection to the person's own Chrome (`browser::chrome`), as the
//! settings page and the Chrome panel drive it. The app's alone: Chrome is on
//! the computer the app runs on, whichever server a window's workspace lives
//! on.

use std::collections::HashMap;
use std::sync::Once;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use crate::app_error::AppCommandError;
use crate::browser::agent::GrantLevel;
use crate::browser::chrome::activity::ActivityEntry;
use crate::browser::chrome::sensitive::{self, SiteEdits, DEFAULT_SITES};
use crate::browser::chrome::{
    ChromeLending, ChromeLink, ChromeStatus, ChromeTab, SITES_EVENT, STATUS_EVENT, TABS_EVENT,
};
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
        let emitter = EventEmitter::from_app(app);
        let mut changes = link.changes();
        let to_status = emitter.clone();
        tauri::async_runtime::spawn(async move {
            while changes.changed().await.is_ok() {
                let status = changes.borrow_and_update().clone();
                emit_event(&to_status, STATUS_EVENT, status);
            }
        });
        let mut tab_changes = link.tab_changes();
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            while tab_changes.changed().await.is_ok() {
                let tabs = tab_changes.borrow_and_update().clone();
                let tabs = match app.try_state::<BrowserRegistry>() {
                    Some(registry) => chrome_share::panel_tabs(&registry, tabs),
                    None => tabs,
                };
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
    registry: State<'_, BrowserRegistry>,
) -> Result<Vec<ChromeTab>, AppCommandError> {
    announce(&app, &link);
    Ok(chrome_share::panel_tabs(&registry, link.tabs()))
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
/// page: the default list (flat, and in its groups), the person's edits to
/// it, and whether they have paused it (`chrome::sensitive`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeSites {
    pub defaults: Vec<String>,
    pub blocked: Vec<String>,
    pub allowed: Vec<String>,
    pub paused: bool,
    /// `defaults` by kind — mail, accounts, payments, banks, exchanges, in
    /// that order — so the page needs no table of its own.
    pub groups: Vec<ChromeSiteGroup>,
}

/// One kind of site in the default list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChromeSiteGroup {
    pub id: String,
    pub sites: Vec<String>,
}

impl From<SiteEdits> for ChromeSites {
    fn from(edits: SiteEdits) -> Self {
        ChromeSites {
            defaults: DEFAULT_SITES.iter().map(|site| site.to_string()).collect(),
            blocked: edits.blocked,
            allowed: edits.allowed,
            paused: edits.paused,
            groups: sensitive::site_groups()
                .into_iter()
                .map(|(id, sites)| ChromeSiteGroup {
                    id: id.to_string(),
                    sites: sites.iter().map(|site| site.to_string()).collect(),
                })
                .collect(),
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

/// The person's edits: sites added (`blocked`), default entries let go of
/// (`allowed`) and, when given, the pause (`paused`; left out — as an older
/// page does — it stays as it is). Kept in the data directory and in force at
/// once; a Chrome tab agents have on a site now kept off is let go of. Every
/// window hears of it (`browser://chrome-sites`). Only the app's own shell
/// reaches this: no server route, no agent tool.
#[tauri::command]
pub async fn browser_chrome_set_sites(
    app: AppHandle,
    registry: State<'_, BrowserRegistry>,
    blocked: Vec<String>,
    allowed: Vec<String>,
    paused: Option<bool>,
) -> Result<ChromeSites, AppCommandError> {
    let kept: ChromeSites =
        chrome_share::set_sites(&app, &registry, blocked, allowed, paused)?.into();
    emit_event(&EventEmitter::from_app(&app), SITES_EVENT, &kept);
    Ok(kept)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_carries_the_pause_and_the_groups() {
        let edits = SiteEdits {
            blocked: vec!["example.com".into()],
            allowed: vec!["paypal.com".into()],
            paused: true,
        }
        .normalized();
        let sites = ChromeSites::from(edits);
        assert!(sites.paused);
        assert_eq!(sites.blocked, vec!["example.com".to_string()]);
        assert_eq!(sites.allowed, vec!["paypal.com".to_string()]);
        let ids: Vec<&str> = sites.groups.iter().map(|g| g.id.as_str()).collect();
        assert_eq!(
            ids,
            vec!["mail", "accounts", "payments", "banks", "exchanges"]
        );
        // 五组合起来就是平铺的默认名单，不重不漏。
        let mut grouped: Vec<String> = sites.groups.iter().flat_map(|g| g.sites.clone()).collect();
        let mut defaults = sites.defaults.clone();
        assert_eq!(defaults.len(), 52);
        assert_eq!(grouped.len(), defaults.len());
        grouped.sort();
        defaults.sort();
        assert_eq!(grouped, defaults);
        let json = serde_json::to_value(&sites).unwrap();
        assert_eq!(json["paused"], true);
        assert_eq!(json["groups"][0]["id"], "mail");
        assert!(json["groups"][0]["sites"]
            .as_array()
            .unwrap()
            .contains(&"mail.google.com".into()));
        assert!(!ChromeSites::from(SiteEdits::default()).paused);
    }
}
