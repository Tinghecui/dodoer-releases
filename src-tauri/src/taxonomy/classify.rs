//! Jev places a conversation on its project's mind map as soon as its first
//! prompt has gone out. It only picks among the categories the last nightly
//! plan left; the tree itself never changes during the day.
//!
//! Jev is the user's TypeSafe judge, run through its skill script
//! (`~/.agents/skills/jev/scripts/jev.py call`, request on stdin, one JSON
//! line out). `CODEG_TAXONOMY_CLASSIFIER` replaces it with another program
//! that speaks the same JSON (tests use a stub), or turns it off with `off`.

use std::process::Stdio;
use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use sea_orm::{DatabaseConnection, EntityTrait};
use serde_json::{json, Value};
use tokio::io::AsyncWriteExt;
use tokio::sync::Semaphore;

use super::model::{self, Assignment, Source, Taxonomy, UNCLASSIFIED};
use super::service::{self, TaxonomyError};
use super::store;
use crate::db::entities::conversation::{self, ConversationKind};
use crate::web::event_bridge::EventEmitter;

pub const CLASSIFIER_ENV: &str = "CODEG_TAXONOMY_CLASSIFIER";
/// Only a conversation this young is new: a prompt to an older one is a
/// resumed session, not a start.
const NEW_CONVERSATION_WINDOW: chrono::TimeDelta = chrono::TimeDelta::minutes(30);
/// Jev's own HTTP timeout is 45 s; this covers the interpreter around it.
const CLASSIFIER_TIMEOUT: Duration = Duration::from_secs(60);
/// Below this, Jev's pick is a guess: the conversation waits for the night.
pub const MIN_CONFIDENCE: f64 = 0.5;
/// How much of the first prompt Jev reads.
const PROMPT_CHARS: usize = 2000;
const QUESTION: &str = "category";

/// One call at a time: the script serializes on a file lock anyway, and a
/// burst of new conversations should queue, not fork a crowd of interpreters.
static ONE_AT_A_TIME: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(1));

/// The program that answers, with its arguments; `None` when there is none.
pub fn classifier() -> Option<(String, Vec<String>)> {
    match std::env::var(CLASSIFIER_ENV) {
        Ok(value) => {
            let value = value.trim();
            if value.is_empty() || matches!(value, "off" | "0" | "false" | "none") {
                None
            } else {
                Some((value.to_string(), Vec::new()))
            }
        }
        Err(_) => {
            let script = dirs::home_dir()?.join(".agents/skills/jev/scripts/jev.py");
            script.is_file().then(|| {
                (
                    "python3".to_string(),
                    vec![script.to_string_lossy().into_owned(), "call".to_string()],
                )
            })
        }
    }
}

/// The text of a prompt's text blocks, as Jev reads it.
pub fn prompt_text<'a>(texts: impl IntoIterator<Item = &'a str>) -> Option<String> {
    let joined = texts
        .into_iter()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    (!joined.is_empty()).then(|| joined.chars().take(PROMPT_CHARS).collect())
}

/// Jev's `choice` question: one label per category (its id), described by
/// its path and rule, plus a way out.
pub fn build_request(t: &Taxonomy, project: &str, title: Option<&str>, prompt: &str) -> Value {
    let mut criteria = serde_json::Map::new();
    for c in &t.categories {
        criteria.insert(
            c.id.clone(),
            Value::String(format!("{}: {}", t.path_name(c), c.rule)),
        );
    }
    criteria.insert(
        UNCLASSIFIED.to_string(),
        Value::String("None of the other categories clearly fits this message.".to_string()),
    );
    let mut state = format!("Project: {project}\n");
    if let Some(title) = title.map(str::trim).filter(|t| !t.is_empty()) {
        state.push_str(&format!("Conversation title: {title}\n"));
    }
    state.push_str("First message from the user:\n");
    state.push_str(prompt);
    json!({
        "state": state,
        "questions": {
            QUESTION: {
                "type": "choice",
                "instructions": format!(
                    "This is the first message a user sent to an AI coding agent in the project \"{project}\". \
                     Choose the category whose rule best describes what the conversation is about. \
                     Choose \"{UNCLASSIFIED}\" when no rule clearly fits."
                ),
                "criteria": criteria,
            }
        }
    })
}

#[derive(Debug, Clone, PartialEq)]
pub struct Verdict {
    /// A category of `t`, or `None` for "unclassified" / a label it does not
    /// know.
    pub category_id: Option<String>,
    pub confidence: f64,
}

/// Read the script's output line.
pub fn read_verdict(t: &Taxonomy, stdout: &str) -> Result<Verdict, String> {
    let line = stdout
        .lines()
        .rev()
        .find(|l| !l.trim().is_empty())
        .ok_or("the classifier printed nothing")?;
    let v: Value =
        serde_json::from_str(line).map_err(|e| format!("the classifier printed no JSON: {e}"))?;
    if v.get("ok").and_then(Value::as_bool) != Some(true) {
        let why = v
            .get("error")
            .or_else(|| v.get("outcome"))
            .map(Value::to_string)
            .unwrap_or_else(|| "no reason given".to_string());
        return Err(format!("the classifier failed: {why}"));
    }
    let answer = &v["response"]["answers"][QUESTION];
    let choice = answer["choice"]
        .as_str()
        .ok_or("the classifier's answer has no choice")?;
    let confidence = answer["confidence"].as_f64().unwrap_or(0.0);
    Ok(Verdict {
        category_id: t.category(choice).map(|c| c.id.clone()),
        confidence,
    })
}

async fn run_classifier(program: &str, args: &[String], request: &Value) -> Result<String, String> {
    let mut command = crate::process::tokio_command(program);
    command
        .args(args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    let mut child = command
        .spawn()
        .map_err(|e| format!("cannot start {program}: {e}"))?;
    let body = serde_json::to_vec(request).map_err(|e| e.to_string())?;
    let mut stdin = child.stdin.take().ok_or("no stdin")?;
    stdin
        .write_all(&body)
        .await
        .map_err(|e| format!("cannot write the request: {e}"))?;
    drop(stdin);
    let output = tokio::time::timeout(CLASSIFIER_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| format!("no answer within {}s", CLASSIFIER_TIMEOUT.as_secs()))?
        .map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if !output.status.success() && stdout.trim().is_empty() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "exited with {}: {}",
            output.status,
            stderr.trim().chars().take(300).collect::<String>()
        ));
    }
    Ok(stdout)
}

/// What became of one conversation.
#[derive(Debug, Clone, PartialEq)]
pub enum Outcome {
    /// A sub-session, loop row, chat, or gone.
    NotPlaceable,
    /// Older than [`NEW_CONVERSATION_WINDOW`]: a resumed session.
    NotNew,
    AlreadyPlaced,
    /// The project has no mind map yet; the prompt is kept for the night.
    NoCategories,
    NoClassifier,
    Placed(String),
    /// Jev chose nothing, or not confidently.
    Unsure,
    Failed(String),
}

/// Place `conversation_id` from its first prompt. See the module docs.
pub async fn classify_first_prompt(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    conversation_id: i32,
    prompt: &str,
    now: DateTime<Utc>,
) -> Result<Outcome, TaxonomyError> {
    let Some(row) = conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?
    else {
        return Ok(Outcome::NotPlaceable);
    };
    if row.deleted_at.is_some() || row.parent_id.is_some() || row.kind != ConversationKind::Regular
    {
        return Ok(Outcome::NotPlaceable);
    }
    if now - row.created_at > NEW_CONVERSATION_WINDOW {
        return Ok(Outcome::NotNew);
    }
    let root = match service::root_of_folder(conn, row.folder_id).await {
        Ok(root) => root,
        Err(TaxonomyError::NotAProject(_)) | Err(TaxonomyError::FolderNotFound(_)) => {
            return Ok(Outcome::NotPlaceable)
        }
        Err(e) => return Err(e),
    };

    let request = {
        let _guard = store::lock(root.id).await;
        let mut t = store::load(conn, root.id).await?;
        if t.placement(conversation_id).is_some() || t.removed_by_hand(conversation_id) {
            return Ok(Outcome::AlreadyPlaced);
        }
        // A prompt kept by an earlier try is the real first one; this call
        // may carry a later prompt to the same (still young) conversation.
        let material = match t.prompts.get(&conversation_id) {
            Some(first) => first.clone(),
            None => {
                // Not a visible change: no revision bump, no broadcast.
                t.prompts
                    .insert(conversation_id, model::prompt_excerpt(prompt));
                store::save(conn, root.id, &t).await?;
                prompt.to_string()
            }
        };
        if t.categories.is_empty() {
            return Ok(Outcome::NoCategories);
        }
        build_request(&t, &service::display_name(&root), row.title.as_deref(), &material)
    };

    let Some((program, args)) = classifier() else {
        return Ok(Outcome::NoClassifier);
    };
    let stdout = {
        // Never closed, so never an error.
        let _turn = ONE_AT_A_TIME.acquire().await.ok();
        match run_classifier(&program, &args, &request).await {
            Ok(out) => out,
            Err(e) => return Ok(Outcome::Failed(e)),
        }
    };

    let _guard = store::lock(root.id).await;
    let mut t = store::load(conn, root.id).await?;
    let verdict = match read_verdict(&t, &stdout) {
        Ok(v) => v,
        Err(e) => return Ok(Outcome::Failed(e)),
    };
    let Some(category_id) = verdict.category_id.filter(|_| verdict.confidence >= MIN_CONFIDENCE)
    else {
        return Ok(Outcome::Unsure);
    };
    // Placed or taken out meanwhile (by hand, or a nightly plan): theirs
    // stands.
    if t.placement(conversation_id).is_some() || t.removed_by_hand(conversation_id) {
        return Ok(Outcome::AlreadyPlaced);
    }
    t.assignments.insert(
        conversation_id,
        Assignment {
            category_id: Some(category_id.clone()),
            source: Source::Jev,
            confidence: Some(verdict.confidence),
            assigned_at: Utc::now(),
        },
    );
    t.version = 1;
    t.revision += 1;
    store::save(conn, root.id, &t).await?;
    store::emit_changed(emitter, root.id, t.revision);
    Ok(Outcome::Placed(category_id))
}

/// Fire-and-forget [`classify_first_prompt`] for the prompt path: never
/// delays the prompt, never fails it.
pub fn spawn_first_prompt(
    conn: DatabaseConnection,
    emitter: EventEmitter,
    conversation_id: i32,
    prompt: String,
) {
    tokio::spawn(async move {
        match classify_first_prompt(&conn, &emitter, conversation_id, &prompt, Utc::now()).await {
            Ok(Outcome::Failed(why)) => tracing::warn!(
                conversation_id,
                %why,
                "[taxonomy] Jev could not place the conversation"
            ),
            Ok(outcome) => tracing::debug!(conversation_id, ?outcome, "[taxonomy] first prompt"),
            Err(e) => tracing::warn!(conversation_id, error = %e, "[taxonomy] first prompt"),
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::conversation_service;
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use crate::taxonomy::model::Category;
    use crate::web::event_bridge::WebEventBroadcaster;
    use sea_orm::{ActiveModelTrait, IntoActiveModel, Set};
    use std::sync::Arc;

    fn taxonomy() -> Taxonomy {
        Taxonomy {
            categories: vec![
                Category {
                    id: "ui".into(),
                    parent_id: None,
                    name: "界面".into(),
                    rule: "Frontend and UI work".into(),
                },
                Category {
                    id: "ui-css".into(),
                    parent_id: Some("ui".into()),
                    name: "样式".into(),
                    rule: "CSS and theming".into(),
                },
            ],
            ..Default::default()
        }
    }

    #[test]
    fn the_request_lists_every_category_and_a_way_out() {
        let req = build_request(&taxonomy(), "app", Some("Fix colors"), "make the button blue");
        let criteria = &req["questions"]["category"]["criteria"];
        assert_eq!(criteria["ui"], "界面: Frontend and UI work");
        assert_eq!(criteria["ui-css"], "界面 / 样式: CSS and theming");
        assert!(criteria[UNCLASSIFIED].is_string());
        assert_eq!(req["questions"]["category"]["type"], "choice");
        let state = req["state"].as_str().unwrap();
        assert!(state.contains("Project: app"));
        assert!(state.contains("Conversation title: Fix colors"));
        assert!(state.ends_with("make the button blue"));
        // Only the keys the jev script accepts.
        let mut keys: Vec<_> = req.as_object().unwrap().keys().cloned().collect();
        keys.sort();
        assert_eq!(keys, vec!["questions".to_string(), "state".to_string()]);
    }

    #[test]
    fn verdicts_are_read_from_the_script_output() {
        let t = taxonomy();
        let ok = r#"{"ok": true, "response": {"answers": {"category": {"type": "choice", "choice": "ui-css", "confidence": 0.82, "probabilities": {"ui-css": 0.82}}}}}"#;
        assert_eq!(
            read_verdict(&t, &format!("noise\n{ok}\n")).unwrap(),
            Verdict {
                category_id: Some("ui-css".into()),
                confidence: 0.82
            }
        );
        let none = r#"{"ok": true, "response": {"answers": {"category": {"choice": "unclassified", "confidence": 0.9}}}}"#;
        assert_eq!(read_verdict(&t, none).unwrap().category_id, None);
        let failed = r#"{"ok": false, "error": "no_usable_keys"}"#;
        assert!(read_verdict(&t, failed).unwrap_err().contains("no_usable_keys"));
        assert!(read_verdict(&t, "").is_err());
        assert!(read_verdict(&t, "not json").is_err());
    }

    #[test]
    fn prompt_text_joins_blocks_and_caps() {
        assert_eq!(prompt_text(["  a ", "", "b"]).as_deref(), Some("a\nb"));
        assert_eq!(prompt_text(["  "]), None);
        let long = "x".repeat(PROMPT_CHARS + 5);
        assert_eq!(prompt_text([long.as_str()]).unwrap().len(), PROMPT_CHARS);
    }

    /// A stand-in for jev.py: answers `ui-css` with the given confidence.
    fn stub(dir: &std::path::Path, confidence: f64) -> String {
        let path = dir.join(format!("jev-stub-{confidence}.sh"));
        std::fs::write(
            &path,
            format!(
                "#!/bin/sh\ncat > \"{}/request.json\"\necho '{{\"ok\": true, \"response\": {{\"answers\": {{\"category\": {{\"choice\": \"ui-css\", \"confidence\": {confidence}}}}}}}}}'\n",
                dir.display()
            ),
        )
        .unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        path.to_string_lossy().into_owned()
    }

    async fn classify_with(
        classifier: &str,
        db: &crate::db::AppDatabase,
        emitter: &EventEmitter,
        conversation_id: i32,
        prompt: &str,
        now: DateTime<Utc>,
    ) -> Outcome {
        temp_env::async_with_vars([(CLASSIFIER_ENV, Some(classifier))], async {
            classify_first_prompt(&db.conn, emitter, conversation_id, prompt, now)
                .await
                .unwrap()
        })
        .await
    }

    #[tokio::test]
    async fn the_first_prompt_is_kept_and_placed() {
        let dir = tempfile::tempdir().unwrap();
        let db = test_helpers::fresh_in_memory_db().await;
        let root = test_helpers::seed_folder(&db, "/p/app").await;
        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let sure = stub(dir.path(), 0.9);
        let new_conversation = |title: &'static str| {
            let conn = db.conn.clone();
            async move {
                conversation_service::create(&conn, root, AgentType::Codex, Some(title.into()), None)
                    .await
                    .unwrap()
                    .id
            }
        };

        // No mind map yet: the prompt is kept for the night, nothing placed.
        let a = new_conversation("first").await;
        assert_eq!(
            classify_with(&sure, &db, &emitter, a, "build the   login page", Utc::now()).await,
            Outcome::NoCategories
        );
        let t = store::load(&db.conn, root).await.unwrap();
        assert_eq!(t.prompts[&a], "build the login page");
        assert_eq!(t.revision, 0);
        assert!(rx.try_recv().is_err());

        // With a mind map, Jev places it and every client hears.
        let mut t = taxonomy();
        t.revision = 3;
        store::save(&db.conn, root, &t).await.unwrap();
        let b = new_conversation("second").await;
        assert_eq!(
            classify_with(&sure, &db, &emitter, b, "make the header teal", Utc::now()).await,
            Outcome::Placed("ui-css".into())
        );
        let t = store::load(&db.conn, root).await.unwrap();
        assert_eq!(t.assignments[&b].source, Source::Jev);
        assert_eq!(t.assignments[&b].confidence, Some(0.9));
        assert_eq!(t.revision, 4);
        let evt = rx.try_recv().expect("placing broadcasts");
        assert_eq!((*evt.payload)["revision"], 4);
        let sent: Value =
            serde_json::from_str(&std::fs::read_to_string(dir.path().join("request.json")).unwrap())
                .unwrap();
        assert!(sent["state"].as_str().unwrap().contains("make the header teal"));

        // Twice is a no-op.
        assert_eq!(
            classify_with(&sure, &db, &emitter, b, "again", Utc::now()).await,
            Outcome::AlreadyPlaced
        );

        // Taken out by hand: Jev leaves it out.
        let f = new_conversation("taken out").await;
        service::assign_manual(&db.conn, &emitter, f, None).await.unwrap();
        assert_eq!(
            classify_with(&sure, &db, &emitter, f, "make it teal", Utc::now()).await,
            Outcome::AlreadyPlaced
        );
        assert!(store::load(&db.conn, root).await.unwrap().removed_by_hand(f));

        // A resumed old conversation is not a start.
        let later = Utc::now() + chrono::TimeDelta::hours(2);
        let c = new_conversation("third").await;
        assert_eq!(
            classify_with(&sure, &db, &emitter, c, "resume", later).await,
            Outcome::NotNew
        );

        // A low-confidence pick waits for the night.
        let unsure = stub(dir.path(), 0.2);
        assert_eq!(
            classify_with(&unsure, &db, &emitter, c, "hmm", Utc::now()).await,
            Outcome::Unsure
        );

        // A classifier that is not there fails softly.
        let missing = dir.path().join("missing").to_string_lossy().into_owned();
        let d = new_conversation("fourth").await;
        assert!(matches!(
            classify_with(&missing, &db, &emitter, d, "x", Utc::now()).await,
            Outcome::Failed(_)
        ));

        // Turned off.
        let e = new_conversation("fifth").await;
        assert_eq!(
            classify_with("off", &db, &emitter, e, "x", Utc::now()).await,
            Outcome::NoClassifier
        );

        // Sub-sessions are never placed.
        let child = conversation_service::create(&db.conn, root, AgentType::Codex, None, None)
            .await
            .unwrap();
        let mut active = child.into_active_model();
        active.parent_id = Set(Some(b));
        let child = active.update(&db.conn).await.unwrap();
        assert_eq!(
            classify_with(&sure, &db, &emitter, child.id, "x", Utc::now()).await,
            Outcome::NotPlaceable
        );
    }
}
