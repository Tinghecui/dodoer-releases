//! Per-connection agent stderr ring buffer + diagnostic redaction.
//!
//! When an agent reports `EndTurn` without producing any output, codeg
//! synthesizes an `"empty"` stop reason (see [`crate::acp::connection`]). The
//! ACP wire carries no error in that case — the agent said "success" — so the
//! only evidence available is out-of-band: what the agent printed to stderr,
//! and what codeg failed to parse. This module owns the collection of that
//! evidence.
//!
//! stderr is already tee'd to `tracing::debug!` at the three `with_debug`
//! branches in `connection.rs`, but the default log level is `Info`
//! (`crate::logging::LogLevel::default`), so those lines are dropped by the
//! `EnvFilter` before anyone can read them. Raising the level is not an option
//! (a debug-log storm once produced a 217 GB file), so the buffer lives in
//! memory and is independent of the subscriber.
//!
//! # Security model
//!
//! Everything collected here can end up rendered in the UI and, in server
//! mode, pushed over the WebSocket to attached clients. So **redaction happens
//! on write**: neither [`StderrTail`] nor the caller's turn probe ever holds
//! plaintext, and every read path is therefore safe by construction.
//!
//! Two redaction layers, because the two sources have different threat models:
//!
//! - [`sanitize_diagnostic`] — a denylist for agent stderr. Agent log lines are
//!   mostly free-form prose, and the realistic leak is a credential echoed into
//!   an error message (`invalid api_key=sk-…`). A denylist fits.
//! - [`summarize_parser_error`] — a **default-deny structural allowlist** for
//!   deserialization errors. Those inline the offending *value*, and that value
//!   comes off the `session/update` channel, which carries user prompt text,
//!   file contents, and tool arguments. A denylist cannot be sound there: the
//!   delimiter varies (`"…"`, `` `…` ``), escapes defeat naive matching, and a
//!   hand-written `Deserialize` can interpolate a value with no delimiter at
//!   all. So instead of scrubbing the text we rebuild it from templates, and
//!   anything unrecognized is discarded whole.

use std::collections::VecDeque;
use std::sync::{Mutex, OnceLock};

use regex::Regex;

/// Max lines retained. Bounds memory for a chatty agent; the tail is all
/// anyone reads.
const MAX_LINES: usize = 200;
/// Max total bytes retained across all lines.
const MAX_BYTES: usize = 32 * 1024;
/// Max bytes retained for a single line. Agents occasionally dump a whole JSON
/// blob on one line; keep the head, which is where the message lives.
const MAX_LINE_BYTES: usize = 512;
/// Upper bound on how much of an input line is scanned for redaction. Beyond
/// this the tail is discarded outright (never retained), so it bounds the
/// regex cost without opening a truncation-boundary leak.
const MAX_SCAN_BYTES: usize = 16 * 1024;
/// Max bytes for a summarized parser error.
const MAX_DROP_ERROR_BYTES: usize = 200;

/// Where a [`tail_since`](StderrTail::tail_since) slice came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TailScope {
    /// Lines emitted after the mark — i.e. during the turn being diagnosed.
    ThisTurn,
    /// The mark matched nothing, so this is the most recent output from
    /// *before* the turn (typically a connect-time failure). Rendered with a
    /// different label so the reader isn't told stale lines are fresh.
    Recent,
}

/// Result of [`StderrTail::tail_since`].
#[derive(Debug, Clone)]
pub struct TailSlice {
    pub lines: Vec<String>,
    pub scope: TailScope,
}

impl TailSlice {
    pub fn is_empty(&self) -> bool {
        self.lines.is_empty()
    }
}

/// Bounded ring buffer of an agent process's stderr, redacted on write.
///
/// Written from the `with_debug` callback, whose signature is a synchronous
/// `Fn(&str, LineDirection) + Send + Sync` (see `acp::agent_process`), so the
/// lock is a `std::sync::Mutex` — there is no `.await` inside and a tokio mutex
/// would not compile there.
#[derive(Debug, Default)]
pub struct StderrTail {
    inner: Mutex<TailInner>,
}

#[derive(Debug, Default)]
struct TailInner {
    lines: VecDeque<(u64, String)>,
    next_seq: u64,
    bytes: usize,
    /// Where a private key printed line by line has got to: the lines arrive
    /// one at a time, so no single line shows the block a rule could
    /// recognise.
    key: KeyBlock,
    /// The words that came before the BEGIN on its line (a timestamp,
    /// `[agent]`), by shape: the key's other lines carry as many, alike.
    key_prefix: Vec<String>,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
enum KeyBlock {
    #[default]
    Out,
    /// Past the BEGIN line, before the first line of base64: where an
    /// encrypted key's `Proc-Type:` and a PGP key's `Version:` go.
    Headers,
    Body,
}

/// A line a PEM private key's body is made of: base64, or its END line.
fn looks_like_key_body(line: &str) -> bool {
    let line = line.trim();
    line.starts_with("-----END")
        || line
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'+' | b'/' | b'='))
}

const KEY_HEADERS: [&str; 6] = [
    "Proc-Type",
    "DEK-Info",
    "Version",
    "Comment",
    "Hash",
    "Charset",
];

/// One of the header lines PEM and PGP put between a key's BEGIN line and its
/// base64. By name: `Error: …` has the same shape.
fn looks_like_key_header(line: &str) -> bool {
    line.trim()
        .split_once(": ")
        .is_some_and(|(name, _)| KEY_HEADERS.contains(&name))
}

/// How many whole words come before a marker: `head` is its line up to the
/// marker. A word glued to it (`key=-----BEGIN`) is not one the next lines
/// repeat.
fn prefix_words(head: &str) -> usize {
    let words = head.split_whitespace().count();
    if head.ends_with(char::is_whitespace) || head.is_empty() {
        words
    } else {
        words - 1
    }
}

/// A word with its digits all `9`: a timestamp on one line has the shape of
/// the timestamp on the next.
fn word_shape(word: &str) -> String {
    word.chars()
        .map(|c| if c.is_ascii_digit() { '9' } else { c })
        .collect()
}

/// The whole words before a marker, by shape (see [`prefix_words`]).
fn prefix_shapes(head: &str) -> Vec<String> {
    head.split_whitespace()
        .take(prefix_words(head))
        .map(word_shape)
        .collect()
}

/// A line that is only a prefix like `shapes`: the blank line inside a PGP
/// key (or after an encrypted key's headers) as a logger prints it.
fn only_prefix(line: &str, shapes: &[String]) -> bool {
    !shapes.is_empty()
        && line
            .split_whitespace()
            .map(word_shape)
            .eq(shapes.iter().cloned())
}

/// The part of `line` a key's line would be, past as many words as its BEGIN
/// line had before the marker (a timestamp changes, its word count does not).
/// `None` for a line too short to be one.
fn past_prefix(line: &str, words: usize) -> Option<&str> {
    let mut rest = line.trim();
    for _ in 0..words {
        let at = rest.find(char::is_whitespace)?;
        rest = rest[at..].trim_start();
    }
    (!rest.is_empty()).then_some(rest)
}

/// `text` without a private key's body cut off from its BEGIN line: what a
/// tail kept of a key printed before the cut, up to its END line. The masking
/// rules find a key by its BEGIN. Only for text that was cut: only lines a
/// key's body is made of may come before that END.
pub fn without_cut_key_head(text: &str) -> &str {
    let Some(end) = text.find("-----END") else {
        return text;
    };
    // The END line's own prefix says how many words each key line carries.
    let end_line = text[..end].rfind('\n').map_or(0, |i| i + 1);
    let words = prefix_words(&text[end_line..end]);
    let shapes = prefix_shapes(&text[end_line..end]);
    let closes_key = text[end..].lines().next().is_some_and(|line| {
        // The END line, or one inside a JSON string (`-----\n"}`).
        let line = line.trim_end();
        line.contains("PRIVATE KEY")
            && (line.ends_with("-----") || line.contains("-----\\n") || line.contains("-----\""))
    });
    // The first line is where the cut fell: in the base64, the BEGIN line,
    // or a header.
    let cut_line = |line: &str| {
        let line = line.trim();
        // A whole BEGIN line was not cut: the masking finds that key.
        (line.ends_with("-----") && !line.contains("-----BEGIN"))
            || line.split_once(": ").is_some_and(|(name, _)| {
                !name.is_empty() && KEY_HEADERS.iter().any(|known| known.ends_with(name))
            })
    };
    let all_body = text[..end_line].lines().enumerate().all(|(i, line)| {
        let part = past_prefix(line, words);
        line.trim().is_empty()
            || only_prefix(line, &shapes)
            || part.is_some_and(|p| looks_like_key_body(p) || looks_like_key_header(p))
            || (i == 0
                && (cut_line(line)
                    || line
                        .split_whitespace()
                        .last()
                        .is_some_and(looks_like_key_body)))
    });
    if !closes_key || !all_body {
        return text;
    }
    let after = text[end..].find('\n').map_or(text.len(), |i| end + i + 1);
    &text[after..]
}

impl StderrTail {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record one stderr line. ANSI-stripped, trimmed, redacted, and truncated
    /// before it lands — the buffer never holds plaintext.
    ///
    /// A poisoned lock is recovered rather than propagated: this is a
    /// diagnostic side channel and must never be able to take down a live
    /// agent connection.
    ///
    /// `false` for a line of a private key's body: the caller must not log it
    /// either.
    pub fn push(&self, raw: &str) -> bool {
        let line = strip_ansi(raw);
        let line = line.trim_end();
        if line.is_empty() {
            return true;
        }
        // Bound the regex scan for a pathological multi-MB line. Whatever is
        // dropped here is dropped entirely — never retained unredacted — and
        // the surviving prefix is orders of magnitude shorter than this cap.
        let scanned = truncate_bytes(line, MAX_SCAN_BYTES);
        let key_marker = |edge: &str| scanned.contains(edge) && scanned.contains("PRIVATE KEY");
        // A line that ends with the BEGIN marker opens a key, whatever comes
        // before it; one that only mentions it (`… -----BEGIN … KEY----- in
        // key.pem`) does not.
        let opens = key_marker("-----BEGIN") && scanned.trim_end().ends_with("-----");
        {
            let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            // The line past its prefix: the BEGIN line's word count, or fewer
            // (a label such as `key:` only the BEGIN line had; none at all for
            // a key printed as a value). Before the first line of base64 only
            // one long enough to be base64 counts, not a word like `Done` or
            // the `1` of `exit 1` after a marker that was only mentioned.
            let parts =
                || (0..=inner.key_prefix.len()).filter_map(|words| past_prefix(&scanned, words));
            let in_body = inner.key == KeyBlock::Body;
            let body = inner.key != KeyBlock::Out
                && parts().any(|p| {
                    looks_like_key_body(p)
                        && (in_body
                            || p.len() >= 16
                            || p.ends_with('=')
                            || p.starts_with("-----END"))
                });
            let header = inner.key == KeyBlock::Headers && parts().any(looks_like_key_header);
            // A key's blank line, printed with the prefix alone, keeps it open.
            let blank = inner.key != KeyBlock::Out && only_prefix(&scanned, &inner.key_prefix);
            if opens {
                inner.key = if key_marker("-----END") {
                    KeyBlock::Out
                } else {
                    KeyBlock::Headers
                };
                inner.key_prefix = scanned
                    .find("-----BEGIN")
                    .map(|at| prefix_shapes(&scanned[..at]))
                    .unwrap_or_default();
            } else if body || header {
                // The key's body is never kept; its END line closes the block.
                inner.key = if key_marker("-----END") {
                    KeyBlock::Out
                } else if body {
                    KeyBlock::Body
                } else {
                    KeyBlock::Headers
                };
                return false;
            } else if blank {
                return false;
            } else {
                // A line no key holds: the BEGIN was only mentioned (an error
                // message, a command line) or the key was cut short.
                inner.key = KeyBlock::Out;
            }
        }
        // Redact BEFORE truncating to the retained length. The other order
        // lets a credential straddling the cut survive as an unrecognized
        // fragment: `sk-…` needs 12 trailing chars to match, so a token sliced
        // at byte 512 would sail straight through the denylist. The rules by
        // shape first (`AIza…`, `"apiKey": "…"`), then the `name=value` ones.
        let line = sanitize_diagnostic(&redact_credentials(&scanned));
        let line = truncate_bytes(&line, MAX_LINE_BYTES);
        if line.is_empty() {
            return true;
        }

        let mut inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let seq = inner.next_seq;
        inner.next_seq += 1;
        inner.bytes += line.len();
        inner.lines.push_back((seq, line));
        while inner.lines.len() > MAX_LINES || (inner.bytes > MAX_BYTES && inner.lines.len() > 1) {
            match inner.lines.pop_front() {
                Some((_, dropped)) => inner.bytes = inner.bytes.saturating_sub(dropped.len()),
                None => break,
            }
        }
        true
    }

    /// Snapshot the current write position. Taken before a turn's prompt
    /// request is dispatched, so "this turn" has a defined lower bound.
    pub fn mark(&self) -> u64 {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        inner.next_seq
    }

    /// Lines recorded at or after `mark`, newest-last, capped.
    ///
    /// Falls back to the most recent lines overall when the turn itself
    /// produced no stderr — a connect-time failure is still the best evidence
    /// available — and says so via [`TailScope`].
    pub fn tail_since(&self, mark: u64, max_lines: usize, max_bytes: usize) -> TailSlice {
        let inner = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        let this_turn: Vec<&String> = inner
            .lines
            .iter()
            .filter(|(seq, _)| *seq >= mark)
            .map(|(_, line)| line)
            .collect();
        let (source, scope) = if this_turn.is_empty() {
            (
                inner.lines.iter().map(|(_, line)| line).collect::<Vec<_>>(),
                TailScope::Recent,
            )
        } else {
            (this_turn, TailScope::ThisTurn)
        };

        // Take from the tail: the last lines before the turn ended are the
        // ones that explain why.
        let mut picked: Vec<String> = Vec::new();
        let mut used = 0usize;
        for line in source.iter().rev() {
            if picked.len() >= max_lines || used + line.len() > max_bytes {
                break;
            }
            used += line.len();
            picked.push((*line).clone());
        }
        picked.reverse();
        TailSlice {
            lines: picked,
            scope,
        }
    }
}

/// Strip ANSI escape sequences (CSI and OSC) that agents use for colored logs.
fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\u{1b}' {
            out.push(c);
            continue;
        }
        match chars.peek() {
            // CSI: ESC [ ... final-byte in @-~
            Some('[') => {
                chars.next();
                for c in chars.by_ref() {
                    if ('\u{40}'..='\u{7e}').contains(&c) {
                        break;
                    }
                }
            }
            // OSC: ESC ] ... BEL or ESC \
            Some(']') => {
                chars.next();
                while let Some(c) = chars.next() {
                    if c == '\u{7}' {
                        break;
                    }
                    if c == '\u{1b}' && chars.peek() == Some(&'\\') {
                        chars.next();
                        break;
                    }
                }
            }
            // Two-character escape (ESC c, ESC =, …): drop the pair.
            Some(_) => {
                chars.next();
            }
            None => {}
        }
    }
    out
}

/// `line` for a debug log record: masked, then cut to about `max` bytes. The
/// other order leaves a key cut at the edge, which no rule recognises.
pub fn log_excerpt(line: &str, max: usize) -> String {
    let scanned = truncate_bytes(line, MAX_SCAN_BYTES);
    let masked = redact_credentials(&scanned);
    if line.len() <= max && masked.len() <= max {
        return masked.into_owned();
    }
    let head = masked
        .char_indices()
        .take_while(|(i, _)| *i < max)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    format!(
        "{}... <truncated {} bytes>",
        &masked[..head],
        line.len().saturating_sub(head)
    )
}

/// Truncate to at most `max` bytes without splitting a UTF-8 char.
fn truncate_bytes(s: &str, max: usize) -> String {
    if s.len() <= max {
        return s.to_string();
    }
    let end = s
        .char_indices()
        .take_while(|(i, c)| i + c.len_utf8() <= max)
        .last()
        .map(|(i, c)| i + c.len_utf8())
        .unwrap_or(0);
    let mut out = s[..end].to_string();
    out.push('…');
    out
}

/// Collapse runs of whitespace into single spaces.
fn collapse_whitespace(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

type Rules = Vec<(Regex, &'static str)>;

/// Credential-shaped patterns replaced in free-form diagnostic text.
///
/// Conservative by design — over-redacting a log line costs nothing, and this
/// is the only thing standing between an agent's error output and the UI.
fn denylist() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| {
        let rules: Vec<(&str, &str)> = vec![
            // Header forms first: they subsume any scheme (Bearer/Basic/Digest/custom).
            // These consume to end of line, not `\S+`: a header value is
            // whitespace-separated from its scheme (`Authorization: Bearer <tok>`),
            // so stopping at the first space would leave the token behind.
            // Over-eating trailing context is the safe direction here.
            (r"(?i)\bauthorization\s*[:=]\s*.*", "Authorization: ***"),
            (r"(?i)\b(set-)?cookie\s*[:=]\s*.*", "${1}cookie: ***"),
            // Bare `Bearer <token>` with no header prefix.
            (r"(?i)\bbearer\s+[A-Za-z0-9._\-]{12,}", "Bearer ***"),
            // Named secrets in `k=v` / `k: v` form.
            (
                r"(?i)\b(api[_\-]?key|access[_\-]?token|auth[_\-]?token|refresh[_\-]?token|id[_\-]?token|client[_\-]?secret|secret|passwd|password|private[_\-]?key)\b\s*[:=]\s*\S+",
                "$1=***",
            ),
            // Credentials embedded in a URI authority.
            (
                r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]+@",
                "${1}***:***@",
            ),
            // Same, but without the terminating `@`. The rule above needs that
            // terminator, so a very long password whose `@` falls past the scan
            // bound would go unmatched and its head would survive the retained
            // 512 bytes. Requiring 16+ non-`/` characters after the colon keeps
            // this off ordinary `host:port` URLs (a port is at most 5 digits and
            // is followed by `/` or end).
            (
                r"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@]+:[^/\s@]{16,}",
                "${1}***:***",
            ),
            // Well-known token shapes.
            (r"sk-[A-Za-z0-9_\-]{12,}", "sk-***"),
            (r"\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", "${1}_***"),
            (r"\bxox[abeprs]-[A-Za-z0-9\-]{10,}", "xox*-***"),
            (r"\bAKIA[0-9A-Z]{16}\b", "AKIA***"),
            (
                r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+",
                "<jwt ***>",
            ),
            (
                r"-----BEGIN [A-Z ]*PRIVATE KEY-----",
                "-----BEGIN PRIVATE KEY (redacted)-----",
            ),
        ];
        rules
            .into_iter()
            .filter_map(|(pattern, replacement)| {
                // A malformed pattern must not take the process down; drop it
                // (the remaining rules still apply) and say so loudly.
                match Regex::new(pattern) {
                    Ok(re) => Some((re, replacement)),
                    Err(e) => {
                        tracing::error!("[stderr_tail] invalid redaction pattern {pattern:?}: {e}");
                        None
                    }
                }
            })
            .collect()
    })
}

/// Redact credential-shaped substrings from free-form diagnostic text.
///
/// Used for agent stderr, and as a final backstop after
/// [`summarize_parser_error`] has already rebuilt its input from templates.
pub fn sanitize_diagnostic(s: &str) -> String {
    let mut out = s.to_string();
    for (re, replacement) in denylist() {
        out = re.replace_all(&out, *replacement).into_owned();
    }
    out
}

/// Replace strings that ARE credentials by their shape — provider keys, GitHub
/// and Slack tokens, AWS key ids, JWTs, private-key blocks, bearer tokens,
/// passwords inside URLs — and values assigned to a secret's name the way
/// `env`, `.env`, JSON and TOML files write them (`OPENAI_API_KEY=…`,
/// `"apiKey": "…"`, `api_key = "…"`), and nothing that merely sits near a word
/// like "password". For text people still read (a conversation shared with an
/// organization), where [`sanitize_diagnostic`]'s `key: value` rules would
/// also eat ordinary code such as `password: String`.
pub fn redact_credentials(s: &str) -> std::borrow::Cow<'_, str> {
    static RULES: OnceLock<Rules> = OnceLock::new();
    let rules = RULES.get_or_init(|| {
        [
            (
                r"-----BEGIN ([A-Z ]*)PRIVATE KEY( BLOCK)?-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY( BLOCK)?-----|\z)",
                "-----BEGIN ${1}PRIVATE KEY${2} (redacted)-----",
            ),
            (r"(?i)(^|[^A-Za-z0-9_]|\\[nrt])bearer\s+[A-Za-z0-9._\-+/=~]{12,}", "${1}Bearer ***"),
            // The user may be empty: `redis://:password@host`. The password
            // may hold `/` and `@` (`openssl rand -base64`): it runs to the
            // last `@`, not past a `?` or `#`; one with no `/` may hold `?`
            // and `#` too, and ends at the host. Not a port and a path:
            // `localhost:5173/@vite/client`.
            (
                r#"([a-zA-Z][a-zA-Z0-9+.\-]*://)[^/\s:@'"]*:(?:[0-9]*[^0-9/\s'"@?#][^\s'"?#]*|[^\s'"/0-9?#@][^\s'"/]*|[0-9]*)@"#,
                "${1}***:***@",
            ),
            // A token as the user: `https://<token>@github.com/…`.
            (r"(://)[A-Za-z0-9_\-]{30,}@", "${1}***@"),
            // Azure's SAS signature, CloudFront's, OpenWeather's `appid`,
            // Firebase's `auth`.
            (r#"([?&](?:sig|Signature|auth)=)[^&\s"'\\#]{16,}"#, "${1}***"),
            // OpenWeather's is 32 long; WeChat's `wx…` appid is public.
            (r#"([?&]appid=)[^&\s"'\\#]{24,}"#, "${1}***"),
            // Webhook URLs are their own key: Slack, Discord, Feishu and
            // Lark, WeCom, Teams.
            (r"(hooks\.slack\.com/services/)[A-Za-z0-9/]{16,}", "${1}***"),
            (
                r"(open\.(?:feishu\.cn|larksuite\.com)/open-apis/bot/v2/hook/)[A-Za-z0-9\-]{16,}",
                "${1}***",
            ),
            (r"(qyapi\.weixin\.qq\.com/cgi-bin/webhook/send\?key=)[A-Za-z0-9\-]{16,}", "${1}***"),
            (r#"(webhook\.office\.com/webhookb2/)[^\s"'\\]{16,}"#, "${1}***"),
            (r"(discord(?:app)?\.com/api/webhooks/[0-9]+/)[A-Za-z0-9_\-]{16,}", "${1}***"),
            // A key's prefix must not sit inside a word (`task-scheduler-panel`
            // is a name), but may follow an escaped line break or tab: JSONL
            // that does not parse arrives with `\n` as two characters.
            (r"(^|[^A-Za-z0-9_]|\\[nrt])sk-[A-Za-z0-9_\-]{12,}", "${1}sk-***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])(sk|rk)_(live|test)_[A-Za-z0-9]{16,}", "${1}${2}_${3}_***"),
            (
                r#"(^|[^A-Za-z0-9_]|\\[nrt])((?:[A-Z][A-Z0-9_]*)?(?:(?:_KEY|APIKEY|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIALS?)[A-Z0-9_]*|TOKEN(?:[A-Z0-9_]*[A-RT-Z0-9_])?|_PWD|_PASS|_AUTH|_PAT|_SK))=("[^"\n]*"|'[^'\n]*'|[^\s"'/~][^\s"']*)"#,
                "${1}${2}=***",
            ),
            // A value starting with `/` is a path (`PUBLIC_KEY_PATH=/home/…`,
            // `SSL_KEY=/etc/ssl/server.key`) unless it is all base64 under a
            // name ending in the secret: base64 starts with `/` too.
            (
                r#"(^|[^A-Za-z0-9_]|\\[nrt])([A-Z0-9_]*(?:SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|_KEY|APIKEY)(?:_BASE)?)=/[A-Za-z0-9+/]{19,}={0,2}([\s"']|$)"#,
                "${1}${2}=***${3}",
            ),
            // The words `names_a_secret` (org/origin.rs) masks parsed JSON
            // by, for JSON that is text: a file as the agent read it, with
            // line numbers in front, never parses. Quotes may be escaped:
            // JSON inside a command's string (`curl -d "{\"token\":…}"`).
            (
                r#"(?i)(\\?"(?:[A-Za-z0-9_.\-]*(?:api[_\-]?key|private[_\-]?key|secret|token|password|passwd|credentials?|authorization|cookie)[A-Za-z0-9_.\-]*|[A-Za-z0-9_.\-]*auth)\\?"\s*:\s*)(\\?")[^"\n]{8,}""#,
                "${1}${2}***${2}",
            ),
            // `.npmrc`: `//registry.npmjs.org/:_authToken=…`, `_auth=…`,
            // `_password=…`. Only where `.npmrc` puts them: a line's start or
            // after the registry's `:`, so `self._auth = auth` in code stays.
            (
                r"(?m)((?:(?:^|\\[nr])[ \t]*(?:[0-9]+(?:\t|→|\\t))?[ \t]*|:)_(?:auth(?:Token)?|password)\s*=\s*)[^\s\\]+",
                "${1}***",
            ),
            // HTTP headers in `curl -v` output and in a command line.
            (
                r"(?i)(authorization:\s*basic\s+)[A-Za-z0-9+/=]{8,}",
                "${1}***",
            ),
            // Any scheme (`Token`, `Bot`, none, a key with `+/=`), where a
            // header is written: a line's start, `-H "…"`, `curl -v`'s `> `.
            // `authorization: Option<String>` and `headers.authorization`
            // in code stay.
            (
                r#"(?im)((?:^|\\[nr]|-H[ \t]+['"]?|[<>][ \t])[ \t]*(?:proxy-)?authorization:[ \t]*(?:(?:bearer|basic|token|bot|digest|apikey)[ \t]+)?)[^\s"'\\<>(){}.,;]{8,}"#,
                "${1}***",
            ),
            // In code and in `--header`: `{'Authorization': 'Token …'}`,
            // `{ Authorization: "Basic …" }`; the scheme says it is one.
            (
                r#"(?i)(authorization['"]?[ \t]*[:=][ \t]*['"]?(?:bearer|basic|token|bot|digest|apikey)[ \t]+)[A-Za-z0-9+/=._~\-]{8,}"#,
                "${1}***",
            ),
            (
                r#"(?i)((?:^|[^A-Za-z0-9_])(?:(?:[a-z0-9]+-)*(?:api-key|auth-token|access-token|vault-token|auth-key|api-token|subscription-key|secret-key|figma-token|functions-key|client-secret|api-secret|security-token)|private-token|apikey):[ \t]*)[^\s"'\\]{8,}"#,
                "${1}***",
            ),
            // Cookies: a header, `Set-Cookie` in `curl -i` output, `curl -b`.
            (
                r#"(?i)((?:^|[^A-Za-z0-9_-])(?:set-)?cookie:[ \t]*)[^\r\n'"\\]+"#,
                "${1}***",
            ),
            // A quoted `-b '…; …'` (a browser's "Copy as cURL") is masked to
            // its closing quote: the session cookie is rarely the first.
            (
                r#"(\s(?:-b|--cookie)[ \t]+\\?['"])[^'"\r\n\\=\s]+=[^'"\r\n\\]+"#,
                "${1}***",
            ),
            (
                r#"(\s(?:-b|--cookie)[ \t]+['"]?)[^\s'"\\=]+=[^\s'"\\]+"#,
                "${1}***",
            ),
            // `curl -u user:password`, quoted or `--user=`; HTTPie's `--auth`,
            // and its `-a` (elsewhere `rsync -a host:dir` is not a password).
            (
                r"(\bhttps?\s(?:[^\n;&|]*?\s)?-a[ \t]+[\x22']?[^\s:\x22'\\]+:)[^\s\x22'\\]+",
                "${1}***",
            ),
            (
                r"(\s(?:-u|--user|--auth)(?:\s+|=)[\x22']?[^\s:\x22'\\]*[^\s:\x22'\\0-9][^\s:\x22'\\]*:)[^\s\x22'\\/][^\s\x22'\\]*",
                "${1}***",
            ),
            // Mid-line: a command's flag, `docker login -p`, a URL query or a
            // connection string, a JavaScript object.
            (
                r#"(?i)((?:^|\s)--(?:[a-z0-9]+-)*(?:password|passwd|pass|pwd|token|secret|api-?key|access-?key|auth-token|auth-?key|authtoken)(?:=|[ \t]+)\\?['"]?)[^\s"'\\\-][^\s"'\\]{5,}"#,
                "${1}***",
            ),
            // In one command: `login … && mkdir -p dir` keeps its `-p dir`.
            (
                r#"(\blogin\s(?:[^\n;&|]*?\s)?-p[ \t]*\\?['"]?)[^\s"'\\\-][^\s"'\\]{5,}"#,
                "${1}***",
            ),
            // `mysql -pPassword`, `sshpass -p …`, `redis-cli -a …`,
            // OpenSSL's `pass:…`, Redis's `requirepass …`.
            // The client as the command, not a word in one: `docker run
            // --name mysql -p3306:3306` and `find -name "*mysql*"` stay.
            (
                r#"((?:^|[\n;&|(`]|\\[nr]|\bsudo|\$\(|/)[ \t]*(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\s(?:[^\n;&|]*?\s)?-p\\?['"]?)[^\s"'\\]{4,}"#,
                "${1}***",
            ),
            // sshpass's own `-p`, before the program it runs: `sshpass -f
            // file ssh host -p2222` keeps ssh's port.
            (
                r#"(\bsshpass\s+(?:-[a-zA-Z]\S*\s+)*?-p[ \t]*\\?['"]?)[^\s"'\\\-][^\s"'\\]{3,}"#,
                "${1}***",
            ),
            (
                r#"(\bredis-cli\b[^\n;&|]*?\s(?:-a|--pass)[ \t]+\\?['"]?)[^\s"'\\]{4,}"#,
                "${1}***",
            ),
            // `--secret-key …`, `--private-key …`, not a key file's path
            // (Ansible's `--private-key ~/.ssh/id_rsa`).
            (
                r#"(?i)((?:^|\s)--(?:[a-z0-9]+-)*(?:secret|private)-key(?:=|[ \t]+)\\?['"]?)[^\s"'\\\-/~.][^\s"'\\]{5,}"#,
                "${1}***",
            ),
            // A key that happens to start with `/`: one slash, then base64
            // with no further `/` or `.` (a path has those).
            (
                r#"(?im)((?:^|\s)--(?:[a-z0-9]+-)*(?:secret|private)-key(?:=|[ \t]+)\\?['"]?)/[A-Za-z0-9+=]{19,}(\s|\\?["']|$)"#,
                "${1}***${2}",
            ),
            // `docker exec -it db mysql -uroot -p…`, `kubectl exec … -- mysql`
            // (not `docker run … mysql -p3306:3306`, a port).
            (
                r#"(\bexec\s[^\n;&|]*?\s(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\s(?:[^\n;&|]*?\s)?-p\\?['"]?)[^\s"'\\]{4,}"#,
                "${1}***",
            ),
            // SQL Server's `sqlcmd -P`, MongoDB's tools' `-p`.
            (r#"(\bsqlcmd\b[^\n;&|]*?\s-P[ \t]*\\?['"]?)[^\s"'\\]{4,}"#, "${1}***"),
            (
                r#"(\b(?:mongosh|mongo|mongodump|mongorestore|mongoexport|mongoimport)\b[^\n;&|]*?\s(?:-p|--password)(?:[ \t]+|=)\\?['"]?)[^\s"'\\\-][^\s"'\\]{3,}"#,
                "${1}***",
            ),
            // SQL: `CREATE USER … WITH PASSWORD '…'`, `ALTER USER … PASSWORD
            // '…'`, `IDENTIFIED [WITH plugin] BY '…'`, `CREATE LOGIN … WITH
            // PASSWORD = '…'`.
            (
                r#"(\b(?:(?i:with)\s+(?i:password)|PASSWORD|IDENTIFIED(?:\s+WITH\s+\w+)?\s+BY|(?i:identified)\s+(?i:by))\s*=?\s*\\?')[^'\n\\]{4,}"#,
                "${1}***",
            ),
            // A sudo password piped in: `echo '…' | sudo -S …`.
            (
                r#"(\b(?:echo|printf)\s+\\?['"]?)[^\s'"|\\]{4,}(\\?['"]?\s*\|\s*sudo\s+(?:-\w+\s+)*-S)"#,
                "${1}***${2}",
            ),
            // A registry password piped in: `echo … | docker login
            // --password-stdin`.
            (
                r#"(\b(?:echo|printf)\s+(?:-n\s+)?\\?['"]?)[^\s'"|\\$]{4,}(\\?['"]?\s*\|\s*(?:sudo\s+(?:-[ugCDhpRrTt]\s+\S+\s+|-\S+\s+)*)?(?:docker|podman|helm|nerdctl)\s+(?:registry\s+)?login\b[^\n;&|]*--password-stdin)"#,
                "${1}***${2}",
            ),
            // `ngrok config add-authtoken …`; a printed Python header dict's
            // `'Cookie': '…'`.
            (r#"(\badd-authtoken\s+)[^\s"'\\]{10,}"#, "${1}***"),
            (
                r#"(?i)(\\?['"]cookie\\?['"]\s*:\s*\\?['"][^'"\n\\=]+=)[^'"\n\\]{4,}"#,
                "${1}***",
            ),
            (r#"(-pass(?:in|out)?[ \t]+pass:)[^\s"'\\]{4,}"#, "${1}***"),
            (r#"(\bopenssl\b[^\n;&|]*?\s-k[ \t]+)[^\s"'\\\-][^\s"'\\]{3,}"#, "${1}***"),
            // `htpasswd -b file user password`, `aws configure set
            // aws_secret_access_key …`, `gh secret set NAME --body …`.
            (
                r#"(\bhtpasswd\s(?:[^\n;&|]*?\s)?-[a-zA-Z]*b[a-zA-Z]*\s+\S+\s+\S+\s+)[^\s"'\\]+"#,
                "${1}***",
            ),
            (
                r#"(\baws\s+configure\s+set\s+\S*(?:secret_access_key|session_token)\s+)[^\s"'\\]+"#,
                "${1}***",
            ),
            (
                r#"(\bgh\s+secret\s+set\b[^\n;&|]*?\s(?:--body|-b)[= \t]+['"]?)[^\s"'\\]{4,}"#,
                "${1}***",
            ),
            // `auth=("user", "…")`, `HTTPBasicAuth("user", "…")`.
            (
                r#"((?:\bauth[ \t]*=[ \t]*\(|\bHTTP(?:Basic|Digest)Auth\()[ \t]*['"][^'"\n]*['"][ \t]*,[ \t]*['"])[^'"\n]{4,}"#,
                "${1}***",
            ),
            // Mid-line in lower case: a libpq DSN (`"host=db password=…"`),
            // `--from-literal=password=…`, `docker run -e api_key=…`, a
            // dotted flag (`--set auth.rootPassword=…`, `-Dgpg.passphrase=…`),
            // Java's and Gradle's (`-DdbPassword=…`, `-PsigningPassword=…`). A
            // value with a digit: `token=$TOKEN`, `password=password` stay.
            (
                r#"(?i)((?:^|[\s'"=.]|\s-[DP])[a-z0-9_]*(?:password|passwd|passphrase|pwd|secret|token|api_?key|access_?key)=['"]?)(?:[0-9][^\s'"\\(),]{5,}|[^\s'"\\$=(),/~0-9.][^\s'"\\(),]*[0-9][^\s'"\\(),]*)"#,
                "${1}***",
            ),
            (
                r#"(?im)((?:^|\\[nr])[ \t]*(?:[0-9]+(?:\t|→|\\t))?[ \t]*(?:requirepass|masterauth)[ \t]+)[^\s"'\\]+"#,
                "${1}***",
            ),
            // A URL's query or fragment (`#access_token=` from OAuth), a
            // connection string (`;Password=`, Azure's `;AccountKey=`).
            (
                r#"(?i)([?&;#][ \t]*[a-z0-9_.\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|account[_\-]?key|shared[_\-]?access[_\-]?key|credentials?)[ \t]*=)[^&;\s"'\\#]{6,}"#,
                "${1}***",
            ),
            (
                r#"(?i)([{,][ \t]*[a-z0-9_.\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|credentials?)[ \t]*:[ \t]*)(['"])[^'"\n\\]{6,}"#,
                "${1}${2}***",
            ),
            // Go's `%+v` (`{User:app Password:…}`, `map[password:…]`) and
            // Rust's `Debug` (`password: Some("…")`); WordPress's
            // `define('DB_PASSWORD', '…')`.
            (
                r#"(?i)((?:[{\s]|map\[)[a-z0-9_]*(?:password|passwd|secret|token|api_?key)(?:_?(?:access_?)?(?:key|value|hash|base))?:)(?:[0-9][^\s{}\[\]"',]*[a-z][^\s{}\[\]"',]*|[^\s{}\[\]"',0-9][^\s{}\[\]"',]*[0-9][^\s{}\[\]"',]*)"#,
                "${1}***",
            ),
            // Go's headers: `map[Authorization:[Basic …]]`, and from `%#v`
            // `"X-Api-Key":[]string{"…"}`.
            (
                r#"(?i)((?:authorization|x-api-key|api-key|x-auth-token)\\?"?:\[(?:\]string\{\\?")?(?:(?:basic|bearer|token)[ \t]+)?)[^\]"\s]{6,}"#,
                "${1}***",
            ),
            (
                r#"(?i)((?:password|passwd|passphrase|secret|token|api_?key|private_?key)(?:_?(?:access_?)?(?:key|value|hash|base))?:\s*Some\(\s*")[^"\n]{6,}"#,
                "${1}***",
            ),
            (
                r#"(?i)(define\(\s*['"][A-Z0-9_]*(?:PASSWORD|KEY|SALT|SECRET|TOKEN)['"]\s*,\s*['"])[^'"\n]{6,}"#,
                "${1}***",
            ),
            // A quoted or symbol key: a Python dict as printed, Django's
            // settings, PHP and Ruby (`'password' => '…'`, `:password => …`).
            // A value with `|` or spaces is a rule or a message: Laravel's
            // `'password' => 'required|min:8'`.
            (
                r#"(?i)((?:^|[\s{,(])['"]?:?[a-z0-9_.\-]*(?:password|passwd|passphrase|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|credentials?)(?:[_\-]?key)?['"]?[ \t]*(?::|=>)[ \t]*)(['"])[^'"\n\\|\s]{6,}(['"])"#,
                "${1}${2}***${3}",
            ),
            // Netscape cookies.txt: domain, flag, path, secure, expiry,
            // name, value — split by tabs.
            (
                r"(?m)(^[ \t]*(?:[0-9]+(?:\t|→))?[^\s]+\t(?:TRUE|FALSE)\t[^\t\n]*\t(?:TRUE|FALSE)\t[0-9]+\t[^\t\n]+\t)[^\t\n]+",
                "${1}***",
            ),
            // Map and cloud keys in a query: Amap's and Steam's `key`,
            // Baidu's `ak`, Azure Functions' `code`.
            (r"([?&](?:key|ak)=)[0-9A-Za-z]{32}\b", "${1}***"),
            (r"([?&]code=)[A-Za-z0-9_\-]{40,}={0,2}", "${1}***"),
            // A call's keyword argument (`connect(password="…")`) and an
            // index (`os.environ["API_TOKEN"] = "…"`).
            (
                r#"(?i)([(,][ \t]*[a-z0-9_]*(?:password|passwd|pwd|secret|token|api_?key|access_?key|private_?key|credentials?)[ \t]*=[ \t]*['"])[^'"\n\\]{6,}"#,
                "${1}***",
            ),
            (
                r#"(?i)(\[[ \t]*['"][a-z0-9_.\-]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|credentials?)['"][ \t]*\][ \t]*=[ \t]*['"])[^'"\n\\]{6,}"#,
                "${1}***",
            ),
            // `{"name": "DB_PASSWORD", "value": "…"}`: env lists of
            // Kubernetes, ECS and compose, as text.
            (
                r#"(?i)("(?:name|key)"[ \t]*:[ \t]*"[a-z0-9_.\-/]*(?:password|passwd|pwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|credentials?)[a-z0-9_.\-]*"(?:[ \t\r\n]*,[ \t\r\n]*"[a-z]+"[ \t]*:[ \t]*"[^"\n]*")*[ \t\r\n]*,[ \t\r\n]*"value"[ \t]*:[ \t]*")[^"\n]{6,}"#,
                "${1}***",
            ),
            // XML: `<password>…</password>` (Maven), a Hadoop property's
            // `<name>…secret.key</name><value>…`, `<add key="…Password"
            // value="…"/>` (NuGet, web.config).
            (
                r#"(?i)(<(?:[a-z0-9_\-]+:)?[a-z0-9_.\-]*(?:password|passwd|secret|token|api[_\-]?key|access[_\-]?key|private[_\-]?key|credentials?)[a-z0-9_.\-]*>)[^<\n]{4,}(</)"#,
                "${1}***${2}",
            ),
            (
                r#"(?i)(<name>(?:[^<\n]*(?:password|secret|token|credential)[^<\n]*|[^<\n]*[._\-]key)</name>\s*<value>)[^<]{4,}"#,
                "${1}***",
            ),
            (
                r#"(?i)(<add\s+key="(?:[^"]*(?:password|secret|token|apikey)[^"]*|[^"]*key)"\s+value=")[^"]{4,}"#,
                "${1}***",
            ),
            // A table of name and value, as `vault kv get` prints it.
            (
                r"(?im)((?:^|\\[nr])[ \t]*[a-z0-9_.\-]*(?:password|passwd|secret|token|api_?key|access_?key)[ \t]{2,})(?:[^\s\\/]{4,}[0-9][^\s\\/]*|[^\s\\/]*[0-9][^\s\\/]{4,})",
                "${1}***",
            ),
            // kubeconfig's base64 PEM.
            (r"(?i)(\bclient-key-data:[ \t]*)[A-Za-z0-9+/=]{16,}", "${1}***"),
            // `.netrc`: `machine h login u password p`.
            (r"(\blogin\s+\S+\s+password\s+)\S+", "${1}***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}", "${1}${2}_***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])github_pat_[A-Za-z0-9_]{20,}", "${1}github_pat_***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])xox[abeprs]-[A-Za-z0-9\-]{10,}", "${1}xox*-***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])AKIA[0-9A-Z]{16}\b", "${1}AKIA***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])AIza[0-9A-Za-z_\-]{35}\b", "${1}AIza***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])glpat-[A-Za-z0-9_\-]{20,}", "${1}glpat-***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])npm_[A-Za-z0-9]{36}\b", "${1}npm_***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])hf_[A-Za-z0-9]{30,}\b", "${1}hf_***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])xai-[A-Za-z0-9]{20,}", "${1}xai-***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])pypi-[A-Za-z0-9_\-]{50,}", "${1}pypi-***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])ya29\.[A-Za-z0-9_\-]{20,}", "${1}ya29.***"),
            (
                r"(^|[^A-Za-z0-9_]|\\[nrt])(tvly-|gsk_|whsec_|dckr_pat_|pplx-|r8_|lin_api_|shpat_|shpss_|dop_v1_|doo_v1_|sbp_|sb_secret_|ntn_|glrt-|gldt-|glsa_|ATATT|nvapi-|GOCSPX-|hvs\.|xapp-|jina_|csk-|sntrys_|figd_|tskey-)[A-Za-z0-9_\-=]{20,}",
                "${1}${2}***",
            ),
            // Firecrawl: hex only, not a CSS class (`fc-daygrid-event`).
            (r"(^|[^A-Za-z0-9_]|\\[nrt])fc-[0-9a-f]{32}\b", "${1}fc-***"),
            // Mailgun, Databricks, a Mapbox secret, a Discord bot token.
            (r"(^|[^A-Za-z0-9_]|\\[nrt])(key-[0-9a-f]{32}|dapi[0-9a-f]{32})\b", "${1}***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])sk\.eyJ[A-Za-z0-9_\-.]{20,}", "${1}sk.***"),
            (
                r"(^|[^A-Za-z0-9_]|\\[nrt])[MN][A-Za-z0-9]{23,25}\.[A-Za-z0-9_\-]{6}\.[A-Za-z0-9_\-]{27,}",
                "${1}<discord token ***>",
            ),
            // Google's refresh token.
            (r"(^|[^A-Za-z0-9_/]|\\[nrt])1//0[A-Za-z0-9_\-]{20,}", "${1}1//0***"),
            (r"(^|[^A-Za-z0-9_]|\\[nrt])SG\.[A-Za-z0-9_\-]{16,}\.[A-Za-z0-9_\-]{16,}", "${1}SG.***"),
            (r"AGE-SECRET-KEY-1[A-Z0-9]{50,}", "AGE-SECRET-KEY-***"),
            // Telegram bot tokens: `<bot id>:<35 characters>`, also inside
            // the API's URL (`/bot<token>/getUpdates`).
            (
                r"(^|[^A-Za-z0-9_]|\\[nrt]|/bot)[0-9]{8,10}:[A-Za-z0-9_\-]{35,}",
                "${1}<bot token ***>",
            ),
            (
                r"(^|[^A-Za-z0-9_]|\\[nrt])eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]+",
                "${1}<jwt ***>",
            ),
        ]
        .into_iter()
        .filter_map(|(pattern, replacement)| match Regex::new(pattern) {
            Ok(re) => Some((re, replacement)),
            Err(e) => {
                tracing::error!("[stderr_tail] invalid credential pattern {pattern:?}: {e}");
                None
            }
        })
        .collect()
    });
    // Before the rules: `apiKey: process.env.API_KEY || "…"` would lose its
    // lookup to the `apiKey:` header rule and keep the default.
    let mut out = mask_env_defaults(s);
    for (re, replacement) in rules {
        if re.is_match(&out) {
            out = std::borrow::Cow::Owned(re.replace_all(&out, *replacement).into_owned());
        }
    }
    if let std::borrow::Cow::Owned(masked) = mask_config_values(&out) {
        out = std::borrow::Cow::Owned(masked);
    }
    match mask_cut_tail(&out) {
        Some(masked) => std::borrow::Cow::Owned(masked),
        None => out,
    }
}

/// A default in an environment lookup: `os.environ.get('SECRET_KEY', '…')`,
/// `os.getenv("API_KEY", default="…")`, `config("SECRET_KEY", default=…)`,
/// `ENV.fetch("…", "…")`, `os.getenv("…") or "…"`, `process.env.API_KEY ||
/// "…"` (or `??`, or `process.env['…']`). Judged like a config line: a
/// `TOKEN_URL` default is an address, not a key.
fn mask_env_defaults(s: &str) -> std::borrow::Cow<'_, str> {
    static LOOKUP: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(re) = LOOKUP.get_or_init(|| {
        Regex::new(
            r#"(?:\b(?:getenv|environ\.get|setdefault|env|config|ENV\.fetch)\(\s*\\?['"](?P<a>[A-Za-z0-9_]+)\\?['"]\s*(?:,\s*(?:default\s*=\s*)?|\)\s+or\s+)|(?:process|import\.meta)\.env(?:\.(?P<b>[A-Za-z0-9_]+)|\[\\?['"](?P<c>[A-Za-z0-9_]+)\\?['"]\])\s*(?:\|\||\?\?)\s*)\\?['"](?P<value>[^'"\n\\]{6,})"#,
        )
        .map_err(|e| tracing::error!("[stderr_tail] invalid lookup pattern: {e}"))
        .ok()
    }) else {
        return std::borrow::Cow::Borrowed(s);
    };
    re.replace_all(s, |caps: &regex::Captures| {
        let name = ["a", "b", "c"]
            .into_iter()
            .find_map(|group| caps.name(group))
            .map_or("", |m| m.as_str());
        let value = &caps["value"];
        let lower = name.to_ascii_lowercase();
        let secret = [
            "password",
            "passwd",
            "secret",
            "token",
            "apikey",
            "api_key",
            "access_key",
            "private_key",
        ]
        .iter()
        .any(|word| lower.contains(word));
        if secret && config_value_is_secret(name, value, true) {
            let whole = caps.get(0).expect("group 0 is the match");
            let start = caps.name("value").expect("value is matched").start();
            format!("{}***", &s[whole.start()..start])
        } else {
            caps[0].to_string()
        }
    })
}

/// Text cut short (`…abc...`, how titles, previews and tool details end)
/// may end in part of a key no rule knows any more: `AIza` one character
/// short, `ghp_` and 19 characters. A last word of letters and digits
/// before the cut goes.
fn mask_cut_tail(s: &str) -> Option<String> {
    let (body, cut) = s
        .strip_suffix("...")
        .map(|body| (body, "..."))
        .or_else(|| s.strip_suffix('…').map(|body| (body, "…")))?;
    let keyish = |c: char| c.is_ascii_alphanumeric() || "_-+/=.~".contains(c);
    let start = body
        .char_indices()
        .rev()
        .find(|(_, c)| !keyish(*c))
        .map_or(0, |(at, c)| at + c.len_utf8());
    let word = &body[start..];
    // A version or a file name (`v1.0.108`, `node-v20.tar.gz`) has dots;
    // a model or a branch (`claude-sonnet-4-5`, `origin/feature-123`) has
    // `-` or `/` and no capitals.
    let named = word.contains(['-', '/']) && !word.chars().any(|c| c.is_ascii_uppercase());
    let fits = word.len() >= 10
        && !word.contains('.')
        && !named
        && word.chars().any(|c| c.is_ascii_digit())
        && word.chars().any(|c| c.is_ascii_alphabetic());
    fits.then(|| format!("{}***{cut}", &body[..start]))
}

/// A name that counts or times something (`max_tokens`, `token_usage`,
/// `expires_at`), word by word: `admin`, `account` and `minio` do not.
pub(crate) fn names_a_count(name: &str) -> bool {
    name_words(name).iter().any(|word| {
        [
            "usage", "count", "counts", "limit", "limits", "max", "min", "size", "len", "length",
            "ttl", "timeout", "expires", "expiry", "at", "ms", "id", "total",
        ]
        .contains(&word.as_str())
    })
}

/// A field name's words, lower case: `cacheReadInputTokens`,
/// `ADMIN_PASSWORD`, `tls.key`.
pub(crate) fn name_words(name: &str) -> Vec<String> {
    let mut words = Vec::new();
    for part in name.split(|c: char| !c.is_ascii_alphanumeric()) {
        let mut word = String::new();
        let mut last_lower = false;
        for c in part.chars() {
            if c.is_ascii_uppercase() && last_lower && !word.is_empty() {
                words.push(std::mem::take(&mut word));
            }
            last_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
            word.push(c.to_ascii_lowercase());
        }
        if !word.is_empty() {
            words.push(word);
        }
    }
    words
}

/// `name = value` and `name: value` lines of config files (INI, TOML, YAML,
/// `.env` in lower case) and of code, where the name says it holds a
/// secret. A line starts at a real line start, at an escaped `\n` (JSONL
/// that does not parse) or a quote, after the line number an agent's file
/// read puts in front, after `path:line:` from `grep -n`, after a diff's
/// `+` or `-`, and after `export`, `const`, `let` and the like.
///
/// A quoted value of 8 characters or more is masked. An unquoted one only
/// when it does not read as code or a path: `token = self.get_token()`,
/// `password: String,`, `max_tokens = 4096`, `secret = settings.SECRET`,
/// `password_file: /run/secrets/db` and `token=$TOKEN` stay. A password of
/// letters only, unquoted, is the price of that.
fn mask_config_values(s: &str) -> std::borrow::Cow<'_, str> {
    static LINE: OnceLock<Option<Regex>> = OnceLock::new();
    let Some(re) = LINE.get_or_init(|| {
        Regex::new(
            r#"(?im)(?P<lead>(?:^|\\[nr]|\\?")[ \t]*(?:[0-9]+(?:\t|→|\\t))?(?:[^\s:"'\\]+:[0-9]+:)?[ \t]*[-+]?[ \t]*(?:(?:(?:export|const|let|var|val|set|readonly|declare|private|public|protected|internal|static|final|string|my|pub(?:\(crate\))?)[ \t]+)+|\$env:)?(?:\$|\$?[a-z_][a-z0-9_]*->)?(?P<name>[a-z0-9_.\-]*(?:password|passwd|passphrase|pwd|secret|token|api[_\-]?key|private[_\-]?key|credentials?|dockerconfigjson|dockercfg)[a-z0-9_.\-]*|[a-z0-9_.\-]*(?:auth|[_.\-]key|[_.\-]pass)|pass)(?:[ \t]*:[ \t]*[&a-z_'][a-z0-9_.\[\]<>&']*(?:[ \t]+[a-z_][a-z0-9_]*)?)?[ \t]*(?::=|[:=])[ \t]*)(?:\\"(?P<esc>(?:[^"\\\n]|\\[^"\n])*)\\"|"(?P<dq>(?:[^"\\\n]|\\[^\n])*)"|'(?P<sq>[^'\n]*)'|\\?["'](?P<open>[^"'\n\\]+)|(?P<bare>[^\s"'\\:][^\s"'\\]*))"#,
        )
        .map_err(|e| tracing::error!("[stderr_tail] invalid config pattern: {e}"))
        .ok()
    }) else {
        return std::borrow::Cow::Borrowed(s);
    };
    re.replace_all(s, |caps: &regex::Captures| {
        let name = &caps["name"];
        let value = [
            ("esc", true),
            ("dq", true),
            ("sq", true),
            ("open", true),
            ("bare", false),
        ]
        .into_iter()
        .find_map(|(group, quoted)| caps.name(group).map(|m| (m, quoted)));
        match value {
            Some((value, quoted)) if config_value_is_secret(name, value.as_str(), quoted) => {
                let whole = caps.get(0).expect("group 0 is the match");
                format!(
                    "{}***{}",
                    &s[whole.start()..value.start()],
                    &s[value.end()..whole.end()]
                )
            }
            _ => caps[0].to_string(),
        }
    })
}

/// An all-capitals variable name or a lower-case dotted or underscored name,
/// with no digits.
fn names_another_key(value: &str) -> bool {
    let joined = value.contains(['_', '.']);
    let word = |c: char| c == '_' || c == '.';
    joined
        && !value.starts_with(word)
        && (value.chars().all(|c| c.is_ascii_uppercase() || word(c))
            || value.chars().all(|c| c.is_ascii_lowercase() || word(c)))
}

fn config_value_is_secret(name: &str, value: &str, quoted: bool) -> bool {
    static CODE: OnceLock<Option<Regex>> = OnceLock::new();
    if value.chars().count() < 8 || value.ends_with("***") {
        return false;
    }
    let counts = names_a_count(name);
    let name = name.to_ascii_lowercase();
    // `tokenizer: o200k_base` names a model's tokenizer, not a token.
    if name.contains("tokenizer") {
        return false;
    }

    // Where a secret is kept or sent, not the secret, quoted or not:
    // `token_url`, `password_file`, `secretName`, `secretKeyRef`,
    // `TOKEN_HEADER = "Authorization"`.
    if [
        "url", "uri", "endpoint", "file", "path", "dir", "name", "ref", "header", "env", "var",
        "prefix", "pattern", "regex", "prompt",
    ]
    .iter()
    .any(|end| name.ends_with(end))
    {
        return false;
    }

    // Another name, not a secret: `MESSAGE_LANGUAGE_KEY: &str =
    // "message_language"`, `API_KEY_ENV = "OPENAI_API_KEY"`.
    if names_another_key(value) {
        return false;
    }
    if quoted {
        return true;
    }

    // `pwd: /Users/…`, `token=$TOKEN`.
    if value.starts_with(['(', '[', '{', '<', '$', '/'])
        || value.starts_with("~/")
        || value.starts_with("./")
        || value.contains("://")
    {
        return false;
    }

    // Code: a call, an index or a type (`self.get_token()`,
    // `Option<String>,`), or a name closing a field (`String,`).
    let code =
        CODE.get_or_init(|| Regex::new(r"^(?:[A-Za-z_][\w.:]*[(\[{<]|[A-Za-z_][\w.]*[,;]$)").ok());
    if code.as_ref().is_some_and(|code| code.is_match(value)) {
        return false;
    }

    // A name, a dotted path or a number reads as code; a key has digits
    // among its letters, or symbols.
    let word = value
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '.');
    if !word {
        return true;
    }
    let digits = value.chars().any(|c| c.is_ascii_digit());
    let letters = value.chars().any(|c| c.is_ascii_alphabetic());
    if digits && !letters {
        // A number under a secret's name is a PIN-like password, unless the
        // name counts or times something: `token_expires_at`, `max_tokens`.
        return !counts && !name.ends_with("tokens");
    }
    digits && letters
}

/// serde's own `expecting` phrasings. Anything outside this set is treated as
/// potentially attacker-controlled — a hand-written `Deserialize::expecting`
/// (or the `&dyn Expected` argument of `invalid_value`) can be built at
/// runtime and interpolate the very payload we are trying to keep out.
const SAFE_EXPECT_PHRASES: &[&str] = &[
    "u8",
    "u16",
    "u32",
    "u64",
    "u128",
    "usize",
    "i8",
    "i16",
    "i32",
    "i64",
    "i128",
    "isize",
    "f32",
    "f64",
    "bool",
    "char",
    "string",
    "str",
    "unit",
    "option",
    "seq",
    "map",
    "integer",
    "boolean",
    "null",
    "byte array",
    "floating point number",
    "a string",
    "an integer",
    "a sequence",
    "a map",
    "a boolean",
    "a borrowed string",
    "a byte array",
    "a character",
    "unit struct",
    "newtype struct",
];

/// Identifiers from codeg's own ACP schema that are safe to echo back.
///
/// Drift (a new schema field not yet listed) degrades to `(redacted)` — a
/// failure on the safe side.
const SAFE_SCHEMA_IDENTS: &[&str] = &[
    "sessionId",
    "sessionUpdate",
    "update",
    "content",
    "role",
    "toolCallId",
    "toolCall",
    "status",
    "kind",
    "title",
    "rawInput",
    "rawOutput",
    "entries",
    "used",
    "size",
    "stopReason",
    "meta",
    "agent_message_chunk",
    "agent_thought_chunk",
    "user_message_chunk",
    "tool_call",
    "tool_call_update",
    "plan",
    "usage_update",
    "current_mode_update",
    "available_commands_update",
    "session_info_update",
    "config_option_update",
    "SessionNotification",
    "SessionUpdate",
    "ContentBlock",
    "ToolCall",
    "ToolCallUpdate",
];

fn is_safe_ident(s: &str) -> bool {
    SAFE_SCHEMA_IDENTS.contains(&s)
}

/// Whether an `expected …` clause may be echoed verbatim.
///
/// Accepts serde's static phrasings, `struct/enum/variant <Ident>` where the
/// identifier is one of ours, and `one of \`a\`, \`b\`` where **every** item is
/// one of ours. Everything else is rejected.
fn safe_expectation(exp: &str) -> bool {
    let exp = exp.trim().trim_end_matches(['.', ',']);
    if SAFE_EXPECT_PHRASES.contains(&exp) {
        return true;
    }
    for prefix in ["struct ", "enum ", "unit variant ", "struct variant "] {
        if let Some(ident) = exp.strip_prefix(prefix) {
            return is_safe_ident(ident.trim());
        }
    }
    if let Some(list) = exp.strip_prefix("one of ") {
        let mut any = false;
        for item in list.split(',') {
            let item = item.trim();
            let Some(ident) = item.strip_prefix('`').and_then(|i| i.strip_suffix('`')) else {
                return false;
            };
            if !is_safe_ident(ident) {
                return false;
            }
            any = true;
        }
        return any;
    }
    false
}

/// A recognized error shape: the regex (capturing only the `expected` clause),
/// the category to report, and whether the *subject* of the error is itself
/// payload. `unknown variant`/`unknown field` name a value that came off the
/// wire, so their subject is always dropped; `invalid type`/`invalid value`
/// name a type, which we drop anyway by not capturing it.
type ShapeRule = (Regex, &'static str, bool);

fn shape_rules() -> &'static Vec<ShapeRule> {
    static RULES: OnceLock<Vec<ShapeRule>> = OnceLock::new();
    RULES.get_or_init(|| {
        let specs: Vec<(&str, &str, bool)> = vec![
            (
                r"^invalid type:.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid type",
                false,
            ),
            (
                r"^invalid value:.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid value",
                false,
            ),
            (
                r"^invalid length.*?,\s*expected\s+(?P<exp>.+)$",
                "invalid length",
                false,
            ),
            (
                r"^unknown variant\s+`[^`]*`,\s*expected\s+(?P<exp>.+)$",
                "unknown variant",
                true,
            ),
            (
                r"^unknown field\s+`[^`]*`,\s*expected\s+(?P<exp>.+)$",
                "unknown field",
                true,
            ),
        ];
        specs
            .into_iter()
            .filter_map(
                |(pattern, category, subject_is_payload)| match Regex::new(pattern) {
                    Ok(re) => Some((re, category, subject_is_payload)),
                    Err(e) => {
                        tracing::error!("[stderr_tail] invalid shape pattern {pattern:?}: {e}");
                        None
                    }
                },
            )
            .collect()
    })
}

fn missing_field_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^missing field\s+`(?P<field>[^`]*)`").unwrap())
}

fn position_rule() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"\bat line \d+ column \d+").unwrap())
}

/// serde_json syntax-error phrases that describe the *shape* of the input
/// without echoing any of it.
///
/// A match emits the phrase **and nothing else**. Matching a prefix says
/// nothing about the suffix: serde_json appends input-derived context to some
/// of these, and a custom error is free to start with one of these phrases and
/// continue with arbitrary payload. Forwarding the remainder would be a hole
/// straight through the default-deny design.
const SAFE_SYNTAX_PREFIXES: &[&str] = &[
    "EOF while parsing",
    "trailing characters",
    "expected value",
    "key must be a string",
    "control character",
    "invalid unicode code point",
    "number out of range",
    "recursion limit exceeded",
];

/// Reduce a deserialization error to a bounded, payload-free summary.
///
/// **Default deny.** The input is never scrubbed and forwarded; it is matched
/// against a closed set of shapes and *rebuilt* from templates, with every
/// retained fragment checked against a finite allowlist. An error that matches
/// nothing collapses to `unrecognized parse error (redacted)`.
///
/// This costs readability for custom `Deserialize` impls, deliberately: the
/// dropped-update *counts* already carry the "protocol mismatch" conclusion,
/// and the raw text is still in the log file. What it buys is the certainty
/// that arbitrary `session/update` payload can never reach the UI or the
/// WebSocket.
pub fn summarize_parser_error(e: &str) -> String {
    let first = e.lines().next().unwrap_or("").trim();
    let first = collapse_whitespace(first);
    let position = position_rule()
        .find(&first)
        .map(|m| m.as_str().to_string())
        .unwrap_or_default();

    let body = summarize_body(&first);
    let mut out = body;
    if !position.is_empty() {
        out.push(' ');
        out.push_str(&position);
    }
    // Backstop. By construction there should be nothing left to redact.
    let out = sanitize_diagnostic(&out);
    truncate_bytes(&out, MAX_DROP_ERROR_BYTES)
}

fn summarize_body(first: &str) -> String {
    if let Some(caps) = missing_field_rule().captures(first) {
        let field = caps.name("field").map(|m| m.as_str()).unwrap_or("");
        return if is_safe_ident(field) {
            format!("missing field `{field}`")
        } else {
            "missing field (redacted)".to_string()
        };
    }

    for (re, category, subject_is_payload) in shape_rules() {
        let Some(caps) = re.captures(first) else {
            continue;
        };
        let exp = caps
            .name("exp")
            .map(|m| m.as_str())
            .unwrap_or("")
            // The position suffix is appended separately; don't fold it into
            // the expectation (it would never match the allowlist).
            .trim();
        let exp = position_rule().replace(exp, "").trim().to_string();
        let exp = exp.trim_end_matches(',').trim().to_string();
        if !safe_expectation(&exp) {
            // Nothing survives: neither the subject (never captured) nor the
            // expectation. Report the category alone.
            return format!("{category} (redacted)");
        }
        let head = if *subject_is_payload {
            format!("{category} (redacted)")
        } else {
            (*category).to_string()
        };
        return format!("{head}, expected {exp}");
    }

    // Anchored at the start, and the phrase is all that survives. `contains`
    // would let a custom error smuggle itself in by merely mentioning one of
    // these; forwarding the suffix would let it smuggle payload in after one.
    // Position info is re-appended by the caller.
    if let Some(phrase) = SAFE_SYNTAX_PREFIXES.iter().find(|p| first.starts_with(**p)) {
        return (*phrase).to_string();
    }

    "unrecognized parse error (redacted)".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    // An agent's stderr arrives a line at a time: a printed private key, a
    // Google key and a JSON key still never reach the error shown or sent.
    #[test]
    fn the_tail_keeps_no_key_printed_line_by_line() {
        let tail = StderrTail::new();
        for line in [
            "loading credentials",
            "-----BEGIN OPENSSH PRIVATE KEY-----",
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
            "QyNTUxOQAAACDx7kq9ZpL2mWv0cR8sYtUeHbNa3fGjKiLoMnPqRsTuVw",
            "-----END OPENSSH PRIVATE KEY-----",
            // A Google key is `AIza` and 35 more.
            "GEMINI_API_KEY AIzaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456",
            r#"{"apiKey": "q8Zt3VnRw2LmXc5PbHy7KdJs"}"#,
            "connect failed",
        ] {
            tail.push(line);
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        for secret in [
            "b3BlbnNzaC1rZXktdjEAAAAABG5vbmU",
            "QyNTUxOQAAACDx7kq9ZpL2mWv0cR8s",
            "AbCdEfGhIjKlMnOpQrStUvWxYz012345",
            "q8Zt3VnRw2LmXc5PbHy7KdJs",
        ] {
            assert!(!shown.contains(secret), "{secret} in {shown}");
        }
        assert!(shown.contains("loading credentials"), "{shown}");
        assert!(shown.contains("connect failed"), "{shown}");
    }

    // A PGP key's armour headers are part of the key; a tail that starts
    // inside a key keeps nothing of it.
    #[test]
    fn a_pgp_key_and_a_cut_key_keep_nothing() {
        let tail = StderrTail::new();
        for line in [
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
            "Version: OpenPGP.js v4.10.10",
            "Comment: https://openpgpjs.org",
            "",
            "xcLYBF9gq3IBCADGq0z8ahP2kSvYbW0Ns6QmVhLKdMv0bc7RfHJ1oQyXu",
            "-----END PGP PRIVATE KEY BLOCK-----",
            "done",
        ] {
            tail.push(line);
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        assert!(!shown.contains("xcLYBF9gq3IBCADGq0z8"), "{shown}");
        assert!(shown.contains("done"), "{shown}");

        let cut = "ZbT2mQ8xVnR4sLw9KdJcHy7PbXe3\n-----END RSA PRIVATE KEY-----\nexit 1";
        assert_eq!(without_cut_key_head(cut), "exit 1");
        let whole = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
        assert_eq!(without_cut_key_head(whole), whole);
        assert_eq!(
            without_cut_key_head("-----END CERTIFICATE-----"),
            "-----END CERTIFICATE-----"
        );
    }

    // A key the cut lands in is masked before the cut, not left as a
    // fragment no rule recognises.
    #[test]
    fn a_key_at_the_debug_cut_is_masked() {
        let line = format!(
            "{}\"apiKey\": \"s3cr3tVALUEabcdefghijklmnop1234567890\"}}",
            "x".repeat(230)
        );
        let logged = redact_credentials(&log_excerpt(&line, 256)).into_owned();
        assert!(!logged.contains("s3cr3tVAL"), "{logged}");
        assert!(logged.contains("<truncated"), "{logged}");
    }

    // A key whose lines carry a prefix — on the BEGIN line only, or on every
    // line — keeps nothing; a key cut inside its BEGIN line is trimmed too.
    #[test]
    fn a_key_behind_a_prefix_keeps_nothing() {
        let tail = StderrTail::new();
        for line in [
            "loaded key: -----BEGIN RSA PRIVATE KEY-----",
            "MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun",
            "-----END RSA PRIVATE KEY-----",
            "08:00:01 [agent] -----BEGIN PRIVATE KEY-----",
            "08:00:01 [agent] MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
            "08:00:02 [agent] -----END PRIVATE KEY-----",
            "08:00:02 [agent] done",
        ] {
            tail.push(line);
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        assert!(!shown.contains("MIIEowIBAAKCAQEAu1SU"), "{shown}");
        assert!(!shown.contains("MIIEvQIBADANBgkqhkiG"), "{shown}");
        assert!(shown.contains("done"), "{shown}");
        let cut =
            "IVATE KEY-----\nZbT2mQ8xVnR4sLw9KdJcHy7PbXe3\n-----END RSA PRIVATE KEY-----\nexit 1";
        assert_eq!(without_cut_key_head(cut), "exit 1");
    }

    // A prefix whose time changes from line to line: the headers and body
    // behind it are the key's, and plain lines after a mentioned marker are
    // kept. A cut key with the prefix on every line is dropped too.
    #[test]
    fn a_key_behind_a_changing_prefix_keeps_nothing() {
        let tail = StderrTail::new();
        for line in [
            "08:00:01.123 [agent] -----BEGIN PGP PRIVATE KEY BLOCK-----",
            "08:00:01.124 [agent] Comment: alice@example.com",
            "08:00:01.125 [agent] lQOYBGVmZXJ0aGluZ3NlY3JldGtleWJvZHkx",
            "08:00:01.126 [agent] -----END PGP PRIVATE KEY BLOCK-----",
            "08:00:02.000 [agent] error: PEM must start with -----BEGIN PRIVATE KEY-----",
            "Done",
        ] {
            tail.push(line);
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        assert!(!shown.contains("lQOYBGVm"), "{shown}");
        assert!(shown.contains("Done"), "{shown}");
        let cut = "[agent] MIIEvQIBADANBgkq\n08:00:01 [agent] ZbT2mQ8xVnR4sLw9\n08:00:02 [agent] -----END PRIVATE KEY-----\nexit 1";
        assert_eq!(without_cut_key_head(cut), "exit 1");
    }

    // A PGP key's blank line, printed with the prefix alone, does not end
    // the key; nor does it when the key was cut.
    #[test]
    fn a_blank_line_behind_a_prefix_keeps_the_key_closed() {
        let tail = StderrTail::new();
        for line in [
            "08:00:01.123 [agent] -----BEGIN PGP PRIVATE KEY BLOCK-----",
            "08:00:01.124 [agent] Version: GnuPG v2",
            "08:00:01.125 [agent]",
            "08:00:01.126 [agent] lQOYBGVmZXJ0aGluZ3NlY3JldGtleWJvZHkx",
            "08:00:01.127 [agent] -----END PGP PRIVATE KEY BLOCK-----",
            "08:00:02.000 [agent] connected",
        ] {
            tail.push(line);
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        assert!(!shown.contains("lQOYBGVm"), "{shown}");
        assert!(shown.contains("connected"), "{shown}");
        let cut = "[agent] Version: GnuPG v2\n08:00:01.125 [agent]\n08:00:01.126 [agent] lQOYBGVmZXJ0aGluZ3Nl\n08:00:01.127 [agent] -----END PGP PRIVATE KEY BLOCK-----\nexit 1";
        assert_eq!(without_cut_key_head(cut), "exit 1");
    }

    // A label only the BEGIN line has, a short last line of base64, a JSON
    // string cut inside its key: none of the key is kept. `exit 1` after a
    // marker that was only mentioned is.
    #[test]
    fn a_labelled_key_keeps_nothing() {
        let tail = StderrTail::new();
        for line in [
            "08:00:01 [agent] key: -----BEGIN PRIVATE KEY-----",
            "08:00:01 [agent] MIIEvQIBADANBgkqhkiG9w0BAQEF",
            "08:00:01 [agent] dGVzdA",
            "08:00:01 [agent] -----END PRIVATE KEY-----",
            "loaded key: -----BEGIN PRIVATE KEY-----",
            "ZbT2mQ8xVnR4sLw9KdJcHy7PbXe3",
            "qRsT9u",
            "-----END PRIVATE KEY-----",
            "expected -----BEGIN PRIVATE KEY-----",
            "exit 1",
        ] {
            tail.push(line);
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        for secret in ["MIIEvQIB", "dGVzdA", "ZbT2mQ8x", "qRsT9u"] {
            assert!(!shown.contains(secret), "{secret}: {shown}");
        }
        assert!(shown.contains("exit 1"), "{shown}");
        let cut = "SIb3DQEB\\nAQEFAASC\\n-----END PRIVATE KEY-----\\n\"}\nexit 1";
        assert_eq!(without_cut_key_head(cut), "exit 1");
    }

    // Only a line that ends with the BEGIN marker opens a key, and only the
    // headers a key has count as its lines: an error after a mentioned marker is kept.
    #[test]
    fn an_error_after_a_mentioned_key_is_kept() {
        let tail = StderrTail::new();
        assert!(tail.push("failed to parse -----BEGIN RSA PRIVATE KEY----- input"));
        assert!(tail.push("Done"));
        assert!(tail.push("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(tail.push("Error: the key is encrypted"));
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        assert!(shown.contains("Done"), "{shown}");
        assert!(shown.contains("Error: the key is encrypted"), "{shown}");
        let message = "expected -----END PRIVATE KEY----- before EOF\nexit 1";
        assert_eq!(without_cut_key_head(message), message);
    }

    // A BEGIN that only names the marker opens no key: the lines after it
    // are kept. A key's body is reported so the caller leaves it out of the
    // log too.
    #[test]
    fn a_mentioned_key_marker_does_not_hide_what_follows() {
        let tail = StderrTail::new();
        assert!(tail.push("expected -----BEGIN PRIVATE KEY----- in key.pem"));
        assert!(tail.push("connect failed: no such host"));
        assert!(tail.push("-----BEGIN RSA PRIVATE KEY-----"));
        assert!(!tail.push("MIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo4lgOEePzNm0tRgeLezV6ffAt0gun"));
        assert!(!tail.push("-----END RSA PRIVATE KEY-----"));
        assert!(tail.push("retrying"));
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        assert!(shown.contains("connect failed"), "{shown}");
        assert!(shown.contains("retrying"), "{shown}");
        assert!(!shown.contains("MIIEowIBAAKCAQEA"), "{shown}");
    }

    // ---- StderrTail ----

    #[test]
    fn push_strips_ansi_and_drops_blank_lines() {
        let tail = StderrTail::new();
        tail.push("\u{1b}[31mboom\u{1b}[0m");
        tail.push("   ");
        tail.push("");
        tail.push("\u{1b}]0;title\u{7}second");
        let slice = tail.tail_since(0, 10, 4096);
        assert_eq!(slice.lines, vec!["boom", "second"]);
    }

    #[test]
    fn push_truncates_long_line_on_char_boundary() {
        let tail = StderrTail::new();
        tail.push(&"中".repeat(400)); // 1200 bytes
        let slice = tail.tail_since(0, 10, 8192);
        assert_eq!(slice.lines.len(), 1);
        let line = &slice.lines[0];
        assert!(line.len() <= MAX_LINE_BYTES + '…'.len_utf8());
        assert!(line.ends_with('…'));
        // Round-trips as valid UTF-8 with no replacement chars.
        assert!(!line.contains('\u{fffd}'));
    }

    #[test]
    fn evicts_oldest_beyond_line_cap() {
        let tail = StderrTail::new();
        for i in 0..(MAX_LINES + 50) {
            tail.push(&format!("line-{i}"));
        }
        let slice = tail.tail_since(0, MAX_LINES + 100, 1024 * 1024);
        assert_eq!(slice.lines.len(), MAX_LINES);
        assert_eq!(slice.lines[0], format!("line-{}", 50));
        assert_eq!(
            slice.lines[MAX_LINES - 1],
            format!("line-{}", MAX_LINES + 49)
        );
    }

    #[test]
    fn evicts_beyond_byte_cap() {
        let tail = StderrTail::new();
        // 100 lines x ~500 bytes = ~50 KB > MAX_BYTES (32 KB).
        for i in 0..100 {
            tail.push(&format!("{i:04}{}", "x".repeat(496)));
        }
        let inner = tail.inner.lock().unwrap();
        assert!(inner.bytes <= MAX_BYTES, "bytes={} ", inner.bytes);
        assert!(inner.lines.len() < 100);
    }

    #[test]
    fn tail_since_scopes_to_this_turn() {
        let tail = StderrTail::new();
        tail.push("before-1");
        tail.push("before-2");
        let mark = tail.mark();
        tail.push("during-1");
        let slice = tail.tail_since(mark, 10, 4096);
        assert_eq!(slice.scope, TailScope::ThisTurn);
        assert_eq!(slice.lines, vec!["during-1"]);
    }

    #[test]
    fn tail_since_falls_back_to_recent_when_turn_silent() {
        let tail = StderrTail::new();
        tail.push("before-1");
        let mark = tail.mark();
        let slice = tail.tail_since(mark, 10, 4096);
        assert_eq!(slice.scope, TailScope::Recent);
        assert_eq!(slice.lines, vec!["before-1"]);
    }

    #[test]
    fn tail_since_is_empty_when_nothing_recorded() {
        let tail = StderrTail::new();
        let slice = tail.tail_since(tail.mark(), 10, 4096);
        assert!(slice.is_empty());
    }

    #[test]
    fn tail_since_takes_from_the_end() {
        let tail = StderrTail::new();
        for i in 0..10 {
            tail.push(&format!("l{i}"));
        }
        let slice = tail.tail_since(0, 3, 4096);
        assert_eq!(slice.lines, vec!["l7", "l8", "l9"]);
    }

    #[test]
    fn concurrent_push_does_not_panic() {
        use std::sync::Arc;
        let tail = Arc::new(StderrTail::new());
        let handles: Vec<_> = (0..8)
            .map(|t| {
                let tail = Arc::clone(&tail);
                std::thread::spawn(move || {
                    for i in 0..200 {
                        tail.push(&format!("thread-{t}-{i}"));
                    }
                })
            })
            .collect();
        for h in handles {
            h.join().unwrap();
        }
        let slice = tail.tail_since(0, MAX_LINES, MAX_BYTES);
        assert_eq!(slice.lines.len(), MAX_LINES);
    }

    #[test]
    fn poisoned_lock_still_serves_reads() {
        use std::sync::Arc;
        let tail = Arc::new(StderrTail::new());
        tail.push("survivor");
        let poisoner = Arc::clone(&tail);
        let _ = std::thread::spawn(move || {
            let _guard = poisoner.inner.lock().unwrap();
            panic!("poison the mutex");
        })
        .join();
        assert!(tail.inner.is_poisoned());
        tail.push("after-poison");
        let slice = tail.tail_since(0, 10, 4096);
        assert_eq!(slice.lines, vec!["survivor", "after-poison"]);
    }

    // ---- sanitize_diagnostic ----

    #[test]
    fn credentials_in_env_and_config_files_are_masked_but_code_is_not() {
        let text = concat!(
            "RELAY_GATEWAY_KEY=9f2c4e7a1b3d5f60\n",
            "export DB_PASSWORD='p4ss-w0rd!'\n",
            "{\"apiKey\": \"0123456789abcdef\", \"max_tokens\": 1000}\n",
            "api_key = \"kimi-0123456789abcdef\"\n",
            "stripe sk_live_51HabcdefGHIJklmnOPQR\n",
            "pub password: String,\n",
            "let password = read_line();\n",
        );
        let out = redact_credentials(text);
        for secret in [
            "9f2c4e7a1b3d5f60",
            "p4ss-w0rd!",
            "0123456789abcdef",
            "kimi-0123456789abcdef",
            "51HabcdefGHIJklmnOPQR",
        ] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        assert!(out.contains("RELAY_GATEWAY_KEY=***"), "{out}");
        assert!(out.contains("\"max_tokens\": 1000"), "{out}");
        assert!(out.contains("pub password: String,"), "{out}");
        assert!(out.contains("let password = read_line();"), "{out}");
    }

    // Cowork fork: Claude Code behind a relay gets its key from
    // `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`, and the value need not
    // have a shape a rule knows (`sk-…`). The old `\b` rules missed both
    // names: `_` before `AUTH` / `API` is a word character.
    #[test]
    fn anthropic_env_tokens_are_masked_in_the_tail() {
        let lines = [
            "ANTHROPIC_AUTH_TOKEN=cr_relaytok0f9e8d7c6b5a4938",
            "export ANTHROPIC_API_KEY=\"relaykey0123456789abcdef\"",
            "env ANTHROPIC_AUTH_TOKEN='relayenv0123456789abc' claude --print",
            "ANTHROPIC_API_KEY=sk-ant-api03-AbCdEfGh0123456789xyz",
            r#"{"env": {"ANTHROPIC_AUTH_TOKEN": "cr_relayjson0123456789"}}"#,
        ];
        let secrets = [
            "relaytok0f9e8d7c6b5a4938",
            "relaykey0123456789abcdef",
            "relayenv0123456789abc",
            "AbCdEfGh0123456789xyz",
            "relayjson0123456789",
        ];
        let tail = StderrTail::new();
        for line in lines {
            assert!(tail.push(line));
        }
        let shown = tail.tail_since(0, 100, 1 << 20).lines.join("\n");
        let masked = redact_credentials(&lines.join("\n")).into_owned();
        for out in [&shown, &masked] {
            for secret in secrets {
                assert!(!out.contains(secret), "{secret} survived: {out}");
            }
            assert!(out.contains("ANTHROPIC_AUTH_TOKEN=***"), "{out}");
            assert!(out.contains("ANTHROPIC_API_KEY=***"), "{out}");
            assert!(out.contains("claude --print"), "{out}");
        }
    }

    // What an agent reads out of a file reaches the organization as text:
    // JSON behind line numbers never parses, and these keys have a fixed
    // prefix or a well-known name.
    #[test]
    fn keys_in_file_text_and_fixed_prefix_keys_are_masked() {
        let text = concat!(
            "     1\t{\"auths\":{\"r.example.test\":{\"auth\":\"dXNlcjpwYXNzd29yZA==\"}}}\n",
            "     2\t{\"bot_token\": \"tg-0123456789abcdef\", \"author\": \"Jane Smithson\"}\n",
            "//registry.npmjs.org/:_authToken=npm_abcdefghijklmnopqrstuvwxyz0123456789\n",
            "_auth=dXNlcjpwYXNzd29yZA==\n",
            "gitlab glpat-abcdefghij0123456789\n",
            "hf hf_abcdefghijklmnopqrstuvwxyz012345\n",
            "grok xai-abcdefghijklmnopqrst0123\n",
            "google ya29.a0AfH6SMBabcdefghijklmnop\n",
            "telegram 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0\n",
        );
        let out = redact_credentials(text);
        for secret in [
            "dXNlcjpwYXNzd29yZA",
            "tg-0123456789abcdef",
            "npm_abcdefghijklmnopqrstuvwxyz0123456789",
            "glpat-abcdefghij0123456789",
            "hf_abcdefghijklmnopqrstuvwxyz012345",
            "xai-abcdefghijklmnopqrst0123",
            "ya29.a0AfH6SMBabcdefghijklmnop",
            "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0",
        ] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        assert!(out.contains("\"author\": \"Jane Smithson\""), "{out}");
    }

    // Masking must neither eat ordinary names and code nor miss a bare
    // `TOKEN=` or JSON escaped inside a command's string.
    #[test]
    fn names_and_code_stay_and_bare_or_escaped_keys_go() {
        for plain in [
            "open src/task-scheduler-panel.tsx",
            "see risk-assessment-report.md",
            "self._auth = auth",
            "basic_auth = HTTPBasicAuth(user, pw)",
        ] {
            assert_eq!(redact_credentials(plain), plain);
        }
        for code in [
            "password: String,",
            "    password: Option<String>,",
            "password = getpass.getpass()",
            "token = self.get_token()",
            "pw = request.form[\"password_field\"]",
        ] {
            assert_eq!(redact_credentials(code), code);
        }
        let text = concat!(
            "key sk-live-abcdefghijklmno\n",
            "TOKEN=abcd1234efgh curl x\n",
            "curl -d \"{\\\"password\\\":\\\"hunter2long\\\"}\"\n",
        );
        let out = redact_credentials(text);
        for secret in ["abcdefghijklmno", "abcd1234efgh", "hunter2long"] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        // The escaped JSON keeps its shape: only the value goes.
        assert!(out.contains("\\\"password\\\":\\\"***\\\""), "{out}");
        // JSONL that does not parse keeps `\n` as two characters.
        let jsonl = r#"{"a":"x\nsk-proj-abcdefghijklmnop\nOPENAI_API_KEY=abcdefghijklmn\tghp_abcdefghijklmnopqrstuvwxyz01"}"#;
        let out = redact_credentials(jsonl);
        for secret in ["abcdefghijklmnop", "abcdefghijklmn", "ghp_abcdefghij"] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
        // Files without quotes: `.pypirc`, `.my.cnf`, compose YAML,
        // `.netrc`, `.npmrc`.
        let files = concat!(
            "[pypi]\npassword = pypi-AgEIcHlwaS5vcmcCJGFiY2RlZmdoLWlqa2wtbW5vcC1xcnN0LXV2d3h5ejAxMjM0NQ\n",
            "[client]\npassword=hunter2hunter2\n",
            "    POSTGRES_PASSWORD: s3cr3tvalue99\n",
            "machine example.test login alice password netrcpass99\n",
            "//registry.example.test/:_password=bnBtcGFzczk5\n",
        );
        let out = redact_credentials(files);
        for secret in [
            "AgEIcHlwaS5vcmc",
            "hunter2hunter2",
            "s3cr3tvalue99",
            "netrcpass99",
            "bnBtcGFzczk5",
        ] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
    }

    // Round 20: a JS `apiKey:` fallback, AWS keys in Go's and Rust's
    // printouts, escaped quotes, more lookups, SQL, Docker's and Mongo's
    // and SQL Server's clients, a piped sudo password, Tailscale and ngrok,
    // a header dict's cookie; and lookups and paths that are not keys.
    #[test]
    fn keys_the_rules_missed_in_round_20_are_masked() {
        for (text, secret) in [
            ("apiKey: process.env.API_KEY || \"Ab3dEfGh1jKlMnOp9\",", "Ab3dEfGh1jKlMnOp9"),
            ("{AccessKeyID:AKIAIOSFODNN7EXAMPLE SecretAccessKey:wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY}", "wJalrXUtnFEMI"),
            ("secret_access_key: Some(\"wJalrXUtnFEMI/K7MDENG/bPxRfiCY\")", "wJalrXUtnFEMI"),
            ("docker login -u admin -p \\\"Hunter2pass9\\\" r.example.com", "Hunter2pass9"),
            ("os.getenv(\\\"X_API_KEY\\\", \\\"Ab3dEfGh1jKlMnOp9\\\")", "Ab3dEfGh1jKlMnOp9"),
            ("SECRET_KEY = config(\"SECRET_KEY\", default=\"django-insecure-q9x0abc123\")", "django-insecure"),
            ("ENV.fetch(\"SECRET_KEY_BASE\", \"9QxK2vabcdef0123456789\")", "9QxK2vabcdef"),
            ("os.getenv(\"API_TOKEN\") or \"Ab3dEfGh1jKlMnOp9\"", "Ab3dEfGh1jKlMnOp9"),
            ("process.env['JWT_SECRET'] || 'Ab3dEfGh1jKlMnOp9'", "Ab3dEfGh1jKlMnOp9"),
            ("CREATE USER app WITH PASSWORD 'S3cretPass9';", "S3cretPass9"),
            ("ALTER USER postgres PASSWORD 'S3cretPass9';", "S3cretPass9"),
            ("CREATE USER 'app'@'%' IDENTIFIED BY 'S3cretPass9';", "S3cretPass9"),
            ("ALTER USER 'root'@'localhost' IDENTIFIED WITH mysql_native_password BY 'S3cretPass9';", "S3cretPass9"),
            ("CREATE LOGIN app WITH PASSWORD = 'S3cretPass9';", "S3cretPass9"),
            ("docker exec -it db mysql -uroot -pS3cretPass9", "S3cretPass9"),
            ("kubectl exec -it db-0 -- mysql -uroot -p'S3cretPass9'", "S3cretPass9"),
            ("sqlcmd -S localhost -U sa -P 'YourStr0ngPassw0rd'", "YourStr0ngPassw0rd"),
            ("mongosh -u admin -p 'S3cretPass9' --authenticationDatabase admin", "S3cretPass9"),
            ("echo 'S3cretPass9' | sudo -S systemctl restart nginx", "S3cretPass9"),
            ("tailscale up --authkey tskey-auth-kAbCdEf1CNTRL-0123456789abcdef", "kAbCdEf1CNTRL"),
            ("cli --secret-key \"Ab3dEfGh1jKlMnOp9\"", "Ab3dEfGh1jKlMnOp9"),
            ("ngrok config add-authtoken 2abcDEFghiJKLmnoPQRstu_0123456789", "2abcDEFghiJKL"),
            ("{'Cookie': 'sid=Ab3dEfGh1jKlMnOp9; other=1'}", "Ab3dEfGh1jKlMnOp9"),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
    }

    // Round 21: `mysqldump` through `exec`, Vite's `import.meta.env`; and a
    // package's `cookie` version and a key file's path are not keys.
    #[test]
    fn keys_the_rules_missed_in_round_21_are_masked() {
        for (text, secret) in [
            (
                "docker exec db mysqldump -uroot -pS3cretPass9 app > dump.sql",
                "S3cretPass9",
            ),
            (
                "kubectl exec -it db-0 -- mysqldump -uroot -pS3cretPass9 app",
                "S3cretPass9",
            ),
            (
                "docker exec db mysqladmin -uroot -pS3cretPass9 ping",
                "S3cretPass9",
            ),
            (
                "apiKey: import.meta.env.VITE_API_KEY || \"Ab3dEfGh1jKlMnOp9\",",
                "Ab3dEfGh1jKlMnOp9",
            ),
            (
                "cli --secret-key \"Ab3dEfGh1jKlMnOp9\"",
                "Ab3dEfGh1jKlMnOp9",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "os.getenv(\"TOKEN_URL\", \"https://oauth2.googleapis.com/token\")",
            "os.getenv(\"TOKENIZER\", \"cl100k_base\")",
            "process.env.SECRETS_DIR ?? \"/run/secrets\"",
            "env(\"API_KEY_ENV_VAR\", \"OPENAI_API_KEY\")",
            "kwargs.setdefault(\"token_type\", \"access_token\")",
            "SSL_KEY=/etc/ssl/private/server.key",
            "SSH_PRIVATE_KEY=/root/.ssh/id_rsa",
            "docker run --name mysql -p3306:3306 mysql",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
        for text in [
            "\"cookie\": \"^0.6.0\",",
            "ansible-playbook -i hosts site.yml --private-key ~/.ssh/id_rsa",
            "ansible all -m ping --private-key=/home/me/.ssh/deploy_key",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 22: a dump with `mariadb-dump` itself, a `/`-led secret key, and
    // a registry password piped into `docker login`.
    #[test]
    fn keys_the_rules_missed_in_round_22_are_masked() {
        for (text, secret) in [
            ("mariadb-dump -uroot -pS3cretPass9 app", "S3cretPass9"),
            (
                "aws-cli --secret-key /aB3dEfGh1jKlMnOp9QrStUvWxYz01234567890",
                "aB3dEfGh1jKlMnOp9QrStUvWxYz01234567890",
            ),
            (
                "echo S3cretPass9 | docker login --password-stdin",
                "S3cretPass9",
            ),
            (
                "echo -n 'S3cretPass9' | podman login -u me --password-stdin quay.io",
                "S3cretPass9",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "ansible all -m ping --private-key /root/key.pem",
            "echo $TOKEN | docker login -u me --password-stdin",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 23: `sudo docker login` where the user is not in the docker group.
    #[test]
    fn keys_the_rules_missed_in_round_23_are_masked() {
        for (text, secret) in [
            (
                "echo S3cretPass9 | sudo docker login -u me --password-stdin",
                "S3cretPass9",
            ),
            (
                "echo S3cretPass9 | sudo -E podman login -u me --password-stdin",
                "S3cretPass9",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        let text = "echo $P | sudo docker login -u me --password-stdin";
        assert_eq!(redact_credentials(text), text);
    }

    // Round 24: a quoted cookie list whose session cookie is not the first;
    // `sudo -u root docker login`.
    #[test]
    fn keys_the_rules_missed_in_round_24_are_masked() {
        for (text, secret) in [
            (
                "curl -b \"lang=en; session=abc123def456ghi789\" https://x.com",
                "abc123def456ghi789",
            ),
            (
                "curl 'https://x.com/api' -b '_ga=GA1.1.5; sid=Zx9Yw8Vu7Ts6Rq5P' -H 'accept: */*'",
                "Zx9Yw8Vu7Ts6Rq5P",
            ),
            (
                "echo S3cretPass9 | sudo -u root docker login --password-stdin",
                "S3cretPass9",
            ),
            (
                "{\"cmd\":\"curl -b \\\"a=1; sid=abc123secret\\\" https://x\"}",
                "abc123secret",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "curl -b cookies.txt https://x.com",
            "grep -b \"x = 1\" file",
            "curl -b \"$COOKIE\" https://x.com",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 19: a quoted value after a flag, a default in an environment
    // lookup, PHP's and Perl's variables, Go's headers; and what round 18
    // masked that is not a secret: counts, other names, paths, rsync.
    #[test]
    fn keys_the_rules_missed_in_round_19_are_masked() {
        for (text, secret) in [
            (
                "docker login -u admin -p \"Hunter2pass9\" registry.example.com",
                "Hunter2pass9",
            ),
            ("mysql --password \"Hunter2pass9\" -u root", "Hunter2pass9"),
            (
                "npx vercel --token \"Ab3dEfGh1jKlMnOp9\"",
                "Ab3dEfGh1jKlMnOp9",
            ),
            ("sshpass -p 'S3cretSshPw99' ssh host", "S3cretSshPw99"),
            ("mysql -u root -p'MyS3cretPw99' db", "MyS3cretPw99"),
            ("redis-cli -a \"S3cretRedisPw99\" ping", "S3cretRedisPw99"),
            (
                "SECRET_KEY = os.environ.get('SECRET_KEY', 'django-insecure-q9#x$abc0123')",
                "django-insecure",
            ),
            (
                "API_KEY = os.getenv(\"WEATHER_API_KEY\", \"0123456789abcdef0123456789abcdef\")",
                "0123456789abcdef",
            ),
            (
                "const apiKey = process.env.API_KEY || \"Ab3dEfGh1jKlMnOp9\";",
                "Ab3dEfGh1jKlMnOp9",
            ),
            (
                "const apiKey = process.env.API_KEY ?? 'Ab3dEfGh1jKlMnOp9';",
                "Ab3dEfGh1jKlMnOp9",
            ),
            ("$password = 'Hunter2pass9';", "Hunter2pass9"),
            (
                "    public $db_password = \"Hunter2pass9\";",
                "Hunter2pass9",
            ),
            ("my $password = \"Hunter2pass9\";", "Hunter2pass9"),
            ("$this->password = 'Hunter2pass9';", "Hunter2pass9"),
            (
                "headers: map[Authorization:[Basic dXNlcjpwYXNzd29yZA==]]",
                "dXNlcjpwYXNzd29yZA",
            ),
            (
                "http.Header{\"X-Api-Key\":[]string{\"Ab3dEfGh1jKlMnOp9\"}}",
                "Ab3dEfGh1jKlMnOp9",
            ),
            ("SECRET_KEY_BASE=/9QxK2vabcdef0123456789", "9QxK2vabcdef"),
            ("http -a alice:S3cretPass9 POST x.test", "S3cretPass9"),
            ("config: {User:app Password:Hunter2pass9}", "Hunter2pass9"),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "usage: map[input_tokens:125000 output_tokens:4096 total_tokens:129096]",
            "{InputTokens:125000 CacheReadInputTokens:1048576}",
            "&{MaxTokens:200000 Temperature:1}",
            "{TokenExpiresAt:1731542400}",
            "const MESSAGE_LANGUAGE_KEY: &str = \"message_language\";",
            "pub(crate) const COMMAND_CODE_API_KEY_ENV: &str = \"COMMAND_CODE_API_KEY\";",
            "PUBLIC_KEY_PATH=/home/app/.ssh/id_rsa.pub",
            "GOOGLE_APPLICATION_CREDENTIALS=/Users/me/sa.json",
            "DB_PASSWORD_FILE=/run/secrets/db_password",
            "token_url: Some(\"https://oauth2.googleapis.com/token\")",
            "secret_name: Some(\"prod-db-credentials\")",
            "rsync -a server:backups/ ./backups",
            "{SecretRef:vault1 SecretName:db-creds-v2}",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 18: `/` starting a value again, `SECRET_KEY` in a dict, Java's
    // and Gradle's camelCase flags, a quoted Helm value, cookies.txt read
    // with line numbers, Go's and Rust's printouts, WordPress, HTTPie's
    // `-a`; and what round 17 masked that is not a secret.
    #[test]
    fn keys_the_rules_missed_in_round_18_are_masked() {
        for (text, secret) in [
            (
                "JWT_SECRET=/Zx9pQ2mWkk+abcdefghij0123456789==",
                "Zx9pQ2mWkk",
            ),
            (
                "{'SECRET_KEY': 'django-insecure-q9#x$abc'}",
                "django-insecure",
            ),
            (
                "environ({'STRIPE_SECRET_KEY': 'Ab3dEfGh1jKlMnOp'})",
                "Ab3dEfGh1jKlMnOp",
            ),
            (
                "./gradlew publish -PmavenCentralPassword=S3cretPass9",
                "S3cretPass9",
            ),
            ("java -DdbPassword=S3cretPass9 -jar app.jar", "S3cretPass9"),
            ("--set auth.rootPassword='S3cretPass9'", "S3cretPass9"),
            (
                "     5→.github.com\tTRUE\t/\tTRUE\t1735689600\tuser_session\tAb3dEf0123456789xyz",
                "Ab3dEf0123456789",
            ),
            (
                "config: {Host:db Port:5432 User:app Password:Hunter2pass9 SSLMode:disable}",
                "Hunter2pass9",
            ),
            ("map[password:Hunter2pass9 user:app]", "Hunter2pass9"),
            (
                "Config { host: \"db\", password: Some(\"Hunter2pass9\") }",
                "Hunter2pass9",
            ),
            (
                "    password: Some(\n        \"Hunter2pass9\",\n    ),",
                "Hunter2pass9",
            ),
            (
                "pub const API_KEY: &str = \"Ab3dEfGh1jKlMnOp9\";",
                "Ab3dEfGh1jKlMnOp9",
            ),
            ("define( 'DB_PASSWORD', 'Hunter2pass9' );", "Hunter2pass9"),
            ("define('AUTH_KEY', 'q9#x$abcdEFGH');", "q9#x$abcdEFGH"),
            ("http -a alice:S3cretPass9 POST x.test", "S3cretPass9"),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "private static final String TOKEN_HEADER = \"Authorization\";",
            "String PASSWORD_RESET_PATH = \"/api/v1/password/reset\";",
            "private String secretKeyRef = \"app-secrets\";",
            "'password' => 'required|string|min:8|confirmed',",
            ":password => 'must be at least 8 characters'",
            "TokenType:Bearer Expiry:0",
            "git push -u origin feature-x",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 17: quoted keys in dicts and hashes, dotted flags, typed
    // declarations, a quoted `curl -u`, cookies.txt, more names, headers and
    // query keys; and what round 16 masked that is not a secret.
    #[test]
    fn keys_the_rules_missed_in_round_17_are_masked() {
        for (text, secret) in [
            ("{'password': 'Hunter2pass9'}", "Hunter2pass9"),
            (
                "environ({'DB_PASSWORD': 'Zx9pQ2mWkk', 'HOME': '/root'})",
                "Zx9pQ2mWkk",
            ),
            ("        'PASSWORD': 'mydbpass123',", "mydbpass123"),
            ("'password' => 'S3cretPass9'", "S3cretPass9"),
            (":password => 'S3cretPass9'", "S3cretPass9"),
            (
                "helm install db bitnami/mysql --set auth.rootPassword=S3cretPass9",
                "S3cretPass9",
            ),
            (
                "java -Dspring.datasource.password=S3cretPass9 -jar app.jar",
                "S3cretPass9",
            ),
            ("mvn deploy -Dgpg.passphrase=S3cretPhrase9", "S3cretPhrase9"),
            (
                "./gradlew publish -Psigning.password=S3cretPass9",
                "S3cretPass9",
            ),
            ("String password = \"S3cretPass9\";", "S3cretPass9"),
            (
                "private static final String API_SECRET = \"Ab3dEfGh1jKlMnOp\";",
                "Ab3dEfGh1jKlMnOp",
            ),
            ("val apiKey = \"Ab3dEfGh1jKlMnOp\"", "Ab3dEfGh1jKlMnOp"),
            ("apiKey := \"Ab3dEfGh1jKlMnOp\"", "Ab3dEfGh1jKlMnOp"),
            ("curl -u 'admin:S3cretPass9' https://x.test", "S3cretPass9"),
            (
                "curl --user=admin:S3cretPass9 https://x.test",
                "S3cretPass9",
            ),
            ("http --auth alice:S3cretPass9 x.test", "S3cretPass9"),
            (
                ".github.com\tTRUE\t/\tTRUE\t1735689600\tuser_session\tAb3dEf0123456789xyz",
                "Ab3dEf0123456789",
            ),
            ("export QIANFAN_SK=Ab3dEfGh1jKlMnOp9", "Ab3dEfGh1jKlMnOp9"),
            (
                "https://restapi.amap.com/v3/ip?key=0123456789abcdef0123456789abcdef",
                "0123456789abcdef0123",
            ),
            (
                "https://api.map.baidu.com/geocoder?ak=0123456789abcdefABCDEF0123456789",
                "0123456789abcdefABCD",
            ),
            ("curl -H 'X-Client-Secret: Ab3dEfGh1jKl' x", "Ab3dEfGh1jKl"),
            (
                "> x-amz-security-token: IQoJb3JpZ2luX2VjEJr",
                "IQoJb3JpZ2lu",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "http://localhost:3000?email=alice@example.com",
            "https://api.example.com:8443?to=bob@example.com",
            "CLAUDE_CODE_MAX_OUTPUT_TOKENS=32000 claude",
            "export MAX_TOKENS=4096",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 16: a URL password with `#` or `?`, more webhooks and headers,
    // Slack's refresh tokens, `_PASSPHRASE` and `_PAT`; and what round 15
    // masked that is not a secret.
    #[test]
    fn keys_the_rules_missed_in_round_16_are_masked() {
        for (text, secret) in [
            ("psql postgres://admin:Pa#ss123word@db.example.com:5432/app", "ss123word"),
            ("DATABASE_URL=postgres://admin:Xy?9kLm2pQ@db.example.com/app", "9kLm2pQ"),
            ("https://open.feishu.cn/open-apis/bot/v2/hook/0f3c9a2e-1b2c-4d5e-8f90-abcdef012345", "0f3c9a2e-1b2c"),
            ("https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=693a91f6-7a2b-4c3d-9e8f-0123456789ab", "693a91f6-7a2b"),
            ("https://acme.webhook.office.com/webhookb2/0123abcd-4567@89ef/IncomingWebhook/abc123def456", "IncomingWebhook/abc123"),
            ("curl -H 'X-Figma-Token: figd_AbCdEfGh0123456789ijklmnop' https://api.figma.com/v1/me", "AbCdEfGh0123"),
            ("> x-functions-key: AzFuncKey0123456789abcdef==", "AzFuncKey0123"),
            (concat!("refresh: xoxe", "-1-My0xLTEwMjM0NTY3ODkwLTEyMzQ1Njc4OTA"), "My0xLTEw"),
            ("docker run -e GPG_PASSPHRASE=S3cretPhrase9 img", "S3cretPhrase9"),
            ("AZURE_DEVOPS_PAT=abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnop", "abcdefghijklmnop"),
            ("key fc-0123456789abcdef0123456789abcdef", "0123456789abcdef0123"),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "default-token-abcde   kubernetes.io/service-account-token   3   10d",
            "  rotate-token-fix     a1b2c3d fix: rotate",
            "api_key_rotation   enabled-by-default",
            "<div class=\"fc-daygrid-event-harness\">",
            "Loading model claude-sonnet-4-5...",
            "Fetching origin/feature-123...",
            "https://api.weixin.qq.com/sns/oauth2?appid=wx1234567890abcdef&scope=x",
            "docker run -u 1000:1000 img",
            "redis-cli -u redis://localhost:6379 ping",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
    }

    // Round 15: Vault's table and tokens, more fixed prefixes, query keys,
    // Python's auth tuples, AWS's pairs as text; and what round 14 masked
    // that is not a secret.
    #[test]
    fn keys_the_rules_missed_in_round_15_are_masked() {
        for (text, secret) in [
            ("db_password    S3cr3tP4ssw0rd!", "S3cr3tP4ssw0rd"),
            ("token    hvs.CAESIJabcdefghijklmnopqrstuvwxyz0123", "CAESIJabcdef"),
            (".dockercfg: eyJodHRwczovL2luZGV4LmRvY2tlci5pbyJ9", "eyJodHRwczov"),
            (r#"Client("nvapi-abcdefghij0123456789klmnop")"#, "abcdefghij0123"),
            (r#"Client("GOCSPX-abcdefghij0123456789klmn")"#, "abcdefghij0123"),
            (r#"Client("xapp-1-A0123456789-0123456789-abcdef")"#, "A0123456789-0123"),
            (concat!("mailgun key", "-0123456789abcdef0123456789abcdef"), "0123456789abcdef0123"),
            (
                concat!(
                    "bot MTEzNDU2Nzg5MDEyMzQ1Njc4",
                    ".GaBcDe.f3XyAbCdEfGhIjKlMnOpQrStUvWxYz012",
                ),
                "f3XyAbCdEfGh",
            ),
            ("https://api.openweathermap.org/data?q=x&appid=0123456789abcdef0123456789abcdef", "0123456789abcdef0123"),
            ("https://d1.cloudfront.net/a?Expires=1&Signature=AbCdEfGh0123456789xyz&Key-Pair-Id=K", "AbCdEfGh0123456789"),
            (r#"requests.get(u, auth=("admin", "Tr0ub4dor&3xyz"))"#, "Tr0ub4dor"),
            (r#"HTTPBasicAuth("deploy", "Tr0ub4dor&3xyz")"#, "Tr0ub4dor"),
            (
                "{\n  \"Name\": \"/prod/app/DB_PASSWORD\",\n  \"Type\": \"SecureString\",\n  \"Value\": \"S3cr3tPassw0rdXyz\"\n}",
                "S3cr3tPassw0rdXyz",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        for text in [
            "PWD=/Users/me/Documents/codeg2",
            "generate(prompt, max_token=512)",
            "Compiling serde_json v1.0.108...",
            "Downloading node-v20.11.0-darwin-arm64.tar.gz...",
            "I'll update parser_v2...",
            "<name>mapreduce.map.output.key.class</name><value>org.apache.hadoop.io.Text</value>",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
        let mail = redact_credentials("https://user:pw1234@host.example.com/x?to=bob@example.com");
        assert!(
            mail.contains("@host.example.com/x?to=bob@example.com"),
            "{mail}"
        );
    }

    // Round 14: passwords with `/` and `@`, keys in code headers, commands
    // and XML no rule knew, and a key cut short at the end of a title.
    #[test]
    fn keys_the_rules_missed_in_round_14_are_masked() {
        let hex = "0123456789abcdef0123456789abcdef01234567";
        for (text, secret) in [
            ("postgresql://admin:Xy7/kQ+9zP==@db:5432/app", "kQ+9zP"),
            ("DATABASE_URL=postgres://app:p@ss123word@db", "ss123word"),
            (
                "tls.key: LS0tLS1CRUdJTiBQUklWQVRFIEtFWS0tLS0t",
                "LS0tLS1CRUdJTi",
            ),
            (
                ".dockerconfigjson: eyJhdXRocyI6eyJyZWdpc3RyeSI6e30",
                "eyJhdXRocyI6",
            ),
            (
                "curl --header 'Authorization: Token 4f9a8b7c6d5e4f3a2b1c'",
                "4f9a8b7c6d5e",
            ),
            (
                "headers={'Authorization': 'Basic dXNlcjpwYXNzd29yZA=='}",
                "dXNlcjpwYXNz",
            ),
            (
                r#"{ Authorization: "Bearer abcDEF123456+/xyz789==" }"#,
                "xyz789",
            ),
            (
                r#"psql "host=db user=app password=Pa55word99""#,
                "Pa55word99",
            ),
            (
                "kubectl create secret generic db --from-literal=password=Hunter2isGood",
                "Hunter2isGood",
            ),
            (
                "aws configure set aws_secret_access_key wJalrXUtnFEMIK7MDENG",
                "wJalrXUtnFEMI",
            ),
            (
                r#"gh secret set API --body "s3cr3tvalue99""#,
                "s3cr3tvalue99",
            ),
            ("docker run -e api_key=abc123def456 img", "abc123def456"),
            ("openssl enc -aes256 -k topsecret9 -in a", "topsecret9"),
            ("htpasswd -b .htpasswd admin Adm1nPass", "Adm1nPass"),
            (
                "https://x.blob.core.windows.net/c/b?sv=2022-11-02&sig=AbCdEf0123456789%2Bxyz%3D",
                "AbCdEf0123456789",
            ),
            ("<password>MavenPass123</password>", "MavenPass123"),
            (
                "<name>fs.s3a.secret.key</name>\n  <value>HadoopSecret99</value>",
                "HadoopSecret99",
            ),
            (
                r#"<add key="ClearTextPassword" value="NuGetPass12" />"#,
                "NuGetPass12",
            ),
            ("key pplx-abcdefghij0123456789abcd", "abcdefghij0123"),
            (
                concat!("key shpat", "_0123456789abcdef0123456789abcdef"),
                "0123456789abcdef0123",
            ),
            ("refresh 1//0gAbCdEfGhIjKlMnOpQrStUvWxYz", "AbCdEfGhIjKl"),
            (
                "/bot123456789:AAHabcdefghijklmnopqrstuvwxyz01234-/getUpdates",
                "AAHabcdefghij",
            ),
            (
                "fix the AIzaSyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6...",
                "SyA1b2C3d4E5",
            ),
        ] {
            let out = redact_credentials(text);
            assert!(!out.contains(secret), "{secret} left in {out}");
        }
        let token_user = format!("git clone https://{hex}@github.com/o/r");
        assert!(!redact_credentials(&token_user).contains(hex));
        // What only looked like a secret stays.
        for text in [
            "http://localhost:5173/@vite/client",
            r#"find /var/lib -name "*mysql*" -print"#,
            "docker run --name mysql -p3306:3306 mysql:8",
            "sshpass -f ~/.pw ssh host -p2222",
            "tests pass:1234 fail:0",
            "max_tokens: 12345678",
            "admin_count: 12345678",
            "token=$TOKEN",
            "a title that ends in words...",
        ] {
            assert_eq!(redact_credentials(text), text);
        }
        assert!(!redact_credentials("admin_password: 12345678").contains("12345678"));
    }

    #[test]
    fn keys_in_headers_commands_calls_and_urls_are_masked() {
        for plain in [
            "gh auth login && mkdir -p src/components/settings",
            "    authorization: Option<String>,",
            "  authorization: headers.authorization,",
            "pass: true",
            "token_expires_at: 1731542400",
            "max_tokens: 40960000",
            "connect(host=\"db\", port=5432)",
            "https://example.test/page#section-two",
        ] {
            assert_eq!(redact_credentials(plain), plain);
        }
        let text = concat!(
            "curl https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0/getUpdates\n",
            "> Authorization: Token 9944b09199c62bcf9418ad846dd0e4bbdfc6ee4b\n",
            "Authorization: Bot MTk4NjIyNDgzNDcxOTI1MjQ4\n",
            "curl -H \"Authorization: lin_api_linearkey99abc\" x\n",
            "Authorization: Bearer abc+def/ghi=b64bearer99\n",
            "curl -H \"X-Auth-Key: cfglobalkey9999\" x\n",
            "curl -H 'Ocp-Apim-Subscription-Key: azuresubkey999' x\n",
            "curl -H 'X-Api-Token: xapitoken9999' x\n",
            "mysql -u root -pMyS3cretPw99 db\n",
            "sshpass -p S3cretSshPw99 ssh host\n",
            "redis-cli -a S3cretRedisPw99 ping\n",
            "openssl pkcs12 -in a.p12 -passin pass:S3cretP12pw\n",
            "requirepass S3cretRequire99\n",
            "REDIS_URL=redis://:S3cretRedisPass@10.0.0.5:6379\n",
            "psycopg2.connect(host=\"db\", password=\"KwargPass99\")\n",
            "Client(api_key=\"a1b2c3d4e5f6g7h8i9\")\n",
            "config[\"password\"] = \"IndexPass99\"\n",
            "os.environ[\"ANTHROPIC_AUTH_TOKEN\"] = \"cr_envindex99\"\n",
            "{\"env\":[{\"name\":\"DB_PASSWORD\",\"value\":\"envpairpass99\"}]}\n",
            "password: 88888888\n",
            "client-key-data: LS0tLS1CRUdJTiBSU0EgUFJJVkFURSBLRVktLS0tLQ==\n",
            "-----BEGIN PGP PRIVATE KEY BLOCK-----\nlQOYBpgpbody99\n-----END PGP PRIVATE KEY BLOCK-----\n",
            "DefaultEndpointsProtocol=https;AccountName=a;AccountKey=azureacctkey99==;\n",
            "https://app.test/callback#access_token=8f14e45fceea167a\n",
            "https://hooks.slack.com/services/T0000/B0000/slackhooksecret99\n",
            "https://discord.com/api/webhooks/123456/discordhooksecret99\n",
            "TAVILY_KEY tvly-tavilykey0123456789abc\n",
            "groq gsk_groqkey0123456789abcdef\n",
            "stripe whsec_whseckey0123456789abc\n",
            "docker dckr_pat_dockerpat0123456789ab\n",
            "sendgrid SG.sendgridpart1abc.sendgridpart2abcdef\n",
            "age AGE-SECRET-KEY-1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ\n",
        );
        let out = redact_credentials(text);
        for secret in [
            "AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw0",
            "9944b09199c62bcf",
            "MTk4NjIyNDgzNDcxOTI1MjQ4",
            "lin_api_linearkey99abc",
            "b64bearer99",
            "cfglobalkey9999",
            "azuresubkey999",
            "xapitoken9999",
            "MyS3cretPw99",
            "S3cretSshPw99",
            "S3cretRedisPw99",
            "S3cretP12pw",
            "S3cretRequire99",
            "S3cretRedisPass",
            "KwargPass99",
            "a1b2c3d4e5f6g7h8i9",
            "IndexPass99",
            "cr_envindex99",
            "envpairpass99",
            "88888888",
            "LS0tLS1CRUdJTi",
            "lQOYBpgpbody99",
            "azureacctkey99",
            "8f14e45fceea167a",
            "slackhooksecret99",
            "discordhooksecret99",
            "tavilykey0123456789abc",
            "groqkey0123456789abcdef",
            "whseckey0123456789abc",
            "dockerpat0123456789ab",
            "sendgridpart2abcdef",
            "QQQQQQQQQQQQQQQQQQQQ",
        ] {
            assert!(!out.contains(secret), "{secret} in {out}");
        }
    }

    #[test]
    fn keys_after_a_prefix_or_mid_line_are_masked_and_paths_stay() {
        for plain in [
            "+let password = read_line();",
            "--password-file=/x",
            "https://x.test/y?token_count=3",
            "git checkout -b feature",
            "mkdir -p dir",
            "sort-key: created_at",
            "token_url: https://oauth2.googleapis.com/token",
            "credentials_file: ~/.config/gcloud/creds.json",
            "password_file: /run/secrets/db",
            "secretName: grafana-tls",
            "pwd: /Users/me/proj",
            "token=$TOKEN",
            "compass: north2east",
            "max_tokens: int = 4096",
            "gh auth login -p ssh",
        ] {
            assert_eq!(redact_credentials(plain), plain);
        }
        let text = concat!(
            "+password = \"diffadded99\"\n",
            "+  api_key: diffyaml1234\n",
            "config/prod.yml:14:  password: grepped99yml\n",
            "docker-compose.yml:9:  POSTGRES_PASSWORD: greppedcompose9\n",
            r#"{"content":"password = firstline99\n..."}"#,
            "\n",
            "export db_password=exported99\n",
            "$env:OPENAI_KEY = \"pwshkey12345\"\n",
            "const apiKey = \"constkey12345\"\n",
            "api_key: str = \"typedkey12345\"\n",
            "smtp_pass: smtppass1234\n",
            "MAIL_PASS: mailpass1234\n",
            "password = \"it's-my-s3cret\"\n",
            "password = \"abc\\\"escapedq99\"\n",
            "password=Pa55;semicolon99\n",
            "password: P@ss,comma99\n",
            "mysql -u root --password=flagpass99\n",
            "tool --api-key flagkey12345\n",
            "docker login -u bob -p dockerpass99 reg.test\n",
            "jdbc:postgresql://h/db?user=app&password=jdbcpass99\n",
            "https://api.x.test/v1?access_token=querytoken99\n",
            "Server=.;User Id=sa;Password=Conn3ction!99;\n",
            "createConnection({host:'x', password:'objectpass99'})\n",
            "curl -H 'cookie: sessionid=cookiehdr99' x\n",
            "curl -b 'sid=curlcookie99' x\n",
            "Set-Cookie: sid=setcookie99\n",
            "PRIVATE-TOKEN: glptlegacy1234567890\n",
            "X-Vault-Token: hvs.vaulttoken99\n",
            "x-goog-api-key: googkey12345678\n",
            "     3\t  \"db2_password\": \"jsondigit99\",\n",
        );
        let out = redact_credentials(text);
        for secret in [
            "diffadded99",
            "diffyaml1234",
            "grepped99yml",
            "greppedcompose9",
            "firstline99",
            "exported99",
            "pwshkey12345",
            "constkey12345",
            "typedkey12345",
            "smtppass1234",
            "mailpass1234",
            "my-s3cret",
            "escapedq99",
            "semicolon99",
            "comma99",
            "flagpass99",
            "flagkey12345",
            "dockerpass99",
            "jdbcpass99",
            "querytoken99",
            "Conn3ction",
            "objectpass99",
            "cookiehdr99",
            "curlcookie99",
            "setcookie99",
            "glptlegacy",
            "vaulttoken99",
            "googkey12345678",
            "jsondigit99",
        ] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
    }

    #[test]
    fn config_lines_in_more_forms_are_masked_and_code_stays() {
        for code in [
            "self.access_token = access_token",
            "max_tokens = self.max_tokens_limit",
            "DEFAULT_MAX_TOKENS = 100000000",
            "secret = settings.SECRET",
            "MAX_TOKENS: 100000000",
            "tokenizer: o200k_base",
            "author: someone2024",
        ] {
            assert_eq!(redact_credentials(code), code);
        }
        // A file as an agent's read shows it, with line numbers in front;
        // JSONL that does not parse; and other formats keys are kept in.
        let text = concat!(
            "     1\tpassword = numbered1pw\n",
            "     2→password=numbered2pw\n",
            r#"{"x":"[db]\npassword = escapedini9\n"}"#,
            "\n",
            "spring.datasource.password=springpw2long\n",
            "password: lowercaseyaml9\n",
            "password: \"quoted yaml words\"\n",
            "password = 'quoted ini words'\n",
            "curl -H 'Authorization: Basic dXNlcjpodW50ZXIy' https://x.test\n",
            "curl -u alice:curluserpw9 https://x.test\n",
            "X-API-Key: headerkey12345\n",
            "MYSQL_PWD=mysqlpwd1234 SMTP_PASS=smtppass1234 REDISCLI_AUTH=redisauth1234\n",
        );
        let out = redact_credentials(text);
        for secret in [
            "numbered1pw",
            "numbered2pw",
            "escapedini9",
            "springpw2long",
            "lowercaseyaml9",
            "quoted yaml words",
            "quoted ini words",
            "dXNlcjpodW50ZXIy",
            "curluserpw9",
            "headerkey12345",
            "mysqlpwd1234",
            "smtppass1234",
            "redisauth1234",
        ] {
            assert!(!out.contains(secret), "{secret} survived: {out}");
        }
    }

    #[test]
    fn redacts_known_token_shapes() {
        let cases = [
            ("key sk-live-abcdefghijklmno here", "sk-live-abcdefghijklmno"),
            (
                "token ghp_abcdefghijklmnopqrstuvwxyz01",
                "ghp_abcdefghijklmnopqrstuvwxyz01",
            ),
            ("slack xoxb-1234567890-abcdef", "xoxb-1234567890-abcdef"),
            ("aws AKIAIOSFODNN7EXAMPLE", "AKIAIOSFODNN7EXAMPLE"),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
        }
    }

    #[test]
    fn redacts_header_and_uri_credential_forms() {
        let cases = [
            ("Authorization: Basic dXNlcjpwYXNzd29yZA==", "dXNlcjpwYXNz"),
            ("authorization=Bearer abcdefghijklmnop", "abcdefghijklmnop"),
            ("Cookie: session=deadbeefdeadbeef", "deadbeefdeadbeef"),
            ("Set-Cookie: sid=abcdef123456", "abcdef123456"),
            ("connect https://user:hunter2@example.com/x", "hunter2"),
            ("Bearer abcdefghijklmnopqrst failed", "abcdefghijklmnopqrst"),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
        }
    }

    #[test]
    fn redacts_named_secret_assignments_and_keys() {
        let cases = [
            ("invalid api_key=sk_test_abcdef", "sk_test_abcdef"),
            ("apiKey: zzzzzzzzzzzz", "zzzzzzzzzzzz"),
            ("access_token = qqqqqqqqqqqq", "qqqqqqqqqqqq"),
            ("password: hunter2hunter2", "hunter2hunter2"),
            (
                "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc",
                "eyJzdWIiOiIxMjM0NSJ9",
            ),
        ];
        for (input, secret) in cases {
            let out = sanitize_diagnostic(input);
            assert!(!out.contains(secret), "leaked {secret:?} in {out:?}");
        }
        assert!(sanitize_diagnostic("-----BEGIN RSA PRIVATE KEY-----").contains("(redacted)"));
    }

    #[test]
    fn leaves_benign_text_alone() {
        for benign in [
            "skipped 3 files",
            "token_count=12",
            "Authorization header missing",
            "reading package.json",
        ] {
            assert_eq!(sanitize_diagnostic(benign), benign, "mangled {benign:?}");
        }
    }

    // ---- summarize_parser_error ----

    #[test]
    fn summarizes_invalid_type_and_keeps_position() {
        let out = summarize_parser_error(
            r#"invalid type: string "sk-live-abcdefghijkl", expected u64 at line 1 column 40"#,
        );
        assert_eq!(out, "invalid type, expected u64 at line 1 column 40");
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn redacts_backticked_variant_payload() {
        let out = summarize_parser_error(
            "unknown variant `sk-live-abcdefghijkl`, expected one of `plan`, `usage_update`",
        );
        assert_eq!(
            out,
            "unknown variant (redacted), expected one of `plan`, `usage_update`"
        );
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn redacts_unknown_field_payload() {
        let out = summarize_parser_error(
            "unknown field `sk-live-abcdefghijkl`, expected `sessionUpdate`",
        );
        assert!(out.starts_with("unknown field (redacted)"));
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn keeps_schema_derived_missing_field() {
        assert_eq!(
            summarize_parser_error("missing field `sessionUpdate` at line 1 column 2"),
            "missing field `sessionUpdate` at line 1 column 2"
        );
    }

    #[test]
    fn redacts_missing_field_outside_allowlist() {
        let out = summarize_parser_error("missing field `sk_live_abcdefghijkl`");
        assert_eq!(out, "missing field (redacted)");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn rejects_expectation_outside_finite_allowlist() {
        // A hand-written `expecting()` can interpolate payload using only
        // "legal" characters — the charset alone proves nothing.
        let out = summarize_parser_error(
            "invalid type: map, expected sk-live-abcdefghijkl at line 1 column 40",
        );
        assert_eq!(out, "invalid type (redacted) at line 1 column 40");
        assert!(!out.contains("sk-live"));
    }

    #[test]
    fn rejects_variant_list_with_one_unknown_item() {
        let out = summarize_parser_error(
            "unknown variant `x`, expected one of `plan`, `sk_live_abcdefghijkl`",
        );
        assert_eq!(out, "unknown variant (redacted)");
        assert!(!out.contains("sk_live"));
    }

    #[test]
    fn unquoted_interpolation_falls_through_to_default_deny() {
        let out = summarize_parser_error("custom deserializer failed on sk-live-abcdefghijkl");
        assert_eq!(out, "unrecognized parse error (redacted)");
    }

    #[test]
    fn escaped_quotes_do_not_leak() {
        let out = summarize_parser_error(
            r#"invalid value: string "a\"sk-live-abcdefghijkl", expected a string"#,
        );
        assert!(!out.contains("sk-live"), "leaked in {out:?}");
        assert_eq!(out, "invalid value, expected a string");
    }

    #[test]
    fn keeps_only_the_first_line() {
        let out = summarize_parser_error(
            "invalid type: string, expected u64\n  at Foo::deserialize (sk-live-abcdefghijkl)",
        );
        assert!(!out.contains("sk-live"));
        assert_eq!(out, "invalid type, expected u64");
    }

    #[test]
    fn keeps_payload_free_syntax_errors() {
        assert_eq!(
            summarize_parser_error("EOF while parsing a value at line 1 column 3"),
            "EOF while parsing at line 1 column 3"
        );
        assert_eq!(
            summarize_parser_error("trailing characters at line 2 column 1"),
            "trailing characters at line 2 column 1"
        );
    }

    /// Matching a safe phrase says nothing about what follows it: serde_json
    /// appends input-derived context to some of these, and a custom error can
    /// open with the phrase and continue with anything at all.
    #[test]
    fn syntax_prefix_match_drops_the_suffix() {
        let out =
            summarize_parser_error("EOF while parsing customer prompt: sk-live-abcdefghijklmnop");
        assert_eq!(out, "EOF while parsing");

        let out = summarize_parser_error("expected value, got confidential user text here");
        assert_eq!(out, "expected value");
    }

    /// Truncating before redacting would slice a token below the length its
    /// pattern requires, letting the fragment through unrecognized.
    #[test]
    fn redacts_before_truncating_so_a_split_secret_cannot_survive() {
        const SECRET: &str = "sk-live-abcdefghijklmnopqrstuvwxyz";
        let tail = StderrTail::new();
        // Place the secret so it straddles MAX_LINE_BYTES.
        let prefix = "x".repeat(MAX_LINE_BYTES - 10);
        tail.push(&format!("{prefix}{SECRET} trailing"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("sk-live"), "leaked fragment in {line:?}");
        assert!(line.contains("sk-***"), "expected redaction marker in {line:?}");
    }

    #[test]
    fn redacts_a_uri_credential_straddling_the_retained_length() {
        let tail = StderrTail::new();
        let prefix = "y".repeat(MAX_LINE_BYTES - 20);
        tail.push(&format!("{prefix}https://user:hunter2secret@example.com/x"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("hunter2secret"), "leaked in {line:?}");
    }

    /// A password long enough to push its terminating `@` past the scan bound
    /// defeats the `@`-anchored rule; the head of the password would otherwise
    /// survive into the retained prefix.
    #[test]
    fn redacts_a_uri_credential_whose_terminator_is_past_the_scan_bound() {
        let tail = StderrTail::new();
        let prefix = "z".repeat(MAX_LINE_BYTES - 30);
        let password = "P".repeat(MAX_SCAN_BYTES);
        tail.push(&format!("{prefix}https://user:{password}@example.com/x"));

        let slice = tail.tail_since(0, 10, 8192);
        let line = &slice.lines[0];
        assert!(!line.contains("PPPP"), "leaked password head in {line:?}");
        assert!(line.contains("***:***"), "expected redaction in {line:?}");
    }

    #[test]
    fn does_not_mangle_an_ordinary_host_port_url() {
        for benign in [
            "fetching https://example.com:8080/v1/models",
            "listening on http://127.0.0.1:3000",
        ] {
            assert_eq!(sanitize_diagnostic(benign), benign, "mangled {benign:?}");
        }
    }

    #[test]
    fn truncates_to_bound_without_splitting_utf8() {
        let long = format!("custom failure {}", "中".repeat(400));
        let out = summarize_parser_error(&long);
        assert!(out.len() <= MAX_DROP_ERROR_BYTES + '…'.len_utf8());
        assert!(!out.contains('\u{fffd}'));
    }

    /// The load-bearing invariant: whatever path a parser error takes, the
    /// original secret must not survive into the output.
    #[test]
    fn never_echoes_the_original_secret() {
        const SECRET: &str = "sk-live-abcdefghijklmnop";
        let inputs = [
            format!(r#"invalid type: string "{SECRET}", expected u64"#),
            format!("unknown variant `{SECRET}`, expected one of `plan`"),
            format!("unknown field `{SECRET}`, expected `sessionUpdate`"),
            format!("missing field `{SECRET}`"),
            format!("invalid value: string, expected {SECRET}"),
            format!("weird custom error mentioning {SECRET} inline"),
            format!("invalid length 3, expected {SECRET} at line 9 column 9"),
            format!("EOF while parsing {SECRET}"),
        ];
        for input in inputs {
            let out = summarize_parser_error(&input);
            assert!(!out.contains(SECRET), "leaked from {input:?} -> {out:?}");
        }
    }
}
