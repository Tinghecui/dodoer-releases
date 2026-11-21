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
pub fn from_record(record: &SessionFailureRecord, at: DateTime<Utc>) -> PersistedTurnFailure {
    let title = record.title.trim();
    PersistedTurnFailure {
        message: if title.is_empty() {
            record.category.clone()
        } else {
            title.to_string()
        },
        kind: kind_of(record),
        at,
    }
}

pub async fn save(
    db: &DatabaseConnection,
    conversation_id: i32,
    failure: &PersistedTurnFailure,
) -> Result<(), DbError> {
    let raw = serde_json::to_string(failure).unwrap_or_default();
    app_metadata_service::upsert_value(db, &key(conversation_id), &raw).await
}

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

/// 最后一轮没有失败行的，按存下来的失败补一行，放在最后。
///
/// 不补的：最后一条用户消息比失败晚（已经是下一轮了）；最后一条用户消息之后
/// 已经有失败行（智能体自己记下了，解析器拼得出来）。没有用户消息的对话也不补。
pub fn inject(turns: &mut Vec<MessageTurn>, failure: &PersistedTurnFailure) {
    let Some(last_user) = turns
        .iter()
        .rposition(|turn| matches!(turn.role, TurnRole::User))
    else {
        return;
    };
    if turns[last_user].timestamp > failure.at {
        return;
    }
    if turns[last_user + 1..].iter().any(is_turn_error_turn) {
        return;
    }
    turns.push(MessageTurn {
        id: "cowork-turn-failure".to_string(),
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
    });
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
        let saved = from_record(&record("connection", &["new_session"]), at(5));
        assert_eq!(saved, lost(5));
        assert_eq!(from_record(&record("limit", &["retry"]), at(5)).kind, None);
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
}
