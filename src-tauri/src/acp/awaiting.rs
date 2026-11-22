//! Cowork 加的：对话列表行上的「在等你」（移植自 dodoer #797 / #673 PR1 的接口格式）。
//!
//! 每个对话一个原因，从它最新那条没断开的连接读出来（判断和侧栏「等你回答」的
//! `acp_list_awaiting_user`（#707）是同一份：[`blocking_prompt`]），挂在
//! `list_all_conversations` 返回的行上（`DbConversationSummary::awaiting`），给手机
//! app（coteam-ios）的「需要你」那一栏用。只在内存里算，不落库，不写回任何状态。
//!
//! 只发原因和从什么时候开始等：命令、问题文字、计划正文会被每个能读列表的客户端
//! 看到，要细节的客户端照旧去问连接（`pet_list_active_sessions` / 会话快照）。
//!
//! 和 dodoer 不一样的地方：不在 `conversation://changed` 上发 `{kind:"awaiting"}`。
//! 已经发出去的网页端、桌面端、官方 codeg 客户端遇到不认识的 `kind` 会把它当成
//! `status`（`app-workspace-context.tsx`：行的状态被清成 `undefined`）或者当成删除
//! （`use-subsession-sync.ts`、`tab-store.ts` 的子会话），所以只在列表行上带。
//! 也没有 dodoer 的 `error` 原因（侧栏「等你回答」没有这一种）。

use std::collections::{HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use super::plan_approval::PendingPlanApprovalState;
use super::question::PendingQuestionState;
use super::session_state::{PendingPermissionState, SessionState, ToolCallState, ToolKind};

/// 声明顺序就是几个提示同时在时报哪个、父对话在几个子对话里挑哪个的顺序。
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AwaitingReason {
    Permission,
    Question,
    Plan,
}

/// 列表行上的 `awaiting`：`{"reason":"permission","since":"…","via_child":false}`。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationAwaiting {
    pub reason: AwaitingReason,
    /// 从什么时候开始等：那个提示自己的创建时间。
    pub since: DateTime<Utc>,
    /// 等的是委托出去的子对话（子孙），在这个对话的委托卡片上回答。
    #[serde(default)]
    pub via_child: bool,
}

/// 一条连接停在用户身上的那个提示。
pub(crate) enum BlockingPrompt<'a> {
    Permission(&'a PendingPermissionState),
    Question(&'a PendingQuestionState),
    Plan(&'a PendingPlanApprovalState),
}

/// 这条连接在等用户的哪个提示，没有就是 `None`。几个同时在时按前端叠在输入框上面的
/// 顺序：权限请求、提问、计划审批。一个问题都没有的提问不出卡片，和前端
/// `blockingPrompts` 一样不算。不看连接断没断开，调用的人自己跳过断开的连接。
pub(crate) fn blocking_prompt(state: &SessionState) -> Option<BlockingPrompt<'_>> {
    if let Some(permission) = state.pending_permission.as_ref() {
        return Some(BlockingPrompt::Permission(permission));
    }
    if let Some(question) = state
        .pending_question
        .as_ref()
        .filter(|q| !q.questions.is_empty())
    {
        return Some(BlockingPrompt::Question(question));
    }
    state
        .pending_plan_approval
        .as_ref()
        .map(BlockingPrompt::Plan)
}

/// 这条连接自己的原因（不含子对话）。其实是计划审批的权限请求（Claude Code 的
/// ExitPlanMode、codex 的计划评审）算 `plan`，和侧栏一样。
pub fn derive(state: &SessionState) -> Option<ConversationAwaiting> {
    let (reason, since) = match blocking_prompt(state)? {
        BlockingPrompt::Permission(permission) => {
            let live = state.active_tool_calls.get(&permission.tool_call_id);
            let reason = if is_plan_approval_permission(&permission.tool_call, live) {
                AwaitingReason::Plan
            } else {
                AwaitingReason::Permission
            };
            (reason, permission.created_at)
        }
        BlockingPrompt::Question(question) => (AwaitingReason::Question, question.created_at),
        BlockingPrompt::Plan(plan) => (AwaitingReason::Plan, plan.created_at),
    };
    Some(ConversationAwaiting {
        reason,
        since,
        via_child: false,
    })
}

/// 权限请求是不是其实是计划审批。前端 `isPlanApprovalPermission`
/// （`src/lib/blocking-prompts.ts`）的 Rust 版，两边都跑
/// `src/lib/plan-approval-cases.json` 里的例子，改一边要改另一边。
///
/// `live` 是会话里记着的这条请求的工具调用。和前端的合并一样，只补请求里没写的：
/// 输入、种类、Claude Code 的工具名。
pub fn is_plan_approval_permission(tool_call: &Value, live: Option<&ToolCallState>) -> bool {
    let parsed;
    let call = match tool_call {
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).ok();
            parsed.as_ref()
        }
        other => Some(other),
    };
    let Some(call) = call.and_then(Value::as_object) else {
        return false;
    };
    let meta = call.get("_meta").and_then(Value::as_object);
    let live_tool_name = live
        .and_then(|l| l.meta.as_ref())
        .and_then(Value::as_object)
        .and_then(claude_code_tool_name);
    let tool_name = meta.and_then(claude_code_tool_name).or(live_tool_name);
    let names = [
        tool_name,
        call.get("name").and_then(Value::as_str),
        call.get("toolName").and_then(Value::as_str),
        call.get("tool_name").and_then(Value::as_str),
    ];
    if names
        .into_iter()
        .flatten()
        .any(|name| normalize_tool_name(name) == "exitplanmode")
    {
        return true;
    }
    if meta
        .and_then(|m| m.get("codex"))
        .and_then(|c| c.get("kind"))
        .and_then(Value::as_str)
        == Some("plan_review")
    {
        return true;
    }
    let has_plan = plan_markdown(call)
        || (!has_input(call)
            && live
                .and_then(|l| l.input.as_ref())
                .and_then(Value::as_object)
                .is_some_and(|input| {
                    let mut wrapped = Map::new();
                    wrapped.insert("rawInput".into(), Value::Object(input.clone()));
                    plan_markdown(&wrapped)
                }));
    if !has_plan {
        return false;
    }
    let mut kind = call
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .trim()
        .to_string();
    // 会话只记得 ACP 认识的种类，别的（比如 `switch_mode`）都折成 `other`，所以
    // `other` 在这里什么也说明不了。
    if kind.is_empty() {
        if let Some(live) = live.filter(|l| l.kind != ToolKind::Other) {
            if let Ok(Value::String(live_kind)) = serde_json::to_value(&live.kind) {
                kind = live_kind;
            }
        }
    }
    kind.is_empty() || is_plan_mode_tool_name(&kind)
}

fn claude_code_tool_name(meta: &Map<String, Value>) -> Option<&str> {
    meta.get("claudeCode")?.get("toolName")?.as_str()
}

fn normalize_tool_name(name: &str) -> String {
    name.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn is_plan_mode_tool_name(name: &str) -> bool {
    matches!(
        normalize_tool_name(name).as_str(),
        "enterplanmode" | "exitplanmode" | "switchmode" | "planreview"
    )
}

fn non_empty_plan(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|plan| !plan.trim().is_empty())
}

/// 前端的 `extractPlanMarkdown`：`plan` / `Plan`，直接在上面或者在下一层的
/// `rawInput` / `raw_input` 里。
fn plan_markdown(input: &Map<String, Value>) -> bool {
    if non_empty_plan(input.get("plan").or_else(|| input.get("Plan"))) {
        return true;
    }
    let nested = input
        .get("rawInput")
        .filter(|v| v.is_object())
        .or_else(|| input.get("raw_input").filter(|v| v.is_object()));
    nested.is_some_and(|nested| non_empty_plan(nested.get("plan").or_else(|| nested.get("Plan"))))
}

fn has_input(call: &Map<String, Value>) -> bool {
    ["rawInput", "raw_input", "input"]
        .iter()
        .any(|key| call.get(*key).is_some_and(|v| !v.is_null()))
}

/// 一个对话在委托树里的位置：上一级是谁，结束了没有（完成、取消、删掉）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub(crate) struct ConversationLink {
    pub(crate) parent: Option<i32>,
    pub(crate) finished: bool,
}

/// 每个对话该显示的原因：结束了的什么都不显示；自己在等就是自己的；不然在它
/// 没结束的子孙里挑排在最前（再比等得最久）的那个，标上 `via_child`。结束了的
/// 子对话和它下面的都不往上传。`links` 里没有的对话当作没结束、没有上一级。
pub(crate) fn roll_up(
    own: &HashMap<i32, ConversationAwaiting>,
    links: &HashMap<i32, ConversationLink>,
) -> HashMap<i32, ConversationAwaiting> {
    let finished = |id: i32| links.get(&id).is_some_and(|l| l.finished);
    let parent_of = |id: i32| links.get(&id).and_then(|l| l.parent);
    let mut shown: HashMap<i32, ConversationAwaiting> = own
        .iter()
        .filter(|(id, _)| !finished(**id))
        .map(|(id, value)| (*id, value.clone()))
        .collect();
    let mut rolled: HashMap<i32, ConversationAwaiting> = HashMap::new();
    for (&id, value) in own {
        if finished(id) {
            continue;
        }
        let mut seen = HashSet::from([id]);
        let mut at = parent_of(id);
        while let Some(parent) = at {
            // 数据坏了成了环，也要停下来。
            if finished(parent) || !seen.insert(parent) {
                break;
            }
            if !own.contains_key(&parent) {
                let better = rolled
                    .get(&parent)
                    .is_none_or(|b| (value.reason, value.since) < (b.reason, b.since));
                if better {
                    let via = ConversationAwaiting {
                        via_child: true,
                        ..value.clone()
                    };
                    rolled.insert(parent, via);
                }
            }
            at = parent_of(parent);
        }
    }
    shown.extend(rolled);
    shown
}

/// 委托链最多往上找几层（防止数据坏了一直查库）。
const MAX_DEPTH: usize = 16;

/// 给列表行填上 `awaiting`。在等的对话不在 `rows` 里（子对话默认不列）时，顺着库里的
/// `parent_id` 往上找到列表里的祖先。平常没有对话在等，什么都不查。
pub async fn fill_list_awaiting(
    manager: &super::manager::ConnectionManager,
    conn: &sea_orm::DatabaseConnection,
    rows: &mut [crate::models::DbConversationSummary],
) {
    let own = manager.awaiting_by_conversation().await;
    if own.is_empty() {
        return;
    }
    let mut links: HashMap<i32, ConversationLink> = rows
        .iter()
        .map(|row| {
            let link = ConversationLink {
                parent: row.parent_id,
                finished: is_finished_status(&row.status),
            };
            (row.id, link)
        })
        .collect();
    for &start in own.keys() {
        let mut at = Some(start);
        for _ in 0..MAX_DEPTH {
            let Some(id) = at else {
                break;
            };
            let link = if let Some(link) = links.get(&id).copied() {
                link
            } else {
                let link = load_link(conn, id).await;
                links.insert(id, link);
                link
            };
            at = link.parent;
        }
    }
    let shown = roll_up(&own, &links);
    for row in rows {
        row.awaiting = shown.get(&row.id).cloned();
    }
}

fn is_finished_status(status: &str) -> bool {
    matches!(status, "completed" | "cancelled")
}

/// 库里找不到、删掉了的对话当作结束了，什么都不往上传。
async fn load_link(conn: &sea_orm::DatabaseConnection, id: i32) -> ConversationLink {
    use crate::db::entities::conversation::{self, ConversationStatus};
    use sea_orm::EntityTrait;
    match conversation::Entity::find_by_id(id).one(conn).await {
        Ok(Some(row)) => ConversationLink {
            parent: row.parent_id,
            finished: row.deleted_at.is_some()
                || matches!(
                    row.status,
                    ConversationStatus::Completed | ConversationStatus::Cancelled
                ),
        },
        Ok(None) => ConversationLink {
            parent: None,
            finished: true,
        },
        Err(error) => {
            tracing::warn!(conversation_id = id, %error, "awaiting: read conversation");
            ConversationLink::default()
        }
    }
}

#[cfg(test)]
#[path = "awaiting_tests.rs"]
mod tests;
