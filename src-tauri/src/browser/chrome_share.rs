//! Handing a tab of the person's own Chrome to agents, and taking it back.
//!
//! Until it is handed over a Chrome tab is only listed for the person
//! (`chrome::tabs`) and is in no registry an agent tool reads. Handing it
//! over attaches to it (`chrome::page`) and registers it with the built-in
//! browser's tabs — owner `chrome`, surface `external` — so the agent tools,
//! the grant checks, the activity record and the console all treat it like
//! any other tab. Taking it back, Chrome closing it, the page leaving the
//! site it was handed over on, or the connection ending all unregister it
//! again, which detaches and leaves the tab in Chrome as it was.
//!
//! Remote windows' agents do not see it: their tools are scoped to their own
//! window's tabs, and `chrome` is no window (lending it to them is a later
//! step, `docs/agent-chrome.md` section 7).

use serde_json::json;
use tauri::{AppHandle, Manager, Url};
use tokio::sync::mpsc;

use crate::app_error::AppCommandError;
use crate::commands::browser::{close_core_if, set_agent_grant_core};

use super::agent::{self, GrantLevel};
use super::channel;
use super::chrome::{ChromeLink, ChromePage, PageEvent};
use super::events;
use super::hooks;
use super::registry::{BrowserRegistry, BrowserTab};
use super::surface::BrowserSurface;
use super::surface_external::ExternalHandle;
use super::types::{Bounds, BrowserTabState, ChannelKind, SurfaceKind, TabKind};

/// The `owner_window` of every Chrome tab in the registry. No window has this
/// label, so nothing tied to a window (its closing, a remote window's scoped
/// tools, the frontend's workspace tabs) ever takes one of these for its own.
pub const OWNER: &str = "chrome";

/// Give agents `level` on the Chrome tab `tab_id` (an id from the tab list),
/// or take it back with [`GrantLevel::None`].
pub async fn share(
    app: &AppHandle,
    link: &ChromeLink,
    registry: &BrowserRegistry,
    tab_id: &str,
    level: GrantLevel,
) -> Result<(), AppCommandError> {
    let registered = registry.read(tab_id, |tab| tab.state.surface == SurfaceKind::External);
    if level == GrantLevel::None {
        if registered == Some(true) {
            set_agent_grant_core(app, registry, tab_id, GrantLevel::None).await?;
            release(app, registry, tab_id, None);
        }
        return Ok(());
    }
    match registered {
        Some(true) => {}
        // The id of a tab of the app's own: not this command's to share.
        Some(false) => return Err(not_found(tab_id)),
        None => register(app, link, registry, tab_id).await?,
    }
    let shared = set_agent_grant_core(app, registry, tab_id, level).await;
    if shared.is_err() && registry.read(tab_id, |tab| tab.state.agent_grant.is_none()) == Some(true) {
        // Registered for nothing: a page with no address that can be shared
        // (it was still loading, or it is a `file:` page).
        release(app, registry, tab_id, None);
    }
    shared.map(drop)
}

async fn register(
    app: &AppHandle,
    link: &ChromeLink,
    registry: &BrowserRegistry,
    tab_id: &str,
) -> Result<(), AppCommandError> {
    let listed = link.listed(tab_id).ok_or_else(|| not_found(tab_id))?;
    let client = link
        .client()
        .ok_or_else(|| AppCommandError::configuration_missing("Chrome is not connected"))?;
    // Held across the attach: a second press of the button must not attach a
    // second time.
    let reservation = registry.reserve(tab_id)?;
    let (page, page_events) = ChromePage::attach(&client, &listed.target, &listed.url, &listed.tab.title)
        .await
        .map_err(|err| AppCommandError::network(format!("could not attach to the Chrome tab: {err}")))?;
    let url = page.url();
    let state = BrowserTabState {
        tab_id: tab_id.to_string(),
        owner_window: OWNER.to_string(),
        kind: TabKind::Page,
        surface: SurfaceKind::External,
        channel: ChannelKind::Native,
        channel_error: None,
        url: url.clone(),
        requested_url: url.clone(),
        title: listed.tab.title.clone(),
        favicon: None,
        loading: page.is_loading(),
        can_go_back: page.can_go_back(),
        can_go_forward: page.can_go_forward(),
        origin: Url::parse(&url).ok().as_ref().and_then(hooks::origin_of),
        zoom: 1.0,
        error: None,
        remote_host: None,
        opener_tab_id: None,
        // In no profile of the built-in browser: nothing that clears or
        // reconfigures a profile reaches the person's Chrome.
        profile: None,
        agent_grant: None,
    };
    let surface = BrowserSurface::External(ExternalHandle::new(page.clone(), tab_id));
    let tab = BrowserTab::new(state, surface, Bounds::default(), false, false);
    if let Err(err) = registry.insert_reserved(tab, reservation) {
        page.detach();
        return Err(err);
    }
    let Some((generation, state)) = registry.read(tab_id, |tab| (tab.generation, tab.state.clone())) else {
        return Err(not_found(tab_id));
    };
    events::emit_state(app, &state);
    tauri::async_runtime::spawn(follow(app.clone(), tab_id.to_string(), generation, page_events));
    Ok(())
}

/// Carry what the page says into its registry entry, the way the engines'
/// callbacks do for the app's own tabs, until it is gone or let go of.
async fn follow(
    app: AppHandle,
    tab_id: String,
    generation: u64,
    mut page_events: mpsc::UnboundedReceiver<PageEvent>,
) {
    while let Some(event) = page_events.recv().await {
        let Some(registry) = app.try_state::<BrowserRegistry>() else {
            return;
        };
        // A later incarnation of the id is somebody else's to follow.
        if registry.read(&tab_id, |tab| tab.generation) != Some(generation) {
            return;
        }
        match event {
            PageEvent::Committed { url } => {
                if let Ok(url) = Url::parse(&url) {
                    hooks::page_load(&app, &tab_id, &url, true);
                }
                release_if_unshared(&app, &registry, &tab_id, generation);
            }
            PageEvent::Loaded { url } => {
                if let Ok(url) = Url::parse(&url) {
                    hooks::page_load(&app, &tab_id, &url, false);
                }
            }
            PageEvent::SameDocument { url } => {
                // What the helper reports on the other surfaces for a route
                // change, through the same handler: new refs, and the grant
                // re-checked against the new address.
                let envelope = json!({ "kind": "nav-state", "top": true, "payload": { "href": url } });
                channel::handle_message(&app, &tab_id, envelope.to_string(), true);
                release_if_unshared(&app, &registry, &tab_id, generation);
            }
            PageEvent::Title(title) => hooks::title_changed(&app, &tab_id, title),
            PageEvent::Console { envelope, main_frame } => {
                channel::handle_message(&app, &tab_id, envelope, main_frame);
            }
            PageEvent::Gone => {
                release(&app, &registry, &tab_id, Some(generation));
                return;
            }
        }
    }
}

/// The page left the site it was handed over on and its grant went with it
/// (`agent::revoke_if_departed`): nothing is left for agents here, so the tab
/// is let go of rather than kept attached.
fn release_if_unshared(app: &AppHandle, registry: &BrowserRegistry, tab_id: &str, generation: u64) {
    let unshared = registry.read(tab_id, |tab| {
        tab.generation == generation && agent::level_of(tab.state.agent_grant.as_ref()) == GrantLevel::None
    });
    if unshared == Some(true) {
        release(app, registry, tab_id, Some(generation));
    }
}

/// Unregister the tab — `generation`'s incarnation of it, when given — which
/// detaches from it and tells the frontend it is gone.
fn release(app: &AppHandle, registry: &BrowserRegistry, tab_id: &str, generation: Option<u64>) {
    let _ = close_core_if(app, registry, tab_id, None, |tab| {
        tab.state.surface == SurfaceKind::External && generation.is_none_or(|wanted| tab.generation == wanted)
    });
}

fn not_found(tab_id: &str) -> AppCommandError {
    AppCommandError::not_found(format!("Chrome tab {tab_id} not found"))
}
