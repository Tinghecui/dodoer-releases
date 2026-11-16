//! 旧版本打开新版本升级过的库（库里有这一版不认的迁移）：换回新版本升级前那一刻
//! 留下的副本（#363 的 `backups/pre-migrate/`），正常起来。原来的库连同 `-wal`、
//! `-shm` 挪到 `backups/downgrade-replaced/<时间>/`，不删：新版本升级以后写的东西
//! 都在那里面。找不到那一刻的副本就拒绝启动，什么都不动。
//!
//! 步骤：副本先复制成 `<库>.restoring`，再把原库挪走，再把 `<库>.restoring` 改名
//! 成库，删掉用掉的副本和 `upgrade-under-way` 标记。每一步被打断，下次启动都能接上
//! （见 [`finish_interrupted_restore`]）。

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::time::Duration;

use sea_orm::{ConnectOptions, Database};

use super::error::DbError;
use super::{
    applied_migrations, database_file_name, known_migrations, pre_migrate_dir, restrict_to_owner,
    UPGRADE_UNDER_WAY,
};

/// 换库时原来的库挪到这里，按时间分目录。
pub(super) const REPLACED_DIR: &str = "backups/downgrade-replaced";

/// 换库时副本先复制成这个名字，复制完了才放到库的位置上。
fn restoring_path(db_path: &Path) -> PathBuf {
    PathBuf::from(format!("{}.restoring", db_path.display()))
}

fn sidecar(db_path: &Path, suffix: &str) -> PathBuf {
    PathBuf::from(format!("{}{suffix}", db_path.display()))
}

/// 上一次换库被打断（断电、被杀）时接着做完。库还在：复制可能没完，副本也还在，
/// 删掉 `.restoring`，后面重新换一次。库不在（已经挪走了）：剩下的 `-wal`、`-shm`
/// 也挪走，再把 `.restoring` 放到库的位置上。
pub(super) fn finish_interrupted_restore(app_data_dir: &Path) -> Result<(), DbError> {
    let db_path = app_data_dir.join(database_file_name());
    let restoring = restoring_path(&db_path);
    if !restoring.exists() {
        return Ok(());
    }
    if db_path.exists() {
        tracing::warn!(
            "[db] dropping {}: an earlier start was cut off while copying it; the copy is \
             still in {}",
            restoring.display(),
            pre_migrate_dir(app_data_dir).display()
        );
        std::fs::remove_file(&restoring)?;
        return Ok(());
    }
    let leftovers = ["-wal", "-shm"]
        .iter()
        .any(|suffix| sidecar(&db_path, suffix).exists());
    if leftovers {
        let replaced = move_aside(app_data_dir, &db_path)?;
        tracing::warn!(
            "[db] moved what was left of the replaced database to {}",
            replaced.display()
        );
    }
    std::fs::rename(&restoring, &db_path).map_err(|e| {
        DbError::Migration(format!(
            "could not finish putting back the copy made before an upgrade: moving {} to {} \
             failed: {e}. Move it there by hand; the replaced database is in {}",
            restoring.display(),
            db_path.display(),
            app_data_dir.join(REPLACED_DIR).display()
        ))
    })?;
    restrict_to_owner(&db_path, 0o600);
    // 放回来的库不是那次升级拷的，下次升级要重新拍。
    let _ = std::fs::remove_file(pre_migrate_dir(app_data_dir).join(UPGRADE_UNDER_WAY));
    tracing::warn!(
        "[db] finished putting back the copy made before an upgrade: {}",
        db_path.display()
    );
    eprintln!(
        "[db] finished putting back the database copy made before an upgrade; the replaced \
         database is in {}",
        app_data_dir.join(REPLACED_DIR).display()
    );
    Ok(())
}

/// 库被一个更新的版本升级过（它有迁移 `unknown`）：换回那个版本升级前那一刻的副本。
/// 返回原来的库挪去的目录。调用前要关掉所有连这个库的连接。
pub(super) async fn restore_copy_before_upgrade(
    app_data_dir: &Path,
    unknown: &str,
) -> Result<PathBuf, DbError> {
    // Cowork fork: the product name, not jenny's.
    let product = crate::cowork::PRODUCT_NAME;
    let db_path = app_data_dir.join(database_file_name());
    let copies_dir = pre_migrate_dir(app_data_dir);
    let Some(current) = migrations_in(&db_path).await else {
        return Err(DbError::Migration(format!(
            "this database was upgraded by another version of {product} (it has migration \
             {unknown}, which this version does not know), and its migrations could not be \
             read to pick the copy made before that upgrade. Nothing was changed. Run the \
             newer version again, or restore a backup made with this one"
        )));
    };
    let known = known_migrations();

    // 从新到旧（文件名以时间开头），`.db` 和 `.done.db` 都算，`.partial` 不算。
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(&copies_dir)
        .map(|entries| {
            entries
                .filter_map(|e| e.ok().map(|e| e.path()))
                .filter(|p| p.is_file() && p.to_string_lossy().ends_with(".db"))
                .collect()
        })
        .unwrap_or_default();
    candidates.sort();
    candidates.reverse();
    let mut older = 0usize;
    let mut chosen = None;
    for copy in candidates {
        match migrations_in(&copy).await {
            None => tracing::warn!(
                "[db] skipping {}: this version cannot read it",
                copy.display()
            ),
            Some(migrations) if copy_matches_the_upgrade(&migrations, &current, &known) => {
                chosen = Some(copy);
                break;
            }
            Some(_) => older += 1,
        }
    }
    let Some(copy) = chosen else {
        let older_note = match older {
            0 => String::new(),
            1 => " A copy was found there, but it was made before an earlier upgrade, not \
                  right before the newer version's, so it was not used: restoring it would \
                  lose everything written after it."
                .to_string(),
            n => format!(
                " {n} copies were found there, but they were made before earlier upgrades, \
                 not right before the newer version's, so they were not used: restoring one \
                 would lose everything written after it."
            ),
        };
        return Err(DbError::Migration(format!(
            "this database was upgraded by another version of {product}, most likely a newer \
             one (it has migration {unknown}, which this version does not know), and no copy \
             made before that upgrade was found in {} that this version can open.{older_note} \
             Nothing was changed. Run the newer version again, or restore a backup made with \
             this one",
            copies_dir.display()
        )));
    };

    // 1. 副本先复制到库旁边，复制完、落了盘才动原库。
    let restoring = restoring_path(&db_path);
    let staged =
        std::fs::copy(&copy, &restoring).and_then(|_| std::fs::File::open(&restoring)?.sync_all());
    if let Err(e) = staged {
        let _ = std::fs::remove_file(&restoring);
        return Err(DbError::Migration(format!(
            "could not copy {} to {} to put back the database made before the upgrade by \
             another version of {product}: {e}. Nothing was changed: the database is still {}",
            copy.display(),
            restoring.display(),
            db_path.display()
        )));
    }
    restrict_to_owner(&restoring, 0o600);

    // 2. 原库挪走，不删。
    let replaced = move_aside(app_data_dir, &db_path)?;
    let replaced_db = replaced.join(database_file_name());

    // 3. 副本放到库的位置上。
    std::fs::rename(&restoring, &db_path).map_err(|e| {
        DbError::Migration(format!(
            "could not move {} to {}: {e}. The newer database is kept in {}; move {} back to \
             {} to undo",
            restoring.display(),
            db_path.display(),
            replaced.display(),
            replaced_db.display(),
            db_path.display()
        ))
    })?;

    // 4. 用掉的副本已经就是现在的库了；放回来的库也不是那次升级拷的。
    if let Err(e) = std::fs::remove_file(&copy) {
        tracing::warn!(
            "[db] could not delete the used copy {}: {e}",
            copy.display()
        );
    }
    let _ = std::fs::remove_file(copies_dir.join(UPGRADE_UNDER_WAY));

    tracing::warn!(
        "[db] this database was upgraded by another version of {product} (migration \
         {unknown}); put back the copy made right before that upgrade ({}). The newer \
         database is kept in {}",
        copy.display(),
        replaced.display()
    );
    eprintln!(
        "[db] WARNING: the database was upgraded by a newer version; put back the copy made \
         before that upgrade. The newer database is kept in {}",
        replaced.display()
    );
    Ok(replaced)
}

/// 把库连同 `-wal`、`-shm` 挪到 `backups/downgrade-replaced/<时间>/`（目录 0700），
/// 先挪 `-wal`、`-shm`，主文件最后挪。不在的就跳过。返回那个目录。
fn move_aside(app_data_dir: &Path, db_path: &Path) -> Result<PathBuf, DbError> {
    let root = app_data_dir.join(REPLACED_DIR);
    let stamp = chrono::Utc::now().format("%Y%m%d-%H%M%S").to_string();
    // 同一秒里挪过一次（接着换完被打断的那次以后马上又换一次）就加个序号。
    let mut dir = root.join(&stamp);
    let mut n = 1;
    while dir.exists() {
        n += 1;
        dir = root.join(format!("{stamp}-{n}"));
    }
    std::fs::create_dir_all(&dir).map_err(|e| {
        DbError::Migration(format!(
            "could not create {} to keep the database a newer version upgraded: {e}. \
             Nothing was changed: the database is still {}",
            dir.display(),
            db_path.display()
        ))
    })?;
    restrict_to_owner(&root, 0o700);
    restrict_to_owner(&dir, 0o700);
    let file_name = database_file_name();
    for suffix in ["-wal", "-shm", ""] {
        let from = sidecar(db_path, suffix);
        if !from.exists() {
            continue;
        }
        let to = dir.join(format!("{file_name}{suffix}"));
        std::fs::rename(&from, &to).map_err(|e| {
            DbError::Migration(format!(
                "could not move {} to {}: {e}. Whatever was moved is in {}; move it back \
                 next to {} to undo",
                from.display(),
                to.display(),
                dir.display(),
                db_path.display()
            ))
        })?;
    }
    Ok(dir)
}

/// 副本是不是新版本升级前那一刻的：迁移集合正好等于当前库的迁移去掉这一版不认的。
/// 只是「这一版都认识」不够：更早的副本也打得开，但换回去会悄悄丢掉之后写的东西。
fn copy_matches_the_upgrade(copy: &[String], current: &[String], known: &[String]) -> bool {
    let copy: BTreeSet<&String> = copy.iter().collect();
    let before_upgrade: BTreeSet<&String> = current.iter().filter(|v| known.contains(v)).collect();
    !copy.is_empty() && copy == before_upgrade
}

/// 用只读连接读一个库文件的迁移；读不出来（不是 SQLite 文件、打不开）是 `None`。
async fn migrations_in(path: &Path) -> Option<Vec<String>> {
    let url = format!(
        "sqlite:{}?mode=ro",
        urlencoding::encode(&path.to_string_lossy())
    );
    let mut opts = ConnectOptions::new(url);
    opts.max_connections(1)
        .min_connections(1)
        .connect_timeout(Duration::from_secs(10))
        .sqlx_logging(false);
    let conn = Database::connect(opts).await.ok()?;
    let applied = applied_migrations(&conn).await.ok();
    let _ = conn.close().await;
    applied
}

#[cfg(test)]
mod tests {
    use super::super::{
        database_file_name, init_database, known_migrations, pre_migrate_dir,
        save_pre_migrate_copy, UPGRADE_UNDER_WAY,
    };
    use super::*;
    use crate::db::migration::Migrator;
    use sea_orm::{
        ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
    };
    use sea_orm_migration::MigratorTrait;

    const FUTURE: &str = "m29990101_000001_future";

    async fn open(path: &Path) -> DatabaseConnection {
        let mut opts = ConnectOptions::new(format!("sqlite:{}?mode=rwc", path.display()));
        opts.max_connections(1)
            .min_connections(1)
            .sqlx_logging(false);
        Database::connect(opts).await.expect("open")
    }

    async fn exec(conn: &DatabaseConnection, sql: &str) {
        conn.execute(Statement::from_string(DbBackend::Sqlite, sql.to_owned()))
            .await
            .unwrap_or_else(|e| panic!("{sql}: {e}"));
    }

    async fn migrations_of(path: &Path) -> Vec<String> {
        let conn = open(path).await;
        let rows = conn
            .query_all(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT version FROM seaql_migrations ORDER BY version",
            ))
            .await
            .expect("migrations");
        conn.close().await.expect("close");
        rows.iter()
            .map(|r| r.try_get::<String>("", "version").expect("version"))
            .collect()
    }

    async fn survivors(path: &Path) -> i64 {
        let conn = open(path).await;
        let row = conn
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                "SELECT COUNT(*) AS n FROM survivor",
            ))
            .await
            .expect("count")
            .expect("row");
        conn.close().await.expect("close");
        row.try_get::<i64>("", "n").expect("n")
    }

    fn db_path(dir: &Path) -> PathBuf {
        dir.join(database_file_name())
    }

    fn files_in(dir: &Path) -> Vec<PathBuf> {
        let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
            .map(|entries| entries.filter_map(|e| e.ok().map(|e| e.path())).collect())
            .unwrap_or_default();
        files.sort();
        files
    }

    fn copies(dir: &Path) -> Vec<PathBuf> {
        files_in(&pre_migrate_dir(dir))
            .into_iter()
            .filter(|p| p.to_string_lossy().ends_with(".db"))
            .collect()
    }

    /// 库停在倒数第二个迁移，加一张 survivor 表写一行。
    async fn database_one_migration_behind(dir: &Path) -> PathBuf {
        let path = db_path(dir);
        let total = Migrator::migrations().len() as u32;
        let conn = open(&path).await;
        Migrator::up(&conn, Some(total - 1))
            .await
            .expect("old schema");
        exec(&conn, "CREATE TABLE survivor (note TEXT)").await;
        exec(&conn, "INSERT INTO survivor VALUES ('before upgrade')").await;
        conn.close().await.expect("close");
        path
    }

    /// 这一版补上最后一个迁移，#363 留下一份 `.done.db`。
    async fn this_build_upgrades(dir: &Path) {
        let db = init_database(dir, "this").await.expect("this build");
        db.conn.close().await.expect("close");
    }

    /// 「新版本」：先留副本（copy 为真时），再写入未知迁移和一行数据。
    async fn newer_build_upgrades(dir: &Path, copy: bool) {
        // 副本的文件名按毫秒排，和这一版留的那份隔开。
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        let conn = open(&db_path(dir)).await;
        if copy {
            save_pre_migrate_copy(&conn, dir, &known_migrations())
                .await
                .expect("newer build's copy");
        }
        exec(
            &conn,
            &format!("INSERT INTO seaql_migrations (version, applied_at) VALUES ('{FUTURE}', 0)"),
        )
        .await;
        exec(
            &conn,
            "INSERT INTO survivor VALUES ('written by newer build')",
        )
        .await;
        conn.close().await.expect("close");
    }

    async fn upgraded_by_newer_build(dir: &Path, copy: bool) -> PathBuf {
        let path = database_one_migration_behind(dir).await;
        this_build_upgrades(dir).await;
        newer_build_upgrades(dir, copy).await;
        path
    }

    fn done_copies(dir: &Path) -> Vec<PathBuf> {
        copies(dir)
            .into_iter()
            .filter(|p| p.to_string_lossy().ends_with(".done.db"))
            .collect()
    }

    /// 完成标准 2 的结果：换回了新版本升级前那份，原来的库在 downgrade-replaced 里。
    async fn assert_restored(dir: &Path, done_before: &[PathBuf]) {
        let path = db_path(dir);
        assert_eq!(migrations_of(&path).await, {
            let mut known = known_migrations();
            known.sort();
            known
        });
        assert_eq!(survivors(&path).await, 1);
        let replaced = files_in(&dir.join(REPLACED_DIR));
        assert_eq!(replaced.len(), 1, "{replaced:?}");
        let moved = replaced[0].join(database_file_name());
        assert!(
            migrations_of(&moved).await.iter().any(|v| v == FUTURE),
            "{moved:?}"
        );
        assert_eq!(survivors(&moved).await, 2);
        // 用掉的副本删了，`.done.db` 那份还在。
        assert_eq!(copies(dir), done_before, "{:?}", copies(dir));
    }

    #[tokio::test]
    async fn an_older_build_restores_the_copy_made_before_the_upgrade() {
        let dir = tempfile::tempdir().unwrap();
        upgraded_by_newer_build(dir.path(), true).await;
        let done = done_copies(dir.path());
        assert_eq!(done.len(), 1, "{:?}", copies(dir.path()));
        assert_eq!(copies(dir.path()).len(), 2);

        let db = init_database(dir.path(), "older").await.expect("restores");
        db.conn.close().await.expect("close");

        assert_restored(dir.path(), &done).await;
    }

    #[test]
    fn only_the_copy_from_right_before_the_upgrade_matches() {
        let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
        let known = s(&["m1", "m2", "m3"]);
        let current = s(&["m1", "m2", "m3", "m9_future"]);
        assert!(copy_matches_the_upgrade(
            &s(&["m1", "m2", "m3"]),
            &current,
            &known
        ));
        assert!(copy_matches_the_upgrade(
            &s(&["m3", "m1", "m2"]),
            &current,
            &known
        ));
        assert!(!copy_matches_the_upgrade(
            &s(&["m1", "m2"]),
            &current,
            &known
        ));
        assert!(!copy_matches_the_upgrade(
            &s(&["m1", "m2", "m3", "m8_other"]),
            &current,
            &known
        ));
        assert!(!copy_matches_the_upgrade(&[], &current, &known));
        assert!(!copy_matches_the_upgrade(&[], &s(&["m9_future"]), &known));
    }

    #[tokio::test]
    async fn a_copy_from_before_an_earlier_upgrade_is_not_restored() {
        let dir = tempfile::tempdir().unwrap();
        let path = upgraded_by_newer_build(dir.path(), false).await;
        let before = std::fs::read(&path).unwrap();
        let old = copies(dir.path());
        assert_eq!(old.len(), 1, "{old:?}");

        let err = match init_database(dir.path(), "older").await {
            Ok(_) => panic!("an earlier upgrade's copy must not be restored"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains(FUTURE), "{err}");
        assert!(
            err.contains(&*pre_migrate_dir(dir.path()).to_string_lossy()),
            "{err}"
        );
        assert!(err.contains("made before an earlier upgrade"), "{err}");
        assert!(err.contains("Run the newer version again"), "{err}");
        assert!(err.contains(crate::cowork::PRODUCT_NAME), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(survivors(&path).await, 2);
        assert!(!dir.path().join(REPLACED_DIR).exists());
        assert_eq!(copies(dir.path()), old);
    }

    #[tokio::test]
    async fn without_a_usable_copy_nothing_is_deleted_and_the_error_says_what_to_do() {
        let dir = tempfile::tempdir().unwrap();
        let path = upgraded_by_newer_build(dir.path(), false).await;
        std::fs::remove_dir_all(pre_migrate_dir(dir.path())).unwrap();
        let before = std::fs::read(&path).unwrap();

        let err = match init_database(dir.path(), "older").await {
            Ok(_) => panic!("must refuse without a copy"),
            Err(e) => e.to_string(),
        };
        assert!(err.contains("Nothing was changed"), "{err}");
        assert!(err.contains("Run the newer version again"), "{err}");
        assert!(!err.contains("made before an earlier upgrade"), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), before);
        assert_eq!(survivors(&path).await, 2);
        assert!(!dir.path().join(REPLACED_DIR).exists());
    }

    #[tokio::test]
    async fn a_copy_this_version_cannot_read_is_skipped() {
        let dir = tempfile::tempdir().unwrap();
        upgraded_by_newer_build(dir.path(), true).await;
        let done = done_copies(dir.path());
        let unreadable =
            pre_migrate_dir(dir.path()).join("99990101-000000000-m_unreadable.done.db");
        std::fs::write(&unreadable, b"not a database").unwrap();

        let db = init_database(dir.path(), "older").await.expect("restores");
        db.conn.close().await.expect("close");

        let mut expected = done.clone();
        expected.push(unreadable);
        assert_restored(dir.path(), &expected).await;
    }

    #[tokio::test]
    async fn a_restore_cut_off_after_moving_the_database_aside_finishes_on_the_next_start() {
        let dir = tempfile::tempdir().unwrap();
        let path = upgraded_by_newer_build(dir.path(), true).await;
        let newest = copies(dir.path()).into_iter().max().unwrap();
        let restoring = PathBuf::from(format!("{}.restoring", path.display()));
        std::fs::copy(&newest, &restoring).unwrap();
        let aside = dir.path().join("moved-aside");
        std::fs::create_dir(&aside).unwrap();
        std::fs::rename(&path, aside.join(database_file_name())).unwrap();

        let db = init_database(dir.path(), "older").await.expect("finishes");
        db.conn.close().await.expect("close");

        assert!(!restoring.exists());
        // 放回去的是副本，不是新建的空库。
        assert_eq!(survivors(&path).await, 1);
        assert!(!migrations_of(&path).await.iter().any(|v| v == FUTURE));
    }

    #[tokio::test]
    async fn a_half_staged_copy_is_dropped_and_the_restore_runs_again() {
        let dir = tempfile::tempdir().unwrap();
        let path = upgraded_by_newer_build(dir.path(), true).await;
        let done = done_copies(dir.path());
        let restoring = PathBuf::from(format!("{}.restoring", path.display()));
        std::fs::write(&restoring, b"SQLite format 3\0half").unwrap();

        let db = init_database(dir.path(), "older").await.expect("restores");
        db.conn.close().await.expect("close");

        assert!(!restoring.exists());
        assert_restored(dir.path(), &done).await;
    }

    #[tokio::test]
    async fn a_restore_forgets_the_upgrade_under_way() {
        let dir = tempfile::tempdir().unwrap();
        let path = upgraded_by_newer_build(dir.path(), true).await;
        let copies_dir = pre_migrate_dir(dir.path());
        let stale = "20000101-000000000-m_stale.db";
        std::fs::write(copies_dir.join(stale), b"stale").unwrap();
        let marker = copies_dir.join(UPGRADE_UNDER_WAY);
        std::fs::write(&marker, format!("{stale}\n{}\n", known_migrations().len())).unwrap();

        restore_copy_before_upgrade(dir.path(), FUTURE)
            .await
            .expect("restores");

        assert!(!marker.exists(), "the upgrade under way is still recorded");
        assert_eq!(survivors(&path).await, 1);
        assert!(!migrations_of(&path).await.iter().any(|v| v == FUTURE));
    }

    #[tokio::test]
    async fn unreadable_migrations_are_refused_and_nothing_is_changed() {
        let dir = tempfile::tempdir().unwrap();
        upgraded_by_newer_build(dir.path(), true).await;
        let path = db_path(dir.path());
        std::fs::write(&path, b"not a database any more").unwrap();
        let before = copies(dir.path());

        let err = restore_copy_before_upgrade(dir.path(), FUTURE)
            .await
            .expect_err("refused")
            .to_string();
        assert!(err.contains("could not be read"), "{err}");
        assert!(err.contains("Nothing was changed"), "{err}");
        assert!(err.contains("Run the newer version again"), "{err}");
        assert!(err.contains(FUTURE), "{err}");
        assert_eq!(std::fs::read(&path).unwrap(), b"not a database any more");
        assert!(!dir.path().join(REPLACED_DIR).exists());
        assert_eq!(copies(dir.path()), before);
    }
}
