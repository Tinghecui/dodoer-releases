//! jenny fork: `codeg-cli taxonomy` — what the nightly Codex automation uses
//! to reorganize each project's conversation mind map: the projects worth a
//! look, one project's conversations (title and first prompt), and applying
//! the new tree. See `crate::taxonomy` and `docs/conversation-mindmap.md`.

use crate::db::AppDatabase;
use crate::taxonomy::service::{self, ApplyOutcome, ExportDoc, ProjectEntry, TaxonomyError};
use crate::web::event_bridge::EventEmitter;

use super::service::CliError;
use super::wire::{TaxonomyApplyRequest, TaxonomyExportRequest, TaxonomyProjectsRequest};

impl From<TaxonomyError> for CliError {
    fn from(err: TaxonomyError) -> Self {
        let message = err.to_string();
        match err {
            TaxonomyError::FolderNotFound(_) | TaxonomyError::NotAProject(_) => {
                CliError::usage("unknown_project", message)
                    .with_next_steps(["codeg-cli taxonomy projects --all".to_string()])
            }
            TaxonomyError::PlanShape(_) | TaxonomyError::Plan(_) => {
                CliError::usage("bad_plan", message)
            }
            TaxonomyError::ConversationNotFound(_)
            | TaxonomyError::NotPlaceable(_)
            | TaxonomyError::CategoryNotFound(_) => CliError::usage("bad_request", message),
            TaxonomyError::Db(_) => CliError::execution("taxonomy_unavailable", message),
        }
    }
}

pub async fn projects(
    db: &AppDatabase,
    req: &TaxonomyProjectsRequest,
) -> Result<Vec<ProjectEntry>, CliError> {
    service::projects(&db.conn, req.all)
        .await
        .map_err(|e| CliError::execution("taxonomy_unavailable", e.to_string()))
}

pub async fn export(db: &AppDatabase, req: &TaxonomyExportRequest) -> Result<ExportDoc, CliError> {
    Ok(service::export(&db.conn, &req.folder).await?)
}

pub async fn apply(
    db: &AppDatabase,
    emitter: &EventEmitter,
    req: TaxonomyApplyRequest,
) -> Result<ApplyOutcome, CliError> {
    Ok(service::apply(&db.conn, emitter, &req.folder, req.plan, req.dry_run).await?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers;

    #[tokio::test]
    async fn errors_read_as_cli_errors() {
        let db = test_helpers::fresh_in_memory_db().await;
        let err = export(
            &db,
            &TaxonomyExportRequest {
                folder: "/nowhere".into(),
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, 400);
        assert_eq!(err.body.error.code, "unknown_project");

        test_helpers::seed_folder(&db, "/p/app").await;
        let err = apply(
            &db,
            &EventEmitter::Noop,
            TaxonomyApplyRequest {
                folder: "/p/app".into(),
                plan: serde_json::json!({"categories": []}),
                dry_run: false,
            },
        )
        .await
        .unwrap_err();
        assert_eq!(err.body.error.code, "bad_plan");
        assert!(err.body.error.message.contains("at least one"), "{}", err.body.error.message);

        assert!(projects(&db, &TaxonomyProjectsRequest { all: true })
            .await
            .unwrap()
            .is_empty());
    }
}
