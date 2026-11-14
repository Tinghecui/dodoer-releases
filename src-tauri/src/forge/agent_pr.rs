//! What a Claude conversation's own transcript says about its pull request:
//! where the agent is working now, and which pull request it opened — for the
//! sidebar's PR status of conversations that do NOT live in a codeg worktree
//! (see [`super::pr_status`]).
//!
//! An agent can make its own worktree (Claude's EnterWorktree, or
//! `git worktree add` and `cd`), and codeg never hears of it: the conversation
//! stays filed under the main checkout. Every transcript record carries the
//! session's `cwd`, which follows the agent there, so the newest one names the
//! worktree. (The records' `gitBranch` does not follow it — it stays the
//! branch the session started on — so the branch is read from the worktree.)
//!
//! The transcript is read incrementally: each conversation keeps its offset,
//! and only complete lines past it are looked at. Most lines are skipped on a
//! substring test; only the newest `cwd` line and the few lines that create a
//! pull request or answer such a call are parsed.
//!
//! Claude Code re-appends old records (same uuids, same timestamps) when it
//! compacts. Those must not move the answer back, so a record only counts when
//! its timestamp is not older than the one the current answer came from.

use std::collections::{HashMap, HashSet};
use std::fs::File;
use std::io::{BufRead, BufReader, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

use serde_json::Value;

use crate::parsers::claude;

/// What [`read_trail`] reports.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AgentTrail {
    /// The session's working directory as of its newest record.
    pub cwd: Option<String>,
    /// The newest pull request the agent opened (its web URL).
    pub created_pr: Option<String>,
}

/// Shell commands that open a pull (merge) request and print its URL.
const CREATE_COMMANDS: &[&str] = &[
    "gh pr create",
    "glab mr create",
    "tea pr create",
    "tea pulls create",
];
/// Tool names (MCP servers' included) that open one, lowercased.
const CREATE_TOOLS: &[&str] = &[
    "create_pull_request",
    "createpullrequest",
    "create_merge_request",
];
/// Where the number sits in a pull request URL: GitLab (`/-/merge_requests/`),
/// CNB (`/-/pulls/`), GitHub (`/pull/`), Gitea (`/pulls/`).
const PR_URL_MARKERS: &[&str] = &["/-/merge_requests/", "/-/pulls/", "/pull/", "/pulls/"];
/// Creation calls whose result has not been seen yet; a call never answered
/// (the session was killed) must not pile up.
const MAX_PENDING: usize = 32;
/// Conversations whose transcript position is remembered. Past this the map
/// is dropped and rebuilt — a rescan from the start, not a wrong answer.
const MAX_TRAILS: usize = 1024;

#[derive(Debug, Default)]
struct Trail {
    session_id: String,
    path: Option<PathBuf>,
    offset: u64,
    cwd: Option<String>,
    cwd_at: String,
    created_pr: Option<String>,
    created_pr_at: String,
    pending: HashSet<String>,
}

static TRAILS: LazyLock<Mutex<HashMap<i32, Trail>>> = LazyLock::new(Default::default);

/// The trail of conversation `conversation_id`, whose Claude session is
/// `session_id`, with its transcript under one of `roots` (the `projects`
/// directories of the agent's environment) — first looked for where a
/// session started in `folder_path` puts it. `None` when no transcript is
/// found. Blocking: file IO.
pub fn read_trail(
    conversation_id: i32,
    roots: &[PathBuf],
    session_id: &str,
    folder_path: &str,
) -> Option<AgentTrail> {
    let taken = TRAILS
        .lock()
        .ok()
        .and_then(|mut trails| trails.remove(&conversation_id));
    // A new session id (a `/clear` rollover) is a new transcript.
    let mut trail = match taken {
        Some(trail) if trail.session_id == session_id => trail,
        _ => Trail {
            session_id: session_id.to_string(),
            ..Trail::default()
        },
    };
    let path = match trail.path.clone().filter(|path| path.is_file()) {
        Some(path) => path,
        None => {
            let found = locate(roots, session_id, folder_path)?;
            if trail.path.as_ref() != Some(&found) {
                trail = Trail {
                    session_id: session_id.to_string(),
                    path: Some(found.clone()),
                    ..Trail::default()
                };
            }
            found
        }
    };
    // Unreadable this time: answer from what was read before.
    let _ = trail.read_from(&path);
    let answer = AgentTrail {
        cwd: trail.cwd.clone(),
        created_pr: trail.created_pr.clone(),
    };
    if let Ok(mut trails) = TRAILS.lock() {
        if trails.len() >= MAX_TRAILS {
            trails.clear();
        }
        trails.insert(conversation_id, trail);
    }
    Some(answer)
}

/// `<root>/<folder path with every non-alphanumeric as '-'>/<id>.jsonl` is
/// where Claude puts a session started in `folder_path`; anything else (a
/// path long enough for Claude to hash, a session resumed elsewhere) is found
/// by the parser's full scan.
fn locate(roots: &[PathBuf], session_id: &str, folder_path: &str) -> Option<PathBuf> {
    let safe_id = !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    let project: String = folder_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    if safe_id {
        let guessed = roots
            .iter()
            .map(|root| root.join(&project).join(format!("{session_id}.jsonl")))
            .find(|path| path.is_file());
        if guessed.is_some() {
            return guessed;
        }
    }
    claude::find_session_file_in_roots(roots, session_id)
}

impl Trail {
    fn read_from(&mut self, path: &Path) -> std::io::Result<()> {
        let mut file = File::open(path)?;
        let len = file.metadata()?.len();
        if len < self.offset {
            // Rewritten from scratch: start over.
            *self = Trail {
                session_id: std::mem::take(&mut self.session_id),
                path: self.path.take(),
                ..Trail::default()
            };
        }
        file.seek(SeekFrom::Start(self.offset))?;
        let mut reader = BufReader::new(file);
        let mut newest_cwd_line: Option<String> = None;
        // Within one read too: a first read of a compacted transcript has the
        // replayed records after the newer ones.
        let mut newest_cwd_at = self.cwd_at.clone();
        let mut line = String::new();
        loop {
            line.clear();
            let read = reader.read_line(&mut line)?;
            // A last line without its newline is still being written: leave it
            // for the next read.
            if read == 0 || !line.ends_with('\n') {
                break;
            }
            self.offset += read as u64;
            if self.feed(&line) {
                let at = record_timestamp(&line);
                if at >= newest_cwd_at.as_str() {
                    newest_cwd_at = at.to_string();
                    newest_cwd_line = Some(std::mem::take(&mut line));
                }
            }
        }
        if let Some(line) = newest_cwd_line {
            self.take_cwd(&line);
        }
        Ok(())
    }

    /// Look at one complete line. Returns whether it names the working
    /// directory; the caller parses only the newest such line, once.
    fn feed(&mut self, line: &str) -> bool {
        if line.contains("\"isSidechain\":true") {
            return false;
        }
        let creates = line.contains("\"tool_use\"")
            && (CREATE_COMMANDS.iter().any(|needle| line.contains(needle))
                || CREATE_TOOLS
                    .iter()
                    .any(|needle| line.to_ascii_lowercase().contains(needle)));
        if creates {
            self.note_create_calls(line);
        }
        if !self.pending.is_empty()
            && line.contains("\"tool_result\"")
            && self.pending.iter().any(|id| line.contains(id.as_str()))
        {
            self.take_create_results(line);
        }
        line.contains("\"cwd\"")
    }

    fn take_cwd(&mut self, line: &str) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let Some(cwd) = record.get("cwd").and_then(Value::as_str) else {
            return;
        };
        if cwd.is_empty() {
            return;
        }
        self.cwd = Some(cwd.to_string());
        self.cwd_at = record_timestamp(line).to_string();
    }

    fn note_create_calls(&mut self, line: &str) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        for block in content_blocks(&record) {
            if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                continue;
            }
            let Some(id) = block.get("id").and_then(Value::as_str) else {
                continue;
            };
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase();
            let command = block
                .get("input")
                .and_then(|input| input.get("command"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let creates = CREATE_TOOLS.iter().any(|tool| name.contains(tool))
                || CREATE_COMMANDS.iter().any(|cmd| command.contains(cmd));
            if creates && self.pending.len() < MAX_PENDING {
                self.pending.insert(id.to_string());
            }
        }
    }

    fn take_create_results(&mut self, line: &str) {
        let Ok(record) = serde_json::from_str::<Value>(line) else {
            return;
        };
        let at = record_timestamp(line);
        for block in content_blocks(&record) {
            if block.get("type").and_then(Value::as_str) != Some("tool_result") {
                continue;
            }
            let Some(id) = block.get("tool_use_id").and_then(Value::as_str) else {
                continue;
            };
            if !self.pending.remove(id) {
                continue;
            }
            let Some(url) = last_pr_url(&result_text(block)) else {
                continue;
            };
            if at >= self.created_pr_at.as_str() {
                self.created_pr = Some(url);
                self.created_pr_at = at.to_string();
            }
        }
    }
}

/// The record's `timestamp` without parsing the line; `""` when it has none.
/// Claude writes ISO-8601 UTC (`2026-11-14T12:14:10.075Z`), which orders as
/// text.
fn record_timestamp(line: &str) -> &str {
    const KEY: &str = "\"timestamp\":\"";
    let Some(start) = line.find(KEY).map(|i| i + KEY.len()) else {
        return "";
    };
    let rest = &line[start..];
    rest.find('"').map(|end| &rest[..end]).unwrap_or("")
}

fn content_blocks(record: &Value) -> impl Iterator<Item = &Value> {
    record
        .get("message")
        .and_then(|message| message.get("content"))
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
}

/// A tool result's text: a plain string, or the text blocks of a list.
fn result_text(block: &Value) -> String {
    match block.get("content") {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| part.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// The last pull request URL in `text` — `gh pr create` prints it last.
fn last_pr_url(text: &str) -> Option<String> {
    let mut found = None;
    let mut rest = text;
    while let Some(start) = rest.find("http") {
        let candidate = &rest[start..];
        let end = candidate
            .find(|c: char| c.is_whitespace() || "\"'<>()[]{}`\\".contains(c))
            .unwrap_or(candidate.len());
        let url = candidate[..end].trim_end_matches(['.', ',', ';', ':']);
        if parse_pr_url(url).is_some() {
            found = Some(url.to_string());
        }
        rest = &candidate[end.max(4)..];
    }
    found
}

/// A pull request URL taken apart.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PrUrl {
    pub host: String,
    /// The repository path as it appears in the URL (`owner/repo`,
    /// `group/sub/repo`).
    pub repo: String,
    pub number: i64,
}

pub fn parse_pr_url(url: &str) -> Option<PrUrl> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let (host, path) = rest.split_once('/')?;
    if host.is_empty() || host.contains('@') {
        return None;
    }
    let path = format!("/{path}");
    let (repo, tail) = PR_URL_MARKERS
        .iter()
        .find_map(|marker| path.split_once(marker))?;
    let digits = tail
        .split(['/', '#', '?'])
        .next()
        .filter(|digits| !digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))?;
    let repo = repo.trim_matches('/');
    if !repo.contains('/') {
        return None;
    }
    Some(PrUrl {
        host: host.to_ascii_lowercase(),
        repo: repo.to_string(),
        number: digits.parse().ok()?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn record(ts: &str, cwd: &str) -> String {
        format!(
            r#"{{"type":"user","cwd":"{cwd}","timestamp":"{ts}","message":{{"role":"user","content":"hi"}}}}"#
        )
    }

    fn create_call(ts: &str, id: &str) -> String {
        format!(
            r#"{{"type":"assistant","cwd":"/repo/wt","timestamp":"{ts}","message":{{"role":"assistant","content":[{{"type":"tool_use","id":"{id}","name":"Bash","input":{{"command":"git push -u origin feat && gh pr create --fill"}}}}]}}}}"#
        )
    }

    fn create_result(ts: &str, id: &str, url: &str) -> String {
        format!(
            r#"{{"type":"user","cwd":"/repo/wt","timestamp":"{ts}","message":{{"role":"user","content":[{{"type":"tool_result","tool_use_id":"{id}","content":"Creating pull request for feat into main\n\n{url}\n"}}]}}}}"#
        )
    }

    fn append(path: &Path, lines: &[String]) {
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .unwrap();
        for line in lines {
            writeln!(file, "{line}").unwrap();
        }
    }

    fn trail_for(path: &Path) -> Trail {
        Trail {
            session_id: "s".to_string(),
            path: Some(path.to_path_buf()),
            ..Trail::default()
        }
    }

    #[test]
    fn the_newest_cwd_and_the_opened_pull_request_are_read() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(
            &path,
            &[
                record("2026-11-14T10:00:00.000Z", "/repo"),
                record("2026-11-14T10:01:00.000Z", "/repo/.claude/worktrees/feat"),
                create_call("2026-11-14T10:02:00.000Z", "toolu_1"),
                create_result(
                    "2026-11-14T10:02:05.000Z",
                    "toolu_1",
                    "https://github.com/acme/app/pull/42",
                ),
            ],
        );
        let mut trail = trail_for(&path);
        trail.read_from(&path).unwrap();
        assert_eq!(trail.cwd.as_deref(), Some("/repo/wt"));
        assert_eq!(
            trail.created_pr.as_deref(),
            Some("https://github.com/acme/app/pull/42")
        );
        assert!(trail.pending.is_empty());

        // Later lines move the answer on; earlier ones are not read again.
        append(&path, &[record("2026-11-14T10:05:00.000Z", "/repo")]);
        trail.read_from(&path).unwrap();
        assert_eq!(trail.cwd.as_deref(), Some("/repo"));
        assert!(trail.created_pr.is_some());
    }

    #[test]
    fn replayed_records_do_not_move_the_answer_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(
            &path,
            &[
                create_call("2026-11-14T09:00:00.000Z", "toolu_old"),
                create_result(
                    "2026-11-14T09:00:05.000Z",
                    "toolu_old",
                    "https://github.com/acme/app/pull/7",
                ),
                create_call("2026-11-14T10:00:00.000Z", "toolu_new"),
                create_result(
                    "2026-11-14T10:00:05.000Z",
                    "toolu_new",
                    "https://github.com/acme/app/pull/8",
                ),
                record("2026-11-14T10:10:00.000Z", "/repo/wt-b"),
            ],
        );
        let mut trail = trail_for(&path);
        trail.read_from(&path).unwrap();
        // Compaction re-appends the old records.
        append(
            &path,
            &[
                record("2026-11-14T08:00:00.000Z", "/repo/wt-a"),
                create_call("2026-11-14T09:00:00.000Z", "toolu_old"),
                create_result(
                    "2026-11-14T09:00:05.000Z",
                    "toolu_old",
                    "https://github.com/acme/app/pull/7",
                ),
            ],
        );
        trail.read_from(&path).unwrap();
        assert_eq!(trail.cwd.as_deref(), Some("/repo/wt-b"));
        assert_eq!(
            trail.created_pr.as_deref(),
            Some("https://github.com/acme/app/pull/8")
        );
    }

    #[test]
    fn a_half_written_line_waits_and_sidechains_do_not_count() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(&path, &[record("2026-11-14T10:00:00.000Z", "/repo")]);
        let sidechain = record("2026-11-14T10:01:00.000Z", "/elsewhere")
            .replace("\"type\":\"user\"", "\"type\":\"user\",\"isSidechain\":true");
        append(&path, &[sidechain]);
        let partial = record("2026-11-14T10:02:00.000Z", "/repo/wt");
        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(&partial.as_bytes()[..20])
            .unwrap();
        let mut trail = trail_for(&path);
        trail.read_from(&path).unwrap();
        assert_eq!(trail.cwd.as_deref(), Some("/repo"));

        std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap()
            .write_all(format!("{}\n", &partial[20..]).as_bytes())
            .unwrap();
        trail.read_from(&path).unwrap();
        assert_eq!(trail.cwd.as_deref(), Some("/repo/wt"));
    }

    #[test]
    fn a_result_of_another_call_is_not_taken_for_a_new_pull_request() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.jsonl");
        append(
            &path,
            &[create_result(
                "2026-11-14T10:00:05.000Z",
                "toolu_view",
                "https://github.com/acme/app/pull/3",
            )],
        );
        let mut trail = trail_for(&path);
        trail.read_from(&path).unwrap();
        assert_eq!(trail.created_pr, None);
    }

    #[test]
    fn the_transcript_is_found_under_the_folders_project_dir() {
        let dir = tempfile::tempdir().unwrap();
        let roots = vec![dir.path().join("projects")];
        let project = roots[0].join("-home-me-work-app");
        std::fs::create_dir_all(&project).unwrap();
        let path = project.join("abc-123.jsonl");
        append(&path, &[record("2026-11-14T10:00:00.000Z", "/home/me/work/app")]);
        assert_eq!(locate(&roots, "abc-123", "/home/me/work/app"), Some(path.clone()));
        // Resumed from another folder: the full scan finds it.
        assert_eq!(locate(&roots, "abc-123", "/home/me/other"), Some(path));
        assert_eq!(locate(&roots, "../abc-123", "/home/me/work/app"), None);
    }

    #[test]
    fn pull_request_urls_of_each_forge_are_recognized() {
        assert_eq!(
            parse_pr_url("https://github.com/acme/app/pull/42"),
            Some(PrUrl {
                host: "github.com".to_string(),
                repo: "acme/app".to_string(),
                number: 42,
            })
        );
        assert_eq!(
            parse_pr_url("https://gitlab.example.com/group/sub/app/-/merge_requests/5")
                .map(|pr| (pr.repo, pr.number)),
            Some(("group/sub/app".to_string(), 5))
        );
        assert_eq!(
            parse_pr_url("https://gitea.example.com/acme/app/pulls/9#issuecomment-1")
                .map(|pr| pr.number),
            Some(9)
        );
        assert_eq!(parse_pr_url("https://github.com/acme/app/issues/42"), None);
        assert_eq!(parse_pr_url("https://github.com/acme/app/pull/new/feat"), None);
        assert_eq!(parse_pr_url("https://github.com/pull/42"), None);
    }

    #[test]
    fn the_last_url_of_a_result_wins() {
        let text = "Warning: 1 uncommitted change\nhttps://github.com/acme/app/pull/1 exists.\n\
                    https://github.com/acme/app/pull/2\n";
        assert_eq!(
            last_pr_url(text).as_deref(),
            Some("https://github.com/acme/app/pull/2")
        );
        assert_eq!(last_pr_url("remote: https://github.com/acme/app/pull/new/feat"), None);
    }
}
