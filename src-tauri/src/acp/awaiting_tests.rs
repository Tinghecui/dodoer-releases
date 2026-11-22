use super::*;
use crate::acp::types::{AcpEvent, ConnectionStatus};
use crate::models::AgentType;
use chrono::TimeZone;

fn at(minute: u32) -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 18, 8, minute, 0).unwrap()
}

fn state() -> SessionState {
    let mut state = SessionState::new(
        "conn-awaiting".into(),
        AgentType::ClaudeCode,
        None,
        "win".into(),
        None,
    );
    state.status = ConnectionStatus::Prompting;
    state
}

fn permission(tool_call: Value, minute: u32) -> PendingPermissionState {
    PendingPermissionState {
        request_id: "r-1".into(),
        tool_call_id: super::super::session_state::extract_tool_call_id(&tool_call),
        tool_call,
        options: vec![],
        created_at: at(minute),
        queued: 0,
    }
}

fn question(minute: u32) -> PendingQuestionState {
    PendingQuestionState {
        question_id: "q-1".into(),
        questions: vec![serde_json::from_value(serde_json::json!({
            "id": "x", "question": "Which?", "header": "", "multi_select": false,
            "options": []
        }))
        .unwrap()],
        created_at: at(minute),
    }
}

fn plan(minute: u32) -> PendingPlanApprovalState {
    PendingPlanApprovalState {
        approval_id: "plan-1".into(),
        tool_call_id: String::new(),
        plan_markdown: "1. go".into(),
        created_at: at(minute),
    }
}

fn reason(state: &SessionState) -> Option<(AwaitingReason, DateTime<Utc>)> {
    derive(state).map(|a| (a.reason, a.since))
}

#[test]
fn each_reason_on_its_own_with_its_start_time() {
    let mut s = state();
    assert_eq!(reason(&s), None);
    s.pending_permission = Some(permission(serde_json::json!({"title": "rm"}), 1));
    assert_eq!(reason(&s), Some((AwaitingReason::Permission, at(1))));

    let mut s = state();
    s.pending_question = Some(question(2));
    assert_eq!(reason(&s), Some((AwaitingReason::Question, at(2))));
    // 一个问题都没有的提问什么也没问。
    s.pending_question.as_mut().unwrap().questions.clear();
    assert_eq!(reason(&s), None);

    let mut s = state();
    s.pending_plan_approval = Some(plan(3));
    assert_eq!(reason(&s), Some((AwaitingReason::Plan, at(3))));
}

#[test]
fn with_all_three_up_permission_then_question_then_plan() {
    let mut s = state();
    s.pending_plan_approval = Some(plan(3));
    s.pending_question = Some(question(2));
    s.pending_permission = Some(permission(serde_json::json!({"title": "rm"}), 1));
    assert_eq!(reason(&s).unwrap().0, AwaitingReason::Permission);
    s.pending_permission = None;
    assert_eq!(reason(&s).unwrap().0, AwaitingReason::Question);
    s.pending_question = None;
    assert_eq!(reason(&s).unwrap().0, AwaitingReason::Plan);
    s.pending_plan_approval = None;
    assert_eq!(reason(&s), None);
}

#[test]
fn exit_plan_mode_and_codex_plan_review_permissions_read_as_plan() {
    let mut s = state();
    s.pending_permission = Some(permission(
        serde_json::json!({
            "toolCallId": "t1", "kind": "switch_mode", "rawInput": {"plan": "1. edit"},
            "_meta": {"claudeCode": {"toolName": "ExitPlanMode"}}
        }),
        1,
    ));
    assert_eq!(reason(&s).unwrap().0, AwaitingReason::Plan);
    s.pending_permission = Some(permission(
        serde_json::json!({"title": "Implement this plan?",
            "_meta": {"codex": {"kind": "plan_review"}}}),
        1,
    ));
    assert_eq!(reason(&s).unwrap().0, AwaitingReason::Plan);
}

#[test]
fn exit_plan_mode_named_only_by_the_live_tool_call_reads_as_plan() {
    let mut s = state();
    s.apply_event(&AcpEvent::ToolCall {
        tool_call_id: "t9".into(),
        title: "Ready to code?".into(),
        kind: "switch_mode".into(),
        status: "pending".into(),
        content: None,
        raw_input: Some(r#"{"plan":"1. edit"}"#.into()),
        raw_output: None,
        locations: None,
        meta: Some(serde_json::json!({"claudeCode": {"toolName": "ExitPlanMode"}})),
        images: None,
    });
    s.pending_permission = Some(permission(
        serde_json::json!({"toolCallId": "t9", "title": "Ready to code?", "kind": "execute"}),
        1,
    ));
    assert_eq!(reason(&s).unwrap().0, AwaitingReason::Plan);
}

/// 前端 `isPlanApprovalPermission` 跑的是同一份例子。
#[test]
fn plan_approval_matches_the_frontend_cases() {
    let cases: Vec<Value> =
        serde_json::from_str(include_str!("../../../src/lib/plan-approval-cases.json")).unwrap();
    assert!(!cases.is_empty());
    for case in cases {
        assert_eq!(
            is_plan_approval_permission(&case["tool_call"], None),
            case["plan"].as_bool().unwrap(),
            "{}",
            case["name"]
        );
    }
}

#[test]
fn the_wire_shape_is_what_the_phone_reads() {
    let value = serde_json::to_value(ConversationAwaiting {
        reason: AwaitingReason::Question,
        since: at(5),
        via_child: true,
    })
    .unwrap();
    assert_eq!(value["reason"], "question");
    assert_eq!(value["via_child"], true);
    assert_eq!(value["since"], "2026-11-18T08:05:00Z");
}

fn waiting(reason: AwaitingReason, minute: u32) -> ConversationAwaiting {
    ConversationAwaiting {
        reason,
        since: at(minute),
        via_child: false,
    }
}

fn via_child(reason: AwaitingReason, minute: u32) -> ConversationAwaiting {
    ConversationAwaiting {
        via_child: true,
        ..waiting(reason, minute)
    }
}

fn child_of(parent: i32) -> ConversationLink {
    ConversationLink {
        parent: Some(parent),
        finished: false,
    }
}

#[test]
fn a_child_wait_reaches_every_ancestor() {
    // 1 ← 2 ← 3，3 在等。
    let own = HashMap::from([(3, waiting(AwaitingReason::Question, 5))]);
    let links = HashMap::from([(3, child_of(2)), (2, child_of(1))]);
    let shown = roll_up(&own, &links);
    assert_eq!(shown.get(&3), Some(&waiting(AwaitingReason::Question, 5)));
    assert_eq!(shown.get(&2), Some(&via_child(AwaitingReason::Question, 5)));
    assert_eq!(shown.get(&1), Some(&via_child(AwaitingReason::Question, 5)));
    assert!(roll_up(&HashMap::new(), &links).is_empty());
}

#[test]
fn a_parent_waiting_itself_keeps_its_own_reason() {
    let own = HashMap::from([
        (1, waiting(AwaitingReason::Plan, 1)),
        (2, waiting(AwaitingReason::Permission, 2)),
    ]);
    let links = HashMap::from([(2, child_of(1))]);
    let shown = roll_up(&own, &links);
    assert_eq!(shown.get(&1), Some(&waiting(AwaitingReason::Plan, 1)));
    assert_eq!(shown.get(&2), Some(&waiting(AwaitingReason::Permission, 2)));
}

#[test]
fn among_children_the_first_ranked_then_longest_waiting_wins() {
    let own = HashMap::from([
        (2, waiting(AwaitingReason::Plan, 1)),
        (3, waiting(AwaitingReason::Permission, 9)),
        (4, waiting(AwaitingReason::Permission, 7)),
    ]);
    let links = HashMap::from([(2, child_of(1)), (3, child_of(1)), (4, child_of(1))]);
    let shown = roll_up(&own, &links);
    assert_eq!(
        shown.get(&1),
        Some(&via_child(AwaitingReason::Permission, 7))
    );
}

#[test]
fn a_finished_conversation_shows_nothing_and_passes_nothing_up() {
    // 1 ← 2 ← 3，3 在等，2 结束了。
    let own = HashMap::from([(3, waiting(AwaitingReason::Permission, 4))]);
    let mut links = HashMap::from([(3, child_of(2)), (2, child_of(1))]);
    links.get_mut(&2).unwrap().finished = true;
    let shown = roll_up(&own, &links);
    assert_eq!(shown.get(&3), Some(&waiting(AwaitingReason::Permission, 4)));
    assert_eq!(shown.get(&2), None);
    assert_eq!(shown.get(&1), None);
    // 自己结束了，自己的也不显示。
    links.get_mut(&3).unwrap().finished = true;
    assert!(roll_up(&own, &links).is_empty());
}

#[test]
fn a_cycle_in_the_links_ends() {
    let own = HashMap::from([(2, waiting(AwaitingReason::Question, 1))]);
    let links = HashMap::from([(2, child_of(1)), (1, child_of(2))]);
    let shown = roll_up(&own, &links);
    assert_eq!(shown.get(&1), Some(&via_child(AwaitingReason::Question, 1)));
    assert_eq!(shown.get(&2), Some(&waiting(AwaitingReason::Question, 1)));
}
