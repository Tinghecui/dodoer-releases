//! The telemetry settings, from `CODEG_TELEMETRY_*` (`COWORK_TELEMETRY_*` are
//! aliases; the `CODEG_` name wins). Pure, so it is tested without touching
//! the process environment.

/// The variable suffixes read here; all of them are removed from the process
/// environment once read ([`env_names`]).
pub const KEYS: &[&str] = &["DSN", "WEB_DSN", "ENV", "TRACES", "USER", "SELFTEST"];

/// Trace sample rate for the commands the web UI calls on a timer: they are
/// 85% of all calls and say little one by one (docs/telemetry.md §5.2). Sent
/// to the web UI in `cowork_info`, so both ends sample them alike.
pub const POLLED_COMMANDS: &[(&str, f32)] = &[
    ("acp_touch_connection", 0.01),
    ("get_git_head", 0.01),
    ("get_codeg_mcp_service_status", 0.01),
    ("get_system_resources", 0.01),
    ("health", 0.01),
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

#[derive(Debug, Clone, PartialEq)]
pub struct TelemetryConfig {
    /// `CODEG_TELEMETRY_DSN`: the server project. Unset: nothing of the
    /// server is reported.
    pub dsn: Option<String>,
    /// `CODEG_TELEMETRY_WEB_DSN`: the web project. Unset: the web UI is not
    /// told to report and the forwarding endpoint answers 404.
    pub web_dsn: Option<String>,
    /// `CODEG_TELEMETRY_ENV`, default `production`.
    pub environment: String,
    /// `CODEG_TELEMETRY_TRACES`, 0 to 1, default 1.
    pub traces_sample_rate: f32,
    /// `CODEG_TELEMETRY_USER`, default the system user without `cw-`.
    pub user: String,
    /// `CODEG_TELEMETRY_SELFTEST` truthy: report one test error at startup.
    pub self_test: bool,
    /// What was wrong with the values, for the startup log.
    pub problems: Vec<String>,
}

impl Default for TelemetryConfig {
    fn default() -> Self {
        resolve(&|_| None)
    }
}

impl TelemetryConfig {
    /// Whether any half is configured.
    pub fn enabled(&self) -> bool {
        self.dsn.is_some() || self.web_dsn.is_some()
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

/// Every variable name [`resolve`] reads, both spellings.
pub fn env_names() -> impl Iterator<Item = String> {
    KEYS.iter().flat_map(|key| {
        [
            format!("CODEG_TELEMETRY_{key}"),
            format!("COWORK_TELEMETRY_{key}"),
        ]
    })
}

pub fn resolve(env: &dyn Fn(&str) -> Option<String>) -> TelemetryConfig {
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
    let user = lookup(env, "USER")
        .or_else(|| {
            ["USER", "LOGNAME"]
                .iter()
                .find_map(|name| non_empty(env(name)))
                .map(|name| match name.strip_prefix("cw-") {
                    Some(rest) if !rest.is_empty() => rest.to_string(),
                    _ => name,
                })
        })
        .unwrap_or_else(|| "unknown".to_string());
    TelemetryConfig {
        dsn: lookup(env, "DSN"),
        web_dsn: lookup(env, "WEB_DSN"),
        environment: lookup(env, "ENV").unwrap_or_else(|| "production".to_string()),
        traces_sample_rate,
        user,
        self_test: crate::cowork::truthy(lookup(env, "SELFTEST").as_deref()),
        problems,
    }
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

    #[test]
    fn nothing_set_is_off() {
        let config = resolve(&env_of(&[("USER", "cw-james")]));
        assert!(!config.enabled());
        assert_eq!(config.environment, "production");
        assert_eq!(config.traces_sample_rate, 1.0);
        assert_eq!(config.user, "james");
        assert!(!config.self_test);
        assert!(config.problems.is_empty());
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
        assert_eq!(names.len(), KEYS.len() * 2);
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
    fn info_targets_match_whole_module_names() {
        assert!(info_log_target("codeg_lib::web::ws"));
        assert!(info_log_target("codeg_lib::acp::manager::inner"));
        assert!(!info_log_target("codeg_lib::web::ws_other"));
        assert!(!info_log_target("codeg_lib::web::router"));
    }
}
