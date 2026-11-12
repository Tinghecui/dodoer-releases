//! Cowork fork: what keeps a desktop app from before the codeg 0.43 base
//! (1.2.5 – 1.4.0) working against this server.
//!
//! A remote window runs the frontend the app shipped with, so until someone
//! presses "update" a 0.40 frontend calls a 0.43 server. `compat.rs` tells
//! such an app to update, in a toast that does not stop anyone from using it;
//! this is the handful of places where carrying on would otherwise go wrong
//! QUIETLY (the audit is in `.cowork/journal/2026-11-12-legacy-desktop-clients.md`):
//!
//! * [`acp_fetch_kimi_models`]: a route 0.43 dropped, which the old Kimi panel
//!   still calls.
//! * [`refuse_opencode_auth`]: the old OpenCode panel saves API keys in a
//!   field 0.43 no longer has. Ignored, it would report "saved".
//! * [`forge_settings`]: the old forge settings dialog saves the whole object
//!   without the footer switch 0.43 added, which would switch it back on.
//!
//! The fourth is not here because it is not a request shape: an old app
//! accepts a forge task without showing the agent's thread reply, see
//! `forge::thread_reply::mark_reviewed`.
//!
//! Remove an entry once `compat::MIN_DESKTOP_VERSION` has been past 1.4.0 for
//! long enough that no such app is left.

use axum::Json;
use sea_orm::DatabaseConnection;
use serde::Deserialize;

use crate::acp::provider_models::{list_models, ModelsProtocol, ModelsRequest};
use crate::app_error::AppCommandError;
use crate::forge::settings::ForgePanelSettings;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpFetchKimiModelsParams {
    pub base_url: String,
    pub api_key: String,
}

/// `/api/acp_fetch_kimi_models` as the 0.40 Kimi panel calls it: the model ids
/// an OpenAI-style endpoint lists for this key, sorted. 0.43 asks through
/// `list_provider_models` instead.
pub async fn acp_fetch_kimi_models(
    Json(params): Json<AcpFetchKimiModelsParams>,
) -> Result<Json<Vec<String>>, AppCommandError> {
    let request = ModelsRequest::new(
        ModelsProtocol::Openai,
        &params.base_url,
        &params.api_key,
        None,
    )
    .map_err(|e| AppCommandError::task_execution_failed(e.message))?;
    let list = list_models(&request)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.message))?;
    let mut ids: Vec<String> = list.models.into_iter().map(|m| m.id).collect();
    ids.sort();
    ids.dedup();
    Ok(Json(ids))
}

/// The `opencodeAuthJson` a 0.40 settings panel sends with every OpenCode
/// save: `Err` when it carries credentials. 0.43 keeps them elsewhere and has
/// no such field, so the save would succeed without storing the key. An empty
/// text or object is what the panel sends when nothing was typed, and passes.
pub fn refuse_opencode_auth(auth_json: Option<&str>) -> Result<(), AppCommandError> {
    if carries_credentials(auth_json) {
        Err(AppCommandError::invalid_input(
            "This desktop app is too old to save OpenCode credentials on this server: \
             nothing was saved. Update the app, or use the web version, and enter the key again.",
        ))
    } else {
        Ok(())
    }
}

fn carries_credentials(auth_json: Option<&str>) -> bool {
    let Some(text) = auth_json.map(str::trim).filter(|t| !t.is_empty()) else {
        return false;
    };
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(serde_json::Value::Object(object)) => !object.is_empty(),
        Ok(serde_json::Value::Null) => false,
        // Not what the panel writes; whatever it is, it was meant to be stored.
        _ => true,
    }
}

/// The settings a `forge_settings_set` request carries, as the type the store
/// takes. A request without `comment_footer` is a 0.40 dialog's, which never
/// heard of the switch: it keeps what the scope has now (a folder without its
/// own row follows the global one) instead of the field's default, on.
pub async fn forge_settings(
    conn: &DatabaseConnection,
    folder_id: Option<i32>,
    settings: Option<serde_json::Value>,
) -> Result<Option<ForgePanelSettings>, AppCommandError> {
    let Some(mut settings) = settings else {
        return Ok(None);
    };
    if lacks_comment_footer(&settings) {
        let store = crate::forge::settings::load(conn).await?;
        let stored = match folder_id {
            Some(id) => store.effective(id),
            None => &store.global,
        }
        .comment_footer;
        keep_comment_footer(&mut settings, stored);
    }
    serde_json::from_value(settings)
        .map(Some)
        .map_err(|e| AppCommandError::invalid_input(format!("unreadable forge settings: {e}")))
}

fn lacks_comment_footer(settings: &serde_json::Value) -> bool {
    settings
        .as_object()
        .is_some_and(|object| !object.contains_key(COMMENT_FOOTER))
}

fn keep_comment_footer(settings: &mut serde_json::Value, stored: bool) {
    if let Some(object) = settings.as_object_mut() {
        object.insert(COMMENT_FOOTER.to_string(), stored.into());
    }
}

const COMMENT_FOOTER: &str = "comment_footer";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_an_auth_json_with_credentials_is_refused() {
        for empty in [None, Some(""), Some("  "), Some("{}"), Some(" { } "), Some("null")] {
            assert!(refuse_opencode_auth(empty).is_ok(), "{empty:?}");
        }
        let key = r#"{"openrouter":{"type":"api","key":"sk-or-1"}}"#;
        let refused = refuse_opencode_auth(Some(key)).expect_err("a key is not dropped quietly");
        assert!(refused.to_string().contains("nothing was saved"), "{refused}");
        assert!(refuse_opencode_auth(Some("sk-or-1")).is_err());
    }

    #[tokio::test]
    async fn a_dialog_that_never_heard_of_the_footer_leaves_it_as_it_is() {
        let db = crate::db::test_helpers::fresh_in_memory_db().await;
        let save = |folder_id: Option<i32>, settings: serde_json::Value| {
            let conn = db.conn.clone();
            async move {
                let settings = forge_settings(&conn, folder_id, Some(settings))
                    .await
                    .expect("readable");
                crate::forge::settings::save(&conn, folder_id, settings)
                    .await
                    .expect("save")
            }
        };

        // Nothing stored: the default, on.
        let store = save(None, serde_json::json!({ "writeback_default": false })).await;
        assert!(store.global.comment_footer);
        assert!(!store.global.writeback_default);

        // Switched off by a dialog that has the switch…
        let store = save(None, serde_json::json!({ "comment_footer": false })).await;
        assert!(!store.global.comment_footer);
        // …and still off after one that does not saves something else,
        let store = save(None, serde_json::json!({ "writeback_default": false })).await;
        assert!(!store.global.comment_footer);
        // also in a folder that had no row of its own until now.
        let store = save(Some(7), serde_json::json!({ "writeback_default": true })).await;
        assert!(!store.folders[&7].comment_footer);
        // A dialog that has the switch still decides.
        let store = save(Some(7), serde_json::json!({ "comment_footer": true })).await;
        assert!(store.folders[&7].comment_footer);
        assert!(!store.global.comment_footer);

        // Dropping a folder's row is not a settings object at all.
        assert!(forge_settings(&db.conn, Some(7), None)
            .await
            .expect("no settings")
            .is_none());
    }
}
