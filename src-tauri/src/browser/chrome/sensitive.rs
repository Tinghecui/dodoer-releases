//! The sites agents may not use in the person's own Chrome, whoever opened
//! the tab (`docs/agent-chrome.md` sections 5.5 and 13.3).
//!
//! Every page an agent opens in that Chrome carries the person's sign-ins, so
//! "only the tabs the agent opened" stops nothing on its own: such a tab can
//! open their mail as easily as anything else. This list is what does. It
//! stops agents only — the person browses these sites in Chrome as ever, and
//! nothing here is consulted for the built-in browser, whose tabs have none
//! of the person's sign-ins.
//!
//! [`DEFAULT_SITES`] is mail, payments, banks, password managers and the
//! account pages that reset all of those. The person edits it in Settings
//! ([`SiteEdits`]): sites they add (`blocked`) and default entries they let
//! agents use after all (`allowed`). What is kept off is
//! `(DEFAULT_SITES - allowed) ∪ blocked`, every entry matched by host with
//! its subdomains. The edits live in `chrome-sites.json` in the app's data
//! directory, not in a window's storage: the list is about the Chrome on this
//! computer, whichever window or server an agent works for, and it holds from
//! the moment the app starts.
//!
//! Pure rules and a file, compiled in both runtimes for the sake of their
//! tests; the desktop app is their only user.

use std::path::Path;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use url::Url;

/// The file the person's edits are kept in, in the app's data directory.
pub const SITES_FILE: &str = "chrome-sites.json";

/// Longest a host name can be (RFC 1035).
const MAX_HOST_LEN: usize = 253;

pub const DEFAULT_SITES: &[&str] = &[
    // Mail.
    "mail.google.com",
    "outlook.live.com",
    "outlook.office.com",
    "outlook.office365.com",
    "mail.yahoo.com",
    "mail.proton.me",
    "icloud.com",
    "mail.qq.com",
    "exmail.qq.com",
    "mail.163.com",
    "mail.126.com",
    "mail.yeah.net",
    "mail.sina.com.cn",
    "mail.aliyun.com",
    "qiye.aliyun.com",
    // Payments.
    "paypal.com",
    "alipay.com",
    "pay.weixin.qq.com",
    "tenpay.com",
    "wise.com",
    // Passwords, and the accounts that reset everything else.
    "1password.com",
    "bitwarden.com",
    "lastpass.com",
    "passwords.google.com",
    "myaccount.google.com",
    "account.apple.com",
    "appleid.apple.com",
    "account.microsoft.com",
    // Banks.
    "icbc.com.cn",
    "ccb.com",
    "abchina.com",
    "boc.cn",
    "bankcomm.com",
    "cmbchina.com",
    "psbc.com",
    "citicbank.com",
    "cebbank.com",
    "cib.com.cn",
    "spdb.com.cn",
    "cmbc.com.cn",
    "pingan.com",
    "hxb.com.cn",
    "cgbchina.com.cn",
    "hsbc.com",
    "hsbc.com.hk",
    "chase.com",
    "bankofamerica.com",
    "wellsfargo.com",
    "citi.com",
    // Exchanges.
    "binance.com",
    "okx.com",
    "coinbase.com",
];

/// The person's changes to [`DEFAULT_SITES`], as `chrome-sites.json` keeps
/// them. Always normalized ([`SiteEdits::normalized`]) once read or set.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct SiteEdits {
    /// Sites the person keeps agents off besides the defaults.
    pub blocked: Vec<String>,
    /// Entries of [`DEFAULT_SITES`] the person lets agents use after all.
    pub allowed: Vec<String>,
}

impl SiteEdits {
    /// Every entry as a bare host name ([`normalize_site`]), each once, in
    /// the order given. What is not a host name is dropped. `allowed` keeps
    /// only entries of the default list — nothing else is there to let go
    /// of. A default entry the person adds to `blocked` is kept off again:
    /// it leaves `allowed`, and `blocked`, which it would only repeat.
    pub fn normalized(&self) -> SiteEdits {
        let blocked = normalize_all(&self.blocked);
        let allowed = normalize_all(&self.allowed)
            .into_iter()
            .filter(|site| is_default(site) && !blocked.contains(site))
            .collect();
        let blocked = blocked
            .into_iter()
            .filter(|site| !is_default(site))
            .collect();
        SiteEdits { blocked, allowed }
    }

    /// Whether agents are kept off `host`: on a default entry the person did
    /// not let go of, or on one they added — the site itself or any of its
    /// subdomains.
    pub fn blocks_host(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        let kept_default = DEFAULT_SITES
            .iter()
            .filter(|site| !self.allowed.iter().any(|allowed| allowed == *site))
            .any(|site| covers(site, &host));
        kept_default || self.blocked.iter().any(|site| covers(site, &host))
    }

    /// [`SiteEdits::blocks_host`] for the host of `url`; an address with no
    /// host is none of these sites.
    pub fn blocks_url(&self, url: &Url) -> bool {
        url.host_str().is_some_and(|host| self.blocks_host(host))
    }

    /// Read the edits from `path`. No file is no edits; a file that cannot be
    /// read or is not this shape is no edits too — the default list, with a
    /// warning in the log — rather than no list at all.
    pub fn load_from(path: &Path) -> SiteEdits {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return SiteEdits::default();
            }
            Err(err) => {
                tracing::warn!("[chrome] could not read {}: {err}", path.display());
                return SiteEdits::default();
            }
        };
        match serde_json::from_str::<SiteEdits>(&raw) {
            Ok(edits) => edits.normalized(),
            Err(err) => {
                tracing::warn!("[chrome] {} is not a site list: {err}", path.display());
                SiteEdits::default()
            }
        }
    }

    /// Write the edits to `path`, whole: a new file renamed over the old one,
    /// so a crash halfway leaves the old list rather than half of the new.
    pub fn save_to(&self, path: &Path) -> std::io::Result<()> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_string_pretty(self).map_err(std::io::Error::other)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, json)?;
        std::fs::rename(&tmp, path)
    }
}

/// `input` as the bare host name a site is listed under: lower case, no
/// trailing dot, no leading `*.` (subdomains are always included), and
/// without what an address copied from the address bar carries besides —
/// scheme, sign-in, port, path, query. `None` when no host name is left.
pub fn normalize_site(input: &str) -> Option<String> {
    let trimmed = input.trim_matches(|c: char| c.is_ascii_whitespace());
    let trimmed = trimmed.strip_prefix("*.").unwrap_or(trimmed);
    if trimmed.is_empty() {
        return None;
    }
    let address = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    let url = Url::parse(&address).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let host = url.host_str()?.trim_end_matches('.').to_ascii_lowercase();
    if host.is_empty() || host.len() > MAX_HOST_LEN || host.starts_with('.') {
        return None;
    }
    Some(host)
}

fn normalize_all(sites: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for site in sites
        .iter()
        .filter_map(|site| normalize_site(site.as_str()))
    {
        if !out.contains(&site) {
            out.push(site);
        }
    }
    out
}

fn is_default(site: &str) -> bool {
    DEFAULT_SITES.contains(&site)
}

/// Whether the entry `site` covers `host`: the same host, or a subdomain.
fn covers(site: &str, host: &str) -> bool {
    host == site
        || host
            .strip_suffix(site)
            .is_some_and(|rest| rest.ends_with('.'))
}

/// The edits in force, read from the data directory on first use.
static CURRENT: RwLock<Option<SiteEdits>> = RwLock::new(None);

/// The person's edits in force.
pub fn current() -> SiteEdits {
    if let Some(edits) = CURRENT.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
        return edits.clone();
    }
    let mut slot = CURRENT.write().unwrap_or_else(|p| p.into_inner());
    slot.get_or_insert_with(|| SiteEdits::load_from(&crate::paths::codeg_chrome_sites_path()))
        .clone()
}

/// Keep `edits` (normalized) in the data directory and put them in force at
/// once. Answers with what was kept.
pub fn set_current(edits: &SiteEdits) -> std::io::Result<SiteEdits> {
    let edits = edits.normalized();
    let mut slot = CURRENT.write().unwrap_or_else(|p| p.into_inner());
    edits.save_to(&crate::paths::codeg_chrome_sites_path())?;
    *slot = Some(edits.clone());
    Ok(edits)
}

/// Whether agents are kept off `host` in the person's Chrome.
pub fn is_sensitive_host(host: &str) -> bool {
    current().blocks_host(host)
}

/// [`is_sensitive_host`] for the host of `url`; an address with no host is
/// none of these sites.
pub fn is_sensitive(url: &Url) -> bool {
    url.host_str().is_some_and(is_sensitive_host)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn edits(blocked: &[&str], allowed: &[&str]) -> SiteEdits {
        SiteEdits {
            blocked: blocked.iter().map(|s| s.to_string()).collect(),
            allowed: allowed.iter().map(|s| s.to_string()).collect(),
        }
        .normalized()
    }

    #[test]
    fn a_listed_site_and_its_subdomains_are_sensitive() {
        let none = SiteEdits::default();
        assert!(none.blocks_host("mail.google.com"));
        assert!(none.blocks_host("www.icbc.com.cn"));
        assert!(none.blocks_host("MAIL.QQ.COM."));
        assert!(none.blocks_url(&Url::parse("https://www.paypal.com/signin?x=1").unwrap()));
    }

    #[test]
    fn a_site_that_merely_ends_in_the_same_letters_is_not() {
        let none = SiteEdits::default();
        assert!(!none.blocks_host("notpaypal.com"));
        assert!(!none.blocks_host("paypal.com.example"));
        assert!(!none.blocks_host("docs.google.com"));
        assert!(!none.blocks_host("qq.com"));
        assert!(!is_sensitive(&Url::parse("data:text/html,hi").unwrap()));
    }

    #[test]
    fn the_rule_is_the_defaults_less_the_allowed_plus_the_blocked() {
        let list = edits(&["example.com"], &["mail.163.com"]);
        assert!(list.blocks_host("example.com"));
        assert!(list.blocks_host("shop.example.com"));
        assert!(!list.blocks_host("myexample.com"));
        assert!(!list.blocks_host("mail.163.com"));
        assert!(!list.blocks_host("www.mail.163.com"));
        // The other defaults stay.
        assert!(list.blocks_host("mail.126.com"));
        assert!(list.blocks_host("paypal.com"));
    }

    #[test]
    fn letting_go_of_a_default_does_not_let_go_of_a_wider_entry() {
        // `icloud.com` covers `www.icloud.com`; allowing a host that is not
        // an entry of its own changes nothing.
        let list = edits(&[], &["www.icloud.com"]);
        assert!(list.allowed.is_empty());
        assert!(list.blocks_host("www.icloud.com"));
    }

    #[test]
    fn blocking_a_default_again_takes_it_off_the_allowed() {
        let list = edits(&["mail.163.com"], &["mail.163.com", "paypal.com"]);
        assert_eq!(list.allowed, vec!["paypal.com".to_string()]);
        assert!(list.blocked.is_empty());
        assert!(list.blocks_host("mail.163.com"));
        assert!(!list.blocks_host("paypal.com"));
    }

    #[test]
    fn entries_are_normalized_and_kept_once() {
        let list = edits(
            &[
                "https://Example.com/path?q=1",
                "example.com.",
                "*.intranet.example",
                "user@admin.example:8443/x",
                "  shop.example  ",
                "",
                "not a host",
                "ftp://files.example",
            ],
            &["PayPal.com", "unknown.example"],
        );
        assert_eq!(
            list.blocked,
            vec![
                "example.com",
                "intranet.example",
                "admin.example",
                "shop.example"
            ]
        );
        assert_eq!(list.allowed, vec!["paypal.com"]);
    }

    #[test]
    fn normalize_site_rejects_what_has_no_host() {
        assert_eq!(
            normalize_site("Mail.Example.COM").as_deref(),
            Some("mail.example.com")
        );
        assert_eq!(
            normalize_site("http://a.example:80/").as_deref(),
            Some("a.example")
        );
        assert_eq!(normalize_site("*."), None);
        assert_eq!(normalize_site("   "), None);
        assert_eq!(normalize_site("file:///etc/hosts"), None);
        assert_eq!(normalize_site(&"a".repeat(300)), None);
    }

    #[test]
    fn no_file_or_a_broken_one_is_the_default_list() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(SITES_FILE);
        assert_eq!(SiteEdits::load_from(&path), SiteEdits::default());
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(SiteEdits::load_from(&path), SiteEdits::default());
        std::fs::write(&path, r#"{"blocked": 3}"#).unwrap();
        assert_eq!(SiteEdits::load_from(&path), SiteEdits::default());
        assert!(SiteEdits::load_from(&path).blocks_host("mail.google.com"));
    }

    #[test]
    fn edits_survive_a_save_and_a_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(SITES_FILE);
        let list = edits(&["example.com"], &["mail.163.com"]);
        list.save_to(&path).unwrap();
        assert_eq!(SiteEdits::load_from(&path), list);
        // A file written by hand is normalized on the way in; a missing key
        // is an empty list.
        std::fs::write(&path, r#"{"blocked": ["HTTPS://Shop.Example/"]}"#).unwrap();
        assert_eq!(SiteEdits::load_from(&path), edits(&["shop.example"], &[]));
    }
}
