use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};

use crate::app_error::{AppCommandError, AppErrorCode};

fn status_for_app_error_code(code: AppErrorCode) -> StatusCode {
    match code {
        AppErrorCode::InvalidInput => StatusCode::BAD_REQUEST,
        AppErrorCode::NotFound => StatusCode::NOT_FOUND,
        AppErrorCode::AlreadyExists | AppErrorCode::TurnInProgress => StatusCode::CONFLICT,
        AppErrorCode::PermissionDenied => StatusCode::FORBIDDEN,
        AppErrorCode::ConfigurationMissing
        | AppErrorCode::ConfigurationInvalid
        | AppErrorCode::DependencyMissing
        | AppErrorCode::NotAGitRepository
        | AppErrorCode::AuthenticationFailed => StatusCode::UNPROCESSABLE_ENTITY,
        AppErrorCode::NetworkError
        | AppErrorCode::DatabaseError
        | AppErrorCode::IoError
        | AppErrorCode::ExternalCommandFailed
        | AppErrorCode::WindowOperationFailed
        | AppErrorCode::TaskExecutionFailed => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

impl IntoResponse for AppCommandError {
    fn into_response(self) -> Response {
        let status = status_for_app_error_code(self.code);
        // Cowork fork: what failed, for the telemetry of a 5xx (`crate::telemetry`).
        let report = status
            .is_server_error()
            .then(|| crate::telemetry::ApiError::of(&self));
        let mut response = (status, Json(self)).into_response();
        if let Some(report) = report {
            response.extensions_mut().insert(report);
        }
        response
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejected_input_is_a_client_error() {
        assert_eq!(
            status_for_app_error_code(AppErrorCode::InvalidInput),
            StatusCode::BAD_REQUEST
        );
    }

    #[test]
    fn command_authentication_failures_are_not_web_session_unauthorized() {
        assert_eq!(
            status_for_app_error_code(AppErrorCode::AuthenticationFailed),
            StatusCode::UNPROCESSABLE_ENTITY
        );
    }

    /// A 5xx carries what failed for telemetry; a 4xx does not.
    #[test]
    fn server_errors_carry_their_code_for_telemetry() {
        let response = AppCommandError::database_error("disk full").into_response();
        let report = response
            .extensions()
            .get::<crate::telemetry::ApiError>()
            .expect("a 500 carries its error");
        assert_eq!(report.code, "database_error");
        let response = AppCommandError::invalid_input("bad").into_response();
        assert!(response
            .extensions()
            .get::<crate::telemetry::ApiError>()
            .is_none());
    }

    /// #165: a row that is not there (or was soft-deleted) is a 404 end to end
    /// — the service's `DbError::NotFound` through the blanket `From` — not
    /// the 500 every `database_error` gets.
    #[test]
    fn db_not_found_is_http_404() {
        let err = AppCommandError::from(crate::db::error::DbError::NotFound(
            "Conversation not found: 7".into(),
        ));
        assert_eq!(status_for_app_error_code(err.code), StatusCode::NOT_FOUND);
        let err = AppCommandError::from(crate::db::error::DbError::Migration("boom".into()));
        assert_eq!(
            status_for_app_error_code(err.code),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    fn status_of(err: impl Into<AppCommandError>) -> StatusCode {
        status_for_app_error_code(err.into().code)
    }

    /// 第 5 行（2026-11-17）：数据库的「内容不合规」是 400、「和别的行冲突」是 409，
    /// 服务器自己的 `Internal` 照旧 500。
    #[test]
    fn db_validation_and_conflict_are_client_errors() {
        use crate::db::error::DbError;
        assert_eq!(
            status_of(DbError::Validation("title is required".into())),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status_of(DbError::Conflict("already bound".into())),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status_of(DbError::Internal("task engine not running".into())),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// ACP 的错误按种类回状态码：调用方的错是 4xx，agent 或服务器自己的错才是 500。
    #[test]
    fn acp_errors_get_their_status() {
        use crate::acp::error::AcpError;
        assert_eq!(
            status_of(AcpError::ConnectionNotFound("c1".into())),
            StatusCode::NOT_FOUND
        );
        assert_eq!(status_of(AcpError::TurnInProgress), StatusCode::CONFLICT);
        assert_eq!(
            status_of(AcpError::invalid_input("skill id cannot be empty")),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            status_of(AcpError::ConversationMoved {
                conversation_id: 1,
                folder_id: 2,
            }),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(status_of(AcpError::NoActiveTurn), StatusCode::BAD_REQUEST);
        assert_eq!(
            status_of(AcpError::SdkNotInstalled("x is not installed".into())),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            status_of(AcpError::PiProjectTrustRequired("trust".into())),
            StatusCode::FORBIDDEN
        );
        assert_eq!(
            status_of(AcpError::ProcessExited),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            status_of(AcpError::SessionLost),
            StatusCode::INTERNAL_SERVER_ERROR
        );
        assert_eq!(
            status_of(AcpError::agent_auth_required("relay token expired")),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    #[test]
    fn terminal_errors_get_their_status() {
        use crate::terminal::error::TerminalError;
        assert_eq!(
            status_of(TerminalError::NotFound("t1".into())),
            StatusCode::NOT_FOUND
        );
        assert_eq!(
            status_of(TerminalError::AlreadyExists("t1".into())),
            StatusCode::CONFLICT
        );
        assert_eq!(
            status_of(TerminalError::WriteFailed("pipe".into())),
            StatusCode::INTERNAL_SERVER_ERROR
        );
    }

    /// 改的那 7 处「找不到」：不存在的 id，经 `From` 和 `db()` 都是 404。
    #[tokio::test]
    async fn a_missing_row_is_404() {
        use crate::db::error::DbError;
        use crate::db::service::{
            agent_setting_service, chat_channel_service, folder_command_service,
            model_provider_service, quick_message_service,
        };
        use crate::models::agent::AgentType;
        use sea_orm::EntityTrait;

        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let conn = &db.conn;
        crate::db::entities::agent_setting::Entity::delete_many()
            .exec(conn)
            .await
            .expect("clear agent settings");

        let missing: Vec<(&str, DbError)> = vec![
            (
                "get_folder_core",
                crate::commands::folders::get_folder_core(&db, 4242)
                    .await
                    .expect_err("no folder 4242"),
            ),
            (
                "agent_setting update",
                agent_setting_service::update(
                    conn,
                    AgentType::ClaudeCode,
                    agent_setting_service::AgentSettingsUpdate {
                        enabled: true,
                        env_json: None,
                        model_provider_id: None,
                    },
                )
                .await
                .expect_err("no agent setting row"),
            ),
            (
                "agent_setting update_preferences",
                agent_setting_service::update_preferences(conn, AgentType::ClaudeCode, true, None)
                    .await
                    .expect_err("no agent setting row"),
            ),
            (
                "chat_channel update",
                chat_channel_service::update(conn, 4242, None, None, None, None, None, None)
                    .await
                    .expect_err("no chat channel 4242"),
            ),
            (
                "folder_command update",
                folder_command_service::update(conn, 4242, None, None, None, None)
                    .await
                    .expect_err("no folder command 4242"),
            ),
            (
                "model_provider update",
                model_provider_service::update(conn, 4242, None, None, None, None, None)
                    .await
                    .expect_err("no model provider 4242"),
            ),
            (
                "quick_message update",
                quick_message_service::update(conn, 4242, None, None)
                    .await
                    .expect_err("no quick message 4242"),
            ),
        ];
        for (what, err) in missing {
            let text = err.to_string();
            assert!(text.contains("not found"), "{what}: {text}");
            assert!(matches!(err, DbError::NotFound(_)), "{what}: {err:?}");
            assert_eq!(status_of(err), StatusCode::NOT_FOUND, "{what}: {text}");
        }
    }

    /// Every code, in declaration order. `index` has no catch-all, so a new
    /// code does not compile until it is given a place there, and then here.
    fn every_code() -> Vec<AppErrorCode> {
        fn index(code: AppErrorCode) -> usize {
            match code {
                AppErrorCode::InvalidInput => 0,
                AppErrorCode::ConfigurationMissing => 1,
                AppErrorCode::ConfigurationInvalid => 2,
                AppErrorCode::NotFound => 3,
                AppErrorCode::NotAGitRepository => 4,
                AppErrorCode::AlreadyExists => 5,
                AppErrorCode::PermissionDenied => 6,
                AppErrorCode::DependencyMissing => 7,
                AppErrorCode::NetworkError => 8,
                AppErrorCode::AuthenticationFailed => 9,
                AppErrorCode::DatabaseError => 10,
                AppErrorCode::IoError => 11,
                AppErrorCode::ExternalCommandFailed => 12,
                AppErrorCode::WindowOperationFailed => 13,
                AppErrorCode::TaskExecutionFailed => 14,
                AppErrorCode::TurnInProgress => 15,
            }
        }
        let every = vec![
            AppErrorCode::InvalidInput,
            AppErrorCode::ConfigurationMissing,
            AppErrorCode::ConfigurationInvalid,
            AppErrorCode::NotFound,
            AppErrorCode::NotAGitRepository,
            AppErrorCode::AlreadyExists,
            AppErrorCode::PermissionDenied,
            AppErrorCode::DependencyMissing,
            AppErrorCode::NetworkError,
            AppErrorCode::AuthenticationFailed,
            AppErrorCode::DatabaseError,
            AppErrorCode::IoError,
            AppErrorCode::ExternalCommandFailed,
            AppErrorCode::WindowOperationFailed,
            AppErrorCode::TaskExecutionFailed,
            AppErrorCode::TurnInProgress,
        ];
        let order: Vec<usize> = every.iter().copied().map(index).collect();
        assert_eq!(order, (0..every.len()).collect::<Vec<_>>());
        every
    }

    /// The codes the web client reads and their statuses, as
    /// `web/api-contract.json` lists them; `src/lib/transport/api-contract.test.ts`
    /// holds `AppErrorCode` in `types.ts` to the same list.
    #[test]
    fn every_code_answers_the_status_the_api_contract_lists() {
        let contract: serde_json::Value =
            serde_json::from_str(include_str!("../api-contract.json")).expect("api-contract.json");
        let listed = contract["errorCodes"].as_object().expect("errorCodes");
        let every = every_code();
        assert_eq!(listed.len(), every.len(), "one entry per code");
        for code in every {
            let name = serde_json::to_value(code).expect("serialize the code");
            let name = name.as_str().expect("a code is a string");
            let status = listed
                .get(name)
                .and_then(serde_json::Value::as_u64)
                .unwrap_or_else(|| panic!("errorCodes in web/api-contract.json has no {name}"));
            assert_eq!(
                u64::from(status_for_app_error_code(code).as_u16()),
                status,
                "{name}"
            );
        }
    }
}
