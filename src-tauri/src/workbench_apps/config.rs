//! What an app is, as the user configured it, and where that is kept.
//!
//! The whole list lives under one `app_metadata` key as a JSON document, the
//! way the forge settings and the branch tag do: the fork may not add a
//! migration (`JENNY-FORK.md`), and a list a person edits by hand a few times
//! is no reason for a table. The key is not on config sync's portable list, so
//! it stays on this machine — right for a list of `127.0.0.1` addresses and the
//! local commands that serve them.

use serde::{Deserialize, Serialize};

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
use crate::db::AppDatabase;

/// The `app_metadata` key holding [`StoredApps`].
pub const APPS_KEY: &str = "workbench_apps";

/// Most apps a list may hold. Far more than anyone pins; the cap keeps one
/// health pass (a connect per app) and the status broadcast small.
pub const MAX_APPS: usize = 32;

const MAX_ID_LEN: usize = 40;
const MAX_NAME_CHARS: usize = 80;
const MAX_URL_LEN: usize = 2048;
const MAX_COMMAND_LEN: usize = 4096;
const MAX_DIR_LEN: usize = 1024;

/// When codeg starts an app's service.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AppLaunch {
    /// With codeg: at launch, and again if it stops on its own.
    #[default]
    Auto,
    /// Only when someone asks for it (the app's Start button).
    Manual,
}

/// One app: a web page codeg shows in place, and optionally the command that
/// serves it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchApp {
    /// Stable id: `[a-z0-9-]`, also the built-in browser surface's name.
    pub id: String,
    pub name: String,
    /// The page to show, `http(s)://`. Its host and port are what the health
    /// check connects to.
    pub url: String,
    /// The shell command that serves `url`, run through the user's login
    /// shell. Absent for a service something else keeps running (launchd, a
    /// container): codeg then only shows it and watches whether it answers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_command: Option<String>,
    /// Where `start_command` runs; the home directory when absent.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub working_dir: Option<String>,
    #[serde(default)]
    pub launch: AppLaunch,
}

impl WorkbenchApp {
    /// Whether codeg has a way to start this app's service.
    pub fn startable(&self) -> bool {
        self.start_command.is_some()
    }
}

/// The stored document. Versioned so a later shape can read this one.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredApps {
    version: u32,
    apps: Vec<WorkbenchApp>,
}

const STORED_VERSION: u32 = 1;

/// The list a machine starts with, before anyone has saved one.
/// Jenny and ActivityWatch run independently; codeg only shows their local
/// pages and watches whether they answer.
pub fn default_apps() -> Vec<WorkbenchApp> {
    let app = |id: &str, name: &str, url: &str| WorkbenchApp {
        id: id.to_string(),
        name: name.to_string(),
        url: url.to_string(),
        start_command: None,
        working_dir: None,
        launch: AppLaunch::Auto,
    };
    vec![
        app("jenny-loop", "Jenny 任务看板", "http://127.0.0.1:7500/"),
        app("activitywatch", "ActivityWatch", "http://127.0.0.1:5600/"),
    ]
}

/// `dir` with a leading `~` meaning the home directory, as a shell reads it.
pub fn expand_home(dir: &str) -> std::path::PathBuf {
    let home = || dirs::home_dir().unwrap_or_default();
    if dir == "~" {
        return home();
    }
    match dir.strip_prefix("~/") {
        Some(rest) => home().join(rest),
        None => std::path::PathBuf::from(dir),
    }
}

/// The saved list, or [`default_apps`] when nothing was saved. A stored value
/// that no longer parses reads as the defaults too (and is logged) rather than
/// failing: an unreadable list must not take the page down with it, and the
/// next save replaces it.
pub async fn load_apps(db: &AppDatabase) -> Result<Vec<WorkbenchApp>, AppCommandError> {
    let stored = app_metadata_service::get_value(&db.conn, APPS_KEY)
        .await
        .map_err(AppCommandError::db)?;
    let Some(raw) = stored else {
        return Ok(default_apps());
    };
    match serde_json::from_str::<StoredApps>(&raw) {
        Ok(doc) => Ok(normalize_apps(doc.apps).unwrap_or_else(|err| {
            tracing::warn!("[apps] stored app list is invalid, using defaults: {err}");
            default_apps()
        })),
        Err(err) => {
            tracing::warn!("[apps] stored app list does not parse, using defaults: {err}");
            Ok(default_apps())
        }
    }
}

/// Validate and store `apps` whole; returns the list as stored.
pub async fn save_apps(
    db: &AppDatabase,
    apps: Vec<WorkbenchApp>,
) -> Result<Vec<WorkbenchApp>, AppCommandError> {
    let apps = normalize_apps(apps)?;
    let doc = StoredApps {
        version: STORED_VERSION,
        apps: apps.clone(),
    };
    let encoded = serde_json::to_string(&doc).map_err(|err| {
        AppCommandError::invalid_input(format!("app list is not serializable: {err}"))
    })?;
    app_metadata_service::upsert_value(&db.conn, APPS_KEY, &encoded)
        .await
        .map_err(AppCommandError::db)?;
    Ok(apps)
}

/// Trim every field, drop empty optional ones, and refuse a list that would
/// not work: a bad id, an empty name, an address that is not `http(s)`, a
/// command with a NUL in it, a duplicate id, or too many apps.
pub fn normalize_apps(apps: Vec<WorkbenchApp>) -> Result<Vec<WorkbenchApp>, AppCommandError> {
    if apps.len() > MAX_APPS {
        return Err(AppCommandError::invalid_input(format!(
            "an app list holds at most {MAX_APPS} apps"
        )));
    }
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(apps.len());
    for app in apps {
        let app = normalize_app(app)?;
        if !seen.insert(app.id.clone()) {
            return Err(AppCommandError::invalid_input(format!(
                "two apps share the id {:?}",
                app.id
            )));
        }
        out.push(app);
    }
    Ok(out)
}

fn normalize_app(app: WorkbenchApp) -> Result<WorkbenchApp, AppCommandError> {
    let id = app.id.trim().to_string();
    if !valid_id(&id) {
        return Err(AppCommandError::invalid_input(format!(
            "invalid app id {id:?}: use 1 to {MAX_ID_LEN} lowercase letters, digits or dashes"
        )));
    }
    let name = app.name.trim().to_string();
    if name.is_empty() {
        return Err(AppCommandError::invalid_input("an app needs a name"));
    }
    if name.chars().count() > MAX_NAME_CHARS {
        return Err(AppCommandError::invalid_input(format!(
            "an app name has at most {MAX_NAME_CHARS} characters"
        )));
    }
    let url = normalize_url(&app.url)?;
    let start_command = optional(app.start_command, MAX_COMMAND_LEN, "start command")?;
    let working_dir = optional(app.working_dir, MAX_DIR_LEN, "working directory")?;
    Ok(WorkbenchApp {
        id,
        name,
        url,
        start_command,
        working_dir,
        launch: app.launch,
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= MAX_ID_LEN
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

/// The address as it will be loaded. Only `http`/`https` with a host: the page
/// opens in the built-in browser, which loads nothing else, and the health
/// check needs a host and port to connect to.
pub fn normalize_url(raw: &str) -> Result<String, AppCommandError> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("an app needs an address"));
    }
    if trimmed.len() > MAX_URL_LEN {
        return Err(AppCommandError::invalid_input("the app address is too long"));
    }
    let parsed = url::Url::parse(trimmed)
        .map_err(|err| AppCommandError::invalid_input(format!("invalid app address: {err}")))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host_str().is_none() {
        return Err(AppCommandError::invalid_input(
            "an app address must start with http:// or https://",
        ));
    }
    Ok(parsed.to_string())
}

/// `value` trimmed, `None` when empty; refused when too long or holding NUL
/// (which no command line or path can carry).
fn optional(
    value: Option<String>,
    max_len: usize,
    what: &str,
) -> Result<Option<String>, AppCommandError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }
    if trimmed.len() > max_len {
        return Err(AppCommandError::invalid_input(format!(
            "the {what} is too long"
        )));
    }
    if trimmed.contains('\0') {
        return Err(AppCommandError::invalid_input(format!(
            "the {what} must not contain NUL characters"
        )));
    }
    Ok(Some(trimmed.to_string()))
}

/// The `host:port` the health check connects to.
pub fn authority_of(url: &str) -> Option<(String, u16)> {
    let parsed = url::Url::parse(url).ok()?;
    let host = parsed.host_str()?;
    // `host_str` keeps an IPv6 literal's brackets, which a socket address
    // parser does not want.
    let host = host.trim_start_matches('[').trim_end_matches(']').to_string();
    let port = parsed.port_or_known_default()?;
    Some((host, port))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn app(id: &str, url: &str) -> WorkbenchApp {
        WorkbenchApp {
            id: id.to_string(),
            name: format!("App {id}"),
            url: url.to_string(),
            start_command: None,
            working_dir: None,
            launch: AppLaunch::Auto,
        }
    }

    #[test]
    fn normalizes_fields_and_drops_empty_optionals() {
        let mut input = app(" a-1 ", " http://127.0.0.1:7500 ");
        input.name = "  Jenny  ".to_string();
        input.start_command = Some("   ".to_string());
        input.working_dir = Some(" /tmp ".to_string());
        let out = normalize_apps(vec![input]).unwrap();
        assert_eq!(out[0].id, "a-1");
        assert_eq!(out[0].name, "Jenny");
        assert_eq!(out[0].url, "http://127.0.0.1:7500/");
        assert_eq!(out[0].start_command, None);
        assert_eq!(out[0].working_dir.as_deref(), Some("/tmp"));
    }

    #[test]
    fn refuses_what_would_not_work() {
        assert!(normalize_apps(vec![app("Bad_Id", "http://a")]).is_err());
        assert!(normalize_apps(vec![app("", "http://a")]).is_err());
        assert!(normalize_apps(vec![app("a", "ftp://a")]).is_err());
        assert!(normalize_apps(vec![app("a", "file:///etc/passwd")]).is_err());
        assert!(normalize_apps(vec![app("a", "not a url")]).is_err());
        assert!(normalize_apps(vec![app("a", "http://x"), app("a", "http://y")]).is_err());
        let mut nameless = app("a", "http://a");
        nameless.name = " ".to_string();
        assert!(normalize_apps(vec![nameless]).is_err());
        let mut nul = app("a", "http://a");
        nul.start_command = Some("echo \0".to_string());
        assert!(normalize_apps(vec![nul]).is_err());
        let many = (0..=MAX_APPS).map(|i| app(&format!("a{i}"), "http://a")).collect();
        assert!(normalize_apps(many).is_err());
    }

    #[test]
    fn authority_uses_the_scheme_default_port() {
        assert_eq!(
            authority_of("http://127.0.0.1:7500/x"),
            Some(("127.0.0.1".to_string(), 7500))
        );
        assert_eq!(
            authority_of("https://example.com/"),
            Some(("example.com".to_string(), 443))
        );
        assert_eq!(
            authority_of("http://[::1]:8080/"),
            Some(("::1".to_string(), 8080))
        );
    }

    #[test]
    fn defaults_are_a_valid_list() {
        let defaults = default_apps();
        assert_eq!(normalize_apps(defaults.clone()).unwrap(), defaults);
        assert_eq!(
            defaults
                .iter()
                .map(|a| (a.id.as_str(), a.url.as_str()))
                .collect::<Vec<_>>(),
            vec![
                ("jenny-loop", "http://127.0.0.1:7500/"),
                ("activitywatch", "http://127.0.0.1:5600/"),
            ]
        );
        assert!(defaults.iter().all(|a| {
            a.start_command.is_none() && a.working_dir.is_none() && a.launch == AppLaunch::Auto
        }));
    }

    #[tokio::test]
    async fn saved_lists_are_not_replaced_or_extended_by_defaults() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        assert_eq!(load_apps(&db).await.unwrap(), default_apps());

        let mut custom = app("custom-dashboard", "http://127.0.0.1:8080/");
        custom.start_command = Some("npm run start".to_string());
        custom.working_dir = Some("~/projects/dashboard".to_string());
        custom.launch = AppLaunch::Manual;
        let saved = vec![custom];
        assert_eq!(save_apps(&db, saved.clone()).await.unwrap(), saved);
        let raw_before = app_metadata_service::get_value(&db.conn, APPS_KEY)
            .await
            .unwrap();
        assert_eq!(load_apps(&db).await.unwrap(), saved);
        assert_eq!(
            app_metadata_service::get_value(&db.conn, APPS_KEY)
                .await
                .unwrap(),
            raw_before
        );

        assert!(save_apps(&db, vec![]).await.unwrap().is_empty());
        assert!(load_apps(&db).await.unwrap().is_empty());
    }

    #[test]
    fn home_is_expanded_only_at_the_start() {
        let home = dirs::home_dir().unwrap_or_default();
        assert_eq!(expand_home("~"), home);
        assert_eq!(expand_home("~/x/y"), home.join("x/y"));
        assert_eq!(expand_home("/a/~/b"), std::path::PathBuf::from("/a/~/b"));
        assert_eq!(expand_home("~other"), std::path::PathBuf::from("~other"));
    }

    #[test]
    fn launch_defaults_to_auto_for_records_without_it() {
        let parsed: WorkbenchApp =
            serde_json::from_str(r#"{"id":"a","name":"A","url":"http://a/"}"#).unwrap();
        assert_eq!(parsed.launch, AppLaunch::Auto);
        let manual: WorkbenchApp = serde_json::from_str(
            r#"{"id":"a","name":"A","url":"http://a/","launch":"manual"}"#,
        )
        .unwrap();
        assert_eq!(manual.launch, AppLaunch::Manual);
    }
}
