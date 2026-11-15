//! The server's side of `ssh <device>` (`docs/devices.md` 5.1,
//! `docs/host-ssh.md` 5.3): the key it logs in with, the host keys it
//! accepts, and the `ssh` configuration that sends each of the person's
//! devices through the tunnel (`codeg-cli desktop proxy --device`).
//!
//! All of it in `<data dir>/host-ssh/` (700). The configuration has one
//! entry per device the server keeps in its book (`web::host_devices`),
//! lending or not, under the device's name: `ssh laptop` always reaches the
//! proxy, which says why it cannot go on when it cannot. The key and the host
//! keys are kept to the lendings there are: made when a desktop app lends its
//! shell, gone once none does. One line at the top of `~/.ssh/config`
//! includes it, so `ssh`, `scp`, `rsync` and `git` need nothing more.

use std::path::{Path, PathBuf};

use tokio::sync::Mutex;

use super::sshd::{generate_key, one_public_key, HOST_KEY_ALIAS};
use super::tunnel::ShellHost;

/// The old name: `ssh desktop`. Now the device called that, else the only
/// device (`docs/devices.md` 5.1).
pub const HOST_ALIAS: &str = "desktop";

const DIR: &str = "host-ssh";
const KEY: &str = "id_ed25519";
const KEY_PUB: &str = "id_ed25519.pub";
const KNOWN_HOSTS: &str = "known_hosts";
const CONFIG: &str = "config";
/// The shared connection's socket: `cm-<the device it reaches>`.
const CONTROL: &str = "cm";

/// A socket path is cut at about 104 bytes, and `ssh` adds a random suffix
/// of 17 while it sets the master up: past this, no shared connection.
const SOCKET_PATH_MAX: usize = 86;

const INCLUDE_NOTE: &str =
    "# Added by codeg-server so that `ssh <device>` reaches the computers dodoer desktop apps\n\
     # lend this workspace (docs/devices.md). It has to stay above every Host line.";

/// What the server's `ssh` configuration is written from: every device in
/// the book (`HostRegistry::ssh_plan`).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SshPlan {
    /// In the book's order.
    pub devices: Vec<SshDevice>,
    /// An app from before devices, lending its shell while the book is
    /// empty: `ssh desktop` reaches it as it did.
    pub legacy: Option<ShellHost>,
}

impl SshPlan {
    /// Whether some shell is lent now.
    pub fn lends(&self) -> bool {
        self.legacy.is_some() || self.devices.iter().any(|d| d.host_key.is_some())
    }

    /// Whether some device's entry answers to the old name.
    fn has_desktop(&self) -> bool {
        self.devices
            .iter()
            .any(|d| d.name == HOST_ALIAS || d.also_desktop)
    }
}

/// One device, as its entry in the configuration needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshDevice {
    /// Its id (`host_device`): what the proxy asks the server for.
    pub id: String,
    /// `ssh <name>` (`host_devices::is_name`).
    pub name: String,
    /// It answers to `desktop` too: the only device, and not called that.
    pub also_desktop: bool,
    /// Who `ssh` logs in as: the shell it lends now, else the one it lent
    /// last.
    pub user: Option<String>,
    /// Its shell's host key, while it lends it.
    pub host_key: Option<String>,
}

/// The name a device's host key goes by: `dodoer-<the start of its id>`.
pub fn host_key_alias(id: &str) -> String {
    format!("dodoer-{}", short_id(id))
}

fn short_id(id: &str) -> &str {
    id.get(..8).unwrap_or(id)
}

/// The files behind `ssh <device>` for one codeg-server.
pub struct ClientFiles {
    dir: PathBuf,
    /// The person's `~/.ssh/config`, where the include goes; `None` with no
    /// home to find it in.
    ssh_config: Option<PathBuf>,
    /// The `codeg-cli` the proxy runs; `None` for the one this server
    /// carries (asked when the configuration is written: it is known only
    /// once the server has set its CLI up).
    program: Option<PathBuf>,
    /// One writer at a time: the lendings changing and a tunnel opening both
    /// write.
    writing: Mutex<()>,
}

impl ClientFiles {
    pub fn new(data_dir: &Path) -> Self {
        Self::with(
            data_dir.join(DIR),
            dirs::home_dir().map(|home| home.join(".ssh").join("config")),
            None,
        )
    }

    pub fn with(dir: PathBuf, ssh_config: Option<PathBuf>, program: Option<PathBuf>) -> Self {
        Self {
            dir,
            ssh_config,
            program,
            writing: Mutex::new(()),
        }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Everything `ssh <device>` needs for `plan`: while some shell is lent, a
    /// key (kept while there is one) and the host keys; the configuration
    /// and the include. With nothing lent the configuration is still kept
    /// current — a device renamed, removed — once there is one; before the
    /// first lending nothing is made.
    pub async fn prepare(&self, plan: &SshPlan) -> Result<(), String> {
        let config = self.dir.join(CONFIG);
        let lends = plan.lends();
        if !lends && !config.is_file() {
            return Ok(());
        }
        let _one = self.writing.lock().await;
        private_dir(&self.dir)?;
        if lends {
            let key = self.dir.join(KEY);
            let public = self.dir.join(KEY_PUB);
            if !key.is_file() || !public.is_file() {
                // `ssh-keygen` asks before it overwrites, and nobody would answer.
                let _ = std::fs::remove_file(&key);
                let _ = std::fs::remove_file(&public);
                generate_key(&key, "codeg-server host-ssh")
                    .await
                    .map_err(|e| e.to_string())?;
            }
            write_private(&self.dir.join(KNOWN_HOSTS), &known_hosts(plan))?;
        }
        let program = self.program.clone().unwrap_or_else(cli_program);
        write_private(&config, &config_text(&self.dir, plan, &program)?)?;
        if let Some(ssh_config) = &self.ssh_config {
            include(ssh_config, &config)?;
        }
        Ok(())
    }

    /// The public half of the key, for the desktop to let in.
    pub fn public_key(&self) -> Result<String, String> {
        let text = std::fs::read_to_string(self.dir.join(KEY_PUB))
            .map_err(|e| format!("reading the client key: {e}"))?;
        one_public_key(&text).ok_or_else(|| "the client key is not a public key".to_string())
    }

    /// No device lends its shell any more: the key and the host keys go;
    /// the configuration stays, for `ssh <device>` to say why.
    pub async fn forget(&self) {
        let _one = self.writing.lock().await;
        for name in [KEY, KEY_PUB, KNOWN_HOSTS] {
            let _ = std::fs::remove_file(self.dir.join(name));
        }
    }
}

/// The `codeg-cli` this server carries: the one it puts on its agents' PATH
/// (`cli_run::shim`), else the one they are told of, else whatever PATH has.
fn cli_program() -> PathBuf {
    crate::cli_run::shim::layout()
        .map(|layout| layout.program().to_path_buf())
        .or_else(|| std::env::var_os(crate::cli_run::shim::CLI_ENV).map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("codeg-cli"))
}

/// A path as an `ssh_config` value: quoted, and its `%` kept from being read
/// as a token. `None` for one a quoted value cannot hold.
fn config_path(path: &Path) -> Option<String> {
    let text = path.to_str()?;
    if text.contains(['"', '\n', '\r']) {
        return None;
    }
    Some(format!("\"{}\"", text.replace('%', "%%")))
}

/// One line per shell lent: each device's host key under its own name, so
/// that a device can only show its own.
fn known_hosts(plan: &SshPlan) -> String {
    let mut known = String::new();
    for device in &plan.devices {
        if let Some(key) = &device.host_key {
            known.push_str(&format!("{} {}\n", host_key_alias(&device.id), key.trim()));
        }
    }
    if let Some(legacy) = &plan.legacy {
        known.push_str(&format!("{HOST_KEY_ALIAS} {}\n", legacy.host_key.trim()));
    }
    known
}

/// The shared connection's socket for an app from before devices, by its
/// host key: when the computer it reaches changes, the next `ssh desktop`
/// must not ride the connection still open to the last.
fn control_name(host_key: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(host_key.trim().as_bytes());
    let short: String = digest.iter().take(4).map(|b| format!("{b:02x}")).collect();
    format!("{CONTROL}-{short}")
}

/// One `Host` entry.
struct Entry<'a> {
    /// The names on its `Host` line.
    names: String,
    /// What its host key goes by.
    alias: String,
    user: Option<&'a str>,
    /// What follows `desktop proxy`: ` --device <id>`, or nothing.
    device_arg: String,
    /// Its shared connection's socket; `None` for none.
    control: Option<String>,
}

fn config_text(dir: &Path, plan: &SshPlan, program: &Path) -> Result<String, String> {
    let program_text = program
        .to_str()
        .filter(|p| !p.contains(['\n', '\r']))
        .ok_or_else(|| format!("{} cannot go into an ssh configuration", program.display()))?;
    // `ssh` runs it with the shell, after reading its `%` tokens.
    let proxy = crate::git_credential::sh_single_quote(program_text).replace('%', "%%");
    let mut text = String::from(
        "# Written by codeg-server: `ssh <device>` reaches that one of the person's computers\n\
         # through codeg-server and the dodoer desktop app on it (docs/devices.md). Rewritten\n\
         # whenever the devices change, so edits here do not last.\n",
    );
    for device in &plan.devices {
        let names = if device.also_desktop {
            format!("{} {HOST_ALIAS}", device.name)
        } else {
            device.name.clone()
        };
        text.push_str(&per_conversation(dir, &names, &device.id)?);
        text.push_str(&entry(
            dir,
            &proxy,
            Entry {
                names,
                alias: host_key_alias(&device.id),
                user: device.user.as_deref().filter(|u| plain_user(u)),
                device_arg: format!(" --device {}", device.id),
                control: Some(format!("{CONTROL}-{}", short_id(&device.id))),
            },
        )?);
    }
    if let Some(legacy) = &plan.legacy {
        text.push_str(&entry(
            dir,
            &proxy,
            Entry {
                names: HOST_ALIAS.to_string(),
                alias: HOST_KEY_ALIAS.to_string(),
                user: Some(legacy.user.as_str()).filter(|u| plain_user(u)),
                device_arg: String::new(),
                control: Some(control_name(&legacy.host_key)),
            },
        )?);
    } else if !plan.has_desktop() {
        // The old name, meaning no one device: the proxy asks, and the
        // server says why (several devices, or none lending).
        text.push_str(&entry(
            dir,
            &proxy,
            Entry {
                names: HOST_ALIAS.to_string(),
                alias: HOST_KEY_ALIAS.to_string(),
                user: None,
                device_arg: String::new(),
                control: None,
            },
        )?);
    }
    text.push_str("# Every host again, for whatever follows the line that includes this.\nHost *\n");
    Ok(text)
}

/// A login name fit for a `User` line as it is.
fn plain_user(user: &str) -> bool {
    !user.is_empty()
        && user.len() <= 64
        && user
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
}

/// How long a connection id is (a UUID), as `CODEG_CLI_CALLER` carries it.
const CALLER_LEN: usize = 36;

/// Each conversation's own shared connection to a device, for an `ssh` in
/// an agent's shell (`CODEG_CLI_CALLER`): without it, one conversation's
/// `ssh` would ride in on another's connection, past the server's check
/// (`docs/devices.md` 5.1, 6.5). Read before the device's own entry, so its
/// `ControlPath` is the one `ssh` takes. Nothing when the socket's path would
/// be too long: then the device's one is shared.
fn per_conversation(dir: &Path, names: &str, id: &str) -> Result<String, String> {
    let caller = crate::cli_run::CLI_CALLER_ENV;
    let socket = format!("{CONTROL}-{}-", short_id(id));
    if dir.join(&socket).as_os_str().len() + CALLER_LEN > SOCKET_PATH_MAX {
        return Ok(String::new());
    }
    let path = config_path(&dir.join(format!("{socket}${{{caller}}}")))
        .ok_or_else(|| format!("{} cannot go into an ssh configuration", dir.display()))?;
    Ok(format!(
        "Match originalhost {} exec \"printenv {caller} >/dev/null\"\n  ControlPath {path}\n",
        names.replace(' ', ",")
    ))
}

fn entry(dir: &Path, proxy: &str, entry: Entry<'_>) -> Result<String, String> {
    let path = |name: &str| {
        config_path(&dir.join(name))
            .ok_or_else(|| format!("{} cannot go into an ssh configuration", dir.display()))
    };
    let multiplex = match &entry.control {
        Some(socket) if dir.join(socket).as_os_str().len() <= SOCKET_PATH_MAX => format!(
            "  ControlMaster auto\n  ControlPath {}\n  ControlPersist 10m\n",
            path(socket)?
        ),
        _ => "  ControlMaster no\n".to_string(),
    };
    let user = entry
        .user
        .map(|user| format!("  User {user}\n"))
        .unwrap_or_default();
    Ok(format!(
        "Host {names}\n\
         \x20 HostName {alias}\n\
         \x20 HostKeyAlias {alias}\n\
         {user}\
         \x20 IdentityFile {key}\n\
         \x20 IdentitiesOnly yes\n\
         \x20 IdentityAgent none\n\
         \x20 UserKnownHostsFile {known}\n\
         \x20 GlobalKnownHostsFile /dev/null\n\
         \x20 StrictHostKeyChecking yes\n\
         \x20 UpdateHostKeys no\n\
         \x20 ProxyCommand {proxy} desktop proxy{device_arg}\n\
         {multiplex}\
         \x20 ServerAliveInterval 30\n\
         \x20 ServerAliveCountMax 3\n",
        names = entry.names,
        alias = entry.alias,
        device_arg = entry.device_arg,
        key = path(KEY)?,
        known = path(KNOWN_HOSTS)?,
    ))
}

/// Put `Include <ours>` at the top of `ssh_config`, unless it is there.
/// Through a symlink to the file it names; the rest of the file untouched.
fn include(ssh_config: &Path, ours: &Path) -> Result<(), String> {
    let line = format!(
        "Include {}",
        config_path(ours).ok_or_else(|| format!("{} cannot be included", ours.display()))?
    );
    let file = std::fs::canonicalize(ssh_config).unwrap_or_else(|_| ssh_config.to_path_buf());
    let existing = match std::fs::read_to_string(&file) {
        Ok(text) => Some(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(format!("reading {}: {e}", file.display())),
    };
    if existing
        .as_deref()
        .is_some_and(|text| text.lines().any(|l| l.trim() == line))
    {
        return Ok(());
    }
    let parent = file
        .parent()
        .ok_or_else(|| format!("{} has no folder", file.display()))?;
    if !parent.is_dir() {
        private_dir(parent)?;
    }
    let text = match &existing {
        Some(rest) => format!("{INCLUDE_NOTE}\n{line}\n\n{rest}"),
        None => format!("{INCLUDE_NOTE}\n{line}\n"),
    };
    let mode = existing_mode(&file).unwrap_or(0o600);
    let staged = parent.join(format!(
        ".{}.codeg-{}",
        file.file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_else(|| "config".into()),
        std::process::id()
    ));
    std::fs::write(&staged, text).map_err(|e| format!("writing {}: {e}", staged.display()))?;
    set_mode(&staged, mode);
    std::fs::rename(&staged, &file).map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        format!("replacing {}: {e}", file.display())
    })?;
    tracing::info!("[host-ssh] {} now includes {}", file.display(), ours.display());
    Ok(())
}

fn private_dir(dir: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dir).map_err(|e| format!("creating {}: {e}", dir.display()))?;
    set_mode(dir, 0o700);
    Ok(())
}

/// Write `text` to `file` (600) whole: an `ssh` starting meanwhile reads the
/// old file or the new one, never half of one. Left alone when it says so
/// already.
fn write_private(file: &Path, text: &str) -> Result<(), String> {
    if std::fs::read_to_string(file).is_ok_and(|old| old == text) {
        set_mode(file, 0o600);
        return Ok(());
    }
    let staged = file.with_extension(format!("codeg-{}", std::process::id()));
    std::fs::write(&staged, text).map_err(|e| format!("writing {}: {e}", staged.display()))?;
    set_mode(&staged, 0o600);
    std::fs::rename(&staged, file).map_err(|e| {
        let _ = std::fs::remove_file(&staged);
        format!("writing {}: {e}", file.display())
    })
}

fn existing_mode(file: &Path) -> Option<u32> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::metadata(file)
            .ok()
            .map(|m| m.permissions().mode() & 0o777)
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        None
    }
}

fn set_mode(path: &Path, mode: u32) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode));
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn host(user: &str, key: &str) -> ShellHost {
        ShellHost {
            host_key: key.to_string(),
            user: user.to_string(),
            platform: Some("macos".into()),
        }
    }

    const KEY_A: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA";
    const KEY_B: &str = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBBB";
    const ID_A: &str = "aaaa1111bbbb2222cccc3333dddd4444";
    const ID_B: &str = "eeee5555ffff6666aaaa7777bbbb8888";

    fn device(id: &str, name: &str, user: Option<&str>, key: Option<&str>) -> SshDevice {
        SshDevice {
            id: id.to_string(),
            name: name.to_string(),
            also_desktop: false,
            user: user.map(str::to_string),
            host_key: key.map(str::to_string),
        }
    }

    fn written(plan: &SshPlan) -> String {
        config_text(
            Path::new("/srv/data/host-ssh"),
            plan,
            Path::new("/opt/codeg/codeg-cli"),
        )
        .unwrap()
    }

    /// The entry under a `Host` line, up to the next one.
    fn entry_of<'a>(text: &'a str, host_line: &str) -> &'a str {
        let start = text
            .find(&format!("Host {host_line}\n"))
            .unwrap_or_else(|| panic!("no `Host {host_line}` in:\n{text}"));
        let rest = &text[start + 1..];
        let end = rest.find("\nHost ").map_or(rest.len(), |at| at + 1);
        &text[start..start + 1 + end]
    }

    /// An agent's `ssh` gets its conversation's own shared connection, read
    /// before the device's; from a short enough directory only.
    #[test]
    fn each_conversation_has_its_own_shared_connection() {
        let plan = SshPlan {
            devices: vec![SshDevice {
                also_desktop: true,
                ..device(ID_A, "imac", Some("me"), Some(KEY_A))
            }],
            legacy: None,
        };
        let text = written(&plan);
        let own =
            "Match originalhost imac,desktop exec \"printenv CODEG_CLI_CALLER >/dev/null\"\n  \
                   ControlPath \"/srv/data/host-ssh/cm-aaaa1111-${CODEG_CLI_CALLER}\"\n";
        let at = text.find(own).unwrap_or_else(|| panic!("{text}"));
        assert!(at < text.find("Host imac desktop\n").unwrap());

        let deep = Path::new("/a/very/long/data/directory/that/goes/on/and/on/host-ssh");
        let text = config_text(deep, &plan, Path::new("/opt/codeg/codeg-cli")).unwrap();
        assert!(!text.contains("Match originalhost"), "{text}");
        assert!(text.contains("Host imac desktop\n"));
    }

    #[test]
    fn each_device_goes_through_the_proxy_under_its_own_name() {
        let plan = SshPlan {
            devices: vec![
                device(ID_A, "imac", Some("me"), Some(KEY_A)),
                device(ID_B, "laptop", Some("me2"), None),
            ],
            legacy: None,
        };
        let text = written(&plan);
        let imac = entry_of(&text, "imac");
        assert!(imac.contains("  HostName dodoer-aaaa1111\n"));
        assert!(imac.contains("  HostKeyAlias dodoer-aaaa1111\n"));
        assert!(imac.contains("  User me\n"));
        assert!(imac.contains("  IdentityFile \"/srv/data/host-ssh/id_ed25519\"\n"));
        assert!(imac.contains("  UserKnownHostsFile \"/srv/data/host-ssh/known_hosts\"\n"));
        assert!(imac.contains("  StrictHostKeyChecking yes\n"));
        assert!(imac.contains(&format!(
            "  ProxyCommand '/opt/codeg/codeg-cli' desktop proxy --device {ID_A}\n"
        )));
        assert!(imac.contains("  ControlPath \"/srv/data/host-ssh/cm-aaaa1111\"\n"));
        // Not lending now: still there, logging in as it did last.
        let laptop = entry_of(&text, "laptop");
        assert!(laptop.contains("  User me2\n"));
        assert!(laptop.contains(&format!("desktop proxy --device {ID_B}\n")));
        assert!(laptop.contains("cm-eeee5555"));
        // Two devices and neither called `desktop`: the old name asks the
        // server, which says which there are.
        let desktop = entry_of(&text, "desktop");
        assert!(desktop.contains("  ProxyCommand '/opt/codeg/codeg-cli' desktop proxy\n"));
        assert!(desktop.contains("  ControlMaster no\n"));
        assert!(!desktop.contains("  User "));
        assert!(
            text.trim_end().ends_with("Host *"),
            "what follows the include is for every host again"
        );

        assert_eq!(
            known_hosts(&plan),
            format!("dodoer-aaaa1111 {KEY_A}\n"),
            "only what is lent now"
        );
    }

    #[test]
    fn the_old_name_is_the_device_called_desktop_or_the_only_one() {
        let only = SshPlan {
            devices: vec![SshDevice {
                also_desktop: true,
                ..device(ID_A, "imac", Some("me"), Some(KEY_A))
            }],
            legacy: None,
        };
        let text = written(&only);
        assert!(text.contains("Host imac desktop\n"));
        assert_eq!(text.matches("Host ").count(), 2, "imac, and every host:\n{text}");

        let called = SshPlan {
            devices: vec![
                device(ID_A, "desktop", Some("me"), Some(KEY_A)),
                device(ID_B, "laptop", None, None),
            ],
            legacy: None,
        };
        let text = written(&called);
        assert_eq!(text.matches("Host desktop").count(), 1);
        assert!(entry_of(&text, "desktop").contains(&format!("--device {ID_A}\n")));
        // Never lent: no login name to give.
        assert!(!entry_of(&text, "laptop").contains("  User "));
    }

    /// An app from before devices, while the book is empty: `ssh desktop` as
    /// it was.
    #[test]
    fn an_app_from_before_devices_is_desktop_as_before() {
        let plan = SshPlan {
            devices: Vec::new(),
            legacy: Some(host("me", KEY_A)),
        };
        let text = written(&plan);
        let desktop = entry_of(&text, "desktop");
        assert!(desktop.contains("  User me\n"));
        assert!(desktop.contains("  HostKeyAlias dodoer-desktop\n"));
        assert!(desktop.contains("  ProxyCommand '/opt/codeg/codeg-cli' desktop proxy\n"));
        let control = control_name(KEY_A);
        assert!(control.starts_with("cm-") && control.len() == "cm-".len() + 8);
        assert!(desktop.contains(&format!("  ControlPath \"/srv/data/host-ssh/{control}\"\n")));
        assert_ne!(control_name(KEY_B), control);
        assert_eq!(control_name(&format!(" {KEY_A}\n")), control);
        assert_eq!(known_hosts(&plan), format!("dodoer-desktop {KEY_A}\n"));
    }

    #[test]
    fn a_long_folder_gets_no_shared_connection_and_odd_paths_are_kept_whole() {
        let plan = SshPlan {
            devices: vec![device(ID_A, "imac", Some("me"), Some(KEY_A))],
            legacy: None,
        };
        let long = PathBuf::from(format!("/{}", "d".repeat(120)));
        let text = config_text(&long, &plan, Path::new("/usr/bin/codeg-cli")).unwrap();
        assert!(text.contains("ControlMaster no"));
        assert!(!text.contains("ControlPath"));

        let odd = config_text(
            Path::new("/data/50%/host-ssh"),
            &plan,
            Path::new("/opt/it's/codeg-cli"),
        )
        .unwrap();
        assert!(odd.contains("IdentityFile \"/data/50%%/host-ssh/id_ed25519\""));
        assert!(odd.contains(&format!(
            r#"ProxyCommand '/opt/it'\''s/codeg-cli' desktop proxy --device {ID_A}"#
        )));
        assert!(config_text(Path::new("/a\"b"), &plan, Path::new("/x")).is_err());
    }

    #[test]
    fn the_include_goes_on_top_once_and_keeps_the_rest() {
        let home = tempfile::tempdir().unwrap();
        let ssh_config = home.path().join(".ssh").join("config");
        let ours = home.path().join("data").join("host-ssh").join("config");

        // No `~/.ssh` at all: made, private.
        include(&ssh_config, &ours).unwrap();
        let first = std::fs::read_to_string(&ssh_config).unwrap();
        assert!(first.contains(&format!("Include \"{}\"", ours.display())));
        assert_eq!(existing_mode(&ssh_config), Some(0o600));
        assert_eq!(existing_mode(ssh_config.parent().unwrap()), Some(0o700));

        // A file of the person's own: the include above it, the rest as was.
        std::fs::write(&ssh_config, "Host work\n  User someone\n").unwrap();
        set_mode(&ssh_config, 0o644);
        include(&ssh_config, &ours).unwrap();
        let text = std::fs::read_to_string(&ssh_config).unwrap();
        let include_at = text.find("Include ").unwrap();
        assert!(include_at < text.find("Host work").unwrap());
        assert!(text.ends_with("Host work\n  User someone\n"));
        assert_eq!(existing_mode(&ssh_config), Some(0o644), "its mode kept");

        // Again: nothing changes.
        include(&ssh_config, &ours).unwrap();
        assert_eq!(std::fs::read_to_string(&ssh_config).unwrap(), text);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_ssh_config_keeps_its_link() {
        let home = tempfile::tempdir().unwrap();
        let dotfiles = home.path().join("dotfiles");
        std::fs::create_dir_all(&dotfiles).unwrap();
        let target = dotfiles.join("ssh_config");
        std::fs::write(&target, "Host a\n").unwrap();
        std::fs::create_dir_all(home.path().join(".ssh")).unwrap();
        let link = home.path().join(".ssh").join("config");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        include(&link, Path::new("/data/host-ssh/config")).unwrap();
        assert!(std::fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert!(std::fs::read_to_string(&target)
            .unwrap()
            .contains("Include \"/data/host-ssh/config\""));
    }

    /// With `ssh-keygen` there (CI's server job, Linux and macOS desktops):
    /// nothing before the first lending; the whole set made then, the key
    /// kept across a second prepare; with nothing lent the configuration
    /// still follows the devices; the keys gone after `forget`, the
    /// configuration left.
    #[tokio::test]
    async fn prepare_makes_the_set_and_forget_takes_the_keys() {
        if !Path::new("/usr/bin/ssh-keygen").is_file() {
            assert!(
                !super::super::sshd::test_needs_sshd(),
                "no ssh-keygen on this machine"
            );
            return;
        }
        let home = tempfile::tempdir().unwrap();
        let data = tempfile::tempdir().unwrap();
        let files = ClientFiles::with(
            data.path().join(DIR),
            Some(home.path().join(".ssh").join("config")),
            Some(PathBuf::from("/opt/codeg/codeg-cli")),
        );
        // Devices, none lending yet: nothing made.
        let unlent = SshPlan {
            devices: vec![device(ID_A, "imac", None, None)],
            legacy: None,
        };
        files.prepare(&SshPlan::default()).await.unwrap();
        files.prepare(&unlent).await.unwrap();
        assert!(!files.dir().exists());

        files
            .prepare(&SshPlan {
                devices: vec![
                    device(ID_A, "imac", Some("me"), Some(KEY_A)),
                    device(ID_B, "laptop", Some("other"), Some(KEY_B)),
                ],
                legacy: None,
            })
            .await
            .unwrap();
        let public = files.public_key().unwrap();
        assert!(public.starts_with("ssh-ed25519 "));
        let known = std::fs::read_to_string(files.dir().join(KNOWN_HOSTS)).unwrap();
        assert_eq!(
            known,
            format!("dodoer-aaaa1111 {KEY_A}\ndodoer-eeee5555 {KEY_B}\n")
        );
        let config = std::fs::read_to_string(files.dir().join(CONFIG)).unwrap();
        assert!(entry_of(&config, "imac").contains("  User me\n"));
        assert!(entry_of(&config, "laptop").contains("  User other\n"));
        assert_eq!(existing_mode(&files.dir().join(KEY)), Some(0o600));
        assert_eq!(existing_mode(files.dir()), Some(0o700));
        assert!(std::fs::read_to_string(home.path().join(".ssh").join("config"))
            .unwrap()
            .contains("Include "));

        files
            .prepare(&SshPlan {
                devices: vec![device(ID_A, "imac", Some("me"), Some(KEY_A))],
                legacy: None,
            })
            .await
            .unwrap();
        assert_eq!(files.public_key().unwrap(), public, "the key stays");

        // Renamed while nothing is lent: the configuration follows.
        files
            .prepare(&SshPlan {
                devices: vec![device(ID_A, "study", Some("me"), None)],
                legacy: None,
            })
            .await
            .unwrap();
        let config = std::fs::read_to_string(files.dir().join(CONFIG)).unwrap();
        assert!(config.contains("Host study\n") && !config.contains("Host imac"));

        files.forget().await;
        assert!(files.public_key().is_err());
        assert!(!files.dir().join(KNOWN_HOSTS).exists());
        assert!(files.dir().join(CONFIG).exists());
    }
}
