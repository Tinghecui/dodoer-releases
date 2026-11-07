use std::sync::Arc;

use axum::{Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::jenny_loop as loop_commands;
use crate::commands::jenny_loop::{LoopSessionPage, LoopSteerResult};
use crate::jenny_loop::LoopConversationDetail;
use crate::models::agent::AgentType;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLoopConversationParams {
    pub folder_id: i32,
}

pub async fn get_loop_conversation(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GetLoopConversationParams>,
) -> Result<Json<LoopConversationDetail>, AppCommandError> {
    Ok(Json(
        loop_commands::get_loop_conversation_core(&state.db.conn, params.folder_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetLoopSessionPageParams {
    pub agent_type: AgentType,
    pub session_id: String,
    pub before: Option<usize>,
    pub limit: Option<usize>,
    pub live: Option<bool>,
}

pub async fn get_loop_session_page(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<GetLoopSessionPageParams>,
) -> Result<Json<LoopSessionPage>, AppCommandError> {
    Ok(Json(
        loop_commands::get_loop_session_page_core(
            &state.db.conn,
            params.agent_type,
            params.session_id,
            params.before,
            params.limit,
            params.live.unwrap_or(false),
        )
        .await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SteerLoopParams {
    pub folder_id: i32,
    pub loop_id: String,
    pub message: String,
}

pub async fn steer_loop(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SteerLoopParams>,
) -> Result<Json<LoopSteerResult>, AppCommandError> {
    Ok(Json(
        loop_commands::steer_loop_core(
            &state.db.conn,
            params.folder_id,
            params.loop_id,
            params.message,
        )
        .await?,
    ))
}
