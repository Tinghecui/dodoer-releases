use chrono::Utc;
use std::collections::{HashMap, HashSet};

use sea_orm::sea_query::Expr;
use sea_orm::DatabaseConnection;
use sea_orm::{
    ActiveModelTrait, ActiveValue::NotSet, ColumnTrait, EntityTrait, IntoActiveModel, QueryFilter,
    QueryOrder, Set, TransactionTrait,
};

use crate::app_error::AppCommandError;
use crate::db::entities::remote_workspace_connection;
use crate::db::error::DbError;
use crate::models::{RemoteWorkspaceConnectionInfo, RemoteWorkspaceHeader};

/// Names the client sets itself, on the HTTP calls and on the WebSocket
/// handshake. The save fails rather than silently drop what the user typed.
/// A slice, not a fixed-size array: the length is one more thing to forget to
/// bump when a name is added.
const RESERVED_HEADER_NAMES: &[&str] = &[
    "authorization",
    "content-type",
    "content-length",
    // `hyper` frames the body itself and picks chunked for the streaming
    // workspace upload. A user-supplied framing header contradicts it, and it
    // is also the header a request-smuggling attempt rides in on — which is
    // the one thing not to hand to a fronting proxy.
    "transfer-encoding",
    "host",
    "connection",
    "upgrade",
    "sec-websocket-key",
    "sec-websocket-version",
    "sec-websocket-protocol",
    "sec-websocket-extensions",
];

// ── Where the token lives ──
//
// On the desktop the `token` column holds `keychain:<key>`, a pointer to an
// OS keychain entry, instead of the token itself. Everything outside this file
// still sees the plain token in `RemoteWorkspaceConnectionInfo`: the pointer is
// resolved on read, so callers, the IPC API and the settings form are
// unchanged. Where there is no keychain (codeg-server, tests, a Linux desktop
// without a secret service, a denied prompt) the token stays in the column as
// before; a row is only switched to a pointer once its keychain write
// succeeded, so a missing keychain never loses a connection.

/// Marks a `token` column value as a keychain pointer rather than a token.
const KEYCHAIN_REF_PREFIX: &str = "keychain:";

/// Secret storage for connection tokens, keyed by an opaque random key.
pub(crate) trait TokenVault: Send + Sync {
    fn set(&self, key: &str, token: &str) -> Result<(), String>;
    /// `Ok(None)` is "no such entry"; `Err` is "could not ask" (locked,
    /// denied). Neither is ever written back, so the difference only shows
    /// in the log.
    fn get(&self, key: &str) -> Result<Option<String>, String>;
    fn delete(&self, key: &str) -> Result<(), String>;
}

fn keychain_key(stored: &str) -> Option<&str> {
    stored.strip_prefix(KEYCHAIN_REF_PREFIX)
}

/// The OS keychain, desktop builds only. Tests and codeg-server have none and
/// keep tokens in the database as before.
#[cfg(all(feature = "tauri-runtime", not(test)))]
mod keychain {
    use std::collections::HashMap;
    use std::sync::{LazyLock, Mutex};

    use super::TokenVault;

    /// The remote proxy reads the connection on every request; one keychain
    /// read per token per process is enough. `set` only invalidates, so the
    /// next read (the migration's read-back included) really asks the keychain.
    pub(super) struct Keychain {
        cache: Mutex<HashMap<String, String>>,
    }

    pub(super) static KEYCHAIN: LazyLock<Keychain> = LazyLock::new(|| Keychain {
        cache: Mutex::new(HashMap::new()),
    });

    fn secret_name(key: &str) -> String {
        format!("remote-workspace:{key}")
    }

    impl TokenVault for Keychain {
        fn set(&self, key: &str, token: &str) -> Result<(), String> {
            self.cache.lock().unwrap().remove(key);
            crate::keyring_store::set_secret(&secret_name(key), token)
        }

        fn get(&self, key: &str) -> Result<Option<String>, String> {
            if let Some(token) = self.cache.lock().unwrap().get(key) {
                return Ok(Some(token.clone()));
            }
            let token = crate::keyring_store::get_secret(&secret_name(key))?;
            if let Some(token) = &token {
                self.cache
                    .lock()
                    .unwrap()
                    .insert(key.to_string(), token.clone());
            }
            Ok(token)
        }

        fn delete(&self, key: &str) -> Result<(), String> {
            self.cache.lock().unwrap().remove(key);
            crate::keyring_store::delete_secret(&secret_name(key))
        }
    }
}

#[cfg(all(feature = "tauri-runtime", not(test)))]
fn vault() -> Option<&'static dyn TokenVault> {
    Some(&*keychain::KEYCHAIN)
}

#[cfg(not(all(feature = "tauri-runtime", not(test))))]
fn vault() -> Option<&'static dyn TokenVault> {
    None
}

/// Move plaintext tokens left by older versions into the keychain, once per
/// process, on the first read. Lazy rather than at startup so it needs no hook
/// in app setup; the first read is the workspace restore or the settings list.
async fn ensure_migrated(conn: &DatabaseConnection, vault: Option<&dyn TokenVault>) {
    #[cfg(all(feature = "tauri-runtime", not(test)))]
    {
        static MIGRATED: tokio::sync::OnceCell<()> = tokio::sync::OnceCell::const_new();
        if let Some(vault) = vault {
            MIGRATED
                .get_or_init(|| async {
                    migrate_tokens(conn, vault).await;
                })
                .await;
        }
    }
    #[cfg(not(all(feature = "tauri-runtime", not(test))))]
    let _ = (conn, vault);
}

/// Move every plaintext token into `vault`, returning how many moved. Each row
/// switches to a pointer only after the keychain read the token back
/// unchanged, and only if the row was not edited meanwhile. The first keychain
/// failure stops the run: the keychain is unavailable, and the remaining rows
/// keep working from the database.
#[cfg_attr(not(all(feature = "tauri-runtime", not(test))), allow(dead_code))]
pub(crate) async fn migrate_tokens(conn: &DatabaseConnection, vault: &dyn TokenVault) -> usize {
    let rows = match remote_workspace_connection::Entity::find().all(conn).await {
        Ok(rows) => rows,
        Err(err) => {
            tracing::warn!("[remote-workspace] token migration: could not read connections: {err}");
            return 0;
        }
    };
    let mut moved = 0;
    for row in rows {
        if row.token.is_empty() || keychain_key(&row.token).is_some() {
            continue;
        }
        let key = uuid::Uuid::new_v4().to_string();
        if let Err(err) = vault.set(&key, &row.token) {
            tracing::warn!(
                "[remote-workspace] keychain unavailable, tokens stay in the database: {err}"
            );
            return moved;
        }
        match vault.get(&key) {
            Ok(Some(read)) if read == row.token => {}
            other => {
                tracing::warn!(
                    "[remote-workspace] keychain did not read back the token (connection {}): {:?}",
                    row.id,
                    other.map(|t| t.map(|_| "<different token>"))
                );
                let _ = vault.delete(&key);
                return moved;
            }
        }
        let updated = remote_workspace_connection::Entity::update_many()
            .col_expr(
                remote_workspace_connection::Column::Token,
                Expr::value(format!("{KEYCHAIN_REF_PREFIX}{key}")),
            )
            .filter(remote_workspace_connection::Column::Id.eq(row.id))
            .filter(remote_workspace_connection::Column::Token.eq(row.token.clone()))
            .exec(conn)
            .await;
        match updated {
            Ok(result) if result.rows_affected == 1 => moved += 1,
            // Edited or deleted since the read: that write already decided
            // where its token lives.
            Ok(_) => {
                let _ = vault.delete(&key);
            }
            Err(err) => {
                tracing::warn!(
                    "[remote-workspace] token migration: could not update connection {}: {err}",
                    row.id
                );
                let _ = vault.delete(&key);
                return moved;
            }
        }
    }
    if moved > 0 {
        tracing::info!("[remote-workspace] moved {moved} connection token(s) into the keychain");
    }
    moved
}

/// The column value to store for `token`: a keychain pointer when the vault
/// takes it, the token itself otherwise. `previous` is the current column
/// value; an existing pointer keeps its key, so an update overwrites the same
/// keychain entry instead of leaving the old one behind.
fn store_token(vault: Option<&dyn TokenVault>, previous: &str, token: &str) -> String {
    let Some(vault) = vault else {
        return token.to_string();
    };
    let existing = keychain_key(previous);
    let key = existing
        .map(str::to_string)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    match vault.set(&key, token) {
        Ok(()) => format!("{KEYCHAIN_REF_PREFIX}{key}"),
        Err(err) => {
            tracing::warn!(
                "[remote-workspace] keychain unavailable, storing the token in the database: {err}"
            );
            if existing.is_some() {
                // The row stops pointing at it; do not leave the old token there.
                let _ = vault.delete(&key);
            }
            token.to_string()
        }
    }
}

/// Drop the keychain entry a column value points at, if any. Best effort: a
/// leftover entry is unreachable (keys are random and never reused).
fn forget_token(vault: Option<&dyn TokenVault>, stored: &str) {
    if let (Some(vault), Some(key)) = (vault, keychain_key(stored)) {
        if let Err(err) = vault.delete(key) {
            tracing::warn!("[remote-workspace] could not delete keychain entry: {err}");
        }
    }
}

fn resolve_token(vault: Option<&dyn TokenVault>, id: i32, stored: String) -> String {
    let Some(key) = keychain_key(&stored) else {
        return stored;
    };
    let found = match vault {
        Some(vault) => vault.get(key),
        None => Err("no keychain in this build".to_string()),
    };
    match found {
        Ok(Some(token)) => token,
        // An empty token fails the connection with an auth error; editing it
        // or clicking the portal link again stores a new one.
        Ok(None) => {
            tracing::warn!("[remote-workspace] connection {id}: keychain entry is missing");
            String::new()
        }
        Err(err) => {
            tracing::warn!(
                "[remote-workspace] connection {id}: could not read the keychain: {err}"
            );
            String::new()
        }
    }
}

fn to_info(
    model: remote_workspace_connection::Model,
    vault: Option<&dyn TokenVault>,
) -> RemoteWorkspaceConnectionInfo {
    RemoteWorkspaceConnectionInfo {
        id: model.id,
        name: model.name,
        base_url: model.base_url,
        token: resolve_token(vault, model.id, model.token),
        headers: serde_json::from_str(&model.headers).unwrap_or_default(),
        sort_order: model.sort_order,
        created_at: model.created_at,
        updated_at: model.updated_at,
    }
}

pub fn validate_headers(
    headers: &[RemoteWorkspaceHeader],
) -> Result<Vec<RemoteWorkspaceHeader>, AppCommandError> {
    let mut result = Vec::with_capacity(headers.len());
    for header in headers {
        let name = header.name.trim();
        let value = header.value.trim();
        if name.is_empty() && value.is_empty() {
            continue;
        }
        if name.is_empty() {
            return Err(AppCommandError::invalid_input(
                "Custom header name is required",
            ));
        }
        if RESERVED_HEADER_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
            return Err(AppCommandError::invalid_input(format!(
                "Custom header \"{name}\" is reserved by dodoer"
            )));
        }
        header.to_header_pair().map_err(|e| {
            AppCommandError::invalid_input(format!("Custom header \"{name}\" is invalid"))
                .with_detail(e.to_string())
        })?;
        result.push(RemoteWorkspaceHeader {
            name: name.to_string(),
            value: value.to_string(),
        });
    }
    Ok(result)
}

fn serialize_headers(headers: &[RemoteWorkspaceHeader]) -> Result<String, AppCommandError> {
    serde_json::to_string(headers).map_err(|e| {
        AppCommandError::invalid_input("Failed to store custom headers").with_detail(e.to_string())
    })
}

pub fn normalize_base_url(raw: &str) -> Result<String, AppCommandError> {
    let trimmed = raw.trim().trim_end_matches('/').to_string();
    let parsed = reqwest::Url::parse(&trimmed).map_err(|e| {
        AppCommandError::invalid_input("Remote Workspace URL is invalid").with_detail(e.to_string())
    })?;
    match parsed.scheme() {
        "http" | "https" => Ok(trimmed),
        _ => Err(AppCommandError::invalid_input(
            "Remote Workspace URL must use http or https",
        )),
    }
}

fn validate_name(name: &str) -> Result<String, AppCommandError> {
    let trimmed = name.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Remote connection name is required",
        ));
    }
    Ok(trimmed.to_string())
}

fn validate_token(token: &str) -> Result<String, AppCommandError> {
    let trimmed = token.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input(
            "Remote connection token is required",
        ));
    }
    // Would be read back as a keychain pointer.
    if trimmed.starts_with(KEYCHAIN_REF_PREFIX) {
        return Err(AppCommandError::invalid_input(
            "Remote connection token is invalid",
        ));
    }
    Ok(trimmed.to_string())
}

pub async fn list(
    conn: &DatabaseConnection,
) -> Result<Vec<RemoteWorkspaceConnectionInfo>, DbError> {
    list_with(conn, vault()).await
}

pub(crate) async fn list_with(
    conn: &DatabaseConnection,
    vault: Option<&dyn TokenVault>,
) -> Result<Vec<RemoteWorkspaceConnectionInfo>, DbError> {
    ensure_migrated(conn, vault).await;
    let rows = remote_workspace_connection::Entity::find()
        .order_by_asc(remote_workspace_connection::Column::SortOrder)
        .order_by_asc(remote_workspace_connection::Column::Name)
        .all(conn)
        .await?;
    Ok(rows.into_iter().map(|row| to_info(row, vault)).collect())
}

pub async fn get(
    conn: &DatabaseConnection,
    id: i32,
) -> Result<Option<RemoteWorkspaceConnectionInfo>, DbError> {
    get_with(conn, id, vault()).await
}

pub(crate) async fn get_with(
    conn: &DatabaseConnection,
    id: i32,
    vault: Option<&dyn TokenVault>,
) -> Result<Option<RemoteWorkspaceConnectionInfo>, DbError> {
    ensure_migrated(conn, vault).await;
    let row = remote_workspace_connection::Entity::find_by_id(id)
        .one(conn)
        .await?;
    Ok(row.map(|row| to_info(row, vault)))
}

pub async fn create(
    conn: &DatabaseConnection,
    name: &str,
    base_url: &str,
    token: &str,
    headers: &[RemoteWorkspaceHeader],
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    create_with(conn, name, base_url, token, headers, vault()).await
}

pub(crate) async fn create_with(
    conn: &DatabaseConnection,
    name: &str,
    base_url: &str,
    token: &str,
    headers: &[RemoteWorkspaceHeader],
    vault: Option<&dyn TokenVault>,
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    let now = Utc::now();
    let headers = serialize_headers(&validate_headers(headers)?)?;
    let max_order = remote_workspace_connection::Entity::find()
        .order_by_desc(remote_workspace_connection::Column::SortOrder)
        .one(conn)
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::db)?
        .map(|m| m.sort_order)
        .unwrap_or(-1);
    let name = validate_name(name)?;
    let base_url = normalize_base_url(base_url)?;
    let token = validate_token(token)?;
    let stored = store_token(vault, "", &token);
    let active = remote_workspace_connection::ActiveModel {
        id: NotSet,
        name: Set(name),
        base_url: Set(base_url),
        token: Set(stored.clone()),
        headers: Set(headers),
        sort_order: Set(max_order + 1),
        created_at: Set(now),
        updated_at: Set(now),
    };
    let model = match active.insert(conn).await {
        Ok(model) => model,
        Err(err) => {
            forget_token(vault, &stored);
            return Err(AppCommandError::db(DbError::from(err)));
        }
    };
    Ok(to_info(model, vault))
}

pub async fn update(
    conn: &DatabaseConnection,
    id: i32,
    name: &str,
    base_url: &str,
    token: &str,
    headers: &[RemoteWorkspaceHeader],
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    update_with(conn, id, name, base_url, token, headers, vault()).await
}

pub(crate) async fn update_with(
    conn: &DatabaseConnection,
    id: i32,
    name: &str,
    base_url: &str,
    token: &str,
    headers: &[RemoteWorkspaceHeader],
    vault: Option<&dyn TokenVault>,
) -> Result<RemoteWorkspaceConnectionInfo, AppCommandError> {
    let headers = serialize_headers(&validate_headers(headers)?)?;
    let row = remote_workspace_connection::Entity::find_by_id(id)
        .one(conn)
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::db)?
        .ok_or_else(|| AppCommandError::not_found(format!("Remote connection {id} not found")))?;

    let name = validate_name(name)?;
    let base_url = normalize_base_url(base_url)?;
    let token = validate_token(token)?;
    let stored = store_token(vault, &row.token, &token);
    let mut active = row.into_active_model();
    active.name = Set(name);
    active.base_url = Set(base_url);
    active.token = Set(stored);
    active.headers = Set(headers);
    active.updated_at = Set(Utc::now());
    let model = active
        .update(conn)
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::db)?;
    Ok(to_info(model, vault))
}

pub async fn delete(conn: &DatabaseConnection, id: i32) -> Result<(), DbError> {
    delete_with(conn, id, vault()).await
}

pub(crate) async fn delete_with(
    conn: &DatabaseConnection,
    id: i32,
    vault: Option<&dyn TokenVault>,
) -> Result<(), DbError> {
    let row = remote_workspace_connection::Entity::find_by_id(id)
        .one(conn)
        .await?;
    remote_workspace_connection::Entity::delete_by_id(id)
        .exec(conn)
        .await?;
    if let Some(row) = row {
        forget_token(vault, &row.token);
    }
    Ok(())
}

pub async fn reorder(conn: &DatabaseConnection, ids: Vec<i32>) -> Result<(), AppCommandError> {
    if ids.is_empty() {
        return Ok(());
    }

    let unique_ids = ids.iter().copied().collect::<HashSet<_>>();
    if unique_ids.len() != ids.len() {
        return Err(AppCommandError::invalid_input(
            "Remote workspace order contains duplicate connections",
        ));
    }

    let rows = remote_workspace_connection::Entity::find()
        .all(conn)
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::db)?;
    let existing_ids = rows.iter().map(|row| row.id).collect::<HashSet<_>>();
    if existing_ids != unique_ids {
        return Err(AppCommandError::invalid_input(
            "Remote workspace order must include every connection exactly once",
        ));
    }

    let now = Utc::now();
    let mut rows_by_id = rows
        .into_iter()
        .map(|row| (row.id, row))
        .collect::<HashMap<_, _>>();
    let txn = conn
        .begin()
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::db)?;
    for (idx, id) in ids.into_iter().enumerate() {
        let Some(row) = rows_by_id.remove(&id) else {
            return Err(AppCommandError::invalid_input(
                "Remote workspace order contains an unknown connection",
            ));
        };
        let mut active = row.into_active_model();
        active.sort_order = Set(idx as i32);
        active.updated_at = Set(now);
        active
            .update(&txn)
            .await
            .map_err(DbError::from)
            .map_err(AppCommandError::db)?;
    }
    txn.commit()
        .await
        .map_err(DbError::from)
        .map_err(AppCommandError::db)?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::test_helpers::fresh_in_memory_db;
    use crate::models::ToHeaderMap;

    #[test]
    fn normalize_base_url_trims_and_removes_trailing_slashes() {
        let actual = normalize_base_url("  http://127.0.0.1:3080///  ").unwrap();
        assert_eq!(actual, "http://127.0.0.1:3080");
    }

    #[test]
    fn normalize_base_url_rejects_non_http_schemes() {
        let err = normalize_base_url("file:///tmp/codeg").unwrap_err();
        assert!(err.message.contains("http"));
    }

    fn header(name: &str, value: &str) -> RemoteWorkspaceHeader {
        RemoteWorkspaceHeader {
            name: name.to_string(),
            value: value.to_string(),
        }
    }

    #[test]
    fn validate_headers_trims_and_drops_empty_rows() {
        let actual = validate_headers(&[
            header("  CF-Access-Client-Id  ", "  abc123  "),
            header("", ""),
            header("   ", "  "),
        ])
        .unwrap();
        assert_eq!(actual, vec![header("CF-Access-Client-Id", "abc123")]);
    }

    #[test]
    fn validate_headers_keeps_repeated_names_and_order() {
        let input = vec![header("X-Trace", "a"), header("X-Trace", "b")];
        assert_eq!(validate_headers(&input).unwrap(), input);
    }

    #[test]
    fn to_header_map_keeps_repeats_and_skips_unparsable_rows() {
        let map = [
            header("X-Trace", "a"),
            header("X-Trace", "b"),
            header("bad header", "dropped"),
            header("  ", "dropped"),
        ]
        .to_header_map();
        assert_eq!(
            map.get_all("x-trace")
                .iter()
                .map(|v| v.to_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["a", "b"]
        );
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn to_header_map_marks_every_value_sensitive() {
        // A custom header is a credential. Sensitive keeps it out of the HTTP/2
        // HPACK dynamic table and out of any `{:?}` of the request.
        let map = [header("CF-Access-Client-Secret", "s3cret")].to_header_map();
        let value = map.get("cf-access-client-secret").unwrap();
        assert!(value.is_sensitive());
        assert_eq!(format!("{value:?}"), "Sensitive");
    }

    #[test]
    fn validate_headers_rejects_reserved_names() {
        for name in [
            "Authorization",
            "content-type",
            "Transfer-Encoding",
            "Sec-WebSocket-Protocol",
        ] {
            let err = validate_headers(&[header(name, "x")]).unwrap_err();
            assert!(
                err.message.contains("reserved"),
                "expected {name} to be reserved, got {}",
                err.message
            );
        }
    }

    #[test]
    fn validate_headers_rejects_invalid_name_value_and_missing_name() {
        assert!(validate_headers(&[header("bad header", "x")]).is_err());
        assert!(validate_headers(&[header("X-Bad", "line\nbreak")]).is_err());
        assert!(validate_headers(&[header("", "orphan-value")]).is_err());
    }

    #[tokio::test]
    async fn create_list_update_delete_roundtrip() {
        let db = fresh_in_memory_db().await;
        let created = create(
            &db.conn,
            "Local 3080",
            "http://127.0.0.1:3080/",
            "secret-token",
            &[header("CF-Access-Client-Id", "abc123")],
        )
        .await
        .unwrap();
        assert_eq!(created.name, "Local 3080");
        assert_eq!(created.base_url, "http://127.0.0.1:3080");
        assert_eq!(created.token, "secret-token");
        assert_eq!(
            created.headers,
            vec![header("CF-Access-Client-Id", "abc123")]
        );
        assert_eq!(created.sort_order, 0);

        let listed = list(&db.conn).await.unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
        assert_eq!(listed[0].headers, created.headers);

        let updated = update(
            &db.conn,
            created.id,
            "Server A",
            "https://codeg.example.com/",
            "next-token",
            &[],
        )
        .await
        .unwrap();
        assert_eq!(updated.name, "Server A");
        assert_eq!(updated.base_url, "https://codeg.example.com");
        assert!(updated.headers.is_empty());

        delete(&db.conn, created.id).await.unwrap();
        assert!(list(&db.conn).await.unwrap().is_empty());
    }

    /// The upgrade path, which is every existing install: rows written before
    /// the `headers` column existed. `ADD COLUMN NOT NULL DEFAULT '[]'` has to
    /// backfill them — a NULL there fails to deserialize into `Model.headers:
    /// String` and takes the whole connection list down, not just the headers.
    /// The insert omits `headers` exactly the way the old schema did.
    #[tokio::test]
    async fn list_reads_a_row_written_without_the_headers_column() {
        use sea_orm::{ConnectionTrait, DbBackend, Statement};

        let db = fresh_in_memory_db().await;
        // Seeded through `create` so the legacy row can copy its timestamps
        // verbatim, rather than guessing SeaORM's SQLite datetime encoding.
        let seed = create(&db.conn, "Seed", "http://127.0.0.1:3080", "token", &[])
            .await
            .unwrap();
        db.conn
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                "INSERT INTO remote_workspace_connection \
                 (name, base_url, token, sort_order, created_at, updated_at) \
                 SELECT 'Legacy', 'http://127.0.0.1:3099', token, 1, \
                 created_at, updated_at FROM remote_workspace_connection"
                    .to_owned(),
            ))
            .await
            .unwrap();

        let listed = list(&db.conn).await.unwrap();
        assert_eq!(
            listed.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            vec!["Seed", "Legacy"]
        );
        assert!(listed[1].headers.is_empty());

        // `create` re-reads every column to find the max sort order, so the
        // legacy row has to survive that read too.
        let next = create(&db.conn, "Next", "http://127.0.0.1:3081", "token", &[])
            .await
            .unwrap();
        assert_eq!(next.sort_order, 2);
        assert_ne!(next.id, seed.id);
    }

    #[tokio::test]
    async fn reorder_updates_list_order() {
        let db = fresh_in_memory_db().await;
        let first = create(&db.conn, "First", "http://127.0.0.1:3080", "token-a", &[])
            .await
            .unwrap();
        let second = create(&db.conn, "Second", "http://127.0.0.1:3081", "token-b", &[])
            .await
            .unwrap();
        let third = create(&db.conn, "Third", "http://127.0.0.1:3082", "token-c", &[])
            .await
            .unwrap();

        reorder(&db.conn, vec![third.id, first.id, second.id])
            .await
            .unwrap();

        let listed = list(&db.conn).await.unwrap();
        assert_eq!(
            listed.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![third.id, first.id, second.id]
        );
        assert_eq!(
            listed
                .iter()
                .map(|item| item.sort_order)
                .collect::<Vec<_>>(),
            vec![0, 1, 2]
        );
    }

    #[tokio::test]
    async fn reorder_rejects_partial_or_duplicate_ids() {
        let db = fresh_in_memory_db().await;
        let first = create(&db.conn, "First", "http://127.0.0.1:3080", "token-a", &[])
            .await
            .unwrap();
        let second = create(&db.conn, "Second", "http://127.0.0.1:3081", "token-b", &[])
            .await
            .unwrap();

        let duplicate = reorder(&db.conn, vec![first.id, first.id])
            .await
            .unwrap_err();
        assert!(matches!(
            duplicate.code,
            crate::app_error::AppErrorCode::InvalidInput
        ));

        let partial = reorder(&db.conn, vec![second.id]).await.unwrap_err();
        assert!(matches!(
            partial.code,
            crate::app_error::AppErrorCode::InvalidInput
        ));

        let listed = list(&db.conn).await.unwrap();
        assert_eq!(
            listed.iter().map(|item| item.id).collect::<Vec<_>>(),
            vec![first.id, second.id]
        );
    }

    // ── Keychain storage ──

    /// In-memory stand-in for the OS keychain; `broken` makes every call fail
    /// the way a Linux desktop without a secret service does.
    #[derive(Default)]
    struct MemoryVault {
        entries: std::sync::Mutex<HashMap<String, String>>,
        broken: bool,
    }

    impl MemoryVault {
        fn broken() -> Self {
            Self {
                broken: true,
                ..Self::default()
            }
        }

        fn len(&self) -> usize {
            self.entries.lock().unwrap().len()
        }

        fn fail(&self) -> Result<(), String> {
            if self.broken {
                Err("no secret service".to_string())
            } else {
                Ok(())
            }
        }
    }

    impl TokenVault for MemoryVault {
        fn set(&self, key: &str, token: &str) -> Result<(), String> {
            self.fail()?;
            self.entries
                .lock()
                .unwrap()
                .insert(key.to_string(), token.to_string());
            Ok(())
        }

        fn get(&self, key: &str) -> Result<Option<String>, String> {
            self.fail()?;
            Ok(self.entries.lock().unwrap().get(key).cloned())
        }

        fn delete(&self, key: &str) -> Result<(), String> {
            self.fail()?;
            self.entries.lock().unwrap().remove(key);
            Ok(())
        }
    }

    async fn stored_token(conn: &DatabaseConnection, id: i32) -> String {
        remote_workspace_connection::Entity::find_by_id(id)
            .one(conn)
            .await
            .unwrap()
            .unwrap()
            .token
    }

    #[tokio::test]
    async fn without_a_vault_the_token_stays_in_the_database() {
        // codeg-server and every non-desktop build: unchanged behaviour.
        let db = fresh_in_memory_db().await;
        let created = create(&db.conn, "Server", "http://127.0.0.1:3080", "plain", &[])
            .await
            .unwrap();
        assert_eq!(stored_token(&db.conn, created.id).await, "plain");
        assert_eq!(
            get(&db.conn, created.id).await.unwrap().unwrap().token,
            "plain"
        );
    }

    #[tokio::test]
    async fn create_and_update_keep_the_token_in_the_vault() {
        let db = fresh_in_memory_db().await;
        let vault = MemoryVault::default();
        let created = create_with(
            &db.conn,
            "Cowork",
            "https://james.example.com",
            "secret-a",
            &[],
            Some(&vault),
        )
        .await
        .unwrap();
        // Callers still see the token; the column only has a pointer.
        assert_eq!(created.token, "secret-a");
        let stored = stored_token(&db.conn, created.id).await;
        assert!(stored.starts_with(KEYCHAIN_REF_PREFIX), "{stored}");
        assert!(!stored.contains("secret-a"));
        assert_eq!(vault.len(), 1);

        let updated = update_with(
            &db.conn,
            created.id,
            "Cowork",
            "https://james.example.com",
            "secret-b",
            &[],
            Some(&vault),
        )
        .await
        .unwrap();
        assert_eq!(updated.token, "secret-b");
        // Same entry overwritten, not a second one left behind.
        assert_eq!(stored_token(&db.conn, created.id).await, stored);
        assert_eq!(vault.len(), 1);

        let listed = list_with(&db.conn, Some(&vault)).await.unwrap();
        assert_eq!(listed[0].token, "secret-b");

        delete_with(&db.conn, created.id, Some(&vault))
            .await
            .unwrap();
        assert_eq!(vault.len(), 0);
    }

    #[tokio::test]
    async fn a_broken_vault_falls_back_to_the_database() {
        let db = fresh_in_memory_db().await;
        let vault = MemoryVault::broken();
        let created = create_with(
            &db.conn,
            "Cowork",
            "https://james.example.com",
            "secret-a",
            &[],
            Some(&vault),
        )
        .await
        .unwrap();
        assert_eq!(created.token, "secret-a");
        assert_eq!(stored_token(&db.conn, created.id).await, "secret-a");
        assert_eq!(
            get_with(&db.conn, created.id, Some(&vault))
                .await
                .unwrap()
                .unwrap()
                .token,
            "secret-a"
        );
        // Deleting still works when the keychain cannot be reached.
        delete_with(&db.conn, created.id, Some(&vault))
            .await
            .unwrap();
        assert!(list_with(&db.conn, Some(&vault)).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn update_falls_back_when_the_vault_stops_working() {
        let db = fresh_in_memory_db().await;
        let working = MemoryVault::default();
        let created = create_with(
            &db.conn,
            "Cowork",
            "https://james.example.com",
            "secret-a",
            &[],
            Some(&working),
        )
        .await
        .unwrap();
        let broken = MemoryVault::broken();
        let updated = update_with(
            &db.conn,
            created.id,
            "Cowork",
            "https://james.example.com",
            "secret-b",
            &[],
            Some(&broken),
        )
        .await
        .unwrap();
        assert_eq!(updated.token, "secret-b");
        assert_eq!(stored_token(&db.conn, created.id).await, "secret-b");
    }

    #[tokio::test]
    async fn migration_moves_plaintext_tokens_once() {
        let db = fresh_in_memory_db().await;
        // Rows written by an older version (no vault).
        let a = create(&db.conn, "A", "http://127.0.0.1:3080", "token-a", &[])
            .await
            .unwrap();
        let b = create(&db.conn, "B", "http://127.0.0.1:3081", "token-b", &[])
            .await
            .unwrap();
        let vault = MemoryVault::default();

        assert_eq!(migrate_tokens(&db.conn, &vault).await, 2);
        for row in [&a, &b] {
            let stored = stored_token(&db.conn, row.id).await;
            assert!(stored.starts_with(KEYCHAIN_REF_PREFIX), "{stored}");
        }
        let listed = list_with(&db.conn, Some(&vault)).await.unwrap();
        assert_eq!(
            listed.iter().map(|c| c.token.as_str()).collect::<Vec<_>>(),
            vec!["token-a", "token-b"]
        );
        // Idempotent: pointers are left alone.
        assert_eq!(migrate_tokens(&db.conn, &vault).await, 0);
        assert_eq!(vault.len(), 2);
    }

    #[tokio::test]
    async fn migration_without_a_keychain_leaves_rows_usable() {
        let db = fresh_in_memory_db().await;
        let a = create(&db.conn, "A", "http://127.0.0.1:3080", "token-a", &[])
            .await
            .unwrap();
        assert_eq!(migrate_tokens(&db.conn, &MemoryVault::broken()).await, 0);
        assert_eq!(stored_token(&db.conn, a.id).await, "token-a");
        assert_eq!(get(&db.conn, a.id).await.unwrap().unwrap().token, "token-a");
    }

    #[tokio::test]
    async fn a_missing_keychain_entry_reads_as_an_empty_token() {
        // Removed in Keychain Access, or the database copied to another
        // machine: the connection stays listed and the token can be re-entered.
        let db = fresh_in_memory_db().await;
        let vault = MemoryVault::default();
        let created = create_with(
            &db.conn,
            "Cowork",
            "https://james.example.com",
            "secret-a",
            &[],
            Some(&vault),
        )
        .await
        .unwrap();
        vault.entries.lock().unwrap().clear();
        let read = get_with(&db.conn, created.id, Some(&vault))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(read.token, "");
        assert_eq!(read.name, "Cowork");
        // Without any vault (codeg-server reading a desktop database) too.
        assert_eq!(get(&db.conn, created.id).await.unwrap().unwrap().token, "");

        let fixed = update_with(
            &db.conn,
            created.id,
            "Cowork",
            "https://james.example.com",
            "secret-new",
            &[],
            Some(&vault),
        )
        .await
        .unwrap();
        assert_eq!(fixed.token, "secret-new");
    }

    #[test]
    fn validate_token_rejects_a_value_that_looks_like_a_pointer() {
        assert!(validate_token("keychain:abc").is_err());
        assert_eq!(validate_token("  real-token ").unwrap(), "real-token");
    }
}
