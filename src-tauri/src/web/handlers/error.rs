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
