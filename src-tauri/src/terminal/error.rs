use serde::Serialize;

use crate::app_error::{AppCommandError, AppErrorCode};

#[derive(Debug, thiserror::Error)]
pub enum TerminalError {
    #[error("failed to spawn terminal: {0}")]
    SpawnFailed(String),
    /// 同一个 id 的终端已经在了（或正在起）。文字和以前包成 `SpawnFailed`
    /// 时一字不差，前端按 `already exists` 认它。
    #[error("failed to spawn terminal: terminal id '{0}' already exists")]
    AlreadyExists(String),
    #[error("terminal not found: {0}")]
    NotFound(String),
    #[error("terminal write error: {0}")]
    WriteFailed(String),
    #[error("terminal resize error: {0}")]
    ResizeFailed(String),
}

impl Serialize for TerminalError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// 终端不在是 404，id 重复是 409，其余是服务器这边起不来、写不进，500。
impl From<TerminalError> for AppCommandError {
    fn from(err: TerminalError) -> Self {
        let code = match &err {
            TerminalError::NotFound(_) => AppErrorCode::NotFound,
            TerminalError::AlreadyExists(_) => AppErrorCode::AlreadyExists,
            TerminalError::SpawnFailed(_)
            | TerminalError::WriteFailed(_)
            | TerminalError::ResizeFailed(_) => AppErrorCode::TaskExecutionFailed,
        };
        AppCommandError::new(code, err.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_errors_map_to_their_kind() {
        let err = AppCommandError::from(TerminalError::NotFound("t1".into()));
        assert_eq!(err.code, AppErrorCode::NotFound, "{err:?}");
        assert_eq!(err.message, "terminal not found: t1");

        let err = AppCommandError::from(TerminalError::AlreadyExists("t1".into()));
        assert_eq!(err.code, AppErrorCode::AlreadyExists, "{err:?}");
        assert_eq!(
            err.message,
            "failed to spawn terminal: terminal id 't1' already exists"
        );

        for e in [
            TerminalError::SpawnFailed("no pty".into()),
            TerminalError::WriteFailed("pipe".into()),
            TerminalError::ResizeFailed("ioctl".into()),
        ] {
            let message = e.to_string();
            let err = AppCommandError::from(e);
            assert_eq!(err.code, AppErrorCode::TaskExecutionFailed, "{err:?}");
            assert_eq!(err.message, message);
        }
    }

    /// 对已经关掉（或从没开过）的终端写，是调用方的事：404。
    #[test]
    fn writing_to_a_missing_terminal_is_not_found() {
        let manager = crate::terminal::manager::TerminalManager::new();
        let err = manager
            .write("gone", b"ls\n")
            .expect_err("no such terminal");
        assert_eq!(AppCommandError::from(err).code, AppErrorCode::NotFound);
        let err = manager
            .resize("gone", 80, 24)
            .expect_err("no such terminal");
        assert_eq!(AppCommandError::from(err).code, AppErrorCode::NotFound);
    }
}
