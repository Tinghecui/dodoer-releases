//! User-scoped preferences stored at `~/.codeg/preferences.json`.
//!
//! These are settings that must be readable **before** the Tauri builder and
//! tokio runtime start (e.g. the webview rendering flags applied via
//! `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` on Windows and `WEBKIT_DISABLE_*`
//! on Linux). All access is synchronous I/O so the data must stay tiny.

use std::fs;
use std::io;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

const PREFERENCES_FILE_NAME: &str = "preferences.json";
const CODEG_DIR_NAME: &str = ".codeg";

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(default)]
pub struct AppPreferences {
    pub disable_hardware_acceleration: bool,
    /// Cowork fork: "Send diagnostics (crashes, hangs, errors)": the desktop
    /// app's crash and hang reports (`crash_report`) and the reports of its
    /// own daemon and local windows (`local_daemon::ChildSpec`). `None` —
    /// never touched — is on; only the person's own "off" is `Some(false)`.
    /// Read here because the panic hook and the watchdog need it as the app
    /// starts. The key of #290's switch (`crash_reports`, off by default and
    /// so `false` in every file saved since) is not read: its `false` does
    /// not tell a choice from a default.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostics: Option<bool>,
}

impl AppPreferences {
    /// Whether diagnostics are sent: unless the person turned them off.
    pub fn diagnostics_enabled(&self) -> bool {
        self.diagnostics.unwrap_or(true)
    }
}

pub fn preferences_file_path() -> Option<PathBuf> {
    dirs::home_dir().map(|h| h.join(CODEG_DIR_NAME).join(PREFERENCES_FILE_NAME))
}

/// Read preferences synchronously. Missing / unreadable / malformed file
/// returns `Default::default()`. Errors are intentionally swallowed because
/// this is called on the startup hot-path; callers log if needed.
pub fn load() -> AppPreferences {
    let Some(path) = preferences_file_path() else {
        return AppPreferences::default();
    };
    match fs::read_to_string(&path) {
        Ok(raw) => serde_json::from_str(&raw).unwrap_or_default(),
        Err(err) if err.kind() == io::ErrorKind::NotFound => AppPreferences::default(),
        Err(err) => {
            tracing::error!("[Preferences] failed to read {}: {err}", path.display());
            AppPreferences::default()
        }
    }
}

pub fn save(prefs: &AppPreferences) -> io::Result<()> {
    let path = preferences_file_path()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "home directory unavailable"))?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let serialized = serde_json::to_string_pretty(prefs)
        .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err.to_string()))?;
    fs::write(&path, serialized)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn diagnostics_are_on_until_turned_off() {
        let read = |raw: &str| serde_json::from_str::<AppPreferences>(raw).unwrap();
        assert!(read("{}").diagnostics_enabled());
        // #290's default-off key says nothing about a choice.
        assert!(read(r#"{"crash_reports":false}"#).diagnostics_enabled());
        assert!(read(r#"{"diagnostics":true}"#).diagnostics_enabled());
        assert!(!read(r#"{"diagnostics":false}"#).diagnostics_enabled());

        let untouched = serde_json::to_string(&AppPreferences::default()).unwrap();
        assert!(!untouched.contains("diagnostics"), "{untouched}");
        let off = AppPreferences {
            diagnostics: Some(false),
            ..Default::default()
        };
        let saved = serde_json::to_string(&off).unwrap();
        assert!(!read(&saved).diagnostics_enabled());
    }
}
