//! DeepSeek Harness deployment settings — the extra model routes.
//!
//! From 0.11 on, `deepseek-acp` keeps its own settings document at
//! `$DSH_HOME/deepseek-acp/settings.yaml` (default `~/.dsh/deepseek-acp/…`).
//! It holds a single section, `llm-pi-ai`: the plugin config of
//! `@deepseek-ai/dsh-llm-pi-ai`, whose `providers` table declares routes beyond
//! the official DeepSeek one — an OpenAI Responses gateway, a local server, …
//! Each route's models show up in the session's model dropdown as
//! `<route>::<model>`.
//!
//! Three upstream facts shape the surface:
//!
//! * The document is read when a session process starts (one client connection
//!   is one process), so a save reaches sessions started after it, not the ones
//!   already running.
//! * While the adapter's own document does not exist, it imports the section
//!   READ-ONLY from `$DSH_HOME/settings.yaml` (what 0.9 read) and then from
//!   `settings.yaml.imported` (that file after upstream's 0.2 CLI moved it).
//!   [`load_deepseek_routes_core`] shows that imported section so the editor
//!   starts from what sessions actually use; the first save lands it in the
//!   adapter's own document, after which the old files are no longer read —
//!   exactly what the adapter's own first edit does. The old files are never
//!   written: they belong to upstream and to older versions.
//! * The adapter rewrites its document with a plain YAML stringify on every
//!   edit it makes itself, so it carries no comments worth preserving. A whole
//!   document round trip through `serde_yaml` is therefore what this module
//!   does too; any other top-level key in the document is kept.
//!
//! The section is edited as YAML text rather than through a form: pi-ai's route
//! schema is wide (protocol, headers, retry policy, per-model capacities…) and
//! validated by pi-ai itself when the session starts. What is checked here is
//! only what would otherwise fail silently or leak: the shape of `providers`,
//! and that no route carries a plaintext `apiKey` — a key goes in the agent's
//! environment and the route names it with `apiKeyEnv`.
//!
//! Path resolution follows the repo-wide convention (`resolve_dsh_home_dir`):
//! codeg's own process env, not the per-agent `env_json`, which only reaches
//! the spawned child.

use std::fs;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_yaml::{Mapping, Value};

use crate::acp::error::AcpError;
use crate::models::agent::AgentType;
use crate::web::event_bridge::EventEmitter;

use super::acp::emit_acp_agents_updated;

/// The only section of the adapter's document: pi-ai's plugin config (the
/// adapter mounts the plugin under the loader entry id `llm-pi-ai`).
const SECTION_KEY: &str = "llm-pi-ai";
/// The route table inside that section.
const PROVIDERS_KEY: &str = "providers";

/// pi-ai 1.x renamed built-in providers: old id → new id. The adapter applies
/// this when it imports an old document, so the editor shows it the same way.
const RENAMED_PROVIDERS: &[(&str, &str)] = &[("azure-openai-responses", "azure")];

/// What the settings panel reads.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeepSeekRoutes {
    /// The adapter's own document, the one a save writes — shown so the user
    /// can find (or hand-edit) it.
    pub path: String,
    /// Whether that document exists.
    pub exists: bool,
    /// The `llm-pi-ai` section as YAML text; empty when no route is declared.
    pub yaml: String,
    /// Set when the adapter's own document does not exist yet and [`Self::yaml`]
    /// is what sessions import read-only from this older document.
    pub imported_from: Option<String>,
    /// Why the adapter's document could not be read. Set only when the file
    /// exists and is unusable — the panel then refuses to edit rather than
    /// offering a save that would overwrite something it never understood.
    pub error: Option<String>,
}

/// `$DSH_HOME/deepseek-acp/settings.yaml` — the adapter's own document.
pub fn deepseek_routes_path() -> PathBuf {
    own_document_path(&crate::parsers::deepseek::resolve_dsh_home_dir())
}

fn own_document_path(home: &Path) -> PathBuf {
    home.join("deepseek-acp").join("settings.yaml")
}

/// The documents the adapter imports from, in its own order, while its own
/// document does not exist.
fn legacy_document_paths(home: &Path) -> Vec<PathBuf> {
    vec![
        home.join("settings.yaml"),
        home.join("settings.yaml.imported"),
    ]
}

/// Read the routes for the settings panel. Never errors: a missing document
/// is "no routes", and an unreadable one is reported in-band.
pub fn load_deepseek_routes_core() -> DeepSeekRoutes {
    let home = crate::parsers::deepseek::resolve_dsh_home_dir();
    load_deepseek_routes_at(&own_document_path(&home), &legacy_document_paths(&home))
}

fn load_deepseek_routes_at(path: &Path, legacy: &[PathBuf]) -> DeepSeekRoutes {
    let mut routes = DeepSeekRoutes {
        path: path.display().to_string(),
        exists: false,
        yaml: String::new(),
        imported_from: None,
        error: None,
    };

    match fs::read_to_string(path) {
        Ok(raw) => {
            routes.exists = true;
            let section =
                parse_document(&raw).and_then(|document| section_text(document.get(SECTION_KEY)));
            match section {
                Ok(yaml) => routes.yaml = yaml,
                Err(message) => routes.error = Some(message),
            }
        }
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            if let Some((from, section)) = read_legacy_section(legacy) {
                // `section_text` only fails on a non-mapping, which
                // `read_legacy_section` already skipped.
                routes.yaml = section_text(Some(&Value::Mapping(section))).unwrap_or_default();
                routes.imported_from = Some(from.display().to_string());
            }
        }
        Err(err) => {
            routes.exists = true;
            routes.error = Some(format!("could not read the settings document: {err}"));
        }
    }
    routes
}

/// The first older document carrying the section, upgraded the way the
/// adapter upgrades it on import. One that cannot be read or parsed is
/// skipped, as the adapter skips it — an older file is not ours to vouch for.
fn read_legacy_section(legacy: &[PathBuf]) -> Option<(&Path, Mapping)> {
    legacy.iter().find_map(|path| {
        let raw = fs::read_to_string(path).ok()?;
        let document = parse_document(&raw).ok()?;
        let mut section = match document.get(SECTION_KEY)? {
            Value::Mapping(section) => section.clone(),
            _ => return None,
        };
        upgrade_legacy_section(&mut section);
        Some((path.as_path(), section))
    })
}

fn upgrade_legacy_section(section: &mut Mapping) {
    let Some(Value::Mapping(providers)) = section.get_mut(PROVIDERS_KEY) else {
        return;
    };
    for (from, to) in RENAMED_PROVIDERS {
        if let Some(value) = providers.shift_remove(*from) {
            // Both present: keep the new one, the user configured it in the
            // newer version.
            if !providers.contains_key(*to) {
                providers.insert((*to).into(), value);
            }
        }
    }
}

/// Parse a settings document into its top-level mapping. An empty document
/// (or one holding only comments) is an empty mapping, as the adapter reads it.
fn parse_document(raw: &str) -> Result<Mapping, String> {
    if is_blank_yaml(raw) {
        return Ok(Mapping::new());
    }
    match serde_yaml::from_str::<Value>(raw) {
        Ok(Value::Null) => Ok(Mapping::new()),
        Ok(Value::Mapping(document)) => Ok(document),
        Ok(_) => Err("the settings document is not a mapping".to_string()),
        Err(err) => Err(format!("could not parse the settings document: {err}")),
    }
}

fn is_blank_yaml(raw: &str) -> bool {
    raw.lines().all(|line| {
        let line = line.trim();
        line.is_empty() || line.starts_with('#')
    })
}

fn section_text(section: Option<&Value>) -> Result<String, String> {
    match section {
        None | Some(Value::Null) => Ok(String::new()),
        Some(Value::Mapping(section)) if section.is_empty() => Ok(String::new()),
        Some(section @ Value::Mapping(_)) => serde_yaml::to_string(section)
            .map_err(|err| format!("could not render the {SECTION_KEY} section: {err}")),
        Some(_) => Err(format!("the {SECTION_KEY} section is not a mapping")),
    }
}

/// Parse and check the section text the panel saves. `Ok(None)` means "no
/// routes": the text is empty or a bare `null`.
fn parse_section(yaml: &str) -> Result<Option<Mapping>, String> {
    if is_blank_yaml(yaml) {
        return Ok(None);
    }
    let section = match serde_yaml::from_str::<Value>(yaml) {
        Ok(Value::Null) => return Ok(None),
        Ok(Value::Mapping(section)) => section,
        Ok(_) => return Err("the routes must be a YAML mapping".to_string()),
        Err(err) => return Err(format!("not valid YAML: {err}")),
    };
    validate_section(&section)?;
    Ok(if section.is_empty() {
        None
    } else {
        Some(section)
    })
}

/// The checks that would otherwise fail silently or leak. Everything else —
/// protocol names, model capacities, headers — pi-ai validates itself and
/// reports when the session starts.
fn validate_section(section: &Mapping) -> Result<(), String> {
    let Some(providers) = section.get(PROVIDERS_KEY) else {
        return Ok(());
    };
    let providers = match providers {
        Value::Null => return Ok(()),
        Value::Mapping(providers) => providers,
        _ => return Err(format!("`{PROVIDERS_KEY}` must be a mapping of route ids")),
    };
    for (id, route) in providers {
        let Some(id) = id.as_str() else {
            return Err(format!(
                "every key under `{PROVIDERS_KEY}` must be a route id"
            ));
        };
        let route = match route {
            // A bare id enables a route pi-ai ships, with its defaults.
            Value::Null => continue,
            Value::Mapping(route) => route,
            _ => return Err(format!("route `{id}` must be a mapping")),
        };
        if route.contains_key("apiKey") {
            // The document is plaintext and shown in this very panel; the
            // adapter itself never writes a key into it.
            return Err(format!(
                "route `{id}` carries a plaintext `apiKey`: put the key in the \
                 environment variables box and name it with `apiKeyEnv`"
            ));
        }
        if let Some(env) = route.get("apiKeyEnv") {
            if env.as_str().is_none_or(|env| env.trim().is_empty()) {
                return Err(format!(
                    "route `{id}`: `apiKeyEnv` must name an environment variable"
                ));
            }
        }
        match route.get("models") {
            None | Some(Value::Null) => {}
            Some(Value::Sequence(models)) => {
                for model in models {
                    let has_id = model
                        .as_mapping()
                        .and_then(|model| model.get("id"))
                        .and_then(Value::as_str)
                        .is_some_and(|id| !id.trim().is_empty());
                    if !has_id {
                        return Err(format!("route `{id}`: every model needs an `id`"));
                    }
                }
            }
            Some(_) => return Err(format!("route `{id}`: `models` must be a list")),
        }
    }
    Ok(())
}

/// Store (or clear) the extra routes. Empty text removes the section.
pub fn update_deepseek_routes_core(yaml: &str, emitter: &EventEmitter) -> Result<(), AcpError> {
    let home = crate::parsers::deepseek::resolve_dsh_home_dir();
    update_deepseek_routes_at(
        &own_document_path(&home),
        &legacy_document_paths(&home),
        yaml,
    )?;
    emit_acp_agents_updated(emitter, "config_updated", Some(AgentType::DeepSeek));
    Ok(())
}

fn update_deepseek_routes_at(path: &Path, legacy: &[PathBuf], yaml: &str) -> Result<(), AcpError> {
    let section = parse_section(yaml)
        .map_err(|message| AcpError::protocol(format!("invalid DeepSeek routes: {message}")))?;

    // Read immediately before writing: the document is shared with the adapter
    // (and with a hand editor), so the merge is against what is on disk now.
    let existing = match fs::read_to_string(path) {
        Ok(existing) => Some(existing),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => None,
        Err(err) => {
            return Err(AcpError::protocol(format!(
                "could not read the DeepSeek settings document: {err}"
            )))
        }
    };

    let mut document = match &existing {
        Some(raw) => parse_document(raw)
            .map_err(|message| AcpError::protocol(format!("DeepSeek settings: {message}")))?,
        None => Mapping::new(),
    };

    match section {
        Some(section) => {
            document.insert(SECTION_KEY.into(), Value::Mapping(section));
        }
        None => {
            document.shift_remove(SECTION_KEY);
            // Nothing stored and nothing imported: there is nothing to clear.
            // With an imported section, the (empty) document still has to be
            // created — while it is missing, sessions keep importing the old
            // routes, which is not what clearing them asks for.
            if existing.is_none() && read_legacy_section(legacy).is_none() {
                return Ok(());
            }
        }
    }

    let body = serde_yaml::to_string(&Value::Mapping(document)).map_err(|err| {
        AcpError::protocol(format!("could not render the DeepSeek settings: {err}"))
    })?;
    if existing.as_deref() == Some(body.as_str()) {
        return Ok(());
    }
    write_settings_document(path, &body)
}

/// The file a write to `path` should actually land on.
///
/// `canonicalize` answers it whenever the document exists. It does NOT when the
/// path is a symlink whose target has not been created yet — a dotfiles
/// checkout that links `~/.dsh/settings.yaml` at a file it will write later —
/// and there the link must still be followed: an `open(O_CREAT)` (what this
/// used to do) creates the TARGET, so replacing the link instead would quietly
/// break the setup on the first save.
///
/// The walk stops at the first hop that is not a symlink (existing or not) and
/// FAILS rather than returning one that still is: the caller renames over what
/// this returns, so a chain longer than the bound — or a cycle, which is the
/// same thing here — would otherwise clobber an intermediate link, possibly one
/// outside the harness home entirely.
fn resolve_write_target(path: &Path) -> Result<PathBuf, std::io::Error> {
    /// Whether the chain ends here: nothing at this path (the file to create),
    /// or something that is not a link. An unreadable parent is neither — it is
    /// an error to report rather than a file to create.
    fn is_end_of_chain(candidate: &Path) -> Result<bool, std::io::Error> {
        match fs::symlink_metadata(candidate) {
            Ok(meta) => Ok(!meta.file_type().is_symlink()),
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(true),
            Err(err) => Err(err),
        }
    }

    if let Ok(resolved) = fs::canonicalize(path) {
        return Ok(resolved);
    }
    // The OS gives up around 32–40 hops; a settings document behind more than a
    // handful of DANGLING links is not a setup to guess at.
    let mut current = path.to_path_buf();
    for _ in 0..8 {
        if is_end_of_chain(&current)? {
            return Ok(current);
        }
        let link = fs::read_link(&current)?;
        current = if link.is_absolute() {
            link
        } else {
            // A relative link resolves against the directory holding the link.
            current
                .parent()
                .map(|parent| parent.join(&link))
                .unwrap_or(link)
        };
        // The target may itself exist (only the last hop was dangling).
        if let Ok(resolved) = fs::canonicalize(&current) {
            return Ok(resolved);
        }
    }
    // Where the last hop landed is a candidate too — a chain that spends the
    // whole budget and then names a file to create is still followable.
    if is_end_of_chain(&current)? {
        return Ok(current);
    }
    Err(std::io::Error::other(format!(
        "{} is behind too many symbolic links",
        path.display()
    )))
}

/// Write the settings document the way the harness' own provider writes it:
/// into a sibling temporary file that is then renamed over the target, under a
/// `0700` parent, owner-only.
///
/// The atomic swap is not decoration. This document is the USER's and can hold
/// any other plugin's section; a plain `fs::write` truncates first, so a full
/// disk, an I/O error or a crash mid-write would leave everyone's settings
/// half-written. `dsh-settings-file` writes it through `writeFileAtomic`
/// (`{mode: 0o600, dirMode: 0o700}`) for exactly that reason, so a rename is
/// also what the file's own owner does to it.
///
/// Three consequences of the swap, all deliberate:
/// * A symlinked document keeps its indirection — [`resolve_write_target`]
///   follows the link first, so the temporary lands beside the REAL file and
///   replaces that.
/// * A hard link to the document is left pointing at the old content (the same
///   is true of the harness' own writes).
/// * On Windows, a rename over a file another process holds open without
///   `FILE_SHARE_DELETE` fails. That surfaces as a save error naming the file,
///   which is the honest outcome — and still better than the truncate-first
///   write it replaces, which could leave the document half-written.
///
/// Mode: an existing document keeps its own, minus any world bits (a
/// deliberately group-shared `0640` survives; a `0644` is repaired). A fresh
/// one is `0600` — it is created by codeg, so its mode is codeg's
/// responsibility, and under the usual `022` umask it would otherwise be
/// readable by every local user.
fn write_settings_document(path: &Path, body: &str) -> Result<(), AcpError> {
    let io_err = |what: &str, err: std::io::Error| {
        AcpError::protocol(format!("could not {what} the DeepSeek settings: {err}"))
    };

    // Follow a symlink to the file it names, so the rename replaces the real
    // document rather than the link.
    let target = resolve_write_target(path).map_err(|err| io_err("resolve the path of", err))?;

    if let Some(parent) = target.parent() {
        if !parent.exists() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt as _;
                fs::DirBuilder::new()
                    .recursive(true)
                    .mode(0o700)
                    .create(parent)
                    .map_err(|err| io_err("create the harness home for", err))?;
            }
            #[cfg(not(unix))]
            fs::create_dir_all(parent).map_err(|err| io_err("create the harness home for", err))?;
        }
    }

    let parent = target.parent().unwrap_or_else(|| Path::new("."));
    let stem = target
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("settings.yaml");

    // The mode the swapped-in file must end up with: an existing document keeps
    // its own minus any world bits, a fresh one is owner-only.
    #[cfg(unix)]
    let mode = {
        use std::os::unix::fs::PermissionsExt as _;
        fs::metadata(&target)
            .map(|meta| meta.permissions().mode() & 0o777 & !0o007)
            .unwrap_or(0o600)
    };

    let (temp, mut file) = create_temp_file(
        parent,
        stem,
        #[cfg(unix)]
        mode,
    )
    .map_err(|err| io_err("create a temporary file for", err))?;

    let mut write_temp = || -> Result<(), std::io::Error> {
        use std::io::Write as _;
        file.write_all(body.as_bytes())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt as _;
            // `OpenOptions::mode` is masked by the umask, so a group-shared
            // document would come back tightened without this.
            fs::set_permissions(&temp, fs::Permissions::from_mode(mode))?;
        }
        // Flush before the swap: a rename can otherwise be durable while the
        // bytes it points at are not.
        file.sync_all()
    };

    if let Err(err) = write_temp() {
        let _ = fs::remove_file(&temp);
        return Err(io_err("write", err));
    }
    if let Err(err) = fs::rename(&temp, &target) {
        let _ = fs::remove_file(&temp);
        return Err(io_err("store", err));
    }

    Ok(())
}

/// Create the temporary file the new document is staged in, beside `target`.
///
/// Beside it, because a rename is only atomic within one filesystem and the
/// system temp dir routinely is a different one.
///
/// The name is unique per CALL, not per process, and the file is created with
/// `create_new`: two saves racing (two windows, or two HTTP requests in the
/// server build) would otherwise stage into one file and rename a document
/// spliced together from both. `create_new` also means a stale temp left by a
/// killed run is never written through — its name is retried instead.
fn create_temp_file(
    parent: &Path,
    stem: &str,
    #[cfg(unix)] mode: u32,
) -> Result<(PathBuf, fs::File), std::io::Error> {
    use std::sync::atomic::{AtomicU64, Ordering};
    static SEQUENCE: AtomicU64 = AtomicU64::new(0);

    let mut last = None;
    for _ in 0..8 {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|since| since.as_nanos())
            .unwrap_or_default();
        let seq = SEQUENCE.fetch_add(1, Ordering::Relaxed);
        let temp = parent.join(format!(
            ".{stem}.codeg-{}-{seq}-{nonce}.tmp",
            std::process::id()
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt as _;
            options.mode(mode);
        }
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists => last = Some(err),
            Err(err) => return Err(err),
        }
    }
    Err(last.unwrap_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "no free temporary file name",
        )
    }))
}

/// Read the DeepSeek extra model routes for the settings panel. Desktop
/// command; the web handler calls [`load_deepseek_routes_core`] directly.
/// Reads the filesystem only — no DB/state needed.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_load_deepseek_routes() -> Result<DeepSeekRoutes, AcpError> {
    Ok(load_deepseek_routes_core())
}

/// Store (or clear) the DeepSeek extra model routes. Desktop command; the web
/// handler calls [`update_deepseek_routes_core`] directly.
#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn acp_update_deepseek_routes(
    yaml: String,
    app: tauri::AppHandle,
) -> Result<(), AcpError> {
    let emitter = EventEmitter::from_app(&app);
    update_deepseek_routes_core(&yaml, &emitter)
}

#[cfg(test)]
mod tests {
    use super::*;

    const GATEWAY: &str = "providers:
  gw:
    api: openai-responses
    baseURL: https://gw.example.com/v1
    apiKeyEnv: GW_API_KEY
    models:
      - id: gw-large
        contextWindow: 200000
";

    /// A one-route section whose model id is `id`, for the write-path tests.
    fn route(id: &str) -> String {
        format!("providers:\n  gw:\n    api: openai-responses\n    models:\n      - id: {id}\n")
    }

    fn save(path: &Path, id: &str) -> Result<(), AcpError> {
        update_deepseek_routes_at(path, &[], &route(id))
    }

    fn section_of(path: &Path) -> Value {
        let raw = fs::read_to_string(path).expect("read");
        parse_document(&raw)
            .expect("parse")
            .get(SECTION_KEY)
            .cloned()
            .unwrap_or(Value::Null)
    }

    #[test]
    fn the_document_lives_beside_upstreams_not_in_it() {
        // Upstream's 0.2 CLI renames `$DSH_HOME/settings.yaml` away on start,
        // so the adapter's own document must not be that file.
        let home = Path::new("/h/.dsh");
        assert_eq!(
            own_document_path(home),
            Path::new("/h/.dsh/deepseek-acp/settings.yaml")
        );
        assert_eq!(
            legacy_document_paths(home),
            vec![
                PathBuf::from("/h/.dsh/settings.yaml"),
                PathBuf::from("/h/.dsh/settings.yaml.imported"),
            ]
        );
    }

    #[test]
    fn load_reports_missing_stored_and_unusable_documents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.yaml");

        let missing = load_deepseek_routes_at(&path, &[]);
        assert!(!missing.exists);
        assert!(missing.yaml.is_empty());
        assert!(missing.error.is_none());

        let stored_doc = "other: 1
llm-pi-ai:
  providers:
    gw:
      api: openai-responses
      models:
        - id: gw-large
";
        fs::write(&path, stored_doc).expect("seed");
        let stored = load_deepseek_routes_at(&path, &[]);
        assert!(stored.exists);
        assert!(stored.error.is_none(), "{:?}", stored.error);
        assert!(stored.yaml.contains("gw-large"), "{}", stored.yaml);
        assert!(!stored.yaml.contains("other"), "{}", stored.yaml);

        fs::write(&path, "llm-pi-ai: [1, 2]\n").expect("seed");
        assert!(load_deepseek_routes_at(&path, &[]).error.is_some());
        fs::write(&path, "llm-pi-ai: {\n").expect("seed");
        assert!(load_deepseek_routes_at(&path, &[]).error.is_some());

        // Empty and comment-only documents hold no routes, they are not broken.
        fs::write(&path, "# nothing yet\n").expect("seed");
        let blank = load_deepseek_routes_at(&path, &[]);
        assert!(blank.error.is_none());
        assert!(blank.yaml.is_empty());
    }

    #[test]
    fn load_shows_what_sessions_import_while_the_own_document_is_missing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let own = dir.path().join("deepseek-acp").join("settings.yaml");
        let old = dir.path().join("settings.yaml");
        let moved = dir.path().join("settings.yaml.imported");
        let legacy = vec![old.clone(), moved.clone()];

        // The first old document without the section is passed over, and an
        // unparsable one is skipped rather than reported: it is not ours.
        fs::write(&old, "llm-deepseek:\n  models: []\n").expect("seed old");
        fs::write(
            &moved,
            "llm-pi-ai:\n  providers:\n    azure-openai-responses:\n      apiKeyEnv: AZ\n",
        )
        .expect("seed moved");
        let imported = load_deepseek_routes_at(&own, &legacy);
        assert!(!imported.exists);
        assert_eq!(
            imported.imported_from.as_deref(),
            Some(moved.to_str().unwrap())
        );
        // Renamed the way the adapter renames it on import.
        assert!(imported.yaml.contains("azure:"), "{}", imported.yaml);
        assert!(!imported.yaml.contains("azure-openai-responses"));

        fs::write(&old, "llm-pi-ai: {\n").expect("seed broken");
        assert_eq!(
            load_deepseek_routes_at(&own, &legacy)
                .imported_from
                .as_deref(),
            Some(moved.to_str().unwrap())
        );

        // Once the own document exists, the old ones are no longer read.
        fs::create_dir_all(own.parent().unwrap()).expect("mkdir");
        fs::write(&own, "{}\n").expect("seed own");
        let own_wins = load_deepseek_routes_at(&own, &legacy);
        assert!(own_wins.exists);
        assert!(own_wins.imported_from.is_none());
        assert!(own_wins.yaml.is_empty());
    }

    #[test]
    fn validation_refuses_only_what_would_fail_silently_or_leak() {
        assert!(parse_section(GATEWAY).expect("gateway").is_some());
        // A bare id enables a route pi-ai ships with its defaults.
        assert!(parse_section("providers:\n  openai:\n").is_ok());
        // Fields this module does not know are pi-ai's to judge.
        assert!(parse_section("retryPolicy: {mode: normal}\nproviders: {}\n").is_ok());

        for (bad, needle) in [
            ("- a\n", "mapping"),
            ("providers: [gw]\n", "providers"),
            ("providers:\n  gw: 1\n", "gw"),
            ("providers:\n  gw:\n    apiKey: sk-live\n", "apiKeyEnv"),
            ("providers:\n  gw:\n    apiKeyEnv: ''\n", "apiKeyEnv"),
            ("providers:\n  gw:\n    models: gw-large\n", "list"),
            ("providers:\n  gw:\n    models:\n      - name: x\n", "id"),
            ("providers: {\n", "YAML"),
        ] {
            let err = parse_section(bad).expect_err(bad);
            assert!(err.contains(needle), "{bad:?}: {err}");
        }
    }

    #[test]
    fn empty_text_means_no_routes() {
        for empty in ["", "  \n", "# just a comment\n", "null\n", "{}\n"] {
            assert!(parse_section(empty).expect(empty).is_none(), "{empty:?}");
        }
    }

    #[test]
    fn update_merges_into_the_document_and_keeps_other_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("deepseek-acp").join("settings.yaml");

        update_deepseek_routes_at(&path, &[], GATEWAY).expect("first write");
        assert!(section_of(&path).get(PROVIDERS_KEY).is_some());

        // A key the adapter (or a hand editor) added survives a save.
        let raw = fs::read_to_string(&path).expect("read");
        fs::write(&path, format!("future-key: kept\n{raw}")).expect("seed");
        save(&path, "b").expect("rewrite");
        let raw = fs::read_to_string(&path).expect("read");
        assert!(raw.contains("future-key: kept"), "{raw}");
        assert!(raw.contains("id: b"), "{raw}");

        // An invalid section never reaches the disk.
        let before = fs::read_to_string(&path).expect("read");
        let leak = update_deepseek_routes_at(&path, &[], "providers:\n  gw:\n    apiKey: sk\n");
        assert!(leak.is_err());
        assert_eq!(fs::read_to_string(&path).expect("read"), before);

        // Clearing removes the section and nothing else.
        update_deepseek_routes_at(&path, &[], "").expect("clear");
        assert!(section_of(&path).is_null());
        assert!(fs::read_to_string(&path)
            .expect("read")
            .contains("future-key"));
    }

    #[test]
    fn update_refuses_to_overwrite_a_document_it_cannot_parse() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.yaml");
        fs::write(&path, "llm-pi-ai: {\n").expect("seed");
        assert!(save(&path, "a").is_err());
        assert_eq!(fs::read_to_string(&path).expect("read"), "llm-pi-ai: {\n");
    }

    #[test]
    fn clearing_imported_routes_creates_the_own_document() {
        // While the own document is missing, sessions keep importing the old
        // routes; clearing them has to stop that, so it writes an empty one.
        let dir = tempfile::tempdir().expect("tempdir");
        let own = dir.path().join("deepseek-acp").join("settings.yaml");
        let old = dir.path().join("settings.yaml");
        fs::write(&old, format!("{SECTION_KEY}:\n  providers:\n    openai:\n")).expect("seed");
        let legacy = vec![old.clone()];

        update_deepseek_routes_at(&own, &legacy, "").expect("clear");
        assert!(own.exists());
        assert!(section_of(&own).is_null());
        let reloaded = load_deepseek_routes_at(&own, &legacy);
        assert!(reloaded.yaml.is_empty());
        assert!(reloaded.imported_from.is_none());
        // The old document is never written.
        assert!(fs::read_to_string(&old).expect("old").contains("openai"));

        // Without anything to import, clearing a missing document is a no-op.
        let dir = tempfile::tempdir().expect("tempdir");
        let own = dir.path().join("deepseek-acp").join("settings.yaml");
        update_deepseek_routes_at(&own, &[], "").expect("clear");
        assert!(!own.exists());
        assert!(!dir.path().join("deepseek-acp").exists());
    }

    #[test]
    fn the_swap_leaves_no_temporary_file_behind() {
        // The swap stages in a sibling temp; a completed save must not leave it
        // in `$DSH_HOME` for the user (or a backup) to find.
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("settings.yaml");
        save(&path, "a").expect("write");
        save(&path, "b").expect("rewrite");
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| name != "settings.yaml")
            .collect();
        assert!(leftovers.is_empty(), "left behind {leftovers:?}");
    }

    #[test]
    fn two_saves_never_stage_into_the_same_temporary_file() {
        // Two windows saving at once would otherwise interleave their bytes in
        // one shared temp and rename a document spliced from both.
        let dir = tempfile::tempdir().expect("tempdir");
        let (first_path, first) = create_temp_file(
            dir.path(),
            "settings.yaml",
            #[cfg(unix)]
            0o600,
        )
        .expect("first temp");
        let (second_path, second) = create_temp_file(
            dir.path(),
            "settings.yaml",
            #[cfg(unix)]
            0o600,
        )
        .expect("second temp");
        assert_ne!(first_path, second_path);
        drop(first);
        drop(second);

        // A stale temp from a killed run is never written through either: the
        // name is simply retried.
        let stale = first_path.clone();
        let (fresh, _file) = create_temp_file(
            dir.path(),
            "settings.yaml",
            #[cfg(unix)]
            0o600,
        )
        .expect("third temp");
        assert_ne!(fresh, stale);
        assert!(fs::read_to_string(&stale).expect("stale kept").is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn writes_through_a_symlinked_document_instead_of_replacing_it() {
        // A settings.yaml symlinked elsewhere (a dotfiles checkout) must keep
        // its indirection: the rename lands on the resolved target.
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("real-settings.yaml");
        let link = dir.path().join("settings.yaml");
        fs::write(&real, "other:\n  keep: me\n").expect("seed");
        std::os::unix::fs::symlink(&real, &link).expect("symlink");

        save(&link, "a").expect("write");

        assert!(
            fs::symlink_metadata(&link)
                .expect("link")
                .file_type()
                .is_symlink(),
            "the symlink was replaced by a regular file"
        );
        let written = fs::read_to_string(&real).expect("target");
        assert!(written.contains("id: a"), "{written}");
        assert!(written.contains("keep: me"), "{written}");
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_target_of_a_symlink_whose_file_does_not_exist_yet() {
        // A dotfiles checkout can link settings.yaml at a file it has not
        // written yet. The old in-place `open(O_CREAT)` created the target;
        // replacing the link instead would quietly break the setup.
        let dir = tempfile::tempdir().expect("tempdir");
        let real = dir.path().join("store").join("real-settings.yaml");
        fs::create_dir_all(real.parent().expect("parent")).expect("mkdir");
        let link = dir.path().join("settings.yaml");
        // Relative link: it must resolve against the directory holding it.
        std::os::unix::fs::symlink("store/real-settings.yaml", &link).expect("symlink");

        save(&link, "a").expect("write");

        assert!(
            fs::symlink_metadata(&link)
                .expect("link")
                .file_type()
                .is_symlink(),
            "the dangling symlink was replaced by a regular file"
        );
        assert!(fs::read_to_string(&real).expect("target").contains("id: a"));
    }

    #[cfg(unix)]
    #[test]
    fn follows_a_dangling_chain_that_spends_the_whole_hop_budget() {
        // Exactly as many links as the walk will follow, ending at a file that
        // does not exist yet: the last hop is the file to create, not a chain
        // to give up on.
        let dir = tempfile::tempdir().expect("tempdir");
        let head = dir.path().join("settings.yaml");
        let final_target = dir.path().join("new-settings.yaml");
        let hops: Vec<PathBuf> = (1..8).map(|i| dir.path().join(format!("l{i}"))).collect();
        std::os::unix::fs::symlink(&hops[0], &head).expect("head");
        for pair in hops.windows(2) {
            std::os::unix::fs::symlink(&pair[1], &pair[0]).expect("hop");
        }
        std::os::unix::fs::symlink(&final_target, hops.last().expect("last")).expect("tail");

        save(&head, "a").expect("write");
        assert!(fs::read_to_string(&final_target)
            .expect("target")
            .contains("id: a"));
        assert!(fs::symlink_metadata(&head)
            .expect("head")
            .file_type()
            .is_symlink());
    }

    #[cfg(unix)]
    #[test]
    fn refuses_a_symlink_chain_it_cannot_follow_to_the_end() {
        // The caller renames over whatever the walk returns, so giving up on a
        // long chain (or a cycle) must not mean "rename over the link I stopped
        // at" — that link can live anywhere, including outside the harness home.
        let dir = tempfile::tempdir().expect("tempdir");
        let head = dir.path().join("settings.yaml");
        // A cycle: settings.yaml -> loop-a -> loop-b -> loop-a -> …
        let a = dir.path().join("loop-a");
        let b = dir.path().join("loop-b");
        std::os::unix::fs::symlink(&a, &head).expect("head");
        std::os::unix::fs::symlink(&b, &a).expect("a");
        std::os::unix::fs::symlink(&a, &b).expect("b");

        assert!(resolve_write_target(&head).is_err());
        assert!(save(&head, "a").is_err());
        // Every link in the cycle is still a link, and nothing was created.
        for link in [&head, &a, &b] {
            assert!(fs::symlink_metadata(link)
                .expect("link")
                .file_type()
                .is_symlink());
        }
        let created: Vec<_> = fs::read_dir(dir.path())
            .expect("read dir")
            .filter_map(Result::ok)
            .map(|entry| entry.file_name().to_string_lossy().to_string())
            .filter(|name| !matches!(name.as_str(), "settings.yaml" | "loop-a" | "loop-b"))
            .collect();
        assert!(created.is_empty(), "left behind {created:?}");
    }

    #[cfg(unix)]
    #[test]
    fn creates_the_document_owner_only_under_an_owner_only_home() {
        use std::os::unix::fs::PermissionsExt as _;
        let dir = tempfile::tempdir().expect("tempdir");
        let home = dir.path().join("dsh-home");
        let path = home.join("settings.yaml");

        save(&path, "a").expect("write");
        assert_eq!(
            fs::metadata(&home).expect("home").permissions().mode() & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(&path).expect("file").permissions().mode() & 0o777,
            0o600
        );

        // An existing world-readable document is repaired on the next write,
        // but a deliberately group-shared one is left alone.
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).expect("chmod");
        save(&path, "b").expect("rewrite");
        assert_eq!(
            fs::metadata(&path).expect("file").permissions().mode() & 0o007,
            0
        );
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).expect("chmod");
        save(&path, "c").expect("rewrite");
        assert_eq!(
            fs::metadata(&path).expect("file").permissions().mode() & 0o777,
            0o640
        );
    }
}
