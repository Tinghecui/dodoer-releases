//! The SSH service behind a lending: the system's own `sshd`, run as the
//! person, listening on loopback only, with keys made for this run
//! (`docs/host-ssh.md` 5.1).
//!
//! Nothing here touches the system's Remote Login, `/etc/ssh` or `~/.ssh`:
//! the configuration, the host key and the list of keys allowed in all live
//! in a private temporary folder that goes when the service stops.
//!
//! Ending the service ends the listener. A session already open is a process
//! of its own session and outlives it, as with any `sshd`; what ends those is
//! their connection closing, and every connection but the self-test's comes
//! through this app (`docs/host-ssh.md` 5.2).

use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, Instant};

use serde::Serialize;
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::Mutex;

const SSHD: &str = "/usr/sbin/sshd";
const SSH: &str = "/usr/bin/ssh";
const SSH_KEYGEN: &str = "/usr/bin/ssh-keygen";

/// The watcher's pid and the service's folder, for the next launch to clear
/// away if this one never got to (`stop_survivor`).
const PID_FILE: &str = "host-ssh.pid";
/// What the watcher goes by in `ps`, so a reused pid is never taken for it.
const WATCHER_NAME: &str = "dodoer-sshd";
/// Runs `sshd` and ends it when this app does, however this app ends: the
/// app holds the other end of the watcher's stdin, and `cat` returns when
/// that closes. Without it a killed app would leave `sshd` listening.
const WATCHER: &str =
    r#"exec 3<&0; "$@" & pid=$!; (cat <&3 >/dev/null; kill "$pid" 2>/dev/null) & wait "$pid""#;

const TEMP_PREFIX: &str = "dodoer-ssh.";
/// Where the service's folder is made: `/tmp`, not this process's temporary
/// folder. An app started from a codeg terminal inherits that terminal's
/// `TMPDIR`, a launch folder of another codeg process that a sweep may take
/// away (`acp::scratch_dir`) — and `authorized_keys` with it, under a running
/// service. The folder itself is the person's alone (700, a random name).
const RUN_ROOT: &str = "/tmp";
/// The name the host key is filed under on the other side, whatever port
/// this run listens on.
pub const HOST_KEY_ALIAS: &str = "dodoer-desktop";

const START_TIMEOUT: Duration = Duration::from_secs(8);
const STOP_TIMEOUT: Duration = Duration::from_secs(2);
const KEYGEN_TIMEOUT: Duration = Duration::from_secs(15);
const SELF_TEST_TIMEOUT: Duration = Duration::from_secs(20);
const LOGIN_PATH_TIMEOUT: Duration = Duration::from_secs(10);
const LOG_LINES: usize = 20;

/// What the self-test asks the session: that it runs commands at all, and
/// which of the tools a person usually installs it can find. Through
/// `/bin/sh` whatever the login shell is.
const SELF_TEST_OK: &str = "dodoer-ok";
const SELF_TEST_COMMAND: &str = r#"/bin/sh -c 'echo dodoer-ok; for t in git node python3 brew cargo; do command -v "$t" >/dev/null 2>&1 && echo "$t"; done; true'"#;

#[derive(Debug, thiserror::Error)]
pub enum SshdError {
    #[error("this system has no sshd this app can run")]
    Unsupported,
    #[error("could not prepare the SSH service: {0}")]
    Setup(String),
    #[error("sshd exited at once: {0}")]
    Exited(String),
    #[error("sshd did not start listening: {0}")]
    Timeout(String),
    #[error("the SSH service is not running")]
    NotRunning,
}

/// Where the running service answers, and who it is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SshdEndpoint {
    pub port: u16,
    /// The host's public key (`ssh-ed25519 AAAA…`), made for this run.
    pub host_key: String,
    /// The login name sessions run as.
    pub user: String,
}

/// What the self-test found.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SelfTest {
    pub ok: bool,
    /// Which of `git node python3 brew cargo` a session finds.
    pub tools: Vec<String>,
    /// Why it failed, in `ssh`'s own words.
    pub detail: Option<String>,
}

struct Running {
    child: Child,
    /// Held open for the watcher: its closing is how it learns the app went.
    _stdin: Option<ChildStdin>,
    dir: tempfile::TempDir,
    endpoint: SshdEndpoint,
    /// The public keys let in, as written to `authorized_keys`.
    authorized: Vec<String>,
    log: Arc<StdMutex<VecDeque<String>>>,
}

/// The one SSH service this app runs.
pub struct Sshd {
    /// Where the pid file is kept: the app's data folder.
    state_dir: PathBuf,
    running: Mutex<Option<Running>>,
}

/// Whether this system has an `sshd` this app can run as the person.
pub fn supported() -> bool {
    cfg!(unix)
        && [SSHD, SSH, SSH_KEYGEN]
            .iter()
            .all(|program| Path::new(program).is_file())
}

impl Sshd {
    pub fn new(state_dir: PathBuf) -> Self {
        Self {
            state_dir,
            running: Mutex::new(None),
        }
    }

    /// The running service, or `None`: never started, stopped, or died since.
    pub async fn endpoint(&self) -> Option<SshdEndpoint> {
        let mut running = self.running.lock().await;
        if let Some(current) = running.as_mut() {
            if matches!(current.child.try_wait(), Ok(Some(_)) | Err(_)) {
                tracing::warn!(
                    "[host-ssh] sshd is gone{}",
                    last_lines(&current.log)
                );
                self.forget_pid();
                *running = None;
            }
        }
        running.as_ref().map(|current| current.endpoint.clone())
    }

    /// Start the service unless it runs already. `path` is the `PATH` its
    /// sessions get (`login_path`).
    pub async fn start(&self, path: Option<String>) -> Result<SshdEndpoint, SshdError> {
        if let Some(endpoint) = self.endpoint().await {
            return Ok(endpoint);
        }
        let mut running = self.running.lock().await;
        if let Some(current) = running.as_ref() {
            return Ok(current.endpoint.clone());
        }
        let launched = launch(&self.state_dir, path.as_deref()).await?;
        let endpoint = launched.endpoint.clone();
        tracing::info!(
            "[host-ssh] sshd listening on 127.0.0.1:{} as {}",
            endpoint.port,
            endpoint.user
        );
        *running = Some(launched);
        Ok(endpoint)
    }

    /// Stop the service and remove everything it was made of.
    pub async fn stop(&self) {
        let Some(running) = self.running.lock().await.take() else {
            return;
        };
        tracing::info!("[host-ssh] stopping sshd");
        end(running).await;
        self.forget_pid();
    }

    /// Let `public_key` in, until the service stops or it is revoked.
    pub async fn authorize(&self, public_key: &str) -> Result<(), SshdError> {
        let key = one_public_key(public_key)
            .ok_or_else(|| SshdError::Setup("not a public key".to_string()))?;
        let mut running = self.running.lock().await;
        let current = running.as_mut().ok_or(SshdError::NotRunning)?;
        if !current.authorized.contains(&key) {
            current.authorized.push(key);
            write_authorized(current.dir.path(), &current.authorized)?;
        }
        Ok(())
    }

    pub async fn revoke(&self, public_key: &str) {
        let Some(key) = one_public_key(public_key) else {
            return;
        };
        let mut running = self.running.lock().await;
        let Some(current) = running.as_mut() else {
            return;
        };
        let before = current.authorized.len();
        current.authorized.retain(|known| known != &key);
        if current.authorized.len() != before {
            let _ = write_authorized(current.dir.path(), &current.authorized);
        }
    }

    /// Log in once the way a lent connection will, with a key made for the
    /// test and let in only while it runs, and run one command.
    pub async fn self_test(&self) -> Result<SelfTest, SshdError> {
        let endpoint = self.endpoint().await.ok_or(SshdError::NotRunning)?;
        let dir = {
            let running = self.running.lock().await;
            match running.as_ref() {
                Some(current) => current.dir.path().to_path_buf(),
                None => return Err(SshdError::NotRunning),
            }
        };
        let key = dir.join("self_test_key");
        let public = dir.join("self_test_key.pub");
        let known_hosts = dir.join("self_test_known_hosts");
        // `ssh-keygen` asks before it overwrites, and there is nobody to ask.
        let _ = std::fs::remove_file(&key);
        let _ = std::fs::remove_file(&public);
        generate_key(&key, "dodoer-self-test").await?;
        let public_key = std::fs::read_to_string(&public)
            .map_err(|e| SshdError::Setup(format!("reading the test key: {e}")))?;
        std::fs::write(
            &known_hosts,
            format!("{HOST_KEY_ALIAS} {}\n", endpoint.host_key),
        )
        .map_err(|e| SshdError::Setup(format!("writing known_hosts: {e}")))?;
        self.authorize(&public_key).await?;

        let mut command = Command::new(SSH);
        command
            .args(["-F", "/dev/null", "-n", "-T"])
            .args(["-o", "BatchMode=yes"])
            .args(["-o", "IdentitiesOnly=yes"])
            .args(["-o", "IdentityAgent=none"])
            .args(["-o", "StrictHostKeyChecking=yes"])
            .arg("-o")
            .arg(format!("UserKnownHostsFile={}", known_hosts.display()))
            .arg("-o")
            .arg(format!("HostKeyAlias={HOST_KEY_ALIAS}"))
            .args(["-o", "ConnectTimeout=5"])
            .args(["-o", "LogLevel=ERROR"])
            .arg("-i")
            .arg(&key)
            .arg("-p")
            .arg(endpoint.port.to_string())
            .arg("-l")
            .arg(endpoint.user.as_str())
            .arg("127.0.0.1")
            .arg(SELF_TEST_COMMAND)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let outcome = tokio::time::timeout(SELF_TEST_TIMEOUT, command.output()).await;

        self.revoke(&public_key).await;
        let _ = std::fs::remove_file(&key);
        let _ = std::fs::remove_file(&public);
        let _ = std::fs::remove_file(&known_hosts);

        Ok(match outcome {
            Ok(Ok(output)) => read_self_test(
                &String::from_utf8_lossy(&output.stdout),
                &String::from_utf8_lossy(&output.stderr),
            ),
            Ok(Err(e)) => SelfTest {
                ok: false,
                tools: Vec::new(),
                detail: Some(format!("could not run ssh: {e}")),
            },
            Err(_) => SelfTest {
                ok: false,
                tools: Vec::new(),
                detail: Some(format!(
                    "no answer within {} s",
                    SELF_TEST_TIMEOUT.as_secs()
                )),
            },
        })
    }

    fn forget_pid(&self) {
        let _ = std::fs::remove_file(self.state_dir.join(PID_FILE));
    }
}

/// What the self-test's `ssh` printed, as a result.
fn read_self_test(stdout: &str, stderr: &str) -> SelfTest {
    let mut lines = stdout.lines().map(str::trim).filter(|l| !l.is_empty());
    if lines.next() == Some(SELF_TEST_OK) {
        return SelfTest {
            ok: true,
            tools: lines.map(str::to_string).collect(),
            detail: None,
        };
    }
    let said = stderr
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("the session ran nothing");
    SelfTest {
        ok: false,
        tools: Vec::new(),
        detail: Some(said.chars().take(300).collect()),
    }
}

/// `public_key` as one `authorized_keys` line: its type and its key, without
/// the comment. `None` for anything that is not a single public key — a
/// second line would be a second key, and options before the type would be
/// obeyed.
pub(crate) fn one_public_key(public_key: &str) -> Option<String> {
    let text = public_key.trim();
    if text.lines().count() != 1 {
        return None;
    }
    let mut fields = text.split_whitespace();
    let kind = fields.next()?;
    let key = fields.next()?;
    let known_kind = kind.starts_with("ssh-")
        || kind.starts_with("ecdsa-")
        || kind.starts_with("sk-");
    let base64 = !key.is_empty()
        && key
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '/' | '='));
    (known_kind && base64).then(|| format!("{kind} {key}"))
}

fn write_authorized(dir: &Path, keys: &[String]) -> Result<(), SshdError> {
    let file = dir.join("authorized_keys");
    let mut text = keys.join("\n");
    if !text.is_empty() {
        text.push('\n');
    }
    std::fs::write(&file, text)
        .map_err(|e| SshdError::Setup(format!("writing authorized_keys: {e}")))?;
    private(&file, 0o600);
    Ok(())
}

/// Keep `path` to the person alone.
fn private(path: &Path, mode: u32) {
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

pub(crate) async fn generate_key(file: &Path, comment: &str) -> Result<(), SshdError> {
    let mut command = Command::new(SSH_KEYGEN);
    command
        .args(["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f"])
        .arg(file)
        .stdin(Stdio::null())
        .kill_on_drop(true);
    let output = tokio::time::timeout(KEYGEN_TIMEOUT, command.output())
        .await
        .map_err(|_| SshdError::Setup("ssh-keygen did not finish".to_string()))?
        .map_err(|e| SshdError::Setup(format!("could not run ssh-keygen: {e}")))?;
    if !output.status.success() {
        return Err(SshdError::Setup(format!(
            "ssh-keygen: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        )));
    }
    Ok(())
}

/// The login name of whoever runs this app.
async fn login_name() -> Result<String, SshdError> {
    let mut command = Command::new("id");
    command.arg("-un").stdin(Stdio::null()).kill_on_drop(true);
    let from_id = match command.output().await {
        Ok(output) if output.status.success() => {
            Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
        }
        _ => None,
    };
    from_id
        .or_else(|| std::env::var("USER").ok())
        .filter(|name| !name.is_empty() && !name.contains(char::is_whitespace))
        .ok_or_else(|| SshdError::Setup("no login name".to_string()))
}

/// The service's whole configuration. Paths are written bare, so none may
/// hold whitespace (`launch` refuses a folder that does).
fn config_text(dir: &Path, port: u16, user: &str, path: Option<&str>) -> String {
    let dir = dir.display();
    let mut text = format!(
        "ListenAddress 127.0.0.1\n\
         Port {port}\n\
         HostKey {dir}/host_key\n\
         AuthorizedKeysFile {dir}/authorized_keys\n\
         PidFile none\n\
         UsePAM no\n\
         StrictModes no\n\
         PubkeyAuthentication yes\n\
         AuthenticationMethods publickey\n\
         PasswordAuthentication no\n\
         KbdInteractiveAuthentication no\n\
         AllowUsers {user}\n\
         AllowAgentForwarding no\n\
         X11Forwarding no\n\
         PermitTunnel no\n\
         GatewayPorts no\n\
         PrintMotd no\n\
         PrintLastLog no\n\
         UseDNS no\n\
         LogLevel INFO\n\
         Subsystem sftp internal-sftp\n"
    );
    if let Some(path) = path {
        text.push_str(&format!("SetEnv PATH={path}\n"));
    }
    text
}

/// `raw` as a `PATH` the configuration can carry on one bare line: absolute
/// folders only, each once, none with a character `sshd` would read as the
/// end of the value or as quoting.
pub fn sanitize_path(raw: &str) -> Option<String> {
    let mut kept: Vec<&str> = Vec::new();
    for entry in raw.trim().split(':') {
        let plain = entry.starts_with('/')
            && !entry
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || matches!(c, '"' | '\'' | '#' | '\\'));
        if plain && !kept.contains(&entry) {
            kept.push(entry);
        }
    }
    (!kept.is_empty()).then(|| kept.join(":"))
}

/// The `PATH` in what the login shell printed for `login_path`: the marked
/// line, whatever a profile printed around it.
fn printed_path(stdout: &str) -> Option<String> {
    stdout
        .lines()
        .find_map(|line| line.strip_prefix("DODOER_PATH="))
        .and_then(sanitize_path)
}

/// The `PATH` of the person's login shell — where `node`, `brew` and the like
/// are found; a session started by `sshd` has only the system's. Falls back
/// to this app's own.
pub async fn login_path() -> Option<String> {
    let from_shell = match std::env::var("SHELL") {
        Ok(shell) if !shell.trim().is_empty() => {
            let mut command = Command::new(shell);
            command
                .arg("-lic")
                .arg(r#"printf 'DODOER_PATH=%s\n' "$PATH""#)
                .stdin(Stdio::null())
                .stderr(Stdio::null())
                .kill_on_drop(true);
            match tokio::time::timeout(LOGIN_PATH_TIMEOUT, command.output()).await {
                Ok(Ok(output)) => printed_path(&String::from_utf8_lossy(&output.stdout)),
                _ => None,
            }
        }
        _ => None,
    };
    from_shell.or_else(|| {
        let own = std::env::var("PATH").ok()?;
        sanitize_path(&own)
    })
}

async fn launch(state_dir: &Path, path: Option<&str>) -> Result<Running, SshdError> {
    if !supported() {
        return Err(SshdError::Unsupported);
    }
    let dir = tempfile::Builder::new()
        .prefix(TEMP_PREFIX)
        .tempdir_in(RUN_ROOT)
        .map_err(|e| SshdError::Setup(format!("no temporary folder: {e}")))?;
    private(dir.path(), 0o700);
    if dir.path().to_string_lossy().contains(char::is_whitespace) {
        return Err(SshdError::Setup(
            "the temporary folder's path has a space in it".to_string(),
        ));
    }
    let host_key_file = dir.path().join("host_key");
    generate_key(&host_key_file, "dodoer").await?;
    let host_key_text = std::fs::read_to_string(dir.path().join("host_key.pub"))
        .map_err(|e| SshdError::Setup(format!("reading the host key: {e}")))?;
    let host_key = one_public_key(&host_key_text)
        .ok_or_else(|| SshdError::Setup("no host key was made".to_string()))?;
    write_authorized(dir.path(), &[])?;
    let user = login_name().await?;
    let port = crate::local_daemon::free_loopback_port()
        .map_err(|e| SshdError::Setup(format!("no free port: {e}")))?;
    let config = dir.path().join("sshd_config");
    std::fs::write(&config, config_text(dir.path(), port, &user, path))
        .map_err(|e| SshdError::Setup(format!("writing the configuration: {e}")))?;
    private(&config, 0o600);

    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(WATCHER)
        .arg(WATCHER_NAME)
        .arg(SSHD)
        .args(["-D", "-e", "-f"])
        .arg(&config)
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Its own group, so stopping it stops the watcher, `sshd` and `cat`
    // together and nothing of this app.
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .spawn()
        .map_err(|e| SshdError::Setup(format!("could not start sshd: {e}")))?;
    let pid = child.id().unwrap_or_default();
    let _ = std::fs::write(
        state_dir.join(PID_FILE),
        format!("{pid}\n{}\n", dir.path().display()),
    );
    let stdin = child.stdin.take();
    let log = Arc::new(StdMutex::new(VecDeque::new()));
    if let Some(stderr) = child.stderr.take() {
        // Drained all along (a full pipe would stall `sshd`), keeping the
        // tail for a failure to quote.
        let log = Arc::clone(&log);
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                let mut log = log.lock().expect("sshd log");
                if log.len() == LOG_LINES {
                    log.pop_front();
                }
                log.push_back(line);
            }
        });
    }
    let mut running = Running {
        child,
        _stdin: stdin,
        dir,
        endpoint: SshdEndpoint {
            port,
            host_key,
            user,
        },
        authorized: Vec::new(),
        log,
    };

    let give_up = Instant::now() + START_TIMEOUT;
    loop {
        if let Ok(Some(status)) = running.child.try_wait() {
            let detail = format!("{status}{}", last_lines(&running.log));
            let _ = std::fs::remove_file(state_dir.join(PID_FILE));
            return Err(SshdError::Exited(detail));
        }
        if tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_ok()
        {
            return Ok(running);
        }
        if Instant::now() >= give_up {
            let detail = format!(
                "nothing on 127.0.0.1:{port} after {} s{}",
                START_TIMEOUT.as_secs(),
                last_lines(&running.log)
            );
            end(running).await;
            let _ = std::fs::remove_file(state_dir.join(PID_FILE));
            return Err(SshdError::Timeout(detail));
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
}

/// Signal the whole group `pid` leads.
fn signal_group(pid: u32, hard: bool) {
    #[cfg(unix)]
    {
        let Ok(pid) = i32::try_from(pid) else {
            return;
        };
        if pid <= 1 {
            return;
        }
        let signal = if hard { libc::SIGKILL } else { libc::SIGTERM };
        // SAFETY: a signal to the group of a process this app started as a
        // group leader (or, for a survivor, checked to be one it started).
        unsafe {
            libc::kill(-pid, signal);
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (pid, hard);
    }
}

/// End the watcher, `sshd` and `cat`; the folder goes with `running`.
async fn end(mut running: Running) {
    if let Some(pid) = running.child.id() {
        signal_group(pid, false);
        if tokio::time::timeout(STOP_TIMEOUT, running.child.wait())
            .await
            .is_err()
        {
            signal_group(pid, true);
        }
    }
    let _ = running.child.kill().await;
}

/// A service left by a run of this app that never got to stop it: ended, and
/// its folder removed. The watcher ends `sshd` when the app goes, so there is
/// seldom anything here to end; the folder is what a killed app leaves.
pub async fn stop_survivor(state_dir: &Path) {
    let file = state_dir.join(PID_FILE);
    let Ok(text) = std::fs::read_to_string(&file) else {
        return;
    };
    let _ = std::fs::remove_file(&file);
    let mut lines = text.lines();
    let pid = lines.next().and_then(|l| l.trim().parse::<u32>().ok());
    let dir = lines.next().map(|l| PathBuf::from(l.trim()));
    if let Some(pid) = pid {
        if !crate::cli_run::discovery::pid_is_dead(pid) && is_watcher(pid).await {
            tracing::warn!("[host-ssh] stopping sshd (pid {pid}) left from an earlier run");
            signal_group(pid, false);
            let give_up = Instant::now() + STOP_TIMEOUT;
            while Instant::now() < give_up && !crate::cli_run::discovery::pid_is_dead(pid) {
                tokio::time::sleep(Duration::from_millis(100)).await;
            }
            if !crate::cli_run::discovery::pid_is_dead(pid) {
                signal_group(pid, true);
            }
        }
    }
    if let Some(dir) = dir {
        let ours = dir
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with(TEMP_PREFIX));
        if ours && dir.is_dir() {
            let _ = std::fs::remove_dir_all(&dir);
        }
    }
}

/// Whether `pid` is a watcher of this app's (a reused pid must not be
/// signalled).
async fn is_watcher(pid: u32) -> bool {
    let mut command = Command::new("ps");
    command
        .args(["-p", &pid.to_string(), "-o", "command="])
        .stdin(Stdio::null())
        .kill_on_drop(true);
    match command.output().await {
        Ok(output) => String::from_utf8_lossy(&output.stdout).contains(WATCHER_NAME),
        Err(_) => false,
    }
}

fn last_lines(log: &Arc<StdMutex<VecDeque<String>>>) -> String {
    let log = log.lock().expect("sshd log");
    if log.is_empty() {
        String::new()
    } else {
        format!(
            ": {}",
            log.iter().cloned().collect::<Vec<_>>().join(" | ")
        )
    }
}

/// Whether a test that needs the real `sshd` must fail without one, instead
/// of passing unseen: CI says so (`CODEG_HOST_SSH_TEST_STRICT`).
#[cfg(test)]
pub(crate) fn test_needs_sshd() -> bool {
    std::env::var("CODEG_HOST_SSH_TEST_STRICT").is_ok_and(|v| !v.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_configuration_listens_on_loopback_and_takes_keys_only() {
        let text = config_text(Path::new("/tmp/dodoer-ssh.x"), 4022, "ada", None);
        assert!(text.contains("ListenAddress 127.0.0.1\n"));
        assert!(text.contains("Port 4022\n"));
        assert!(text.contains("AuthenticationMethods publickey\n"));
        assert!(text.contains("PasswordAuthentication no\n"));
        assert!(text.contains("AllowUsers ada\n"));
        assert!(text.contains("AuthorizedKeysFile /tmp/dodoer-ssh.x/authorized_keys\n"));
        assert!(!text.contains("SetEnv"));
        assert!(!text.contains("0.0.0.0"));
    }

    #[test]
    fn the_configuration_hands_sessions_the_login_path() {
        let text = config_text(
            Path::new("/tmp/dodoer-ssh.x"),
            4022,
            "ada",
            Some("/opt/homebrew/bin:/usr/bin"),
        );
        assert!(text.ends_with("SetEnv PATH=/opt/homebrew/bin:/usr/bin\n"));
    }

    #[test]
    fn a_path_keeps_only_what_one_bare_line_can_carry() {
        assert_eq!(
            sanitize_path("/opt/homebrew/bin:/usr/bin:/opt/homebrew/bin:bin::/a b/c:/x#y\n"),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
        assert_eq!(sanitize_path("relative:"), None);
        assert_eq!(sanitize_path("/usr/bin\nPermitRootLogin yes"), None);
    }

    #[test]
    fn the_login_path_is_read_past_what_a_profile_prints() {
        assert_eq!(
            printed_path("Welcome back!\nDODOER_PATH=/opt/homebrew/bin:/usr/bin\n"),
            Some("/opt/homebrew/bin:/usr/bin".to_string())
        );
        assert_eq!(printed_path("Welcome back!\n"), None);
    }

    #[test]
    fn only_a_single_bare_public_key_is_let_in() {
        assert_eq!(
            one_public_key("ssh-ed25519 AAAAC3Nza+/= someone@somewhere\n"),
            Some("ssh-ed25519 AAAAC3Nza+/=".to_string())
        );
        // Options before the type would be obeyed by sshd.
        assert_eq!(
            one_public_key("command=\"x\" ssh-ed25519 AAAAC3Nza"),
            None
        );
        // A second line would be a second key.
        assert_eq!(
            one_public_key("ssh-ed25519 AAAA\nssh-ed25519 BBBB"),
            None
        );
        assert_eq!(one_public_key("ssh-ed25519"), None);
        assert_eq!(one_public_key(""), None);
    }

    #[test]
    fn the_self_test_reads_what_the_session_printed() {
        assert_eq!(
            read_self_test("dodoer-ok\ngit\nnode\n", ""),
            SelfTest {
                ok: true,
                tools: vec!["git".to_string(), "node".to_string()],
                detail: None,
            }
        );
        let refused = read_self_test("", "\nPermission denied (publickey).\n");
        assert!(!refused.ok);
        assert_eq!(
            refused.detail.as_deref(),
            Some("Permission denied (publickey).")
        );
    }

    /// The whole life of the service against the real `sshd`, where there is
    /// one: it listens on loopback, lets in the self-test's key and no other,
    /// hands sessions the `PATH` it was given, and is gone — listener, pid
    /// file and folder — once stopped. CI sets `CODEG_HOST_SSH_TEST_STRICT`
    /// so that a runner without `sshd` fails instead of passing unseen.
    #[tokio::test]
    async fn the_service_starts_answers_and_leaves_nothing_behind() {
        if !supported() {
            assert!(!test_needs_sshd(), "no sshd on this machine");
            return;
        }
        let state = tempfile::tempdir().unwrap();
        let sshd = Sshd::new(state.path().to_path_buf());
        assert_eq!(sshd.endpoint().await, None);
        assert!(matches!(
            sshd.self_test().await,
            Err(SshdError::NotRunning)
        ));

        let endpoint = sshd
            .start(Some("/usr/local/bin:/usr/bin:/bin".to_string()))
            .await
            .expect("sshd starts");
        assert!(endpoint.host_key.starts_with("ssh-ed25519 "));
        assert_eq!(sshd.start(None).await.unwrap(), endpoint, "started once");
        assert!(state.path().join(PID_FILE).is_file());

        let test = sshd.self_test().await.unwrap();
        assert!(test.ok, "self-test: {:?}", test.detail);
        // The key the test logged in with is let in no longer.
        let dir = {
            let running = sshd.running.lock().await;
            running.as_ref().unwrap().dir.path().to_path_buf()
        };
        assert_eq!(
            std::fs::read_to_string(dir.join("authorized_keys")).unwrap(),
            ""
        );

        sshd.stop().await;
        assert_eq!(sshd.endpoint().await, None);
        assert!(!state.path().join(PID_FILE).exists());
        assert!(!dir.exists());
        assert!(
            tokio::net::TcpStream::connect(("127.0.0.1", endpoint.port))
                .await
                .is_err(),
            "nothing listens once stopped"
        );
    }

    /// A killed app leaves the pid file and the folder; the next launch
    /// clears both, and signals nothing that is not a watcher of its own.
    #[tokio::test]
    async fn a_survivor_is_cleared_away() {
        let state = tempfile::tempdir().unwrap();
        let left = tempfile::Builder::new()
            .prefix(TEMP_PREFIX)
            .tempdir()
            .unwrap()
            .keep();
        // This test's own pid: alive, and not a watcher.
        std::fs::write(
            state.path().join(PID_FILE),
            format!("{}\n{}\n", std::process::id(), left.display()),
        )
        .unwrap();
        stop_survivor(state.path()).await;
        assert!(!state.path().join(PID_FILE).exists());
        assert!(!left.exists());

        // A folder that is not one of ours is left alone.
        let other = tempfile::tempdir().unwrap();
        std::fs::write(
            state.path().join(PID_FILE),
            format!("999999999\n{}\n", other.path().display()),
        )
        .unwrap();
        stop_survivor(state.path()).await;
        assert!(other.path().is_dir());
    }
}
