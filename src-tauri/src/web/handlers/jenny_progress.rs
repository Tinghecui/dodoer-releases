use axum::Json;
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::commands::jenny_progress as progress_commands;
use crate::jenny_progress::JennyProgressDetail;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GetJennyProgressParams {
    pub session_id: String,
}

pub async fn get_jenny_progress(
    Json(params): Json<GetJennyProgressParams>,
) -> Result<Json<JennyProgressDetail>, AppCommandError> {
    Ok(Json(
        progress_commands::get_jenny_progress_core(params.session_id).await?,
    ))
}
