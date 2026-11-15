//! What agents have done to each tab of the person's own Chrome, for the
//! Chrome panel (`docs/agent-chrome.md` section 13.4).
//!
//! Every attempt an agent makes on a tab is already announced as it happens
//! (`browser://agent-activity`); the built-in browser keeps those in the
//! window that shows the tab. A Chrome tab is shown by no window, and the
//! panel that lists it is opened long after the agent was there, so the lines
//! are kept here instead: in memory, the last [`PER_TAB`] per tab and
//! [`TOTAL`] in all, and forgotten when the connection ends
//! (`ChromeLink`). Never written to disk: a line names the site and what was
//! done there, and a file of those is a browsing history to look after.
//!
//! What a line never holds is what was typed. An input says which field it
//! went into, by the name the agent's last snapshot gave that field, and a
//! password field not even that.
//!
//! What a line of `browser_eval` does hold is the code the agent sent, up to
//! [`CODE_CHARS`] of it (13.5): the code is what the agent did, and it is
//! the agent's, not the person's.
//!
//! Pure bookkeeping, compiled in both runtimes for the sake of its tests; the
//! desktop app is its only user (`browser::chrome_share`).

use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;

use crate::browser::agent::{AgentAction, AgentOutcome};

/// Lines kept per tab.
pub const PER_TAB: usize = 50;

/// Lines kept in all; the oldest go first, whichever tab they are on.
pub const TOTAL: usize = 500;

/// A field's name, as kept: long enough to recognise, short enough that a
/// page cannot fill the panel through it.
const NAME_CHARS: usize = 80;

/// Names remembered from one snapshot of one tab.
const NAMES_PER_TAB: usize = 2000;

/// The most of an agent's code a line keeps: as much as `browser_eval`
/// accepts at all (`eval::MAX_EVAL_CODE_CHARS`), so a line shows all of what
/// ran.
pub const CODE_CHARS: usize = crate::browser::eval::MAX_EVAL_CODE_CHARS;

/// What an action was aimed at, as the person is told of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum ActivityTarget {
    /// The element's name in the agent's last snapshot of the page.
    Named { name: String },
    /// A password field: not even its name.
    Password,
    /// The code an agent sent to run in the page (`browser_eval`), up to
    /// [`CODE_CHARS`].
    Code { code: String },
}

impl ActivityTarget {
    /// The line for running `code`: the first [`CODE_CHARS`] characters of
    /// it, marked as cut when there was more.
    pub fn code(code: &str) -> Self {
        let code = if code.chars().count() <= CODE_CHARS {
            code.to_string()
        } else {
            let mut kept: String = code.chars().take(CODE_CHARS).collect();
            kept.push('…');
            kept
        };
        ActivityTarget::Code { code }
    }
}

/// One agent's one attempt on one Chrome tab. Mirrored by
/// `ChromeActivityEntry` in `src/lib/browser/chrome-api.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityEntry {
    /// Unix milliseconds.
    pub at: i64,
    pub action: AgentAction,
    pub outcome: AgentOutcome,
    /// The site the tab was on at the time; `None` for a page with no host.
    pub host: Option<String>,
    /// Whose agent it was: `local` for the app's own, a remote window's
    /// label for that server's (`chrome::lending`).
    pub scope: String,
    pub target: Option<ActivityTarget>,
}

#[derive(Default)]
pub struct ChromeActivity {
    inner: Mutex<Inner>,
}

#[derive(Default)]
struct Inner {
    /// Oldest first, each line with the order it was recorded in.
    tabs: HashMap<String, VecDeque<(u64, ActivityEntry)>>,
    total: usize,
    next: u64,
    names: HashMap<String, RefNames>,
}

/// The names of one snapshot's refs, good for the refs that snapshot issued.
struct RefNames {
    generation: String,
    names: HashMap<String, String>,
}

impl ChromeActivity {
    pub fn record(&self, tab_id: &str, entry: ActivityEntry) {
        let mut guard = self.inner();
        let inner = &mut *guard;
        let seq = inner.next;
        inner.next += 1;
        let lines = inner.tabs.entry(tab_id.to_string()).or_default();
        lines.push_back((seq, entry));
        inner.total += 1;
        if lines.len() > PER_TAB {
            lines.pop_front();
            inner.total -= 1;
        }
        while inner.total > TOTAL && inner.evict_oldest() {}
    }

    /// Every tab's lines, oldest first.
    pub fn all(&self) -> HashMap<String, Vec<ActivityEntry>> {
        self.inner()
            .tabs
            .iter()
            .map(|(tab_id, lines)| {
                let lines = lines.iter().map(|(_, entry)| entry.clone()).collect();
                (tab_id.clone(), lines)
            })
            .collect()
    }

    /// Forget everything: the connection ended.
    pub fn clear(&self) {
        *self.inner() = Inner::default();
    }

    /// Forget the tabs Chrome no longer has open.
    pub fn retain_tabs(&self, open: impl Fn(&str) -> bool) {
        let mut guard = self.inner();
        let inner = &mut *guard;
        inner.tabs.retain(|tab_id, _| open(tab_id));
        inner.names.retain(|tab_id, _| open(tab_id));
        inner.total = inner.tabs.values().map(VecDeque::len).sum();
    }

    /// Keep the names a snapshot of `tab_id` gave its refs, for the lines of
    /// the actions taken by those refs.
    pub fn remember_names(&self, tab_id: &str, generation: &str, tree: &str) {
        let names = ref_names(tree);
        self.inner().names.insert(
            tab_id.to_string(),
            RefNames {
                generation: generation.to_string(),
                names,
            },
        );
    }

    /// The name the snapshot that issued `generation` gave `target`.
    pub fn name_of(&self, tab_id: &str, generation: &str, target: &str) -> Option<String> {
        let inner = self.inner();
        let known = inner.names.get(tab_id)?;
        if known.generation != generation {
            return None;
        }
        known.names.get(target).cloned()
    }

    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

impl Inner {
    /// Drop the oldest line of all. `false` when there was none.
    fn evict_oldest(&mut self) -> bool {
        let oldest = self
            .tabs
            .iter()
            .filter_map(|(tab_id, lines)| lines.front().map(|(seq, _)| (*seq, tab_id.clone())))
            .min();
        let Some((_, tab_id)) = oldest else {
            return false;
        };
        if let Some(lines) = self.tabs.get_mut(&tab_id) {
            lines.pop_front();
            if lines.is_empty() {
                self.tabs.remove(&tab_id);
            }
        }
        self.total -= 1;
        true
    }
}

/// `ref → name` for every named element of a snapshot's tree (Playwright's
/// `ai` rendering: `- textbox "Email" [ref=e5]: …`).
///
/// Only the name and the ref are read, from the parts of a line the renderer
/// writes itself: the name is JSON-quoted and the attributes after it are
/// `[…]` groups, so a page that writes `[ref=e9]` into its text or into a
/// field's value cannot pass it off as a ref. A field's value, which follows
/// the attributes, is never read.
pub fn ref_names(tree: &str) -> HashMap<String, String> {
    let mut names = HashMap::new();
    for line in tree.lines() {
        if names.len() >= NAMES_PER_TAB {
            break;
        }
        if let Some((target, name)) = named_ref(line) {
            names.insert(target, name);
        }
    }
    names
}

fn named_ref(line: &str) -> Option<(String, String)> {
    let item = line.trim_start().strip_prefix("- ")?;
    // A key YAML would misread is single-quoted whole, quotes doubled.
    let key = match item.strip_prefix('\'') {
        Some(quoted) => unquote_single(quoted)?,
        None => item.to_string(),
    };
    let (_role, rest) = key.split_once(' ')?;
    let (name, mut rest) = json_string_prefix(rest)?;
    while let Some(group) = rest.strip_prefix(" [") {
        let (attribute, after) = group.split_once(']')?;
        if let Some(target) = attribute.strip_prefix("ref=") {
            let name = name.trim();
            if name.is_empty() {
                return None;
            }
            return Some((target.to_string(), shorten(name)));
        }
        rest = after;
    }
    None
}

/// The text of a single-quoted YAML key, up to its closing quote.
fn unquote_single(quoted: &str) -> Option<String> {
    let mut out = String::new();
    let mut chars = quoted.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '\'' {
            out.push(c);
        } else if chars.peek() == Some(&'\'') {
            chars.next();
            out.push('\'');
        } else {
            return Some(out);
        }
    }
    None
}

/// A JSON string at the start of `text`, and what follows it.
fn json_string_prefix(text: &str) -> Option<(String, &str)> {
    if !text.starts_with('"') {
        return None;
    }
    let mut escaped = false;
    for (index, c) in text.char_indices().skip(1) {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == '"' {
            let end = index + c.len_utf8();
            let name = serde_json::from_str::<String>(&text[..end]).ok()?;
            return Some((name, &text[end..]));
        }
    }
    None
}

fn shorten(name: &str) -> String {
    if name.chars().count() <= NAME_CHARS {
        return name.to_string();
    }
    let mut short: String = name.chars().take(NAME_CHARS - 1).collect();
    short.push('…');
    short
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(at: i64) -> ActivityEntry {
        ActivityEntry {
            at,
            action: AgentAction::Read,
            outcome: AgentOutcome::Done,
            host: Some("example.com".to_string()),
            scope: "local".to_string(),
            target: None,
        }
    }

    fn total(activity: &ChromeActivity) -> usize {
        activity.all().values().map(Vec::len).sum()
    }

    #[test]
    fn a_tab_keeps_its_last_fifty_lines() {
        let activity = ChromeActivity::default();
        for at in 0..(PER_TAB as i64 + 7) {
            activity.record("tab-1", entry(at));
        }
        let lines = &activity.all()["tab-1"];
        assert_eq!(lines.len(), PER_TAB);
        assert_eq!(lines[0].at, 7);
        assert_eq!(lines[PER_TAB - 1].at, PER_TAB as i64 + 6);
    }

    #[test]
    fn five_hundred_in_all_and_the_oldest_go_first() {
        let activity = ChromeActivity::default();
        // Twelve tabs of fifty, written one tab after the other.
        for tab in 0..12 {
            for line in 0..PER_TAB as i64 {
                activity.record(&format!("tab-{tab}"), entry(tab * 100 + line));
            }
        }
        assert_eq!(total(&activity), TOTAL);
        let all = activity.all();
        // The first two tabs were the oldest hundred lines.
        assert!(!all.contains_key("tab-0"));
        assert!(!all.contains_key("tab-1"));
        assert_eq!(all["tab-2"].len(), PER_TAB);
        assert_eq!(all["tab-11"].len(), PER_TAB);
        // Still five hundred after more, the oldest of what is left gone.
        activity.record("tab-12", entry(5000));
        assert_eq!(total(&activity), TOTAL);
        assert_eq!(activity.all()["tab-2"].len(), PER_TAB - 1);
        assert_eq!(activity.all()["tab-2"][0].at, 201);
    }

    #[test]
    fn clearing_forgets_the_lines_and_the_names() {
        let activity = ChromeActivity::default();
        activity.record("tab-1", entry(1));
        activity.remember_names("tab-1", "g1", "- textbox \"Email\" [ref=e1]");
        activity.clear();
        assert!(activity.all().is_empty());
        assert_eq!(activity.name_of("tab-1", "g1", "e1"), None);
        // And counts from nothing again.
        for at in 0..TOTAL as i64 {
            activity.record(&format!("tab-{}", at % 20), entry(at));
        }
        assert_eq!(total(&activity), TOTAL);
    }

    #[test]
    fn closed_tabs_are_forgotten() {
        let activity = ChromeActivity::default();
        activity.record("tab-1", entry(1));
        activity.record("tab-2", entry(2));
        activity.remember_names("tab-1", "g1", "- button \"Go\" [ref=e1]");
        activity.retain_tabs(|tab_id| tab_id == "tab-2");
        assert_eq!(activity.all().keys().collect::<Vec<_>>(), ["tab-2"]);
        assert_eq!(activity.name_of("tab-1", "g1", "e1"), None);
        // The count went with them.
        for at in 0..(TOTAL as i64 - 1) {
            activity.record(&format!("tab-{}", 3 + at % 20), entry(at));
        }
        assert_eq!(activity.all()["tab-2"].len(), 1);
    }

    #[test]
    fn a_line_serializes_without_what_was_typed() {
        let mut line = entry(1);
        line.action = AgentAction::Type;
        line.target = Some(ActivityTarget::Password);
        let value = serde_json::to_value(&line).unwrap();
        assert_eq!(value["action"], "type");
        assert_eq!(value["target"], serde_json::json!({ "kind": "password" }));
        assert_eq!(value["host"], "example.com");
        line.target = Some(ActivityTarget::Named {
            name: "Email".to_string(),
        });
        let value = serde_json::to_value(&line).unwrap();
        assert_eq!(
            value["target"],
            serde_json::json!({ "kind": "named", "name": "Email" })
        );
    }

    #[test]
    fn a_line_of_running_code_keeps_the_code() {
        let mut line = entry(1);
        line.action = AgentAction::Eval;
        line.target = Some(ActivityTarget::code("return document.title"));
        let value = serde_json::to_value(&line).unwrap();
        assert_eq!(value["action"], "eval");
        assert_eq!(
            value["target"],
            serde_json::json!({ "kind": "code", "code": "return document.title" })
        );
    }

    #[test]
    fn code_is_kept_up_to_its_cap_in_characters() {
        let whole = "字".repeat(CODE_CHARS);
        assert_eq!(
            ActivityTarget::code(&whole),
            ActivityTarget::Code {
                code: whole.clone()
            }
        );
        let ActivityTarget::Code { code } = ActivityTarget::code(&format!("{whole}ab")) else {
            panic!("not a code line");
        };
        assert_eq!(code.chars().count(), CODE_CHARS + 1);
        assert!(code.ends_with('…'));
        assert!(code.starts_with(&whole));
    }

    #[test]
    fn names_come_from_the_snapshot_that_issued_the_ref() {
        let tree = [
            "- generic [ref=e1]:",
            "  - textbox \"Email\" [ref=e2]: someone@example.com",
            "  - textbox \"Password\" [ref=e3]: hunter2",
            "  - button \"Sign \\\"in\\\"\" [ref=e4] [cursor=pointer]",
            "  - 'button \"Save: now\" [ref=e5]'",
            "  - 'link \"Bob''s page\" [ref=e6]':",
            "  - checkbox \"Remember me\" [checked] [ref=e7]",
            "  - text: click [ref=e9] to continue",
            "  - textbox [ref=e8]: \"x\" [ref=e10]",
        ]
        .join("\n");
        let activity = ChromeActivity::default();
        activity.remember_names("tab-1", "g1.1.0", &tree);
        let name = |target: &str| activity.name_of("tab-1", "g1.1.0", target);
        assert_eq!(name("e1"), None);
        assert_eq!(name("e2").as_deref(), Some("Email"));
        assert_eq!(name("e3").as_deref(), Some("Password"));
        assert_eq!(name("e4").as_deref(), Some("Sign \"in\""));
        assert_eq!(name("e5").as_deref(), Some("Save: now"));
        assert_eq!(name("e6").as_deref(), Some("Bob's page"));
        assert_eq!(name("e7").as_deref(), Some("Remember me"));
        // Refs written by the page are not refs.
        assert_eq!(name("e9"), None);
        assert_eq!(name("e10"), None);
        // A ref quoted from another snapshot gets no name.
        assert_eq!(activity.name_of("tab-1", "g2.1.0", "e2"), None);
        // Values are never kept, not even as names.
        let names = ref_names(&tree);
        assert!(names.values().all(|name| !name.contains("hunter2")));
        assert!(names.values().all(|name| !name.contains("someone@")));
    }

    #[test]
    fn long_names_are_cut() {
        let long = "x".repeat(300);
        let names = ref_names(&format!("- button \"{long}\" [ref=e1]"));
        assert_eq!(names["e1"].chars().count(), NAME_CHARS);
        assert!(names["e1"].ends_with('…'));
    }
}
