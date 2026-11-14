//! Cowork fork: a conversation the user renames in codeg is renamed in the
//! agent too, so `claude --resume`, the agent's own session list and anything
//! else reading Claude Code's sessions show the name the user picked, not the
//! one the agent generated (a renamed row used to be unfindable from there).
//!
//! Only a user rename comes here (`update_conversation_title`, the Tauri
//! command and the web handler); titles codeg derives itself never do.
//!
//! Claude Code only. A rename is written the way the CLI's own `/rename`
//! writes it, so every reader already understands it:
//!
//! * a `custom-title` and an `agent-name` record appended to the session's
//!   transcript. The SDK takes the last `custom-title` in the transcript's
//!   tail as the session's name (`acp::registry`, (qqq) of the Claude Code
//!   entry), and `parsers::claude` prefers it to an `ai-title` too;
//! * the `<session id>/custom-title.json` sidecar beside the transcript
//!   (`{"customTitle": …}`), which the SDK reads when the tail has no
//!   `custom-title` record.
//!
//! Writing while the CLI runs is safe. Before the CLI re-appends its session
//! metadata (on compaction and exit) it re-reads the transcript's last
//! `custom-title` record into memory (`planReAppendSessionMetadata`, CLI
//! 2.1.x), so it carries our name forward rather than writing an older one
//! back over it.
//!
//! claude-agent-acp 0.105.0 serves `session/set_title`, which writes the same
//! records. It is not used: it needs a running adapter of that version, and a
//! rename must also reach a session no connection has open.
//!
//! Best effort: a failed write is logged and the rename in codeg stands.

use std::fs::{self, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use sea_orm::DatabaseConnection;

use crate::db::service::{agent_setting_service, conversation_service};
use crate::models::AgentType;
use crate::parsers::claude;

/// Send the conversation's (just stored) title to its agent session.
pub async fn sync_conversation_title_to_agent(conn: &DatabaseConnection, conversation_id: i32) {
    let Ok(conv) = conversation_service::get_by_id(conn, conversation_id).await else {
        return;
    };
    if !matches!(conv.agent_type, AgentType::ClaudeCode) {
        return;
    }
    let (Some(session_id), Some(title)) = (conv.external_id, conv.title) else {
        return;
    };
    let title = title.trim().to_string();
    if title.is_empty() {
        return;
    }
    // The agent's own environment: a `CLAUDE_CONFIG_DIR` in its settings
    // (ccr's `~/.claudr`, say) moves the transcripts.
    let env = agent_setting_service::load_agent_env(conn, AgentType::ClaudeCode).await;
    let roots = claude::resolve_claude_projects_dirs_for_env(&env);
    let id = session_id.clone();
    let written =
        tokio::task::spawn_blocking(move || rename_claude_session(&roots, &id, &title)).await;
    match written {
        Ok(Ok(true)) => tracing::info!(
            conversation_id,
            %session_id,
            "agent title sync: renamed Claude session"
        ),
        Ok(Ok(false)) => tracing::debug!(
            conversation_id,
            %session_id,
            "agent title sync: no Claude transcript for this session; nothing renamed"
        ),
        Ok(Err(error)) => tracing::warn!(
            conversation_id,
            %session_id,
            %error,
            "agent title sync: writing the Claude session's title failed"
        ),
        Err(error) => tracing::warn!(conversation_id, %error, "agent title sync: task failed"),
    }
}

/// Rename the Claude session `session_id` found under any of `roots` (the
/// `projects` directories). `Ok(false)` when no root has its transcript.
fn rename_claude_session(
    roots: &[PathBuf],
    session_id: &str,
    title: &str,
) -> std::io::Result<bool> {
    // `find_session_file_in` rejects ids shaped like a path.
    let Some(transcript) = roots
        .iter()
        .find_map(|dir| claude::find_session_file_in(dir, session_id))
    else {
        return Ok(false);
    };
    append_title_records(&transcript, session_id, title)?;
    write_title_sidecar(&transcript, session_id, title)?;
    Ok(true)
}

/// Append the two records `/rename` appends, in one write.
fn append_title_records(transcript: &Path, session_id: &str, title: &str) -> std::io::Result<()> {
    let custom = serde_json::json!({
        "type": "custom-title",
        "customTitle": title,
        "sessionId": session_id,
    });
    let agent_name = serde_json::json!({
        "type": "agent-name",
        "agentName": title,
        "sessionId": session_id,
    });
    let mut file = OpenOptions::new().read(true).append(true).open(transcript)?;
    // A transcript whose last line has no newline would glue our record onto it.
    let mut out = String::new();
    if file.seek(SeekFrom::End(0))? > 0 {
        file.seek(SeekFrom::End(-1))?;
        let mut last = [0u8; 1];
        file.read_exact(&mut last)?;
        if last[0] != b'\n' {
            out.push('\n');
        }
    }
    out.push_str(&format!("{custom}\n{agent_name}\n"));
    file.write_all(out.as_bytes())
}

/// Replace `<session id>/custom-title.json` beside the transcript, through a
/// temporary file so a reader never sees half of it.
fn write_title_sidecar(transcript: &Path, session_id: &str, title: &str) -> std::io::Result<()> {
    let Some(project_dir) = transcript.parent() else {
        return Ok(());
    };
    let dir = project_dir.join(session_id);
    fs::create_dir_all(&dir)?;
    let body = serde_json::json!({ "customTitle": title }).to_string();
    let tmp = dir.join(format!("custom-title.json.tmp.{}", std::process::id()));
    fs::write(&tmp, body)?;
    fs::rename(&tmp, dir.join("custom-title.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsers::claude::ClaudeParser;
    use crate::parsers::AgentParser;

    const SESSION: &str = "5f3f81fe-3eca-446f-ab19-390d2b1b0448";

    /// `projects/<project>/<SESSION>.jsonl` holding `body`.
    fn transcript(body: &str) -> (tempfile::TempDir, PathBuf, PathBuf) {
        let root = tempfile::tempdir().expect("tempdir");
        let projects = root.path().join("projects");
        let project = projects.join("-home-me-work");
        fs::create_dir_all(&project).expect("mkdir");
        let path = project.join(format!("{SESSION}.jsonl"));
        fs::write(&path, body).expect("write transcript");
        (root, projects, path)
    }

    fn records(path: &Path) -> Vec<serde_json::Value> {
        fs::read_to_string(path)
            .expect("read transcript")
            .lines()
            .map(|line| serde_json::from_str(line).expect("every line is JSON"))
            .collect()
    }

    const PROMPT: &str = r#"{"type":"user","sessionId":"5f3f81fe-3eca-446f-ab19-390d2b1b0448","timestamp":"2026-11-14T10:00:00.000Z","message":{"role":"user","content":"hi"}}"#;
    const AI_TITLE: &str = r#"{"type":"ai-title","aiTitle":"Dodoer原生仓库新提交分析","sessionId":"5f3f81fe-3eca-446f-ab19-390d2b1b0448"}"#;

    #[test]
    fn rename_appends_the_records_rename_writes_and_the_sidecar() {
        let (_root, projects, path) = transcript(&format!("{PROMPT}\n{AI_TITLE}\n"));

        assert!(rename_claude_session(&[projects], SESSION, "遥测增加").expect("rename"));

        let all = records(&path);
        assert_eq!(all.len(), 4, "the two old lines and two new ones");
        assert_eq!(
            all[2],
            serde_json::json!({"type": "custom-title", "customTitle": "遥测增加", "sessionId": SESSION})
        );
        assert_eq!(
            all[3],
            serde_json::json!({"type": "agent-name", "agentName": "遥测增加", "sessionId": SESSION})
        );
        let sidecar = path.parent().unwrap().join(SESSION).join("custom-title.json");
        let sidecar: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(sidecar).expect("sidecar")).expect("json");
        assert_eq!(sidecar, serde_json::json!({"customTitle": "遥测增加"}));
    }

    #[test]
    fn codegs_own_claude_reader_takes_the_new_name_over_the_ai_title() {
        let (_root, projects, _path) = transcript(&format!("{PROMPT}\n{AI_TITLE}\n"));
        let roots = std::slice::from_ref(&projects);
        rename_claude_session(roots, SESSION, "first").expect("rename");
        rename_claude_session(roots, SESSION, "遥测增加").expect("rename again");

        let listed = ClaudeParser::with_base_dir(projects)
            .list_conversations()
            .expect("list");
        let row = listed.iter().find(|c| c.id == SESSION).expect("listed");
        assert_eq!(row.title.as_deref(), Some("遥测增加"), "the last rename wins");
    }

    #[test]
    fn a_last_line_without_newline_is_not_glued_to() {
        let (_root, projects, path) = transcript(PROMPT);

        rename_claude_session(&[projects], SESSION, "renamed").expect("rename");

        let all = records(&path);
        assert_eq!(all.len(), 3);
        assert_eq!(all[1]["customTitle"], "renamed");
    }

    #[test]
    fn a_session_with_no_transcript_or_a_path_shaped_id_writes_nothing() {
        let (_root, projects, path) = transcript(&format!("{PROMPT}\n"));
        let before = fs::read_to_string(&path).unwrap();

        let roots = std::slice::from_ref(&projects);
        assert!(!rename_claude_session(roots, "no-such-session", "x").unwrap());
        assert!(!rename_claude_session(roots, "../-home-me-work/x", "x").unwrap());
        assert!(!rename_claude_session(&[], SESSION, "x").unwrap());

        assert_eq!(fs::read_to_string(&path).unwrap(), before);
        assert!(!path.parent().unwrap().join(SESSION).exists(), "no sidecar either");
    }
}
