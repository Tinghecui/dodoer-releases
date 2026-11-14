//! Cowork fork: the computer a desktop app runs on, as the app names it to
//! the servers it lends things to (`web::host_registry`,
//! `docs/host-choice.md`).
//!
//! A person may have the app open on two computers at once, both lending the
//! same server their tabs or their command line. The server has to tell them
//! apart for longer than a socket lasts — "always use the Mac mini's
//! browser" must still mean the Mac mini after both apps restart — so each
//! app sends an id it made once and keeps, and the name the person knows the
//! computer by.
//!
//! The id says nothing about the computer: random, kept in `~/.codeg`, and
//! sent only to servers the person connected the app to.

use std::path::Path;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

/// Where the id is kept, in the codeg home directory.
const ID_FILE: &str = "device-id";

/// How much of a name a server keeps.
const NAME_MAX_CHARS: usize = 80;

/// A computer, as its app names it in `host_register`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostDevice {
    /// Made once per computer and kept ([`device_id`]).
    pub id: String,
    /// The name people know it by ("James's Mac mini"); may be empty.
    #[serde(default)]
    pub name: String,
}

impl HostDevice {
    /// What an app sent, fit to keep and to show: `None` for an id that is
    /// not one; the name on one line and cut to a length.
    pub fn sound(self) -> Option<Self> {
        if !is_id(&self.id) {
            return None;
        }
        let one_line: String = self
            .name
            .chars()
            .map(|c| if c.is_control() { ' ' } else { c })
            .collect();
        let name = one_line
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ")
            .chars()
            .take(NAME_MAX_CHARS)
            .collect();
        Some(Self { id: self.id, name })
    }
}

/// Whether `id` could be one of ours: plain characters, a sensible length.
fn is_id(id: &str) -> bool {
    (8..=64).contains(&id.len())
        && id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_'))
}

/// This computer's id, kept in `dir`: made the first time it is asked for,
/// the same ever after. `None` when it can neither be read nor kept — an id
/// that changes with every start would be worse than none.
pub fn device_id(dir: &Path) -> Option<String> {
    let file = dir.join(ID_FILE);
    if let Ok(text) = std::fs::read_to_string(&file) {
        let id = text.trim();
        if is_id(id) {
            return Some(id.to_string());
        }
    }
    let id = uuid::Uuid::new_v4().simple().to_string();
    std::fs::create_dir_all(dir).ok()?;
    std::fs::write(&file, format!("{id}\n")).ok()?;
    Some(id)
}

/// The computer this app runs on. Asked once: finding the name runs a
/// program on macOS.
pub fn this_device() -> Option<HostDevice> {
    static DEVICE: OnceLock<Option<HostDevice>> = OnceLock::new();
    DEVICE
        .get_or_init(|| {
            let id = device_id(&crate::paths::codeg_home_dir())?;
            let name = crate::cowork_connect::this_device_name().unwrap_or_default();
            Some(HostDevice { id, name })
        })
        .clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_id_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().join("not-there-yet");
        let first = device_id(&home).expect("made");
        assert!(is_id(&first));
        assert_eq!(device_id(&home).as_deref(), Some(first.as_str()));
    }

    #[test]
    fn a_spoiled_id_file_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(ID_FILE), "two words\n").unwrap();
        let id = device_id(dir.path()).expect("made again");
        assert!(is_id(&id));
        assert_eq!(device_id(dir.path()).as_deref(), Some(id.as_str()));
    }

    #[test]
    fn what_an_app_sends_is_kept_only_if_it_is_plain() {
        let device = |id: &str, name: &str| HostDevice {
            id: id.to_string(),
            name: name.to_string(),
        };
        assert_eq!(device("short", "Mac").sound(), None);
        assert_eq!(device("has a space in it", "Mac").sound(), None);
        assert_eq!(device(&"a".repeat(65), "Mac").sound(), None);
        assert_eq!(
            device("0123456789abcdef", "  James's\tMac\nmini ").sound(),
            Some(device("0123456789abcdef", "James's Mac mini"))
        );
        let long = device("0123456789abcdef", &"名".repeat(200))
            .sound()
            .unwrap();
        assert_eq!(long.name.chars().count(), NAME_MAX_CHARS);
        // A computer nobody named still has its id.
        assert_eq!(
            device("0123456789abcdef", "").sound(),
            Some(device("0123456789abcdef", ""))
        );
    }

    #[test]
    fn a_device_from_before_names_reads() {
        let device: HostDevice = serde_json::from_str(r#"{"id":"0123456789abcdef"}"#).unwrap();
        assert_eq!(device.name, "");
    }
}
