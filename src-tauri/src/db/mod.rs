mod downgrade;
pub mod entities;
pub mod error;
pub mod migration;
pub mod service;

#[cfg(any(test, feature = "test-utils"))]
pub mod test_helpers;

use std::path::{Path, PathBuf};
use std::time::Duration;

use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    TransactionTrait,
};
use sea_orm_migration::MigratorTrait;

use error::DbError;
use migration::Migrator;

pub struct AppDatabase {
    pub conn: DatabaseConnection,
}

pub fn database_file_name() -> &'static str {
    if cfg!(all(debug_assertions, feature = "tauri-runtime")) {
        "codeg-dev.db"
    } else {
        "codeg.db"
    }
}

/// The data dir holds provider API keys, tokens and every conversation; on a
/// shared Linux host the default umask leaves it readable by every user.
/// Best effort: a dir owned by someone else (a mounted volume) must not stop
/// the app from starting.
#[cfg(unix)]
fn restrict_to_owner(path: &Path, mode: u32) {
    use std::os::unix::fs::PermissionsExt;
    if let Err(e) = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode)) {
        eprintln!(
            "[DB] could not make {} private ({e}); other users on this machine may read it",
            path.display()
        );
    }
}

#[cfg(not(unix))]
fn restrict_to_owner(_path: &Path, _mode: u32) {}

pub async fn init_database(
    app_data_dir: impl AsRef<Path>,
    app_version: &str,
) -> Result<AppDatabase, DbError> {
    let app_data_dir = app_data_dir.as_ref();
    std::fs::create_dir_all(app_data_dir)?;
    restrict_to_owner(app_data_dir, 0o700);

    // Apply any pending restore BEFORE opening a connection — swapping
    // `codeg.db` under a live SQLite handle would corrupt it. A failure here
    // aborts startup loudly (leaving the safety snapshot intact) rather than
    // booting a half-restored data dir.
    match crate::commands::backup::restore::apply_pending_restore_on_startup(app_data_dir) {
        Ok(crate::commands::backup::restore::RestoreApplied::Applied { .. }) => {}
        Ok(crate::commands::backup::restore::RestoreApplied::None) => {}
        Err(e) => return Err(DbError::Io(e)),
    }
    crate::commands::backup::restore::cleanup_transient_dirs(app_data_dir);
    // A copy put back by an older start that was cut off half-way: finish it
    // before anything creates an empty database where it goes.
    downgrade::finish_interrupted_restore(app_data_dir)?;

    let db_path = app_data_dir.join(database_file_name());
    let db_url = format!(
        "sqlite:{}?mode=rwc",
        urlencoding::encode(&db_path.to_string_lossy())
    );

    // Apply migrations on a dedicated single connection. The runtime pool below
    // keeps several connections open for read concurrency, but sea-orm spreads a
    // migration's statements across whichever pooled connections are free. A
    // statement that references a column an earlier migration just added (e.g.
    // the `is_chat` → `kind` backfill) can then land on a connection whose
    // cached SQLite schema predates the `ALTER TABLE`, producing a flaky
    // `no such column: "is_chat"` under load. One connection observes every DDL
    // change in order, so the schema it compiles against is always current.
    if !db_path.exists() {
        std::fs::File::create(&db_path)?;
    }
    // SQLite gives its -wal and -shm the main file's mode.
    restrict_to_owner(&db_path, 0o600);
    let mut migrate_conn = connect_for_migration(&db_url).await?;
    // A database a newer version upgraded: put back the copy it left right
    // before that upgrade, or refuse, before anything touches it. The
    // connection is closed first, so the -wal is folded into the file that
    // gets moved aside.
    let applied = applied_migrations(&migrate_conn).await?;
    if let Some(unknown) = first_unknown_migration(&applied, &known_migrations()) {
        migrate_conn.close().await?;
        downgrade::restore_copy_before_upgrade(app_data_dir, &unknown).await?;
        migrate_conn = connect_for_migration(&db_url).await?;
    }
    let snapshot = snapshot_before_migrations(&migrate_conn, app_data_dir).await?;
    migrate_one_at_a_time(&migrate_conn).await.map_err(|e| {
        DbError::Migration(match &snapshot {
            Some(path) => format!(
                "{e}. The database as it was before this upgrade is saved at {}",
                path.display()
            ),
            None => e.to_string(),
        })
    })?;
    // The upgrade went through: this copy, and any an earlier start left
    // unmarked (stopped between the commit and the rename), are done.
    settle_pre_migrate_copies(app_data_dir);
    migrate_conn.close().await?;

    // Runtime connection pool. Migrations are already applied above, so the
    // schema is stable and spreading queries across pooled connections is safe.
    let mut opts = ConnectOptions::new(db_url);
    opts.max_connections(5)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .idle_timeout(Duration::from_secs(300))
        .sqlx_logging(false);
    let conn = Database::connect(opts).await?;
    apply_sqlite_pragmas(&conn).await?;

    service::app_metadata_service::update_app_version(&conn, app_version).await?;

    // Publish user-registered ACP agents into the process-global launch
    // registry before anything can ask for agent metadata. This is the single
    // chokepoint every runtime (desktop, server) goes through, so custom agents
    // are live from the first `all_acp_agents()` / `get_agent_meta()` call.
    // A failure here must not block startup — the built-in agents still work.
    if let Err(e) = service::custom_agent_service::hydrate_registry(&conn).await {
        tracing::warn!("[custom-agent] failed to hydrate custom agent registry: {e}");
    }

    // Load user-authorized workspace links before any file command can run, so
    // the workspace path guard follows exactly the symlinks the user created
    // and nothing else. A failure here fails *closed* (registry stays empty:
    // linked subtrees look unreadable) rather than blocking startup.
    match crate::folder_links::hydrate(&conn).await {
        Ok(count) if count > 0 => {
            tracing::info!("[folder-link] hydrated {count} workspace link(s)");
        }
        Ok(_) => {}
        Err(e) => tracing::warn!("[folder-link] failed to hydrate workspace links: {e}"),
    }

    Ok(AppDatabase { conn })
}

/// 桌面版启动时 [`init_database`] 失败，弹框里给人看的正文：中英各一句说怎么回事、
/// 该怎么办，原来的库在哪，最后附上原文。库是更新的版本升级过的（换不回升级前的
/// 副本，见 `downgrade`）单独说，不动用户的数据（#1258）。
#[cfg(any(feature = "tauri-runtime", test))]
#[cfg_attr(not(feature = "tauri-runtime"), allow(dead_code))]
pub fn open_failure_message(err: &DbError, app_data_dir: &Path) -> String {
    let detail = err.to_string();
    let db_path = app_data_dir.join(database_file_name());
    let upgraded_by_newer = matches!(err, DbError::Migration(m)
        if m.contains("upgraded by another version") || m.contains("Migration file of version"));
    let (zh, en) = if upgraded_by_newer {
        (
            "这份数据是更新的版本升级过的，这个版本打不开。请装回新版本或恢复备份。数据没有被改动。",
            "This data was upgraded by a newer version, which this version cannot open. \
             Install the newer version again or restore a backup. Nothing was changed.",
        )
    } else {
        (
            "打不开数据库，这次启动不了。",
            "The database could not be opened, so the app cannot start.",
        )
    };
    format!(
        "{zh}\n{en}\n\n数据库 / Database: {}\n\n{detail}",
        db_path.display()
    )
}

/// Where [`snapshot_before_migrations`] keeps its copies, under the data dir.
pub(crate) const PRE_MIGRATE_DIR: &str = "backups/pre-migrate";

/// The copies of this build's database. A debug build keeps `codeg-dev.db`
/// in the same data dir: its copies and its upgrade under way are its own, or
/// it would settle or replace the release database's copy.
fn pre_migrate_dir(app_data_dir: &Path) -> PathBuf {
    match database_file_name().strip_suffix(".db") {
        Some("codeg") | None => app_data_dir.join(PRE_MIGRATE_DIR),
        Some(stem) => app_data_dir.join(format!("{PRE_MIGRATE_DIR}-{stem}")),
    }
}
/// How many pre-migration copies to keep; older ones are deleted.
const PRE_MIGRATE_KEEP: usize = 3;

/// Apply pending migrations, each with its record in one transaction. sea-orm
/// runs SQLite migrations without one, so a migration stopped between two
/// statements (a crash, a kill, a full disk) left its first change behind
/// unrecorded, and every later start failed on it ("duplicate column").
/// SQLite rolls schema changes back like any other, so now an interrupted
/// migration leaves nothing and simply runs again.
async fn migrate_one_at_a_time(conn: &DatabaseConnection) -> Result<(), sea_orm::DbErr> {
    let pending = Migrator::get_pending_migrations(conn).await?.len();
    for _ in 0..pending {
        let txn = conn.begin().await?;
        Migrator::up(&txn, Some(1)).await?;
        txn.commit().await?;
    }
    Ok(())
}

/// The single connection migrations run on (see the note in
/// [`init_database`]).
async fn connect_for_migration(db_url: &str) -> Result<DatabaseConnection, DbError> {
    let mut opts = ConnectOptions::new(db_url.to_owned());
    opts.max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .sqlx_logging(false);
    let conn = Database::connect(opts).await?;
    apply_sqlite_pragmas(&conn).await?;
    Ok(conn)
}

/// The migrations this binary has, by name.
fn known_migrations() -> Vec<String> {
    Migrator::migrations()
        .iter()
        .map(|m| m.name().to_string())
        .collect()
}

/// The migrations a database has had applied, by name; none for a new one.
async fn applied_migrations(conn: &DatabaseConnection) -> Result<Vec<String>, sea_orm::DbErr> {
    let has_table = conn
        .query_one(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'seaql_migrations'",
        ))
        .await?
        .is_some();
    if !has_table {
        return Ok(Vec::new());
    }
    Ok(conn
        .query_all(Statement::from_string(
            DbBackend::Sqlite,
            "SELECT version FROM seaql_migrations ORDER BY version",
        ))
        .await?
        .iter()
        .filter_map(|row| row.try_get::<String>("", "version").ok())
        .collect())
}

/// A migration the database has that this binary does not: another version,
/// most likely a newer one, upgraded it.
fn first_unknown_migration(applied: &[String], known: &[String]) -> Option<String> {
    applied.iter().find(|v| !known.contains(v)).cloned()
}

/// Before migrations change an existing database, keep a copy of it as it
/// was: SQLite runs a migration without a transaction, so one that fails
/// half-way leaves a schema neither version opens, and a migrated database is
/// one the previous version refuses. Returns the copy's path, or `None` when
/// nothing is pending or the database is new.
///
/// A database a newer version upgraded never gets here: `init_database` puts
/// back the copy from before that upgrade, or refuses (see `downgrade`).
async fn snapshot_before_migrations(
    conn: &DatabaseConnection,
    app_data_dir: &Path,
) -> Result<Option<PathBuf>, DbError> {
    let applied = applied_migrations(conn).await?;
    let known = known_migrations();
    if applied.is_empty() {
        return Ok(None);
    }
    if known.iter().all(|name| applied.contains(name)) {
        return Ok(None);
    }

    // Without the copy the upgrade still runs, as it always did: refusing to
    // start over a full disk would leave no way in at all.
    match save_pre_migrate_copy(conn, app_data_dir, &applied).await {
        Ok(path) => Ok(Some(path)),
        Err(reason) => {
            tracing::warn!(
                "[db] could not save a copy of the database before upgrading it: {reason}"
            );
            eprintln!("[db] WARNING: upgrading the database without a copy of it: {reason}");
            Ok(None)
        }
    }
}

/// Mark a copy whose upgrade went through, so a later upgrade from the same
/// version (after restoring an older backup, say) takes a fresh copy instead
/// of reusing this one, which no longer matches the database.
fn settle_pre_migrate_copy(path: &Path) {
    let settled = path.with_extension("done.db");
    if let Err(e) = std::fs::rename(path, &settled) {
        tracing::warn!("[db] could not mark {} as done: {e}", path.display());
    }
}

/// Mark every unmarked copy done, once the database is fully upgraded, and
/// forget which upgrade was under way.
fn settle_pre_migrate_copies(app_data_dir: &Path) {
    let dir = pre_migrate_dir(app_data_dir);
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };
    for path in entries.filter_map(|e| e.ok().map(|e| e.path())) {
        if unsettled(&path) {
            settle_pre_migrate_copy(&path);
        }
    }
    let _ = std::fs::remove_file(dir.join(UPGRADE_UNDER_WAY));
}

/// Names the copy of an upgrade that has not gone through yet, and how many
/// migrations the database had then. Only that copy is taken up again: one
/// left unmarked by an older version, by a failed rename or before a restored
/// backup is not "the database before this upgrade".
const UPGRADE_UNDER_WAY: &str = "upgrade-under-way";

/// A copy taken before an upgrade that has not gone through yet.
fn unsettled(path: &Path) -> bool {
    let name = path.to_string_lossy();
    name.ends_with(".db") && !name.ends_with(".done.db")
}

/// Copy the database into `backups/pre-migrate`, keeping the newest few.
async fn save_pre_migrate_copy(
    conn: &DatabaseConnection,
    app_data_dir: &Path,
    applied: &[String],
) -> Result<PathBuf, String> {
    let last_applied = applied.last().map(String::as_str).unwrap_or_default();
    let dir = pre_migrate_dir(app_data_dir);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    restrict_to_owner(&dir, 0o700);
    let listed: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| format!("{}: {e}", dir.display()))?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    // A copy cut short by a kill is no copy.
    for partial in listed
        .iter()
        .filter(|p| p.extension().is_some_and(|e| e == "partial"))
    {
        let _ = std::fs::remove_file(partial);
    }

    // An upgrade that failed part way (its first steps went through) is
    // tried again on the next start: the copy from before the first try is
    // the one to keep, not one of the half-upgraded database. If nothing was
    // upgraded since (it failed at its first step), the database may have
    // been used on by the version it came from: take a new copy. Counted, not
    // compared by the last name: a pending migration can sort before one
    // already applied (a merged branch).
    let marker = dir.join(UPGRADE_UNDER_WAY);
    let recorded = std::fs::read_to_string(&marker).unwrap_or_default();
    let mut lines = recorded.lines();
    let under_way = lines
        .next()
        .map(|name| dir.join(name.trim()))
        .filter(|path| unsettled(path) && path.is_file());
    let applied_then = lines.next().and_then(|n| n.trim().parse::<usize>().ok());
    if let (Some(earlier), Some(then)) = (&under_way, applied_then) {
        if applied.len() > then {
            return Ok(earlier.clone());
        }
    }
    let name = format!(
        "{}-{last_applied}.db",
        chrono::Utc::now().format("%Y%m%d-%H%M%S%3f")
    );
    let dest = dir.join(&name);
    let partial = dest.with_extension("partial");
    if let Err(e) = crate::commands::backup::core::snapshot_db_to(conn, &partial).await {
        let _ = std::fs::remove_file(&partial);
        return Err(e.detail.unwrap_or(e.message));
    }
    std::fs::rename(&partial, &dest).map_err(|e| format!("{}: {e}", dest.display()))?;
    restrict_to_owner(&dest, 0o600);
    // Without the marker the copy is still a copy; the next start just
    // won't take it up again.
    if let Err(e) = std::fs::write(&marker, format!("{name}\n{}\n", applied.len())) {
        tracing::warn!("[db] could not record {}: {e}", marker.display());
    }

    // The copy it replaces was taken at the same migration count, so it holds
    // nothing this one doesn't: keeping it would only push finished upgrades'
    // copies out (a container restarting on a failing upgrade takes a copy
    // every start).
    if let Some(replaced) = under_way {
        if applied_then == Some(applied.len()) {
            let _ = std::fs::remove_file(replaced);
        } else {
            settle_pre_migrate_copy(&replaced);
        }
    }
    tracing::info!(
        "[db] saved the database before migrating it: {}",
        dest.display()
    );

    // Only finished upgrades' copies are pruned; the new one is unsettled.
    let mut copies: Vec<PathBuf> = listed
        .into_iter()
        .filter(|path| path.to_string_lossy().ends_with(".done.db"))
        .collect();
    copies.sort();
    let excess = copies.len().saturating_sub(PRE_MIGRATE_KEEP - 1);
    for old in &copies[..excess] {
        if let Err(e) = std::fs::remove_file(old) {
            tracing::warn!(
                "[db] could not delete an old pre-migration copy {}: {e}",
                old.display()
            );
        }
    }
    Ok(dest)
}

/// Apply SQLite performance and reliability pragmas to a freshly opened
/// connection. `journal_mode=WAL` persists in the database header; the rest are
/// per-connection settings that must be re-applied every time a connection opens.
async fn apply_sqlite_pragmas(conn: &DatabaseConnection) -> Result<(), DbError> {
    for pragma in [
        "PRAGMA journal_mode=WAL;",
        "PRAGMA busy_timeout=5000;",
        "PRAGMA synchronous=NORMAL;",
        "PRAGMA foreign_keys=ON;",
        "PRAGMA cache_size=-8000;",
    ] {
        conn.execute(Statement::from_string(DbBackend::Sqlite, pragma.to_owned()))
            .await?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    async fn open(path: &Path) -> DatabaseConnection {
        // One connection, as `init_database` migrates on: see the note there.
        let mut opts = ConnectOptions::new(format!("sqlite:{}?mode=rwc", path.display()));
        opts.max_connections(1)
            .min_connections(1)
            .sqlx_logging(false);
        Database::connect(opts).await.expect("open")
    }

    async fn migration_count(path: &Path) -> i64 {
        let conn = open(path).await;
        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS n FROM seaql_migrations",
            ))
            .await
            .expect("count")
            .expect("row");
        let n = row.try_get::<i64>("", "n").expect("n");
        conn.close().await.expect("close");
        n
    }

    fn pre_migrate_copies(dir: &Path) -> Vec<PathBuf> {
        std::fs::read_dir(pre_migrate_dir(dir))
            .map(|entries| {
                entries
                    .filter_map(|e| e.ok().map(|e| e.path()))
                    .filter(|p| p.extension().is_some_and(|e| e == "db"))
                    .collect()
            })
            .unwrap_or_default()
    }

    // An upgrade that has migrations to run keeps the database as it was, so
    // a migration that fails half-way, or a rollback to the version before,
    // has something to go back to.
    #[tokio::test]
    async fn an_upgrade_keeps_the_database_as_it_was() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let total = Migrator::migrations().len() as u32;
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(total - 1))
            .await
            .expect("old schema");
        conn.close().await.expect("close");

        init_database(dir.path(), "test").await.expect("upgrade");

        let copies = pre_migrate_copies(dir.path());
        assert_eq!(copies.len(), 1, "one copy before the upgrade: {copies:?}");
        assert_eq!(migration_count(&copies[0]).await, i64::from(total - 1));
        assert_eq!(migration_count(&db_path).await, i64::from(total));

        // Nothing pending on the next start: no new copy.
        init_database(dir.path(), "test").await.expect("reopen");
        assert_eq!(pre_migrate_copies(dir.path()).len(), 1);
    }

    // A migration that fails part way is tried again on the next start. The
    // copy to keep is the one from before the first try, not one of the
    // half-upgraded database; and like the database it is the owner's alone.
    #[tokio::test]
    async fn a_retried_upgrade_keeps_the_first_copy() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let total = Migrator::migrations().len() as u32;
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(total - 2))
            .await
            .expect("old schema");
        let first = snapshot_before_migrations(&conn, dir.path())
            .await
            .expect("first try")
            .expect("a copy");
        // The first try went part way: one of the two steps went through.
        Migrator::up(&conn, Some(1)).await.expect("one step");
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        let again = snapshot_before_migrations(&conn, dir.path())
            .await
            .expect("second try")
            .expect("a copy");
        conn.close().await.expect("close");
        assert_eq!(again, first);
        assert_eq!(pre_migrate_copies(dir.path()).len(), 1);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&first).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    // A migration that fails between two statements must leave nothing
    // behind, or every later start fails on its first change. Here its second
    // column is already there, so the second statement fails.
    #[tokio::test]
    async fn a_migration_that_fails_part_way_leaves_nothing_behind() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let idx = Migrator::migrations()
            .iter()
            .position(|m| m.name() == "m20261016_000002_conversation_assistant")
            .expect("migration is registered");
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("schema before it");
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "ALTER TABLE conversation ADD COLUMN assistant_snapshot TEXT",
        ))
        .await
        .expect("the column its second statement adds");
        conn.close().await.expect("close");

        assert!(init_database(dir.path(), "test").await.is_err());

        let conn = open(&db_path).await;
        let first_change = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT 1 FROM pragma_table_info('conversation') WHERE name = 'assistant_id'",
            ))
            .await
            .expect("query");
        conn.close().await.expect("close");
        assert!(
            first_change.is_none(),
            "the first statement was not rolled back"
        );
        assert_eq!(migration_count(&db_path).await, idx as i64);
    }

    // An upgrade of several steps that stops after its first: the next try
    // starts from a later version but must still point at, and keep, the copy
    // from before the first step, and mark it done once it goes through.
    #[tokio::test]
    async fn an_upgrade_stopped_after_its_first_step_keeps_the_first_copy() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let idx = Migrator::migrations()
            .iter()
            .position(|m| m.name() == "m20261016_000002_conversation_assistant")
            .expect("migration is registered");
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(idx as u32 - 1))
            .await
            .expect("two steps before it");
        let add = "ALTER TABLE conversation ADD COLUMN assistant_snapshot TEXT";
        conn.execute(Statement::from_string(DbBackend::Sqlite, add))
            .await
            .expect("the column its second statement adds");
        conn.close().await.expect("close");

        let mut errors = Vec::new();
        for _ in 0..2 {
            errors.push(
                init_database(dir.path(), "test")
                    .await
                    .err()
                    .expect("fails")
                    .to_string(),
            );
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
        let copies = pre_migrate_copies(dir.path());
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert_eq!(migration_count(&copies[0]).await, idx as i64 - 1);
        let named = copies[0].display().to_string();
        assert!(errors.iter().all(|e| e.contains(&named)), "{errors:?}");

        let conn = open(&db_path).await;
        conn.execute(Statement::from_string(
            DbBackend::Sqlite,
            "ALTER TABLE conversation DROP COLUMN assistant_snapshot",
        ))
        .await
        .expect("drop it again");
        conn.close().await.expect("close");
        let db = init_database(dir.path(), "test").await.expect("upgrade");
        db.conn.close().await.expect("close");
        let copies = pre_migrate_copies(dir.path());
        assert_eq!(copies.len(), 1, "{copies:?}");
        assert!(
            copies[0].to_string_lossy().ends_with(".done.db"),
            "{copies:?}"
        );
    }

    /// The copy an upgrade error names.
    fn named_copy(err: &str, copies_dir: &Path) -> PathBuf {
        let at = err
            .find(&*copies_dir.to_string_lossy())
            .unwrap_or_else(|| panic!("the error names no copy: {err}"));
        let rest = &err[at..];
        PathBuf::from(&rest[..rest.find(".db").expect("a .db name") + 3])
    }

    // A container that fails its upgrade at the first step restarts again and
    // again, often within a second. Each start takes a copy; none of that may
    // push out the copies of earlier upgrades that went through, and the copy
    // the error names must be there.
    #[tokio::test]
    async fn restarts_on_a_failing_upgrade_keep_the_earlier_copies() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let idx = Migrator::migrations()
            .iter()
            .position(|m| m.name() == "m20261016_000002_conversation_assistant")
            .expect("migration is registered");
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("every step before it");
        let add = "ALTER TABLE conversation ADD COLUMN assistant_snapshot TEXT";
        conn.execute(Statement::from_string(DbBackend::Sqlite, add))
            .await
            .expect("the column it adds, so it fails");
        conn.close().await.expect("close");
        let copies_dir = pre_migrate_dir(dir.path());
        std::fs::create_dir_all(&copies_dir).unwrap();
        let earlier = [
            "20250101-000000-m20250101_000001_a.done.db",
            "20250201-000000-m20250101_000001_a.done.db",
        ];
        for name in earlier {
            std::fs::write(copies_dir.join(name), "earlier").unwrap();
        }
        for _ in 0..3 {
            let err = init_database(dir.path(), "test")
                .await
                .err()
                .expect("fails");
            let named = named_copy(&err.to_string(), &copies_dir);
            assert!(named.is_file(), "{err}");
        }
        for name in earlier {
            assert!(copies_dir.join(name).is_file(), "{name} was deleted");
        }
        let unsettled: Vec<_> = pre_migrate_copies(dir.path())
            .into_iter()
            .filter(|c| unsettled(c))
            .collect();
        assert_eq!(unsettled.len(), 1, "{unsettled:?}");
    }

    // Pending migrations can sort before one already applied (a merged
    // branch). When the first of them goes through and the next fails, the
    // last migration name does not change: the upgrade is still half done,
    // and the copy from before it must stay the one the error names.
    #[tokio::test]
    async fn a_half_done_upgrade_out_of_name_order_keeps_its_copy() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let conn = open(&db_path).await;
        Migrator::up(&conn, None).await.expect("every step");
        for sql in [
            "ALTER TABLE work_task DROP COLUMN deferred_at",
            "DELETE FROM seaql_migrations WHERE version IN \
             ('m20261015_000001_work_task_deferred_at', 'm20261016_000002_conversation_assistant')",
        ] {
            conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
                .await
                .expect("two steps pending, the second fails");
        }
        conn.close().await.expect("close");
        let copies_dir = pre_migrate_dir(dir.path());
        let first = init_database(dir.path(), "test")
            .await
            .err()
            .expect("fails");
        let first = named_copy(&first.to_string(), &copies_dir);
        let second = init_database(dir.path(), "test")
            .await
            .err()
            .expect("fails");
        let second = named_copy(&second.to_string(), &copies_dir);
        assert!(
            first.is_file(),
            "the copy from before the upgrade is gone: {first:?}"
        );
        assert_eq!(second, first);
    }

    // A debug build keeps its own database beside the release one. Its
    // upgrade must not touch the copy of a release upgrade under way.
    #[tokio::test]
    async fn another_builds_upgrade_copy_is_left_alone() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let total = Migrator::migrations().len() as u32;
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(total - 1))
            .await
            .expect("old schema");
        conn.close().await.expect("close");
        let theirs = dir.path().join(PRE_MIGRATE_DIR);
        std::fs::create_dir_all(&theirs).unwrap();
        let name = format!(
            "20260101-000000000-{}.db",
            Migrator::migrations()[total as usize - 2].name()
        );
        std::fs::write(theirs.join(&name), "the release database").unwrap();
        std::fs::write(
            theirs.join(UPGRADE_UNDER_WAY),
            format!("{name}\n{}\n", total - 1),
        )
        .unwrap();
        if database_file_name() == "codeg.db" {
            return; // this build is the release one: nothing to share
        }
        let db = init_database(dir.path(), "test").await.expect("upgrade");
        db.conn.close().await.expect("close");
        assert!(
            theirs.join(&name).is_file(),
            "{:?}",
            std::fs::read_dir(&theirs).unwrap().collect::<Vec<_>>()
        );
    }

    // A copy left unmarked by something else (an older version, a failed
    // rename, a backup restored after it) is not the copy of this upgrade,
    // even when its version is one the database has.
    #[tokio::test]
    async fn a_stray_unmarked_copy_is_not_taken_for_this_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let migrations = Migrator::migrations();
        let total = migrations.len() as u32;
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(total - 1))
            .await
            .expect("old schema");
        conn.close().await.expect("close");
        let copies_dir = pre_migrate_dir(dir.path());
        std::fs::create_dir_all(&copies_dir).unwrap();
        let stray = copies_dir.join(format!("20250101-000000-{}.db", migrations[0].name()));
        std::fs::write(&stray, "not this database").unwrap();
        let db = init_database(dir.path(), "test").await.expect("upgrade");
        db.conn.close().await.expect("close");
        let copies = pre_migrate_copies(dir.path());
        assert_eq!(copies.len(), 2, "{copies:?}");
        let newest = copies.iter().max().unwrap();
        assert!(
            std::fs::read(newest)
                .unwrap()
                .starts_with(b"SQLite format 3"),
            "the copy of this upgrade is {newest:?}"
        );
    }

    // An upgrade that failed before changing anything leaves its copy
    // unmarked. If the database is then used on (by the version it came from)
    // and a later start upgrades it, that old copy is not "the database before
    // this upgrade": a new copy must hold what was written since. And once an
    // upgrade has gone through, no copy is left unmarked.
    #[tokio::test]
    async fn an_old_unmarked_copy_is_not_taken_for_a_new_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let idx = Migrator::migrations()
            .iter()
            .position(|m| m.name() == "m20261016_000002_conversation_assistant")
            .expect("migration is registered");
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("every step before it");
        let add = "ALTER TABLE conversation ADD COLUMN assistant_snapshot TEXT";
        conn.execute(Statement::from_string(DbBackend::Sqlite, add))
            .await
            .expect("the column it adds, so it fails");
        conn.close().await.expect("close");
        init_database(dir.path(), "test")
            .await
            .err()
            .expect("fails");
        tokio::time::sleep(std::time::Duration::from_millis(1100)).await;

        let conn = open(&db_path).await;
        for sql in [
            "ALTER TABLE conversation DROP COLUMN assistant_snapshot",
            "CREATE TABLE written_since (x INTEGER)",
        ] {
            conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
                .await
                .expect("used on by the old version");
        }
        conn.close().await.expect("close");
        let db = init_database(dir.path(), "test").await.expect("upgrade");
        db.conn.close().await.expect("close");

        let copies = pre_migrate_copies(dir.path());
        assert!(
            copies
                .iter()
                .all(|c| c.to_string_lossy().ends_with(".done.db")),
            "{copies:?}"
        );
        let newest = copies.iter().max().expect("a copy");
        let copy = open(newest).await;
        let has = copy
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT 1 FROM sqlite_master WHERE name = 'written_since'",
            ))
            .await
            .expect("query")
            .is_some();
        copy.close().await.expect("close");
        assert!(has, "the copy misses what was written since: {newest:?}");
    }

    // After an upgrade went through, upgrading again from the same version
    // (an older backup restored) must copy the database as it is now, not
    // hand back the copy from the first time.
    #[tokio::test]
    async fn a_second_upgrade_from_the_same_version_takes_a_new_copy() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let total = Migrator::migrations().len() as u32;
        for _ in 0..2 {
            for suffix in ["", "-wal", "-shm"] {
                let _ = std::fs::remove_file(format!("{}{suffix}", db_path.display()));
            }
            let conn = open(&db_path).await;
            Migrator::up(&conn, Some(total - 1))
                .await
                .expect("old schema");
            conn.close().await.expect("close");
            let db = init_database(dir.path(), "test").await.expect("upgrade");
            db.conn.close().await.expect("close");
            tokio::time::sleep(std::time::Duration::from_millis(1100)).await;
        }
        assert_eq!(pre_migrate_copies(dir.path()).len(), 2);
    }

    // A copy that cannot be made (a full disk; here, a file where the folder
    // goes) must not keep the app from starting: the upgrade runs as before.
    #[tokio::test]
    async fn an_upgrade_without_room_for_a_copy_still_starts() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join(database_file_name());
        let total = Migrator::migrations().len() as u32;
        let conn = open(&db_path).await;
        Migrator::up(&conn, Some(total - 1))
            .await
            .expect("old schema");
        conn.close().await.expect("close");
        std::fs::create_dir_all(dir.path().join("backups")).unwrap();
        std::fs::write(pre_migrate_dir(dir.path()), b"not a folder").unwrap();

        init_database(dir.path(), "test")
            .await
            .expect("the upgrade runs without the copy");
        assert_eq!(migration_count(&db_path).await, i64::from(total));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_data_dir_is_readable_by_its_owner_only() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let data = dir.path().join("data");
        std::fs::create_dir(&data).unwrap();
        std::fs::set_permissions(&data, std::fs::Permissions::from_mode(0o755)).unwrap();
        let db = init_database(&data, "test").await.unwrap();
        drop(db);
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&data), 0o700);
        assert_eq!(mode(&data.join(database_file_name())), 0o600);
    }

    #[tokio::test]
    async fn a_new_database_needs_no_copy() {
        let dir = tempfile::tempdir().unwrap();
        init_database(dir.path(), "test").await.expect("create");
        assert!(pre_migrate_copies(dir.path()).is_empty());
    }

    // Opening a database a newer version wrote must say so, and leave it
    // untouched.
    #[tokio::test]
    async fn a_database_from_a_newer_version_is_refused_with_a_clear_reason() {
        let dir = tempfile::tempdir().unwrap();
        let db = init_database(dir.path(), "test").await.expect("create");
        db.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "INSERT INTO seaql_migrations (version, applied_at) \
                 VALUES ('m29990101_000001_future', 0)",
            ))
            .await
            .expect("future row");
        db.conn.close().await.expect("close");
        let db_path = dir.path().join(database_file_name());
        let before = migration_count(&db_path).await;

        let err = match init_database(dir.path(), "test").await {
            Ok(_) => panic!("a newer database must be refused"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("another version"), "{err}");
        assert!(err.contains("m29990101_000001_future"), "{err}");
        assert_eq!(migration_count(&db_path).await, before);
        assert!(pre_migrate_copies(dir.path()).is_empty());
    }
}
