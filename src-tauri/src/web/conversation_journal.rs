//! Numbered `conversation://changed` changes (#673).
//!
//! Every change gets this run's `generation` and the next `seq` (from 1, one
//! apart) whether or not any client listens, and the latest
//! [`JOURNAL_CAPACITY`] stay here, deletions included. A client that comes back
//! with the last `{generation, seq}` it saw is sent only what came after; a
//! client this journal cannot serve gets the whole list again, with the reason.
//!
//! In memory only: a restart mints a new generation, and every client then
//! takes one full list.
//!
//! Cowork：照搬 dodoer #946（#673 PR4，`36f600659`）。我们分支上它挂在
//! `WebEventBroadcaster` 自己的锁下面（dodoer 挂在 display-status 缓存的锁下面），
//! 见 `event_bridge.rs` 的 `WebEventBroadcaster::send_shared`。

use std::collections::VecDeque;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use serde_json::Value;

/// How many changes stay for replay.
pub const JOURNAL_CAPACITY: usize = 2000;

/// Above this many missed changes a client gets the whole list instead.
pub const MAX_REPLAY: usize = 500;

/// The last change a client has applied.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationListCursor {
    pub generation: String,
    pub seq: u64,
}

/// Why a client gets the whole list instead of the changes it missed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotReason {
    /// The client sent no cursor (first load).
    NoCursor,
    /// The server restarted since the client's cursor.
    GenerationChanged,
    /// The changes after the cursor are no longer kept.
    CursorTooOld,
    /// The cursor is ahead of this server, which should not happen.
    CursorAhead,
    /// More than [`MAX_REPLAY`] changes were missed.
    TooManyChanges,
}

pub struct ConversationJournal {
    generation: String,
    seq: u64,
    /// `(seq, stamped payload)`, oldest first.
    entries: VecDeque<(u64, Arc<Value>)>,
    capacity: usize,
}

impl Default for ConversationJournal {
    fn default() -> Self {
        Self::with_capacity(JOURNAL_CAPACITY)
    }
}

impl ConversationJournal {
    pub fn with_capacity(capacity: usize) -> Self {
        Self {
            generation: uuid::Uuid::new_v4().simple().to_string(),
            seq: 0,
            entries: VecDeque::with_capacity(capacity.min(JOURNAL_CAPACITY)),
            capacity: capacity.max(1),
        }
    }

    pub fn cursor(&self) -> ConversationListCursor {
        ConversationListCursor {
            generation: self.generation.clone(),
            seq: self.seq,
        }
    }

    /// Number the change, keep it, and return it stamped with
    /// `generation` and `seq`. Must run under the lock that orders broadcasts,
    /// so kept order is broadcast order.
    pub fn record(&mut self, payload: Arc<Value>) -> Arc<Value> {
        self.seq += 1;
        let mut value = Arc::unwrap_or_clone(payload);
        if let Value::Object(map) = &mut value {
            map.insert("generation".into(), Value::String(self.generation.clone()));
            map.insert("seq".into(), Value::from(self.seq));
        }
        let stamped = Arc::new(value);
        if self.entries.len() == self.capacity {
            self.entries.pop_front();
        }
        self.entries.push_back((self.seq, stamped.clone()));
        stamped
    }

    /// The changes after `cursor`, in order, or why the client needs the
    /// whole list instead. At most `max` changes are replayed.
    pub fn since(
        &self,
        cursor: Option<&ConversationListCursor>,
        max: usize,
    ) -> Result<Vec<Arc<Value>>, SnapshotReason> {
        let cursor = cursor.ok_or(SnapshotReason::NoCursor)?;
        if cursor.generation != self.generation {
            return Err(SnapshotReason::GenerationChanged);
        }
        if cursor.seq > self.seq {
            return Err(SnapshotReason::CursorAhead);
        }
        let missed = self.seq - cursor.seq;
        if missed == 0 {
            return Ok(Vec::new());
        }
        // The first missed change must still be kept.
        let oldest = self.entries.front().map_or(self.seq + 1, |(seq, _)| *seq);
        if cursor.seq + 1 < oldest {
            return Err(SnapshotReason::CursorTooOld);
        }
        if missed > max as u64 {
            return Err(SnapshotReason::TooManyChanges);
        }
        let skip = (cursor.seq + 1 - oldest) as usize;
        Ok(self
            .entries
            .iter()
            .skip(skip)
            .map(|(_, payload)| payload.clone())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record_n(journal: &mut ConversationJournal, n: u64) {
        for i in 0..n {
            journal.record(Arc::new(json!({"kind": "deleted", "id": i})));
        }
    }

    fn at(journal: &ConversationJournal, seq: u64) -> ConversationListCursor {
        ConversationListCursor {
            generation: journal.cursor().generation,
            seq,
        }
    }

    fn seqs(changes: &[Arc<Value>]) -> Vec<u64> {
        changes.iter().map(|c| c["seq"].as_u64().unwrap()).collect()
    }

    #[test]
    fn stamps_generation_and_seq_from_one() {
        let mut journal = ConversationJournal::default();
        let first = journal.record(Arc::new(json!({"kind": "deleted", "id": 4})));
        let second = journal.record(Arc::new(json!({"kind": "deleted", "id": 5})));
        assert_eq!(first["seq"], 1);
        assert_eq!(second["seq"], 2);
        assert_eq!(first["generation"], json!(journal.cursor().generation));
        assert_eq!(first["kind"], "deleted");
        assert_eq!(first["id"], 4);
        assert_eq!(journal.cursor().seq, 2);
    }

    #[test]
    fn generations_differ_between_runs() {
        assert_ne!(
            ConversationJournal::default().cursor().generation,
            ConversationJournal::default().cursor().generation
        );
    }

    #[test]
    fn keeps_only_the_latest_2000() {
        let mut journal = ConversationJournal::default();
        record_n(&mut journal, 2100);
        assert_eq!(journal.entries.len(), JOURNAL_CAPACITY);
        assert_eq!(journal.entries.front().unwrap().0, 101);
        assert_eq!(journal.entries.back().unwrap().0, 2100);
        assert_eq!(
            journal.since(Some(&at(&journal, 99)), usize::MAX),
            Err(SnapshotReason::CursorTooOld)
        );
        // The oldest kept change is still replayable from just before it.
        let all = journal.since(Some(&at(&journal, 100)), usize::MAX).unwrap();
        assert_eq!(all.len(), JOURNAL_CAPACITY);
        assert_eq!(seqs(&all).first(), Some(&101));
    }

    #[test]
    fn no_cursor_needs_the_whole_list() {
        let journal = ConversationJournal::default();
        assert_eq!(
            journal.since(None, MAX_REPLAY),
            Err(SnapshotReason::NoCursor)
        );
    }

    #[test]
    fn another_generation_needs_the_whole_list() {
        let mut journal = ConversationJournal::default();
        record_n(&mut journal, 3);
        let stale = ConversationListCursor {
            generation: "an-earlier-run".into(),
            seq: 2,
        };
        assert_eq!(
            journal.since(Some(&stale), MAX_REPLAY),
            Err(SnapshotReason::GenerationChanged)
        );
    }

    #[test]
    fn a_cursor_ahead_needs_the_whole_list() {
        let mut journal = ConversationJournal::default();
        record_n(&mut journal, 3);
        assert_eq!(
            journal.since(Some(&at(&journal, 4)), MAX_REPLAY),
            Err(SnapshotReason::CursorAhead)
        );
    }

    #[test]
    fn an_up_to_date_cursor_gets_nothing() {
        let mut journal = ConversationJournal::default();
        assert_eq!(
            journal.since(Some(&at(&journal, 0)), MAX_REPLAY),
            Ok(vec![])
        );
        record_n(&mut journal, 3);
        assert_eq!(
            journal.since(Some(&at(&journal, 3)), MAX_REPLAY),
            Ok(vec![])
        );
    }

    #[test]
    fn one_behind_gets_the_one_change() {
        let mut journal = ConversationJournal::default();
        record_n(&mut journal, 3);
        let changes = journal.since(Some(&at(&journal, 2)), MAX_REPLAY).unwrap();
        assert_eq!(seqs(&changes), vec![3]);
    }

    #[test]
    fn more_than_the_replay_limit_needs_the_whole_list() {
        let mut journal = ConversationJournal::default();
        record_n(&mut journal, 2000);
        // 1999 behind: still kept, but too many to replay.
        assert_eq!(
            journal.since(Some(&at(&journal, 1)), MAX_REPLAY),
            Err(SnapshotReason::TooManyChanges)
        );
        let kept = journal.since(Some(&at(&journal, 1)), usize::MAX).unwrap();
        assert_eq!(seqs(&kept), (2..=2000).collect::<Vec<_>>());
        // Exactly at the limit is replayed.
        let at_limit = journal
            .since(Some(&at(&journal, 2000 - MAX_REPLAY as u64)), MAX_REPLAY)
            .unwrap();
        assert_eq!(at_limit.len(), MAX_REPLAY);
    }
}
