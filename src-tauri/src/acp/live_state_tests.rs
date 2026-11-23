use super::*;
use crate::acp::plan_approval::PendingPlanApprovalState;
use crate::acp::question::PendingQuestionState;
use crate::acp::session_state::PendingPermissionState;
use crate::acp::types::ConnectionStatus;
use crate::models::AgentType;
use crate::web::event_bridge::EventEmitter;
use chrono::TimeZone;
use serde_json::json;

fn at(minute: u32, second: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 22, 8, minute, second)
        .unwrap()
}

fn state() -> SessionState {
    let mut state = SessionState::new(
        "conn-live".into(),
        AgentType::ClaudeCode,
        None,
        "win".into(),
        None,
    );
    state.status = ConnectionStatus::Prompting;
    state
}

fn permission(tool_call: Value) -> PendingPermissionState {
    PendingPermissionState {
        request_id: "r-1".into(),
        tool_call_id: crate::acp::session_state::extract_tool_call_id(&tool_call),
        tool_call,
        options: vec![],
        created_at: at(1, 0),
        queued: 0,
    }
}

fn question(text: &str) -> PendingQuestionState {
    PendingQuestionState {
        question_id: "q-1".into(),
        questions: vec![
            serde_json::from_value(json!({
                "id": "a", "question": text, "header": "", "multi_select": false,
                "options": []
            }))
            .unwrap(),
            serde_json::from_value(json!({
                "id": "b", "question": "second one", "header": "", "multi_select": false,
                "options": []
            }))
            .unwrap(),
        ],
        created_at: at(2, 0),
    }
}

fn plan() -> PendingPlanApprovalState {
    PendingPlanApprovalState {
        approval_id: "plan-1".into(),
        tool_call_id: String::new(),
        plan_markdown: "1. go".into(),
        created_at: at(3, 0),
    }
}

fn waiting(reason: AwaitingReason, title: Option<&str>) -> (ConversationAwaiting, Option<String>) {
    (
        ConversationAwaiting {
            reason,
            since: at(1, 0),
            via_child: false,
        },
        title.map(str::to_string),
    )
}

#[test]
fn the_file_is_exactly_the_agreed_shape() {
    let content = LiveContent::from_parts(
        vec![9, 3, 3],
        [
            (7, waiting(AwaitingReason::Permission, Some("Run ls"))),
            (12, waiting(AwaitingReason::Plan, None)),
        ],
    );
    let value = serde_json::to_value(content.stamp(at(5, 0))).unwrap();
    assert_eq!(
        value,
        json!({
            "version": 1,
            "updated_at": "2026-11-22T08:05:00Z",
            "running": [3, 9],
            "awaiting": {
                "7": {
                    "reason": "permission",
                    "since": "2026-11-22T08:01:00Z",
                    "title": "Run ls",
                    "via_child": false
                },
                "12": {
                    "reason": "plan",
                    "since": "2026-11-22T08:01:00Z",
                    "title": null,
                    "via_child": false
                }
            }
        })
    );
}

#[test]
fn an_empty_state_has_every_field() {
    let value = serde_json::to_value(LiveContent::default().stamp(at(0, 0))).unwrap();
    assert_eq!(
        value,
        json!({"version": 1, "updated_at": "2026-11-22T08:00:00Z", "running": [], "awaiting": {}})
    );
}

#[test]
fn a_permission_is_titled_by_its_tool_call() {
    let mut s = state();
    s.pending_permission = Some(permission(
        json!({"toolCallId": "t-1", "title": "  Run `ls -la`  "}),
    ));
    assert_eq!(prompt_title(&s).as_deref(), Some("Run `ls -la`"));
    // 请求里是 JSON 字符串也认。
    s.pending_permission = Some(permission(Value::String(
        r#"{"toolCallId":"t-2","title":"Edit main.rs"}"#.into(),
    )));
    assert_eq!(prompt_title(&s).as_deref(), Some("Edit main.rs"));
}

#[test]
fn a_question_is_titled_by_its_first_question() {
    let mut s = state();
    s.pending_question = Some(question("Which branch?"));
    assert_eq!(prompt_title(&s).as_deref(), Some("Which branch?"));
}

#[test]
fn a_plan_has_no_title() {
    let mut s = state();
    s.pending_plan_approval = Some(plan());
    assert_eq!(prompt_title(&s), None);
}

#[test]
fn titles_are_trimmed_flattened_and_cut() {
    assert_eq!(
        clean_title("line one\nline two\r\nthree").as_deref(),
        Some("line one line two three")
    );
    assert_eq!(clean_title("   \n  "), None);
    assert_eq!(clean_title(""), None);
    let long: String = "字".repeat(TITLE_MAX_CHARS + 50);
    let cut = clean_title(&long).unwrap();
    assert_eq!(cut.chars().count(), TITLE_MAX_CHARS);
}

#[test]
fn an_empty_tool_title_is_null() {
    let mut s = state();
    s.pending_permission = Some(permission(json!({"toolCallId": "t-1", "title": " "})));
    assert_eq!(prompt_title(&s), None);
}

#[test]
fn only_the_server_writes_not_the_desktop_daemon() {
    assert!(enabled_for(None));
    assert!(enabled_for(Some("0")));
    assert!(!enabled_for(Some("1")));
}

fn read(path: &Path) -> LiveState {
    serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap()
}

#[tokio::test]
async fn the_file_is_written_whole_and_private() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = LiveStateWriter::new(dir.path());
    let content = LiveContent::from_parts(vec![4], []);
    assert!(writer.write_now(content, at(0, 0)).await);
    let path = dir.path().join(FILE_NAME);
    assert_eq!(read(&path).running, vec![4]);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }
    // 没留下临时文件。
    let names: Vec<_> = std::fs::read_dir(dir.path())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from(FILE_NAME)]);
}

#[tokio::test]
async fn a_dir_that_cannot_be_written_only_warns() {
    let dir = tempfile::tempdir().unwrap();
    // 「数据目录」其实是个文件：谁跑测试（包括 root）都写不进去。
    let not_a_dir = dir.path().join("plain-file");
    std::fs::write(&not_a_dir, b"x").unwrap();
    let mut writer = LiveStateWriter::new(&not_a_dir);
    assert!(!writer.tick(LiveContent::default(), at(0, 0)).await);
    // 下一次接着试。
    assert!(writer.due(&LiveContent::default(), at(0, 2)));
    assert!(!writer.tick(LiveContent::default(), at(0, 2)).await);
}

#[tokio::test]
async fn unchanged_content_is_rewritten_only_every_minute() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = LiveStateWriter::new(dir.path());
    let content = LiveContent::from_parts(vec![1], []);
    assert!(writer.tick(content.clone(), at(0, 0)).await);
    assert!(!writer.tick(content.clone(), at(0, 2)).await);
    assert!(!writer.tick(content.clone(), at(0, 58)).await);
    assert_eq!(read(writer.path()).updated_at, at(0, 0));
    assert!(writer.tick(content.clone(), at(1, 0)).await);
    assert_eq!(read(writer.path()).updated_at, at(1, 0));
}

#[tokio::test]
async fn changed_content_is_written_on_the_next_tick() {
    let dir = tempfile::tempdir().unwrap();
    let mut writer = LiveStateWriter::new(dir.path());
    assert!(writer.tick(LiveContent::default(), at(0, 0)).await);
    let changed = LiveContent::from_parts(vec![2], []);
    assert!(writer.tick(changed, at(0, 2)).await);
    assert_eq!(read(writer.path()).running, vec![2]);
}

async fn add(mgr: &ConnectionManager, id: &str, conversation_id: i32) {
    mgr.insert_test_connection(id, AgentType::ClaudeCode, None, EventEmitter::Noop)
        .await;
    let state = mgr.get_state(id).await.unwrap();
    state.write().await.conversation_id = Some(conversation_id);
}

async fn edit(mgr: &ConnectionManager, id: &str, f: impl FnOnce(&mut SessionState)) {
    let state = mgr.get_state(id).await.unwrap();
    f(&mut *state.write().await);
}

#[tokio::test]
async fn running_follows_the_busy_check() {
    let mgr = ConnectionManager::new();
    add(&mgr, "idle", 1).await;
    add(&mgr, "prompting", 2).await;
    edit(&mgr, "prompting", |s| {
        s.status = ConnectionStatus::Prompting
    })
    .await;
    add(&mgr, "in-flight", 3).await;
    edit(&mgr, "in-flight", |s| s.turn_in_flight = true).await;
    add(&mgr, "errored", 4).await;
    edit(&mgr, "errored", |s| {
        s.status = ConnectionStatus::Error;
        s.turn_in_flight = true;
    })
    .await;
    add(&mgr, "gone", 5).await;
    edit(&mgr, "gone", |s| {
        s.status = ConnectionStatus::Disconnected;
        s.turn_in_flight = true;
    })
    .await;
    assert_eq!(snapshot(&mgr).await.running, vec![2, 3]);
}

#[tokio::test]
async fn a_pending_permission_shows_up_and_goes_away() {
    let dir = tempfile::tempdir().unwrap();
    let mgr = ConnectionManager::new();
    add(&mgr, "c1", 42).await;
    edit(&mgr, "c1", |s| {
        s.pending_permission = Some(permission(
            json!({"toolCallId": "t-1", "title": "Run make"}),
        ));
    })
    .await;
    let mut writer = LiveStateWriter::new(dir.path());
    assert!(writer.tick(snapshot(&mgr).await, at(0, 0)).await);
    let file = read(writer.path());
    assert_eq!(
        file.awaiting.get("42"),
        Some(&LiveAwaiting {
            reason: AwaitingReason::Permission,
            since: at(1, 0),
            title: Some("Run make".into()),
            via_child: false,
        })
    );

    // 批准了：下一次写的文件里就没有了。
    edit(&mgr, "c1", |s| s.pending_permission = None).await;
    assert!(writer.tick(snapshot(&mgr).await, at(0, 2)).await);
    assert!(read(writer.path()).awaiting.is_empty());
}

#[tokio::test]
async fn a_plan_permission_is_awaiting_plan_without_a_title() {
    let mgr = ConnectionManager::new();
    add(&mgr, "c1", 8).await;
    edit(&mgr, "c1", |s| {
        s.pending_permission = Some(permission(json!({
            "toolCallId": "t-1", "title": "ExitPlanMode", "_meta": {"claudeCode": {"toolName": "ExitPlanMode"}}
        })));
    })
    .await;
    let content = snapshot(&mgr).await;
    let entry = content.awaiting.get("8").unwrap();
    assert_eq!(entry.reason, AwaitingReason::Plan);
    assert_eq!(entry.title, None);
}

#[tokio::test]
async fn start_writes_empty_and_stop_writes_empty() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    // 上次留下的旧内容。
    std::fs::write(
        &path,
        br#"{"version":1,"updated_at":"2026-01-01T00:00:00Z","running":[5],"awaiting":{}}"#,
    )
    .unwrap();
    let mgr = ConnectionManager::new();
    let task = LiveStateTask::start(mgr.clone_ref(), dir.path()).await;
    let first = read(&path);
    assert!(first.running.is_empty() && first.awaiting.is_empty());
    std::fs::write(&path, b"{}").unwrap();
    task.stop().await;
    let last = read(&path);
    assert!(last.running.is_empty() && last.awaiting.is_empty());
}

// 同一个数据目录上的两个服务器（测试里是同一个进程里开两份，文件锁照样互相看得见）。

#[tokio::test]
async fn two_servers_on_one_dir_are_merged() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    let mut a = Publisher::open(dir.path()).await;
    let mut b = Publisher::open(dir.path()).await;
    a.publish(LiveContent::default(), at(0, 0), true).await;
    b.publish(LiveContent::default(), at(0, 0), true).await;

    let a_own = LiveContent::from_parts(
        vec![1],
        [(7, waiting(AwaitingReason::Permission, Some("Run ls")))],
    );
    let b_own = LiveContent::from_parts(vec![2], [(9, waiting(AwaitingReason::Question, None))]);
    assert!(a.publish(a_own.clone(), at(0, 2), false).await);
    assert!(b.publish(b_own.clone(), at(0, 2), false).await);
    // 后写的那个也带着先写的那个的会话。
    let both = read(&path);
    assert_eq!(both.running, vec![1, 2]);
    assert_eq!(
        both.awaiting.keys().cloned().collect::<Vec<_>>(),
        vec!["7".to_string(), "9".to_string()]
    );

    // b 正常退出：文件里只剩 a 的，不是空的。
    assert!(b.close(at(0, 4)).await);
    let left = read(&path);
    assert_eq!(left.running, vec![1]);
    assert_eq!(
        left.awaiting.keys().cloned().collect::<Vec<_>>(),
        vec!["7".to_string()]
    );
    // a 下一次算的时候 b 的那份也没了，内容和上次写的一样就不用重写。
    assert!(!a.publish(a_own, at(0, 6), false).await);
    assert!(a.close(at(0, 8)).await);
    let last = read(&path);
    assert!(last.running.is_empty() && last.awaiting.is_empty());
}

#[tokio::test]
async fn a_dead_servers_part_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    // 崩掉的进程留下的那一份：锁文件在、但没人锁着。
    let parts = dir.path().join(PARTS_DIR);
    std::fs::create_dir_all(&parts).unwrap();
    std::fs::write(
        parts.join("4242-1.json"),
        br#"{"version":1,"updated_at":"2026-11-22T08:00:00Z","running":[5],"awaiting":{}}"#,
    )
    .unwrap();
    std::fs::write(parts.join("4242-1.lock"), b"").unwrap();

    let mut p = Publisher::open(dir.path()).await;
    assert!(p.publish(LiveContent::default(), at(0, 0), true).await);
    assert!(read(&dir.path().join(FILE_NAME)).running.is_empty());
    assert!(!parts.join("4242-1.json").exists());
    assert!(!parts.join("4242-1.lock").exists());
    p.close(at(0, 2)).await;
}

#[test]
fn the_same_conversation_in_two_parts_keeps_the_earliest_wait() {
    let mut early = waiting(AwaitingReason::Permission, Some("first"));
    early.0.since = at(0, 0);
    let late = waiting(AwaitingReason::Question, Some("later"));
    let merged = merge(
        LiveContent::from_parts(vec![3], [(7, late)]),
        [LiveContent::from_parts(vec![3, 1], [(7, early)])],
    );
    assert_eq!(merged.running, vec![1, 3]);
    assert_eq!(merged.awaiting["7"].title.as_deref(), Some("first"));
}

#[tokio::test]
async fn a_part_that_could_not_be_made_at_start_is_retried() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join(FILE_NAME);
    let parts = dir.path().join(PARTS_DIR);
    // 启动时子目录建不出来（这里用一个同名的普通文件挡着）。
    std::fs::write(&parts, b"").unwrap();
    let mut a = Publisher::open(dir.path()).await;
    let a_own = LiveContent::from_parts(vec![1], []);
    assert!(a.publish(a_own.clone(), at(0, 0), true).await);
    assert_eq!(read(&path).running, vec![1]);

    // 挡着的东西没了，另一个服务器起来了：a 下一次就把自己的那一份补上，也合上 b 的。
    std::fs::remove_file(&parts).unwrap();
    let mut b = Publisher::open(dir.path()).await;
    assert!(
        b.publish(LiveContent::from_parts(vec![2], []), at(0, 1), true)
            .await
    );
    assert!(a.publish(a_own, at(0, 2), false).await);
    assert_eq!(read(&path).running, vec![1, 2]);

    // a 退出时只撤掉自己的，b 的还在。
    assert!(a.close(at(0, 4)).await);
    assert_eq!(read(&path).running, vec![2]);
    b.close(at(0, 6)).await;
}
