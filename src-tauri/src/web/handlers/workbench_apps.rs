use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::workbench_apps as app_commands;
use crate::workbench_apps::{
    WorkbenchApp, WorkbenchAppLog, WorkbenchAppStatus, WorkbenchAppsSnapshot,
};

pub async fn list_workbench_apps(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<WorkbenchAppsSnapshot>, AppCommandError> {
    Ok(Json(app_commands::list_workbench_apps_core(&state.db).await?))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveWorkbenchAppsParams {
    pub apps: Vec<WorkbenchApp>,
}

pub async fn save_workbench_apps(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<SaveWorkbenchAppsParams>,
) -> Result<Json<WorkbenchAppsSnapshot>, AppCommandError> {
    Ok(Json(
        app_commands::save_workbench_apps_core(&state.db, params.apps).await?,
    ))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkbenchAppIdParams {
    pub id: String,
}

pub async fn start_workbench_app(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WorkbenchAppIdParams>,
) -> Result<Json<WorkbenchAppStatus>, AppCommandError> {
    Ok(Json(
        app_commands::start_workbench_app_core(&state.db, params.id).await?,
    ))
}

pub async fn stop_workbench_app(
    Json(params): Json<WorkbenchAppIdParams>,
) -> Result<Json<WorkbenchAppStatus>, AppCommandError> {
    Ok(Json(app_commands::stop_workbench_app_core(params.id).await?))
}

pub async fn restart_workbench_app(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<WorkbenchAppIdParams>,
) -> Result<Json<WorkbenchAppStatus>, AppCommandError> {
    Ok(Json(
        app_commands::restart_workbench_app_core(&state.db, params.id).await?,
    ))
}

pub async fn read_workbench_app_log(
    Json(params): Json<WorkbenchAppIdParams>,
) -> Result<Json<WorkbenchAppLog>, AppCommandError> {
    Ok(Json(app_commands::read_workbench_app_log_core(params.id)?))
}
