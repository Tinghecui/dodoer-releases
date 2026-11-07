//! jenny fork: read-only view of one Jenny progress record, for the
//! conversation's "Jenny progress" tab in the right panel.
//!
//! Jenny (a separate local tool) keeps one `progress.json` per agent session,
//! written by its `progress-cli` and by its hooks. Schema `jenny-progress/v1`;
//! the source of truth is Jenny's `schemas/progress-v1.schema.json`. dodoer only
//! reads this file — every write goes through Jenny's own CLI, which takes its
//! file lock and checks the schema — so nothing here locks, repairs or rewrites
//! a record.
//!
//! A record says three things worth showing (Jenny's `docs/progress-protocol.md`):
//! how the latest turn ended, what only the user can do, and the key numbers of
//! a long task over time, the first one being the main chart. Older records also
//! hold task names, checklists and test rounds; they are not read any more.
//! Parsing is lenient on purpose: a record from an older Jenny may lack
//! `completion` (Jenny infers it on read).

use std::fs;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value;

use crate::app_error::AppCommandError;

/// The schema this reader understands. Any other version is not read.
pub const SCHEMA_VERSION: &str = "jenny-progress/v1";
/// Jenny refuses to read a record above this size; so does dodoer.
const MAX_RECORD_BYTES: u64 = 4 * 1024 * 1024;
/// Points per curve handed to the view, newest kept.
const MAX_POINTS: usize = 400;

/// Whether the agent has registered the end of the session's latest turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Registration {
    /// The registered end belongs to the latest turn.
    Current,
    /// A newer turn is still running and has not registered yet.
    Pending,
    /// A newer turn stopped without registering its end.
    Missed,
    /// No agent ever wrote this record; only Jenny's hooks or a script did.
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JennyMetricPoint {
    pub at: String,
    pub value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JennyMetric {
    pub id: String,
    pub label: String,
    pub value: f64,
    pub unit: String,
    /// `None` for an open-ended metric.
    pub target: Option<f64>,
    pub history: Vec<JennyMetricPoint>,
}

/// Everything the tab shows for one record.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JennyProgressDetail {
    pub session_id: String,
    /// `pending` / `active` / `blocked` / `completed` / `failed`.
    pub task_status: String,
    /// `open` / `completed` / `blocked`.
    pub completion_state: String,
    pub registration: Registration,
    pub updated_at: String,
    /// What only the user can do; the agent keeps working on the rest.
    pub human_summary: Option<String>,
    pub challenge_summary: Option<String>,
    /// The first one is the main chart.
    pub metrics: Vec<JennyMetric>,
    pub revision: u64,
}

/// Where Jenny keeps its sessions: `JENNY_DATA_ROOT` when set (Jenny's own
/// override, also what its services run with), else the source checkout's
/// `data/sessions` that the global rules' `progress-cli` writes to, else the
/// installed app's data folder. The first that exists wins.
pub fn data_root() -> Option<PathBuf> {
    let home = dirs::home_dir().unwrap_or_default();
    let candidates = [
        std::env::var_os("JENNY_DATA_ROOT").map(PathBuf::from),
        Some(home.join("Documents/jenny/data/sessions")),
        Some(home.join("Library/Application Support/Jenny/data/sessions")),
    ];
    candidates.into_iter().flatten().find(|p| p.is_dir())
}

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

fn bool_at(value: &Value, path: &[&str]) -> bool {
    path.iter()
        .try_fold(value, |v, key| v.get(*key))
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

/// The end state a record without `completion` has, the same way Jenny's
/// `normalizeCompletion` infers it from the task status.
fn completion_state(record: &Value) -> String {
    if let Some(state) = str_at(record, &["completion", "state"]) {
        return state.to_string();
    }
    match str_at(record, &["task", "status"]) {
        Some("completed") => "completed",
        Some("blocked") => "blocked",
        _ => "open",
    }
    .to_string()
}

fn registration(record: &Value) -> Registration {
    // An older record may have no agent-written completion yet still be the
    // agent's: it wrote the task.
    let by_agent = |path: &[&str]| str_at(record, path) == Some("agent");
    if !by_agent(&["completion", "source"]) && !by_agent(&["task", "source"]) {
        return Registration::None;
    }
    let registered = str_at(record, &["completion", "turnId"]);
    let latest = str_at(record, &["activity", "lastTurnId"]);
    match (registered, latest) {
        (Some(done), Some(now)) if done != now => {
            if str_at(record, &["activity", "lifecycle"]) == Some("active") {
                Registration::Pending
            } else {
                Registration::Missed
            }
        }
        _ => Registration::Current,
    }
}

fn is_finite_metric(metric: &Value) -> Option<f64> {
    (str_at(metric, &["limit", "mode"]) == Some("finite"))
        .then(|| metric.get("limit").and_then(|l| l.get("target")))
        .flatten()
        .and_then(Value::as_f64)
}

fn newest<T>(mut items: Vec<T>) -> Vec<T> {
    items.drain(..items.len().saturating_sub(MAX_POINTS));
    items
}

/// The detail view for a parsed record, or `None` when it is not a v1 record.
pub fn detail(record: &Value) -> Option<JennyProgressDetail> {
    if str_at(record, &["schemaVersion"]) != Some(SCHEMA_VERSION) {
        return None;
    }
    let session_id = string_at(record, &["session", "id"])?;
    let updated_at = string_at(record, &["activity", "updatedAt"])?;
    let metrics = array_at(record, "metrics")
        .iter()
        .filter_map(|m| {
            let history = array_at(m, "history")
                .iter()
                .filter_map(|p| {
                    Some(JennyMetricPoint {
                        at: string_at(p, &["recordedAt"])
                            .filter(|t| parse_time(Some(t)).is_some())?,
                        value: p.get("value")?.as_f64()?,
                    })
                })
                .collect();
            Some(JennyMetric {
                id: string_at(m, &["id"]).unwrap_or_default(),
                label: string_at(m, &["label"]).unwrap_or_default(),
                value: m.get("value")?.as_f64()?,
                unit: string_at(m, &["unit"]).unwrap_or_default(),
                target: is_finite_metric(m),
                history: newest(history),
            })
        })
        .collect();
    Some(JennyProgressDetail {
        task_status: string_at(record, &["task", "status"]).unwrap_or_else(|| "pending".into()),
        completion_state: completion_state(record),
        registration: registration(record),
        human_summary: bool_at(record, &["humanIntervention", "required"])
            .then(|| string_at(record, &["humanIntervention", "summary"]))
            .flatten(),
        challenge_summary: bool_at(record, &["requirementChallenge", "active"])
            .then(|| string_at(record, &["requirementChallenge", "summary"]))
            .flatten(),
        metrics,
        revision: record.get("revision").and_then(Value::as_u64).unwrap_or(0),
        session_id,
        updated_at,
    })
}

fn read_json(path: &Path, max_bytes: u64) -> Option<Value> {
    let meta = fs::metadata(path).ok()?;
    if !meta.is_file() || meta.len() > max_bytes {
        return None;
    }
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

/// Jenny names each session folder by its session id; the same rule keeps a
/// caller-supplied id from walking out of the sessions folder.
fn valid_session_id(id: &str) -> bool {
    let mut chars = id.chars();
    id.len() <= 256
        && chars.next().is_some_and(|c| c.is_ascii_alphanumeric())
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// One record's detail, or a not-found error naming the session.
pub fn read_detail(root: &Path, session_id: &str) -> Result<JennyProgressDetail, AppCommandError> {
    if !valid_session_id(session_id) {
        return Err(AppCommandError::invalid_input(format!(
            "Jenny session id is not valid: {session_id}"
        )));
    }
    let path = root.join(session_id).join("progress.json");
    read_json(&path, MAX_RECORD_BYTES)
        .and_then(|record| detail(&record))
        .ok_or_else(|| {
            AppCommandError::not_found(format!(
                "No readable Jenny progress record at {}",
                path.display()
            ))
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record(id: &str) -> Value {
        json!({
            "schemaVersion": "jenny-progress/v1",
            "revision": 3,
            "session": { "id": id, "provider": "claude", "cwd": "/w/codeg",
                "projectName": "codeg", "startedAt": "2026-11-01T10:00:00+08:00", "endedAt": null },
            "task": { "title": "等待任务信息", "summary": "x", "status": "active",
                "source": "agent", "startedAt": "2026-11-01T10:00:00+08:00", "completedAt": null },
            "checklist": [],
            "metrics": [
                { "id": "cov", "label": "Coverage", "value": 80, "unit": "%",
                  "limit": { "mode": "finite", "target": 90 }, "xAxis": "time", "source": "agent",
                  "history": [{ "value": 70, "recordedAt": "2026-11-01T10:00:00+08:00", "iteration": null, "summary": "x" },
                              { "value": 80, "recordedAt": "2026-11-01T11:00:00+08:00", "iteration": null, "summary": "y" }] },
                { "id": "open", "label": "Rows", "value": 5, "unit": "rows",
                  "limit": { "mode": "open" }, "xAxis": "time", "source": "script",
                  "history": [{ "value": 5, "recordedAt": "2026-11-01T10:00:00+08:00", "iteration": null, "summary": "z" }] }
            ],
            "iteration": { "enabled": false, "currentRound": 0, "rounds": [] },
            "humanIntervention": { "required": false, "summary": null, "updatedAt": null },
            "requirementChallenge": { "active": false, "summary": null, "updatedAt": null },
            "activity": { "lifecycle": "idle", "lastEvent": "AgentUpdate", "lastTurnId": "t1",
                "updatedAt": "2026-11-01T11:45:00+08:00" },
            "completion": { "turnId": "t1", "state": "open", "source": "agent",
                "summary": null, "updatedAt": "2026-11-01T11:45:00+08:00", "inferred": false }
        })
    }

    #[test]
    fn detail_keeps_the_numbers_in_order_with_their_times() {
        let d = detail(&record("s1")).unwrap();
        assert_eq!(d.metrics.len(), 2);
        assert_eq!(d.metrics[0].id, "cov", "the first number is the main chart");
        assert_eq!(d.metrics[0].target, Some(90.0));
        assert_eq!(
            d.metrics[0]
                .history
                .iter()
                .map(|p| p.value)
                .collect::<Vec<_>>(),
            vec![70.0, 80.0]
        );
        assert_eq!(d.metrics[0].history[1].at, "2026-11-01T11:00:00+08:00");
        assert_eq!(d.metrics[1].target, None, "an open metric has no target");
        assert_eq!(
            d.human_summary, None,
            "a cleared call for the user is not shown"
        );
    }

    #[test]
    fn detail_shows_what_only_the_user_can_do() {
        let mut r = record("s1");
        r["humanIntervention"] = json!({ "required": true, "summary": "Log in",
            "updatedAt": "2026-11-01T11:00:00+08:00" });
        assert_eq!(detail(&r).unwrap().human_summary.as_deref(), Some("Log in"));
    }

    #[test]
    fn an_older_record_with_checklist_and_tests_still_reads() {
        let mut r = record("s1");
        r["task"]["title"] = json!("Add panel");
        r["checklist"] = json!([{ "id": "a", "label": "A", "done": true, "source": "agent",
            "updatedAt": "2026-11-01T10:00:00+08:00", "evidenceSummary": "ok" }]);
        r["iteration"] = json!({ "enabled": true, "currentRound": 1, "rounds": [
            { "round": 1, "testedAt": "2026-11-01T10:30:00+08:00", "passed": false, "summary": "2 failed" }] });
        r["eta"] =
            json!({ "estimatedCompletionAt": "2026-11-01T11:00:00+08:00", "extensions": [] });
        let d = detail(&r).unwrap();
        assert_eq!(d.metrics.len(), 2);
        assert_eq!(d.completion_state, "open");
    }

    #[test]
    fn a_bad_point_is_skipped_and_only_the_newest_points_are_kept() {
        let mut r = record("s1");
        r["metrics"][0]["history"] = json!([
            { "value": 1, "recordedAt": "not a time" },
            { "value": 2, "recordedAt": "2026-11-01T10:00:00+08:00" }]);
        assert_eq!(detail(&r).unwrap().metrics[0].history.len(), 1);
        let many: Vec<Value> = (0..MAX_POINTS + 5)
            .map(|i| json!({ "value": i, "recordedAt": "2026-11-01T10:00:00+08:00" }))
            .collect();
        r["metrics"][0]["history"] = json!(many);
        let d = detail(&r).unwrap();
        assert_eq!(d.metrics[0].history.len(), MAX_POINTS);
        assert_eq!(d.metrics[0].history[0].value, 5.0);
    }

    #[test]
    fn registration_follows_the_latest_turn() {
        let mut r = record("s1");
        assert_eq!(registration(&r), Registration::Current);
        r["activity"]["lastTurnId"] = json!("t2");
        r["activity"]["lifecycle"] = json!("active");
        assert_eq!(registration(&r), Registration::Pending);
        r["activity"]["lifecycle"] = json!("idle");
        assert_eq!(registration(&r), Registration::Missed);
    }

    #[test]
    fn only_a_record_no_agent_touched_counts_as_unregistered() {
        let mut r = record("s1");
        r["completion"]["source"] = json!("script");
        assert_eq!(
            registration(&r),
            Registration::Current,
            "an agent wrote the task, so this is not an unregistered record"
        );
        r["task"]["source"] = json!("script");
        assert_eq!(registration(&r), Registration::None);
    }

    #[test]
    fn a_record_without_completion_is_inferred_like_jenny() {
        let mut r = record("s1");
        r.as_object_mut().unwrap().remove("completion");
        r["task"]["status"] = json!("blocked");
        let d = detail(&r).unwrap();
        assert_eq!(d.completion_state, "blocked");
        assert_eq!(
            d.registration,
            Registration::Current,
            "an agent wrote the task"
        );
        r["task"]["source"] = json!("script");
        assert_eq!(detail(&r).unwrap().registration, Registration::None);
    }

    #[test]
    fn other_schema_versions_are_skipped() {
        let mut r = record("s1");
        r["schemaVersion"] = json!("jenny-session-state.v1");
        assert!(detail(&r).is_none());
    }

    #[test]
    fn read_detail_reads_the_record_of_that_session() {
        let dir = tempfile::tempdir().unwrap();
        let folder = dir.path().join("s1");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("progress.json"), record("s1").to_string()).unwrap();
        assert_eq!(read_detail(dir.path(), "s1").unwrap().session_id, "s1");
    }

    #[test]
    fn detail_rejects_ids_that_leave_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let err = read_detail(dir.path(), "../etc").unwrap_err();
        assert!(err.to_string().contains("not valid"));
        assert!(read_detail(dir.path(), "missing").is_err());
    }
}
