//! Commands of the Apps page (`crate::workbench_apps`): the saved list with
//! every app's status, saving it, and starting / stopping an app's service.
//! The `_core` functions serve both the desktop commands and the axum
//! handlers in `web::handlers::workbench_apps`.

#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::db::AppDatabase;
use crate::workbench_apps::{
    self, WorkbenchApp, WorkbenchAppLog, WorkbenchAppStatus, WorkbenchAppsSnapshot,
};

pub async fn list_workbench_apps_core(
    db: &AppDatabase,
) -> Result<WorkbenchAppsSnapshot, AppCommandError> {
    workbench_apps::snapshot(db).await
}

/// Save the list whole. Apps that are gone have their service stopped, and a
/// new `auto` app is started, before this returns the list as stored.
pub async fn save_workbench_apps_core(
    db: &AppDatabase,
    apps: Vec<WorkbenchApp>,
) -> Result<WorkbenchAppsSnapshot, AppCommandError> {
    workbench_apps::save(db, apps).await
}

pub async fn start_workbench_app_core(
    db: &AppDatabase,
    id: String,
) -> Result<WorkbenchAppStatus, AppCommandError> {
    // The list as stored, so a start right after a save in another window
    // knows the app.
    workbench_apps::refresh_apps(db).await?;
    workbench_apps::start_app(&id).await
}

pub async fn stop_workbench_app_core(id: String) -> Result<WorkbenchAppStatus, AppCommandError> {
    workbench_apps::stop_app(&id).await
}

pub async fn restart_workbench_app_core(
    db: &AppDatabase,
    id: String,
) -> Result<WorkbenchAppStatus, AppCommandError> {
    workbench_apps::refresh_apps(db).await?;
    workbench_apps::restart_app(&id).await
}

pub fn read_workbench_app_log_core(id: String) -> Result<WorkbenchAppLog, AppCommandError> {
    workbench_apps::read_log(&id)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn list_workbench_apps(
    db: State<'_, AppDatabase>,
) -> Result<WorkbenchAppsSnapshot, AppCommandError> {
    list_workbench_apps_core(&db).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_workbench_apps(
    db: State<'_, AppDatabase>,
    apps: Vec<WorkbenchApp>,
) -> Result<WorkbenchAppsSnapshot, AppCommandError> {
    save_workbench_apps_core(&db, apps).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn start_workbench_app(
    db: State<'_, AppDatabase>,
    id: String,
) -> Result<WorkbenchAppStatus, AppCommandError> {
    start_workbench_app_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn stop_workbench_app(id: String) -> Result<WorkbenchAppStatus, AppCommandError> {
    stop_workbench_app_core(id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn restart_workbench_app(
    db: State<'_, AppDatabase>,
    id: String,
) -> Result<WorkbenchAppStatus, AppCommandError> {
    restart_workbench_app_core(&db, id).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn read_workbench_app_log(id: String) -> Result<WorkbenchAppLog, AppCommandError> {
    read_workbench_app_log_core(id)
}
