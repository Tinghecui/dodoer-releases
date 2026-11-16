//! Where credentials live. Windows and Linux desktop builds use the OS keyring;
//! codeg-server and the macOS desktop app use the 0600 `tokens.json` beside the
//! database (`CODEG_DATA_DIR`, which the desktop app exports at the top of
//! `run()`).
//!
//! Why not the macOS keychain: an item's partition list names the apps that
//! may read it without asking, by Apple team id when the app has one and by
//! cdhash when it does not. dodoer is signed with a self-signed certificate (no
//! team id), so every update is a new cdhash and the user is asked for their
//! login password again. The cost: any program running as this user can read
//! the file without a prompt, as on a server.
//! Entries an older version put in the keychain are copied over on first read,
//! once each (see [`get_or_migrate_at`]).

#[cfg(feature = "tauri-runtime")]
const SERVICE_NAME: &str = "codeg";

/// Whether this build carries entries over from the macOS keychain.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
const FROM_KEYCHAIN: bool = cfg!(all(feature = "tauri-runtime", target_os = "macos"));

fn token_key(account_id: &str) -> String {
    format!("github-token:{}", account_id)
}

fn channel_token_key(channel_id: i32) -> String {
    format!("chat-channel:{}", channel_id)
}

/// Namespace for secrets that are not tokens of an account or a channel. The
/// prefix keeps them from ever colliding with a `github-token:<id>` whose id
/// happens to look like a secret name.
fn secret_key(name: &str) -> String {
    format!("secret:{}", name)
}

// ── Windows / Linux desktop: OS keyring ──

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn set_token(account_id: &str, token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("keyring set error: {e}"))
}

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn get_token(account_id: &str) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &token_key(account_id)).ok()?;
    entry.get_password().ok()
}

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn delete_token(account_id: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &token_key(account_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

// ── Server and macOS desktop: file-based token store ──

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn tokens_file_path() -> std::path::PathBuf {
    tokens_file_path_for(std::env::var("CODEG_DATA_DIR").ok().as_deref())
}

/// Resolve the on-disk `tokens.json` path given an explicit
/// `CODEG_DATA_DIR` value (or `None` to fall back to the platform
/// default). Always returns an absolute path so subprocess credential
/// helpers — which inherit our env but run in git's CWD, not ours —
/// don't end up looking for `tokens.json` in the user's repo. Factored
/// out so tests can exercise path resolution without poking at process
/// env state.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn tokens_file_path_for(env_value: Option<&str>) -> std::path::PathBuf {
    let dir = env_value.map(std::path::PathBuf::from).unwrap_or_else(|| {
        dirs::data_dir()
            .map(|d| d.join("codeg"))
            .unwrap_or_else(|| std::path::PathBuf::from(".codeg-data"))
    });
    crate::git_credential::absolutize(&dir).join("tokens.json")
}

/// Read the token map, first tightening a pre-existing file to `0600`.
/// Stores written before the permission hardening landed sit at the umask
/// default (usually 0644) inside a bind-mounted `/data` volume; tightening on
/// every read is idempotent and cheap, and doing it BEFORE the read means no
/// code path ever handles token bytes from a world-readable file it could have
/// fixed. Best-effort: if chmod fails the read will usually fail too, and a
/// read-only mount is not made worse by proceeding.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn read_tokens_at(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    read_tokens_at_checked(path).unwrap_or_default()
}

/// The same read, but an unreadable or corrupt store is an error rather than an
/// empty map. Callers that WRITE secrets back need the distinction: "there is no
/// entry" and "the file would not open" lead to opposite decisions on the way
/// out — write nothing, versus refuse to write at all — and collapsing them
/// turns a transient read failure into a permanent deletion.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn read_tokens_at_checked(
    path: &std::path::Path,
) -> Result<std::collections::HashMap<String, String>, String> {
    #[cfg(unix)]
    if path.exists() {
        use std::os::unix::fs::PermissionsExt;
        if let Err(err) =
            std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))
        {
            // Keep reading (a read-only mount is not made worse), but make the
            // failed hardening observable instead of silently world-readable.
            tracing::warn!(
                "[tokens] could not tighten {} to 0600: {err}",
                path.display()
            );
        }
    }
    match std::fs::read_to_string(path) {
        Ok(raw) => serde_json::from_str(&raw)
            .map_err(|e| format!("token store is not readable JSON: {e}")),
        // A store that was never written is legitimately empty.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(std::collections::HashMap::new())
        }
        Err(err) => Err(format!("token store read error: {err}")),
    }
}

/// Persist the token map without ever exposing a wide-permission file, even
/// transiently. A plain `fs::write` + chmod leaves a window (and a permanent
/// 0644 file if the process dies between the two), so on Unix the content goes
/// into a same-directory temp file created with mode `0600`, is fsynced, and
/// then atomically renamed over the store. The explicit `set_permissions`
/// after creation pins the bits exactly even under an exotic umask (umask can
/// only clear bits at open time; chmod is not masked).
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn write_tokens_at(
    path: &std::path::Path,
    tokens: &std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| "token store path has no parent directory".to_string())?;
    std::fs::create_dir_all(parent)
        .map_err(|e| format!("failed to create token store directory: {e}"))?;
    let json = serde_json::to_string_pretty(tokens)
        .map_err(|e| format!("failed to serialize tokens: {e}"))?;

    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        use std::sync::atomic::{AtomicU64, Ordering};
        static TMP_SEQ: AtomicU64 = AtomicU64::new(0);
        let tmp = parent.join(format!(
            ".tokens.json.tmp-{}-{}",
            std::process::id(),
            TMP_SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("failed to create token store temp file: {e}"))?;
        let write_result = file
            .write_all(json.as_bytes())
            .and_then(|()| file.set_permissions(std::fs::Permissions::from_mode(0o600)))
            .and_then(|()| file.sync_all())
            .map_err(|e| format!("failed to write token store: {e}"))
            .and_then(|()| {
                std::fs::rename(&tmp, path)
                    .map_err(|e| format!("failed to persist token store: {e}"))
            });
        if write_result.is_err() {
            let _ = std::fs::remove_file(&tmp);
        }
        write_result
    }

    #[cfg(not(unix))]
    {
        // Non-Unix server builds are outside the supported surface; keep the
        // plain write rather than pretending NTFS ACL hardening exists here.
        std::fs::write(path, json).map_err(|e| format!("failed to write token store: {e}"))
    }
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
type KeychainRead<'a> = &'a dyn Fn(&str) -> Result<Option<String>, String>;

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn keychain_migrated_key(key: &str) -> String {
    format!("keychain-migrated:{key}")
}

/// Read one entry. When `legacy` is given (the macOS desktop app) and the file
/// has never held this entry, ask the old keychain item once and copy what it
/// returns into the file, together with a `keychain-migrated:<key>` marker, so
/// the keychain is asked at most once per entry (once more after a denied
/// prompt, which is an error and leaves no marker). The marker outlives
/// [`delete_at`], so a deleted token is not brought back from the keychain
/// copy we leave behind (deleting it would be one more password prompt).
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn get_or_migrate_at(
    path: &std::path::Path,
    key: &str,
    legacy: Option<KeychainRead<'_>>,
) -> Result<Option<String>, String> {
    let tokens = read_tokens_at_checked(path)?;
    if let Some(value) = tokens.get(key) {
        return Ok(Some(value.clone()));
    }
    let Some(legacy) = legacy else {
        return Ok(None);
    };
    let marker = keychain_migrated_key(key);
    // What the file already says about `key`, if anything: its value, or that
    // it was migrated (or set, or deleted) and is absent.
    let settled = |tokens: &std::collections::HashMap<String, String>| match tokens.get(key) {
        Some(value) => Some(Some(value.clone())),
        None => tokens.contains_key(&marker).then_some(None),
    };
    if let Some(known) = settled(&tokens) {
        return Ok(known);
    }
    // One keychain prompt at a time in this process: a thread that waited here
    // finds the other's result in the file instead of prompting again.
    static MIGRATING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = MIGRATING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(known) = settled(&read_tokens_at_checked(path)?) {
        return Ok(known);
    }
    let found = legacy(key)?;
    // The prompt may have waited minutes for the user. Start again from the
    // file as it is now, so that what other threads and the git credential
    // helper wrote meanwhile survives, and a set or delete of this very key
    // made meanwhile wins over the keychain copy.
    let mut tokens = match read_tokens_at_checked(path) {
        Ok(tokens) => tokens,
        Err(err) => {
            tracing::warn!("[tokens] could not save {key} taken from the keychain: {err}");
            return Ok(found);
        }
    };
    if let Some(known) = settled(&tokens) {
        return Ok(known);
    }
    if let Some(value) = &found {
        tokens.insert(key.to_string(), value.clone());
    }
    tokens.insert(marker, "1".to_string());
    if let Err(err) = write_tokens_at(path, &tokens) {
        // The value is still good for this call; the next read asks again.
        tracing::warn!("[tokens] could not save {key} taken from the keychain: {err}");
    }
    Ok(found)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn set_at(
    path: &std::path::Path,
    key: &str,
    value: &str,
    from_keychain: bool,
) -> Result<(), String> {
    let mut tokens = read_tokens_at(path);
    tokens.insert(key.to_string(), value.to_string());
    if from_keychain {
        tokens.insert(keychain_migrated_key(key), "1".to_string());
    }
    write_tokens_at(path, &tokens)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn delete_at(path: &std::path::Path, key: &str, from_keychain: bool) -> Result<(), String> {
    let mut tokens = read_tokens_at(path);
    tokens.remove(key);
    if from_keychain {
        tokens.insert(keychain_migrated_key(key), "1".to_string());
    }
    write_tokens_at(path, &tokens)
}

/// The keychain item an older macOS build wrote under `key`.
#[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
fn keychain_get(key: &str) -> Result<Option<String>, String> {
    let entry =
        keyring::Entry::new(SERVICE_NAME, key).map_err(|e| format!("keyring init error: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get error: {e}")),
    }
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn file_get(key: &str) -> Result<Option<String>, String> {
    #[cfg(all(feature = "tauri-runtime", target_os = "macos"))]
    let legacy: Option<KeychainRead<'_>> = Some(&keychain_get);
    #[cfg(not(all(feature = "tauri-runtime", target_os = "macos")))]
    let legacy: Option<KeychainRead<'_>> = None;
    get_or_migrate_at(&tokens_file_path(), key, legacy)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn file_set(key: &str, value: &str) -> Result<(), String> {
    set_at(&tokens_file_path(), key, value, FROM_KEYCHAIN)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn file_delete(key: &str) -> Result<(), String> {
    delete_at(&tokens_file_path(), key, FROM_KEYCHAIN)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn set_token(account_id: &str, token: &str) -> Result<(), String> {
    file_set(&token_key(account_id), token)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn get_token(account_id: &str) -> Option<String> {
    file_get(&token_key(account_id)).ok().flatten()
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn delete_token(account_id: &str) -> Result<(), String> {
    file_delete(&token_key(account_id))
}

// ── Chat channel token helpers ──
// Reuse the same storage mechanism (keyring or file) with a different key prefix.

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn set_channel_token(channel_id: i32, token: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &channel_token_key(channel_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(token)
        .map_err(|e| format!("keyring set error: {e}"))
}

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn get_channel_token(channel_id: i32) -> Option<String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &channel_token_key(channel_id)).ok()?;
    entry.get_password().ok()
}

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn delete_channel_token(channel_id: i32) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &channel_token_key(channel_id))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn set_channel_token(channel_id: i32, token: &str) -> Result<(), String> {
    file_set(&channel_token_key(channel_id), token)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn get_channel_token(channel_id: i32) -> Option<String> {
    file_get(&channel_token_key(channel_id)).ok().flatten()
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn delete_channel_token(channel_id: i32) -> Result<(), String> {
    file_delete(&channel_token_key(channel_id))
}

// ── Named secrets ──
// Same storage as the tokens above (OS keyring on Windows/Linux desktop, the
// 0600 `tokens.json` on a server and on the macOS desktop), for credentials that belong to a feature rather
// than to an account: the config-sync WebDAV password and snapshot passphrase.

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &secret_key(name))
        .map_err(|e| format!("keyring init error: {e}"))?;
    entry
        .set_password(value)
        .map_err(|e| format!("keyring set error: {e}"))
}

/// `Ok(None)` is "nothing stored under that name"; `Err` is "the store would not
/// open". Unlike [`get_token`], which collapses both into `None`, a secret's
/// reader has to keep them apart: an empty value means "delete this entry" when
/// it travels back through [`set_secret`]/[`delete_secret`], so a denied
/// keychain prompt read as "absent" would erase the secret at the next save.
#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn get_secret(name: &str) -> Result<Option<String>, String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &secret_key(name))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(format!("keyring get error: {e}")),
    }
}

#[cfg(all(feature = "tauri-runtime", not(target_os = "macos")))]
pub fn delete_secret(name: &str) -> Result<(), String> {
    let entry = keyring::Entry::new(SERVICE_NAME, &secret_key(name))
        .map_err(|e| format!("keyring init error: {e}"))?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(format!("keyring delete error: {e}")),
    }
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn set_secret(name: &str, value: &str) -> Result<(), String> {
    file_set(&secret_key(name), value)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn get_secret(name: &str) -> Result<Option<String>, String> {
    file_get(&secret_key(name))
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
pub fn delete_secret(name: &str) -> Result<(), String> {
    file_delete(&secret_key(name))
}

#[cfg(all(test, any(not(feature = "tauri-runtime"), target_os = "macos")))]
mod tests {
    use super::*;

    #[test]
    fn test_tokens_file_path_absolutizes_relative_env() {
        // Regression: a relative `CODEG_DATA_DIR=data` previously made
        // `tokens.json` resolve against the helper subprocess's CWD (i.e.
        // git's repo dir), even after we'd absolutized the path used for
        // the database. The token store must always land on an absolute
        // path so DB lookup and token lookup point at the same root.
        let cwd = std::env::current_dir().expect("cwd");
        let resolved = tokens_file_path_for(Some("data"));
        assert!(
            resolved.is_absolute(),
            "tokens path must be absolute, got: {}",
            resolved.display()
        );
        assert_eq!(resolved, cwd.join("data").join("tokens.json"));
    }

    #[test]
    fn test_tokens_file_path_absolute_env_unchanged() {
        let data_dir = std::env::current_dir().expect("cwd").join("codeg-data");
        let data_dir_str = data_dir.to_string_lossy().to_string();
        let resolved = tokens_file_path_for(Some(&data_dir_str));
        assert_eq!(resolved, data_dir.join("tokens.json"));
    }

    #[test]
    fn test_tokens_file_path_default_when_unset() {
        // No env var → derived from `dirs::data_dir()` (always absolute on
        // every platform we ship to). Just verify we end at `tokens.json`
        // and that the result is absolute, not the literal default.
        let resolved = tokens_file_path_for(None);
        assert!(resolved.is_absolute());
        assert!(resolved.ends_with("tokens.json"));
    }

    #[cfg(unix)]
    fn mode_bits(path: &std::path::Path) -> u32 {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(path).expect("metadata").permissions().mode() & 0o777
    }

    /// A fresh store must be 0600 from its very first byte on disk — there is
    /// no window where a parallel reader could see a wide-permission file,
    /// because the temp file is created with the final mode and only then
    /// renamed into place.
    #[test]
    #[cfg(unix)]
    fn test_write_tokens_creates_0600() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let mut tokens = std::collections::HashMap::new();
        tokens.insert("github-token:a".to_string(), "secret".to_string());
        write_tokens_at(&path, &tokens).expect("write");
        assert_eq!(mode_bits(&path), 0o600);
        assert_eq!(read_tokens_at(&path).get("github-token:a").unwrap(), "secret");
        // No temp residue left behind.
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().starts_with(".tokens.json.tmp"))
            .collect();
        assert!(leftovers.is_empty(), "temp files must not survive a write");
    }

    /// Overwriting a legacy wide-permission store must end 0600: the rename
    /// replaces the inode, so the old 0644 bits die with the old file.
    #[test]
    #[cfg(unix)]
    fn test_write_tokens_replaces_legacy_wide_file_with_0600() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        std::fs::write(&path, "{}").expect("seed legacy file");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let mut tokens = std::collections::HashMap::new();
        tokens.insert("github-token:b".to_string(), "s2".to_string());
        write_tokens_at(&path, &tokens).expect("write");
        assert_eq!(mode_bits(&path), 0o600);
    }

    /// An entry the file never held is taken from the keychain once, then
    /// served from the file; the keychain is not asked again.
    #[test]
    fn test_get_or_migrate_copies_keychain_entry_once() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let asked = std::cell::Cell::new(0);
        let keychain = |key: &str| -> Result<Option<String>, String> {
            asked.set(asked.get() + 1);
            Ok((key == "secret:remote-workspace:k").then(|| "tok".to_string()))
        };
        let got = get_or_migrate_at(&path, "secret:remote-workspace:k", Some(&keychain));
        assert_eq!(got.unwrap().as_deref(), Some("tok"));
        let got = get_or_migrate_at(&path, "secret:remote-workspace:k", Some(&keychain));
        assert_eq!(got.unwrap().as_deref(), Some("tok"));
        assert_eq!(asked.get(), 1);
        // Absent from the keychain too: asked once, then remembered as absent.
        assert_eq!(
            get_or_migrate_at(&path, "github-token:x", Some(&keychain)).unwrap(),
            None
        );
        assert_eq!(
            get_or_migrate_at(&path, "github-token:x", Some(&keychain)).unwrap(),
            None
        );
        assert_eq!(asked.get(), 2);
    }

    /// A denied prompt is an error, not "absent": nothing is recorded, so the
    /// next read asks again instead of losing the token for good.
    #[test]
    fn test_get_or_migrate_denied_keychain_asks_again() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let denied = |_: &str| -> Result<Option<String>, String> {
            Err("keyring get error: denied".to_string())
        };
        assert!(get_or_migrate_at(&path, "secret:a", Some(&denied)).is_err());
        let allowed = |_: &str| -> Result<Option<String>, String> { Ok(Some("v".to_string())) };
        assert_eq!(
            get_or_migrate_at(&path, "secret:a", Some(&allowed))
                .unwrap()
                .as_deref(),
            Some("v")
        );
    }

    /// Deleting a migrated entry must not bring it back from the keychain copy.
    #[test]
    fn test_delete_does_not_resurrect_from_keychain() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let keychain = |_: &str| -> Result<Option<String>, String> { Ok(Some("old".to_string())) };
        assert!(get_or_migrate_at(&path, "github-token:a", Some(&keychain))
            .unwrap()
            .is_some());
        delete_at(&path, "github-token:a", true).expect("delete");
        assert_eq!(
            get_or_migrate_at(&path, "github-token:a", Some(&keychain)).unwrap(),
            None
        );
        // Set before any read: the keychain is never consulted for it.
        set_at(&path, "github-token:b", "new", true).expect("set");
        delete_at(&path, "github-token:b", true).expect("delete");
        assert_eq!(
            get_or_migrate_at(&path, "github-token:b", Some(&keychain)).unwrap(),
            None
        );
    }

    /// Writes made while the keychain prompt was open survive the migration's
    /// own write, and a delete of the same key made meanwhile wins.
    #[test]
    fn test_migration_keeps_writes_made_during_the_prompt() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let keychain = |_: &str| -> Result<Option<String>, String> {
            set_at(&path, "github-token:other", "fresh", true).expect("set other");
            Ok(Some("old".to_string()))
        };
        let got = get_or_migrate_at(&path, "github-token:a", Some(&keychain)).unwrap();
        assert_eq!(got.as_deref(), Some("old"));
        let tokens = read_tokens_at(&path);
        assert_eq!(tokens.get("github-token:other").unwrap(), "fresh");
        assert_eq!(tokens.get("github-token:a").unwrap(), "old");

        let deleting = |key: &str| -> Result<Option<String>, String> {
            delete_at(&path, key, true).expect("delete");
            Ok(Some("old".to_string()))
        };
        let got = get_or_migrate_at(&path, "github-token:b", Some(&deleting)).unwrap();
        assert_eq!(got, None);
        assert!(!read_tokens_at(&path).contains_key("github-token:b"));
    }

    /// Without a keychain (codeg-server) nothing but the entry itself is stored.
    #[test]
    fn test_server_store_has_no_markers() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        set_at(&path, "github-token:a", "t", false).expect("set");
        assert_eq!(
            get_or_migrate_at(&path, "github-token:z", None).unwrap(),
            None
        );
        delete_at(&path, "github-token:a", false).expect("delete");
        assert!(read_tokens_at(&path).is_empty());
    }

    /// Reading an existing legacy store tightens it to 0600 before the bytes
    /// are consumed, so a server that only ever reads (never re-saves) still
    /// heals the volume-mounted file.
    #[test]
    #[cfg(unix)]
    fn test_read_tokens_tightens_existing_file() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        std::fs::write(&path, r#"{"github-token:c":"s3"}"#).expect("seed");
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o644)).unwrap();
        let tokens = read_tokens_at(&path);
        assert_eq!(tokens.get("github-token:c").unwrap(), "s3");
        assert_eq!(mode_bits(&path), 0o600);
    }
}
