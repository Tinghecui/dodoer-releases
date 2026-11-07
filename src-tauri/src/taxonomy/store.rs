//! Where a project's taxonomy lives: one `app_metadata` row per root folder,
//! the document as JSON. No table of its own — the private build must not add
//! migrations (JENNY-FORK.md, hard rule 1).
//!
//! Every write is a read-modify-write of that one value, so writes to a
//! folder run one at a time behind an in-process lock, and never inside a
//! transaction (see `conversation_tag_service` on WAL snapshots). Two
//! processes sharing one data directory are not serialized against each
//! other; the later write wins, which at worst loses one placement that the
//! next night puts back.

use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter};
use serde::Serialize;
use tokio::sync::{Mutex, OwnedMutexGuard};

use super::model::Taxonomy;
use crate::db::entities::app_metadata;
use crate::db::error::DbError;
use crate::db::service::app_metadata_service;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// `app_metadata` key prefix; the root folder's id follows.
pub const KEY_PREFIX: &str = "jenny.conversation_taxonomy:folder:";

/// Broadcast after every visible change to a project's taxonomy.
pub const CONVERSATION_TAXONOMY_CHANGED_EVENT: &str = "conversation-taxonomy://changed";

/// Payload of [`CONVERSATION_TAXONOMY_CHANGED_EVENT`]: which project, and the
/// revision it is now at. Clients refetch when it is ahead of theirs.
#[derive(Debug, Clone, Serialize)]
pub struct TaxonomyChanged {
    pub folder_id: i32,
    pub revision: i64,
}

pub fn key(root_folder_id: i32) -> String {
    format!("{KEY_PREFIX}{root_folder_id}")
}

static LOCKS: LazyLock<StdMutex<HashMap<i32, Arc<Mutex<()>>>>> =
    LazyLock::new(|| StdMutex::new(HashMap::new()));

/// Hold this while reading and writing one project's document.
pub async fn lock(root_folder_id: i32) -> OwnedMutexGuard<()> {
    let lock = LOCKS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(root_folder_id)
        .or_default()
        .clone();
    lock.lock_owned().await
}

/// The project's document; an empty one when it has none yet. A value that
/// no longer parses is set aside under `<key>:unreadable` and read as empty,
/// rather than wedging the mind map for good.
pub async fn load(conn: &DatabaseConnection, root_folder_id: i32) -> Result<Taxonomy, DbError> {
    let key = key(root_folder_id);
    let Some(raw) = app_metadata_service::get_value(conn, &key).await? else {
        return Ok(Taxonomy::default());
    };
    match serde_json::from_str::<Taxonomy>(&raw) {
        Ok(t) => Ok(t),
        Err(e) => {
            tracing::warn!(
                folder_id = root_folder_id,
                error = %e,
                "[taxonomy] stored document does not parse; starting over"
            );
            app_metadata_service::upsert_value(conn, &format!("{key}:unreadable"), &raw).await?;
            Ok(Taxonomy::default())
        }
    }
}

pub async fn save(
    conn: &DatabaseConnection,
    root_folder_id: i32,
    taxonomy: &Taxonomy,
) -> Result<(), DbError> {
    let json = serde_json::to_string(taxonomy).map_err(|e| DbError::Migration(e.to_string()))?;
    app_metadata_service::upsert_value(conn, &key(root_folder_id), &json).await
}

/// Every stored document, by root folder id. For the project list.
pub async fn load_all(conn: &DatabaseConnection) -> Result<HashMap<i32, Taxonomy>, DbError> {
    let rows = app_metadata::Entity::find()
        .filter(app_metadata::Column::Key.starts_with(KEY_PREFIX))
        .filter(app_metadata::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    let mut out = HashMap::new();
    for row in rows {
        let Some(id) = row
            .key
            .strip_prefix(KEY_PREFIX)
            .and_then(|rest| rest.parse::<i32>().ok())
        else {
            continue; // `…:unreadable` copies and the like
        };
        if let Ok(t) = serde_json::from_str::<Taxonomy>(&row.value) {
            out.insert(id, t);
        }
    }
    Ok(out)
}

pub fn emit_changed(emitter: &EventEmitter, root_folder_id: i32, revision: i64) {
    emit_event(
        emitter,
        CONVERSATION_TAXONOMY_CHANGED_EVENT,
        TaxonomyChanged {
            folder_id: root_folder_id,
            revision,
        },
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers;
    use crate::taxonomy::model::Category;

    #[tokio::test]
    async fn a_document_saves_loads_and_lists() {
        let db = test_helpers::fresh_in_memory_db().await;
        assert_eq!(load(&db.conn, 7).await.unwrap(), Taxonomy::default());

        let t = Taxonomy {
            version: 1,
            revision: 3,
            categories: vec![Category {
                id: "ui".into(),
                parent_id: None,
                name: "UI".into(),
                rule: "front end".into(),
            }],
            ..Default::default()
        };
        save(&db.conn, 7, &t).await.unwrap();
        assert_eq!(load(&db.conn, 7).await.unwrap(), t);

        let all = load_all(&db.conn).await.unwrap();
        assert_eq!(all.len(), 1);
        assert_eq!(all[&7].revision, 3);
    }

    #[tokio::test]
    async fn an_unreadable_document_is_set_aside() {
        let db = test_helpers::fresh_in_memory_db().await;
        app_metadata_service::upsert_value(&db.conn, &key(9), "{not json")
            .await
            .unwrap();
        assert_eq!(load(&db.conn, 9).await.unwrap(), Taxonomy::default());
        let kept = app_metadata_service::get_value(&db.conn, &format!("{}:unreadable", key(9)))
            .await
            .unwrap();
        assert_eq!(kept.as_deref(), Some("{not json"));
        // The copy is not mistaken for a project.
        assert!(load_all(&db.conn).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn the_lock_serializes_one_folder_only() {
        let a = lock(1).await;
        // Another folder is not blocked by folder 1.
        let b = tokio::time::timeout(std::time::Duration::from_millis(200), lock(2)).await;
        assert!(b.is_ok());
        // Folder 1 is.
        let again = tokio::time::timeout(std::time::Duration::from_millis(50), lock(1)).await;
        assert!(again.is_err());
        drop(a);
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(200), lock(1))
                .await
                .is_ok()
        );
    }
}
