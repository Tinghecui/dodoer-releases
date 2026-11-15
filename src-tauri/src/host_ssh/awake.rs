//! Cowork fork: no sleep while the shell is lent (`docs/devices.md` 7.3).
//!
//! While the SSH service runs for a lent server, the app keeps
//! `/usr/bin/caffeinate -s -w <the app's pid>` going: the system does not
//! go to sleep while on AC power, the screen still goes off, and a laptop
//! still sleeps on battery or with its lid shut. It is ended when the
//! service stops; if the app quits or is killed, `-w` ends it by itself.
//! Elsewhere than macOS nothing is run.

use std::path::PathBuf;
use std::process::Stdio;

use tokio::process::{Child, Command};
use tokio::sync::Mutex;

/// What keeps the computer awake for as long as it runs.
pub struct Awake {
    /// The program and its arguments; none where there is nothing to run.
    command: Option<(PathBuf, Vec<String>)>,
    child: Mutex<Option<Child>>,
}

impl Default for Awake {
    fn default() -> Self {
        Self::new()
    }
}

impl Awake {
    /// `caffeinate` on macOS, nothing elsewhere.
    pub fn new() -> Self {
        let command = if cfg!(target_os = "macos") {
            Some((
                PathBuf::from("/usr/bin/caffeinate"),
                vec![
                    "-s".to_string(),
                    "-w".to_string(),
                    std::process::id().to_string(),
                ],
            ))
        } else {
            None
        };
        Self {
            command,
            child: Mutex::new(None),
        }
    }

    #[cfg(test)]
    fn running(program: &str, args: &[&str]) -> Self {
        Self {
            command: Some((
                PathBuf::from(program),
                args.iter().map(|a| a.to_string()).collect(),
            )),
            child: Mutex::new(None),
        }
    }

    /// Keep the computer awake, if it is not kept already. One that ended
    /// by itself is started again.
    pub async fn hold(&self) {
        let Some((program, args)) = &self.command else {
            return;
        };
        let mut child = self.child.lock().await;
        if matches!(child.as_mut().map(Child::try_wait), Some(Ok(None))) {
            return;
        }
        *child = match Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(spawned) => {
                tracing::info!("[host-ssh] keeping this computer awake while it is lent");
                Some(spawned)
            }
            Err(e) => {
                tracing::warn!("[host-ssh] cannot keep this computer awake: {e}");
                None
            }
        };
    }

    /// Let the computer sleep again.
    pub async fn release(&self) {
        let Some(mut running) = self.child.lock().await.take() else {
            return;
        };
        if let Err(e) = running.kill().await {
            tracing::warn!("[host-ssh] the keep-awake did not end: {e}");
        } else {
            tracing::info!("[host-ssh] this computer may sleep again");
        }
    }

    /// Whether it is kept awake now.
    pub async fn held(&self) -> bool {
        let mut child = self.child.lock().await;
        matches!(child.as_mut().map(Child::try_wait), Some(Ok(None)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn held_until_released_and_once_only() {
        let awake = Awake::running("sleep", &["600"]);
        assert!(!awake.held().await);
        awake.hold().await;
        assert!(awake.held().await);
        let first = awake.child.lock().await.as_ref().and_then(Child::id);
        awake.hold().await;
        let second = awake.child.lock().await.as_ref().and_then(Child::id);
        assert_eq!(first, second, "a second hold starts nothing");
        awake.release().await;
        assert!(!awake.held().await);
        // Releasing what is not held is nothing.
        awake.release().await;
    }

    #[tokio::test]
    async fn one_that_ended_is_started_again() {
        let awake = Awake::running("true", &[]);
        awake.hold().await;
        // `true` is gone at once.
        for _ in 0..50 {
            if !awake.held().await {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!awake.held().await);
        let first = awake.child.lock().await.as_ref().and_then(Child::id);
        awake.hold().await;
        let second = awake.child.lock().await.as_ref().and_then(Child::id);
        assert_ne!(first, second);
    }

    #[tokio::test]
    async fn nothing_to_run_is_never_held() {
        let awake = Awake {
            command: None,
            child: Mutex::new(None),
        };
        awake.hold().await;
        assert!(!awake.held().await);
    }
}
