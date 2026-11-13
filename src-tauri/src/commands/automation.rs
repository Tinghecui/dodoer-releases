//! Automation CRUD commands. The `*_core` fns are mode-agnostic (plain
//! references, no `tauri::State`) and emit [`AUTOMATION_CHANGED_EVENT`] so both
//! the Tauri command wrappers and the Axum handlers share one code path. The
//! `#[tauri::command]` wrappers are desktop-only and build an
//! `EventEmitter::Tauri` from the `AppHandle`.

use chrono::{DateTime, Utc};

use crate::app_error::AppCommandError;
use crate::db::error::DbError;
use crate::db::service::automation_service;
use crate::db::AppDatabase;
use crate::models::{AutomationDraft, AutomationInfo, AutomationRunInfo};
use crate::web::event_bridge::{
    emit_event, AutomationChange, EventEmitter, AUTOMATION_CHANGED_EVENT,
};

// ── shared business logic (both modes) ──────────────────────────────────────

/// Map service errors onto user-facing codes for every automation endpoint
/// (Axum handlers and Tauri wrappers alike): a rejected draft is the caller's
/// mistake — `invalid_input` (HTTP 400) with its reason, not an opaque
/// `database_error` 500 — and a missing automation is `not_found`. A bad cron
/// additionally carries an i18n key (`AppCommandError::invalid_cron`). Same
/// split as `commands::canvas::map_db`.
pub fn automation_error(e: DbError) -> AppCommandError {
    match e {
        DbError::NotFound(msg) => AppCommandError::not_found(msg),
        DbError::Validation(msg) => AppCommandError::invalid_input(msg),
        other => AppCommandError::from(other),
    }
}

pub async fn automation_list_core(db: &AppDatabase) -> Result<Vec<AutomationInfo>, DbError> {
    automation_service::list(&db.conn).await
}

pub async fn automation_get_core(db: &AppDatabase, id: i32) -> Result<AutomationInfo, DbError> {
    automation_service::get(&db.conn, id).await
}

pub async fn automation_runs_core(
    db: &AppDatabase,
    automation_id: i32,
    limit: u64,
) -> Result<Vec<AutomationRunInfo>, DbError> {
    automation_service::list_runs(&db.conn, automation_id, limit).await
}

pub async fn automation_create_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    let info = automation_service::create(&db.conn, draft).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn automation_update_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    draft: AutomationDraft,
) -> Result<AutomationInfo, DbError> {
    let info = automation_service::update(&db.conn, id, draft).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn automation_set_enabled_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
    enabled: bool,
) -> Result<AutomationInfo, DbError> {
    let info = automation_service::set_enabled(&db.conn, id, enabled).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Upsert { id: info.id },
    );
    Ok(info)
}

pub async fn automation_delete_core(
    emitter: &EventEmitter,
    db: &AppDatabase,
    id: i32,
) -> Result<(), DbError> {
    automation_service::delete(&db.conn, id).await?;
    emit_event(
        emitter,
        AUTOMATION_CHANGED_EVENT,
        AutomationChange::Deleted { id },
    );
    Ok(())
}

pub async fn automation_mark_seen_core(db: &AppDatabase) -> Result<(), DbError> {
    automation_service::mark_all_seen(&db.conn).await
}

/// Editor "next run" preview. Authoritative — shares the exact cron evaluator the
/// scheduler uses, so the previewed time can never diverge from the actual fire.
pub fn automation_compute_next_run_core(
    cron: &str,
    timezone: &str,
) -> Result<Option<DateTime<Utc>>, DbError> {
    automation_service::compute_next_run(cron, timezone, Utc::now())
}

// ── Tauri command wrappers (desktop only) ───────────────────────────────────

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_list(
    db: tauri::State<'_, AppDatabase>,
) -> Result<Vec<AutomationInfo>, AppCommandError> {
    automation_list_core(&db).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_get(
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<AutomationInfo, AppCommandError> {
    automation_get_core(&db, id).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_runs(
    db: tauri::State<'_, AppDatabase>,
    automation_id: i32,
    limit: u64,
) -> Result<Vec<AutomationRunInfo>, AppCommandError> {
    automation_runs_core(&db, automation_id, limit).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_create(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    draft: AutomationDraft,
) -> Result<AutomationInfo, AppCommandError> {
    automation_create_core(&EventEmitter::Tauri(app), &db, draft).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_update(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    draft: AutomationDraft,
) -> Result<AutomationInfo, AppCommandError> {
    automation_update_core(&EventEmitter::Tauri(app), &db, id, draft)
        .await
        .map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_set_enabled(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
    enabled: bool,
) -> Result<AutomationInfo, AppCommandError> {
    automation_set_enabled_core(&EventEmitter::Tauri(app), &db, id, enabled)
        .await
        .map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_delete(
    app: tauri::AppHandle,
    db: tauri::State<'_, AppDatabase>,
    id: i32,
) -> Result<(), AppCommandError> {
    automation_delete_core(&EventEmitter::Tauri(app), &db, id).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_mark_seen(
    db: tauri::State<'_, AppDatabase>,
) -> Result<(), AppCommandError> {
    automation_mark_seen_core(&db).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_compute_next_run(
    cron: String,
    timezone: String,
) -> Result<Option<DateTime<Utc>>, AppCommandError> {
    automation_compute_next_run_core(&cron, &timezone).map_err(automation_error)
}

// ── engine-dispatched ops (manual run / cancel) ─────────────────────────────

/// Manual "Run now" — fire immediately, bypassing the schedule. Returns the new
/// run id. Routes through the process-global engine (spawned in both modes).
pub async fn automation_run_now_core(automation_id: i32) -> Result<i32, DbError> {
    let engine = crate::automation::engine()
        .ok_or_else(|| DbError::Validation("automation engine not running".to_string()))?;
    engine
        .run_automation(automation_id, "manual", None)
        .await
        .map_err(DbError::Validation)
}

/// Cancel an in-flight (or clear a wedged) run.
pub async fn automation_cancel_run_core(run_id: i32) -> Result<(), DbError> {
    let engine = crate::automation::engine()
        .ok_or_else(|| DbError::Validation("automation engine not running".to_string()))?;
    engine.cancel_run(run_id).await.map_err(DbError::Validation)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_run_now(automation_id: i32) -> Result<i32, AppCommandError> {
    automation_run_now_core(automation_id).await.map_err(automation_error)
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn automation_cancel_run(run_id: i32) -> Result<(), AppCommandError> {
    automation_cancel_run_core(run_id).await.map_err(automation_error)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_error::AppErrorCode;
    use crate::db::error::CronProblem;

    #[test]
    fn rejected_input_is_invalid_input_not_database_error() {
        let err = automation_error(DbError::Validation("name is required".into()));
        assert!(matches!(err.code, AppErrorCode::InvalidInput));
        assert_eq!(err.message, "name is required");

        let err = automation_error(DbError::NotFound("automation 7".into()));
        assert!(matches!(err.code, AppErrorCode::NotFound));

        let err = automation_error(DbError::InvalidCron(CronProblem::NeverFires(
            "0 0 31 2 *".into(),
        )));
        assert!(matches!(err.code, AppErrorCode::InvalidInput));
        assert_eq!(err.i18n_key.as_deref(), Some("cronErrorNeverFires"));
    }

    #[test]
    fn next_run_preview_of_a_bad_cron_is_a_localized_invalid_input() {
        // What the editor's live preview gets back for `not a cron`.
        let err = automation_compute_next_run_core("not a cron", "UTC")
            .map_err(automation_error)
            .unwrap_err();
        assert!(matches!(err.code, AppErrorCode::InvalidInput));
        assert_eq!(err.i18n_key.as_deref(), Some("cronErrorFieldCount"));
        assert_eq!(
            err.i18n_params.as_ref().and_then(|p| p.get("n")).map(String::as_str),
            Some("3")
        );
        // A never-firing cron previews as "no next run", and saving refuses it.
        assert_eq!(automation_compute_next_run_core("0 0 31 2 *", "UTC").unwrap(), None);
    }
}
