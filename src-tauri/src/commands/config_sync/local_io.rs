//! Export the local configuration to a single file, and import one back.
//!
//! The file is one self-contained JSON object — manifest and snapshot
//! together — because a user who picks "export" expects one file they can put
//! in a note-taking app or send to themselves, not a pair they must keep
//! together. The WebDAV path keeps them separate for a different reason (see
//! `snapshot.rs`: a two-file upload is how a half-finished transfer becomes
//! detectable), and the two formats deliberately share the same manifest type.
//!
//! Import also accepts a bare `config.json` — the exact file the sync writes
//! to WebDAV — so a user who fetches one out of their cloud drive's web UI can
//! feed it straight back in, encrypted or not.
//!
//! The checksum is NOT enforced on import. It exists to catch a truncated
//! upload, which cannot happen to a local file the OS handed us whole; holding
//! a hand-edited export to a byte-exact hash would only punish the user for
//! reformatting their own file. Schema version, structure, domain payloads, and
//! the preference allowlist are still enforced.
//!
//! Both halves come in a by-path and a by-content flavour. The desktop picks
//! paths with a native dialog and lets the backend do the I/O; a browser has no
//! path to hand over, so it posts the bytes instead. A config snapshot is tens
//! of KB, so the second flavour costs one copy in memory — which is why this
//! feature does not need the upload-staging machinery `backup` uses for
//! archives measured in gigabytes.

use std::collections::BTreeMap;
use std::path::Path;

use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use super::credentials::{self, SNAPSHOT_PASSPHRASE};
use super::crypto;
use super::snapshot::{
    apply_snapshot_core, build_manifest, collect_snapshot_core, read_rollback, resolve_rollback,
    serialize_snapshot, write_rollback_snapshot, ApplyReport, ConfigManifest, ConfigSnapshot,
    ENCRYPTION_NONE,
};
use crate::app_error::{AppCommandError, CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT};
use crate::web::event_bridge::EventEmitter;

/// Marker + version of the single-file export envelope.
pub const EXPORT_FORMAT_VERSION: u32 = 1;

/// Hard ceiling on a posted import, so a browser (or anything else speaking to
/// the HTTP API) cannot hand the parser an unbounded body. Two orders of
/// magnitude above any real snapshot, and the same bound the WebDAV client
/// applies to a download.
pub const MAX_IMPORT_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExportFile {
    /// Presence of this field is what distinguishes an export envelope from a
    /// bare `config.json`.
    pub codeg_config_export: u32,
    pub manifest: ConfigManifest,
    pub config: ConfigSnapshot,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExportSummary {
    pub path: String,
    pub counts: BTreeMap<String, usize>,
}

/// What the confirmation dialog shows before anything is written.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportPreview {
    pub manifest: ConfigManifest,
    pub counts: BTreeMap<String, usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigImportResult {
    pub applied: ApplyReport,
    /// Where the pre-import state was saved. `None` means the safety net could
    /// not be written — surfaced, but never a reason to refuse an import the
    /// user explicitly asked for.
    pub rollback_path: Option<String>,
}

pub async fn build_export_core(
    conn: &DatabaseConnection,
    app_version: &str,
    include_secrets: bool,
) -> Result<ConfigExportFile, AppCommandError> {
    let mut snapshot = collect_snapshot_core(conn).await?;
    if !include_secrets {
        omit_provider_api_keys(&mut snapshot);
    }
    let bytes = serialize_snapshot(&snapshot)?;
    let manifest = build_manifest(&bytes, app_version, snapshot.counts(), ENCRYPTION_NONE);
    Ok(ConfigExportFile {
        codeg_config_export: EXPORT_FORMAT_VERSION,
        manifest,
        config: snapshot,
    })
}

/// 用户在导出确认框里勾了「不导出密钥」：把模型服务商的 `apiKey` 整个去掉
/// （不是写成空串）。导入时没有这个字段就保留那台机器自己的密钥，见
/// `domains::apply_model_providers`；空串仍表示「密钥被清空了」。
///
/// 供应商绑到智能体时，同一把密钥也会被写进智能体的环境变量（比如
/// `ANTHROPIC_AUTH_TOKEN`），所以 `agentSettings` 的 `envJson` 里值等于某把
/// 供应商密钥的变量也一起去掉，不管变量叫什么；别的变量照旧导出。
fn omit_provider_api_keys(snapshot: &mut ConfigSnapshot) {
    let mut keys: Vec<String> = Vec::new();
    if let Some(serde_json::Value::Array(rows)) = snapshot
        .domains
        .get_mut(super::domains::DOMAIN_MODEL_PROVIDERS)
    {
        for row in rows {
            if let serde_json::Value::Object(fields) = row {
                if let Some(serde_json::Value::String(key)) = fields.remove("apiKey") {
                    let key = key.trim();
                    if !key.is_empty() {
                        keys.push(key.to_string());
                    }
                }
            }
        }
    }
    if keys.is_empty() {
        return;
    }
    let Some(serde_json::Value::Array(rows)) = snapshot
        .domains
        .get_mut(super::domains::DOMAIN_AGENT_SETTINGS)
    else {
        return;
    };
    for row in rows {
        let serde_json::Value::Object(fields) = row else {
            continue;
        };
        let Some(serde_json::Value::String(raw)) = fields.get("envJson") else {
            continue;
        };
        let Ok(mut env) = serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(raw)
        else {
            continue;
        };
        let before = env.len();
        env.retain(|_, value| {
            !matches!(value, serde_json::Value::String(v) if keys.iter().any(|k| k == v.trim()))
        });
        if env.len() == before {
            continue;
        }
        let replaced = if env.is_empty() {
            serde_json::Value::Null
        } else {
            match serde_json::to_string(&env) {
                Ok(text) => serde_json::Value::String(text),
                Err(_) => serde_json::Value::Null,
            }
        };
        fields.insert("envJson".to_string(), replaced);
    }
}

/// The export as text, for a caller with somewhere other than a local path to
/// put it — a browser saves it with a `Blob` download. Byte-for-byte the same
/// document [`export_to_file_core`] writes, so the two runtimes produce
/// interchangeable files.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigExportContent {
    pub content: String,
    pub counts: BTreeMap<String, usize>,
}

pub async fn export_content_core(
    conn: &DatabaseConnection,
    app_version: &str,
    include_secrets: bool,
) -> Result<ConfigExportContent, AppCommandError> {
    let export = build_export_core(conn, app_version, include_secrets).await?;
    let content = serde_json::to_string_pretty(&export).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize config export").with_detail(e.to_string())
    })?;
    Ok(ConfigExportContent {
        counts: export.config.counts(),
        content,
    })
}

pub async fn export_to_file_core(
    conn: &DatabaseConnection,
    app_version: &str,
    dest: &Path,
    include_secrets: bool,
) -> Result<ConfigExportSummary, AppCommandError> {
    let export = build_export_core(conn, app_version, include_secrets).await?;
    let bytes = serde_json::to_vec_pretty(&export).map_err(|e| {
        AppCommandError::task_execution_failed("Serialize config export").with_detail(e.to_string())
    })?;
    let counts = export.config.counts();

    if let Some(parent) = dest.parent() {
        if !parent.as_os_str().is_empty() {
            std::fs::create_dir_all(parent).map_err(AppCommandError::io)?;
        }
    }
    std::fs::write(dest, &bytes).map_err(AppCommandError::io)?;

    Ok(ConfigExportSummary {
        path: dest.to_string_lossy().to_string(),
        counts,
    })
}

/// Accepts all three shapes a user can plausibly present: the export envelope,
/// a bare `config.json` lifted off the remote, and an encrypted one. The bare
/// forms get a synthesized manifest so the preview dialog has something to
/// show.
///
/// `passphrase` is only consulted for the encrypted shape, and an empty one
/// there is reported as "configure a passphrase", not as "this file is junk" —
/// the file is fine, this machine just cannot read it yet.
pub fn parse_export_bytes(
    bytes: &[u8],
    passphrase: &str,
) -> Result<ConfigExportFile, AppCommandError> {
    if bytes.len() > MAX_IMPORT_BYTES {
        return Err(AppCommandError::invalid_input("Config file is too large")
            .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new()));
    }

    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|e| {
        AppCommandError::invalid_input("Not a codeg config file")
            .with_detail(e.to_string())
            .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new())
    })?;

    if value.get("codegConfigExport").is_some() {
        let export: ConfigExportFile = serde_json::from_value(value).map_err(|e| {
            AppCommandError::invalid_input("Malformed codeg config export")
                .with_detail(e.to_string())
                .with_i18n(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT, BTreeMap::new())
        })?;
        // Reject a newer schema — and a domain payload that would abort the
        // apply — the same way the WebDAV path does, before any of it reaches
        // the database.
        let snapshot_bytes = serialize_snapshot(&export.config)?;
        super::snapshot::parse_snapshot(&snapshot_bytes)?;
        return Ok(export);
    }

    if crypto::is_encrypted_value(&value) {
        let payload = crypto::parse_envelope(value)?;
        let plain = crypto::decrypt(&payload, passphrase)?;
        return synthesize_export(&plain);
    }

    synthesize_export(bytes)
}

/// Wrap a bare `config.json` in the envelope the rest of the import path
/// expects, with a manifest describing the snapshot as it now stands in memory.
fn synthesize_export(snapshot_bytes: &[u8]) -> Result<ConfigExportFile, AppCommandError> {
    let snapshot = super::snapshot::parse_snapshot(snapshot_bytes)?;
    let canonical = serialize_snapshot(&snapshot)?;
    let manifest = build_manifest(&canonical, "unknown", snapshot.counts(), ENCRYPTION_NONE);
    Ok(ConfigExportFile {
        codeg_config_export: EXPORT_FORMAT_VERSION,
        manifest,
        config: snapshot,
    })
}

/// The passphrase the user configured for WebDAV snapshots, reused here so a
/// `config.json` pulled out of a cloud drive's web UI imports without a second
/// place to type it.
fn stored_passphrase() -> String {
    credentials::load(SNAPSHOT_PASSPHRASE)
}

pub fn read_export_file(path: &Path) -> Result<ConfigExportFile, AppCommandError> {
    let bytes = std::fs::read(path).map_err(AppCommandError::io)?;
    parse_export_bytes(&bytes, &stored_passphrase())
}

/// Read and validate without touching the database — what the UI calls to
/// populate "this file contains N providers, M agents…".
pub fn peek_import_core(path: &Path) -> Result<ConfigImportPreview, AppCommandError> {
    preview_of(read_export_file(path)?)
}

/// Same, for a caller that already has the bytes (the web import posts them).
pub fn peek_import_bytes_core(bytes: &[u8]) -> Result<ConfigImportPreview, AppCommandError> {
    preview_of(parse_export_bytes(bytes, &stored_passphrase())?)
}

fn preview_of(export: ConfigExportFile) -> Result<ConfigImportPreview, AppCommandError> {
    Ok(ConfigImportPreview {
        counts: export.config.counts(),
        manifest: export.manifest,
    })
}

pub async fn import_from_file_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    path: &Path,
    rollbacks: &Path,
) -> Result<ConfigImportResult, AppCommandError> {
    // Parse before writing the rollback snapshot: a malformed file should cost
    // the user nothing at all.
    let export = read_export_file(path)?;
    apply_import(conn, emitter, &export.config, rollbacks).await
}

pub async fn import_bytes_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    bytes: &[u8],
    rollbacks: &Path,
) -> Result<ConfigImportResult, AppCommandError> {
    let export = parse_export_bytes(bytes, &stored_passphrase())?;
    apply_import(conn, emitter, &export.config, rollbacks).await
}

async fn apply_import(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    snapshot: &ConfigSnapshot,
    rollbacks: &Path,
) -> Result<ConfigImportResult, AppCommandError> {
    // Hold the uploader off for the duration: applying rewrites local
    // configuration row by row, and a tick landing in the middle would push a
    // half-merged state to the remote as if it were a state the user chose.
    // The upload the import DOES deserve happens on the next tick, once the
    // configuration is whole again.
    let _suppression = super::auto_sync::suppress_auto_sync();
    let rollback_path = save_rollback(conn, rollbacks).await;
    let applied = apply_snapshot_core(conn, emitter, snapshot).await?;
    Ok(ConfigImportResult {
        applied,
        rollback_path,
    })
}

/// Undo an import or a restore by re-applying the snapshot taken just before
/// it. Writes its own rollback point first, so the undo is itself undoable —
/// a user who rolls back to the wrong one is not out of options.
///
/// `dir` is a parameter rather than a call to [`rollback_dir`] for the same
/// reason [`write_rollback_snapshot`] takes one: the command layer supplies the
/// real directory, and a test supplies a temporary one instead of writing into
/// the developer's `~/.codeg`.
pub async fn apply_rollback_core(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    dir: &Path,
    id: &str,
) -> Result<ConfigImportResult, AppCommandError> {
    let path = resolve_rollback(dir, id)?;
    let snapshot = read_rollback(&path)?;
    apply_import(conn, emitter, &snapshot, dir).await
}

/// Newest first. Empty — never an error — when nothing has ever been imported:
/// the directory simply does not exist yet.
pub fn list_rollbacks_core(dir: &Path) -> Vec<super::snapshot::RollbackSnapshotInfo> {
    super::snapshot::list_rollback_infos(dir)
}

/// Capture "what this machine looked like before" so a surprising import is
/// undoable. Best effort by design — see [`ConfigImportResult::rollback_path`].
///
/// `dir` is a parameter for the same reason the read side takes one. Calling
/// [`rollback_dir`] in here instead would mean an import driven against a
/// temporary directory still WRITES to — and prunes — the real one, so the two
/// halves of "undo" would disagree about where the snapshots are, and a test
/// would evict the developer's own.
pub async fn save_rollback(conn: &DatabaseConnection, dir: &Path) -> Option<String> {
    let snapshot = match collect_snapshot_core(conn).await {
        Ok(snapshot) => snapshot,
        Err(err) => {
            tracing::warn!("[CONFIG-SYNC] rollback snapshot not collected: {err}");
            return None;
        }
    };
    match write_rollback_snapshot(dir, &snapshot) {
        Ok(path) => Some(path.to_string_lossy().to_string()),
        Err(err) => {
            tracing::warn!("[CONFIG-SYNC] rollback snapshot not written: {err}");
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::snapshot::SCHEMA_VERSION;
    use super::*;
    use crate::db::entities::{model_provider, quick_message};
    use crate::db::test_helpers::fresh_in_memory_db;
    use sea_orm::{ActiveModelTrait, ActiveValue::NotSet, EntityTrait, Set};

    async fn seed_message(conn: &DatabaseConnection, title: &str) {
        let now = chrono::Utc::now();
        quick_message::ActiveModel {
            id: NotSet,
            title: Set(title.to_string()),
            content: Set("body".to_string()),
            sort_order: Set(0),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(conn)
        .await
        .expect("seed");
    }

    async fn seed_provider(conn: &DatabaseConnection, api_key: &str) {
        let now = chrono::Utc::now();
        model_provider::ActiveModel {
            id: NotSet,
            name: Set("Fake Provider".to_string()),
            api_url: Set("https://provider.example.invalid".to_string()),
            api_key: Set(api_key.to_string()),
            agent_types_json: Set("[\"claude_code\"]".to_string()),
            agent_type: Set("claude_code".to_string()),
            model: Set(None),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(conn)
        .await
        .expect("seed provider");
    }

    /// 默认导出照旧带密钥：换电脑直接导入就能用。
    #[tokio::test]
    async fn an_export_with_secrets_carries_the_api_key() {
        let source = fresh_in_memory_db().await;
        seed_provider(&source.conn, "sk-fake-source-key").await;
        let built = export_content_core(&source.conn, "9.9.9", true)
            .await
            .expect("export");
        assert!(built.content.contains("sk-fake-source-key"));
    }

    /// 勾了「不导出密钥」：文件里没有密钥明文；导入到已经有同名供应商的
    /// 机器上，不能拿空值把那边自己的密钥冲掉。
    #[tokio::test]
    async fn an_export_without_secrets_omits_the_api_key_and_keeps_the_targets() {
        let source = fresh_in_memory_db().await;
        seed_provider(&source.conn, "sk-fake-source-key").await;
        let built = export_content_core(&source.conn, "9.9.9", false)
            .await
            .expect("export");
        assert!(
            !built.content.contains("sk-fake-source-key"),
            "export without secrets still contains the key: {}",
            built.content
        );
        assert_eq!(built.counts.get("modelProviders"), Some(&1));

        let target = fresh_in_memory_db().await;
        seed_provider(&target.conn, "sk-fake-target-key").await;
        let rollbacks = tempfile::tempdir().expect("tempdir");
        import_bytes_core(
            &target.conn,
            &EventEmitter::Noop,
            built.content.as_bytes(),
            rollbacks.path(),
        )
        .await
        .expect("import");
        let providers = model_provider::Entity::find()
            .all(&target.conn)
            .await
            .expect("providers");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].api_key, "sk-fake-target-key");

        // 新机器上没有这个供应商：照样建出来，密钥留空等用户自己填。
        let fresh = fresh_in_memory_db().await;
        import_bytes_core(
            &fresh.conn,
            &EventEmitter::Noop,
            built.content.as_bytes(),
            rollbacks.path(),
        )
        .await
        .expect("import into fresh");
        let providers = model_provider::Entity::find()
            .all(&fresh.conn)
            .await
            .expect("providers");
        assert_eq!(providers.len(), 1);
        assert_eq!(providers[0].api_key, "");
    }

    /// 供应商绑到智能体以后，同一把密钥会出现在智能体的环境变量里：勾了
    /// 「不导出密钥」，环境变量里这把密钥也要去掉，别的变量照旧导出。
    #[tokio::test]
    async fn an_export_without_secrets_drops_the_bound_key_from_agent_env() {
        use crate::db::entities::agent_setting;
        let source = fresh_in_memory_db().await;
        seed_provider(&source.conn, "sk-fake-bound-key").await;
        let provider = model_provider::Entity::find()
            .one(&source.conn)
            .await
            .expect("provider")
            .expect("seeded");
        let now = chrono::Utc::now();
        agent_setting::ActiveModel {
            id: NotSet,
            agent_type: Set("claude_code".to_string()),
            registry_id: Set("claude_code".to_string()),
            enabled: Set(true),
            sort_order: Set(0),
            installed_version: Set(None),
            env_json: Set(Some(
                "{\"ANTHROPIC_AUTH_TOKEN\":\"sk-fake-bound-key\",\"ANTHROPIC_MODEL\":\"fake-model\"}"
                    .to_string(),
            )),
            model_provider_id: Set(Some(provider.id)),
            created_at: Set(now),
            updated_at: Set(now),
        }
        .insert(&source.conn)
        .await
        .expect("seed agent setting");

        let built = export_content_core(&source.conn, "9.9.9", false)
            .await
            .expect("export");
        assert!(
            !built.content.contains("sk-fake-bound-key"),
            "export without secrets still contains the bound key: {}",
            built.content
        );
        assert!(built.content.contains("fake-model"));
        assert_eq!(built.counts.get("agentSettings"), Some(&1));

        let with_keys = export_content_core(&source.conn, "9.9.9", true)
            .await
            .expect("export");
        assert!(with_keys.content.contains("ANTHROPIC_AUTH_TOKEN"));
    }

    #[tokio::test]
    async fn exported_file_imports_into_another_machine() {
        let source = fresh_in_memory_db().await;
        seed_message(&source.conn, "Exported").await;

        let dir = tempfile::tempdir().expect("tempdir");
        let dest = dir.path().join("nested").join("codeg-config.json");
        let summary = export_to_file_core(&source.conn, "9.9.9", &dest, true)
            .await
            .expect("export");
        assert!(dest.exists());
        assert_eq!(summary.counts.get("quickMessages"), Some(&1));

        let preview = peek_import_core(&dest).expect("peek");
        assert_eq!(preview.manifest.app_version, "9.9.9");
        assert_eq!(preview.counts.get("quickMessages"), Some(&1));

        let target = fresh_in_memory_db().await;
        let rollbacks = tempfile::tempdir().expect("tempdir");
        let result = import_from_file_core(&target.conn, &EventEmitter::Noop, &dest, rollbacks.path())
            .await
            .expect("import");
        assert!(result.applied.total >= 1);
        assert_eq!(
            quick_message::Entity::find()
                .all(&target.conn)
                .await
                .expect("messages")
                .len(),
            1
        );
    }

    /// The file the WebDAV sync uploads must be importable as-is — a user who
    /// pulls `config.json` out of their cloud drive's web UI should not have
    /// to reshape it.
    #[tokio::test]
    async fn a_bare_remote_config_json_is_accepted() {
        let source = fresh_in_memory_db().await;
        seed_message(&source.conn, "Bare").await;
        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");
        let bytes = serialize_snapshot(&snapshot).expect("bytes");

        let export = parse_export_bytes(&bytes, "").expect("parse bare");
        assert_eq!(export.config.schema_version, SCHEMA_VERSION);
        assert_eq!(export.manifest.app_version, "unknown");
        assert_eq!(export.config.counts().get("quickMessages"), Some(&1));
    }

    /// The encrypted `config.json` the sync uploads has to come back in through
    /// the same door: a user who downloads it from their cloud drive's web UI
    /// should not be told their own file is not a codeg config.
    #[tokio::test]
    async fn an_encrypted_remote_config_json_is_accepted_with_the_stored_passphrase() {
        let _guard = credentials::test_guard().await;
        let source = fresh_in_memory_db().await;
        seed_message(&source.conn, "Sealed").await;
        let snapshot = collect_snapshot_core(&source.conn).await.expect("collect");
        let sealed = crypto::encrypt(&serialize_snapshot(&snapshot).expect("bytes"), "hunter2")
            .expect("encrypt");

        // Nothing configured yet: the file is readable, this machine is not
        // equipped to read it, and the message has to say which.
        credentials::store(SNAPSHOT_PASSPHRASE, "").expect("clear");
        let err = parse_export_bytes(&sealed, &stored_passphrase()).expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_PASSPHRASE_REQUIRED)
        );

        credentials::store(SNAPSHOT_PASSPHRASE, "wrong").expect("store");
        let err = parse_export_bytes(&sealed, &stored_passphrase()).expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_BAD_PASSPHRASE)
        );

        credentials::store(SNAPSHOT_PASSPHRASE, "hunter2").expect("store");
        let preview = peek_import_bytes_core(&sealed).expect("peek");
        assert_eq!(preview.counts.get("quickMessages"), Some(&1));

        let target = fresh_in_memory_db().await;
        let rollbacks = tempfile::tempdir().expect("tempdir");
        let result = import_bytes_core(&target.conn, &EventEmitter::Noop, &sealed, rollbacks.path())
            .await
            .expect("import");
        assert!(result.applied.total >= 1);
        credentials::store(SNAPSHOT_PASSPHRASE, "").expect("clear");
    }

    /// Regression: only the envelope was checked, so a file whose domain
    /// payload was nonsense previewed cleanly ("1 quick message") and then
    /// aborted the apply — after the rollback snapshot had been written and
    /// with the user told an import was starting.
    #[tokio::test]
    async fn a_file_that_would_abort_mid_apply_never_reaches_the_preview() {
        let bytes = serde_json::to_vec(&serde_json::json!({
            "schemaVersion": SCHEMA_VERSION,
            "domains": {
                "quickMessages": [{ "title": "fine", "content": "body" }],
                "customAgents": [{ "registryId": "acme" }]
            }
        }))
        .expect("bytes");

        let err = peek_import_bytes_core(&bytes).expect_err("must refuse at preview");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(crate::app_error::CONFIG_SYNC_I18N_KEY_BAD_DOMAIN)
        );

        // And nothing is written when the import is attempted anyway.
        let target = fresh_in_memory_db().await;
        let rollbacks = tempfile::tempdir().expect("tempdir");
        import_bytes_core(&target.conn, &EventEmitter::Noop, &bytes, rollbacks.path())
            .await
            .expect_err("must refuse");
        assert_eq!(
            quick_message::Entity::find()
                .all(&target.conn)
                .await
                .expect("messages")
                .len(),
            0
        );
    }

    #[tokio::test]
    async fn an_oversized_payload_is_refused_before_it_is_parsed() {
        let huge = vec![b'x'; MAX_IMPORT_BYTES + 1];
        let err = parse_export_bytes(&huge, "").expect_err("must refuse");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT)
        );
    }

    /// A reformatted export (different indentation, reordered keys) must still
    /// import: the checksum guards transfers, not the user's text editor.
    #[tokio::test]
    async fn a_reformatted_export_still_imports() {
        let source = fresh_in_memory_db().await;
        seed_message(&source.conn, "Reformatted").await;
        let export = build_export_core(&source.conn, "1.0.0", true)
            .await
            .expect("build");

        let compact = serde_json::to_vec(&export).expect("compact bytes");
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("compact.json");
        std::fs::write(&path, compact).expect("write");

        let target = fresh_in_memory_db().await;
        import_from_file_core(&target.conn, &EventEmitter::Noop, &path, dir.path())
            .await
            .expect("import compact");
        assert_eq!(
            quick_message::Entity::find()
                .all(&target.conn)
                .await
                .expect("messages")
                .len(),
            1
        );
    }

    /// The safety net has to be reachable, not merely written: a snapshot taken
    /// before an import must be listable by id and applicable by that id, or
    /// the `rollbackPath` an import returns is a file the product cannot open.
    #[tokio::test]
    async fn a_rollback_snapshot_can_be_listed_and_applied_back() {
        let dir = tempfile::tempdir().expect("tempdir");

        let before = fresh_in_memory_db().await;
        seed_message(&before.conn, "Original").await;
        let snapshot = collect_snapshot_core(&before.conn).await.expect("collect");
        write_rollback_snapshot(dir.path(), &snapshot).expect("write rollback");

        let listed = list_rollbacks_core(dir.path());
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].counts.get("quickMessages"), Some(&1));

        // A machine that has since been overwritten with someone else's config.
        let target = fresh_in_memory_db().await;
        seed_message(&target.conn, "Imported").await;

        let result = apply_rollback_core(&target.conn, &EventEmitter::Noop, dir.path(), &listed[0].id)
            .await
            .expect("apply rollback");
        assert!(result.applied.total >= 1);

        let titles: Vec<String> = quick_message::Entity::find()
            .all(&target.conn)
            .await
            .expect("messages")
            .into_iter()
            .map(|m| m.title)
            .collect();
        assert!(titles.contains(&"Original".to_string()), "{titles:?}");

        // An id that is not on this machine is a plain "gone", not a panic and
        // not a path.
        assert!(
            apply_rollback_core(&target.conn, &EventEmitter::Noop, dir.path(), "../../etc/passwd")
                .await
                .is_err()
        );

        // And the undo left its own undo point in the SAME directory it reads
        // from — see the next test for why that is not automatic.
        let after = list_rollbacks_core(dir.path());
        assert_eq!(after.len(), 2, "the undo must itself be undoable");
    }

    /// The write half and the read half of "undo" have to agree on where the
    /// snapshots live. They did not: the reader took a directory and the writer
    /// called [`rollback_dir`] regardless, so an import driven against a
    /// temporary directory still wrote into — and PRUNED — the real
    /// `~/.codeg/config-snapshots`. The button showed nothing while the test
    /// suite quietly evicted the developer's own eleventh-newest snapshot.
    #[tokio::test]
    async fn an_import_saves_its_rollback_point_where_the_list_will_look() {
        let rollbacks = tempfile::tempdir().expect("tempdir");
        let source = fresh_in_memory_db().await;
        seed_message(&source.conn, "Incoming").await;
        let export = build_export_core(&source.conn, "9.9.9", true)
            .await
            .expect("export");
        let bytes = serde_json::to_vec(&export).expect("bytes");

        let target = fresh_in_memory_db().await;
        seed_message(&target.conn, "Local").await;
        assert!(list_rollbacks_core(rollbacks.path()).is_empty());

        let result = import_bytes_core(&target.conn, &EventEmitter::Noop, &bytes, rollbacks.path())
            .await
            .expect("import");

        let listed = list_rollbacks_core(rollbacks.path());
        assert_eq!(listed.len(), 1, "the rollback point went somewhere else");
        assert!(
            result
                .rollback_path
                .as_deref()
                .is_some_and(|path| path.starts_with(&*rollbacks.path().to_string_lossy())),
            "reported {:?}, expected it under {}",
            result.rollback_path,
            rollbacks.path().display()
        );
    }

    #[tokio::test]
    async fn junk_files_are_rejected_before_anything_is_touched() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("notes.txt");
        std::fs::write(&path, b"just some notes").expect("write");

        let target = fresh_in_memory_db().await;
        let err = import_from_file_core(&target.conn, &EventEmitter::Noop, &path, dir.path())
            .await
            .expect_err("must reject");
        assert_eq!(
            err.i18n_key.as_deref(),
            Some(CONFIG_SYNC_I18N_KEY_INVALID_SNAPSHOT)
        );
    }
}
