//! Cowork fork: lending this computer's shell to a remote workspace's agents
//! (`docs/host-ssh.md`).
//!
//! A person lends the computer to one server at a time, by that server's
//! address — not by the connection's id, which a deleted connection gives up
//! to the next one made, and not for good once the address is edited to
//! point somewhere else. The SSH service ([`Sshd`]) runs only while a window
//! of a lent server is open, and stops with the last of them.
//!
//! A server's `ssh` reaches the service through a tunnel the app dials
//! itself (`tunnel`, `docs/host-ssh.md` 5.2): the app lets the server's key
//! in for it ([`Lending::admit`]) and ends it the moment the lending ends
//! ([`Lending::withdrawn`]). The server's side of `ssh desktop` — its key,
//! the host keys it accepts, its `ssh` configuration — is `client`.

pub mod client;
mod sshd;
pub mod tunnel;

#[cfg(test)]
pub(crate) use sshd::test_needs_sshd;
pub use sshd::{login_path, stop_survivor, supported, SelfTest, Sshd, SshdEndpoint, SshdError};
pub use tunnel::ShellHost;

use std::collections::{BTreeSet, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use serde::Serialize;
use tokio::sync::{watch, Mutex};

/// A server's address as lendings are kept by it: as the connection stores
/// it, without the spaces and trailing slashes a person may or may not type.
pub fn server_key(base_url: &str) -> String {
    base_url.trim().trim_end_matches('/').to_string()
}

/// What a window shows about lending this computer to its server.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LendingStatus {
    /// Whether this system can lend at all.
    pub supported: bool,
    /// Whether the person lent this computer to the server asked about.
    pub lent: bool,
    /// Whether the SSH service is up right now.
    pub running: bool,
    /// Why it is not, when it should be.
    pub error: Option<String>,
}

#[derive(Default)]
struct State {
    /// The servers this computer is lent to (`server_key`).
    lent: BTreeSet<String>,
    /// The remote windows open now, each with its server.
    open: HashMap<u64, String>,
    /// Why the last start failed; cleared by the next that works, and by
    /// there being nothing to start.
    error: Option<String>,
}

/// Which servers this computer is lent to, and the service that follows from
/// it.
pub struct Lending {
    sshd: Sshd,
    state: Mutex<State>,
    /// One start or stop at a time, decided from the state as it is then.
    reconciling: Mutex<()>,
    next_window: AtomicU64,
    /// Bumped whenever a status may read differently.
    changed: watch::Sender<u64>,
}

/// A remote window, for as long as it is held: dropping it is the window
/// closing.
pub struct OpenWindow {
    lending: Arc<Lending>,
    id: u64,
    runtime: tokio::runtime::Handle,
}

impl Drop for OpenWindow {
    fn drop(&mut self) {
        let lending = Arc::clone(&self.lending);
        let id = self.id;
        self.runtime.spawn(async move {
            lending.state.lock().await.open.remove(&id);
            lending.reconcile().await;
        });
    }
}

impl Lending {
    pub fn new(sshd: Sshd, lent: BTreeSet<String>) -> Arc<Self> {
        let (changed, _) = watch::channel(0);
        Arc::new(Self {
            sshd,
            state: Mutex::new(State {
                lent,
                ..State::default()
            }),
            reconciling: Mutex::new(()),
            next_window: AtomicU64::new(1),
            changed,
        })
    }

    /// Told of every change a status may show.
    pub fn subscribe(&self) -> watch::Receiver<u64> {
        self.changed.subscribe()
    }

    /// A window of `base_url`'s server opened. Must be called on the runtime
    /// the window's task runs on.
    pub async fn window_opened(self: &Arc<Self>, base_url: &str) -> OpenWindow {
        let id = self.next_window.fetch_add(1, Ordering::Relaxed);
        self.state
            .lock()
            .await
            .open
            .insert(id, server_key(base_url));
        self.reconcile().await;
        OpenWindow {
            lending: Arc::clone(self),
            id,
            runtime: tokio::runtime::Handle::current(),
        }
    }

    /// Lend this computer to `base_url`'s server, or stop. Returns every
    /// server lent to now, for the caller to store.
    pub async fn set_lent(&self, base_url: &str, lent: bool) -> BTreeSet<String> {
        let servers = {
            let mut state = self.state.lock().await;
            let server = server_key(base_url);
            if lent {
                state.lent.insert(server);
            } else {
                state.lent.remove(&server);
            }
            state.lent.clone()
        };
        self.reconcile().await;
        servers
    }

    pub async fn status(&self, base_url: &str) -> LendingStatus {
        let running = self.sshd.endpoint().await.is_some();
        let state = self.state.lock().await;
        LendingStatus {
            supported: supported(),
            lent: state.lent.contains(&server_key(base_url)),
            running,
            error: state.error.clone(),
        }
    }

    /// The running service, for whoever connects a tunnel to it.
    pub async fn endpoint(&self) -> Option<SshdEndpoint> {
        self.sshd.endpoint().await
    }

    pub async fn self_test(&self) -> Result<SelfTest, SshdError> {
        self.sshd.self_test().await
    }

    /// The shell this computer lends `base_url`'s server now: lent to it,
    /// and the service up.
    pub async fn shell_for(&self, base_url: &str) -> Option<ShellHost> {
        if !self.is_lent(base_url).await {
            return None;
        }
        let endpoint = self.sshd.endpoint().await?;
        Some(ShellHost {
            host_key: endpoint.host_key,
            user: endpoint.user,
            platform: Some(std::env::consts::OS.to_string()),
        })
    }

    /// Let `client_key` in for a tunnel of `base_url`'s server, if this
    /// computer is lent to it; the port to join the tunnel to. `Err` says
    /// why not, for the server to pass on.
    pub async fn admit(&self, base_url: &str, client_key: &str) -> Result<u16, String> {
        if !self.is_lent(base_url).await {
            return Err("this computer is not lent to this server any more".to_string());
        }
        let endpoint = self
            .sshd
            .endpoint()
            .await
            .ok_or_else(|| "the SSH service on this computer is not running".to_string())?;
        self.sshd
            .authorize(client_key)
            .await
            .map_err(|e| e.to_string())?;
        Ok(endpoint.port)
    }

    /// Resolves once a tunnel of `base_url`'s server joined to the service
    /// on `port` must end: the lending taken back, or that service gone.
    pub async fn withdrawn(&self, base_url: &str, port: u16) {
        // Subscribed before looking, so no change slips between the two.
        let mut changes = self.subscribe();
        loop {
            let still = self.is_lent(base_url).await
                && self
                    .sshd
                    .endpoint()
                    .await
                    .is_some_and(|endpoint| endpoint.port == port);
            if !still || changes.changed().await.is_err() {
                return;
            }
        }
    }

    async fn is_lent(&self, base_url: &str) -> bool {
        self.state
            .lock()
            .await
            .lent
            .contains(&server_key(base_url))
    }

    /// The app is going: stop the service whatever is lent.
    pub async fn shut_down(&self) {
        let _one = self.reconciling.lock().await;
        self.sshd.stop().await;
    }

    /// Run the service exactly while a window of a lent server is open.
    async fn reconcile(&self) {
        let _one = self.reconciling.lock().await;
        let wanted = {
            let state = self.state.lock().await;
            state.open.values().any(|server| state.lent.contains(server))
        };
        let error = if !wanted {
            self.sshd.stop().await;
            None
        } else if self.sshd.endpoint().await.is_some() {
            None
        } else if !supported() {
            Some(SshdError::Unsupported.to_string())
        } else {
            let path = login_path().await;
            match self.sshd.start(path).await {
                Ok(_) => None,
                Err(e) => {
                    tracing::error!("[host-ssh] {e}");
                    Some(e.to_string())
                }
            }
        };
        self.state.lock().await.error = error;
        self.changed.send_modify(|version| *version += 1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lending(lent: &[&str]) -> (Arc<Lending>, tempfile::TempDir) {
        let state = tempfile::tempdir().unwrap();
        let lent = lent.iter().copied().map(server_key).collect();
        (
            Lending::new(Sshd::new(state.path().to_path_buf()), lent),
            state,
        )
    }

    #[test]
    fn a_server_is_the_same_with_or_without_its_trailing_slash() {
        assert_eq!(server_key(" https://a.example/ "), "https://a.example");
        assert_eq!(server_key("https://a.example"), "https://a.example");
        assert_ne!(server_key("https://a.example"), server_key("https://b.example"));
    }

    /// Nobody has lent anything until they say so.
    #[tokio::test]
    async fn nothing_is_lent_and_nothing_runs_to_begin_with() {
        let (lending, _state) = lending(&[]);
        let status = lending.status("https://a.example").await;
        assert!(!status.lent);
        assert!(!status.running);
        assert_eq!(status.error, None);
    }

    /// Lending is to one server: another server's window sees it as not
    /// lent, and no window open means nothing runs however much is lent.
    #[tokio::test]
    async fn lending_is_kept_by_server_and_needs_a_window() {
        let (lending, _state) = lending(&[]);
        let servers = lending.set_lent("https://a.example/", true).await;
        assert_eq!(
            servers.into_iter().collect::<Vec<_>>(),
            vec!["https://a.example".to_string()]
        );
        assert!(lending.status("https://a.example").await.lent);
        assert!(!lending.status("https://b.example").await.lent);
        assert!(!lending.status("https://a.example").await.running);

        // A window of a server that was not lent to starts nothing either.
        let window = lending.window_opened("https://b.example").await;
        assert!(!lending.status("https://b.example").await.running);
        drop(window);

        assert!(lending.set_lent("https://a.example", false).await.is_empty());
        assert!(!lending.status("https://a.example").await.lent);
    }

    /// The service follows the windows: up when a lent server's window
    /// opens, down when the last closes or the lending is taken back. With
    /// no `sshd` to run (CI sets `CODEG_HOST_SSH_TEST_STRICT` so that cannot
    /// pass unseen), the failure is what the status says instead.
    #[tokio::test]
    async fn the_service_runs_while_a_lent_servers_window_is_open() {
        let (lending, _state) = lending(&["https://a.example"]);
        let changes = lending.subscribe();
        let window = lending.window_opened("https://a.example/").await;
        assert!(changes.has_changed().unwrap());
        let status = lending.status("https://a.example").await;
        if !supported() {
            assert!(!sshd::test_needs_sshd(), "no sshd on this machine");
            assert!(!status.running);
            assert!(status.error.is_some());
            return;
        }
        assert!(status.running, "{:?}", status.error);
        let port = lending.endpoint().await.unwrap().port;

        // A second window keeps it up when the first closes.
        let second = lending.window_opened("https://a.example").await;
        drop(window);
        settle(&lending, true).await;
        drop(second);
        settle(&lending, false).await;
        assert!(tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .is_err());

        // Taking the lending back stops it under an open window.
        let _third = lending.window_opened("https://a.example").await;
        assert!(lending.status("https://a.example").await.running);
        lending.set_lent("https://a.example", false).await;
        assert!(!lending.status("https://a.example").await.running);
    }

    /// What a tunnel needs from the lending: the shell to register, a key
    /// let in for the server lent to only, and an end when the lending ends.
    #[tokio::test]
    async fn a_tunnel_is_admitted_for_the_lent_server_and_ended_with_the_lending() {
        let (lending, _state) = lending(&["https://a.example"]);
        let _window = lending.window_opened("https://a.example").await;
        if !supported() {
            assert!(!sshd::test_needs_sshd(), "no sshd on this machine");
            assert_eq!(lending.shell_for("https://a.example").await, None);
            return;
        }
        let shell = lending.shell_for("https://a.example/").await.expect("lent and running");
        assert!(shell.is_sound(), "{shell:?}");
        assert_eq!(lending.shell_for("https://b.example").await, None);

        let key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIAAA";
        assert!(lending.admit("https://b.example", key).await.is_err());
        assert!(lending.admit("https://a.example", "not a key").await.is_err());
        let port = lending.admit("https://a.example", key).await.unwrap();
        assert_eq!(lending.endpoint().await.unwrap().port, port);

        let watching = Arc::clone(&lending);
        let ended = tokio::spawn(async move {
            watching.withdrawn("https://a.example", port).await;
        });
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        assert!(!ended.is_finished(), "still lent");
        lending.set_lent("https://a.example", false).await;
        tokio::time::timeout(std::time::Duration::from_secs(5), ended)
            .await
            .expect("ends with the lending")
            .unwrap();
        assert!(lending.admit("https://a.example", key).await.is_err());
    }

    /// A closed window is put right by a task of its own: wait for it.
    async fn settle(lending: &Arc<Lending>, running: bool) {
        for _ in 0..100 {
            let settled = {
                // Held so that no start or stop is half done while looking.
                let _reconciled = lending.reconciling.lock().await;
                let open = lending.state.lock().await.open.len();
                let is_running = lending.sshd.endpoint().await.is_some();
                is_running == running && (running || open == 0)
            };
            if settled {
                return;
            }
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        panic!("the service did not settle at running = {running}");
    }
}
