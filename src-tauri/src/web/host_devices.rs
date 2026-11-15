//! Cowork fork: the book of a person's devices this server keeps
//! (`docs/devices.md` 4).
//!
//! Every desktop app that connects says which computer it is on
//! (`host_device`, in `host_register`). The registry (`web::host_registry`)
//! knows which of them are connected right now; this book remembers every
//! one that ever was — its name, what kind of machine, when it was last
//! online — across the apps' restarts and the server's. The person and the
//! agents call a device by its name, so a name is unique here, plain enough
//! for an `ssh` configuration, and the person's to choose: the app asks once,
//! at the first connection, offering one made from the computer's name
//! ([`default_name`]).
//!
//! Kept as JSON in `app_metadata` ([`KEY_BOOK`]): a handful of devices, no
//! table and so no migration (a test build and the release can share a data
//! directory).
//!
//! * `POST /api/list_host_devices` — every device: online, or since when not,
//!   and what it lends;
//! * `POST /api/rename_host_device` — the name the person chose, or kept;
//! * `POST /api/forget_host_device` — a device that is not connected, gone
//!   from the book.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use axum::{extract::Extension, Json};
use sea_orm::DatabaseConnection;
use serde::{Deserialize, Serialize};

use super::host_registry::HostRegistry;
use crate::app_error::AppCommandError;
use crate::app_state::AppState;
use crate::db::service::app_metadata_service;
use crate::host_device::HostDevice;

/// The `server_info` feature a client looks for before it shows the devices
/// (`compat::FEATURES`).
pub const FEATURE: &str = "host_devices";

/// Where the book is kept (`app_metadata`), as JSON.
const KEY_BOOK: &str = "host_devices.registry";

/// How long a name may be: `ssh <name>` is typed, and read in every command.
pub const NAME_MAX: usize = 32;

/// What a device is called when nothing about it gives a name.
const FALLBACK_NAME: &str = "device";

/// How long the book waits before it is written: a reconnect, several
/// windows opening, are one write.
const SAVE_DELAY: Duration = Duration::from_secs(2);

/// How often a device online now has its "last online" moved on, so that a
/// server stopped without warning still says about when each was there.
const TOUCH_EVERY: Duration = Duration::from_secs(5 * 60);

/// One device, as the book keeps it.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceRecord {
    /// The app's id for its computer (`host_device::device_id`).
    pub id: String,
    /// What the person and the agents call it ([`is_name`]).
    pub name: String,
    /// The person chose the name, or saw the one made up and kept it: the
    /// app does not ask again.
    #[serde(default)]
    pub named: bool,
    /// The computer's own name ("James's MacBook Air"). A person's name may
    /// be in it, so it is shown and never logged.
    #[serde(default)]
    pub computer_name: String,
    /// "MacBook Air", "iMac".
    #[serde(default)]
    pub model: String,
    /// `desktop`, `laptop`; later `phone`, `tablet`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
    /// `macos`, as the shell it lends says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub platform: Option<String>,
    /// The app's version, as its `hello` says.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub app_version: Option<String>,
    /// The login name its shell was last lent as: what `ssh <name>` logs in
    /// as while the device is away (`docs/devices.md` 5.1).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub user: Option<String>,
    /// When the server first heard of it, in milliseconds since 1970.
    #[serde(default)]
    pub first_seen: i64,
    /// When it was last connected (now, while it is).
    #[serde(default)]
    pub last_seen: i64,
}

/// The book as it is written.
#[derive(Debug, Default, Serialize, Deserialize)]
struct StoredBook {
    #[serde(default)]
    devices: Vec<DeviceRecord>,
}

/// What a registration says besides the device.
#[derive(Debug, Clone, Copy, Default)]
pub struct Seen<'a> {
    pub platform: Option<&'a str>,
    pub user: Option<&'a str>,
    pub app_version: Option<&'a str>,
}

/// Why a name was not taken.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NameError {
    /// Not a name ([`is_name`]).
    Invalid,
    /// Another device has it.
    Taken,
    /// The server's own `~/.ssh/config` has a `Host` of that name, which ours
    /// would hide.
    Reserved,
    NoSuchDevice,
}

/// Why a device was not forgotten.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ForgetError {
    /// It is connected: it would be back at once, with a new name.
    Online,
    NoSuchDevice,
}

/// Every device the server has heard of.
#[derive(Debug, Default, Clone)]
pub struct DeviceBook {
    devices: Vec<DeviceRecord>,
    /// Names the server's own `~/.ssh/config` gives a `Host` already.
    reserved: BTreeSet<String>,
}

impl DeviceBook {
    pub fn records(&self) -> &[DeviceRecord] {
        &self.devices
    }

    pub fn get(&self, id: &str) -> Option<&DeviceRecord> {
        self.devices.iter().find(|d| d.id == id)
    }

    /// An app on `device` registered, or said something new: the book has
    /// it, as it is now. A device new here gets a name nobody has.
    pub fn seen(&mut self, device: &HostDevice, seen: Seen<'_>, now: i64) {
        if let Some(record) = self.devices.iter_mut().find(|d| d.id == device.id) {
            record.computer_name = device.name.clone();
            if !device.model.is_empty() {
                record.model = device.model.clone();
            }
            if device.kind.is_some() {
                record.kind = device.kind.clone();
            }
            if let Some(platform) = seen.platform {
                record.platform = Some(platform.to_string());
            }
            if let Some(user) = seen.user {
                record.user = Some(user.to_string());
            }
            if let Some(version) = seen.app_version {
                record.app_version = Some(version.to_string());
            }
            record.last_seen = now;
            return;
        }
        let base = default_name(&device.name, &device.model, device.kind.as_deref());
        let name = unique(&base, |name| self.is_taken(name));
        self.devices.push(DeviceRecord {
            id: device.id.clone(),
            name,
            named: false,
            computer_name: device.name.clone(),
            model: device.model.clone(),
            kind: device.kind.clone(),
            platform: seen.platform.map(str::to_string),
            app_version: seen.app_version.map(str::to_string),
            user: seen.user.map(str::to_string),
            first_seen: now,
            last_seen: now,
        });
    }

    /// The last app on `id` went away.
    pub fn left(&mut self, id: &str, now: i64) -> bool {
        self.touch(&[id.to_string()], now)
    }

    /// These are online now.
    pub fn touch(&mut self, ids: &[String], now: i64) -> bool {
        let mut touched = false;
        for record in self.devices.iter_mut().filter(|d| ids.contains(&d.id)) {
            record.last_seen = now;
            touched = true;
        }
        touched
    }

    /// Call `id` `name` (lowercased), the person's choice from now on. Its
    /// own name again only marks it chosen.
    pub fn rename(&mut self, id: &str, name: &str) -> Result<(), NameError> {
        let name = name.trim().to_ascii_lowercase();
        if !is_name(&name) {
            return Err(NameError::Invalid);
        }
        if self.get(id).is_none() {
            return Err(NameError::NoSuchDevice);
        }
        if self.devices.iter().any(|d| d.id != id && d.name == name) {
            return Err(NameError::Taken);
        }
        if self.reserved.contains(&name) {
            return Err(NameError::Reserved);
        }
        if let Some(record) = self.devices.iter_mut().find(|d| d.id == id) {
            record.name = name;
            record.named = true;
        }
        Ok(())
    }

    /// Gone from the book; whether it was there.
    pub fn forget(&mut self, id: &str) -> bool {
        let before = self.devices.len();
        self.devices.retain(|d| d.id != id);
        self.devices.len() != before
    }

    /// The names the server's `~/.ssh/config` has. A name made up here that
    /// is one of them is made up again; whether any was.
    pub fn set_reserved(&mut self, reserved: BTreeSet<String>) -> bool {
        self.reserved = reserved;
        self.settle_names()
    }

    /// The book as it was kept, when the server starts. An app that
    /// registered before it was read keeps what it said, under the name and
    /// the history kept for it.
    pub fn restore(&mut self, stored: Vec<DeviceRecord>) {
        let live = std::mem::take(&mut self.devices);
        let mut devices: Vec<DeviceRecord> = Vec::new();
        for kept in stored {
            if !crate::host_device::is_id(&kept.id) || devices.iter().any(|d| d.id == kept.id) {
                continue;
            }
            let record = match live.iter().find(|d| d.id == kept.id) {
                Some(now) => DeviceRecord {
                    name: kept.name,
                    named: kept.named,
                    first_seen: kept.first_seen,
                    user: now.user.clone().or(kept.user),
                    ..now.clone()
                },
                None => kept,
            };
            devices.push(record);
        }
        for record in live {
            if !devices.iter().any(|d| d.id == record.id) {
                devices.push(record);
            }
        }
        self.devices = devices;
        self.settle_names();
    }

    /// Every name sound and nobody else's, and none made up here one the
    /// server's `ssh` has already: the person's own choices are kept first.
    /// Whether any changed.
    fn settle_names(&mut self) -> bool {
        let mut order: Vec<usize> = (0..self.devices.len()).collect();
        order.sort_by_key(|&at| !self.devices[at].named);
        let mut taken: BTreeSet<String> = BTreeSet::new();
        let mut changed = false;
        for at in order {
            let record = &self.devices[at];
            let current = record.name.clone();
            let keep = is_name(&current)
                && !taken.contains(&current)
                && (record.named || !self.reserved.contains(&current));
            let name = if keep {
                current
            } else {
                let base = if is_name(&current) {
                    current
                } else {
                    default_name(
                        &record.computer_name,
                        &record.model,
                        record.kind.as_deref(),
                    )
                };
                let reserved = &self.reserved;
                unique(&base, |name| taken.contains(name) || reserved.contains(name))
            };
            let record = &mut self.devices[at];
            if record.name != name {
                record.name = name.clone();
                record.named = false;
                changed = true;
            }
            taken.insert(name);
        }
        changed
    }

    fn is_taken(&self, name: &str) -> bool {
        self.reserved.contains(name) || self.devices.iter().any(|d| d.name == name)
    }
}

/// Whether `name` can be a device's: lowercase letters, digits and dashes,
/// starting with a letter or a digit and not ending in a dash, at most
/// [`NAME_MAX`]. Fit to go into an `ssh` configuration as it is.
pub fn is_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= NAME_MAX
        && bytes[0] != b'-'
        && bytes.last() != Some(&b'-')
        && bytes
            .iter()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// The name a device is offered: made from the computer's name without its
/// owner's ("James's MacBook Air" → `macbook-air`); when that leaves too
/// little — a name all in Chinese — from the model, in English; else from
/// its kind.
pub fn default_name(computer_name: &str, model: &str, kind: Option<&str>) -> String {
    [slug(without_owner(computer_name)), slug(model)]
        .into_iter()
        .find(|name| name.len() >= 2)
        .unwrap_or_else(|| {
            kind.filter(|kind| is_name(kind))
                .unwrap_or(FALLBACK_NAME)
                .to_string()
        })
}

/// "James's MacBook Air", "张三的 MacBook Air": the computer, not whose it is.
fn without_owner(name: &str) -> &str {
    ["'s ", "\u{2019}s ", "的"]
        .iter()
        .find_map(|mark| name.find(mark).map(|at| &name[at + mark.len()..]))
        .unwrap_or(name)
}

/// The letters and digits of `text`, lowercased, each run of anything else a
/// dash between them; cut to [`NAME_MAX`].
fn slug(text: &str) -> String {
    let mut out = String::new();
    let mut gap = false;
    for c in text.chars() {
        if c.is_ascii_alphanumeric() {
            if gap && !out.is_empty() {
                out.push('-');
            }
            gap = false;
            out.push(c.to_ascii_lowercase());
        } else {
            gap = true;
        }
    }
    let mut cut: String = out.chars().take(NAME_MAX).collect();
    while cut.ends_with('-') {
        cut.pop();
    }
    cut
}

/// `base`, or `base-2`, `base-3`… — the first nobody has.
fn unique(base: &str, taken: impl Fn(&str) -> bool) -> String {
    if !taken(base) {
        return base.to_string();
    }
    let mut n: u32 = 2;
    loop {
        let suffix = format!("-{n}");
        let mut head: String = base.chars().take(NAME_MAX - suffix.len()).collect();
        while head.ends_with('-') {
            head.pop();
        }
        let candidate = format!("{head}{suffix}");
        if !taken(&candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// The plain names an `ssh_config` gives a `Host` (no patterns, no
/// negations), lowercased.
pub fn reserved_names(config: &str) -> BTreeSet<String> {
    let mut names = BTreeSet::new();
    for line in config.lines() {
        let line = line.trim();
        let Some((key, rest)) = line.split_once(|c: char| c.is_whitespace() || c == '=') else {
            continue;
        };
        if !key.eq_ignore_ascii_case("host") {
            continue;
        }
        for pattern in rest.split(|c: char| c.is_whitespace() || c == '=') {
            let pattern = pattern.trim_matches('"').to_ascii_lowercase();
            if is_name(&pattern) {
                names.insert(pattern);
            }
        }
    }
    names
}

/// The server's `~/.ssh/config`: the one ours is included at the top of
/// (`host_ssh::client`).
fn ssh_config() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join(".ssh").join("config"))
}

/// [`reserved_names`] of the server's `~/.ssh/config`; none without one.
async fn read_reserved() -> BTreeSet<String> {
    let Some(path) = ssh_config() else {
        return BTreeSet::new();
    };
    match tokio::fs::read_to_string(&path).await {
        Ok(text) => reserved_names(&text),
        Err(_) => BTreeSet::new(),
    }
}

/// Now, as the book counts time.
pub fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

/// How long ago `then` was, both in milliseconds since 1970, in words.
pub fn ago(then: i64, now: i64) -> String {
    if then <= 0 {
        return "a long time ago".to_string();
    }
    let minutes = (now - then).max(0) / 60_000;
    match minutes {
        0 => "just now".to_string(),
        1 => "a minute ago".to_string(),
        2..=59 => format!("{minutes} minutes ago"),
        60..=119 => "an hour ago".to_string(),
        120..=1439 => format!("{} hours ago", minutes / 60),
        1440..=2879 => "a day ago".to_string(),
        _ => format!("{} days ago", minutes / 1440),
    }
}

/// One device as a client is shown it.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceView {
    pub id: String,
    pub name: String,
    pub named: bool,
    pub computer_name: String,
    pub model: String,
    pub kind: Option<String>,
    pub platform: Option<String>,
    pub app_version: Option<String>,
    pub first_seen: i64,
    pub last_seen: i64,
    /// Some app on it is connected now.
    pub online: bool,
    /// It lends its command line now.
    pub shell: bool,
    /// It lends its tabs now.
    pub browser: bool,
    /// …and the person lets agents use their own Chrome there.
    pub chrome: bool,
}

/// What the registry knows of a device right now.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Presence {
    pub online: bool,
    pub shell: bool,
    pub browser: bool,
    pub chrome: bool,
}

impl DeviceView {
    pub fn new(record: &DeviceRecord, presence: Presence) -> Self {
        Self {
            id: record.id.clone(),
            name: record.name.clone(),
            named: record.named,
            computer_name: record.computer_name.clone(),
            model: record.model.clone(),
            kind: record.kind.clone(),
            platform: record.platform.clone(),
            app_version: record.app_version.clone(),
            first_seen: record.first_seen,
            last_seen: record.last_seen,
            online: presence.online,
            shell: presence.shell,
            browser: presence.browser,
            chrome: presence.chrome,
        }
    }
}

/// `POST /api/list_host_devices`.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DeviceList {
    /// Online first, then the one seen last.
    pub devices: Vec<DeviceView>,
    /// Apps connected now that are too old to say which computer they are
    /// on: they lend what they lend, and are in no book.
    pub unnamed_hosts: usize,
}

/// Read the book back, take in the server's `ssh` names, and keep the book
/// written and its online devices' times current, for as long as the server
/// runs. Before any app registers.
pub async fn start(state: &AppState) {
    let registry = Arc::clone(&state.host_registry);
    match app_metadata_service::get_value(&state.db.conn, KEY_BOOK).await {
        Ok(Some(text)) => match serde_json::from_str::<StoredBook>(&text) {
            Ok(stored) => registry.restore_book(stored.devices),
            Err(e) => tracing::warn!("[host-devices] the stored book does not read: {e}"),
        },
        Ok(None) => {}
        Err(e) => tracing::warn!("[host-devices] reading the stored book: {e}"),
    }
    registry.set_reserved_names(read_reserved().await);
    spawn_saver(Arc::clone(&registry), state.db.conn.clone());
    spawn_ticker(registry);
}

fn spawn_saver(registry: Arc<HostRegistry>, conn: DatabaseConnection) {
    let mut changes = registry.watch_book();
    tokio::spawn(async move {
        while changes.changed().await.is_ok() {
            tokio::time::sleep(SAVE_DELAY).await;
            // What changed meanwhile is in what is written now.
            drop(changes.borrow_and_update());
            save(&conn, registry.book_records()).await;
        }
    });
}

async fn save(conn: &DatabaseConnection, devices: Vec<DeviceRecord>) {
    let text = match serde_json::to_string(&StoredBook { devices }) {
        Ok(text) => text,
        Err(e) => {
            tracing::warn!("[host-devices] the book does not write: {e}");
            return;
        }
    };
    if let Err(e) = app_metadata_service::upsert_value(conn, KEY_BOOK, &text).await {
        tracing::warn!("[host-devices] keeping the book: {e}");
    }
}

fn spawn_ticker(registry: Arc<HostRegistry>) {
    tokio::spawn(async move {
        let mut every = tokio::time::interval(TOUCH_EVERY);
        every.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        // The first tick is at once.
        every.tick().await;
        loop {
            every.tick().await;
            registry.touch_online();
        }
    });
}

/// `POST /api/list_host_devices` (`cowork::api_routes`).
pub async fn list_host_devices(Extension(state): Extension<Arc<AppState>>) -> Json<DeviceList> {
    Json(state.host_registry.device_list())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameHostDeviceParams {
    id: String,
    name: String,
}

/// `POST /api/rename_host_device` (`cowork::api_routes`): the list afterwards.
pub async fn rename_host_device(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<RenameHostDeviceParams>,
) -> Result<Json<DeviceList>, AppCommandError> {
    // The person may have added a `Host` since the server started.
    state
        .host_registry
        .set_reserved_names(read_reserved().await);
    state
        .host_registry
        .rename_device(&params.id, &params.name)
        .map_err(|e| name_error(e, &params.name))?;
    Ok(Json(state.host_registry.device_list()))
}

fn name_error(error: NameError, name: &str) -> AppCommandError {
    let name = name.trim().to_ascii_lowercase();
    match error {
        NameError::Invalid => AppCommandError::invalid_input(format!(
            "A device name is 1 to {NAME_MAX} lowercase letters, digits and dashes, starting \
             with a letter or a digit"
        )),
        NameError::Taken => {
            AppCommandError::already_exists(format!("Another device is called \"{name}\""))
        }
        NameError::Reserved => AppCommandError::already_exists(format!(
            "\"{name}\" is a Host in this server's ~/.ssh/config already"
        )),
        NameError::NoSuchDevice => AppCommandError::not_found("No such device"),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForgetHostDeviceParams {
    id: String,
}

/// `POST /api/forget_host_device` (`cowork::api_routes`): the list afterwards.
pub async fn forget_host_device(
    Extension(state): Extension<Arc<AppState>>,
    Json(params): Json<ForgetHostDeviceParams>,
) -> Result<Json<DeviceList>, AppCommandError> {
    state
        .host_registry
        .forget_device(&params.id)
        .map_err(|e| match e {
            ForgetError::Online => AppCommandError::invalid_input(
                "A connected device cannot be removed: quit dodoer on it first",
            ),
            ForgetError::NoSuchDevice => AppCommandError::not_found("No such device"),
        })?;
    Ok(Json(state.host_registry.device_list()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn device(id: &str, name: &str, model: &str, kind: Option<&str>) -> HostDevice {
        HostDevice {
            id: format!("{id}-0123456789"),
            name: name.to_string(),
            model: model.to_string(),
            kind: kind.map(str::to_string),
        }
    }

    fn names(book: &DeviceBook) -> Vec<&str> {
        book.records().iter().map(|d| d.name.as_str()).collect()
    }

    #[test]
    fn a_name_is_plain_enough_for_ssh() {
        let longest = "a".repeat(NAME_MAX);
        for good in ["desktop", "laptop-2", "imac", "a", "0", longest.as_str()] {
            assert!(is_name(good), "{good}");
        }
        let too_long = "a".repeat(NAME_MAX + 1);
        for bad in [
            "",
            "-a",
            "a-",
            "Desktop",
            "two words",
            "a_b",
            "a.b",
            "书房",
            too_long.as_str(),
        ] {
            assert!(!is_name(bad), "{bad}");
        }
    }

    #[test]
    fn the_name_offered_is_the_computers_without_its_owner() {
        assert_eq!(default_name("James's MacBook Air", "MacBook Air", None), "macbook-air");
        assert_eq!(default_name("James\u{2019}s iMac", "iMac", None), "imac");
        assert_eq!(default_name("张三的MacBook Pro", "MacBook Pro", None), "macbook-pro");
        assert_eq!(default_name("Studio Desk", "Mac Studio", None), "studio-desk");
        // A name all in Chinese: the model, in English.
        assert_eq!(default_name("书房的电脑", "Mac Studio", Some("desktop")), "mac-studio");
        assert_eq!(default_name("书房电脑", "", Some("laptop")), "laptop");
        assert_eq!(default_name("", "", None), "device");
        assert_eq!(default_name("x", "", None), "device");
        let long = default_name(&"Very Long Name ".repeat(5), "", None);
        assert!(is_name(&long) && long.len() <= NAME_MAX, "{long}");
    }

    #[test]
    fn a_new_device_gets_a_name_nobody_has() {
        let mut book = DeviceBook::default();
        book.seen(&device("a", "Study iMac", "iMac", None), Seen::default(), 1);
        book.seen(&device("b", "Study iMac", "iMac", None), Seen::default(), 2);
        book.seen(&device("c", "Study iMac", "iMac", None), Seen::default(), 3);
        assert_eq!(names(&book), ["study-imac", "study-imac-2", "study-imac-3"]);
        assert!(book.records().iter().all(|d| !d.named));
    }

    #[test]
    fn a_device_seen_again_keeps_its_name_and_takes_what_it_says_now() {
        let mut book = DeviceBook::default();
        let first = device("a", "Old Name", "iMac", Some("desktop"));
        let seen = Seen {
            platform: Some("macos"),
            user: Some("me"),
            app_version: Some("1.6.8"),
        };
        book.seen(&first, seen, 10);
        book.rename(&first.id, "desktop").unwrap();
        let renamed_computer = device("a", "New Name", "", None);
        book.seen(&renamed_computer, Seen::default(), 20);
        let record = book.get(&first.id).unwrap();
        assert_eq!(record.name, "desktop");
        assert!(record.named);
        assert_eq!(record.computer_name, "New Name");
        assert_eq!(record.model, "iMac", "an app that says no model keeps the one known");
        assert_eq!(record.kind.as_deref(), Some("desktop"));
        assert_eq!(record.user.as_deref(), Some("me"));
        assert_eq!(record.app_version.as_deref(), Some("1.6.8"));
        assert_eq!((record.first_seen, record.last_seen), (10, 20));
        assert!(book.left(&first.id, 30));
        assert_eq!(book.get(&first.id).unwrap().last_seen, 30);
        assert!(!book.left("nobody-0123456789", 30));
    }

    #[test]
    fn a_rename_is_checked_and_marks_the_name_chosen() {
        let mut book = DeviceBook::default();
        let a = device("a", "iMac", "iMac", None);
        let b = device("b", "MacBook Air", "MacBook Air", None);
        book.seen(&a, Seen::default(), 1);
        book.seen(&b, Seen::default(), 1);
        book.set_reserved(BTreeSet::from(["prod".to_string()]));
        assert_eq!(book.rename(&a.id, "Two Words"), Err(NameError::Invalid));
        assert_eq!(book.rename(&a.id, "macbook-air"), Err(NameError::Taken));
        assert_eq!(book.rename(&a.id, "prod"), Err(NameError::Reserved));
        assert_eq!(book.rename("nobody-0123456789", "x"), Err(NameError::NoSuchDevice));
        // Its own name again: kept, and no longer asked about.
        assert_eq!(book.rename(&a.id, " IMAC "), Ok(()));
        assert!(book.get(&a.id).unwrap().named);
        assert_eq!(book.rename(&a.id, "desktop"), Ok(()));
        assert_eq!(book.get(&a.id).unwrap().name, "desktop");
    }

    #[test]
    fn a_made_up_name_gives_way_to_a_host_the_server_has() {
        let mut book = DeviceBook::default();
        let a = device("a", "Build Box", "", None);
        let b = device("b", "Laptop", "", None);
        book.seen(&a, Seen::default(), 1);
        book.seen(&b, Seen::default(), 1);
        book.rename(&b.id, "laptop").unwrap();
        let changed = book.set_reserved(BTreeSet::from([
            "build-box".to_string(),
            "laptop".to_string(),
        ]));
        assert!(changed);
        // Made up here: changed. The person's own: theirs.
        assert_eq!(names(&book), ["build-box-2", "laptop"]);
        assert!(!book.set_reserved(BTreeSet::from(["build-box".to_string()])));
    }

    #[test]
    fn the_book_comes_back_under_what_registered_meanwhile() {
        let mut book = DeviceBook::default();
        let early = device("a", "iMac", "iMac", None);
        book.seen(
            &early,
            Seen {
                app_version: Some("1.7.0"),
                ..Seen::default()
            },
            50,
        );
        let kept = |id: &str, name: &str, named: bool| DeviceRecord {
            id: format!("{id}-0123456789"),
            name: name.to_string(),
            named,
            computer_name: String::new(),
            model: String::new(),
            kind: None,
            platform: None,
            app_version: Some("1.6.8".into()),
            user: Some("me".into()),
            first_seen: 5,
            last_seen: 6,
        };
        book.restore(vec![
            kept("a", "desktop", true),
            kept("b", "imac", false),
            kept("b", "again", false),
            DeviceRecord {
                id: "bad id".into(),
                ..kept("c", "x", false)
            },
            DeviceRecord {
                name: "Not A Name".into(),
                computer_name: "Spare Mac".into(),
                ..kept("d", "", false)
            },
        ]);
        assert_eq!(names(&book), ["desktop", "imac", "spare-mac"]);
        let a = book.get(&early.id).unwrap();
        assert!(a.named);
        assert_eq!(a.first_seen, 5, "the history kept");
        assert_eq!(a.last_seen, 50, "what it said now");
        assert_eq!(a.app_version.as_deref(), Some("1.7.0"));
        assert_eq!(a.user.as_deref(), Some("me"));
    }

    #[test]
    fn a_device_is_forgotten_once() {
        let mut book = DeviceBook::default();
        let a = device("a", "iMac", "iMac", None);
        book.seen(&a, Seen::default(), 1);
        assert!(book.forget(&a.id));
        assert!(!book.forget(&a.id));
        assert!(book.records().is_empty());
    }

    #[test]
    fn the_hosts_of_an_ssh_config_are_reserved() {
        let config = "# mine\nHost prod staging\n  HostName example.com\nhost=Box\nHost *\nHost !no *.lan \"quoted\"\nMatch host other\nHostName nope\n";
        assert_eq!(
            reserved_names(config),
            BTreeSet::from([
                "box".to_string(),
                "prod".to_string(),
                "quoted".to_string(),
                "staging".to_string(),
            ])
        );
    }

    /// The book as written reads back, and what a client is shown is
    /// camelCase, as `src/lib/cowork/host-devices.ts` reads it.
    #[test]
    fn the_book_and_the_list_read_as_their_readers_expect() {
        let mut book = DeviceBook::default();
        let a = device("a", "iMac", "iMac", Some("desktop"));
        book.seen(&a, Seen::default(), 7);
        let text = serde_json::to_string(&StoredBook {
            devices: book.records().to_vec(),
        })
        .unwrap();
        let back: StoredBook = serde_json::from_str(&text).unwrap();
        assert_eq!(back.devices, book.records());
        let bare: StoredBook =
            serde_json::from_str(r#"{"devices":[{"id":"a-0123456789","name":"imac"}]}"#).unwrap();
        assert_eq!(bare.devices[0].last_seen, 0);
        assert!(!bare.devices[0].named);

        let list = DeviceList {
            devices: vec![DeviceView::new(
                book.get(&a.id).unwrap(),
                Presence {
                    online: true,
                    shell: true,
                    browser: false,
                    chrome: false,
                },
            )],
            unnamed_hosts: 1,
        };
        assert_eq!(
            serde_json::to_value(&list).unwrap(),
            serde_json::json!({
                "devices": [{
                    "id": "a-0123456789",
                    "name": "imac",
                    "named": false,
                    "computerName": "iMac",
                    "model": "iMac",
                    "kind": "desktop",
                    "platform": null,
                    "appVersion": null,
                    "firstSeen": 7,
                    "lastSeen": 7,
                    "online": true,
                    "shell": true,
                    "browser": false,
                    "chrome": false,
                }],
                "unnamedHosts": 1,
            })
        );
    }

    #[test]
    fn the_parameters_read_as_the_client_sends_them() {
        let rename: RenameHostDeviceParams =
            serde_json::from_str(r#"{"id":"a-0123456789","name":"desktop"}"#).unwrap();
        assert_eq!((rename.id.as_str(), rename.name.as_str()), ("a-0123456789", "desktop"));
        let forget: ForgetHostDeviceParams =
            serde_json::from_str(r#"{"id":"a-0123456789"}"#).unwrap();
        assert_eq!(forget.id, "a-0123456789");
    }

    #[test]
    fn how_long_ago_reads() {
        let now = 1_000_000_000_000;
        assert_eq!(ago(now - 10_000, now), "just now");
        assert_eq!(ago(now - 60_000, now), "a minute ago");
        assert_eq!(ago(now - 5 * 60_000, now), "5 minutes ago");
        assert_eq!(ago(now - 90 * 60_000, now), "an hour ago");
        assert_eq!(ago(now - 5 * 3_600_000, now), "5 hours ago");
        assert_eq!(ago(now - 30 * 3_600_000, now), "a day ago");
        assert_eq!(ago(now - 3 * 86_400_000, now), "3 days ago");
        assert_eq!(ago(0, now), "a long time ago");
    }
}
