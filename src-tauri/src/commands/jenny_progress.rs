//! jenny fork: the command behind the conversation's "Jenny progress" tab
//! (`crate::jenny_progress`) — one record's detail. Read-only. The `_core`
//! function serves both the desktop command and the axum handler in
//! `web::handlers::jenny_progress`.

use crate::app_error::AppCommandError;
use crate::jenny_progress::{self, JennyProgressDetail};

pub async fn get_jenny_progress_core(
    session_id: String,
) -> Result<JennyProgressDetail, AppCommandError> {
    let root = jenny_progress::data_root().ok_or_else(|| {
        AppCommandError::not_found("No Jenny data folder found (set JENNY_DATA_ROOT)")
    })?;
    // A small file: keep the blocking read off the async runtime.
    tokio::task::spawn_blocking(move || jenny_progress::read_detail(&root, &session_id))
        .await
        .map_err(|e| AppCommandError::io_error(format!("Jenny progress read stopped: {e}")))?
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_jenny_progress(
    session_id: String,
) -> Result<JennyProgressDetail, AppCommandError> {
    get_jenny_progress_core(session_id).await
}
