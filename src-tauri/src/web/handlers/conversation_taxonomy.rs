use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::conversation_taxonomy as taxonomy_commands;
use crate::taxonomy::service::TaxonomyView;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTaxonomyGetParams {
    pub folder_id: i32,
}

pub async fn conversation_taxonomy_get(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationTaxonomyGetParams>,
) -> Result<Json<TaxonomyView>, AppCommandError> {
    Ok(Json(
        taxonomy_commands::conversation_taxonomy_get_core(&state.db, params.folder_id).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationTaxonomyAssignParams {
    pub conversation_id: i32,
    /// Absent or null = take it out of every category.
    #[serde(default)]
    pub category_id: Option<String>,
}

pub async fn conversation_taxonomy_assign(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationTaxonomyAssignParams>,
) -> Result<Json<TaxonomyView>, AppCommandError> {
    Ok(Json(
        taxonomy_commands::conversation_taxonomy_assign_core(
            &state.emitter,
            &state.db,
            params.conversation_id,
            params.category_id,
        )
        .await?,
    ))
}

pub async fn conversation_unopenable_list(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ConversationTaxonomyGetParams>,
) -> Result<Json<Vec<i32>>, AppCommandError> {
    Ok(Json(
        taxonomy_commands::conversation_unopenable_list_core(&state.db, params.folder_id).await?,
    ))
}
