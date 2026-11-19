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

/// The read, with an unreadable store taken as empty. Tests only: every caller
/// that writes back goes through [`update_at`], which must tell them apart.
#[cfg(all(test, any(not(feature = "tauri-runtime"), target_os = "macos")))]
fn read_tokens_at(path: &std::path::Path) -> std::collections::HashMap<String, String> {
    read_tokens_at_checked(path).unwrap_or_default()
}

/// Read the token map, first tightening a pre-existing file to `0600`.
/// Stores written before the permission hardening landed sit at the umask
/// default (usually 0644) inside a bind-mounted `/data` volume; tightening on
/// every read is idempotent and cheap, and doing it BEFORE the read means no
/// code path ever handles token bytes from a world-readable file it could have
/// fixed. Best-effort: if chmod fails the read will usually fail too, and a
/// read-only mount is not made worse by proceeding.
///
/// An unreadable or corrupt store is an error rather than an empty map.
/// Callers that WRITE secrets back need the distinction: "there is no entry"
/// and "the file would not open" lead to opposite decisions on the way out —
/// write nothing, versus refuse to write at all — and collapsing them turns a
/// transient read failure into a permanent deletion.
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
        // An empty file (an older version wrote in place) holds nothing to
        // lose; refusing it would refuse every save from then on.
        Ok(raw) if raw.trim().is_empty() => Ok(std::collections::HashMap::new()),
        Ok(raw) => serde_json::from_str(&raw).map_err(|e| {
            format!(
                "token store {} is not readable JSON: {e}; fix or remove it",
                path.display()
            )
        }),
        // A store that was never written is legitimately empty.
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            Ok(std::collections::HashMap::new())
        }
        Err(err) => Err(format!("token store read error: {err}")),
    }
}

/// How long a save waits for another process to finish with the store.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
const STORE_LOCK_WAIT: std::time::Duration = std::time::Duration::from_secs(10);

/// The store held for one read → change → write: a lock in this process, and
/// one on `tokens.json.lock` beside the store for the other processes that
/// write the same file. On the macOS desktop those are the app (remote
/// workspace tokens, entries taken over from the keychain), its own daemon —
/// a `codeg-server` child on the same data directory (accounts, channel
/// tokens, config-sync secrets) — and the git credential helper the app
/// binary runs, which takes keychain entries over too. Without the locks two
/// saves at once each write back the map they read, without the other's
/// entry. Not `tokens.json` itself: every write renames a new file over it.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
struct StoreLock {
    // Declared first, so the file lock goes before the thread lock.
    _file: Option<std::fs::File>,
    _held: std::sync::MutexGuard<'static, ()>,
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
impl StoreLock {
    fn acquire(path: &std::path::Path) -> Result<Self, String> {
        use std::fs::TryLockError;
        use std::time::{Duration, Instant};
        static STORE: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let held = STORE.lock().unwrap_or_else(|e| e.into_inner());
        let file = match open_lock_file(path) {
            Ok(file) => file,
            Err(err) => {
                // A directory that takes no file fails the write that follows
                // too, which says why; this process is still serialised.
                tracing::warn!("[tokens] could not open the store's lock file: {err}");
                return Ok(Self {
                    _file: None,
                    _held: held,
                });
            }
        };
        let deadline = Instant::now() + STORE_LOCK_WAIT;
        loop {
            match file.try_lock() {
                Ok(()) => break,
                Err(TryLockError::WouldBlock) if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(TryLockError::WouldBlock) => {
                    return Err("another codeg process holds the token store".to_string());
                }
                Err(TryLockError::Error(err)) => {
                    // A file system without locks: this process is still
                    // serialised, as before there was a file lock at all.
                    tracing::warn!("[tokens] could not lock the store: {err}");
                    return Ok(Self {
                        _file: None,
                        _held: held,
                    });
                }
            }
        }
        Ok(Self {
            _file: Some(file),
            _held: held,
        })
    }
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn open_lock_file(path: &std::path::Path) -> std::io::Result<std::fs::File> {
    let mut name = path
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_else(|| "tokens.json".into());
    name.push(".lock");
    let lock_path = path.with_file_name(name);
    if let Some(parent) = lock_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(lock_path)
}

/// Read, change and write the store as one step, under [`StoreLock`]. The
/// read is the checked one: a corrupt or unreadable store read as empty would
/// be written back holding only this change, deleting every other token.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn update_at(
    path: &std::path::Path,
    change: impl FnOnce(&mut std::collections::HashMap<String, String>),
) -> Result<(), String> {
    let _store = StoreLock::acquire(path)?;
    let mut tokens = read_tokens_at_checked(path)?;
    change(&mut tokens);
    write_tokens_at(path, &tokens)
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

/// Keys whose keychain read failed in this process (the user denied the
/// prompt), with the error it gave. Memory only, never written to the file:
/// the next launch asks once more, so a mistaken "Deny" does not lose the
/// token for good.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
type DeniedReads = std::sync::Mutex<std::collections::HashMap<String, String>>;

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
static DENIED: std::sync::LazyLock<DeniedReads> = std::sync::LazyLock::new(Default::default);

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn denied_error(denied: &DeniedReads, key: &str) -> Option<String> {
    denied
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(key)
        .cloned()
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn keychain_migrated_key(key: &str) -> String {
    format!("keychain-migrated:{key}")
}

/// Read one entry. When `legacy` is given (the macOS desktop app) and the file
/// has never held this entry, ask the old keychain item once and copy what it
/// returns into the file, together with a `keychain-migrated:<key>` marker, so
/// the keychain is asked at most once per entry. A denied prompt is an error
/// and leaves no marker; it is remembered in `denied` (memory only), so the
/// rest of this launch gives the same error without prompting again, and the
/// next launch asks once more. A value set in the file meanwhile still wins.
/// The marker outlives
/// [`delete_at`], so a deleted token is not brought back from the keychain
/// copy we leave behind (deleting it would be one more password prompt).
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn get_or_migrate_at(
    path: &std::path::Path,
    key: &str,
    legacy: Option<KeychainRead<'_>>,
    denied: &DeniedReads,
) -> Result<Option<String>, String> {
    let tokens = read_tokens_at_checked(path)?;
    if let Some(value) = tokens.get(key) {
        return Ok(Some(value.clone()));
    }
    let Some(legacy) = legacy else {
        return Ok(None);
    };
    if let Some(known) = settled(&tokens, key) {
        return Ok(known);
    }
    if let Some(err) = denied_error(denied, key) {
        return Err(err);
    }
    // One keychain prompt at a time in this process: a thread that waited here
    // finds the other's result in the file instead of prompting again.
    static MIGRATING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = MIGRATING.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(known) = settled(&read_tokens_at_checked(path)?, key) {
        return Ok(known);
    }
    // Denied while this thread waited for the other prompt.
    if let Some(err) = denied_error(denied, key) {
        return Err(err);
    }
    let found = match legacy(key) {
        Ok(found) => found,
        Err(err) => {
            denied
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .insert(key.to_string(), err.clone());
            return Err(err);
        }
    };
    match save_migrated(path, key, found.as_deref()) {
        Ok(Some(known)) => Ok(known),
        Ok(None) => Ok(found),
        Err(err) => {
            // The value is still good for this call; the next read asks again.
            tracing::warn!("[tokens] could not save {key} taken from the keychain: {err}");
            Ok(found)
        }
    }
}

/// What the file already says about `key`, if anything: its value, or that
/// it was migrated (or set, or deleted) and is absent.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn settled(
    tokens: &std::collections::HashMap<String, String>,
    key: &str,
) -> Option<Option<String>> {
    let marker = keychain_migrated_key(key);
    match tokens.get(key) {
        Some(value) => Some(Some(value.clone())),
        None => tokens.contains_key(&marker).then_some(None),
    }
}

/// Save what the keychain returned for `key` (`found`), with its marker.
/// The prompt may have waited minutes for the user, so this starts again from
/// the file as it is now, under [`StoreLock`]: what other threads, processes
/// and the git credential helper wrote meanwhile survives, and a set or delete
/// of this very key made meanwhile wins over the keychain copy — `Ok(Some(_))`
/// is what the file says now, and nothing is written.
#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn save_migrated(
    path: &std::path::Path,
    key: &str,
    found: Option<&str>,
) -> Result<Option<Option<String>>, String> {
    let _store = StoreLock::acquire(path)?;
    let mut tokens = read_tokens_at_checked(path)?;
    if let Some(known) = settled(&tokens, key) {
        return Ok(Some(known));
    }
    if let Some(value) = found {
        tokens.insert(key.to_string(), value.to_string());
    }
    tokens.insert(keychain_migrated_key(key), "1".to_string());
    write_tokens_at(path, &tokens)?;
    Ok(None)
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn set_at(
    path: &std::path::Path,
    key: &str,
    value: &str,
    from_keychain: bool,
) -> Result<(), String> {
    update_at(path, |tokens| {
        tokens.insert(key.to_string(), value.to_string());
        if from_keychain {
            tokens.insert(keychain_migrated_key(key), "1".to_string());
        }
    })
}

#[cfg(any(not(feature = "tauri-runtime"), target_os = "macos"))]
fn delete_at(path: &std::path::Path, key: &str, from_keychain: bool) -> Result<(), String> {
    update_at(path, |tokens| {
        tokens.remove(key);
        if from_keychain {
            tokens.insert(keychain_migrated_key(key), "1".to_string());
        }
    })
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
    get_or_migrate_at(&tokens_file_path(), key, legacy, &DENIED)
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
        let got = get_or_migrate_at(
            &path,
            "secret:remote-workspace:k",
            Some(&keychain),
            &DeniedReads::default(),
        );
        assert_eq!(got.unwrap().as_deref(), Some("tok"));
        let got = get_or_migrate_at(
            &path,
            "secret:remote-workspace:k",
            Some(&keychain),
            &DeniedReads::default(),
        );
        assert_eq!(got.unwrap().as_deref(), Some("tok"));
        assert_eq!(asked.get(), 1);
        // Absent from the keychain too: asked once, then remembered as absent.
        assert_eq!(
            get_or_migrate_at(
                &path,
                "github-token:x",
                Some(&keychain),
                &DeniedReads::default()
            )
            .unwrap(),
            None
        );
        assert_eq!(
            get_or_migrate_at(
                &path,
                "github-token:x",
                Some(&keychain),
                &DeniedReads::default()
            )
            .unwrap(),
            None
        );
        assert_eq!(asked.get(), 2);
    }

    /// A fake keychain that counts its reads and refuses the first `deny` of
    /// them, the way a user clicking "Deny" does.
    fn counting_keychain(
        asked: &std::cell::Cell<usize>,
        deny: usize,
    ) -> impl Fn(&str) -> Result<Option<String>, String> + '_ {
        move |key: &str| {
            asked.set(asked.get() + 1);
            if asked.get() <= deny {
                Err("keyring get error: User canceled the operation".to_string())
            } else {
                Ok(Some(format!("tok-{key}")))
            }
        }
    }

    /// A denied prompt is not asked again in the same process: every later
    /// read of that key gives the same error without touching the keychain,
    /// and nothing is written to the file.
    #[test]
    fn a_denied_keychain_read_is_not_asked_again_this_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let denied = DeniedReads::default();
        let asked = std::cell::Cell::new(0);
        let keychain = counting_keychain(&asked, 1);
        for _ in 0..5 {
            let err = get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied).unwrap_err();
            assert!(err.contains("User canceled"), "{err}");
        }
        assert_eq!(asked.get(), 1);
        assert!(!read_tokens_at(&path).contains_key(&keychain_migrated_key("secret:a")));
        assert!(read_tokens_at(&path).is_empty());
    }

    /// The denial lives only in memory: the next launch (a fresh record) asks
    /// again, and what it returns is moved into the file with its marker.
    #[test]
    fn a_denied_keychain_read_is_asked_again_next_launch() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let denied = DeniedReads::default();
        let asked = std::cell::Cell::new(0);
        let keychain = counting_keychain(&asked, 1);
        assert!(get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied).is_err());
        assert!(get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied).is_err());
        assert_eq!(asked.get(), 1);
        // Restart: the in-memory record is gone.
        denied.lock().unwrap().clear();
        assert_eq!(
            get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied)
                .unwrap()
                .as_deref(),
            Some("tok-secret:a")
        );
        assert_eq!(asked.get(), 2);
        let tokens = read_tokens_at(&path);
        assert_eq!(tokens.get("secret:a").unwrap(), "tok-secret:a");
        assert!(tokens.contains_key(&keychain_migrated_key("secret:a")));
    }

    /// One denied key does not stop the others from being taken over.
    #[test]
    fn a_denied_key_does_not_block_other_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let denied = DeniedReads::default();
        let asked = std::cell::Cell::new(0);
        let keychain = counting_keychain(&asked, 1);
        assert!(get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied).is_err());
        assert_eq!(
            get_or_migrate_at(&path, "github-token:b", Some(&keychain), &denied)
                .unwrap()
                .as_deref(),
            Some("tok-github-token:b")
        );
        assert_eq!(asked.get(), 2);
    }

    /// A token saved after the denial (the connection edited, the portal link
    /// clicked again) is stored and read back as usual.
    #[test]
    fn a_token_saved_after_a_denial_reads_back() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let denied = DeniedReads::default();
        let asked = std::cell::Cell::new(0);
        let keychain = counting_keychain(&asked, usize::MAX);
        assert!(get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied).is_err());
        set_at(&path, "secret:a", "fresh", true).expect("set");
        assert_eq!(
            get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied)
                .unwrap()
                .as_deref(),
            Some("fresh")
        );
        assert_eq!(asked.get(), 1);
        // Deleted afterwards: absent, not the old denial, and still not asked.
        delete_at(&path, "secret:a", true).expect("delete");
        assert_eq!(
            get_or_migrate_at(&path, "secret:a", Some(&keychain), &denied).unwrap(),
            None
        );
        assert_eq!(asked.get(), 1);
    }

    /// Deleting a migrated entry must not bring it back from the keychain copy.
    #[test]
    fn test_delete_does_not_resurrect_from_keychain() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let keychain = |_: &str| -> Result<Option<String>, String> { Ok(Some("old".to_string())) };
        assert!(get_or_migrate_at(
            &path,
            "github-token:a",
            Some(&keychain),
            &DeniedReads::default()
        )
        .unwrap()
        .is_some());
        delete_at(&path, "github-token:a", true).expect("delete");
        assert_eq!(
            get_or_migrate_at(
                &path,
                "github-token:a",
                Some(&keychain),
                &DeniedReads::default()
            )
            .unwrap(),
            None
        );
        // Set before any read: the keychain is never consulted for it.
        set_at(&path, "github-token:b", "new", true).expect("set");
        delete_at(&path, "github-token:b", true).expect("delete");
        assert_eq!(
            get_or_migrate_at(
                &path,
                "github-token:b",
                Some(&keychain),
                &DeniedReads::default()
            )
            .unwrap(),
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
        let got = get_or_migrate_at(
            &path,
            "github-token:a",
            Some(&keychain),
            &DeniedReads::default(),
        )
        .unwrap();
        assert_eq!(got.as_deref(), Some("old"));
        let tokens = read_tokens_at(&path);
        assert_eq!(tokens.get("github-token:other").unwrap(), "fresh");
        assert_eq!(tokens.get("github-token:a").unwrap(), "old");

        let deleting = |key: &str| -> Result<Option<String>, String> {
            delete_at(&path, key, true).expect("delete");
            Ok(Some("old".to_string()))
        };
        let got = get_or_migrate_at(
            &path,
            "github-token:b",
            Some(&deleting),
            &DeniedReads::default(),
        )
        .unwrap();
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
            get_or_migrate_at(&path, "github-token:z", None, &DeniedReads::default()).unwrap(),
            None
        );
        delete_at(&path, "github-token:a", false).expect("delete");
        assert!(read_tokens_at(&path).is_empty());
    }

    /// A store that does not read is refused, not replaced by one holding only
    /// the new entry: every other token in it would be gone.
    #[test]
    fn a_save_into_a_store_that_does_not_read_writes_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let broken = "{\"github-token:a\": \"s1\"";
        std::fs::write(&path, broken).expect("seed");
        assert!(set_at(&path, "github-token:b", "s2", false).is_err());
        assert!(delete_at(&path, "github-token:a", true).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), broken);
    }

    /// An empty store (an older version wrote in place) holds nothing to lose:
    /// a save into it works.
    #[test]
    fn an_empty_store_takes_a_save() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        std::fs::write(&path, b"").expect("seed");
        set_at(&path, "github-token:a", "t", false).expect("set");
        assert_eq!(read_tokens_at(&path).get("github-token:a").unwrap(), "t");
    }

    /// Saves at once keep every entry: each one reads what the last one wrote.
    #[test]
    fn concurrent_saves_lose_nothing() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        std::thread::scope(|scope| {
            for i in 0..8 {
                let path = &path;
                scope.spawn(move || {
                    for j in 0..50 {
                        let key = format!("github-token:{i}-{j}");
                        set_at(path, &key, "v", false).expect("set");
                    }
                });
            }
        });
        assert_eq!(read_tokens_at_checked(&path).unwrap().len(), 400);
    }

    /// Another process holding the store (here another handle on its lock
    /// file, which the OS treats the same) holds a save back until it lets go.
    #[test]
    fn a_save_waits_for_another_process_holding_the_store() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("tokens.json");
        let other = open_lock_file(&path).expect("lock file");
        other.lock().expect("lock");
        std::thread::scope(|scope| {
            let saving = scope.spawn(|| set_at(&path, "github-token:a", "t", false));
            std::thread::sleep(std::time::Duration::from_millis(300));
            assert!(!path.exists(), "saved while another process held the store");
            other.unlock().expect("unlock");
            saving.join().unwrap().expect("set");
        });
        assert_eq!(read_tokens_at(&path).get("github-token:a").unwrap(), "t");
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
