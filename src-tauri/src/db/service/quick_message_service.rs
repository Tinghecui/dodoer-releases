use chrono::Utc;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ConnectionTrait, DbBackend, EntityTrait,
    IntoActiveModel, QueryOrder, Set, Statement,
};

use crate::db::entities::quick_message;
use crate::db::error::DbError;
use crate::models::QuickMessageInfo;

fn to_info(m: quick_message::Model) -> QuickMessageInfo {
    QuickMessageInfo {
        id: m.id,
        title: m.title,
        content: m.content,
        sort_order: m.sort_order,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

/// 全是空格的标题、内容不让写进去：界面上看不见文字，直接调接口也一样拦（#1157）
fn require_text(field: &str, value: &str) -> Result<(), DbError> {
    if value.trim().is_empty() {
        return Err(DbError::Validation(format!("{field} is required")));
    }
    Ok(())
}

pub async fn list(conn: &DatabaseConnection) -> Result<Vec<QuickMessageInfo>, DbError> {
    let rows = quick_message::Entity::find()
        .order_by_asc(quick_message::Column::SortOrder)
        .all(conn)
        .await?;

    Ok(rows.into_iter().map(to_info).collect())
}

pub async fn create(
    conn: &DatabaseConnection,
    title: &str,
    content: &str,
) -> Result<QuickMessageInfo, DbError> {
    require_text("title", title)?;
    require_text("content", content)?;
    let now = Utc::now();

    let max_order = quick_message::Entity::find()
        .order_by_desc(quick_message::Column::SortOrder)
        .one(conn)
        .await?
        .map(|m| m.sort_order)
        .unwrap_or(-1);

    let active = quick_message::ActiveModel {
        id: NotSet,
        title: Set(title.to_string()),
        content: Set(content.to_string()),
        sort_order: Set(max_order + 1),
        created_at: Set(now),
        updated_at: Set(now),
    };

    let model = active.insert(conn).await?;
    Ok(to_info(model))
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    title: Option<String>,
    content: Option<String>,
) -> Result<QuickMessageInfo, DbError> {
    if let Some(t) = &title {
        require_text("title", t)?;
    }
    if let Some(c) = &content {
        require_text("content", c)?;
    }
    let row = quick_message::Entity::find_by_id(id)
        .one(conn)
        .await?
        .ok_or_else(|| DbError::NotFound(format!("QuickMessage {} not found", id)))?;

    let mut active = row.into_active_model();
    if let Some(t) = title {
        active.title = Set(t);
    }
    if let Some(c) = content {
        active.content = Set(c);
    }
    active.updated_at = Set(Utc::now());

    let model = active.update(conn).await?;
    Ok(to_info(model))
}

pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    quick_message::Entity::delete_by_id(id).exec(conn).await?;
    Ok(())
}

pub async fn reorder(conn: &DatabaseConnection, ids: Vec<i32>) -> Result<(), DbError> {
    if ids.is_empty() {
        return Ok(());
    }

    let now = Utc::now();
    let now_str = now.format("%Y-%m-%d %H:%M:%S %:z").to_string();
    let case_expr = ids
        .iter()
        .enumerate()
        .map(|(idx, id)| format!("WHEN {} THEN {}", id, idx))
        .collect::<Vec<_>>()
        .join(" ");
    let id_list = ids
        .iter()
        .map(|id| id.to_string())
        .collect::<Vec<_>>()
        .join(", ");

    let sql = format!(
        "UPDATE quick_message SET sort_order = CASE id {case_expr} END, updated_at = '{now_str}' WHERE id IN ({id_list})"
    );
    conn.execute(Statement::from_string(DbBackend::Sqlite, sql))
        .await?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;

    // 全是空格的标题、内容不能写进去，库里保持原样（#1157）
    #[tokio::test]
    async fn rejects_blank_title_or_content() {
        let db = fresh_in_memory_db().await;

        for (title, content) in [("   ", "内容"), ("标题", " \n\t "), ("", "")] {
            assert!(matches!(
                create(&db.conn, title, content).await,
                Err(DbError::Validation(_))
            ));
        }
        assert!(list(&db.conn).await.unwrap().is_empty());

        let saved = create(&db.conn, "问候", "你好").await.unwrap();
        for (title, content) in [
            (Some("  ".to_string()), None),
            (None, Some("\n ".to_string())),
            (Some("新标题".to_string()), Some(" ".to_string())),
        ] {
            assert!(matches!(
                update(&db.conn, saved.id, title, content).await,
                Err(DbError::Validation(_))
            ));
        }
        let listed = list(&db.conn).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "问候");
        assert_eq!(listed[0].content, "你好");

        // 不带标题、内容的更新照旧能过
        let renamed = update(&db.conn, saved.id, Some("新的".into()), None)
            .await
            .unwrap();
        assert_eq!(renamed.title, "新的");
        assert_eq!(renamed.content, "你好");
    }
}
