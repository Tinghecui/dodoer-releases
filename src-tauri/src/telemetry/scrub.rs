//! What leaves the machine is scrubbed here (docs/telemetry.md §5.7): no
//! paths, tokens, e-mail addresses, URL paths or query strings, and none of
//! the fields that carry content. The web UI applies the same rules; both
//! test against `src/lib/telemetry/scrub-cases.json`.

use std::sync::LazyLock;

use regex::{Captures, Regex};
use serde_json::Value;

/// Messages are cut to this many characters.
pub const MAX_CHARS: usize = 500;

/// Fields dropped whole, matched on the last segment of the key
/// (`code.file.path` → `path`), case-insensitively.
pub const DROPPED_FIELDS: &[&str] = &[
    "working_dir",
    "cwd",
    "path",
    "file",
    "title",
    "prompt",
    "text",
    "content",
    "token",
    "password",
    "secret",
    "authorization",
    "cookie",
];

pub const REDACTED: &str = "<redacted>";

fn re(pattern: &str) -> Regex {
    Regex::new(pattern).expect("telemetry scrub pattern")
}

static URL: LazyLock<Regex> = LazyLock::new(|| re(r#"(?i)\b[a-z][a-z0-9+.-]*://[^\s"'<>]+"#));
static JWT: LazyLock<Regex> =
    LazyLock::new(|| re(r"\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*"));
static AUTH_SCHEME: LazyLock<Regex> =
    LazyLock::new(|| re(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+"));
static SECRET_VALUE: LazyLock<Regex> = LazyLock::new(|| {
    re(
        r#"(?i)\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+"#,
    )
});
static EMAIL: LazyLock<Regex> =
    LazyLock::new(|| re(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}"));
static WINDOWS_PATH: LazyLock<Regex> = LazyLock::new(|| re(r#"\b[A-Za-z]:\\[^\s"'<>]*"#));
static HOME_PATH: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(^|[\s"'(=:,\[])(?:/home|/Users)/[^/\s"'<>]+(?:/[^\s"'<>]*)?"#));
static DEEP_PATH: LazyLock<Regex> =
    LazyLock::new(|| re(r#"(^|[\s"'(=:,\[])(/[A-Za-z0-9._@+-]+)(?:/[^/\s"'<>),\]]+){2,}/?"#));
static LONG_TOKEN: LazyLock<Regex> = LazyLock::new(|| re(r"[A-Za-z0-9+/=_-]{32,}"));
static UUID: LazyLock<Regex> = LazyLock::new(|| {
    re(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
});

/// A URL keeps its scheme and host; user info, path, query and fragment go.
fn scrub_url(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else {
        return REDACTED.to_string();
    };
    let rest = rest.split(['?', '#']).next().unwrap_or("");
    let (authority, path) = match rest.find('/') {
        Some(at) => rest.split_at(at),
        None => (rest, ""),
    };
    let host = authority.rsplit('@').next().unwrap_or("");
    let path = if path.is_empty() || path == "/" {
        path.to_string()
    } else {
        format!("/{REDACTED}")
    };
    format!("{scheme}://{host}{path}")
}

/// A run of 32+ token characters with both letters and digits is a key, a
/// hash or a token — unless it holds a UUID (connection and session ids).
fn scrub_long_token(token: &str) -> String {
    let digit = token.chars().any(|c| c.is_ascii_digit());
    let letter = token.chars().any(|c| c.is_ascii_alphabetic());
    if digit && letter && !UUID.is_match(token) {
        REDACTED.to_string()
    } else {
        token.to_string()
    }
}

/// Scrub one string.
pub fn scrub_text(text: &str) -> String {
    let s = URL.replace_all(text, |c: &Captures| scrub_url(&c[0]));
    let s = JWT.replace_all(&s, REDACTED);
    let s = AUTH_SCHEME.replace_all(&s, format!("${{1}} {REDACTED}").as_str());
    let s = SECRET_VALUE.replace_all(&s, format!("${{1}}${{2}}{REDACTED}").as_str());
    let s = EMAIL.replace_all(&s, "<email>");
    let s = WINDOWS_PATH.replace_all(&s, "<path>");
    let s = HOME_PATH.replace_all(&s, format!("${{1}}~/{REDACTED}").as_str());
    let s = DEEP_PATH.replace_all(&s, format!("${{1}}${{2}}/{REDACTED}").as_str());
    let s = LONG_TOKEN.replace_all(&s, |c: &Captures| scrub_long_token(&c[0]));
    truncate(&s)
}

fn truncate(text: &str) -> String {
    match text.char_indices().nth(MAX_CHARS) {
        Some((at, _)) => format!("{}…", &text[..at]),
        None => text.to_string(),
    }
}

/// Whether a field named `key` is dropped whole.
pub fn drops_field(key: &str) -> bool {
    let last = key.rsplit(['.', ':']).next().unwrap_or(key);
    DROPPED_FIELDS
        .iter()
        .any(|name| name.eq_ignore_ascii_case(last))
}

/// Scrub a JSON value: strings scrubbed, dropped fields removed from objects
/// at any depth.
pub fn scrub_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(scrub_text(&s)),
        Value::Array(items) => Value::Array(items.into_iter().map(scrub_value).collect()),
        Value::Object(map) => Value::Object(
            map.into_iter()
                .filter(|(key, _)| !drops_field(key))
                .map(|(key, value)| (key, scrub_value(value)))
                .collect(),
        ),
        other => other,
    }
}

/// [`scrub_value`] over a map's entries.
pub fn scrub_map<M>(map: M) -> M
where
    M: IntoIterator<Item = (String, Value)> + FromIterator<(String, Value)>,
{
    map.into_iter()
        .filter(|(key, _)| !drops_field(key))
        .map(|(key, value)| (key, scrub_value(value)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The cases the web UI tests against too.
    const CASES: &str = include_str!("../../../src/lib/telemetry/scrub-cases.json");

    #[test]
    fn shared_cases() {
        let cases: Value = serde_json::from_str(CASES).unwrap();
        for case in cases["text"].as_array().unwrap() {
            let input = case["in"].as_str().unwrap();
            assert_eq!(
                scrub_text(input),
                case["out"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
        for case in cases["fields"].as_array().unwrap() {
            assert_eq!(
                scrub_value(case["in"].clone()),
                case["out"],
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn long_messages_are_cut() {
        let long = "a".repeat(MAX_CHARS + 100);
        let out = scrub_text(&long);
        assert_eq!(out.chars().count(), MAX_CHARS + 1);
        assert!(out.ends_with('…'));
        let wide = "错".repeat(MAX_CHARS + 1);
        assert_eq!(scrub_text(&wide).chars().count(), MAX_CHARS + 1);
        assert_eq!(scrub_text("short"), "short");
    }

    #[test]
    fn fields_are_matched_on_their_last_segment() {
        assert!(drops_field("working_dir"));
        assert!(drops_field("code.file.path"));
        assert!(drops_field("connection:CWD"));
        assert!(!drops_field("code.module.name"));
        assert!(!drops_field("paths_checked"));
    }

    #[test]
    fn maps_drop_and_scrub() {
        let map: std::collections::BTreeMap<String, Value> = [
            ("cwd".to_string(), Value::from("/home/a/b")),
            ("note".to_string(), Value::from("mail a@b.co")),
        ]
        .into_iter()
        .collect();
        let out = scrub_map(map);
        assert_eq!(out.len(), 1);
        assert_eq!(out["note"], "mail <email>");
    }
}
