//! Cowork fork: every conversation keeps its own model and mode, and the last
//! pick an agent confirmed is the default for new conversations.
//!
//! Upstream keeps ONE set of preferred selector values per agent type, in each
//! browser's localStorage, and replays it on every connect — the resume of an
//! existing session included. Switching session A to Fable therefore switched
//! session B to Fable the next time B reconnected, and the web client and the
//! desktop app each had their own idea of the default. Here the server decides
//! what a connect applies:
//!
//! - resuming a session a conversation owns applies that conversation's own
//!   values (what its agent last reported), and nothing when none were recorded
//!   yet: the agent's own default is then the truth, not another conversation's
//!   pick;
//! - a brand-new session applies the server-side default for the agent type,
//!   with what the client sent filling the ids the server has no default for.
//!
//! Both live in `app_metadata` (key → JSON): no migration, and nothing added to
//! the upstream `conversation` table to conflict with.

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;

use crate::acp::connection::SetterOutcome;
use crate::acp::error::AcpError;
use crate::acp::manager::ConnectionManager;
use crate::acp::session_state::SessionState;
use crate::acp::types::{SessionConfigKindInfo, SessionConfigOptionInfo};
use crate::db::entities::conversation;
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;
use crate::models::agent::AgentType;

/// The selector values a session runs with: the legacy mode channel and the
/// config options by id — what a connect hands the preference replay.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct SessionPrefs {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mode_id: Option<String>,
    #[serde(default)]
    pub config_values: BTreeMap<String, String>,
}

impl SessionPrefs {
    fn is_empty(&self) -> bool {
        self.mode_id.is_none() && self.config_values.is_empty()
    }
}

const CONVERSATION_KEY_PREFIX: &str = "cowork.session_prefs.conversation.";
const DEFAULT_KEY_PREFIX: &str = "cowork.session_prefs.default.";

/// How long a user's pick waits for the agent's answer. Past it the request is
/// left to finish on its own; only a confirmed answer makes it the default.
const SETTER_WAIT: Duration = Duration::from_secs(15);

fn conversation_key(conversation_id: i32) -> String {
    format!("{CONVERSATION_KEY_PREFIX}{conversation_id}")
}

fn default_key(agent_type: AgentType) -> String {
    format!("{DEFAULT_KEY_PREFIX}{}", agent_type_str(agent_type))
}

/// The agent type as `conversation.agent_type` stores it (`claude_code`).
fn agent_type_str(agent_type: AgentType) -> String {
    serde_json::to_value(agent_type)
        .ok()
        .and_then(|v| v.as_str().map(String::from))
        .unwrap_or_default()
}

async fn load(db: &DatabaseConnection, key: &str) -> Result<Option<SessionPrefs>, DbError> {
    let Some(raw) = app_metadata_service::get_value(db, key).await? else {
        return Ok(None);
    };
    // A value this build cannot read counts as absent, never as an error: a
    // connect must not fail over a remembered selector.
    let prefs = serde_json::from_str::<SessionPrefs>(&raw).ok();
    Ok(prefs.filter(|p| !p.is_empty()))
}

async fn store(db: &DatabaseConnection, key: &str, prefs: &SessionPrefs) -> Result<(), DbError> {
    let raw = serde_json::to_string(prefs)
        .map_err(|e| DbError::Migration(format!("session prefs: {e}")))?;
    app_metadata_service::upsert_value(db, key, &raw).await
}

/// What a connect applies, given what the server knows.
///
/// `own` is `Some` when the session being resumed belongs to a conversation:
/// the values recorded for it, or `None` when nothing was recorded yet. That
/// conversation gets exactly its own values — never the default, never what
/// the client sent: both are some other conversation's pick. A new session
/// gets the default, which wins per id over what the client sent, so every
/// client starts a new conversation the same way.
pub fn choose_connect_prefs(
    own: Option<Option<SessionPrefs>>,
    default: Option<SessionPrefs>,
    client: SessionPrefs,
) -> SessionPrefs {
    if let Some(own) = own {
        return own.unwrap_or_default();
    }
    let Some(default) = default else {
        return client;
    };
    let mut config_values = client.config_values;
    config_values.extend(default.config_values);
    SessionPrefs {
        mode_id: default.mode_id.or(client.mode_id),
        config_values,
    }
}

/// [`choose_connect_prefs`] for one `acp_connect`. A failed lookup falls back
/// to what the client sent — the behavior before this existed — rather than
/// failing the connect.
pub async fn resolve_connect_prefs(
    db: &DatabaseConnection,
    agent_type: AgentType,
    session_id: Option<&str>,
    client_mode_id: Option<String>,
    client_config_values: BTreeMap<String, String>,
) -> SessionPrefs {
    let client = SessionPrefs {
        mode_id: client_mode_id,
        config_values: client_config_values,
    };
    let known = async {
        let own = match session_id {
            Some(sid) => match conversation_for_session(db, agent_type, sid).await? {
                Some(cid) => Some(load(db, &conversation_key(cid)).await?),
                None => None,
            },
            None => None,
        };
        let default = load(db, &default_key(agent_type)).await?;
        Ok::<_, DbError>((own, default))
    }
    .await;
    match known {
        Ok((own, default)) => choose_connect_prefs(own, default, client),
        Err(e) => {
            tracing::warn!("[session-prefs] lookup failed, applying the client's picks: {e}");
            client
        }
    }
}

/// The live conversation that owns `session_id` (the agent's own session id).
async fn conversation_for_session(
    db: &DatabaseConnection,
    agent_type: AgentType,
    session_id: &str,
) -> Result<Option<i32>, DbError> {
    let row = conversation::Entity::find()
        .filter(conversation::Column::ExternalId.eq(session_id))
        .filter(conversation::Column::AgentType.eq(agent_type_str(agent_type)))
        .filter(conversation::Column::DeletedAt.is_null())
        .order_by_desc(conversation::Column::UpdatedAt)
        .one(db)
        .await?;
    Ok(row.map(|r| r.id))
}

/// The values a session's agent reports, in the shape a connect replays.
/// Empty values are left out: replaying one could only fail.
fn reported_prefs(
    current_mode: Option<&str>,
    config_options: Option<&[SessionConfigOptionInfo]>,
) -> SessionPrefs {
    let config_values = config_options
        .unwrap_or_default()
        .iter()
        .map(|opt| {
            let value = match &opt.kind {
                SessionConfigKindInfo::Select(sel) => sel.current_value.clone(),
                SessionConfigKindInfo::Boolean(b) => b.current_value.to_string(),
            };
            (opt.id.clone(), value)
        })
        .filter(|(_, value)| !value.is_empty())
        .collect();
    SessionPrefs {
        mode_id: current_mode.filter(|m| !m.is_empty()).map(str::to_string),
        config_values,
    }
}

/// Record what `state`'s agent reports right now as its conversation's own
/// values. Runs on every selector report and when a connection is bound to its
/// conversation. A connection not bound yet — a resumed session before its
/// first prompt — finds its conversation through the session id; a session no
/// conversation owns yet (a new one before its first prompt) records nothing,
/// and the bind at that first prompt does.
pub async fn record_current(
    db: &DatabaseConnection,
    state: &Arc<RwLock<SessionState>>,
) -> Result<(), DbError> {
    let (conversation_id, external_id, agent_type, prefs) = {
        let s = state.read().await;
        (
            s.conversation_id,
            s.external_id.clone(),
            s.agent_type,
            reported_prefs(s.current_mode.as_deref(), s.config_options.as_deref()),
        )
    };
    if prefs.is_empty() {
        return Ok(());
    }
    let conversation_id = match (conversation_id, external_id) {
        (Some(cid), _) => cid,
        (None, Some(sid)) => match conversation_for_session(db, agent_type, &sid).await? {
            Some(cid) => cid,
            None => return Ok(()),
        },
        (None, None) => return Ok(()),
    };
    let key = conversation_key(conversation_id);
    if load(db, &key).await?.as_ref() == Some(&prefs) {
        return Ok(());
    }
    store(db, &key, &prefs).await
}

/// `acp_set_config_option`: forward the user's pick and, once the agent
/// confirms it, make it the default for new conversations of this agent type.
/// An error the agent answers with is already on screen (the connection emits
/// it), so — as before — only a connection that is gone fails the call.
pub async fn set_config_option(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
    conn_id: &str,
    config_id: String,
    value_id: String,
) -> Result<(), AcpError> {
    let agent_type = agent_type_of(manager, conn_id).await;
    let (id, value) = (config_id.clone(), value_id.clone());
    let answer = manager.set_config_option_and_wait(conn_id, id, value);
    let answer = tokio::time::timeout(SETTER_WAIT, answer).await;
    let Some(current) = confirmed(answer)? else {
        return Ok(());
    };
    if current != value_id {
        return Ok(());
    }
    if let Some(agent_type) = agent_type {
        remember_default(db, agent_type, |d| {
            d.config_values.insert(config_id, current);
        })
        .await;
    }
    Ok(())
}

/// `acp_set_mode`, the same way as [`set_config_option`].
pub async fn set_mode(
    manager: &ConnectionManager,
    db: &DatabaseConnection,
    conn_id: &str,
    mode_id: String,
) -> Result<(), AcpError> {
    let agent_type = agent_type_of(manager, conn_id).await;
    let answer = manager.set_mode_and_wait(conn_id, mode_id.clone());
    let answer = tokio::time::timeout(SETTER_WAIT, answer).await;
    let Some(current) = confirmed(answer)? else {
        return Ok(());
    };
    if current != mode_id {
        return Ok(());
    }
    if let Some(agent_type) = agent_type {
        remember_default(db, agent_type, |d| d.mode_id = Some(current)).await;
    }
    Ok(())
}

/// The value a setter's answer says is now in effect. `Ok(None)` for every
/// answer that names none (the agent took it without saying, refused it, or
/// had not answered in time) and for an agent error, which the connection has
/// already surfaced; `Err` only when the connection is gone.
fn confirmed(
    answer: Result<Result<SetterOutcome, AcpError>, tokio::time::error::Elapsed>,
) -> Result<Option<String>, AcpError> {
    match answer {
        Ok(Ok(SetterOutcome::Confirmed { current })) => Ok(Some(current)),
        Ok(Ok(_)) | Ok(Err(AcpError::Protocol(_))) | Err(_) => Ok(None),
        Ok(Err(e)) => Err(e),
    }
}

async fn agent_type_of(manager: &ConnectionManager, conn_id: &str) -> Option<AgentType> {
    let state = manager.get_state(conn_id).await?;
    let agent_type = state.read().await.agent_type;
    Some(agent_type)
}

async fn remember_default(
    db: &DatabaseConnection,
    agent_type: AgentType,
    change: impl FnOnce(&mut SessionPrefs),
) {
    let key = default_key(agent_type);
    let saved = async {
        let mut prefs = load(db, &key).await?.unwrap_or_default();
        change(&mut prefs);
        store(db, &key, &prefs).await
    }
    .await;
    if let Err(e) = saved {
        tracing::warn!("[session-prefs] could not save the default for {agent_type}: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::acp::types::{SessionConfigBooleanInfo, SessionConfigSelectInfo};
    use crate::db::test_helpers;
    use sea_orm::{ActiveModelTrait, Set};

    fn prefs(mode: Option<&str>, values: &[(&str, &str)]) -> SessionPrefs {
        SessionPrefs {
            mode_id: mode.map(str::to_string),
            config_values: values
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect(),
        }
    }

    fn select(id: &str, current: &str) -> SessionConfigOptionInfo {
        SessionConfigOptionInfo {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            category: None,
            kind: SessionConfigKindInfo::Select(SessionConfigSelectInfo {
                current_value: current.to_string(),
                options: Vec::new(),
                groups: Vec::new(),
            }),
            recommended_value: None,
        }
    }

    async fn conversation_with_session(db: &crate::db::AppDatabase, session_id: &str) -> i32 {
        let folder_id = test_helpers::seed_folder(db, "/tmp/session-prefs").await;
        let id = test_helpers::seed_conversation(db, folder_id, AgentType::ClaudeCode).await;
        let row = conversation::Entity::find_by_id(id)
            .one(&db.conn)
            .await
            .unwrap()
            .unwrap();
        let mut row: conversation::ActiveModel = row.into();
        row.external_id = Set(Some(session_id.to_string()));
        row.update(&db.conn).await.unwrap();
        id
    }

    fn state_reporting(
        conversation_id: Option<i32>,
        external_id: Option<&str>,
        options: Vec<SessionConfigOptionInfo>,
    ) -> Arc<RwLock<SessionState>> {
        let mut state = SessionState::new(
            "c1".to_string(),
            AgentType::ClaudeCode,
            None,
            "test-window".to_string(),
            None,
        );
        state.conversation_id = conversation_id;
        state.external_id = external_id.map(str::to_string);
        state.current_mode = Some("plan".to_string());
        state.config_options = Some(options);
        Arc::new(RwLock::new(state))
    }

    #[test]
    fn a_resumed_conversation_gets_only_its_own_values() {
        let own = prefs(Some("plan"), &[("model", "opus")]);
        let default = prefs(Some("default"), &[("model", "fable"), ("effort", "high")]);
        let client = prefs(Some("acceptEdits"), &[("model", "haiku")]);
        let chosen = choose_connect_prefs(Some(Some(own.clone())), Some(default), client);
        assert_eq!(chosen, own);
    }

    #[test]
    fn a_conversation_with_nothing_recorded_gets_nothing() {
        let default = prefs(None, &[("model", "fable")]);
        let client = prefs(Some("plan"), &[("model", "haiku")]);
        let chosen = choose_connect_prefs(Some(None), Some(default), client);
        assert_eq!(chosen, SessionPrefs::default());
    }

    #[test]
    fn a_new_session_gets_the_default_over_the_clients_picks() {
        let default = prefs(None, &[("model", "fable")]);
        let client = prefs(Some("plan"), &[("model", "haiku"), ("effort", "low")]);
        let chosen = choose_connect_prefs(None, Some(default), client);
        assert_eq!(
            chosen,
            prefs(Some("plan"), &[("model", "fable"), ("effort", "low")])
        );
    }

    #[test]
    fn a_new_session_without_a_default_gets_the_clients_picks() {
        let client = prefs(Some("plan"), &[("model", "haiku")]);
        assert_eq!(choose_connect_prefs(None, None, client.clone()), client);
    }

    #[test]
    fn reported_values_leave_out_empty_ones() {
        let options = vec![
            select("model", "opus"),
            select("effort", ""),
            SessionConfigOptionInfo {
                kind: SessionConfigKindInfo::Boolean(SessionConfigBooleanInfo {
                    current_value: true,
                }),
                ..select("fast", "")
            },
        ];
        assert_eq!(
            reported_prefs(Some("plan"), Some(&options)),
            prefs(Some("plan"), &[("model", "opus"), ("fast", "true")])
        );
        assert_eq!(reported_prefs(Some(""), None), SessionPrefs::default());
    }

    #[tokio::test]
    async fn a_recorded_conversation_resumes_on_its_own_model() {
        let db = test_helpers::fresh_in_memory_db().await;
        let cid = conversation_with_session(&db, "sess-a").await;
        let state = state_reporting(Some(cid), Some("sess-a"), vec![select("model", "opus")]);
        record_current(&db.conn, &state).await.unwrap();
        store(
            &db.conn,
            &default_key(AgentType::ClaudeCode),
            &prefs(None, &[("model", "fable")]),
        )
        .await
        .unwrap();

        let resumed = resolve_connect_prefs(
            &db.conn,
            AgentType::ClaudeCode,
            Some("sess-a"),
            None,
            BTreeMap::from([("model".to_string(), "fable".to_string())]),
        )
        .await;
        assert_eq!(resumed, prefs(Some("plan"), &[("model", "opus")]));

        let at = AgentType::ClaudeCode;
        let fresh = resolve_connect_prefs(&db.conn, at, None, None, BTreeMap::new()).await;
        assert_eq!(fresh, prefs(None, &[("model", "fable")]));
    }

    #[tokio::test]
    async fn an_unbound_connection_records_through_its_session_id() {
        let db = test_helpers::fresh_in_memory_db().await;
        let cid = conversation_with_session(&db, "sess-b").await;
        let state = state_reporting(None, Some("sess-b"), vec![select("model", "sonnet")]);
        record_current(&db.conn, &state).await.unwrap();
        let saved = load(&db.conn, &conversation_key(cid)).await.unwrap();
        assert_eq!(saved, Some(prefs(Some("plan"), &[("model", "sonnet")])));

        // A session no conversation owns yet records nothing.
        let draft = state_reporting(None, Some("sess-new"), vec![select("model", "haiku")]);
        record_current(&db.conn, &draft).await.unwrap();
        let at = AgentType::ClaudeCode;
        let other = conversation_for_session(&db.conn, at, "sess-new")
            .await
            .unwrap();
        assert_eq!(other, None);
    }
}
