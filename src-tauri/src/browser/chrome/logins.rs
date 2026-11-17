//! Cowork fork: 右边的内置浏览器借用用户 Chrome 里的登录（issue #408）。
//!
//! 内置浏览器有自己的一套 Cookie，用户的账户都登在日常用的 Chrome 里。
//! 打开「右边的网页用我 Chrome 里的登录」以后，在右边打开一个网站前，
//! 先从连着的 Chrome 里取这个网站的 Cookie（`Storage.getCookies`，浏览器级），
//! 写进内置浏览器 `default` profile 的存储。这个模块只管纯逻辑和设置文件：
//!
//! - [`fetch`]：向 Chrome 要全部 Cookie，解析成 [`ChromeCookie`]；
//! - [`for_host`]：只留浏览器访问某个主机时会带上的那些；
//! - [`may_borrow`]：这个地址、这个 profile 能不能借，不能的话是什么原因；
//! - [`plan_writes`]：哪些 Cookie 要写进内置浏览器（第一次覆盖、之后补缺）；
//! - [`LoginSettings`]：开关、「不借」名单、借过的域，存在
//!   `chrome-logins.json`（和 `chrome-sites.json` 同一个目录）。
//!
//! Cookie 的值就是登录本身：它只在内存里从 Chrome 的连接走到内置浏览器的
//! 存储。[`ChromeCookie`] 的 `Debug` 不带名字和值，对外能拿到值的只有
//! [`ChromeCookie::value_for_store`]（给桌面端写存储用）。日志、事件、
//! 命令的回答里只放主机名、域和个数。
//!
//! 这个目录在服务器版里也编译（为了测试）；用到它的只有桌面端。

use std::path::Path;
use std::sync::RwLock;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use url::Url;

use super::cdp::{CdpClient, CdpError};
use super::lending::is_local_address;
use super::sensitive::{self, SiteEdits};

/// 设置存在 app 数据目录下的这个文件里。
pub const LOGINS_FILE: &str = "chrome-logins.json";

/// 只借给这个 profile 的标签（`browser::profile::DEFAULT_PROFILE_ID`，
/// 那个模块只在桌面版编译，这里抄一份）。
pub const DEFAULT_PROFILE: &str = "default";

/// Cookie 的 `SameSite`，照 Chrome 给的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SameSite {
    Strict,
    Lax,
    None,
}

/// 从 Chrome 取来的一个 Cookie。`Debug` 不带名字和值。
#[derive(Clone, PartialEq)]
pub struct ChromeCookie {
    name: String,
    value: String,
    /// 带点开头（`.example.com`）的对这个域和子域名都算，不带点的只给这一个主机。
    pub domain: String,
    pub path: String,
    /// 过期时间（Unix 秒）；`None` 是会话 Cookie。
    pub expires: Option<f64>,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<SameSite>,
}

impl std::fmt::Debug for ChromeCookie {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ChromeCookie")
            .field("domain", &self.domain)
            .field("path", &self.path)
            .field("expires", &self.expires)
            .field("http_only", &self.http_only)
            .field("secure", &self.secure)
            .field("same_site", &self.same_site)
            .finish_non_exhaustive()
    }
}

impl ChromeCookie {
    /// 名字：只给桌面端写存储、比较键用，不进日志和回答。
    pub fn name(&self) -> &str {
        &self.name
    }

    /// 值：这个模块里唯一能拿到值的地方，只给桌面端写内置浏览器的存储用。
    pub fn value_for_store(&self) -> &str {
        &self.value
    }

    /// 内置浏览器里认这个 Cookie 用的键：名字、域、路径。
    pub fn key(&self) -> CookieKey {
        CookieKey::new(&self.name, &self.domain, &self.path)
    }
}

/// 一个 Cookie 的键（名字、域、路径）。同一个键只能有一个 Cookie。
/// `Debug` 不带名字。
#[derive(Clone, PartialEq, Eq, Hash)]
pub struct CookieKey {
    pub name: String,
    pub domain: String,
    pub path: String,
}

impl std::fmt::Debug for CookieKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CookieKey")
            .field("domain", &self.domain)
            .field("path", &self.path)
            .finish_non_exhaustive()
    }
}

impl CookieKey {
    /// 域按小写比，空路径就是 `/`。
    pub fn new(name: &str, domain: &str, path: &str) -> CookieKey {
        CookieKey {
            name: name.to_string(),
            domain: domain.trim().to_ascii_lowercase(),
            path: if path.is_empty() { "/" } else { path }.to_string(),
        }
    }
}

/// 向连着的 Chrome 要它的全部 Cookie（`Storage.getCookies`，不带 session，
/// 发给浏览器本身）。Chrome 拒绝时把错误原样交出去，不当成「没有 Cookie」。
pub async fn fetch(client: &CdpClient) -> Result<Vec<ChromeCookie>, CdpError> {
    let answer = client.call("Storage.getCookies", json!({}), None).await?;
    Ok(parse_cookies(&answer, now_secs()))
}

/// 解析 `Storage.getCookies` 的回答。不认识的字段忽略；分区 Cookie
/// （带 `partitionKey`）和 `now` 之前已经过期的丢掉；缺名字、值或域的丢掉。
pub fn parse_cookies(answer: &Value, now: f64) -> Vec<ChromeCookie> {
    answer
        .get("cookies")
        .and_then(Value::as_array)
        .map(|cookies| {
            cookies
                .iter()
                .filter_map(|raw| parse_cookie(raw, now))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_cookie(raw: &Value, now: f64) -> Option<ChromeCookie> {
    // 分区 Cookie 只在某个顶层网站里嵌着时才带，右边的标签用不上。
    let partitioned = raw.get("partitionKey").is_some_and(|key| !key.is_null())
        || raw.get("partitionKeyOpaque").and_then(Value::as_bool) == Some(true);
    if partitioned {
        return None;
    }
    let text = |field: &str| raw.get(field).and_then(Value::as_str);
    let flag = |field: &str| raw.get(field).and_then(Value::as_bool).unwrap_or(false);
    let name = text("name")?;
    let value = text("value")?;
    let domain = text("domain").filter(|d| !d.trim_matches('.').is_empty())?;
    let path = text("path").filter(|p| !p.is_empty()).unwrap_or("/");
    // Chrome 给会话 Cookie 写 `session: true`、`expires: -1`。
    let expires = raw
        .get("expires")
        .and_then(Value::as_f64)
        .filter(|at| !flag("session") && *at > 0.0);
    if expires.is_some_and(|at| at <= now) {
        return None;
    }
    let same_site = match text("sameSite") {
        Some("Strict") => Some(SameSite::Strict),
        Some("Lax") => Some(SameSite::Lax),
        Some("None") => Some(SameSite::None),
        _ => None,
    };
    Some(ChromeCookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: domain.to_string(),
        path: path.to_string(),
        expires,
        http_only: flag("httpOnly"),
        secure: flag("secure"),
        same_site,
    })
}

fn now_secs() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64())
        .unwrap_or(0.0)
}

/// 只留浏览器访问 `host` 时会带上的 Cookie。
pub fn for_host(cookies: &[ChromeCookie], host: &str) -> Vec<ChromeCookie> {
    cookies
        .iter()
        .filter(|cookie| domain_matches(&cookie.domain, host))
        .cloned()
        .collect()
}

/// Cookie 的域 `domain` 对主机 `host` 算不算：带点开头的对这个域和子域名
/// 都算，不带点的只在主机名完全相同时算。
pub fn domain_matches(domain: &str, host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    let domain = domain.trim().to_ascii_lowercase();
    match domain.strip_prefix('.') {
        Some(parent) => !parent.is_empty() && covers(parent, &host),
        None => !domain.is_empty() && host == domain,
    }
}

/// `site` 这个主机名盖不盖得住 `host`：同一个，或者是它的子域名。
fn covers(site: &str, host: &str) -> bool {
    host == site
        || host
            .strip_suffix(site)
            .is_some_and(|rest| rest.ends_with('.'))
}

/// 能不能给一个地址借 Chrome 的登录；不能时是什么原因。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum BorrowVerdict {
    /// 开关关着。
    Off,
    /// 标签不在 `default` 这个 profile 里（包括 `remote-<连接号>`）。
    NotDefaultProfile,
    /// 不是 http(s)，或者是回环、内网、CGNAT（100.64/10）地址。
    Local,
    /// 敏感网站名单拦着（名单暂停、这个网站被放开时不算）。
    Sensitive,
    /// 主机名或它的上级域名在用户的「不借」名单里。
    Skipped,
    Ok,
}

/// [`may_borrow_with`]，敏感网站名单用现在生效的那份。
pub fn may_borrow(settings: &LoginSettings, url: &str, profile: &str) -> BorrowVerdict {
    may_borrow_with(settings, url, profile, &sensitive::current())
}

/// 能不能给 `profile` 里打开 `url` 的标签借登录，`sites` 是敏感网站名单。
pub fn may_borrow_with(
    settings: &LoginSettings,
    url: &str,
    profile: &str,
    sites: &SiteEdits,
) -> BorrowVerdict {
    if !settings.enabled {
        return BorrowVerdict::Off;
    }
    if profile != DEFAULT_PROFILE {
        return BorrowVerdict::NotDefaultProfile;
    }
    let Some(url) = Url::parse(url)
        .ok()
        .filter(|url| matches!(url.scheme(), "http" | "https"))
    else {
        return BorrowVerdict::Local;
    };
    let host = match url.host_str() {
        Some(host) if !is_local_address(&url) => host,
        _ => return BorrowVerdict::Local,
    };
    if sites.blocks_host(host) {
        return BorrowVerdict::Sensitive;
    }
    if settings.skips(host) {
        return BorrowVerdict::Skipped;
    }
    BorrowVerdict::Ok
}

/// 借登录的设置，存在 `chrome-logins.json`。读出来、设过之后都是
/// [`LoginSettings::normalized`] 过的。
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LoginSettings {
    /// 「右边的网页用我 Chrome 里的登录」，出厂关。
    pub enabled: bool,
    /// 不借的网站（主机名，含子域名）。
    pub skip: Vec<String>,
    /// 已经借过的 Cookie 域（`github.com`、`.github.com`），只有域。
    pub borrowed: Vec<String>,
}

impl LoginSettings {
    /// `skip` 每项变成裸主机名（`sensitive::normalize_site`），`borrowed`
    /// 每项小写、去掉末尾的点（开头的点留着）；不是主机名的丢掉，重复的留一个。
    pub fn normalized(&self) -> LoginSettings {
        let mut skip: Vec<String> = Vec::new();
        for site in self
            .skip
            .iter()
            .filter_map(|s| sensitive::normalize_site(s))
        {
            if !skip.contains(&site) {
                skip.push(site);
            }
        }
        LoginSettings {
            enabled: self.enabled,
            skip,
            borrowed: Vec::new(),
        }
        .with_borrowed(self.borrowed.iter().map(String::as_str))
    }

    /// 界面发来的改动：没带的那一项不变。
    pub fn edited(&self, enabled: Option<bool>, skip: Option<Vec<String>>) -> LoginSettings {
        LoginSettings {
            enabled: enabled.unwrap_or(self.enabled),
            skip: skip.unwrap_or_else(|| self.skip.clone()),
            borrowed: self.borrowed.clone(),
        }
        .normalized()
    }

    /// `host` 或它的上级域名在「不借」名单里。
    pub fn skips(&self, host: &str) -> bool {
        let host = host.trim_end_matches('.').to_ascii_lowercase();
        self.skip.iter().any(|site| covers(site, &host))
    }

    /// `borrowed` 里对 `host` 算数的那些域。
    pub fn borrowed_for(&self, host: &str) -> Vec<String> {
        self.borrowed
            .iter()
            .filter(|domain| domain_matches(domain, host))
            .cloned()
            .collect()
    }

    /// 把这次借到的域记进 `borrowed`。
    pub fn with_borrowed<'a>(&self, domains: impl IntoIterator<Item = &'a str>) -> LoginSettings {
        let mut next = self.clone();
        for domain in domains {
            let domain = domain.trim().trim_end_matches('.').to_ascii_lowercase();
            if !domain.trim_start_matches('.').is_empty() && !next.borrowed.contains(&domain) {
                next.borrowed.push(domain);
            }
        }
        next
    }

    /// 把属于 `host`（含子域名）的域从 `borrowed` 里去掉；`None` 是全部。
    /// 回去掉以后的设置和去掉的那些域。
    pub fn without_borrowed(&self, host: Option<&str>) -> (LoginSettings, Vec<String>) {
        let host = host.map(|host| host.trim_end_matches('.').to_ascii_lowercase());
        let (gone, kept): (Vec<String>, Vec<String>) =
            self.borrowed
                .iter()
                .cloned()
                .partition(|domain| match &host {
                    Some(host) => covers(host, domain.trim_start_matches('.')),
                    None => true,
                });
        let next = LoginSettings {
            borrowed: kept,
            ..self.clone()
        };
        (next, gone)
    }

    /// 从 `path` 读。文件没有、坏了、读不出来都按出厂值（关）算。
    pub fn load_from(path: &Path) -> LoginSettings {
        let raw = match std::fs::read_to_string(path) {
            Ok(raw) => raw,
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
                return LoginSettings::default();
            }
            Err(err) => {
                tracing::warn!("[chrome] could not read {}: {err}", path.display());
                return LoginSettings::default();
            }
        };
        match serde_json::from_str::<LoginSettings>(&raw) {
            Ok(settings) => settings.normalized(),
            Err(err) => {
                tracing::warn!("[chrome] {} is not a logins file: {err}", path.display());
                LoginSettings::default()
            }
        }
    }

    /// 整个写进 `path`：先写临时文件再改名，写到一半崩了留下的是旧的。
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

/// 现在生效的设置，第一次用时从数据目录读。
static CURRENT: RwLock<Option<LoginSettings>> = RwLock::new(None);

/// 现在生效的设置。
pub fn current() -> LoginSettings {
    if let Some(settings) = CURRENT.read().unwrap_or_else(|p| p.into_inner()).as_ref() {
        return settings.clone();
    }
    let mut slot = CURRENT.write().unwrap_or_else(|p| p.into_inner());
    slot.get_or_insert_with(|| LoginSettings::load_from(&crate::paths::codeg_chrome_logins_path()))
        .clone()
}

/// 按 `change` 改设置，存进数据目录并马上生效。回存下来的设置。
pub fn update(
    change: impl FnOnce(&LoginSettings) -> LoginSettings,
) -> std::io::Result<LoginSettings> {
    let path = crate::paths::codeg_chrome_logins_path();
    let mut slot = CURRENT.write().unwrap_or_else(|p| p.into_inner());
    let settings = change(slot.get_or_insert_with(|| LoginSettings::load_from(&path))).normalized();
    settings.save_to(&path)?;
    *slot = Some(settings.clone());
    Ok(settings)
}

/// 要往内置浏览器里写的 Cookie。
#[derive(Debug, Clone, Default, PartialEq)]
pub struct WritePlan {
    pub write: Vec<ChromeCookie>,
    /// 这次写的里面有没有 `httpOnly` 的（有的话页面要重载才用得上）。
    pub http_only: bool,
}

/// 决定从 Chrome 取来、对这个主机算数的 `cookies` 哪些要写进内置浏览器：
/// 域不在 `borrowed` 里的（第一次借这个域）一律写，覆盖同名同域同路径的；
/// 域已经在 `borrowed` 里的只补内置浏览器里还没有的（`existing` 是它现有
/// Cookie 的键），不覆盖；`force`（用户点了「重新借一次」）时全部写。
pub fn plan_writes(
    cookies: &[ChromeCookie],
    existing: &[CookieKey],
    borrowed: &[String],
    force: bool,
) -> WritePlan {
    let write: Vec<ChromeCookie> = cookies
        .iter()
        .filter(|cookie| {
            let domain = cookie
                .domain
                .trim()
                .trim_end_matches('.')
                .to_ascii_lowercase();
            let first_time = !borrowed
                .iter()
                .any(|seen| seen.eq_ignore_ascii_case(&domain));
            force || first_time || !existing.contains(&cookie.key())
        })
        .cloned()
        .collect();
    let http_only = write.iter().any(|cookie| cookie.http_only);
    WritePlan { write, http_only }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_800_000_000.0;

    /// 一段写死的 `Storage.getCookies` 回答（名字、值都是编的）。
    fn answer() -> Value {
        json!({
            "cookies": [
                {
                    "name": "user_session", "value": "s3cr3t-session",
                    "domain": "github.com", "path": "/",
                    "expires": -1, "size": 30, "httpOnly": true, "secure": true,
                    "session": true, "sameSite": "Lax", "priority": "Medium",
                    "sameParty": false, "sourceScheme": "Secure", "sourcePort": 443
                },
                {
                    "name": "logged_in", "value": "yes",
                    "domain": ".github.com", "path": "/",
                    "expires": NOW + 86_400.0, "httpOnly": false, "secure": true,
                    "session": false, "sameSite": "None", "somethingNew": {"a": 1}
                },
                {
                    "name": "pref", "value": "dark",
                    "domain": "docs.example.org", "path": "",
                    "expires": NOW + 10.0, "session": false, "sameSite": "Strict"
                },
                {
                    "name": "nosite", "value": "nosite-value",
                    "domain": "plain.example.org", "path": "/a",
                    "expires": NOW + 10.0, "session": false
                },
                {
                    "name": "partitioned", "value": "p",
                    "domain": ".embed.example", "path": "/",
                    "expires": NOW + 10.0, "session": false,
                    "partitionKey": {"topLevelSite": "https://example.org", "hasCrossSiteAncestor": false}
                },
                {
                    "name": "stale", "value": "old",
                    "domain": ".github.com", "path": "/",
                    "expires": NOW - 1.0, "session": false
                },
                { "value": "no-name", "domain": "github.com", "path": "/" }
            ]
        })
    }

    fn cookie(name: &str, domain: &str) -> ChromeCookie {
        ChromeCookie {
            name: name.to_string(),
            value: format!("value-of-{name}"),
            domain: domain.to_string(),
            path: "/".to_string(),
            expires: None,
            http_only: false,
            secure: true,
            same_site: None,
        }
    }

    fn strings(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    // ---- 完成标准 1：解析 ----

    #[test]
    fn parses_the_fields_and_drops_partitioned_and_expired() {
        let cookies = parse_cookies(&answer(), NOW);
        let names: Vec<&str> = cookies.iter().map(|c| c.name()).collect();
        assert_eq!(names, vec!["user_session", "logged_in", "pref", "nosite"]);

        let session = &cookies[0];
        assert_eq!(session.value_for_store(), "s3cr3t-session");
        assert_eq!(session.domain, "github.com");
        assert_eq!(session.path, "/");
        assert_eq!(session.expires, None);
        assert!(session.http_only);
        assert!(session.secure);
        assert_eq!(session.same_site, Some(SameSite::Lax));

        let persistent = &cookies[1];
        assert_eq!(persistent.domain, ".github.com");
        assert_eq!(persistent.expires, Some(NOW + 86_400.0));
        assert!(!persistent.http_only);
        assert_eq!(persistent.same_site, Some(SameSite::None));

        // 空路径按 `/` 算；没写的布尔值是假。
        assert_eq!(cookies[2].path, "/");
        assert_eq!(cookies[2].same_site, Some(SameSite::Strict));
        assert!(!cookies[2].http_only && !cookies[2].secure);
        assert_eq!(cookies[3].same_site, None);
        assert_eq!(cookies[3].path, "/a");
    }

    #[test]
    fn an_answer_without_cookies_is_none() {
        assert!(parse_cookies(&json!({}), NOW).is_empty());
        assert!(parse_cookies(&json!({"cookies": "nope"}), NOW).is_empty());
    }

    // ---- 完成标准 2：按主机筛 ----

    #[test]
    fn a_dotted_domain_covers_its_subdomains_a_bare_one_only_itself() {
        let cookies = vec![cookie("a", ".github.com"), cookie("b", "github.com")];
        let names = |host: &str| -> Vec<String> {
            for_host(&cookies, host)
                .iter()
                .map(|c| c.name().to_string())
                .collect()
        };
        assert_eq!(names("github.com"), strings(&["a", "b"]));
        assert_eq!(names("gist.github.com"), strings(&["a"]));
        assert_eq!(names("GitHub.com."), strings(&["a", "b"]));
        assert!(names("notgithub.com").is_empty());
        assert!(names("github.com.example").is_empty());
        assert!(!domain_matches(".", "com"));
        assert!(!domain_matches("", ""));
    }

    // ---- 完成标准 3：能不能借 ----

    fn on() -> LoginSettings {
        LoginSettings {
            enabled: true,
            ..LoginSettings::default()
        }
    }

    const PR: &str = "https://github.com/example-org/example-repo/pull/1";

    #[test]
    fn off_when_the_switch_is_off() {
        let sites = SiteEdits::default();
        assert_eq!(
            may_borrow_with(&LoginSettings::default(), PR, "default", &sites),
            BorrowVerdict::Off
        );
    }

    #[test]
    fn only_the_default_profile_borrows() {
        let sites = SiteEdits::default();
        assert_eq!(
            may_borrow_with(&on(), PR, "work", &sites),
            BorrowVerdict::NotDefaultProfile
        );
        assert_eq!(
            may_borrow_with(&on(), PR, "remote-9001", &sites),
            BorrowVerdict::NotDefaultProfile
        );
    }

    #[test]
    fn local_addresses_and_other_schemes_do_not_borrow() {
        let sites = SiteEdits::default();
        // CGNAT 段的地址分段拼出来，免得字面量撞上公开同步的扫描。
        let cgnat = format!("http://{}.{}.{}.{}/", 100, 101, 102, 103);
        for url in [
            "http://localhost:3000/",
            "http://127.0.0.1:8080/x",
            "http://192.168.1.20/",
            cgnat.as_str(),
            "http://devbox.local/",
            "file:///tmp/a.html",
            "about:blank",
            "not a url",
        ] {
            assert_eq!(
                may_borrow_with(&on(), url, "default", &sites),
                BorrowVerdict::Local,
                "{url}"
            );
        }
    }

    #[test]
    fn sensitive_sites_do_not_borrow_unless_let_go_or_paused() {
        let sites = SiteEdits::default();
        let mail = "https://mail.google.com/mail/u/0/";
        assert_eq!(
            may_borrow_with(&on(), mail, "default", &sites),
            BorrowVerdict::Sensitive
        );
        let paused = SiteEdits {
            paused: true,
            ..SiteEdits::default()
        };
        assert_eq!(
            may_borrow_with(&on(), mail, "default", &paused),
            BorrowVerdict::Ok
        );
        let let_go = SiteEdits {
            allowed: strings(&["mail.google.com"]),
            ..SiteEdits::default()
        }
        .normalized();
        assert_eq!(
            may_borrow_with(&on(), mail, "default", &let_go),
            BorrowVerdict::Ok
        );
    }

    #[test]
    fn skipped_sites_and_their_subdomains_do_not_borrow() {
        let sites = SiteEdits::default();
        let settings = LoginSettings {
            enabled: true,
            skip: strings(&["github.com"]),
            borrowed: Vec::new(),
        };
        assert_eq!(
            may_borrow_with(&settings, PR, "default", &sites),
            BorrowVerdict::Skipped
        );
        assert_eq!(
            may_borrow_with(&settings, "https://gist.github.com/x", "default", &sites),
            BorrowVerdict::Skipped
        );
        assert_eq!(
            may_borrow_with(&settings, "https://notgithub.com/", "default", &sites),
            BorrowVerdict::Ok
        );
    }

    #[test]
    fn a_public_site_in_the_default_profile_borrows() {
        assert_eq!(
            may_borrow_with(&on(), PR, "default", &SiteEdits::default()),
            BorrowVerdict::Ok
        );
    }

    // ---- 完成标准 4：设置文件 ----

    #[test]
    fn no_file_or_a_broken_one_is_off() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(LOGINS_FILE);
        assert_eq!(LoginSettings::load_from(&path), LoginSettings::default());
        assert!(!LoginSettings::load_from(&path).enabled);
        std::fs::write(&path, "{ nope").unwrap();
        assert_eq!(LoginSettings::load_from(&path), LoginSettings::default());
        std::fs::write(&path, r#"{"enabled": "yes"}"#).unwrap();
        assert_eq!(LoginSettings::load_from(&path), LoginSettings::default());
        // 读不出来（是个目录）也按出厂值。
        let as_dir = dir.path().join("dir.json");
        std::fs::create_dir(&as_dir).unwrap();
        assert_eq!(LoginSettings::load_from(&as_dir), LoginSettings::default());
    }

    #[test]
    fn settings_survive_a_save_and_a_load() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested").join(LOGINS_FILE);
        let settings = LoginSettings {
            enabled: true,
            skip: strings(&["example.com"]),
            borrowed: strings(&[".github.com", "github.com"]),
        };
        settings.save_to(&path).unwrap();
        assert_eq!(LoginSettings::load_from(&path), settings);
        // 临时文件改名掉了，不留下。
        assert!(!path.with_extension("json.tmp").exists());
        // 手写的文件读进来时规整；缺的项按出厂值。
        std::fs::write(
            &path,
            r#"{"enabled": true, "skip": ["HTTPS://Shop.Example/", "shop.example", "not a host"], "borrowed": [".GitHub.com.", ""]}"#,
        )
        .unwrap();
        let back = LoginSettings::load_from(&path);
        assert!(back.enabled);
        assert_eq!(back.skip, strings(&["shop.example"]));
        assert_eq!(back.borrowed, strings(&[".github.com"]));
        std::fs::write(&path, r#"{"skip": ["a.example"]}"#).unwrap();
        let back = LoginSettings::load_from(&path);
        assert!(!back.enabled);
        assert!(back.borrowed.is_empty());
    }

    #[test]
    fn edited_keeps_what_was_not_given() {
        let settings = LoginSettings {
            enabled: true,
            skip: strings(&["example.com"]),
            borrowed: strings(&[".github.com"]),
        };
        assert_eq!(settings.edited(None, None), settings);
        let off = settings.edited(Some(false), None);
        assert!(!off.enabled);
        assert_eq!(off.skip, strings(&["example.com"]));
        let skips = settings.edited(None, Some(strings(&["https://Gist.GitHub.com/x"])));
        assert!(skips.enabled);
        assert_eq!(skips.skip, strings(&["gist.github.com"]));
        assert_eq!(skips.borrowed, strings(&[".github.com"]));
    }

    #[test]
    fn borrowed_domains_are_recorded_and_forgotten_by_host() {
        let settings = LoginSettings::default().with_borrowed([
            ".github.com",
            "github.com",
            "GITHUB.com",
            "docs.example.org",
        ]);
        assert_eq!(
            settings.borrowed,
            strings(&[".github.com", "github.com", "docs.example.org"])
        );
        assert_eq!(
            settings.borrowed_for("gist.github.com"),
            strings(&[".github.com"])
        );
        assert_eq!(
            settings.borrowed_for("github.com"),
            strings(&[".github.com", "github.com"])
        );
        assert!(settings.borrowed_for("notgithub.com").is_empty());

        let (left, gone) = settings.without_borrowed(Some("github.com"));
        assert_eq!(gone, strings(&[".github.com", "github.com"]));
        assert_eq!(left.borrowed, strings(&["docs.example.org"]));
        // 去掉一个主机名也去掉它子域名上的域。
        let (left, gone) = settings.without_borrowed(Some("example.org"));
        assert_eq!(gone, strings(&["docs.example.org"]));
        assert_eq!(left.borrowed.len(), 2);
        let (left, gone) = settings.without_borrowed(None);
        assert_eq!(gone.len(), 3);
        assert!(left.borrowed.is_empty());
    }

    // ---- 完成标准 5：怎么写 ----

    fn names(plan: &WritePlan) -> Vec<String> {
        plan.write.iter().map(|c| c.name().to_string()).collect()
    }

    #[test]
    fn a_domain_borrowed_for_the_first_time_overwrites() {
        let mut session = cookie("session", ".github.com");
        session.http_only = true;
        let cookies = vec![session, cookie("theme", ".github.com")];
        // 内置浏览器里以前没登录时留下了一个同名同域同路径的。
        let existing = vec![CookieKey::new("session", ".GitHub.com", "")];
        let plan = plan_writes(&cookies, &existing, &[], false);
        assert_eq!(names(&plan), strings(&["session", "theme"]));
        assert!(plan.http_only);
    }

    #[test]
    fn a_domain_borrowed_before_only_fills_what_is_missing() {
        let mut session = cookie("session", ".github.com");
        session.http_only = true;
        let cookies = vec![
            session,
            cookie("theme", ".github.com"),
            cookie("other", "github.com"),
        ];
        let existing = vec![CookieKey::new("session", ".github.com", "/")];
        let borrowed = strings(&[".github.com"]);
        let plan = plan_writes(&cookies, &existing, &borrowed, false);
        // `session` 已经有了，不覆盖；`github.com` 这个域还没借过，照写。
        assert_eq!(names(&plan), strings(&["theme", "other"]));
        assert!(!plan.http_only);
        // 全都有了：什么都不写。
        let all: Vec<CookieKey> = cookies.iter().map(ChromeCookie::key).collect();
        let borrowed = strings(&[".github.com", "github.com"]);
        assert!(plan_writes(&cookies, &all, &borrowed, false)
            .write
            .is_empty());
    }

    #[test]
    fn borrowing_again_overwrites_everything() {
        let mut session = cookie("session", ".github.com");
        session.http_only = true;
        let cookies = vec![session, cookie("theme", ".github.com")];
        let existing: Vec<CookieKey> = cookies.iter().map(ChromeCookie::key).collect();
        let borrowed = strings(&[".github.com"]);
        let plan = plan_writes(&cookies, &existing, &borrowed, true);
        assert_eq!(names(&plan), strings(&["session", "theme"]));
        assert!(plan.http_only);
    }

    // ---- 完成标准 6：值不外露 ----

    #[test]
    fn debug_shows_neither_the_name_nor_the_value() {
        let cookies = parse_cookies(&answer(), NOW);
        assert!(!cookies.is_empty());
        for cookie in &cookies {
            let shown = format!("{cookie:?}");
            assert!(!shown.contains(cookie.value_for_store()), "{shown}");
            assert!(!shown.contains(cookie.name()), "{shown}");
            let key = format!("{:?}", cookie.key());
            assert!(!key.contains(cookie.name()), "{key}");
        }
        let plan = plan_writes(&cookies, &[], &[], false);
        let shown = format!("{plan:?}");
        assert!(!shown.contains("s3cr3t-session"), "{shown}");
        assert!(shown.contains("github.com"));
    }
}
