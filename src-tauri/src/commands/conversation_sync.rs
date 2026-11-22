//! "Sync the conversation list" (#673): the changes a client missed since its
//! last `{generation, seq}`, or the whole list with the reason. Served at
//! `POST /api/sync_conversation_list`.
//!
//! Cowork：移植自 dodoer #946（#673 PR4，`36f600659`、`ca42db9de`）。整份的列表和
//! `list_all_conversations` 一样带上「在等你」（`acp::awaiting::fill_list_awaiting`）；
//! 没有 dodoer 的 `display_status`，也没有 Tauri 命令（我们的前端不调它）。

use serde::Serialize;

use crate::app_error::AppCommandError;
use crate::commands::conversations::{list_all_conversations_core, ListAllConversationsOptions};
use crate::models::DbConversationSummary;
use crate::web::event_bridge::{ConversationListCursor, EventEmitter, SnapshotReason, MAX_REPLAY};

#[derive(Debug, Serialize)]
#[serde(tag = "mode", rename_all = "snake_case")]
pub enum ConversationListSync {
    /// Every `conversation://changed` after the client's cursor, in order;
    /// each carries its own `generation` and `seq`.
    Changes {
        generation: String,
        seq: u64,
        changes: Vec<serde_json::Value>,
    },
    /// The whole list as of `{generation, seq}`. Changes numbered after it
    /// may repeat what the list already shows, but none are missing.
    Snapshot {
        generation: String,
        seq: u64,
        reason: SnapshotReason,
        conversations: Vec<DbConversationSummary>,
    },
}

#[derive(Debug, Default)]
pub(crate) struct SyncConversationListOptions {
    pub(crate) cursor: Option<ConversationListCursor>,
    pub(crate) include_children: bool,
    pub(crate) include_loops: bool,
}

/// A cursor needs both halves.
pub(crate) fn cursor_from(
    generation: Option<String>,
    seq: Option<u64>,
) -> Option<ConversationListCursor> {
    Some(ConversationListCursor {
        generation: generation?,
        seq: seq?,
    })
}

pub(crate) async fn sync_conversation_list_core(
    conn: &sea_orm::DatabaseConnection,
    emitter: &EventEmitter,
    chat_channel_manager: &crate::chat_channel::manager::ChatChannelManager,
    manager: &crate::acp::manager::ConnectionManager,
    options: SyncConversationListOptions,
) -> Result<ConversationListSync, AppCommandError> {
    // The cursor is read before the database, so whatever changes after it
    // shows up both in the list and in the changes numbered after it.
    let (cursor, since) = emitter.conversation_changes_since(options.cursor.as_ref(), MAX_REPLAY);
    let reason = match since {
        Ok(changes) => {
            return Ok(ConversationListSync::Changes {
                generation: cursor.generation,
                seq: cursor.seq,
                changes: changes.iter().map(|c| (**c).clone()).collect(),
            })
        }
        Err(reason) => reason,
    };
    let mut conversations = list_all_conversations_core(
        conn,
        emitter,
        chat_channel_manager,
        ListAllConversationsOptions {
            include_children: options.include_children,
            include_loops: options.include_loops,
            ..Default::default()
        },
    )
    .await?;
    crate::acp::awaiting::fill_list_awaiting(manager, conn, &mut conversations).await;
    Ok(ConversationListSync::Snapshot {
        generation: cursor.generation,
        seq: cursor.seq,
        reason,
        conversations,
    })
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use serde_json::{json, Value};

    use super::*;
    use crate::acp::manager::ConnectionManager;
    use crate::chat_channel::manager::ChatChannelManager;
    use crate::db::service::conversation_service;
    use crate::db::test_helpers::{fresh_in_memory_db, seed_conversation, seed_folder};
    use crate::db::AppDatabase;
    use crate::models::AgentType;
    use crate::web::event_bridge::{
        emit_event, ConversationChange, WebEventBroadcaster, CONVERSATION_CHANGED_EVENT,
        JOURNAL_CAPACITY,
    };

    struct Fixture {
        db: AppDatabase,
        emitter: EventEmitter,
        id: i32,
        _dir: tempfile::TempDir,
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().unwrap();
        let db = fresh_in_memory_db().await;
        let folder = seed_folder(&db, dir.path().to_str().unwrap()).await;
        let id = seed_conversation(&db, folder, AgentType::ClaudeCode).await;
        let emitter = EventEmitter::test_web_only(Arc::new(WebEventBroadcaster::new()));
        Fixture {
            db,
            emitter,
            id,
            _dir: dir,
        }
    }

    impl Fixture {
        fn change(&self, change: ConversationChange) {
            emit_event(&self.emitter, CONVERSATION_CHANGED_EVENT, change);
        }

        /// A change that keeps nothing in the caches: a missing row deleted.
        fn noise(&self, n: usize) {
            for i in 0..n {
                self.change(ConversationChange::Deleted {
                    id: 100_000 + i as i32,
                });
            }
        }

        async fn sync(&self, cursor: Option<ConversationListCursor>) -> Value {
            let result = sync_conversation_list_core(
                &self.db.conn,
                &self.emitter,
                &ChatChannelManager::new(),
                &ConnectionManager::new(),
                SyncConversationListOptions {
                    cursor,
                    ..Default::default()
                },
            )
            .await
            .expect("sync conversation list");
            serde_json::to_value(result).unwrap()
        }

        async fn cursor(&self) -> ConversationListCursor {
            let synced = self.sync(None).await;
            ConversationListCursor {
                generation: synced["generation"].as_str().unwrap().to_string(),
                seq: synced["seq"].as_u64().unwrap(),
            }
        }

        async fn behind(&self, by: u64) -> ConversationListCursor {
            let mut cursor = self.cursor().await;
            cursor.seq -= by;
            cursor
        }
    }

    fn snapshot_reason(synced: &Value) -> &str {
        assert_eq!(synced["mode"], "snapshot", "{synced}");
        synced["reason"].as_str().unwrap()
    }

    fn change_seqs(synced: &Value) -> Vec<u64> {
        assert_eq!(synced["mode"], "changes", "{synced}");
        synced["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["seq"].as_u64().unwrap())
            .collect()
    }

    #[tokio::test]
    async fn changes_are_numbered_with_no_one_listening() {
        let f = fixture().await;
        f.noise(3);
        // Nobody subscribed for those three; the next one still follows them.
        let web = match &f.emitter {
            EventEmitter::WebOnly { broadcaster, .. } => broadcaster.clone(),
            _ => unreachable!(),
        };
        let mut rx = web.subscribe();
        f.noise(1);
        let event = rx.try_recv().unwrap();
        assert_eq!(event.payload["seq"], 4);
        let start = ConversationListCursor {
            generation: event.payload["generation"].as_str().unwrap().into(),
            seq: 0,
        };
        assert_eq!(change_seqs(&f.sync(Some(start)).await), vec![1, 2, 3, 4]);
    }

    #[tokio::test]
    async fn no_cursor_gets_the_whole_list() {
        let f = fixture().await;
        f.noise(2);
        let synced = f.sync(None).await;
        assert_eq!(snapshot_reason(&synced), "no_cursor");
        assert_eq!(synced["seq"], 2);
        assert!(synced["generation"].as_str().is_some_and(|g| !g.is_empty()));
        let rows = synced["conversations"].as_array().unwrap();
        assert!(rows.iter().any(|row| row["id"] == json!(f.id)), "{synced}");
        // 没有对话在等：行上没有 `awaiting`。
        assert!(rows.iter().all(|row| row.get("awaiting").is_none()));
    }

    /// Desktop windows and web clients see the same numbered payload, and an
    /// old client's fields are all still there.
    #[tokio::test]
    async fn a_numbered_change_keeps_its_own_fields() {
        let f = fixture().await;
        let web = match &f.emitter {
            EventEmitter::WebOnly { broadcaster, .. } => broadcaster.clone(),
            _ => unreachable!(),
        };
        let mut rx = web.subscribe();
        f.change(ConversationChange::Status {
            id: f.id,
            status: "in_progress".into(),
        });
        let event = rx.try_recv().unwrap();
        assert_eq!(event.payload["kind"], "status");
        assert_eq!(event.payload["id"], json!(f.id));
        assert_eq!(event.payload["status"], "in_progress");
        assert_eq!(event.payload["seq"], 1);
        // Other channels are not numbered.
        web.send_value(
            "folder://changed",
            Arc::new(json!({"kind": "deleted", "id": 1})),
        );
        let folder = rx.try_recv().unwrap();
        assert!(folder.payload.get("seq").is_none());
        assert_eq!(f.cursor().await.seq, 1);
    }

    #[tokio::test]
    async fn another_generation_gets_the_whole_list() {
        let f = fixture().await;
        f.noise(2);
        let stale = ConversationListCursor {
            generation: "an-earlier-run".into(),
            seq: 1,
        };
        assert_eq!(
            snapshot_reason(&f.sync(Some(stale)).await),
            "generation_changed"
        );
    }

    #[tokio::test]
    async fn a_cursor_ahead_of_the_server_gets_the_whole_list() {
        let f = fixture().await;
        f.noise(2);
        let mut ahead = f.cursor().await;
        ahead.seq += 1;
        assert_eq!(snapshot_reason(&f.sync(Some(ahead)).await), "cursor_ahead");
    }

    #[tokio::test]
    async fn a_cursor_older_than_the_journal_gets_the_whole_list() {
        let f = fixture().await;
        f.noise(JOURNAL_CAPACITY + 100);
        let lost = f.behind(JOURNAL_CAPACITY as u64 + 1).await;
        assert_eq!(snapshot_reason(&f.sync(Some(lost)).await), "cursor_too_old");
    }

    #[tokio::test]
    async fn more_than_500_missed_gets_the_whole_list() {
        let f = fixture().await;
        f.noise(JOURNAL_CAPACITY);
        // 1999 behind: all still kept, but too many to replay.
        let lagging = f.behind(1999).await;
        assert_eq!(
            snapshot_reason(&f.sync(Some(lagging)).await),
            "too_many_changes"
        );
        let limit = MAX_REPLAY as u64;
        assert_eq!(
            snapshot_reason(&f.sync(Some(f.behind(limit + 1).await)).await),
            "too_many_changes"
        );
        let replayed = change_seqs(&f.sync(Some(f.behind(limit).await)).await);
        assert_eq!(replayed.len(), MAX_REPLAY);
    }

    #[tokio::test]
    async fn one_behind_gets_just_that_change() {
        let f = fixture().await;
        f.noise(3);
        let synced = f.sync(Some(f.behind(1).await)).await;
        assert_eq!(change_seqs(&synced), vec![3]);
        assert_eq!(synced["seq"], 3);
        // Up to date: nothing to apply.
        assert!(change_seqs(&f.sync(Some(f.cursor().await)).await).is_empty());
    }

    #[tokio::test]
    async fn a_deletion_is_replayed() {
        let f = fixture().await;
        let summary = conversation_service::get_by_id(&f.db.conn, f.id)
            .await
            .unwrap();
        f.change(ConversationChange::Upsert {
            summary: Box::new(summary),
        });
        let before = f.cursor().await;
        conversation_service::soft_delete(&f.db.conn, f.id)
            .await
            .unwrap();
        f.change(ConversationChange::Deleted { id: f.id });
        let synced = f.sync(Some(before)).await;
        let changes = synced["changes"].as_array().unwrap();
        assert_eq!(changes.len(), 1, "{synced}");
        assert_eq!(changes[0]["kind"], "deleted");
        assert_eq!(changes[0]["id"], json!(f.id));
        assert_eq!(changes[0]["seq"], 2);
    }
}
