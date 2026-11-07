//! jenny fork: the conversation mind map's commands — reading a project's
//! map and moving one conversation by hand. The nightly reorganization comes
//! in through `codeg-cli taxonomy` instead (`cli_run::taxonomy`). See
//! `crate::taxonomy`.

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use std::collections::BTreeMap;

use crate::app_error::AppCommandError;
use crate::db::entities::conversation::ConversationStatus;
use crate::db::service::agent_setting_service;
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::parsers::build_agent_parser;
use crate::taxonomy::service::{self, TaxonomyError, TaxonomyView};
use crate::web::event_bridge::EventEmitter;

impl From<TaxonomyError> for AppCommandError {
    fn from(err: TaxonomyError) -> Self {
        let message = err.to_string();
        match err {
            TaxonomyError::Db(db) => AppCommandError::from(db),
            TaxonomyError::FolderNotFound(_)
            | TaxonomyError::ConversationNotFound(_)
            | TaxonomyError::CategoryNotFound(_) => AppCommandError::not_found(message),
            TaxonomyError::NotAProject(_)
            | TaxonomyError::NotPlaceable(_)
            | TaxonomyError::PlanShape(_)
            | TaxonomyError::Plan(_) => AppCommandError::invalid_input(message),
        }
    }
}

/// The mind map of the project `folder_id` belongs to (a worktree's is its
/// repository's).
pub async fn conversation_taxonomy_get_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<TaxonomyView, AppCommandError> {
    Ok(service::view(&db.conn, folder_id).await?)
}

/// Move a conversation into `category_id`, or out of every category with
/// `None`. Broadcasts `conversation-taxonomy://changed`.
pub async fn conversation_taxonomy_assign_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    conversation_id: i32,
    category_id: Option<String>,
) -> Result<TaxonomyView, AppCommandError> {
    Ok(service::assign_manual(&db.conn, emitter, conversation_id, category_id).await?)
}

/// The conversations of `folder_id`'s project that would open empty: their
/// agent's history no longer holds the session (deleted, or moved away), or
/// they never got a session id. A running conversation is never listed — its
/// file may simply not be written yet — and neither is one whose agent cannot
/// tell from file names alone (see `AgentParser::session_ids`).
pub async fn conversation_unopenable_list_core(
    db: &AppDatabase,
    folder_id: i32,
) -> Result<Vec<i32>, AppCommandError> {
    let root = service::root_of_folder(&db.conn, folder_id).await?;
    let rows = service::project_conversation_rows(&db.conn, root.id)
        .await
        .map_err(AppCommandError::from)?;
    let mut by_agent: BTreeMap<String, Vec<(i32, Option<String>)>> = BTreeMap::new();
    for row in rows {
        if row.status == ConversationStatus::InProgress {
            continue;
        }
        by_agent
            .entry(row.agent_type)
            .or_default()
            .push((row.id, row.external_id));
    }
    let mut unopenable = Vec::new();
    for (agent, members) in by_agent {
        let Ok(agent_type) =
            serde_json::from_value::<AgentType>(serde_json::Value::String(agent))
        else {
            continue;
        };
        let env = agent_setting_service::load_agent_env(&db.conn, agent_type).await;
        let known = tokio::task::spawn_blocking(move || {
            build_agent_parser(agent_type, &env).session_ids()
        })
        .await
        .map_err(|e| {
            AppCommandError::task_execution_failed("Failed to list the agent's sessions")
                .with_detail(e.to_string())
        })?;
        let Some(known) = known else { continue };
        unopenable.extend(
            members
                .into_iter()
                .filter(|(_, external_id)| {
                    external_id.as_ref().is_none_or(|id| !known.contains(id))
                })
                .map(|(id, _)| id),
        );
    }
    unopenable.sort_unstable();
    Ok(unopenable)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn conversation_unopenable_list(
    db: State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<Vec<i32>, AppCommandError> {
    conversation_unopenable_list_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn conversation_taxonomy_get(
    db: State<'_, AppDatabase>,
    folder_id: i32,
) -> Result<TaxonomyView, AppCommandError> {
    conversation_taxonomy_get_core(&db, folder_id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn conversation_taxonomy_assign(
    app: tauri::AppHandle,
    db: State<'_, AppDatabase>,
    conversation_id: i32,
    category_id: Option<String>,
) -> Result<TaxonomyView, AppCommandError> {
    conversation_taxonomy_assign_core(&EventEmitter::Tauri(app), &db, conversation_id, category_id)
        .await
}
