//! Whose agents may use the person's own Chrome, and which of its tabs each
//! of them is told of (`docs/agent-chrome.md` section 5.7).
//!
//! The switch "let agents use my Chrome" is per scope: the app's own agents
//! (every local window together, [`LOCAL_SCOPE`]) or one remote window's
//! server, named by that window's label. The registry says whose a Chrome tab
//! is by its `owner_window`: [`OWNER`] for one the person handed over,
//! `chrome@<scope>` ([`agent_owner`]) for a page that scope's agents opened.
//! No window has either label, so nothing tied to a window takes one of these
//! tabs for its own.
//!
//! Pure rules, compiled in both runtimes for the sake of their tests; the
//! desktop app is their only user (`browser::chrome_share`).

use std::collections::HashSet;
use std::sync::{Mutex, MutexGuard};

use url::Url;

use super::AgentWindow;

/// The `owner_window` of a Chrome tab the person handed over.
pub const OWNER: &str = "chrome";

/// The `owner_window` of a page an agent opened in Chrome: this, then the
/// scope whose agents opened it.
pub const AGENT_OWNER_PREFIX: &str = "chrome@";

/// The scope of the app's own agents, whichever local window they work in.
pub const LOCAL_SCOPE: &str = "local";

/// Whose agents a tool call is for: a remote window's label, or
/// [`LOCAL_SCOPE`] for `None` — the app's own agents.
pub fn scope_key(window: Option<&str>) -> &str {
    window.unwrap_or(LOCAL_SCOPE)
}

pub fn agent_owner(scope: &str) -> String {
    format!("{AGENT_OWNER_PREFIX}{scope}")
}

/// Which scopes' agents the person lets use their Chrome, and the window
/// those agents open pages in. One for the app; the switches live as long as
/// the app does, and each window tells it its own when it opens.
#[derive(Default)]
pub struct ChromeLending {
    lent: Mutex<HashSet<String>>,
    window: AgentWindow,
}

impl ChromeLending {
    pub fn is_lent(&self, scope: &str) -> bool {
        self.lent().contains(scope)
    }

    /// Turn `scope`'s switch on or off.
    pub fn set(&self, scope: &str, on: bool) {
        let mut lent = self.lent();
        if on {
            lent.insert(scope.to_string());
        } else {
            lent.remove(scope);
        }
    }

    pub fn window(&self) -> &AgentWindow {
        &self.window
    }

    fn lent(&self) -> MutexGuard<'_, HashSet<String>> {
        self.lent.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

/// Whether the agents of `scope` (a remote window's label; `None` for the
/// app's own) may be told of a tab whose `owner_window` is `owner`. For the
/// app's own tabs this is what it always was: every tab for the app's
/// agents, a remote window's agents their own window's.
pub fn reaches(lending: Option<&ChromeLending>, owner: &str, scope: Option<&str>) -> bool {
    let lent = |scope: &str| lending.is_some_and(|lending| lending.is_lent(scope));
    if let Some(opener) = owner.strip_prefix(AGENT_OWNER_PREFIX) {
        // A page agents opened is theirs alone, and only while the switch
        // that let them is on.
        return opener == scope_key(scope) && lent(opener);
    }
    match scope {
        // The tabs the person handed over included: handing one over is the
        // person saying so, to the agents of this app first.
        None => true,
        Some(window) => owner == window || (owner == OWNER && lent(window)),
    }
}

/// Whether `raw_url`, opened by an agent of `scope`, goes to the person's
/// Chrome rather than the built-in browser.
///
/// Loopback and private-network addresses stay in the built-in browser. A
/// remote window's agents mean their server's own (its dev servers, which
/// that window's tabs reach through the server), never this computer's; and
/// a dev server on this computer needs none of the person's sign-ins.
pub fn opens_in_chrome(lending: &ChromeLending, scope: &str, raw_url: &str) -> bool {
    lending.is_lent(scope)
        && Url::parse(raw_url)
            .ok()
            .is_some_and(|url| matches!(url.scheme(), "http" | "https") && !is_local_address(&url))
}

fn is_local_address(url: &Url) -> bool {
    use std::net::{Ipv4Addr, Ipv6Addr};
    use url::Host;
    // 100.64.0.0/10: carrier-grade NAT, and the addresses of a tailnet.
    let shared = |ip: &Ipv4Addr| ip.octets()[0] == 100 && (ip.octets()[1] & 0xc0) == 64;
    let private = |ip: &Ipv4Addr| {
        ip.is_loopback() || ip.is_private() || ip.is_link_local() || ip.is_unspecified() || shared(ip)
    };
    let unique_local =
        |ip: &Ipv6Addr| (ip.segments()[0] & 0xfe00) == 0xfc00 || (ip.segments()[0] & 0xffc0) == 0xfe80;
    match url.host() {
        Some(Host::Domain(name)) => {
            let name = name.trim_end_matches('.').to_ascii_lowercase();
            name == "localhost"
                || !name.contains('.')
                || [".localhost", ".local", ".internal", ".lan", ".home.arpa"]
                    .iter()
                    .any(|suffix| name.ends_with(suffix))
        }
        Some(Host::Ipv4(ip)) => private(&ip),
        Some(Host::Ipv6(ip)) => {
            ip.is_loopback()
                || ip.is_unspecified()
                || unique_local(&ip)
                || ip.to_ipv4_mapped().as_ref().is_some_and(private)
        }
        None => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lending(scopes: &[&str]) -> ChromeLending {
        let lending = ChromeLending::default();
        for scope in scopes {
            lending.set(scope, true);
        }
        lending
    }

    const REMOTE: &str = "remote-workspace-7";

    #[test]
    fn the_app_s_own_tabs_reach_whom_they_always_did() {
        let lending = lending(&[]);
        assert!(reaches(Some(&lending), "main", None));
        assert!(reaches(Some(&lending), REMOTE, Some(REMOTE)));
        assert!(!reaches(Some(&lending), "main", Some(REMOTE)));
        assert!(!reaches(Some(&lending), "remote-workspace-8", Some(REMOTE)));
    }

    #[test]
    fn a_handed_over_tab_reaches_a_remote_window_only_while_it_is_lent() {
        assert!(reaches(Some(&lending(&[])), OWNER, None));
        assert!(!reaches(Some(&lending(&[])), OWNER, Some(REMOTE)));
        assert!(!reaches(None, OWNER, Some(REMOTE)));
        assert!(reaches(Some(&lending(&[REMOTE])), OWNER, Some(REMOTE)));
        assert!(!reaches(Some(&lending(&[REMOTE])), OWNER, Some("remote-workspace-8")));
    }

    #[test]
    fn a_page_agents_opened_is_theirs_alone() {
        let both = lending(&[LOCAL_SCOPE, REMOTE]);
        let remote_page = agent_owner(REMOTE);
        assert!(reaches(Some(&both), &remote_page, Some(REMOTE)));
        assert!(!reaches(Some(&both), &remote_page, None));
        assert!(!reaches(Some(&both), &remote_page, Some("remote-workspace-8")));
        let local_page = agent_owner(LOCAL_SCOPE);
        assert!(reaches(Some(&both), &local_page, None));
        assert!(!reaches(Some(&both), &local_page, Some(REMOTE)));
        // …and only while their switch is on.
        assert!(!reaches(Some(&lending(&[])), &remote_page, Some(REMOTE)));
        let switched_off = lending(&[REMOTE]);
        switched_off.set(REMOTE, false);
        assert!(!reaches(Some(&switched_off), &remote_page, Some(REMOTE)));
    }

    #[test]
    fn the_app_s_own_agents_are_the_local_scope() {
        assert_eq!(scope_key(None), LOCAL_SCOPE);
        assert_eq!(scope_key(Some(REMOTE)), REMOTE);
        assert_eq!(agent_owner(REMOTE), "chrome@remote-workspace-7");
    }

    #[test]
    fn web_addresses_go_to_chrome_and_local_ones_stay_in_the_built_in_browser() {
        let lent = lending(&[REMOTE]);
        for address in ["https://example.com/", "http://news.example.org/a?b"] {
            assert!(opens_in_chrome(&lent, REMOTE, address), "{address}");
        }
        for address in [
            "http://localhost:3000/",
            "http://app.localhost/",
            "http://127.0.0.1:8080/",
            "http://[::1]:5173/",
            "http://[::ffff:192.168.0.3]/",
            "http://192.168.1.10/",
            "http://10.0.0.2/",
            "http://100.64.0.7:3080/",
            "http://devbox/",
            "http://printer.local/",
            "file:///etc/hosts",
            "not an address",
        ] {
            assert!(!opens_in_chrome(&lent, REMOTE, address), "{address}");
        }
        // Not lent: nothing goes there.
        assert!(!opens_in_chrome(&lent, LOCAL_SCOPE, "https://example.com/"));
    }
}
