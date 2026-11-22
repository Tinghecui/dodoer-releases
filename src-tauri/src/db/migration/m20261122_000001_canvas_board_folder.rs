use std::collections::HashMap;

use sea_orm::{ConnectionTrait, Statement};
use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 画布归哪个项目（`folder.id`，总是项目的根文件夹，worktree 归到它的仓库）。
        // 可空：NULL = 不属于哪个项目，在每个项目的画布列表里都显示。软引用、不加外键，
        // 和 canvas_node 上的绑定列一样：项目删了画布不跟着删。
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasBoard::Table)
                    .add_column(ColumnDef::new(CanvasBoard::FolderId).integer().null())
                    .to_owned(),
            )
            .await?;

        backfill_folder_ids(manager.get_connection()).await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_canvas_board_folder_id")
                    .table(CanvasBoard::Table)
                    .col(CanvasBoard::FolderId)
                    .to_owned(),
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_index(
                Index::drop()
                    .if_exists()
                    .name("idx_canvas_board_folder_id")
                    .table(CanvasBoard::Table)
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(CanvasBoard::Table)
                    .drop_column(CanvasBoard::FolderId)
                    .to_owned(),
            )
            .await
    }
}

/// 一个还在的普通文件夹：所属项目（根文件夹）的 id 和它的路径。
struct LiveFolder {
    project: i32,
    path: String,
}

/// 升级前建的画布按上面卡片最多的那个项目归过去。每张卡片最多投一票：
/// 项目区域投它绑的项目，会话卡投会话所在的项目，文件卡和终端卡投路径落在哪个
/// 项目目录里（取最长的那个）。其余卡片（便签、自选区域、分组、智能体区域）不投票。
/// 没有票、或者票数最多的项目不止一个，留 NULL：在所有项目里都显示。
async fn backfill_folder_ids<C: ConnectionTrait>(db: &C) -> Result<(), DbErr> {
    let backend = db.get_database_backend();
    let sql = |s: &str| Statement::from_string(backend, s.to_owned());

    let mut folders: HashMap<i32, LiveFolder> = HashMap::new();
    for row in db
        .query_all(sql("SELECT id, parent_id, path FROM folder \
             WHERE deleted_at IS NULL AND kind = 'regular'"))
        .await?
    {
        let id: i32 = row.try_get("", "id")?;
        let parent: Option<i32> = row.try_get("", "parent_id")?;
        let path: String = row.try_get("", "path")?;
        folders.insert(
            id,
            LiveFolder {
                project: parent.unwrap_or(id),
                path,
            },
        );
    }
    // worktree 的根文件夹本身也得还在，否则这一票不算。
    let project_of = |folder_id: i32| -> Option<i32> {
        let project = folders.get(&folder_id)?.project;
        folders.contains_key(&project).then_some(project)
    };

    let mut conversation_folder: HashMap<i32, i32> = HashMap::new();
    for row in db
        .query_all(sql(
            "SELECT id, folder_id FROM conversation WHERE deleted_at IS NULL",
        ))
        .await?
    {
        let id: i32 = row.try_get("", "id")?;
        let folder_id: i32 = row.try_get("", "folder_id")?;
        conversation_folder.insert(id, folder_id);
    }

    let mut votes: HashMap<i32, HashMap<i32, u32>> = HashMap::new();
    for row in db
        .query_all(sql(
            "SELECT board_id, kind, folder_id, conversation_id, path FROM canvas_node",
        ))
        .await?
    {
        let board_id: i32 = row.try_get("", "board_id")?;
        let kind: String = row.try_get("", "kind")?;
        let folder_id: Option<i32> = row.try_get("", "folder_id")?;
        let conversation_id: Option<i32> = row.try_get("", "conversation_id")?;
        let path: Option<String> = row.try_get("", "path")?;
        let project = match kind.as_str() {
            "folder" => folder_id.and_then(project_of),
            "conversation" => conversation_id
                .and_then(|c| conversation_folder.get(&c).copied())
                .and_then(project_of),
            "file" | "terminal" => path
                .as_deref()
                .and_then(|p| folder_containing(&folders, p))
                .and_then(project_of),
            _ => None,
        };
        if let Some(project) = project {
            *votes
                .entry(board_id)
                .or_default()
                .entry(project)
                .or_default() += 1;
        }
    }

    for (board_id, tally) in votes {
        let Some(&best) = tally.values().max() else {
            continue;
        };
        let mut leaders = tally.iter().filter(|(_, n)| **n == best);
        let (Some((&project, _)), None) = (leaders.next(), leaders.next()) else {
            continue;
        };
        db.execute(Statement::from_sql_and_values(
            backend,
            "UPDATE canvas_board SET folder_id = ? WHERE id = ?",
            [project.into(), board_id.into()],
        ))
        .await?;
    }
    Ok(())
}

/// 路径落在哪个文件夹里：等于它的路径，或者在它下面；有几个就取路径最长的那个
/// （worktree 常放在仓库目录里面，这样归到 worktree，再由它归到项目）。
fn folder_containing(folders: &HashMap<i32, LiveFolder>, path: &str) -> Option<i32> {
    folders
        .iter()
        .filter(|(_, f)| path_is_within(path, &f.path))
        .max_by_key(|(_, f)| f.path.len())
        .map(|(&id, _)| id)
}

fn path_is_within(path: &str, dir: &str) -> bool {
    let dir = dir.trim_end_matches(['/', '\\']);
    if dir.is_empty() {
        return false;
    }
    match path.strip_prefix(dir) {
        Some(rest) => rest.is_empty() || rest.starts_with(['/', '\\']),
        None => false,
    }
}

#[derive(DeriveIden)]
enum CanvasBoard {
    Table,
    FolderId,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Statement};
    use sea_orm_migration::MigratorTrait;

    use super::path_is_within;
    use crate::db::entities::canvas_board;
    use crate::db::migration::Migrator;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    async fn exec(conn: &sea_orm::DatabaseConnection, s: &str) {
        conn.execute(sql(s)).await.expect(s);
    }

    async fn legacy_db() -> sea_orm::DatabaseConnection {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("canvas_board_folder"))
            .expect("migration is registered");
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("legacy migrations");
        conn
    }

    async fn folder(conn: &sea_orm::DatabaseConnection, id: i32, path: &str, parent: &str) {
        exec(
            conn,
            &format!(
                "INSERT INTO folder (id, name, path, parent_id, last_opened_at, created_at, \
                 updated_at) VALUES ({id}, 'f{id}', '{path}', {parent}, '2026-11-01 00:00:00', \
                 '2026-11-01 00:00:00', '2026-11-01 00:00:00')"
            ),
        )
        .await;
    }

    async fn board(conn: &sea_orm::DatabaseConnection, id: i32) {
        exec(
            conn,
            &format!(
                "INSERT INTO canvas_board (id, created_at, updated_at) VALUES \
                 ({id}, '2026-11-01 00:00:00', '2026-11-01 00:00:00')"
            ),
        )
        .await;
    }

    async fn node(
        conn: &sea_orm::DatabaseConnection,
        id: i32,
        board: i32,
        kind: &str,
        folder_id: &str,
        conversation_id: &str,
        path: &str,
    ) {
        exec(
            conn,
            &format!(
                "INSERT INTO canvas_node (id, board_id, kind, folder_id, conversation_id, path, \
                 collapsed, grid_columns, grid_rows, x, y, width, height, created_at, \
                 updated_at) VALUES ({id}, {board}, '{kind}', {folder_id}, {conversation_id}, \
                 {path}, 0, 0, 0, 0.0, 0.0, 100.0, 100.0, '2026-11-01 00:00:00', \
                 '2026-11-01 00:00:00')"
            ),
        )
        .await;
    }

    /// 老画布归到卡片最多的那个项目；判断不出（没有能归属的卡片、两个项目票数一样）
    /// 的留 NULL。worktree 里的卡片算它所在仓库的票。
    #[tokio::test]
    async fn legacy_boards_go_to_the_project_most_of_their_cards_belong_to() {
        let conn = legacy_db().await;
        folder(&conn, 1, "/work/demo", "NULL").await;
        folder(&conn, 2, "/work/docs", "NULL").await;
        folder(&conn, 3, "/work/demo/.worktrees/feat", "1").await;
        exec(
            &conn,
            "INSERT INTO conversation (id, folder_id, title_locked, agent_type, status, kind, \
             message_count, created_at, updated_at) VALUES \
             (7, 2, 0, 'codex', 'completed', 'regular', 1, \
              '2026-11-01 00:00:00', '2026-11-01 00:00:00')",
        )
        .await;

        // 画布 10：demo 有两票（README 文件卡、worktree 里的终端），docs 一票（会话卡）。
        board(&conn, 10).await;
        node(
            &conn,
            1,
            10,
            "file",
            "NULL",
            "NULL",
            "'/work/demo/README.md'",
        )
        .await;
        node(
            &conn,
            2,
            10,
            "terminal",
            "NULL",
            "NULL",
            "'/work/demo/.worktrees/feat'",
        )
        .await;
        node(&conn, 3, 10, "conversation", "NULL", "7", "NULL").await;
        node(&conn, 4, 10, "note", "NULL", "NULL", "NULL").await;
        // 画布 11：只有便签，判断不出。
        board(&conn, 11).await;
        node(&conn, 5, 11, "note", "NULL", "NULL", "NULL").await;
        // 画布 12：demo、docs 各一票，平票。
        board(&conn, 12).await;
        node(&conn, 6, 12, "folder", "1", "NULL", "NULL").await;
        node(&conn, 7, 12, "folder", "2", "NULL", "NULL").await;
        // 画布 13：空的。
        board(&conn, 13).await;
        // 画布 14：路径只是前缀相同（/work/demo-old 不在 /work/demo 里）。
        board(&conn, 14).await;
        node(
            &conn,
            8,
            14,
            "file",
            "NULL",
            "NULL",
            "'/work/demo-old/a.md'",
        )
        .await;

        Migrator::up(&conn, None).await.expect("folder migration");

        let mut boards = canvas_board::Entity::find()
            .all(&conn)
            .await
            .expect("boards decode");
        boards.sort_by_key(|b| b.id);
        let got: Vec<(i32, Option<i32>)> = boards.iter().map(|b| (b.id, b.folder_id)).collect();
        assert_eq!(
            got,
            vec![
                (10, Some(1)),
                (11, None),
                (12, None),
                (13, None),
                (14, None)
            ]
        );
    }

    #[test]
    fn a_path_is_within_its_folder_only_on_a_separator() {
        assert!(path_is_within("/a/b", "/a/b"));
        assert!(path_is_within("/a/b/c.md", "/a/b/"));
        assert!(path_is_within("C:\\a\\b\\c.md", "C:\\a\\b"));
        assert!(!path_is_within("/a/bc/d.md", "/a/b"));
        assert!(!path_is_within("/a", "/a/b"));
    }
}
