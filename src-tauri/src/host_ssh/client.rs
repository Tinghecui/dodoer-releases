//! The server's side of `ssh desktop` (`docs/host-ssh.md` 5.3): the key it
//! logs in with, the host keys it accepts, and the `ssh` configuration that
//! sends `desktop` through the tunnel (`codeg-cli desktop proxy`).
//!
//! All of it in `<data dir>/host-ssh/` (700), kept to the lendings there
//! are: made when a desktop app lends its shell, the key and host keys gone
//! once none does. The configuration stays — with no lending, `ssh desktop`
//! reaches the proxy, which says what the person can do about it. One line
//! at the top of `~/.ssh/config` includes it, so `ssh desktop`, `scp`,
//! `rsync` and `git` need nothing more.

use std::path::{Path, PathBuf};

use tokio::sync::Mutex;

use super::sshd::{generate_key, one_public_key, HOST_KEY_ALIAS};
use super::tunnel::ShellHost;

/// The name agents use: `ssh desktop`.
pub const HOST_ALIAS: &str = "desktop";

const DIR: &str = "host-ssh";
const KEY: &str = "id_ed25519";
const KEY_PUB: &str = "id_ed25519.pub";
const KNOWN_HOSTS: &str = "known_hosts";
const CONFIG: &str = "config";
const CONTROL: &str = "cm";

/// A socket path is cut at about 104 bytes, and `ssh` adds a random suffix
/// of 17 while it sets the master up: past this, no shared connection.
const SOCKET_PATH_MAX: usize = 86;

const INCLUDE_NOTE: &str =
    "# Added by codeg-server so that `ssh desktop` reaches the computer a dodoer desktop app\n\
     # lends this workspace (docs/host-ssh.md). It has to stay above every Host line.";

/// The files behind `ssh desktop` for one codeg-server.
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

    /// Everything `ssh desktop` needs while `hosts` lend their shells, the
    /// one used last first: a key (kept while there is one), their host keys,
    /// the configuration (logging in as the first), the include.
    pub async fn prepare(&self, hosts: &[ShellHost]) -> Result<(), String> {
        let Some(newest) = hosts.iter().find(|host| host.is_sound()) else {
            return Ok(());
        };
        let _one = self.writing.lock().await;
        private_dir(&self.dir)?;
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
        let known: String = hosts
            .iter()
            .filter(|host| host.is_sound())
            .map(|host| format!("{HOST_KEY_ALIAS} {}\n", host.host_key.trim()))
            .collect();
        write_private(&self.dir.join(KNOWN_HOSTS), &known)?;
        let program = self.program.clone().unwrap_or_else(cli_program);
        write_private(
            &self.dir.join(CONFIG),
            &config_text(&self.dir, &newest.user, &program)?,
        )?;
        if let Some(ssh_config) = &self.ssh_config {
            include(ssh_config, &self.dir.join(CONFIG))?;
        }
        Ok(())
    }

    /// The public half of the key, for the desktop to let in.
    pub fn public_key(&self) -> Result<String, String> {
        let text = std::fs::read_to_string(self.dir.join(KEY_PUB))
            .map_err(|e| format!("reading the client key: {e}"))?;
        one_public_key(&text).ok_or_else(|| "the client key is not a public key".to_string())
    }

    /// No desktop lends its shell any more: the key and the host keys go.
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

fn config_text(dir: &Path, user: &str, program: &Path) -> Result<String, String> {
    let path = |name: &str| {
        config_path(&dir.join(name))
            .ok_or_else(|| format!("{} cannot go into an ssh configuration", dir.display()))
    };
    let program_text = program
        .to_str()
        .filter(|p| !p.contains(['\n', '\r']))
        .ok_or_else(|| format!("{} cannot go into an ssh configuration", program.display()))?;
    // `ssh` runs it with the shell, after reading its `%` tokens.
    let proxy = crate::git_credential::sh_single_quote(program_text).replace('%', "%%");
    let control = dir.join(CONTROL);
    let multiplex = if control.as_os_str().len() <= SOCKET_PATH_MAX {
        format!(
            "  ControlMaster auto\n  ControlPath {}\n  ControlPersist 10m\n",
            path(CONTROL)?
        )
    } else {
        "  ControlMaster no\n".to_string()
    };
    Ok(format!(
        "# Written by codeg-server: `ssh desktop` reaches the computer a dodoer desktop app\n\
         # lends this workspace, through codeg-server (docs/host-ssh.md). Rewritten whenever\n\
         # that changes, so edits here do not last.\n\
         Host {HOST_ALIAS}\n\
         \x20 HostName {HOST_KEY_ALIAS}\n\
         \x20 HostKeyAlias {HOST_KEY_ALIAS}\n\
         \x20 User {user}\n\
         \x20 IdentityFile {key}\n\
         \x20 IdentitiesOnly yes\n\
         \x20 IdentityAgent none\n\
         \x20 UserKnownHostsFile {known}\n\
         \x20 GlobalKnownHostsFile /dev/null\n\
         \x20 StrictHostKeyChecking yes\n\
         \x20 UpdateHostKeys no\n\
         \x20 ProxyCommand {proxy} desktop proxy\n\
         {multiplex}\
         \x20 ServerAliveInterval 30\n\
         \x20 ServerAliveCountMax 3\n\
         # Every host again, for whatever follows the line that includes this.\n\
         Host *\n",
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

    #[test]
    fn the_configuration_sends_desktop_through_the_proxy() {
        let text = config_text(
            Path::new("/srv/data/host-ssh"),
            "me",
            Path::new("/opt/codeg/codeg-cli"),
        )
        .unwrap();
        assert!(text.contains("Host desktop\n"));
        assert!(text.contains("  User me\n"));
        assert!(text.contains("  HostKeyAlias dodoer-desktop\n"));
        assert!(text.contains("  IdentityFile \"/srv/data/host-ssh/id_ed25519\"\n"));
        assert!(text.contains("  UserKnownHostsFile \"/srv/data/host-ssh/known_hosts\"\n"));
        assert!(text.contains("  StrictHostKeyChecking yes\n"));
        assert!(text.contains("  ProxyCommand '/opt/codeg/codeg-cli' desktop proxy\n"));
        assert!(text.contains("  ControlPath \"/srv/data/host-ssh/cm\"\n"));
        assert!(
            text.trim_end().ends_with("Host *"),
            "what follows the include is for every host again"
        );
    }

    #[test]
    fn a_long_folder_gets_no_shared_connection_and_odd_paths_are_kept_whole() {
        let long = PathBuf::from(format!("/{}", "d".repeat(120)));
        let text = config_text(&long, "me", Path::new("/usr/bin/codeg-cli")).unwrap();
        assert!(text.contains("ControlMaster no"));
        assert!(!text.contains("ControlPath"));

        let odd = config_text(
            Path::new("/data/50%/host-ssh"),
            "me",
            Path::new("/opt/it's/codeg-cli"),
        )
        .unwrap();
        assert!(odd.contains("IdentityFile \"/data/50%%/host-ssh/id_ed25519\""));
        assert!(odd.contains(r#"ProxyCommand '/opt/it'\''s/codeg-cli' desktop proxy"#));
        assert!(config_text(Path::new("/a\"b"), "me", Path::new("/x")).is_err());
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
    /// the whole set made, the key kept across a second prepare, gone after
    /// `forget` but the configuration left.
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
        // Nothing lent: nothing made.
        files.prepare(&[]).await.unwrap();
        assert!(!files.dir().exists());

        files
            .prepare(&[host("me", KEY_A), host("other", KEY_B)])
            .await
            .unwrap();
        let public = files.public_key().unwrap();
        assert!(public.starts_with("ssh-ed25519 "));
        let known = std::fs::read_to_string(files.dir().join(KNOWN_HOSTS)).unwrap();
        assert_eq!(known, format!("dodoer-desktop {KEY_A}\ndodoer-desktop {KEY_B}\n"));
        let config = std::fs::read_to_string(files.dir().join(CONFIG)).unwrap();
        assert!(config.contains("  User me\n"), "the newest host's login");
        assert_eq!(existing_mode(&files.dir().join(KEY)), Some(0o600));
        assert_eq!(existing_mode(files.dir()), Some(0o700));
        assert!(std::fs::read_to_string(home.path().join(".ssh").join("config"))
            .unwrap()
            .contains("Include "));

        files.prepare(&[host("me", KEY_A)]).await.unwrap();
        assert_eq!(files.public_key().unwrap(), public, "the key stays");

        files.forget().await;
        assert!(files.public_key().is_err());
        assert!(!files.dir().join(KNOWN_HOSTS).exists());
        assert!(files.dir().join(CONFIG).exists());
    }
}
