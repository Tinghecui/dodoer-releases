use std::sync::Arc;

use axum::{extract::Extension, Json};
use serde::Deserialize;

use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::commands::terminal::prepare_credential_env;
use crate::terminal::manager::SpawnOptions;
use crate::terminal::types::{TerminalInfo, TerminalSnapshot};

// ---------------------------------------------------------------------------
// Param structs
// ---------------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSpawnParams {
    pub working_dir: String,
    pub shell: Option<String>,
    pub initial_command: Option<String>,
    pub terminal_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIdParams {
    pub terminal_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalKillParams {
    pub terminal_id: String,
    /// Stop the process but keep the terminal's final output (see
    /// `TerminalManager::stop`) instead of closing the terminal.
    #[serde(default)]
    pub keep_output: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalWriteParams {
    pub terminal_id: String,
    pub data: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalResizeParams {
    pub terminal_id: String,
    pub cols: u16,
    pub rows: u16,
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

pub async fn terminal_spawn(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalSpawnParams>,
) -> Result<Json<String>, AppCommandError> {
    let manager = &state.terminal_manager;
    let terminal_id = params
        .terminal_id
        .filter(|id| !id.is_empty() && id.len() <= 256)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());

    let extra_env = prepare_credential_env(&state.data_dir);

    let id = manager
        .spawn_with_id(
            SpawnOptions {
                terminal_id,
                working_dir: params.working_dir,
                owner_window_label: "web".to_string(),
                shell: params.shell,
                initial_command: params.initial_command,
                extra_env,
                temp_files: vec![],
            },
            state.emitter.clone(),
        )
        .map_err(AppCommandError::from)?;

    Ok(Json(id))
}

pub async fn terminal_write(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalWriteParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = &state.terminal_manager;
    manager
        .write(&params.terminal_id, params.data.as_bytes())
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

pub async fn terminal_resize(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalResizeParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = &state.terminal_manager;
    manager
        .resize(&params.terminal_id, params.cols, params.rows)
        .map_err(AppCommandError::from)?;
    Ok(Json(()))
}

/// Recent output of an already-running terminal — the re-attach half of
/// `terminal_spawn` (see the Tauri command of the same name).
pub async fn terminal_snapshot(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalIdParams>,
) -> Result<Json<TerminalSnapshot>, AppCommandError> {
    let manager = &state.terminal_manager;
    Ok(Json(manager.snapshot(&params.terminal_id)))
}

pub async fn terminal_kill(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalKillParams>,
) -> Result<Json<()>, AppCommandError> {
    let manager = &state.terminal_manager;
    let result = if params.keep_output {
        manager.stop(&params.terminal_id)
    } else {
        manager.kill(&params.terminal_id)
    };
    result.map_err(AppCommandError::from)?;
    Ok(Json(()))
}

/// 终端里是不是还有程序在跑，关闭前要不要确认（#1136）。`null` 是不知道
/// （终端不在了，或者 Windows 上判断不了），调用方照直接关处理。
pub async fn terminal_is_busy(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<TerminalIdParams>,
) -> Result<Json<Option<bool>>, AppCommandError> {
    let manager = &state.terminal_manager;
    Ok(Json(manager.foreground_busy(&params.terminal_id)))
}

pub async fn terminal_list(
    Extension(state): Extension<Arc<AppState>>,
) -> Result<Json<Vec<TerminalInfo>>, AppCommandError> {
    let manager = &state.terminal_manager;
    let result = manager.list_with_exit_check(Some(&state.emitter));
    Ok(Json(result))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;

    async fn test_state() -> (Arc<AppState>, tempfile::TempDir) {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let dir = tempfile::tempdir().unwrap();
        let state = Arc::new(AppState::new_for_test(db, dir.path().to_path_buf()));
        (state, dir)
    }

    /// 对已经关掉（或从没开过）的终端写、改大小、关掉，都是调用方的事：404，
    /// message 照旧是 `terminal not found: …`。
    #[tokio::test]
    async fn a_missing_terminal_is_404() {
        let (state, _dir) = test_state().await;
        let write: TerminalWriteParams =
            serde_json::from_str(r#"{"terminalId":"gone","data":"ls\n"}"#).unwrap();
        let err = terminal_write(Extension(state.clone()), Json(write))
            .await
            .expect_err("no such terminal");
        assert_eq!(err.code, AppErrorCode::NotFound, "{err:?}");
        assert_eq!(err.message, "terminal not found: gone");

        let resize: TerminalResizeParams =
            serde_json::from_str(r#"{"terminalId":"gone","cols":80,"rows":24}"#).unwrap();
        let err = terminal_resize(Extension(state.clone()), Json(resize))
            .await
            .expect_err("no such terminal");
        assert_eq!(err.code, AppErrorCode::NotFound, "{err:?}");

        let kill: TerminalKillParams = serde_json::from_str(r#"{"terminalId":"gone"}"#).unwrap();
        let err = terminal_kill(Extension(state), Json(kill))
            .await
            .expect_err("no such terminal");
        assert_eq!(err.code, AppErrorCode::NotFound, "{err:?}");
        assert_eq!(
            axum::response::IntoResponse::into_response(err).status(),
            axum::http::StatusCode::NOT_FOUND
        );
    }

    #[test]
    fn a_kill_without_keep_output_still_closes_the_terminal() {
        // Older clients send only the id, and that must stay a close.
        let close: TerminalKillParams =
            serde_json::from_str(r#"{"terminalId":"t"}"#).expect("close params");
        assert!(!close.keep_output);
        let stop: TerminalKillParams =
            serde_json::from_str(r#"{"terminalId":"t","keepOutput":true}"#).expect("stop params");
        assert!(stop.keep_output);
    }
}
