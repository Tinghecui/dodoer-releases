use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 回合没跑完程序就停了（退出、崩溃、被杀）时写上的时间：被打断 = `status = cancelled`
        // 且这一列有值。不加新的状态值，认 `cancelled` 的老代码读到的还是 `cancelled`。
        // 之后任何一次状态写入都清回 NULL。老行和新行默认都是 NULL，不回填。
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .add_column(
                        ColumnDef::new(Conversation::InterruptedAt)
                            .timestamp_with_time_zone()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversation::Table)
                    .drop_column(Conversation::InterruptedAt)
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum Conversation {
    Table,
    InterruptedAt,
}

#[cfg(test)]
mod tests {
    use sea_orm::{ConnectionTrait, Database, DbBackend, EntityTrait, Statement};
    use sea_orm_migration::MigratorTrait;

    use crate::db::entities::conversation;
    use crate::db::migration::Migrator;

    fn sql(s: &str) -> Statement {
        Statement::from_string(DbBackend::Sqlite, s.to_owned())
    }

    /// 迁移之前就有的行读出来不是被打断的，状态也不动。
    #[tokio::test]
    async fn existing_rows_read_back_not_interrupted() {
        let conn = Database::connect("sqlite::memory:").await.expect("db");
        let migrations = <Migrator as MigratorTrait>::migrations();
        let idx = migrations
            .iter()
            .position(|m| m.name().contains("conversation_interrupted_at"))
            .expect("migration is registered");
        Migrator::up(&conn, Some(idx as u32))
            .await
            .expect("legacy migrations");
        conn.execute(sql(
            "INSERT INTO folder (id, name, path, last_opened_at, created_at, updated_at) VALUES \
             (1, 'repo', '/tmp/repo', '2026-11-01 00:00:00', '2026-11-01 00:00:00', \
              '2026-11-01 00:00:00')",
        ))
        .await
        .expect("legacy folder");
        conn.execute(sql(
            "INSERT INTO conversation (id, folder_id, title_locked, agent_type, status, kind, \
             message_count, created_at, updated_at) VALUES \
             (7, 1, 0, 'codex', 'in_progress', 'regular', 1, \
              '2026-11-01 00:00:00', '2026-11-01 00:00:00')",
        ))
        .await
        .expect("legacy row");

        Migrator::up(&conn, None)
            .await
            .expect("the interrupted_at migration");

        let row = conversation::Entity::find_by_id(7)
            .one(&conn)
            .await
            .expect("row decodes")
            .expect("row exists");
        assert_eq!(row.interrupted_at, None);
        assert_eq!(row.status, conversation::ConversationStatus::InProgress);
    }
}
