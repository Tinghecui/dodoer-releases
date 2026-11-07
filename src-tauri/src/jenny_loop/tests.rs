use super::*;
use chrono::TimeZone;
use serde_json::json;
use std::fs;

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 3, 1, 12, 0, 0).unwrap()
}

fn write_loop(folder: &Path, id: &str, state: Value) -> PathBuf {
    let dir = folder.join(LOOP_DOCS).join(id);
    fs::create_dir_all(dir.join("runtime")).unwrap();
    fs::write(dir.join("loop.json"), state.to_string()).unwrap();
    dir
}

fn state(id: &str, status: &str, phase: &str, updated: &str) -> Value {
    serde_json::json!({
        "schemaVersion": "jenny-loop/v2",
        "id": id,
        "title": format!("task of {id}"),
        "status": status,
        "phase": phase,
        "cycle": 2,
        "testRound": 1,
        "revision": 5,
        "updatedAt": updated,
        "contextMeta": { "originalRequestSha256": format!("sha-{id}") },
        "runtime": { "framework": "claude", "threadId": "live-session" },
        "stageCounts": { "impl": 1, "test": 1 },
        "timing": { "stageStartedAt": "2026-02-20T10:30:00Z" },
        "exitConditions": [
            { "id": "a", "label": "first", "done": true, "evidence": ["e1"] },
            { "id": "b", "label": "second", "done": false }
        ],
        "metrics": [{
            "id": "m", "label": "score", "unit": "分", "goal": "at-least", "target": 3,
            "value": 2, "history": [
                { "testRound": 1, "value": 1, "recordedAt": "2026-02-20T09:00:00Z" },
                { "testRound": 2, "value": 2, "recordedAt": "2026-02-20T10:00:00Z" }
            ]
        }],
        "attention": {
            "humanIntervention": { "active": false, "summary": "old" },
            "requirementChallenge": { "active": true, "summary": "too strict" }
        },
        "rounds": [
            { "id": "impl-01", "phase": "impl", "cycle": 1, "result": "passed", "summary": "built",
              "startedAt": "2026-02-20T08:00:00Z", "completedAt": "2026-02-20T09:00:00Z",
              "durationMinutes": 60.0, "evidence": ["e"] },
            { "id": "test-01", "phase": "test", "cycle": 1, "result": "failed", "summary": "broke",
              "startedAt": "2026-02-20T09:00:00Z", "completedAt": "2026-02-20T10:00:00Z" }
        ]
    })
}

fn no_stores() -> SessionStores {
    SessionStores {
        codex_env: AgentEnv::inherited(),
        claude_env: AgentEnv::inherited(),
        grok_env: AgentEnv::inherited(),
        data_root: None,
    }
}

fn session(id: &str, marker: Option<StageMarker>, started: &str) -> IndexedSession {
    IndexedSession {
        agent_type: AgentType::Codex,
        id: id.to_string(),
        role: LoopSessionRole::Stage,
        label: None,
        parent: None,
        marker,
        graph_stage: None,
        started: parse_time(Some(started)),
        updated: None,
    }
}

fn marker(phase: &str, cycle: Option<u64>, number: Option<u64>) -> StageMarker {
    StageMarker {
        loop_id: "loop01".to_string(),
        phase: phase.to_string(),
        cycle,
        number,
    }
}

#[test]
fn every_prompt_shape_jenny_wrote_names_its_stage() {
    let current = "你正在执行 Jenny Loop loop22 的 reflect 阶段，第 49 个循环。\n\n本次执行对话必须使用名称：loop22reflect17。请把这个名称作为标题";
    let m = classify_session(None, current).unwrap();
    assert_eq!(
        (m.loop_id.as_str(), m.phase.as_str(), m.cycle, m.number),
        ("loop22", "reflect", Some(49), Some(17))
    );

    let objective = "完成 loop01 第 6 循环的 test 阶段，并提交可验证结果";
    let m = classify_session(None, objective).unwrap();
    assert_eq!(
        (m.phase.as_str(), m.cycle, m.number),
        ("test", Some(6), None)
    );

    let direct = "你是当前任务的主 Agent，直接负责完成用户要求。\n\nLoop：loop09，当前阶段：impl。\n当前循环：3；当前 Loop revision：4\n本次对话名称：loop09impl02";
    let m = classify_session(None, direct).unwrap();
    assert_eq!(
        (m.loop_id.as_str(), m.phase.as_str(), m.cycle, m.number),
        ("loop09", "impl", Some(3), Some(2))
    );

    let named = classify_session(Some("loop02test03"), "whatever").unwrap();
    assert_eq!((named.phase.as_str(), named.number), ("test", Some(3)));
    let launcher = classify_session(Some("loop02launcher"), "").unwrap();
    assert_eq!(launcher.phase, "launcher");
}

#[test]
fn ordinary_sessions_are_not_stages() {
    assert_eq!(
        classify_session(None, "帮我看看 loop docs/loop01 为什么失败"),
        None
    );
    assert_eq!(
        classify_session(Some("fix loop01"), "Loop：loop01，当前阶段：impl"),
        None
    );
    assert!(!is_loop_session_title("完成 登录页 的改版"));
    assert!(is_loop_session_title(
        "完成 loop03 第 3 循环的 impl 阶段，并提交可验证结果"
    ));
    assert!(is_loop_session_title(
        "你是 Loop v2 的独立节点对话。只完成下面这个节点"
    ));
}

#[test]
fn a_named_session_goes_to_its_round_and_a_retry_joins_it() {
    let mut stages = read_rounds(&state("loop01", "active", "test", "2026-02-20T10:00:00Z"));
    let first = session(
        "a",
        Some(marker("impl", Some(1), Some(1))),
        "2026-02-20T08:00:05Z",
    );
    let retry = session(
        "b",
        Some(marker("impl", Some(1), Some(1))),
        "2026-02-20T08:40:00Z",
    );
    assign_sessions(&mut stages, &[&first, &retry], &[]);
    let ids: Vec<_> = stages[0]
        .sessions
        .iter()
        .map(|s| s.session_id.as_str())
        .collect();
    assert_eq!(stages[0].id, "impl-01");
    assert_eq!(ids, ["a", "b"]);
    assert!(stages[1].sessions.is_empty());
}

#[test]
fn an_unnamed_session_picks_the_attempt_whose_time_holds_it() {
    let mut stages = read_rounds(&serde_json::json!({ "rounds": [
        { "id": "impl-01", "phase": "impl", "cycle": 5,
          "startedAt": "2026-02-20T08:00:00Z", "completedAt": "2026-02-20T09:00:00Z" },
        { "id": "impl-02", "phase": "impl", "cycle": 5,
          "startedAt": "2026-02-20T10:00:00Z", "completedAt": "2026-02-20T11:00:00Z" }
    ]}));
    let later = session(
        "late",
        Some(marker("impl", Some(5), None)),
        "2026-02-20T10:30:00Z",
    );
    assign_sessions(&mut stages, &[&later], &[]);
    assert!(stages[0].sessions.is_empty());
    assert_eq!(stages[1].sessions[0].session_id, "late");
}

#[test]
fn a_session_no_round_knows_gets_its_own_stage_instead_of_vanishing() {
    let mut stages = read_rounds(&state("loop01", "active", "test", "2026-02-20T10:00:00Z"));
    let stray = session(
        "s",
        Some(marker("deploy", None, Some(7))),
        "2026-02-20T11:00:00Z",
    );
    assign_sessions(&mut stages, &[&stray], &[]);
    let last = stages.last().unwrap();
    assert_eq!((last.id.as_str(), last.result.clone()), ("deploy-07", None));
    assert_eq!(last.sessions[0].session_id, "s");
}

#[test]
fn helpers_follow_their_parent_at_any_depth() {
    let mut stages = read_rounds(&state("loop01", "active", "test", "2026-02-20T10:00:00Z"));
    let stage = session(
        "stage",
        Some(marker("test", Some(1), Some(1))),
        "2026-02-20T09:00:01Z",
    );
    let mut child = session("child", None, "2026-02-20T09:10:00Z");
    child.role = LoopSessionRole::Subagent;
    child.parent = Some("stage".into());
    let mut grand = session("grand", None, "2026-02-20T09:20:00Z");
    grand.role = LoopSessionRole::Subagent;
    grand.parent = Some("child".into());
    assign_sessions(&mut stages, &[&grand, &child, &stage], &[]);
    let ids: Vec<_> = stages[1]
        .sessions
        .iter()
        .map(|s| s.session_id.as_str())
        .collect();
    assert_eq!(ids, ["stage", "child", "grand"]);
}

#[test]
fn a_task_graph_node_lands_on_the_stage_its_graph_is_bound_to() {
    let head = r#"{"id":"g","spec":{"nodes":[]},"binding":{"loopDirectory":"/p/loop docs/loop01","loopId":"loop01","phase":"impl","stage":1,"inputHash":"h"},"simulation":false}"#;
    let binding = parse_graph_binding(head).unwrap();
    assert_eq!((binding.phase.as_str(), binding.stage), ("impl", 1));
    let mut stages = read_rounds(&state("loop01", "active", "test", "2026-02-20T10:00:00Z"));
    let mut node = session("n", None, "2026-02-20T08:30:00Z");
    node.role = LoopSessionRole::Node;
    node.label = Some("build".into());
    node.graph_stage = Some(binding);
    assign_sessions(&mut stages, &[&node], &[]);
    assert_eq!(stages[0].sessions[0].label.as_deref(), Some("build"));
    assert_eq!(
        graph_ref("x --id 00065521-3bf9-5535-df56-5ab4da6fdfa9 --node build y")
            .unwrap()
            .1
            .as_deref(),
        Some("build")
    );
}

#[test]
fn a_grok_session_is_found_from_its_first_prompt() {
    let home = tempfile::tempdir().unwrap();
    let group = home
        .path()
        .join("sessions")
        .join(urlencoding::encode("/work/app").as_ref());
    let write = |id: &str, text: &str| {
        let dir = group.join(id);
        fs::create_dir_all(&dir).unwrap();
        let update = serde_json::json!({ "method": "session/update", "params": { "update": {
            "sessionUpdate": "user_message_chunk", "content": { "type": "text", "text": text }
        }}});
        fs::write(
            dir.join("updates.jsonl"),
            format!("{{\"method\":\"setup\"}}\n{update}\n"),
        )
        .unwrap();
        fs::write(
            dir.join("summary.json"),
            r#"{"created_at":"2026-02-20T08:00:00Z"}"#,
        )
        .unwrap();
    };
    write(
        "stage-1",
        "你正在执行 Jenny Loop loop03 的 impl 阶段，第 1 个循环。",
    );
    write("chat-1", "帮我修一下登录页");
    let found = grok_sessions(home.path(), "/work/app", None);
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].id, "stage-1");
    assert_eq!(found[0].agent_type, AgentType::Grok);
    assert_eq!(found[0].marker.as_ref().unwrap().loop_id, "loop03");
    assert!(found[0].started.is_some());
}

#[test]
fn run_state_trusts_a_stop_then_a_fresh_heartbeat() {
    let dir = tempfile::tempdir().unwrap();
    let loop_dir = write_loop(
        dir.path(),
        "loop01",
        state("loop01", "active", "impl", "2026-02-20T10:00:00Z"),
    );
    let read = |s: &Value| run_state(s, &loop_dir, now());
    let active = state("loop01", "active", "impl", "2026-02-20T10:00:00Z");
    assert_eq!(read(&active), LoopRunState::Stopped);

    let heartbeat =
        |at: &str| serde_json::json!({ "status": "running", "heartbeatAt": at }).to_string();
    fs::write(
        loop_dir.join("runtime/direct-status.json"),
        heartbeat("2026-03-01T11:59:00Z"),
    )
    .unwrap();
    assert_eq!(read(&active), LoopRunState::Running);
    fs::write(
        loop_dir.join("runtime/direct-status.json"),
        heartbeat("2026-03-01T11:00:00Z"),
    )
    .unwrap();
    assert_eq!(read(&active), LoopRunState::Stopped);

    // A state write just now still counts, for a runner with no heartbeat file.
    let just_written = state("loop01", "active", "impl", "2026-03-01T11:58:00Z");
    assert_eq!(read(&just_written), LoopRunState::Running);

    fs::write(
        loop_dir.join("runtime/direct-control.json"),
        r#"{"desiredState":"stopped"}"#,
    )
    .unwrap();
    assert_eq!(read(&just_written), LoopRunState::Paused);
    assert_eq!(
        read(&state(
            "loop01",
            "completed",
            "done",
            "2026-02-20T10:00:00Z"
        )),
        LoopRunState::Completed
    );
}

#[test]
fn the_sidebar_row_names_the_running_loop_and_needs_a_person_when_asked() {
    let dir = tempfile::tempdir().unwrap();
    write_loop(
        dir.path(),
        "loop01",
        state("loop01", "completed", "done", "2026-02-25T10:00:00Z"),
    );
    let summary = summarize_folder(dir.path(), now()).unwrap();
    assert_eq!(summary.status, "completed");
    assert_eq!(summary.agent_type, AgentType::ClaudeCode);
    assert_eq!(summary.stage_count, 2);
    assert!(summary.title.starts_with("loop01｜"));

    write_loop(
        dir.path(),
        "loop02",
        state("loop02", "active", "impl", "2026-03-01T11:59:00Z"),
    );
    let summary = summarize_folder(dir.path(), now()).unwrap();
    assert_eq!(summary.status, "in_progress");
    assert!(summary.title.starts_with("loop02 impl｜"));
    assert!(summary.running);

    let mut asks = state("loop02", "active", "impl", "2026-03-01T11:59:00Z");
    asks["attention"]["humanIntervention"] =
        serde_json::json!({ "active": true, "summary": "log in" });
    write_loop(dir.path(), "loop02", asks);
    assert_eq!(
        summarize_folder(dir.path(), now()).unwrap().status,
        "pending_review"
    );
}

#[test]
fn a_folder_without_loops_has_no_row() {
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(summarize_folder(dir.path(), now()), None);
    fs::create_dir_all(dir.path().join(LOOP_DOCS).join("task01")).unwrap();
    assert_eq!(summarize_folder(dir.path(), now()), None);
}

#[test]
fn an_attempt_workspace_of_jenny_has_no_row() {
    let dir = tempfile::tempdir().unwrap();
    let attempt = dir.path().join("Jenny/attempts/loop04/94/id/project");
    write_loop(
        &attempt,
        "loop04",
        state("loop04", "active", "impl", "2026-02-20T10:00:00Z"),
    );
    assert_eq!(summarize_folder(&attempt, now()), None);
}

#[test]
fn a_worktree_hides_the_records_its_branch_was_cut_with() {
    let root = tempfile::tempdir().unwrap();
    let main = root.path().join("repo");
    let worktree = root.path().join("repo-wt");
    write_loop(
        &main,
        "loop01",
        state("loop01", "completed", "done", "2026-02-25T10:00:00Z"),
    );
    write_loop(
        &worktree,
        "loop01",
        state("loop01", "active", "impl", "2026-02-20T10:00:00Z"),
    );
    fs::create_dir_all(main.join(".git/worktrees/wt")).unwrap();
    fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", main.join(".git/worktrees/wt").display()),
    )
    .unwrap();

    assert_eq!(summarize_folder(&worktree, now()), None);
    assert!(read_conversation(&worktree, &no_stores(), now())
        .loops
        .is_empty());

    // A Loop started in the worktree is its own.
    write_loop(
        &worktree,
        "loop02",
        state("loop02", "active", "impl", "2026-03-01T11:59:00Z"),
    );
    assert!(summarize_folder(&worktree, now())
        .unwrap()
        .title
        .starts_with("loop02"));
}

#[test]
fn the_conversation_lists_loops_oldest_first_with_the_live_stage_last() {
    let dir = tempfile::tempdir().unwrap();
    write_loop(
        dir.path(),
        "loop10",
        state("loop10", "active", "deploy", "2026-03-01T11:59:00Z"),
    );
    write_loop(
        dir.path(),
        "loop9",
        state("loop9", "completed", "done", "2026-02-01T00:00:00Z"),
    );
    let detail = read_conversation(dir.path(), &no_stores(), now());
    let ids: Vec<_> = detail.loops.iter().map(|l| l.id.as_str()).collect();
    assert_eq!(ids, ["loop9", "loop10"]);

    let live = &detail.loops[1];
    assert_eq!(live.run_state, LoopRunState::Running);
    assert_eq!(live.requirement_challenge.as_deref(), Some("too strict"));
    assert_eq!(live.human_intervention, None);
    assert_eq!(live.exit_conditions.iter().filter(|c| c.done).count(), 1);
    assert_eq!(live.metrics[0].history.len(), 2);
    let last = live.stages.last().unwrap();
    assert!(last.current);
    assert_eq!(last.id, "deploy-01");
    // `runtime.threadId` is there the moment the stage starts.
    assert_eq!(last.sessions[0].session_id, "live-session");
    assert_eq!(last.sessions[0].agent_type, AgentType::ClaudeCode);

    assert!(detail.loops[0].stages.iter().all(|s| !s.current));
}

#[test]
fn only_plain_loop_directories_take_commands() {
    let dir = tempfile::tempdir().unwrap();
    write_loop(
        dir.path(),
        "loop01",
        state("loop01", "active", "impl", "2026-02-20T10:00:00Z"),
    );
    assert!(loop_dir_for(dir.path(), "loop01").is_some());
    assert!(loop_dir_for(dir.path(), "../loop01").is_none());
    assert!(loop_dir_for(dir.path(), "loop02").is_none());
}

fn timed_session(id: &str, started: &str, updated: &str) -> IndexedSession {
    IndexedSession {
        updated: parse_time(Some(updated)),
        ..session(id, None, started)
    }
}

fn timed_stage(id: &str, phase: &str, from: &str, to: &str) -> LoopStage {
    let mut stage = read_rounds(&json!({ "rounds": [{
        "id": id,
        "phase": phase,
        "cycle": 1,
        "result": "passed",
        "startedAt": from,
        "completedAt": to,
    }] }))
    .remove(0);
    stage.sessions.clear();
    stage
}

#[test]
fn a_session_started_just_before_its_stage_lands_on_that_stage() {
    let mut stages = vec![
        timed_stage(
            "impl-01",
            "impl",
            "2026-08-13T14:00:00Z",
            "2026-08-13T14:29:14Z",
        ),
        timed_stage(
            "impl-02",
            "impl",
            "2026-08-13T14:29:14Z",
            "2026-08-13T15:00:00Z",
        ),
    ];
    let mut late = timed_session("late", "2026-08-13T14:28:54Z", "2026-08-13T15:00:00Z");
    late.marker = Some(marker("impl", Some(1), None));
    assign_sessions(&mut stages, &[&late], &[]);
    assert_eq!(stages[1].sessions[0].session_id, "late");
}

#[test]
fn one_session_running_several_stages_shows_on_each() {
    let mut stages = vec![
        timed_stage(
            "impl-01",
            "impl",
            "2026-09-08T15:03:42Z",
            "2026-09-08T15:11:15Z",
        ),
        timed_stage(
            "test-01",
            "test",
            "2026-09-08T15:11:15Z",
            "2026-09-08T15:15:11Z",
        ),
        timed_stage(
            "impl-02",
            "impl",
            "2026-09-08T16:00:00Z",
            "2026-09-08T16:10:00Z",
        ),
    ];
    let mut only = timed_session("only", "2026-09-08T15:03:30Z", "2026-09-08T15:30:29Z");
    only.marker = Some(marker("impl", None, Some(1)));
    assign_sessions(&mut stages, &[&only], &[]);
    assert_eq!(stages[0].sessions[0].session_id, "only");
    assert_eq!(stages[1].sessions[0].session_id, "only");
    // Outside the session's time: nothing to show, and nothing is made up.
    assert!(stages[2].sessions.is_empty());
}

#[test]
fn a_goal_stage_is_found_from_its_rollout_even_in_a_deleted_worktree() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("codex");
    fs::create_dir_all(home.join("archived_sessions")).unwrap();
    let folder = dir.path().join("project");
    let worktree = dir.path().join("project-worktrees/gone");

    let rollout = |stage_prompt: &str| {
        [
            json!({"payload": {"type": "session_meta"}}),
            json!({"payload": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": "# AGENTS.md instructions"}
            ]}}),
            json!({"payload": {"type": "message", "role": "user", "content": [
                {"type": "input_text", "text": stage_prompt}
            ]}}),
        ]
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n")
    };
    // Compressed and moved to the archive after the table recorded its path.
    let zst = home.join("archived_sessions/rollout-a.jsonl.zst");
    fs::write(
        &zst,
        zstd::encode_all(
            rollout("你正在执行 Jenny Loop loop01 的 impl 阶段，第 1 个循环。").as_bytes(),
            0,
        )
        .unwrap(),
    )
    .unwrap();
    let plain = home.join("rollout-b.jsonl");
    fs::write(&plain, rollout("与 Loop 无关的自动任务")).unwrap();

    let conn = rusqlite::Connection::open(home.join("state_5.sqlite")).unwrap();
    conn.execute_batch(
        "CREATE TABLE threads (
            id TEXT, name TEXT, title TEXT, first_user_message TEXT, cwd TEXT,
            created_at INTEGER, updated_at INTEGER,
            created_at_ms INTEGER, updated_at_ms INTEGER,
            thread_source TEXT, rollout_path TEXT, source TEXT, agent_nickname TEXT
        );",
    )
    .unwrap();
    let insert = |id: &str, first: &str, cwd: &Path, source: &str, path: &str| {
        conn.execute(
            "INSERT INTO threads VALUES (?1, NULL, ?2, ?2, ?3, 1, 2, 1000, 2000, ?4, ?5, 'vscode', NULL)",
            rusqlite::params![id, first, cwd.to_string_lossy(), source, path],
        )
        .unwrap();
    };
    let stored = home.join("sessions/rollout-a.jsonl");
    insert(
        "stage",
        "阶段预算已使用约 80%",
        &worktree,
        "automation",
        &stored.to_string_lossy(),
    );
    insert(
        "latest",
        "",
        &worktree,
        "automation",
        "/nowhere/rollout-none.jsonl",
    );
    insert(
        "other",
        "",
        &worktree,
        "automation",
        &plain.to_string_lossy(),
    );
    insert(
        "typed",
        "阶段预算已使用",
        &worktree,
        "user",
        &stored.to_string_lossy(),
    );
    drop(conn);

    let folder_text = folder.to_string_lossy().into_owned();
    let found = codex_sessions(&home, &folder_text, &["latest".to_string()], None).unwrap();
    let ids: Vec<&str> = found.iter().map(|s| s.id.as_str()).collect();
    assert_eq!(ids, ["stage"]);
    let stage_marker = found[0].marker.as_ref().unwrap();
    assert_eq!(stage_marker.loop_id, "loop01");
    assert_eq!(stage_marker.phase, "impl");
    assert_eq!(stage_marker.cycle, Some(1));

    // Without a Loop pointing at the worktree its threads stay out.
    assert!(codex_sessions(&home, &folder_text, &[], None)
        .unwrap()
        .is_empty());
}

#[test]
fn the_stage_reminder_keeps_a_session_out_of_the_ordinary_list() {
    assert!(is_loop_session_title(
        "阶段预算已使用约 80%，请收敛当前工作"
    ));
    assert!(!is_loop_session_title("预算还剩多少"));
}
