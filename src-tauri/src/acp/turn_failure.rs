//! Cowork 加的（#1120）：一轮以失败收尾时，把失败说明存下来，刷新后还在。
//!
//! 「本轮失败」那一行本来只在前端的实时状态里；刷新后对话从智能体自己的记录
//! 重新解析。底下的 Claude CLI 被杀时，它来不及写失败记录，这一行就没了，用户
//! 看不出这一轮为什么没完成。这里在回合以没解决的 error 级 SessionFailure 收尾
//! 时，把失败存进 `app_metadata`（键 → JSON，不用迁移）；拿会话详情时，最后一轮
//! 还没有失败行的，按这条补一行。下一轮不是这样收尾的，就清掉。

use chrono::{DateTime, Utc};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use crate::acp::types::SessionFailureRecord;
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;
use crate::models::message::{ContentBlock, MessageTurn, TurnRole};

const KEY_PREFIX: &str = "cowork.turn_failure.conversation.";

/// `ContentBlock::TurnError::kind`：智能体底下的进程没了、连接断了，这个会话
/// 要重新连上才能接着用（`connection::session_failure_ends_session`）。前端据此
/// 显示本地化的说明和「重试」。
pub const KIND_CONNECTION_LOST: &str = "connection_lost";

/// 存下来的一轮失败。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedTurnFailure {
    /// 适配器写的原话（记录的 title，空的时候是类别）。
    pub message: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// 这一轮收尾的时间。比它晚的用户消息说明已经是下一轮了。
    pub at: DateTime<Utc>,
    /// #1645：这一轮的用户消息是什么时候发出的（`SessionState::prompt_started_at`）。
    /// 刷新时只补到这条消息开头的那一轮；这版以前存的没有，照旧按时间补。
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_started_at: Option<DateTime<Utc>>,
}

fn key(conversation_id: i32) -> String {
    format!("{KEY_PREFIX}{conversation_id}")
}

/// 失败记录对应的 `TurnError::kind`。
pub fn kind_of(record: &SessionFailureRecord) -> Option<String> {
    crate::acp::connection::session_failure_ends_session(record)
        .then(|| KIND_CONNECTION_LOST.to_string())
}

/// 由一条失败记录得出要存的内容。
pub fn from_record(
    record: &SessionFailureRecord,
    at: DateTime<Utc>,
    prompt_started_at: Option<DateTime<Utc>>,
) -> PersistedTurnFailure {
    let title = record.title.trim();
    PersistedTurnFailure {
        message: if title.is_empty() {
            record.category.clone()
        } else {
            title.to_string()
        },
        kind: kind_of(record),
        at,
        prompt_started_at,
    }
}

/// #1555：每一轮的失败另记一份历史。「最近一轮」那条下一轮正常结束、被停止就
/// 清掉，被杀的那一轮点了「重试」、下一轮又被停止以后，刷新时它就补不回来了。
const HISTORY_KEY_PREFIX: &str = "cowork.turn_failure.history.conversation.";
/// 历史最多留这么多轮，更早的不再补失败行（和这版以前一样）。
const HISTORY_LIMIT: usize = 20;

fn history_key(conversation_id: i32) -> String {
    format!("{HISTORY_KEY_PREFIX}{conversation_id}")
}

async fn load_saved_history(
    db: &DatabaseConnection,
    conversation_id: i32,
) -> Vec<PersistedTurnFailure> {
    app_metadata_service::get_value(db, &history_key(conversation_id))
        .await
        .ok()
        .flatten()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub async fn save(
    db: &DatabaseConnection,
    conversation_id: i32,
    failure: &PersistedTurnFailure,
) -> Result<(), DbError> {
    let raw = serde_json::to_string(failure).unwrap_or_default();
    app_metadata_service::upsert_value(db, &key(conversation_id), &raw).await?;
    // 同一条失败可能存两遍，一样的不重复记。
    let mut history = load_saved_history(db, conversation_id).await;
    if history.contains(failure) {
        return Ok(());
    }
    history.push(failure.clone());
    if history.len() > HISTORY_LIMIT {
        history.drain(..history.len() - HISTORY_LIMIT);
    }
    let raw = serde_json::to_string(&history).unwrap_or_default();
    app_metadata_service::upsert_value(db, &history_key(conversation_id), &raw).await
}

/// 只清「最近一轮」那条（会话任务据它判断这一轮是不是失败的），历史不动。
pub async fn clear(db: &DatabaseConnection, conversation_id: i32) -> Result<(), DbError> {
    app_metadata_service::delete_value(db, &key(conversation_id)).await
}

/// 读不到、读坏了都当没有。
pub async fn load(db: &DatabaseConnection, conversation_id: i32) -> Option<PersistedTurnFailure> {
    let raw = app_metadata_service::get_value(db, &key(conversation_id))
        .await
        .ok()??;
    serde_json::from_str(&raw).ok()
}

fn is_turn_error_turn(turn: &MessageTurn) -> bool {
    matches!(turn.role, TurnRole::System)
        && !turn.blocks.is_empty()
        && turn
            .blocks
            .iter()
            .all(|block| matches!(block, ContentBlock::TurnError { .. }))
}

/// 这一轮被失败打断、没配上结果的工具调用（#1454：命令跑到一半智能体被杀）
/// 标成 `cancelled`，界面显示中断，不再当成已完成。智能体自己记了终态的不动。
fn mark_cut_off_calls(round: &mut [MessageTurn]) {
    let answered: std::collections::HashSet<String> = round
        .iter()
        .flat_map(|turn| turn.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::ToolResult {
                tool_use_id: Some(id),
                ..
            } => Some(id.clone()),
            _ => None,
        })
        .collect();
    for block in round.iter_mut().flat_map(|turn| turn.blocks.iter_mut()) {
        if let ContentBlock::ToolUse {
            tool_use_id: Some(id),
            status,
            ..
        } = block
        {
            let settled = status
                .as_deref()
                .is_some_and(|s| matches!(s.trim(), "completed" | "failed" | "cancelled"));
            if !settled && !answered.contains(id.as_str()) {
                *status = Some("cancelled".to_string());
            }
        }
    }
}

/// 这一轮被失败打断时，记录里最后一条往往是发起调用的那一刻（#1555：跑了一分钟
/// 的命令显示「1 秒」）。把最后一段回复的时长补到失败那一刻，各段时长加起来就是
/// 从发出到失败。记录本来就比失败晚的不动。返回加到时长上的毫秒数（会话的总
/// 时长要跟着加）。
fn extend_to_failure(round: &mut [MessageTurn], failed_at: DateTime<Utc>) -> u64 {
    let Some(last) = round
        .iter_mut()
        .rev()
        .find(|turn| matches!(turn.role, TurnRole::Assistant))
    else {
        return 0;
    };
    let end = last.completed_at.unwrap_or(last.timestamp);
    let Ok(extra) = u64::try_from((failed_at - end).num_milliseconds()) else {
        return 0;
    };
    if extra == 0 {
        return 0;
    }
    last.completed_at = Some(failed_at);
    match last.duration_ms {
        Some(duration) => {
            last.duration_ms = Some(duration + extra);
            extra
        }
        None => 0,
    }
}

/// 用户消息的时间和 prompt 开始的时间来自同一台机器，留几秒余量就够。
const PROMPT_CLOCK_SLACK_SECS: i64 = 5;

/// 按存下来的失败给它那一轮补一行失败说明，放在那一轮最后；返回补长的时长。
///
/// 那一轮是失败之前最后一条用户消息到下一条用户消息之间（#1555：被杀的那一轮
/// 点了「重试」以后，它已经不是最后一轮了）。不补的：失败之前没有用户消息；
/// 那条用户消息比这一轮 prompt 开始得早（#1645）；那一轮已经有失败行（智能体
/// 自己记下了，解析器拼得出来）。
pub fn inject(turns: &mut Vec<MessageTurn>, failure: &PersistedTurnFailure) -> u64 {
    let Some(start) = turns
        .iter()
        .rposition(|turn| matches!(turn.role, TurnRole::User) && turn.timestamp <= failure.at)
    else {
        return 0;
    };
    // #1645：知道这一轮 prompt 什么时候开始的，那一轮的用户消息就不会比它早
    // （智能体在收到 prompt 以后才记下它）。早的是之前已经回完的一轮：这一轮
    // 的消息没进记录，不往别的轮次下面挂失败、也不拉长它的时长。
    if let Some(started) = failure.prompt_started_at {
        if turns[start].timestamp < started - chrono::Duration::seconds(PROMPT_CLOCK_SLACK_SECS) {
            return 0;
        }
    }
    let end = turns[start + 1..]
        .iter()
        .position(|turn| matches!(turn.role, TurnRole::User))
        .map_or(turns.len(), |offset| start + 1 + offset);
    let round = &mut turns[start + 1..end];
    if round.iter().any(is_turn_error_turn) {
        return 0;
    }
    mark_cut_off_calls(round);
    let extra = extend_to_failure(round, failure.at);
    turns.insert(
        end,
        MessageTurn {
            // 每一轮一个 id：同一个对话里可能补好几行，前端按最后那一行的 id
            // 决定给不给「重试」。
            id: format!("cowork-turn-failure-{}", failure.at.timestamp_millis()),
            role: TurnRole::System,
            blocks: vec![ContentBlock::TurnError {
                message: failure.message.clone(),
                kind: failure.kind.clone(),
            }],
            timestamp: failure.at,
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: Some(failure.at),
            agent_message_id: None,
        },
    );
    extra
}

/// 存下来的每一轮失败都补回它自己那一轮（按时间先后），返回一共补长的时长
/// （毫秒）：调用方加进会话的总时长，和各段时长对得上。
pub fn inject_all(turns: &mut Vec<MessageTurn>, failures: &[PersistedTurnFailure]) -> u64 {
    failures.iter().map(|failure| inject(turns, failure)).sum()
}

/// 这个会话存下来的每一轮失败，按时间排好。这版以前只存了「最近一轮」那条的，
/// 也算进来。读不到、读坏了都当没有。
pub async fn load_history(
    db: &DatabaseConnection,
    conversation_id: i32,
) -> Vec<PersistedTurnFailure> {
    let mut history = load_saved_history(db, conversation_id).await;
    if let Some(latest) = load(db, conversation_id)
        .await
        .filter(|latest| !history.contains(latest))
    {
        history.push(latest);
    }
    history.sort_by_key(|failure| failure.at);
    history
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;

    fn at(secs: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(1_800_000_000 + secs, 0).unwrap()
    }

    fn turn(id: &str, role: TurnRole, blocks: Vec<ContentBlock>, ts: i64) -> MessageTurn {
        MessageTurn {
            id: id.into(),
            role,
            blocks,
            timestamp: at(ts),
            usage: None,
            duration_ms: None,
            model: None,
            completed_at: None,
            agent_message_id: None,
        }
    }

    fn text(t: &str) -> Vec<ContentBlock> {
        vec![ContentBlock::Text { text: t.into() }]
    }

    fn lost(ts: i64) -> PersistedTurnFailure {
        PersistedTurnFailure {
            message: "The connection to Claude was lost.".into(),
            kind: Some(KIND_CONNECTION_LOST.into()),
            at: at(ts),
            prompt_started_at: None,
        }
    }

    fn record(category: &str, actions: &[&str]) -> SessionFailureRecord {
        SessionFailureRecord {
            id: "t1:error".into(),
            revision: 1,
            category: category.into(),
            severity: "error".into(),
            title: " The connection to Claude was lost. ".into(),
            details: None,
            actions: actions.iter().map(|a| a.to_string()).collect(),
            resolved: false,
        }
    }

    #[test]
    fn a_lost_connection_record_is_kept_with_its_kind() {
        let saved = from_record(&record("connection", &["new_session"]), at(5), None);
        assert_eq!(saved, lost(5));
        assert_eq!(
            from_record(&record("limit", &["retry"]), at(5), None).kind,
            None
        );
    }

    #[test]
    fn the_failure_closes_the_last_round_after_a_reload() {
        let mut turns = vec![
            turn("turn-0", TurnRole::User, text("kill $PPID"), 0),
            turn("turn-1", TurnRole::Assistant, text("好"), 1),
        ];
        inject(&mut turns, &lost(2));
        assert_eq!(turns.len(), 3);
        assert!(matches!(turns[2].role, TurnRole::System));
        match &turns[2].blocks[..] {
            [ContentBlock::TurnError { message, kind }] => {
                assert_eq!(message, "The connection to Claude was lost.");
                assert_eq!(kind.as_deref(), Some(KIND_CONNECTION_LOST));
            }
            other => panic!("not a failure line: {other:?}"),
        }
    }

    fn tool_use(id: &str, status: Option<&str>) -> ContentBlock {
        ContentBlock::ToolUse {
            tool_use_id: Some(id.into()),
            tool_name: "Bash".into(),
            input_preview: None,
            status: status.map(String::from),
            meta: None,
        }
    }

    fn tool_result(id: &str) -> ContentBlock {
        ContentBlock::ToolResult {
            tool_use_id: Some(id.into()),
            output_preview: Some("ok".into()),
            is_error: false,
            agent_stats: None,
            images: Vec::new(),
            exit_code: None,
        }
    }

    fn status_of(turns: &[MessageTurn], id: &str) -> Option<String> {
        turns
            .iter()
            .flat_map(|turn| turn.blocks.iter())
            .find_map(|block| match block {
                ContentBlock::ToolUse {
                    tool_use_id: Some(tid),
                    status,
                    ..
                } if tid == id => Some(status.clone()),
                _ => None,
            })
            .flatten()
    }

    /// #1454：被打断的命令没有结果，补失败行时标成中断，界面不再写「全部通过」。
    /// 配上了结果的、上一轮的不动。
    #[test]
    fn calls_cut_off_by_the_failure_are_marked_cancelled() {
        let mut turns = vec![
            turn("turn-0", TurnRole::User, text("先前"), 0),
            turn(
                "turn-1",
                TurnRole::Assistant,
                vec![tool_use("old", None)],
                1,
            ),
            turn("turn-2", TurnRole::User, text("跑 dd"), 2),
            turn(
                "turn-3",
                TurnRole::Assistant,
                vec![
                    tool_use("bg", None),
                    tool_result("bg"),
                    tool_use("dd", None),
                ],
                3,
            ),
        ];
        inject(&mut turns, &lost(4));
        assert_eq!(status_of(&turns, "dd").as_deref(), Some("cancelled"));
        assert_eq!(status_of(&turns, "bg"), None);
        assert_eq!(status_of(&turns, "old"), None);
    }

    /// #1555：智能体跑了一分钟的命令被杀，记录里最后一条是发起调用（第 1 秒），
    /// 这一轮的时长要算到失败那一刻（第 60 秒），不是 1 秒。分在几段里的时长
    /// 加起来也到失败那一刻。
    #[test]
    fn the_cut_off_round_lasts_until_the_failure() {
        let mut thinking = turn("turn-1", TurnRole::Assistant, text("想一下"), 0);
        thinking.duration_ms = Some(500);
        thinking.completed_at = Some(at(0) + chrono::Duration::milliseconds(500));
        let mut dd = turn("turn-2", TurnRole::Assistant, vec![tool_use("dd", None)], 1);
        dd.duration_ms = Some(500);
        dd.completed_at = Some(at(1));
        let mut turns = vec![
            turn("turn-0", TurnRole::User, text("跑 dd"), 0),
            thinking,
            dd,
        ];
        inject(&mut turns, &lost(60));
        let total: u64 = turns.iter().filter_map(|t| t.duration_ms).sum();
        assert_eq!(total, 60_000);
        assert_eq!(turns[2].duration_ms, Some(59_500));
        assert_eq!(turns[2].completed_at, Some(at(60)));

        // 记录本来就比失败晚的（智能体自己写到了最后），时长不动。
        let mut late = turn("turn-1", TurnRole::Assistant, text("好"), 1);
        late.duration_ms = Some(9_000);
        late.completed_at = Some(at(9));
        let mut turns = vec![turn("turn-0", TurnRole::User, text("hi"), 0), late];
        inject(&mut turns, &lost(5));
        assert_eq!(turns[1].duration_ms, Some(9_000));
        assert_eq!(turns[1].completed_at, Some(at(9)));
    }

    /// #1645：两轮都正常回完以后进程才被杀，存下的失败对不上任何一轮的用户
    /// 消息（这一轮 prompt 的消息没进记录）：不补失败行，回完的那一轮时长不动。
    /// 对得上第二轮的，照旧补在第二轮、时长补到失败那一刻。
    #[test]
    fn a_failure_only_closes_the_round_its_prompt_started() {
        fn two_finished_rounds() -> Vec<MessageTurn> {
            let mut first = turn("turn-1", TurnRole::Assistant, text("你好！"), 0);
            first.duration_ms = Some(1_000);
            first.completed_at = Some(at(1));
            let mut second = turn("turn-3", TurnRole::Assistant, text("在的"), 60);
            second.duration_ms = Some(1_000);
            second.completed_at = Some(at(61));
            vec![
                turn("turn-0", TurnRole::User, text("你好"), 0),
                first,
                turn("turn-2", TurnRole::User, text("还在吗"), 60),
                second,
            ]
        }
        let mut stray = lost(143);
        stray.prompt_started_at = Some(at(130));
        let mut turns = two_finished_rounds();
        assert_eq!(inject(&mut turns, &stray), 0);
        assert_eq!(turns.len(), 4, "no failure line under a finished round");
        assert_eq!(turns[1].duration_ms, Some(1_000));
        assert_eq!(turns[3].duration_ms, Some(1_000));
        assert_eq!(turns[3].completed_at, Some(at(61)));

        let mut own = lost(143);
        own.prompt_started_at = Some(at(60));
        let mut turns = two_finished_rounds();
        assert_eq!(inject(&mut turns, &own), 82_000);
        assert_eq!(turns.len(), 5);
        assert!(is_turn_error_turn(&turns[4]));
        assert_eq!(turns[3].duration_ms, Some(83_000));
    }

    #[test]
    fn a_later_round_or_the_agents_own_record_is_left_alone() {
        // 失败以后又发了一条：那是下一轮的事。
        let mut later = vec![turn("turn-0", TurnRole::User, text("再来"), 10)];
        inject(&mut later, &lost(2));
        assert_eq!(later.len(), 1);

        // 智能体自己记下了失败。
        let mut own = vec![
            turn("turn-0", TurnRole::User, text("hi"), 0),
            turn(
                "turn-1",
                TurnRole::System,
                vec![ContentBlock::TurnError {
                    message: "API Error: 503".into(),
                    kind: None,
                }],
                1,
            ),
        ];
        inject(&mut own, &lost(2));
        assert_eq!(own.len(), 2);

        let mut empty = Vec::new();
        inject(&mut empty, &lost(2));
        assert!(empty.is_empty());
    }

    /// #1555 复现第 3 步：被杀的那一轮点了「重试」（发了下一条），下一轮又被停止。
    /// 刷新后被杀那一轮照样补回失败行、被打断的命令标成中断、时长到失败那一刻；
    /// 下一轮不动。补长的时长返回给调用方，加进会话的总时长。
    #[test]
    fn a_retried_round_keeps_its_own_failure() {
        let mut dd = turn("turn-1", TurnRole::Assistant, vec![tool_use("dd", None)], 1);
        dd.duration_ms = Some(1_000);
        dd.completed_at = Some(at(1));
        let mut retry = turn(
            "turn-3",
            TurnRole::Assistant,
            vec![tool_use("dd2", None)],
            71,
        );
        retry.duration_ms = Some(1_000);
        retry.completed_at = Some(at(71));
        let mut turns = vec![
            turn("turn-0", TurnRole::User, text("跑 dd"), 0),
            dd,
            turn("turn-2", TurnRole::User, text("跑 dd"), 70),
            retry,
        ];
        let extra = inject_all(&mut turns, &[lost(60)]);
        assert_eq!(status_of(&turns, "dd").as_deref(), Some("cancelled"));
        assert_eq!(status_of(&turns, "dd2"), None);
        assert_eq!(turns[1].duration_ms, Some(60_000));
        assert_eq!(extra, 59_000);
        assert!(is_turn_error_turn(&turns[2]), "failure line closes round 1");
        assert!(matches!(turns[3].role, TurnRole::User));
        assert_eq!(turns[4].duration_ms, Some(1_000));
        assert_eq!(turns.len(), 5);
    }

    /// 存了两轮失败（同一轮存了两遍只算一次），下一轮正常结束清掉的只是「最近
    /// 一轮」那条，历史还在，按时间排好。
    #[tokio::test]
    async fn every_failed_round_is_remembered() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        save(&db.conn, 7, &lost(60)).await.unwrap();
        save(&db.conn, 7, &lost(60)).await.unwrap();
        save(&db.conn, 7, &lost(90)).await.unwrap();
        clear(&db.conn, 7).await.unwrap();
        assert_eq!(load(&db.conn, 7).await, None);
        assert_eq!(load_history(&db.conn, 7).await, vec![lost(60), lost(90)]);
        assert!(load_history(&db.conn, 8).await.is_empty());
    }
}
