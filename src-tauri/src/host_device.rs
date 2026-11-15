//! Cowork fork: the computer a desktop app runs on, as the app names it to
//! the servers it connects to (`web::host_devices`, `docs/devices.md`).
//!
//! A person may have the app open on several computers, all connected to the
//! same server. The server keeps a book of them for longer than a socket
//! lasts — `ssh laptop` must still mean the laptop after both apps restart —
//! so each app sends an id it made once and keeps, the name the person knows
//! the computer by, and what kind of machine it is.
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

/// What a computer may say it is, for the icon a list shows it with. Phones
/// and tablets are for the apps that will run there.
const KINDS: &[&str] = &["desktop", "laptop", "phone", "tablet"];

/// A computer, as its app names it in `host_register`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct HostDevice {
    /// Made once per computer and kept ([`device_id`]).
    pub id: String,
    /// The name people know it by ("James's Mac mini"); may be empty.
    #[serde(default)]
    pub name: String,
    /// The kind of machine, in English ("MacBook Air", "iMac"): what a
    /// server names it by when `name` gives it nothing to go on (a name all
    /// in Chinese). Empty from an app from before this.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub model: String,
    /// One of [`KINDS`].
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}

impl HostDevice {
    /// What an app sent, fit to keep and to show: `None` for an id that is
    /// not one; the name on one line and cut to a length.
    pub fn sound(self) -> Option<Self> {
        if !is_id(&self.id) {
            return None;
        }
        let kind = self.kind.filter(|kind| KINDS.contains(&kind.as_str()));
        Some(Self {
            id: self.id,
            name: one_line(&self.name),
            model: one_line(&self.model),
            kind,
        })
    }
}

/// `text` on one line, its runs of spaces one space, cut to a length.
fn one_line(text: &str) -> String {
    let plain: String = text
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    plain
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(NAME_MAX_CHARS)
        .collect()
}

/// Whether `id` could be one of ours: plain characters, a sensible length.
pub fn is_id(id: &str) -> bool {
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

/// The computer this app runs on. Asked once: finding the name and the
/// model runs programs on macOS, so the app asks at launch, off the async
/// threads ([`warm_up`]).
pub fn this_device() -> Option<HostDevice> {
    static DEVICE: OnceLock<Option<HostDevice>> = OnceLock::new();
    DEVICE
        .get_or_init(|| {
            let id = device_id(&crate::paths::codeg_home_dir())?;
            let name = crate::cowork_connect::this_device_name().unwrap_or_default();
            let model = machine_model().unwrap_or_default();
            let kind = kind_of(&model).map(str::to_string);
            Some(HostDevice {
                id,
                name,
                model,
                kind,
            })
        })
        .clone()
}

/// Find [`this_device`] on a thread of its own, so that the first socket to
/// register does not wait on `system_profiler` on an async thread.
pub fn warm_up() {
    let _ = std::thread::Builder::new()
        .name("host-device".into())
        .spawn(|| {
            let _ = this_device();
        });
}

/// The model's name, as "About This Mac" gives it ("MacBook Air").
fn machine_model() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("/usr/sbin/system_profiler")
            .args(["SPHardwareDataType", "-json"])
            .output()
            .ok()
            .filter(|out| out.status.success())
            .and_then(|out| model_from_profile(&out.stdout))
    }
    #[cfg(not(target_os = "macos"))]
    {
        None
    }
}

/// `machine_name` from `system_profiler SPHardwareDataType -json`.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn model_from_profile(json: &[u8]) -> Option<String> {
    let profile: serde_json::Value = serde_json::from_slice(json).ok()?;
    let name = profile
        .get("SPHardwareDataType")?
        .get(0)?
        .get("machine_name")?
        .as_str()?
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

/// What kind of machine a model is: every Mac laptop is a MacBook.
fn kind_of(model: &str) -> Option<&'static str> {
    if model.is_empty() {
        None
    } else if model.starts_with("MacBook") {
        Some("laptop")
    } else {
        Some("desktop")
    }
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
            model: String::new(),
            kind: None,
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
        assert_eq!(device.model, "");
        assert_eq!(device.kind, None);
    }

    #[test]
    fn the_model_and_its_kind_are_kept_plain_and_known() {
        let sent = HostDevice {
            id: "0123456789abcdef".into(),
            name: "Study".into(),
            model: " MacBook\tAir ".into(),
            kind: Some("laptop".into()),
        };
        let kept = sent.sound().unwrap();
        assert_eq!(kept.model, "MacBook Air");
        assert_eq!(kept.kind.as_deref(), Some("laptop"));
        let odd = HostDevice {
            id: "0123456789abcdef".into(),
            name: String::new(),
            model: String::new(),
            kind: Some("toaster".into()),
        };
        assert_eq!(odd.sound().unwrap().kind, None);
        // Nothing to say is said as nothing.
        let bare = serde_json::to_value(HostDevice {
            id: "0123456789abcdef".into(),
            name: "Study".into(),
            model: String::new(),
            kind: None,
        })
        .unwrap();
        assert_eq!(
            bare,
            serde_json::json!({"id": "0123456789abcdef", "name": "Study"})
        );
    }

    #[test]
    fn the_model_is_read_from_the_hardware_profile() {
        let profile = br#"{"SPHardwareDataType": [{"_name": "hardware_overview",
            "machine_model": "Mac15,12", "machine_name": "MacBook Air"}]}"#;
        assert_eq!(model_from_profile(profile).as_deref(), Some("MacBook Air"));
        assert_eq!(model_from_profile(br#"{"SPHardwareDataType": []}"#), None);
        assert_eq!(model_from_profile(b"not json"), None);
        assert_eq!(kind_of("MacBook Pro"), Some("laptop"));
        assert_eq!(kind_of("iMac"), Some("desktop"));
        assert_eq!(kind_of("Mac Studio"), Some("desktop"));
        assert_eq!(kind_of(""), None);
    }
}
