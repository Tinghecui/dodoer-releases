//! jenny fork: read-only view of the Jenny Loops of one project folder, for the
//! folder's "Loop" conversation.
//!
//! Jenny (a separate local tool) keeps every Loop in `<folder>/loop docs/loopNN`
//! (`loop.json`, schema `jenny-loop/v2`, Jenny's `docs/loop-read-contract.md`).
//! A Loop runs in stages (prepare, impl, deploy, test, reflect), and each stage
//! is one or more ordinary agent sessions in the agent's own history store.
//! Nothing here writes: every state change goes through Jenny's own CLI.
//!
//! The stage ↔ session link is not stored in one place across Jenny's versions,
//! so it is rebuilt from what each store has:
//! * Codex: its `state_*.sqlite` holds each thread's name and first prompt.
//! * Claude: the first prompt in the project's transcript files.
//! * Grok: the first prompt in each session's `updates.jsonl`.
//! * Every framework: `loop.json` names the session of the running stage.
//!
//! Jenny writes the marker this reads into each stage prompt
//! (`src/loop/dispatch.mjs`, `src/loop/phase-context.mjs`). The older prompt
//! shapes stay recognized because their sessions are still on disk.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use chrono::{DateTime, Utc};
use regex::Regex;
use serde::Serialize;
use serde_json::Value;

use crate::models::agent::AgentType;
use crate::parsers::{claude, codex, grok, AgentEnv};

/// The folder inside a project that holds its Loops.
const LOOP_DOCS: &str = "loop docs";
/// The same limit Jenny's reader applies to one state file.
const MAX_RECORD_BYTES: u64 = 32 * 1024 * 1024;
/// Jenny reads at most this many Loop directories per project.
const MAX_LOOP_DIRS: usize = 400;
/// A runner writes its heartbeat every few seconds; past this it is gone.
const HEARTBEAT_FRESH: Duration = Duration::from_secs(180);
/// An older runner has no heartbeat file; a state write this recent counts.
const STATE_WRITE_FRESH: Duration = Duration::from_secs(300);
/// How long one folder's session index is reused between polls.
const INDEX_TTL: Duration = Duration::from_secs(15);
/// The nudge Jenny sends a native Goal stage. Codex stored it as the thread's
/// first message on such stages, in place of the stage prompt.
const STAGE_REMINDER: &str = "阶段预算已使用";
/// How much of a rollout's head to read for a stage prompt. The prompt follows
/// the injected instructions, which can be long.
const ROLLOUT_HEAD_LINES: usize = 40;
/// The first prompt is read from at most this many leading transcript lines.
const HEAD_LINES: usize = 60;
const MAX_EVIDENCE: usize = 8;
const MAX_POINTS: usize = 400;
/// `binding` sits right after a task graph's `spec`; graphs reach gigabytes, so
/// only the head of the file is read.
const GRAPH_HEAD_BYTES: u64 = 8 * 1024 * 1024;

/// What a Loop is doing right now, as far as the files can prove.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopRunState {
    Running,
    /// A person stopped it; the goal is not finished.
    Paused,
    /// No runner is alive, and nobody asked it to stop.
    Stopped,
    Blocked,
    Completed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LoopSessionRole {
    /// The stage's own agent.
    Stage,
    /// One node of a Loop v2 task graph.
    Node,
    /// A review session of a task graph node.
    Reflection,
    /// A helper the stage or node agent started.
    Subagent,
    /// The session that started the Loop.
    Launcher,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopSession {
    pub agent_type: AgentType,
    pub session_id: String,
    pub role: LoopSessionRole,
    /// Node id, helper nickname, or nothing for the stage's own agent.
    pub label: Option<String>,
    pub parent_session_id: Option<String>,
    pub started_at: Option<String>,
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopStage {
    /// Jenny's round id, such as `impl-03`.
    pub id: String,
    pub phase: String,
    /// The count Jenny names the stage with (`loop22impl03` → 3).
    pub number: Option<u64>,
    pub cycle: Option<u64>,
    /// `passed`, `failed`, … ; `None` until Jenny accepts the stage.
    pub result: Option<String>,
    pub summary: Option<String>,
    pub evidence: Vec<String>,
    pub started_at: Option<String>,
    pub completed_at: Option<String>,
    pub duration_minutes: Option<f64>,
    /// The stage the running Loop is in now.
    pub current: bool,
    pub sessions: Vec<LoopSession>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopExitCondition {
    pub id: String,
    pub label: String,
    pub done: bool,
    pub evidence: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopMetricPoint {
    pub at: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopMetric {
    pub id: String,
    pub label: String,
    pub unit: String,
    /// `at-least` / `at-most`, as Jenny writes it.
    pub goal: Option<String>,
    pub target: Option<f64>,
    pub value: Option<f64>,
    pub history: Vec<LoopMetricPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopEntry {
    pub id: String,
    pub title: String,
    /// False when only sessions are left and `loop.json` is gone.
    pub has_record: bool,
    pub status: String,
    pub phase: Option<String>,
    pub cycle: Option<u64>,
    pub test_round: Option<u64>,
    pub run_state: LoopRunState,
    pub framework: Option<String>,
    pub model: Option<String>,
    pub updated_at: Option<String>,
    pub summary: Option<String>,
    pub next_action: Option<String>,
    pub stage_started_at: Option<String>,
    pub stage_deadline_at: Option<String>,
    pub estimated_completion_at: Option<String>,
    pub remaining_cycles: Option<u64>,
    pub exit_conditions: Vec<LoopExitCondition>,
    pub metrics: Vec<LoopMetric>,
    /// What only a person can settle.
    pub human_intervention: Option<String>,
    pub requirement_challenge: Option<String>,
    pub stages: Vec<LoopStage>,
}

/// Everything the folder's Loop conversation shows. Oldest Loop first, as a
/// conversation reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopConversationDetail {
    pub folder_path: String,
    pub loops: Vec<LoopEntry>,
}

/// What the sidebar row needs. Built from the state files only, so it stays
/// cheap enough to run on a timer for every folder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FolderLoopSummary {
    pub title: String,
    /// `in_progress` / `pending_review` / `completed` / `cancelled`.
    pub status: &'static str,
    pub agent_type: AgentType,
    pub stage_count: u32,
    pub running: bool,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Reading one state file ───────────────────────────────────────────────────

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    path.iter()
        .try_fold(value, |v, key| v.get(*key))
        .and_then(Value::as_str)
}

fn string_at(value: &Value, path: &[&str]) -> Option<String> {
    str_at(value, path)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn u64_at(value: &Value, path: &[&str]) -> Option<u64> {
    path.iter()
        .try_fold(value, |v, key| v.get(*key))
        .and_then(Value::as_u64)
}

fn f64_at(value: &Value, key: &str) -> Option<f64> {
    value
        .get(key)
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite())
}

fn array_at<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or(&[])
}

fn parse_time(value: Option<&str>) -> Option<DateTime<Utc>> {
    value
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|t| t.with_timezone(&Utc))
}

fn evidence_of(value: &Value) -> Vec<String> {
    array_at(value, "evidence")
        .iter()
        .filter_map(Value::as_str)
        .take(MAX_EVIDENCE)
        .map(str::to_string)
        .collect()
}

fn read_small_json(path: &Path) -> Option<Value> {
    let meta = fs::symlink_metadata(path).ok()?;
    if !meta.is_file() || meta.len() > MAX_RECORD_BYTES {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// The parts of `loop.json` that never need the folder's sessions.
struct LoopRecord {
    id: String,
    /// `contextMeta.originalRequestSha256`: one Loop's identity across copies.
    identity: Option<String>,
    revision: u64,
    entry: LoopEntry,
    current_session: Option<String>,
    stage_counts: BTreeMap<String, u64>,
}

fn read_exit_conditions(state: &Value) -> Vec<LoopExitCondition> {
    array_at(state, "exitConditions")
        .iter()
        .filter_map(|item| {
            Some(LoopExitCondition {
                id: string_at(item, &["id"])?,
                label: string_at(item, &["label"]).unwrap_or_default(),
                done: item.get("done").and_then(Value::as_bool).unwrap_or(false),
                evidence: evidence_of(item),
            })
        })
        .collect()
}

fn read_metrics(state: &Value) -> Vec<LoopMetric> {
    array_at(state, "metrics")
        .iter()
        .filter_map(|item| {
            let history: Vec<LoopMetricPoint> = array_at(item, "history")
                .iter()
                .filter_map(|point| {
                    Some(LoopMetricPoint {
                        at: string_at(point, &["recordedAt"])?,
                        value: f64_at(point, "value")?,
                    })
                })
                .collect();
            let skip = history.len().saturating_sub(MAX_POINTS);
            Some(LoopMetric {
                id: string_at(item, &["id"])?,
                label: string_at(item, &["label"]).unwrap_or_default(),
                unit: string_at(item, &["unit"]).unwrap_or_default(),
                goal: string_at(item, &["goal"]),
                target: f64_at(item, "target"),
                value: f64_at(item, "value"),
                history: history.into_iter().skip(skip).collect(),
            })
        })
        .collect()
}

fn read_rounds(state: &Value) -> Vec<LoopStage> {
    array_at(state, "rounds")
        .iter()
        .filter_map(|round| {
            let id = string_at(round, &["id"])?;
            let phase = string_at(round, &["phase"])
                .or_else(|| id.split('-').next().map(str::to_string))?;
            Some(LoopStage {
                number: id.rsplit('-').next().and_then(|n| n.parse().ok()),
                id,
                phase,
                cycle: u64_at(round, &["cycle"]),
                result: string_at(round, &["result"]),
                summary: string_at(round, &["summary"]),
                evidence: evidence_of(round),
                started_at: string_at(round, &["startedAt"]),
                completed_at: string_at(round, &["completedAt"]),
                duration_minutes: f64_at(round, "durationMinutes"),
                current: false,
                sessions: Vec::new(),
            })
        })
        .collect()
}

/// Whether a runner is alive, the way Jenny's own status decides it: a person's
/// stop wins, then a fresh heartbeat. A dead pid alone never means "stopped by
/// a person".
fn run_state(state: &Value, loop_dir: &Path, now: DateTime<Utc>) -> LoopRunState {
    let status = str_at(state, &["status"]).unwrap_or("");
    if status == "completed" {
        return LoopRunState::Completed;
    }
    let runtime = loop_dir.join("runtime");
    let control = read_small_json(&runtime.join("direct-control.json"));
    let stopped = control
        .as_ref()
        .is_some_and(|c| str_at(c, &["desiredState"]) == Some("stopped"));
    if status == "stopped" || stopped {
        return LoopRunState::Paused;
    }
    let fresh = |at: Option<DateTime<Utc>>, window: Duration| {
        at.is_some_and(|t| (now - t).to_std().map(|age| age < window).unwrap_or(true))
    };
    let heartbeat = read_small_json(&runtime.join("direct-status.json")).filter(|s| {
        !matches!(
            str_at(s, &["status"]),
            Some("stopped" | "exited" | "completed")
        )
    });
    if heartbeat
        .as_ref()
        .is_some_and(|s| fresh(parse_time(str_at(s, &["heartbeatAt"])), HEARTBEAT_FRESH))
        || fresh(parse_time(str_at(state, &["updatedAt"])), STATE_WRITE_FRESH)
    {
        return LoopRunState::Running;
    }
    if status == "blocked" {
        LoopRunState::Blocked
    } else {
        LoopRunState::Stopped
    }
}

fn active_summary(state: &Value, key: &str) -> Option<String> {
    let item = state.get("attention")?.get(key)?;
    item.get("active")
        .and_then(Value::as_bool)
        .unwrap_or(false)
        .then(|| string_at(item, &["summary"]))
        .flatten()
}

fn framework_of(state: &Value) -> Option<String> {
    string_at(state, &["runtime", "framework"]).or_else(|| {
        // Before `runtime.framework` the engine named the same thing.
        str_at(state, &["runtime", "engine"]).and_then(|engine| {
            if engine.starts_with("claude") {
                Some("claude".to_string())
            } else if engine.starts_with("grok") {
                Some("grok".to_string())
            } else if engine.starts_with("codex") {
                Some("codex".to_string())
            } else {
                None
            }
        })
    })
}

fn read_record(loop_dir: &Path, now: DateTime<Utc>) -> Option<LoopRecord> {
    let state = read_small_json(&loop_dir.join("loop.json"))?;
    let id = string_at(&state, &["id"])
        .or_else(|| loop_dir.file_name()?.to_str().map(str::to_string))?;
    let run_state = run_state(&state, loop_dir, now);
    let stage_counts = state
        .get("stageCounts")
        .and_then(Value::as_object)
        .map(|counts| {
            counts
                .iter()
                .filter_map(|(k, v)| Some((k.clone(), v.as_u64()?)))
                .collect()
        })
        .unwrap_or_default();
    let entry = LoopEntry {
        id: id.clone(),
        title: string_at(&state, &["title"]).unwrap_or_else(|| id.clone()),
        has_record: true,
        status: string_at(&state, &["status"]).unwrap_or_else(|| "active".to_string()),
        phase: string_at(&state, &["phase"]),
        cycle: u64_at(&state, &["cycle"]),
        test_round: u64_at(&state, &["testRound"]),
        run_state,
        framework: framework_of(&state),
        model: string_at(&state, &["runtime", "model"]),
        updated_at: string_at(&state, &["updatedAt"]),
        summary: string_at(&state, &["summary"]),
        next_action: string_at(&state, &["nextAction"]),
        stage_started_at: string_at(&state, &["timing", "stageStartedAt"]),
        stage_deadline_at: string_at(&state, &["timing", "stageDeadlineAt"]),
        estimated_completion_at: string_at(&state, &["timing", "estimatedCompletionAt"]),
        remaining_cycles: u64_at(&state, &["timing", "remainingCycles"]),
        exit_conditions: read_exit_conditions(&state),
        metrics: read_metrics(&state),
        human_intervention: active_summary(&state, "humanIntervention"),
        requirement_challenge: active_summary(&state, "requirementChallenge"),
        stages: read_rounds(&state),
    };
    Some(LoopRecord {
        id,
        identity: string_at(&state, &["contextMeta", "originalRequestSha256"]),
        revision: u64_at(&state, &["revision"]).unwrap_or(0),
        entry,
        current_session: string_at(&state, &["runtime", "threadId"]),
        stage_counts,
    })
}

// ── Finding a folder's Loops ─────────────────────────────────────────────────

fn loop_dir_regex() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^loop\d+$").expect("loop dir regex"))
}

/// `loop07` → 7, for ordering: `loop100` comes after `loop99`.
fn loop_number(id: &str) -> u64 {
    id.trim_start_matches(|c: char| !c.is_ascii_digit())
        .parse()
        .unwrap_or(0)
}

/// The Loop directories under `folder`. A symlink is never followed: Jenny's
/// read contract refuses them so a record can't point outside its project.
fn loop_dirs(folder: &Path) -> Vec<PathBuf> {
    let docs = folder.join(LOOP_DOCS);
    if !fs::symlink_metadata(&docs).is_ok_and(|m| m.is_dir()) {
        return Vec::new();
    }
    let mut dirs: Vec<PathBuf> = fs::read_dir(&docs)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_ok_and(|t| t.is_dir()))
        .filter(|entry| {
            entry
                .file_name()
                .to_str()
                .is_some_and(|name| loop_dir_regex().is_match(name))
        })
        .map(|entry| entry.path())
        .take(MAX_LOOP_DIRS)
        .collect();
    dirs.sort_by_key(|dir| {
        dir.file_name()
            .and_then(|n| n.to_str())
            .map(loop_number)
            .unwrap_or(0)
    });
    dirs
}

/// The main checkout of a linked Git worktree. A worktree's `.git` is a file
/// holding `gitdir: <main>/.git/worktrees/<name>`.
fn main_checkout(folder: &Path) -> Option<PathBuf> {
    let git = folder.join(".git");
    if !fs::symlink_metadata(&git).ok()?.is_file() {
        return None;
    }
    let text = fs::read_to_string(git).ok()?;
    let gitdir = PathBuf::from(text.trim().strip_prefix("gitdir:")?.trim());
    let dot_git = gitdir.parent()?.parent()?;
    (dot_git.file_name()? == ".git").then(|| dot_git.parent().map(Path::to_path_buf))?
}

/// A worktree carries the Loop records its branch was cut with. Those are the
/// main checkout's Loops, not Loops started here, so one that is no further
/// along than the original is a copy.
fn is_worktree_copy(record: &LoopRecord, main: Option<&Path>, now: DateTime<Utc>) -> bool {
    if record.entry.run_state == LoopRunState::Running {
        return false;
    }
    let Some(main) = main else { return false };
    read_record(&main.join(LOOP_DOCS).join(&record.id), now).is_some_and(|original| {
        original.identity == record.identity && original.revision >= record.revision
    })
}

fn agent_type_of(framework: Option<&str>) -> AgentType {
    match framework {
        Some("claude") => AgentType::ClaudeCode,
        Some("grok") => AgentType::Grok,
        _ => AgentType::Codex,
    }
}

fn parse_loop_time(entry: &LoopEntry) -> Option<DateTime<Utc>> {
    parse_time(entry.updated_at.as_deref())
}

/// A throwaway copy of a project Jenny made for one attempt
/// (`<data>/attempts/<loop>/...`). Jenny's read contract keeps those off its
/// board as project roots, and they stay off the sidebar too.
pub(crate) fn is_jenny_attempt_workspace(folder: &Path) -> bool {
    let mut parts = folder.components().map(|c| c.as_os_str());
    parts.any(|c| c == "Jenny") && parts.any(|c| c == "attempts")
}

/// The row a folder's Loops add to the sidebar, or `None` when it has none. The
/// row names the running Loop, else the one touched last.
pub fn summarize_folder(folder: &Path, now: DateTime<Utc>) -> Option<FolderLoopSummary> {
    if is_jenny_attempt_workspace(folder) {
        return None;
    }
    let dirs = loop_dirs(folder);
    if dirs.is_empty() {
        return None;
    }
    let main = main_checkout(folder);
    let records: Vec<LoopRecord> = dirs
        .iter()
        .filter_map(|dir| read_record(dir, now))
        .filter(|record| !is_worktree_copy(record, main.as_deref(), now))
        .collect();
    let Some(latest) = records
        .iter()
        .filter(|r| r.entry.run_state == LoopRunState::Running)
        .max_by_key(|r| parse_loop_time(&r.entry))
        .or_else(|| records.iter().max_by_key(|r| parse_loop_time(&r.entry)))
    else {
        // Only stage folders are left. A worktree's are the main checkout's;
        // a main checkout's old sessions may still be on disk.
        if main.is_some() {
            return None;
        }
        let last = dirs.last()?.file_name()?.to_str()?.to_string();
        return Some(FolderLoopSummary {
            title: last,
            status: "cancelled",
            agent_type: AgentType::Codex,
            stage_count: 0,
            running: false,
            created_at: None,
            updated_at: None,
        });
    };
    let entry = &latest.entry;
    let status = match entry.run_state {
        LoopRunState::Completed => "completed",
        // Waiting on a person reads the same as a conversation waiting on one.
        _ if entry.human_intervention.is_some() => "pending_review",
        LoopRunState::Running => "in_progress",
        LoopRunState::Blocked => "pending_review",
        LoopRunState::Paused | LoopRunState::Stopped => "cancelled",
    };
    let title = match (&entry.phase, entry.run_state) {
        (Some(phase), LoopRunState::Running) => {
            format!("{} {}｜{}", entry.id, phase, entry.title)
        }
        _ => format!("{}｜{}", entry.id, entry.title),
    };
    Some(FolderLoopSummary {
        title,
        status,
        agent_type: agent_type_of(entry.framework.as_deref()),
        stage_count: records.iter().map(|r| r.entry.stages.len() as u32).sum(),
        running: entry.run_state == LoopRunState::Running,
        created_at: records
            .iter()
            .filter_map(|r| {
                r.entry
                    .stages
                    .first()
                    .and_then(|s| parse_time(s.started_at.as_deref()))
            })
            .min(),
        updated_at: parse_loop_time(entry),
    })
}

/// Every project folder Jenny has registered a Loop for, from its id registry
/// (`data/loop-ids`). A Loop started in a folder dodoer has never opened is
/// only known from here. Temporary test folders are left out.
pub fn registered_loop_folders(data_root: &Path) -> Vec<PathBuf> {
    let Some(ids) = data_root.parent().map(|d| d.join("loop-ids")) else {
        return Vec::new();
    };
    let temp = std::env::temp_dir();
    let mut folders: HashSet<PathBuf> = HashSet::new();
    for entry in fs::read_dir(ids)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        let Some(registry) = read_small_json(&entry.path()) else {
            continue;
        };
        for item in array_at(&registry, "loops") {
            let Some(dir) = str_at(item, &["directory"]) else {
                continue;
            };
            let dir = Path::new(dir);
            let Some(folder) = dir.parent().and_then(Path::parent) else {
                continue;
            };
            let is_temp = folder.starts_with(&temp)
                || folder.starts_with("/tmp")
                || folder.starts_with("/private/tmp")
                || folder.starts_with("/private/var/folders");
            if !is_temp && dir.is_dir() {
                folders.insert(folder.to_path_buf());
            }
        }
    }
    let mut folders: Vec<PathBuf> = folders.into_iter().collect();
    folders.sort();
    folders
}

// ── Which session belongs to which stage ─────────────────────────────────────

const PHASES: &str = "prepare|impl|deploy|test|reflect";

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct StageMarker {
    pub loop_id: String,
    pub phase: String,
    pub cycle: Option<u64>,
    pub number: Option<u64>,
}

fn name_marker(name: &str) -> Option<StageMarker> {
    static NAME: OnceLock<Regex> = OnceLock::new();
    static LAUNCHER: OnceLock<Regex> = OnceLock::new();
    let name = name.trim();
    let re = NAME.get_or_init(|| {
        Regex::new(&format!(r"^(loop\d+)({PHASES})(\d+)$")).expect("stage name regex")
    });
    if let Some(c) = re.captures(name) {
        return Some(StageMarker {
            loop_id: c[1].to_string(),
            phase: c[2].to_string(),
            cycle: None,
            number: c[3].parse().ok(),
        });
    }
    let re = LAUNCHER.get_or_init(|| Regex::new(r"^(loop\d+)launcher$").expect("launcher regex"));
    re.captures(name).map(|c| StageMarker {
        loop_id: c[1].to_string(),
        phase: "launcher".to_string(),
        cycle: None,
        number: None,
    })
}

/// The stage a session's first prompt (or thread name) says it runs. Covers
/// every prompt shape Jenny has written; anything else is not a stage session.
pub(crate) fn classify_session(name: Option<&str>, prompt: &str) -> Option<StageMarker> {
    static CURRENT: OnceLock<Regex> = OnceLock::new();
    static OBJECTIVE: OnceLock<Regex> = OnceLock::new();
    static DIRECT: OnceLock<Regex> = OnceLock::new();
    static DIRECT_CYCLE: OnceLock<Regex> = OnceLock::new();
    static NAMED: OnceLock<Regex> = OnceLock::new();
    let named = NAMED.get_or_init(|| {
        Regex::new(&format!(r"名称：(loop\d+(?:{PHASES})\d+)")).expect("named stage regex")
    });
    let number_in_prompt = || {
        named
            .captures(prompt)
            .and_then(|c| name_marker(&c[1]))
            .and_then(|m| m.number)
    };

    let re = CURRENT.get_or_init(|| {
        Regex::new(r"^\s*你正在执行 Jenny Loop (loop\d+) 的 (\w+) 阶段，第 (\d+) 个循环")
            .expect("stage prompt regex")
    });
    if let Some(c) = re.captures(prompt) {
        return Some(StageMarker {
            loop_id: c[1].to_string(),
            phase: c[2].to_string(),
            cycle: c[3].parse().ok(),
            number: number_in_prompt(),
        });
    }
    let re = OBJECTIVE.get_or_init(|| {
        Regex::new(r"^\s*完成 (loop\d+) 第 (\d+) 循环的 (\w+) 阶段").expect("objective regex")
    });
    if let Some(c) = re.captures(prompt) {
        return Some(StageMarker {
            loop_id: c[1].to_string(),
            phase: c[3].to_string(),
            cycle: c[2].parse().ok(),
            number: name.and_then(name_marker).and_then(|m| m.number),
        });
    }
    let re = DIRECT.get_or_init(|| {
        Regex::new(r"Loop：(loop\d+)，当前阶段：(\w+)").expect("direct prompt regex")
    });
    if prompt.trim_start().starts_with("你是当前任务的主 Agent") {
        if let Some(c) = re.captures(prompt) {
            let cycle = DIRECT_CYCLE
                .get_or_init(|| Regex::new(r"当前循环：(\d+)").expect("direct cycle regex"))
                .captures(prompt)
                .and_then(|c| c[1].parse().ok());
            return Some(StageMarker {
                loop_id: c[1].to_string(),
                phase: c[2].to_string(),
                cycle,
                number: name
                    .and_then(name_marker)
                    .and_then(|m| m.number)
                    .or_else(number_in_prompt),
            });
        }
    }
    name.and_then(name_marker)
}

/// A session's text that says it is a Loop session, for keeping those out of
/// the ordinary conversation list: they show inside the Loop conversation.
pub fn is_loop_session_title(title: &str) -> bool {
    let title = title.trim_start();
    title.starts_with("你是 Loop v2 的独立节点对话")
        || title.starts_with("你是 Loop v2 节点级独立反思对话")
        || title.starts_with(STAGE_REMINDER)
        || classify_session(Some(title), title).is_some()
}

#[derive(Debug, Clone)]
struct IndexedSession {
    agent_type: AgentType,
    id: String,
    role: LoopSessionRole,
    label: Option<String>,
    parent: Option<String>,
    marker: Option<StageMarker>,
    /// Task graph binding of a node session: the Loop directory, its stage.
    graph_stage: Option<GraphBinding>,
    started: Option<DateTime<Utc>>,
    updated: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct GraphBinding {
    loop_directory: String,
    loop_id: String,
    phase: String,
    stage: u64,
}

fn millis_time(ms: Option<i64>) -> Option<DateTime<Utc>> {
    ms.and_then(DateTime::<Utc>::from_timestamp_millis)
}

fn parse_graph_binding(head: &str) -> Option<GraphBinding> {
    let start = head.find("\"binding\":{")? + "\"binding\":".len();
    let end = start + head[start..].find('}')? + 1;
    let binding: Value = serde_json::from_str(&head[start..end]).ok()?;
    Some(GraphBinding {
        loop_directory: string_at(&binding, &["loopDirectory"])?,
        loop_id: string_at(&binding, &["loopId"])?,
        phase: string_at(&binding, &["phase"])?,
        stage: u64_at(&binding, &["stage"])?,
    })
}

/// A graph's binding, read once from the head of its file. It never changes.
fn graph_binding(graphs_root: &Path, graph_id: &str) -> Option<GraphBinding> {
    static CACHE: OnceLock<Mutex<HashMap<String, Option<GraphBinding>>>> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Some(known) = cache.lock().ok()?.get(graph_id) {
        return known.clone();
    }
    let mut head = Vec::new();
    fs::File::open(graphs_root.join(format!("{graph_id}.json")))
        .ok()?
        .take(GRAPH_HEAD_BYTES)
        .read_to_end(&mut head)
        .ok()?;
    let binding = parse_graph_binding(&String::from_utf8_lossy(&head));
    cache
        .lock()
        .ok()?
        .insert(graph_id.to_string(), binding.clone());
    binding
}

fn graph_ref(prompt: &str) -> Option<(String, Option<String>)> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"--id ([0-9a-f-]{36})(?: --node (\S+))?").expect("graph ref regex")
    });
    let c = re.captures(prompt)?;
    Some((c[1].to_string(), c.get(2).map(|m| m.as_str().to_string())))
}

fn newest_codex_state_db(home: &Path) -> Option<PathBuf> {
    fs::read_dir(home)
        .ok()?
        .filter_map(Result::ok)
        .map(|e| e.path())
        .filter(|p| {
            p.file_name()
                .and_then(|n| n.to_str())
                .is_some_and(|n| n.starts_with("state_") && n.ends_with(".sqlite"))
        })
        .max_by_key(|p| {
            p.file_stem()
                .and_then(|n| n.to_str())
                .and_then(|n| n.strip_prefix("state_"))
                .and_then(|n| n.parse::<u32>().ok())
                .unwrap_or(0)
        })
}

fn subagent_parent(source: &str) -> Option<String> {
    let value: Value = serde_json::from_str(source).ok()?;
    string_at(&value, &["subagent", "thread_spawn", "parent_thread_id"])
}

/// Stage, node and helper sessions of `folder` from Codex's own thread table.
/// That table is the only place with the first prompt of a compressed rollout.
/// Where a rollout is now. The table keeps the path it was first written at;
/// Codex may since have compressed or archived the file.
fn locate_rollout(home: &Path, stored: &str) -> Option<PathBuf> {
    let stored = Path::new(stored);
    let name = stored.file_name()?.to_str()?;
    let dirs = [
        stored.parent().map(Path::to_path_buf),
        Some(home.join("archived_sessions")),
    ];
    dirs.into_iter().flatten().find_map(|dir| {
        [name.to_string(), format!("{name}.zst")]
            .iter()
            .map(|file| dir.join(file))
            .find(|path| path.is_file())
    })
}

/// The stage a rollout's own opening messages say it runs.
fn rollout_marker(path: &Path) -> Option<StageMarker> {
    let file = fs::File::open(path).ok()?;
    let reader: Box<dyn BufRead> = if path.extension().is_some_and(|e| e == "zst") {
        Box::new(BufReader::new(zstd::stream::read::Decoder::new(file).ok()?))
    } else {
        Box::new(BufReader::new(file))
    };
    reader
        .lines()
        .take(ROLLOUT_HEAD_LINES)
        .map_while(Result::ok)
        .filter_map(|line| serde_json::from_str::<Value>(&line).ok())
        .filter(|line| {
            str_at(line, &["payload", "type"]) == Some("message")
                && str_at(line, &["payload", "role"]) == Some("user")
        })
        .find_map(|line| {
            line.get("payload")?
                .get("content")?
                .as_array()?
                .iter()
                .find_map(|item| classify_session(None, item.get("text")?.as_str()?))
        })
}

/// The folder and the workspaces its Loops last ran in. A Loop can run from a
/// linked worktree that has since been deleted; only its threads still say where.
fn codex_workspaces(
    conn: &rusqlite::Connection,
    folder: &str,
    current_sessions: &[String],
) -> rusqlite::Result<Vec<String>> {
    let mut cwds = vec![folder.to_string()];
    let mut stmt = conn.prepare("SELECT cwd FROM threads WHERE id = ?1")?;
    for id in current_sessions {
        let found = stmt
            .query_map([id], |row| row.get::<_, String>(0))?
            .filter_map(Result::ok);
        for cwd in found {
            if !cwds.contains(&cwd) {
                cwds.push(cwd);
            }
        }
    }
    Ok(cwds)
}

fn codex_sessions(
    home: &Path,
    folder: &str,
    current_sessions: &[String],
    graphs_root: Option<&Path>,
) -> rusqlite::Result<Vec<IndexedSession>> {
    use rusqlite::{Connection, OpenFlags};
    let Some(db) = newest_codex_state_db(home) else {
        return Ok(Vec::new());
    };
    let conn = Connection::open_with_flags(
        db,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    conn.busy_timeout(Duration::from_secs(2))?;

    let cwds = codex_workspaces(&conn, folder, current_sessions)?;
    let mut out: Vec<IndexedSession> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT id, name, title, substr(first_user_message, 1, 6000),
                COALESCE(created_at_ms, created_at * 1000),
                COALESCE(updated_at_ms, updated_at * 1000),
                thread_source, rollout_path
         FROM threads
         WHERE cwd = ?1 AND COALESCE(thread_source, '') != 'subagent'",
    )?;
    let mut rows = Vec::new();
    for cwd in &cwds {
        rows.extend(
            stmt.query_map([cwd], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                ))
            })?
            .filter_map(Result::ok),
        );
    }
    for (id, name, title, prompt, started, updated, source, rollout) in rows {
        let name = name.filter(|n| !n.is_empty()).or(Some(title));
        // A native Goal stage keeps its prompt only in the rollout; the table
        // holds nothing, or the reminder sent to it later.
        let prompt_is_elsewhere = source.as_deref() == Some("automation")
            && (prompt.is_empty() || prompt.starts_with(STAGE_REMINDER));
        let marker = classify_session(name.as_deref(), &prompt).or_else(|| {
            prompt_is_elsewhere
                .then(|| rollout_marker(&locate_rollout(home, &rollout)?))
                .flatten()
        });
        let Some(marker) = marker else {
            continue;
        };
        out.push(IndexedSession {
            agent_type: AgentType::Codex,
            id,
            role: if marker.phase == "launcher" {
                LoopSessionRole::Launcher
            } else {
                LoopSessionRole::Stage
            },
            label: None,
            parent: None,
            marker: Some(marker),
            graph_stage: None,
            started: millis_time(started),
            updated: millis_time(updated),
        });
    }

    // Node sessions run in their own workspace, so cwd can't find them; their
    // prompt names the graph, and the graph names its Loop.
    if let Some(graphs_root) = graphs_root {
        let mut stmt = conn.prepare(
            "SELECT id, substr(first_user_message, 1, 1500),
                    COALESCE(created_at_ms, created_at * 1000),
                    COALESCE(updated_at_ms, updated_at * 1000)
             FROM threads
             WHERE first_user_message LIKE '你是 Loop v2 %'",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<i64>>(2)?,
                row.get::<_, Option<i64>>(3)?,
            ))
        })?;
        let folder_docs = Path::new(folder).join(LOOP_DOCS);
        for row in rows.filter_map(Result::ok) {
            let (id, prompt, started, updated) = row;
            let Some((graph, node)) = graph_ref(&prompt) else {
                continue;
            };
            let Some(binding) = graph_binding(graphs_root, &graph) else {
                continue;
            };
            if !Path::new(&binding.loop_directory).starts_with(&folder_docs) {
                continue;
            }
            let reflection = prompt.starts_with("你是 Loop v2 节点级独立反思对话");
            out.push(IndexedSession {
                agent_type: AgentType::Codex,
                id,
                role: if reflection {
                    LoopSessionRole::Reflection
                } else {
                    LoopSessionRole::Node
                },
                label: node,
                parent: None,
                marker: None,
                graph_stage: Some(binding),
                started: millis_time(started),
                updated: millis_time(updated),
            });
        }
    }

    // Helpers, kept only under a session of this index, at any depth.
    let mut stmt = conn.prepare(
        "SELECT id, source, agent_nickname, substr(first_user_message, 1, 120),
                COALESCE(created_at_ms, created_at * 1000),
                COALESCE(updated_at_ms, updated_at * 1000)
         FROM threads
         WHERE cwd = ?1 AND thread_source = 'subagent'",
    )?;
    let mut rows = Vec::new();
    for cwd in &cwds {
        rows.extend(
            stmt.query_map([cwd], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, Option<i64>>(4)?,
                    row.get::<_, Option<i64>>(5)?,
                ))
            })?
            .filter_map(Result::ok),
        );
    }
    let mut helpers: Vec<IndexedSession> = rows
        .into_iter()
        .filter_map(|(id, source, nickname, prompt, started, updated)| {
            Some(IndexedSession {
                agent_type: AgentType::Codex,
                id,
                role: LoopSessionRole::Subagent,
                label: nickname
                    .filter(|n| !n.is_empty())
                    .or_else(|| (!prompt.is_empty()).then_some(prompt)),
                parent: Some(subagent_parent(&source)?),
                marker: None,
                graph_stage: None,
                started: millis_time(started),
                updated: millis_time(updated),
            })
        })
        .collect();
    let mut known: HashSet<String> = out.iter().map(|s| s.id.clone()).collect();
    loop {
        let (kept, rest): (Vec<_>, Vec<_>) = helpers
            .into_iter()
            .partition(|h| h.parent.as_ref().is_some_and(|p| known.contains(p)));
        if kept.is_empty() {
            break;
        }
        known.extend(kept.iter().map(|h| h.id.clone()));
        out.extend(kept);
        helpers = rest;
    }
    Ok(out)
}

/// The first user prompt and its time from a Claude transcript's head.
fn claude_first_prompt(path: &Path) -> Option<(String, Option<DateTime<Utc>>)> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().take(HEAD_LINES) {
        let Ok(line) = line else { continue };
        if !line.contains("\"user\"") {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        if str_at(&record, &["type"]) != Some("user") {
            continue;
        }
        let Some(content) = record.get("message").and_then(|m| m.get("content")) else {
            continue;
        };
        let text = match content {
            Value::String(text) => Some(text.clone()),
            Value::Array(parts) => parts
                .iter()
                .find_map(|p| str_at(p, &["text"]).map(str::to_string)),
            _ => None,
        };
        if let Some(text) = text {
            return Some((text, parse_time(str_at(&record, &["timestamp"]))));
        }
    }
    None
}

/// Claude names a project directory after its cwd with every other character
/// turned into `-`.
fn claude_project_dir_name(folder: &str) -> String {
    folder
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

type ClaudeHead = Option<(StageMarker, Option<DateTime<Utc>>)>;

fn claude_sessions(roots: &[PathBuf], folder: &str) -> Vec<IndexedSession> {
    // A transcript's head never changes, so each file is opened once.
    static HEADS: OnceLock<Mutex<HashMap<PathBuf, ClaudeHead>>> = OnceLock::new();
    let heads = HEADS.get_or_init(Default::default);
    let dir_name = claude_project_dir_name(folder);
    let mut out = Vec::new();
    for root in roots {
        let dir = root.join(&dir_name);
        for entry in fs::read_dir(&dir)
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
        {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(id) = path
                .file_stem()
                .and_then(|s| s.to_str())
                .map(str::to_string)
            else {
                continue;
            };
            let known = heads.lock().ok().and_then(|m| m.get(&path).cloned());
            let head = match known {
                Some(head) => head,
                None => {
                    let read = claude_first_prompt(&path).and_then(|(prompt, at)| {
                        classify_session(None, &prompt).map(|marker| (marker, at))
                    });
                    if let Ok(mut map) = heads.lock() {
                        map.insert(path.clone(), read.clone());
                    }
                    read
                }
            };
            let Some((marker, started)) = head else {
                continue;
            };
            let updated = entry
                .metadata()
                .ok()
                .and_then(|m| m.modified().ok())
                .map(DateTime::<Utc>::from);
            out.push(IndexedSession {
                agent_type: AgentType::ClaudeCode,
                id,
                role: LoopSessionRole::Stage,
                label: None,
                parent: None,
                marker: Some(marker),
                graph_stage: None,
                started,
                updated,
            });
        }
    }
    out
}

/// What a Grok session's first prompt says it is.
#[derive(Clone)]
enum GrokHead {
    Stage(StageMarker),
    Node { graph: String, node: Option<String> },
    Other,
}

/// The first prompt of a Grok session: its `updates.jsonl` starts with the
/// session's setup, then the user's message.
fn grok_first_prompt(path: &Path) -> Option<String> {
    let reader = BufReader::new(fs::File::open(path).ok()?);
    for line in reader.lines().take(HEAD_LINES) {
        let Ok(line) = line else { continue };
        if !line.contains("user_message_chunk") {
            continue;
        }
        let record: Value = serde_json::from_str(&line).ok()?;
        return string_at(&record, &["params", "update", "content", "text"]);
    }
    None
}

/// Grok keeps a directory per session under its percent-encoded cwd. Only this
/// folder's directories are read, each head once; a first prompt never changes.
fn grok_sessions(home: &Path, folder: &str, graphs_root: Option<&Path>) -> Vec<IndexedSession> {
    static HEADS: OnceLock<Mutex<HashMap<PathBuf, GrokHead>>> = OnceLock::new();
    let heads = HEADS.get_or_init(Default::default);
    let dir = home
        .join("sessions")
        .join(urlencoding::encode(folder).as_ref());
    let folder_docs = Path::new(folder).join(LOOP_DOCS);
    let mut out = Vec::new();
    for entry in fs::read_dir(dir)
        .into_iter()
        .flatten()
        .filter_map(Result::ok)
    {
        let updates = entry.path().join("updates.jsonl");
        let Some(id) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let known = heads.lock().ok().and_then(|m| m.get(&updates).cloned());
        let head = known.unwrap_or_else(|| {
            let prompt = grok_first_prompt(&updates).unwrap_or_default();
            let read = if prompt.starts_with("你是 Loop v2 ") {
                graph_ref(&prompt)
                    .map(|(graph, node)| GrokHead::Node { graph, node })
                    .unwrap_or(GrokHead::Other)
            } else {
                classify_session(None, &prompt)
                    .map(GrokHead::Stage)
                    .unwrap_or(GrokHead::Other)
            };
            if let Ok(mut map) = heads.lock() {
                map.insert(updates.clone(), read.clone());
            }
            read
        });
        let (role, label, marker, graph_stage) = match head {
            GrokHead::Other => continue,
            GrokHead::Stage(marker) => (LoopSessionRole::Stage, None, Some(marker), None),
            GrokHead::Node { graph, node } => {
                let Some(binding) = graphs_root.and_then(|root| graph_binding(root, &graph)) else {
                    continue;
                };
                if !Path::new(&binding.loop_directory).starts_with(&folder_docs) {
                    continue;
                }
                (LoopSessionRole::Node, node, None, Some(binding))
            }
        };
        let summary = read_small_json(&entry.path().join("summary.json"));
        let time = |key: &str| summary.as_ref().and_then(|s| parse_time(str_at(s, &[key])));
        out.push(IndexedSession {
            agent_type: AgentType::Grok,
            id,
            role,
            label,
            parent: None,
            marker,
            graph_stage,
            started: time("created_at"),
            updated: time("updated_at"),
        });
    }
    out
}

/// Where each framework keeps the history a folder's sessions are read from.
pub struct SessionStores {
    pub codex_env: AgentEnv,
    pub claude_env: AgentEnv,
    pub grok_env: AgentEnv,
    pub data_root: Option<PathBuf>,
}

fn session_index(
    folder: &str,
    current_sessions: &[String],
    stores: &SessionStores,
) -> Arc<Vec<IndexedSession>> {
    type IndexCache = Mutex<HashMap<String, (Instant, Arc<Vec<IndexedSession>>)>>;
    static CACHE: OnceLock<IndexCache> = OnceLock::new();
    let cache = CACHE.get_or_init(Default::default);
    if let Ok(map) = cache.lock() {
        if let Some((at, index)) = map.get(folder) {
            if at.elapsed() < INDEX_TTL {
                return Arc::clone(index);
            }
        }
    }
    let graphs_root = stores
        .data_root
        .as_deref()
        .and_then(Path::parent)
        .map(|d| d.join("loop-v2"));
    let mut sessions = codex_sessions(
        &codex::resolve_codex_home_dir_for_env(&stores.codex_env),
        folder,
        current_sessions,
        graphs_root.as_deref(),
    )
    .unwrap_or_else(|error| {
        tracing::warn!(%error, "[jenny-loop] Codex thread table unreadable");
        Vec::new()
    });
    sessions.extend(claude_sessions(
        &claude::resolve_claude_projects_dirs_for_env(&stores.claude_env),
        folder,
    ));
    sessions.extend(grok_sessions(
        &grok::resolve_grok_home_dir_for_env(&stores.grok_env),
        folder,
        graphs_root.as_deref(),
    ));
    let index = Arc::new(sessions);
    if let Ok(mut map) = cache.lock() {
        map.insert(folder.to_string(), (Instant::now(), Arc::clone(&index)));
    }
    index
}

// ── Building the conversation ────────────────────────────────────────────────

fn to_session(s: &IndexedSession) -> LoopSession {
    LoopSession {
        agent_type: s.agent_type,
        session_id: s.id.clone(),
        role: s.role,
        label: s.label.clone(),
        parent_session_id: s.parent.clone(),
        started_at: s.started.map(|t| t.to_rfc3339()),
        updated_at: s.updated.map(|t| t.to_rfc3339()),
    }
}

fn stage_id(phase: &str, number: u64) -> String {
    format!("{phase}-{number:02}")
}

fn stage_start(stage: &LoopStage) -> Option<DateTime<Utc>> {
    parse_time(stage.started_at.as_deref()).or_else(|| {
        stage
            .sessions
            .iter()
            .filter_map(|s| parse_time(s.started_at.as_deref()))
            .min()
    })
}

/// The stage a session belongs to when its name doesn't say: the same phase and
/// cycle, the attempt whose time span holds the session's start, or the nearest.
fn nearest_stage(
    stages: &[LoopStage],
    phase: Option<&str>,
    cycle: Option<u64>,
    started: Option<DateTime<Utc>>,
    updated: Option<DateTime<Utc>>,
) -> Option<usize> {
    let span = |stage: &LoopStage| {
        (
            parse_time(stage.started_at.as_deref()),
            parse_time(stage.completed_at.as_deref()),
        )
    };
    let candidates = || {
        stages.iter().enumerate().filter(|(_, stage)| {
            phase.is_none_or(|p| stage.phase == p) && cycle.is_none_or(|c| stage.cycle == Some(c))
        })
    };
    let Some(started) = started else {
        return candidates().map(|(i, _)| i).next_back();
    };
    // A session often starts moments before its stage is recorded, inside the
    // stage before. The stage it shares the most time with is the one it ran.
    if let Some(updated) = updated {
        let shared = candidates()
            .filter_map(|(i, stage)| {
                let (Some(from), Some(to)) = span(stage) else {
                    return None;
                };
                let seconds = (to.min(updated) - from.max(started)).num_seconds();
                (seconds > 0).then_some((i, seconds))
            })
            .max_by_key(|(_, seconds)| *seconds);
        if let Some((i, _)) = shared {
            return Some(i);
        }
    }
    if let Some((i, _)) = candidates().find(|(_, stage)| match span(stage) {
        (Some(from), Some(to)) => from <= started && started <= to,
        (Some(from), None) => from <= started,
        _ => false,
    }) {
        return Some(i);
    }
    // A phase-and-cycle match may be off by a retry; a bare time match is only
    // trusted inside a stage's span, above.
    phase?;
    candidates()
        .min_by_key(|(_, stage)| {
            span(stage)
                .0
                .map(|from| (from - started).num_seconds().abs())
                .unwrap_or(i64::MAX)
        })
        .map(|(i, _)| i)
}

/// A stage made up from its sessions: an attempt Jenny has not accepted yet, or
/// a Loop whose `loop.json` is gone.
fn synthetic_stage(marker: &StageMarker) -> LoopStage {
    let id = match (marker.number, marker.cycle) {
        (Some(number), _) => stage_id(&marker.phase, number),
        (None, Some(cycle)) => format!("{}-c{cycle}", marker.phase),
        (None, None) => marker.phase.clone(),
    };
    LoopStage {
        id,
        phase: marker.phase.clone(),
        number: marker.number,
        cycle: marker.cycle,
        result: None,
        summary: None,
        evidence: Vec::new(),
        started_at: None,
        completed_at: None,
        duration_minutes: None,
        current: false,
        sessions: Vec::new(),
    }
}

/// Adds the current stage of a live Loop: Jenny records a round only when the
/// stage ends.
fn push_current_stage(record: &LoopRecord, stages: &mut Vec<LoopStage>) {
    let entry = &record.entry;
    if entry.run_state == LoopRunState::Completed {
        return;
    }
    let Some(phase) = entry.phase.clone().filter(|p| p != "done") else {
        return;
    };
    let number = record.stage_counts.get(&phase).copied().unwrap_or(0) + 1;
    let id = stage_id(&phase, number);
    if stages.iter().any(|s| s.id == id) {
        return;
    }
    stages.push(LoopStage {
        id,
        phase,
        number: Some(number),
        cycle: entry.cycle,
        result: None,
        summary: None,
        evidence: Vec::new(),
        started_at: entry.stage_started_at.clone(),
        completed_at: None,
        duration_minutes: None,
        current: entry.run_state == LoopRunState::Running,
        sessions: Vec::new(),
    });
}

fn attach(stages: &mut Vec<LoopStage>, session: &IndexedSession) -> Option<usize> {
    let index = if let Some(binding) = &session.graph_stage {
        let id = stage_id(&binding.phase, binding.stage);
        stages.iter().position(|s| s.id == id).or_else(|| {
            nearest_stage(
                stages,
                Some(&binding.phase),
                None,
                session.started,
                session.updated,
            )
        })
    } else if let Some(marker) = &session.marker {
        let named = marker
            .number
            .map(|number| stage_id(&marker.phase, number))
            .and_then(|id| stages.iter().position(|s| s.id == id));
        match named.or_else(|| {
            marker
                .cycle
                .is_some()
                .then(|| {
                    nearest_stage(
                        stages,
                        Some(&marker.phase),
                        marker.cycle,
                        session.started,
                        session.updated,
                    )
                })
                .flatten()
        }) {
            Some(index) => Some(index),
            None => {
                let stage = synthetic_stage(marker);
                match stages.iter().position(|s| s.id == stage.id) {
                    Some(index) => Some(index),
                    None => {
                        stages.push(stage);
                        Some(stages.len() - 1)
                    }
                }
            }
        }
    } else {
        // `direct-sessions.json` knows only when a session was seen.
        nearest_stage(stages, None, None, session.started, session.updated)
    }?;
    let stage = &mut stages[index];
    if !stage
        .sessions
        .iter()
        .any(|s| s.session_id == session.id && s.agent_type == session.agent_type)
    {
        stage.sessions.push(to_session(session));
    }
    Some(index)
}

/// `runtime/direct-sessions.json`: the sessions a runner saw, with when. Fills
/// in a session whose store has no readable head.
fn direct_sessions(loop_dir: &Path, agent_type: AgentType) -> Vec<IndexedSession> {
    let Some(file) = read_small_json(&loop_dir.join("runtime/direct-sessions.json")) else {
        return Vec::new();
    };
    array_at(&file, "sessions")
        .iter()
        .filter_map(|item| {
            Some(IndexedSession {
                agent_type,
                id: string_at(item, &["sessionId"])?,
                role: LoopSessionRole::Stage,
                label: None,
                parent: None,
                marker: None,
                graph_stage: None,
                started: parse_time(str_at(item, &["firstSeenAt"])),
                updated: parse_time(str_at(item, &["lastSeenAt"])),
            })
        })
        .collect()
}

/// One session can run several stages in a row. A stage with no session of its
/// own shows the session whose time holds the whole stage.
fn share_spanning_sessions(stages: &mut [LoopStage]) {
    let spanning: Vec<LoopSession> = stages
        .iter()
        .flat_map(|stage| &stage.sessions)
        .filter(|s| s.role != LoopSessionRole::Subagent)
        .cloned()
        .collect();
    for stage in stages.iter_mut().filter(|s| s.sessions.is_empty()) {
        let (Some(from), Some(to)) = (
            parse_time(stage.started_at.as_deref()),
            parse_time(stage.completed_at.as_deref()),
        ) else {
            continue;
        };
        let holder = spanning.iter().find(|s| {
            parse_time(s.started_at.as_deref()).is_some_and(|at| at <= from)
                && parse_time(s.updated_at.as_deref()).is_some_and(|at| at >= to)
        });
        stage.sessions.extend(holder.cloned());
    }
}

fn sort_stages(stages: &mut [LoopStage]) {
    // Keep Jenny's order where times are missing: a stable sort by start, with
    // a stage without one left behind the stage before it.
    let mut last = None;
    let mut keyed: Vec<(Option<DateTime<Utc>>, LoopStage)> = stages
        .iter()
        .map(|stage| {
            let at = stage_start(stage).or(last);
            last = at;
            (at, stage.clone())
        })
        .collect();
    keyed.sort_by_key(|(at, _)| *at);
    for (slot, (_, stage)) in stages.iter_mut().zip(keyed) {
        *slot = stage;
    }
}

/// Puts `sessions` of one Loop on its stages. Helpers follow their parent.
fn assign_sessions(
    stages: &mut Vec<LoopStage>,
    sessions: &[&IndexedSession],
    extra: &[IndexedSession],
) {
    let mut where_is: HashMap<String, usize> = HashMap::new();
    let (helpers, own): (Vec<&&IndexedSession>, Vec<&&IndexedSession>) = sessions
        .iter()
        .partition(|s| s.role == LoopSessionRole::Subagent);
    for session in own {
        if let Some(index) = attach(stages, session) {
            where_is.insert(session.id.clone(), index);
        }
    }
    for session in extra {
        if where_is.contains_key(&session.id) {
            continue;
        }
        if let Some(index) = attach(stages, session) {
            where_is.insert(session.id.clone(), index);
        }
    }
    let mut helpers = helpers;
    helpers.sort_by_key(|s| s.started);
    // A helper of a helper comes after its parent in time, so one pass resolves
    // every depth.
    for session in helpers {
        let Some(index) = session
            .parent
            .as_ref()
            .and_then(|p| where_is.get(p))
            .copied()
        else {
            continue;
        };
        stages[index].sessions.push(to_session(session));
        where_is.insert(session.id.clone(), index);
    }
    share_spanning_sessions(stages);
    for stage in stages.iter_mut() {
        stage.sessions.sort_by_key(|s| {
            (
                s.role == LoopSessionRole::Subagent,
                parse_time(s.started_at.as_deref()),
            )
        });
    }
    sort_stages(stages);
}

fn session_loop_id(session: &IndexedSession) -> Option<&str> {
    session
        .marker
        .as_ref()
        .map(|m| m.loop_id.as_str())
        .or_else(|| session.graph_stage.as_ref().map(|b| b.loop_id.as_str()))
}

/// The folder's Loops with every session on its stage. Oldest Loop first.
pub fn read_conversation(
    folder: &Path,
    stores: &SessionStores,
    now: DateTime<Utc>,
) -> LoopConversationDetail {
    let folder_text = folder.to_string_lossy().into_owned();
    let dirs = loop_dirs(folder);
    let records: Vec<(PathBuf, LoopRecord)> = dirs
        .iter()
        .filter_map(|dir| Some((dir.clone(), read_record(dir, now)?)))
        .collect();
    let main = main_checkout(folder);
    // A copied record's session ran for the main checkout, not for this folder.
    let current_sessions: Vec<String> = records
        .iter()
        .filter(|(_, record)| !is_worktree_copy(record, main.as_deref(), now))
        .filter_map(|(_, record)| record.current_session.clone())
        .collect();
    let index = session_index(&folder_text, &current_sessions, stores);

    // Helpers carry no Loop id of their own; they go with their parent's Loop.
    let mut owner: HashMap<&str, &str> = HashMap::new();
    for session in index.iter() {
        if let Some(id) = session_loop_id(session) {
            owner.insert(session.id.as_str(), id);
        }
    }
    let mut by_loop: BTreeMap<String, Vec<&IndexedSession>> = BTreeMap::new();
    let mut helpers: Vec<&IndexedSession> = index
        .iter()
        .filter(|s| s.role == LoopSessionRole::Subagent)
        .collect();
    helpers.sort_by_key(|s| s.started);
    let mut helper_owner: HashMap<String, String> = HashMap::new();
    for helper in helpers {
        let Some(parent) = helper.parent.as_deref() else {
            continue;
        };
        let Some(loop_id) = owner
            .get(parent)
            .map(|id| id.to_string())
            .or_else(|| helper_owner.get(parent).cloned())
        else {
            continue;
        };
        helper_owner.insert(helper.id.clone(), loop_id.clone());
        by_loop.entry(loop_id).or_default().push(helper);
    }
    for session in index.iter() {
        if let Some(id) = session_loop_id(session) {
            by_loop.entry(id.to_string()).or_default().push(session);
        }
    }
    let mut loops: Vec<LoopEntry> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    for (dir, record) in &records {
        let sessions = by_loop.remove(&record.id).unwrap_or_default();
        seen.insert(record.id.clone());
        if sessions.is_empty() && is_worktree_copy(record, main.as_deref(), now) {
            continue;
        }
        let mut entry = record.entry.clone();
        let agent_type = agent_type_of(entry.framework.as_deref());
        push_current_stage(record, &mut entry.stages);
        let mut extra = direct_sessions(dir, agent_type);
        // `runtime.threadId` names the running stage's session the moment it
        // starts, ahead of any index.
        if let (Some(id), Some(current)) = (
            record.current_session.as_ref(),
            entry
                .stages
                .iter()
                .find(|s| s.current || s.result.is_none()),
        ) {
            extra.push(IndexedSession {
                agent_type,
                id: id.clone(),
                role: LoopSessionRole::Stage,
                label: None,
                parent: None,
                marker: Some(StageMarker {
                    loop_id: record.id.clone(),
                    phase: current.phase.clone(),
                    cycle: current.cycle,
                    number: current.number,
                }),
                graph_stage: None,
                started: parse_time(current.started_at.as_deref()),
                updated: None,
            });
        }
        assign_sessions(&mut entry.stages, &sessions, &extra);
        // A stage with neither a result nor a session and no live runner never
        // really began.
        entry
            .stages
            .retain(|s| s.current || s.result.is_some() || !s.sessions.is_empty());
        loops.push(entry);
    }
    for (id, sessions) in by_loop {
        if seen.contains(&id) || sessions.is_empty() {
            continue;
        }
        let mut stages = Vec::new();
        assign_sessions(&mut stages, &sessions, &[]);
        let updated_at = stages
            .iter()
            .flat_map(|s: &LoopStage| &s.sessions)
            .filter_map(|s| s.updated_at.clone())
            .max();
        loops.push(LoopEntry {
            title: id.clone(),
            id,
            has_record: false,
            status: "unknown".to_string(),
            phase: None,
            cycle: None,
            test_round: None,
            run_state: LoopRunState::Stopped,
            framework: None,
            model: None,
            updated_at,
            summary: None,
            next_action: None,
            stage_started_at: None,
            stage_deadline_at: None,
            estimated_completion_at: None,
            remaining_cycles: None,
            exit_conditions: Vec::new(),
            metrics: Vec::new(),
            human_intervention: None,
            requirement_challenge: None,
            stages,
        });
    }
    loops.sort_by_key(|l| loop_number(&l.id));
    LoopConversationDetail {
        folder_path: folder_text,
        loops,
    }
}

/// The directory of `loop_id` in `folder`, for a command sent to that Loop. The
/// id comes from the client, so only a plain `loopNN` directory qualifies.
pub fn loop_dir_for(folder: &Path, loop_id: &str) -> Option<PathBuf> {
    if !loop_dir_regex().is_match(loop_id) {
        return None;
    }
    let dir = folder.join(LOOP_DOCS).join(loop_id);
    fs::symlink_metadata(&dir)
        .is_ok_and(|m| m.is_dir())
        .then_some(dir)
}

/// Jenny's Loop command entry next to its data folder (`<jenny>/data/sessions`
/// → `<jenny>/scripts/loop-cli.mjs`), or where `JENNY_HOME` says.
pub fn loop_cli_path(data_root: Option<&Path>) -> Option<PathBuf> {
    let from_env = std::env::var_os("JENNY_HOME").map(PathBuf::from);
    let from_data = data_root
        .and_then(Path::parent)
        .and_then(Path::parent)
        .map(Path::to_path_buf);
    let home = dirs::home_dir().map(|h| h.join("Documents/jenny"));
    [from_env, from_data, home]
        .into_iter()
        .flatten()
        .map(|dir| dir.join("scripts/loop-cli.mjs"))
        .find(|path| path.is_file())
}

#[cfg(test)]
mod tests;
