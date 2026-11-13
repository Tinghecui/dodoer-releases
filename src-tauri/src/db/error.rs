use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum DbError {
    #[error("database error: {0}")]
    Database(#[from] sea_orm::DbErr),
    #[error("migration error: {0}")]
    Migration(String),
    #[error("not found: {0}")]
    NotFound(String),
    #[error("validation error: {0}")]
    Validation(String),
    /// A cron expression that can't be scheduled. Split out of `Validation` so
    /// the API can tell the user which of three things is wrong, in their
    /// language (see [`CronProblem`]); the `Display` text stays the English
    /// detail the CLI and the chat-authoring tool read.
    #[error("validation error: {0}")]
    InvalidCron(CronProblem),
    /// A write that another row's claim on a unique key makes impossible, and
    /// that no retry can resolve — as opposed to the transient contention
    /// `Database` usually carries. Distinct because the caller's correct
    /// response differs: it must ABANDON the operation rather than retry it or
    /// treat it as a benign no-op.
    #[error("conflict: {0}")]
    Conflict(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Why a cron expression was rejected. Deliberately coarse — three kinds, not a
/// per-field diagnosis (decided 2026-11-13, AI QA #162): the editor shows one
/// localized sentence per kind plus an example, which is enough to fix any of
/// them, while the string payloads keep the precise English reason for logs,
/// the CLI and the LLM that authored the expression.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum CronProblem {
    /// Not 5 fields (6/7-field crate-native forms are tolerated, never offered).
    #[error("cron must have 5 fields (min hour dom mon dow), got {0}")]
    FieldCount(usize),
    /// The right number of fields, but one of them doesn't parse or is out of
    /// range (`99 99 * * *`, `*/0 * * * *`, an unknown `@macro`).
    #[error("{0}")]
    InvalidValue(String),
    /// Parses, but no instant ever matches (`0 0 31 2 *` — 31 February).
    #[error("cron '{0}' never fires: no date matches it")]
    NeverFires(String),
}

impl Serialize for DbError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}
