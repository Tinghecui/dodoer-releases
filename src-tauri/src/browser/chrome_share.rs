//! The person's own Chrome as agents get it: the tabs the person hands over,
//! and — once they let a window's agents use their Chrome — the pages those
//! agents open there themselves.
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
//! The switch "let agents use my Chrome" is per window (`chrome::lending`,
//! which also says who is told of which tab). With it on, a web page those
//! agents open goes to a window of Chrome kept for agents
//! (`chrome::agent_window`), is registered with owner `chrome@<scope>`, and is
//! shared with them for reading and acting wherever it goes — but never on a
//! sensitive site (`chrome::sensitive`), where it is let go of. Turning a
//! switch off lets go of the pages its agents opened; they stay open in
//! Chrome. `docs/agent-chrome.md` has the design.

use std::time::{Duration, Instant};

use serde_json::json;
use tauri::{AppHandle, Manager, Url};
use tokio::sync::mpsc;

use crate::app_error::AppCommandError;
use crate::commands::browser::{close_core_if, set_agent_grant_core};
use crate::commands::workspace_windows::REMOTE_WORKSPACE_LABEL_PREFIX;

use super::agent::{self, GrantLevel};
use super::channel;
use super::chrome::cdp::CdpClient;
use super::chrome::lending::{agent_owner, ChromeLending, AGENT_OWNER_PREFIX, LOCAL_SCOPE, OWNER};
use super::chrome::{sensitive, tabs, ChromeLink, ChromePage, PageEvent};
use super::events;
use super::hooks;
use super::registry::{BrowserRegistry, BrowserTab};
use super::surface::BrowserSurface;
use super::surface_external::ExternalHandle;
use super::types::{Bounds, BrowserTabState, ChannelKind, SurfaceKind, TabKind};

/// Tags the refusal of a sensitive site (`chrome::sensitive`).
pub const BROWSER_I18N_KEY_SENSITIVE: &str = "browser.chrome.error.sensitive";

/// How long a page an agent opened may take to commit its first document.
const COMMIT_WAIT: Duration = Duration::from_secs(20);

/// The scope a window's switch stands for: a remote window's own, or the app's
/// agents' for any local window.
pub fn scope_of_window(label: &str) -> String {
    if label.starts_with(REMOTE_WORKSPACE_LABEL_PREFIX) {
        label.to_string()
    } else {
        LOCAL_SCOPE.to_string()
    }
}

/// Turn `scope`'s switch on or off. Off lets go of every page its agents
/// opened: unregistered and detached, still open in Chrome.
pub fn set_lent(app: &AppHandle, registry: &BrowserRegistry, lending: &ChromeLending, scope: &str, on: bool) {
    lending.set(scope, on);
    if !on {
        let owner = agent_owner(scope);
        for state in registry.list() {
            if state.owner_window == owner {
                release(app, registry, &state.tab_id, None);
            }
        }
    }
}

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
        None => {
            let listed = link.listed(tab_id).ok_or_else(|| not_found(tab_id))?;
            if Url::parse(&listed.url).ok().as_ref().is_some_and(sensitive::is_sensitive) {
                return Err(sensitive_refusal(&listed.tab.host));
            }
            let client = connected(link)?;
            register(
                app,
                &client,
                registry,
                tab_id,
                &listed.target,
                &listed.url,
                &listed.tab.title,
                OWNER,
            )
            .await?;
        }
    }
    let shared = set_agent_grant_core(app, registry, tab_id, level).await;
    if shared.is_err() && registry.read(tab_id, |tab| tab.state.agent_grant.is_none()) == Some(true) {
        // Registered for nothing: a page with no address that can be shared
        // (it was still loading, or it is a `file:` page).
        release(app, registry, tab_id, None);
    }
    shared.map(drop)
}

/// Open `url` for an agent of `scope` in the agents' window of the person's
/// Chrome, register it, and answer with its id once it has committed a
/// document (shared with the agent for reading and acting) or has been given
/// the time to. Whether the switch is on is the caller's to have checked.
pub async fn open_for_agent(
    app: &AppHandle,
    link: &ChromeLink,
    registry: &BrowserRegistry,
    lending: &ChromeLending,
    scope: &str,
    url: &Url,
) -> Result<String, AppCommandError> {
    sensitive_check(url)?;
    let client = connected(link)?;
    let opened = lending
        .window()
        .open(&client, url.as_str())
        .await
        .map_err(|err| AppCommandError::network(format!("Chrome did not open the page: {err}")))?;
    let tab_id = tabs::tab_id(&opened.target);
    register(
        app,
        &client,
        registry,
        &tab_id,
        &opened.target,
        &opened.url,
        &opened.title,
        &agent_owner(scope),
    )
    .await?;
    // Whatever committed before the page was attached to said nothing.
    if let Some(generation) = registry.read(&tab_id, |tab| tab.generation) {
        keep_shared(app, registry, &tab_id, generation).await;
    }
    let deadline = Instant::now() + COMMIT_WAIT;
    while Instant::now() < deadline {
        match registry.read(&tab_id, |tab| tab.state.origin.is_some()) {
            Some(true) => break,
            Some(false) => tokio::time::sleep(Duration::from_millis(100)).await,
            // Let go of already: closed, or gone to a sensitive site.
            None => break,
        }
    }
    Ok(tab_id)
}

/// Bring the Chrome tab `tab_id` (an id from the tab list) to the front, for
/// the person to look at or take over.
pub async fn activate(link: &ChromeLink, tab_id: &str) -> Result<(), AppCommandError> {
    let listed = link.listed(tab_id).ok_or_else(|| not_found(tab_id))?;
    let client = connected(link)?;
    client
        .call("Target.activateTarget", json!({ "targetId": listed.target }), None)
        .await
        .map(drop)
        .map_err(|err| AppCommandError::network(format!("Chrome did not switch to the tab: {err}")))
}

fn connected(link: &ChromeLink) -> Result<CdpClient, AppCommandError> {
    link.client().ok_or_else(|| {
        AppCommandError::configuration_missing(
            "Chrome is not connected. The person connects it from the Chrome icon at the bottom left \
             of dodoer",
        )
    })
}

#[allow(clippy::too_many_arguments)]
async fn register(
    app: &AppHandle,
    client: &CdpClient,
    registry: &BrowserRegistry,
    tab_id: &str,
    target: &str,
    url: &str,
    title: &str,
    owner: &str,
) -> Result<(), AppCommandError> {
    // Held across the attach: a second press of the button must not attach a
    // second time.
    let reservation = registry.reserve(tab_id)?;
    let (page, page_events) = ChromePage::attach(client, target, url, title)
        .await
        .map_err(|err| AppCommandError::network(format!("could not attach to the Chrome tab: {err}")))?;
    let url = page.url();
    let state = BrowserTabState {
        tab_id: tab_id.to_string(),
        owner_window: owner.to_string(),
        kind: TabKind::Page,
        surface: SurfaceKind::External,
        channel: ChannelKind::Native,
        channel_error: None,
        url: url.clone(),
        requested_url: url.clone(),
        title: title.to_string(),
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
    let opened_by_agent = owner.starts_with(AGENT_OWNER_PREFIX);
    tauri::async_runtime::spawn(follow(
        app.clone(),
        tab_id.to_string(),
        generation,
        opened_by_agent,
        page_events,
    ));
    Ok(())
}

/// Carry what the page says into its registry entry, the way the engines'
/// callbacks do for the app's own tabs, until it is gone or let go of.
async fn follow(
    app: AppHandle,
    tab_id: String,
    generation: u64,
    opened_by_agent: bool,
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
                arrived(&app, &registry, &tab_id, generation, opened_by_agent).await;
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
                arrived(&app, &registry, &tab_id, generation, opened_by_agent).await;
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

/// The page is at a new address, and its grant has been re-checked against
/// it (`agent::revoke_if_departed`, in the hooks above).
async fn arrived(app: &AppHandle, registry: &BrowserRegistry, tab_id: &str, generation: u64, opened_by_agent: bool) {
    if opened_by_agent {
        keep_shared(app, registry, tab_id, generation).await;
    } else {
        release_if_unshared(app, registry, tab_id, generation);
    }
}

/// An agent's own page is shared with it wherever it goes, as a link or a
/// sign-in redirect takes it from site to site — except onto a sensitive
/// one, where it is let go of.
async fn keep_shared(app: &AppHandle, registry: &BrowserRegistry, tab_id: &str, generation: u64) {
    let seen = registry.read(tab_id, |tab| {
        (tab.generation == generation)
            .then(|| (tab.state.url.clone(), agent::level_of(tab.state.agent_grant.as_ref())))
    });
    let Some((url, level)) = seen.flatten() else {
        return;
    };
    if Url::parse(&url).ok().as_ref().is_some_and(sensitive::is_sensitive) {
        release(app, registry, tab_id, Some(generation));
        return;
    }
    if level == GrantLevel::None {
        // Refused for a page with no address a grant binds to (still
        // `about:blank`): the next document is shared when it commits.
        let _ = set_agent_grant_core(app, registry, tab_id, GrantLevel::Control).await;
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

/// Whether `url` is one agents may not open in the person's Chrome; the
/// refusal when it is.
pub fn sensitive_check(url: &Url) -> Result<(), AppCommandError> {
    if sensitive::is_sensitive(url) {
        Err(sensitive_refusal(url.host_str().unwrap_or_default()))
    } else {
        Ok(())
    }
}

fn sensitive_refusal(host: &str) -> AppCommandError {
    AppCommandError::permission_denied(format!(
        "{host} is on the list of sensitive sites (mail, payments, banks, passwords) that agents may \
         not use in the person's own Chrome"
    ))
    .with_i18n(BROWSER_I18N_KEY_SENSITIVE, std::collections::BTreeMap::new())
}

fn not_found(tab_id: &str) -> AppCommandError {
    AppCommandError::not_found(format!("Chrome tab {tab_id} not found"))
}
