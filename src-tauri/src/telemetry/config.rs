//! The telemetry settings, from `CODEG_TELEMETRY_*` (`COWORK_TELEMETRY_*` are
//! aliases; the `CODEG_` name wins) and the DSNs a release build carries.
//! Pure, so it is tested without touching the process environment.
//!
//! Where each half's DSN comes from (docs/telemetry.md §5.1), first match:
//!
//! 1. `CODEG_TELEMETRY=off` (or `0`, `false`, `no`): both halves off.
//! 2. `CODEG_TELEMETRY_DSN` / `CODEG_TELEMETRY_WEB_DSN` set: that value; set
//!    but empty turns that half off.
//! 3. The other half set from the environment: off. A deployment that names
//!    its own Sentry project gets nothing it did not name.
//! 4. The DSN built in by the release workflows (`CODEG_TELEMETRY_BUILTIN_*`
//!    at compile time), if this build has one.
//! 5. Off.
//!
//! With the environment's DSNs the defaults are a deployment's
//! (`production`, the system user); with the built-in ones they are those of
//! anybody's machine: `community` (`desktop-local` for a desktop app's own
//! daemon) and a random install id instead of the system user's name.

use std::path::Path;

/// The variable suffixes read here; all of them are removed from the process
/// environment once read ([`env_names`]).
pub const KEYS: &[&str] = &["DSN", "WEB_DSN", "ENV", "TRACES", "USER", "SELFTEST"];

/// The master switch, `CODEG_TELEMETRY` (and its `COWORK_` alias).
pub const SWITCH: &str = "TELEMETRY";

/// The server project's DSN of a release build. Set by the release workflows
/// from an Actions secret; absent from local, PR and test builds.
pub const BUILTIN_DSN: Option<&str> = option_env!("CODEG_TELEMETRY_BUILTIN_DSN");
/// The web project's, likewise.
pub const BUILTIN_WEB_DSN: Option<&str> = option_env!("CODEG_TELEMETRY_BUILTIN_WEB_DSN");

/// `environment` with the built-in DSNs.
pub const COMMUNITY_ENVIRONMENT: &str = "community";
/// `environment` with the built-in DSNs, in a desktop app's own daemon.
pub const DESKTOP_LOCAL_ENVIRONMENT: &str = "desktop-local";

/// The file in the data directory that keeps [`install_id`].
pub const INSTALL_ID_FILE: &str = "telemetry-install-id";
/// Characters of an install id.
pub const INSTALL_ID_LEN: usize = 12;

/// Trace sample rate for the commands the web UI calls on a timer: they are
/// 85% of all calls and say little one by one (docs/telemetry.md §5.2). Sent
/// to the web UI in `cowork_info`, so both ends sample them alike.
pub const POLLED_COMMANDS: &[(&str, f32)] = &[
    ("acp_touch_connection", 0.01),
    ("get_git_head", 0.01),
    ("get_codeg_mcp_service_status", 0.01),
    ("get_system_resources", 0.01),
    ("list_host_devices", 0.01),
    ("health", 0.01),
    // Every 10 s per open conversation (`CONVERSATION_DEVICE_POLL_MS`).
    ("get_conversation_device", 0.01),
    // The sidebar's pull-request marks, every 20 s (`pr-status-poller.tsx`).
    ("folder_pr_statuses", 0.01),
    ("conversation_pr_statuses", 0.01),
    // Panels and dialogs that re-read while they are shown.
    ("get_jenny_progress", 0.01),
    ("get_loop_conversation", 0.01),
    ("get_loop_session_page", 0.01),
    ("get_conversation", 0.01),
    ("read_workbench_app_log", 0.01),
    ("git_list_conflicts", 0.01),
    ("forge_auto_status", 0.01),
    ("renew_office_watch", 0.01),
    ("codex_poll_device_code", 0.01),
    ("weixin_check_qrcode", 0.01),
];

/// Modules whose INFO lines also go to Sentry as logs (WARN and ERROR go from
/// everywhere): the realtime socket, the agent connections' state, the
/// desktop hosts — what "who dropped the connection" is answered from.
pub const INFO_LOG_TARGETS: &[&str] = &[
    "codeg_lib::web::ws",
    "codeg_lib::web::ws_attach",
    "codeg_lib::web::host_registry",
    "codeg_lib::acp::session_state",
    "codeg_lib::acp::manager",
    "codeg_lib::acp::idle_sweep",
];

/// The DSNs a build carries ([`BUILTIN_DSN`], [`BUILTIN_WEB_DSN`]); empty
/// means none.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Builtin {
    pub dsn: Option<String>,
    pub web_dsn: Option<String>,
}

impl Builtin {
    /// What this build was compiled with.
    pub fn compiled() -> Self {
        Self {
            dsn: non_empty(BUILTIN_DSN.map(str::to_string)),
            web_dsn: non_empty(BUILTIN_WEB_DSN.map(str::to_string)),
        }
    }
}

/// Where one half's DSN came from, or why it is off.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Status {
    /// `CODEG_TELEMETRY_DSN` / `CODEG_TELEMETRY_WEB_DSN`.
    Env,
    /// Built in by the release workflows.
    Builtin,
    /// `CODEG_TELEMETRY=off`.
    SwitchedOff,
    /// Its variable is set, to nothing.
    SetEmpty,
    /// Not set, while the other half's is: a deployment of its own.
    OtherHalfConfigured,
    /// Not set, and nothing built in.
    NotConfigured,
}

impl Status {
    pub fn describe(self) -> &'static str {
        match self {
            Status::Env => "on (from the environment)",
            Status::Builtin => "on (built in)",
            Status::SwitchedOff => "off (CODEG_TELEMETRY=off)",
            Status::SetEmpty => "off (its DSN variable is set empty)",
            Status::OtherHalfConfigured => "off (the environment names only the other half)",
            Status::NotConfigured => "off (no DSN set, none built in)",
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct TelemetryConfig {
    /// The server project. `None`: nothing of the server is reported.
    pub dsn: Option<String>,
    /// The web project. `None`: the web UI is not told to report and the
    /// forwarding endpoint answers 404.
    pub web_dsn: Option<String>,
    /// Where [`Self::dsn`] came from, or why it is off.
    pub server_status: Status,
    /// Where [`Self::web_dsn`] came from, or why it is off.
    pub web_status: Status,
    /// `CODEG_TELEMETRY_ENV`, default `production` with the environment's
    /// DSNs, [`COMMUNITY_ENVIRONMENT`] / [`DESKTOP_LOCAL_ENVIRONMENT`] with
    /// the built-in ones.
    pub environment: String,
    /// `CODEG_TELEMETRY_TRACES`, 0 to 1, default 1.
    pub traces_sample_rate: f32,
    /// `CODEG_TELEMETRY_USER`, default the system user without `cw-` with
    /// the environment's DSNs, the install id with the built-in ones.
    pub user: String,
    /// The user is to be the install id: [`resolve_with`] leaves `user`
    /// empty and the server's start fills it in ([`install_id`]), once the
    /// data directory is known.
    pub install_id_user: bool,
    /// `CODEG_TELEMETRY_SELFTEST` truthy: report one test error at startup.
    pub self_test: bool,
    /// What was wrong with the values, for the startup log.
    pub problems: Vec<String>,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        resolve_with(&|_| None, &Builtin::default())
    }
}

impl TelemetryConfig {
    /// Whether any half is configured.
    pub fn enabled(&self) -> bool {
        self.dsn.is_some() || self.web_dsn.is_some()
    }

    /// Whether a DSN came from the environment (the way a deployment of its
    /// own configures it).
    pub fn from_env(&self) -> bool {
        self.server_status == Status::Env || self.web_status == Status::Env
    }

    /// One line for the startup log: each half on (and from where) or off
    /// (and why).
    pub fn summary(&self) -> String {
        format!(
            "server reports {}, web reports {}",
            self.server_status.describe(),
            self.web_status.describe()
        )
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value
        .map(|v| v.trim().to_string())
        .filter(|v| !v.is_empty())
}

fn lookup(env: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<String> {
    non_empty(env(&format!("CODEG_TELEMETRY_{key}")))
        .or_else(|| non_empty(env(&format!("COWORK_TELEMETRY_{key}"))))
}

/// Like [`lookup`], but tells "set to nothing" (`Some(None)`) from "not set"
/// (`None`). The `CODEG_` name wins when it is set at all.
fn lookup_set(env: &dyn Fn(&str) -> Option<String>, key: &str) -> Option<Option<String>> {
    ["CODEG", "COWORK"]
        .iter()
        .find_map(|prefix| env(&format!("{prefix}_TELEMETRY_{key}")))
        .map(|value| non_empty(Some(value)))
}

/// Whether `CODEG_TELEMETRY` turns everything off.
fn switched_off(env: &dyn Fn(&str) -> Option<String>) -> bool {
    ["CODEG", "COWORK"]
        .iter()
        .find_map(|prefix| non_empty(env(&format!("{prefix}_{SWITCH}"))))
        .is_some_and(|v| {
            matches!(
                v.to_ascii_lowercase().as_str(),
                "0" | "false" | "off" | "no"
            )
        })
}

/// Every variable name [`resolve`] reads, both spellings.
pub fn env_names() -> impl Iterator<Item = String> {
    KEYS.iter()
        .map(|key| format!("{SWITCH}_{key}"))
        .chain(std::iter::once(SWITCH.to_string()))
        .flat_map(|name| [format!("CODEG_{name}"), format!("COWORK_{name}")])
}

/// [`resolve_with`] this build's built-in DSNs.
pub fn resolve(env: &dyn Fn(&str) -> Option<String>) -> TelemetryConfig {
    resolve_with(env, &Builtin::compiled())
}

/// One half's DSN and where it came from.
fn half(
    set: Option<Option<String>>,
    builtin: Option<&str>,
    other_from_env: bool,
) -> (Option<String>, Status) {
    match set {
        Some(Some(dsn)) => (Some(dsn), Status::Env),
        Some(None) => (None, Status::SetEmpty),
        None if other_from_env => (None, Status::OtherHalfConfigured),
        None => match builtin {
            Some(dsn) => (Some(dsn.to_string()), Status::Builtin),
            None => (None, Status::NotConfigured),
        },
    }
}

pub fn resolve_with(env: &dyn Fn(&str) -> Option<String>, builtin: &Builtin) -> TelemetryConfig {
    let mut problems = Vec::new();
    let traces_sample_rate = match lookup(env, "TRACES") {
        None => 1.0,
        Some(raw) => match raw.parse::<f32>() {
            Ok(rate) if (0.0..=1.0).contains(&rate) => rate,
            _ => {
                problems.push(format!(
                    "CODEG_TELEMETRY_TRACES={raw} is not a number from 0 to 1; using 1"
                ));
                1.0
            }
        },
    };
    let ((dsn, server_status), (web_dsn, web_status)) = if switched_off(env) {
        ((None, Status::SwitchedOff), (None, Status::SwitchedOff))
    } else {
        let server = lookup_set(env, "DSN");
        let web = lookup_set(env, "WEB_DSN");
        let server_from_env = matches!(server, Some(Some(_)));
        let web_from_env = matches!(web, Some(Some(_)));
        (
            half(server, builtin.dsn.as_deref(), web_from_env),
            half(web, builtin.web_dsn.as_deref(), server_from_env),
        )
    };
    // Never mixed with one from the environment (`half`).
    let built_in = server_status == Status::Builtin || web_status == Status::Builtin;
    let default_environment = if !built_in {
        "production"
    } else if crate::cowork::truthy(env(crate::local_daemon::CHILD_ENV).as_deref()) {
        DESKTOP_LOCAL_ENVIRONMENT
    } else {
        COMMUNITY_ENVIRONMENT
    };
    let (user, install_id_user) = match lookup(env, "USER") {
        Some(user) => (user, false),
        // Somebody else's machine: its login name is theirs to keep.
        None if built_in => (String::new(), true),
        None => (system_user(env), false),
    };
    let environment = match lookup(env, "ENV") {
        Some(environment) => environment,
        None => default_environment.to_string(),
    };
    TelemetryConfig {
        dsn,
        web_dsn,
        server_status,
        web_status,
        environment,
        traces_sample_rate,
        user,
        install_id_user,
        self_test: crate::cowork::truthy(lookup(env, "SELFTEST").as_deref()),
        problems,
    }
}

/// The system user without the `cw-` of a Cowork employee's account.
fn system_user(env: &dyn Fn(&str) -> Option<String>) -> String {
    ["USER", "LOGNAME"]
        .iter()
        .find_map(|name| non_empty(env(name)))
        .map(|name| match name.strip_prefix("cw-") {
            Some(rest) if !rest.is_empty() => rest.to_string(),
            _ => name,
        })
        .unwrap_or_else(|| "unknown".to_string())
}

fn valid_install_id(id: &str) -> bool {
    id.len() == INSTALL_ID_LEN && id.bytes().all(|b| b.is_ascii_hexdigit())
}

/// This installation's id: random, made once and kept in the data directory
/// ([`INSTALL_ID_FILE`]), so reports of one machine count as one user without
/// naming anybody. When the file cannot be written the id is this run's only.
pub fn install_id(data_dir: &Path) -> String {
    let file = data_dir.join(INSTALL_ID_FILE);
    if let Ok(kept) = std::fs::read_to_string(&file) {
        let kept = kept.trim();
        if valid_install_id(kept) {
            return kept.to_string();
        }
    }
    let mut id = uuid::Uuid::new_v4().simple().to_string();
    id.truncate(INSTALL_ID_LEN);
    if let Err(e) = keep_install_id(data_dir, &file, &id) {
        tracing::warn!("[telemetry] cannot keep the install id: {e}");
    }
    id
}

fn keep_install_id(data_dir: &Path, file: &Path, id: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    std::fs::write(file, id)
}

/// The release both ends report: the Cowork tag in `COWORK-VERSION` beside
/// the binary (`cowork-codeg-vX.Y.Z`), else the upstream version.
pub fn release_from(cowork_version: Option<&str>) -> String {
    cowork_version
        .map(str::trim)
        .filter(|v| !v.is_empty() && *v != "unknown")
        .map(str::to_string)
        .unwrap_or_else(|| format!("codeg@{}", env!("CARGO_PKG_VERSION")))
}

/// The trace sample rate for one API command.
pub fn command_sample_rate(command: &str, default: f32) -> f32 {
    POLLED_COMMANDS
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, rate)| rate.min(default))
        .unwrap_or(default)
}

/// Whether an INFO line of `target` goes to Sentry as a log.
pub fn info_log_target(target: &str) -> bool {
    INFO_LOG_TARGETS.iter().any(|prefix| {
        target == *prefix
            || target
                .strip_prefix(prefix)
                .is_some_and(|rest| rest.starts_with("::"))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn env_of(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(k, v)| (k.to_string(), v.to_string()))
            .collect();
        move |k| map.get(k).cloned()
    }

    /// Without a built-in DSN, as in every local and PR build.
    fn resolve(env: &dyn Fn(&str) -> Option<String>) -> TelemetryConfig {
        resolve_with(env, &Builtin::default())
    }

    const DSN_A: &str = "https://a@x.test/1";

    fn builtin() -> Builtin {
        Builtin {
            dsn: Some("https://pub@x.test/10".to_string()),
            web_dsn: Some("https://pub@x.test/11".to_string()),
        }
    }

    #[test]
    fn nothing_set_is_off() {
        let config = resolve(&env_of(&[("USER", "cw-james")]));
        assert!(!config.enabled());
        assert_eq!(config.environment, "production");
        assert_eq!(config.traces_sample_rate, 1.0);
        assert_eq!(config.user, "james");
        assert!(!config.self_test);
        assert!(config.problems.is_empty());
        assert_eq!(config.server_status, Status::NotConfigured);
        assert_eq!(config.web_status, Status::NotConfigured);
        assert!(config.summary().contains("none built in"));
    }

    #[test]
    fn the_built_in_dsns_are_used_when_the_environment_names_none() {
        let config = resolve_with(&env_of(&[("USER", "cw-pat")]), &builtin());
        assert_eq!(config.dsn.as_deref(), Some("https://pub@x.test/10"));
        assert_eq!(config.web_dsn.as_deref(), Some("https://pub@x.test/11"));
        assert_eq!(config.server_status, Status::Builtin);
        assert_eq!(config.web_status, Status::Builtin);
        assert!(!config.from_env());
        // Anybody's machine: not production, and not its login name.
        assert_eq!(config.environment, COMMUNITY_ENVIRONMENT);
        assert!(config.install_id_user);
        assert_eq!(config.user, "");
        assert!(config.summary().contains("built in"));
    }

    #[test]
    fn a_desktop_apps_own_daemon_is_desktop_local() {
        let env = env_of(&[(crate::local_daemon::CHILD_ENV, "1")]);
        let config = resolve_with(&env, &builtin());
        assert_eq!(config.environment, DESKTOP_LOCAL_ENVIRONMENT);
        let env = env_of(&[
            (crate::local_daemon::CHILD_ENV, "1"),
            ("CODEG_TELEMETRY_ENV", "staging"),
            ("CODEG_TELEMETRY_USER", "tester"),
        ]);
        let config = resolve_with(&env, &builtin());
        assert_eq!(config.environment, "staging");
        assert_eq!(config.user, "tester");
        assert!(!config.install_id_user);
    }

    #[test]
    fn the_environment_wins_over_the_built_in_dsns() {
        let env = env_of(&[
            ("CODEG_TELEMETRY_DSN", "https://a@x.test/1"),
            ("CODEG_TELEMETRY_WEB_DSN", "https://c@x.test/3"),
            ("USER", "cw-pat"),
        ]);
        let config = resolve_with(&env, &builtin());
        assert_eq!(config.dsn.as_deref(), Some("https://a@x.test/1"));
        assert_eq!(config.web_dsn.as_deref(), Some("https://c@x.test/3"));
        assert_eq!(config.server_status, Status::Env);
        assert_eq!(config.web_status, Status::Env);
        // A deployment's defaults, as before.
        assert_eq!(config.environment, "production");
        assert_eq!(config.user, "pat");
        assert!(!config.install_id_user);
    }

    #[test]
    fn a_deployment_naming_one_half_gets_nothing_built_in() {
        let env = env_of(&[("CODEG_TELEMETRY_DSN", "https://a@x.test/1")]);
        let config = resolve_with(&env, &builtin());
        assert_eq!(config.server_status, Status::Env);
        assert_eq!(config.web_dsn, None);
        assert_eq!(config.web_status, Status::OtherHalfConfigured);
        assert_eq!(config.environment, "production");
    }

    #[test]
    fn the_switch_turns_both_halves_off() {
        for off in ["off", "0", "false", "No", " OFF "] {
            for name in ["CODEG_TELEMETRY", "COWORK_TELEMETRY"] {
                let env = env_of(&[(name, off), ("CODEG_TELEMETRY_DSN", DSN_A)]);
                let config = resolve_with(&env, &builtin());
                assert!(!config.enabled(), "{name}={off}");
                assert_eq!(config.server_status, Status::SwitchedOff);
                assert_eq!(config.web_status, Status::SwitchedOff);
                assert!(config.summary().contains("CODEG_TELEMETRY=off"));
            }
        }
        for on in ["on", "1", ""] {
            let config = resolve_with(&env_of(&[("CODEG_TELEMETRY", on)]), &builtin());
            assert!(config.enabled(), "{on}");
        }
    }

    #[test]
    fn a_dsn_set_empty_turns_its_half_off() {
        let env = env_of(&[("CODEG_TELEMETRY_DSN", "")]);
        let config = resolve_with(&env, &builtin());
        assert_eq!(config.dsn, None);
        assert_eq!(config.server_status, Status::SetEmpty);
        // The other half keeps the built-in one.
        assert_eq!(config.web_status, Status::Builtin);

        let env = env_of(&[("COWORK_TELEMETRY_WEB_DSN", "  ")]);
        let config = resolve_with(&env, &builtin());
        assert_eq!(config.web_status, Status::SetEmpty);
        assert_eq!(config.server_status, Status::Builtin);

        // Set at all, the CODEG_ name decides.
        let env = env_of(&[
            ("CODEG_TELEMETRY_DSN", ""),
            ("COWORK_TELEMETRY_DSN", "https://b@x.test/2"),
        ]);
        assert_eq!(resolve_with(&env, &builtin()).dsn, None);
    }

    #[test]
    fn the_install_id_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        let id = install_id(&data);
        assert_eq!(id.len(), INSTALL_ID_LEN);
        assert!(id.bytes().all(|b| b.is_ascii_hexdigit()));
        assert_eq!(install_id(&data), id);
        let file = data.join(INSTALL_ID_FILE);
        assert_eq!(std::fs::read_to_string(&file).unwrap(), id);

        // A file that is not an id is replaced.
        std::fs::write(&file, "not an id").unwrap();
        let fresh = install_id(&data);
        assert_ne!(fresh, id);
        assert_eq!(install_id(&data), fresh);
    }

    #[test]
    fn codeg_names_win_over_cowork_aliases() {
        let config = resolve(&env_of(&[
            ("CODEG_TELEMETRY_DSN", " https://a@x.test/1 "),
            ("COWORK_TELEMETRY_DSN", "https://b@x.test/2"),
            ("COWORK_TELEMETRY_WEB_DSN", "https://c@x.test/3"),
            ("COWORK_TELEMETRY_ENV", "ai-qa"),
            ("CODEG_TELEMETRY_USER", "alice"),
            ("CODEG_TELEMETRY_SELFTEST", "1"),
            ("USER", "cw-james"),
        ]));
        assert_eq!(config.dsn.as_deref(), Some("https://a@x.test/1"));
        assert_eq!(config.web_dsn.as_deref(), Some("https://c@x.test/3"));
        assert_eq!(config.environment, "ai-qa");
        assert_eq!(config.user, "alice");
        assert!(config.self_test);
    }

    #[test]
    fn a_bad_trace_rate_falls_back_to_one_and_says_so() {
        for bad in ["2", "-0.1", "half", "NaN"] {
            let config = resolve(&env_of(&[("CODEG_TELEMETRY_TRACES", bad)]));
            assert_eq!(config.traces_sample_rate, 1.0, "{bad}");
            assert_eq!(config.problems.len(), 1, "{bad}");
        }
        let config = resolve(&env_of(&[("CODEG_TELEMETRY_TRACES", "0.25")]));
        assert_eq!(config.traces_sample_rate, 0.25);
    }

    #[test]
    fn the_user_falls_back_to_the_system_user() {
        assert_eq!(resolve(&env_of(&[("LOGNAME", "bob")])).user, "bob");
        assert_eq!(resolve(&env_of(&[("USER", "cw-")])).user, "cw-");
        assert_eq!(resolve(&env_of(&[])).user, "unknown");
    }

    #[test]
    fn every_name_read_is_stripped() {
        let names: Vec<String> = env_names().collect();
        assert!(names.contains(&"CODEG_TELEMETRY_WEB_DSN".to_string()));
        assert!(names.contains(&"COWORK_TELEMETRY_DSN".to_string()));
        assert!(names.contains(&"CODEG_TELEMETRY".to_string()));
        assert!(names.contains(&"COWORK_TELEMETRY".to_string()));
        assert_eq!(names.len(), (KEYS.len() + 1) * 2);
    }

    #[test]
    fn release_is_the_cowork_tag_when_there_is_one() {
        assert_eq!(
            release_from(Some("cowork-codeg-v0.6.0\n")),
            "cowork-codeg-v0.6.0"
        );
        let upstream = format!("codeg@{}", env!("CARGO_PKG_VERSION"));
        assert_eq!(release_from(Some("unknown")), upstream);
        assert_eq!(release_from(None), upstream);
    }

    #[test]
    fn polled_commands_are_sampled_down_never_up() {
        assert_eq!(command_sample_rate("acp_touch_connection", 1.0), 0.01);
        assert_eq!(command_sample_rate("acp_touch_connection", 0.0), 0.0);
        assert_eq!(command_sample_rate("acp_prompt", 0.5), 0.5);
    }

    #[test]
    fn timer_polls_of_the_web_ui_are_listed() {
        // Three of the four that filled the relay's general budget.
        for command in [
            "get_conversation_device",
            "folder_pr_statuses",
            "conversation_pr_statuses",
        ] {
            assert_eq!(command_sample_rate(command, 1.0), 0.01, "{command}");
        }
        // The fourth is read when a person opens a conversation, not on a
        // timer: it stays fully sampled.
        assert_eq!(command_sample_rate("get_folder_conversation", 1.0), 1.0);
        assert_eq!(command_sample_rate("save_opened_tabs", 1.0), 1.0);
    }

    #[test]
    fn polled_command_names_are_unique() {
        let mut names: Vec<&str> = POLLED_COMMANDS.iter().map(|(n, _)| *n).collect();
        names.sort_unstable();
        let total = names.len();
        names.dedup();
        assert_eq!(names.len(), total);
    }

    #[test]
    fn info_targets_match_whole_module_names() {
        assert!(info_log_target("codeg_lib::web::ws"));
        assert!(info_log_target("codeg_lib::acp::manager::inner"));
        assert!(!info_log_target("codeg_lib::web::ws_other"));
        assert!(!info_log_target("codeg_lib::web::router"));
    }
}
