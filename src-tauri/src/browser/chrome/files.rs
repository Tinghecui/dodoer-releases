//! Files in and out of the person's Chrome for agents
//! (`docs/agent-chrome.md` section 13.7).
//!
//! Uploading: an agent names files on this computer, and only inside one
//! folder of it, [`upload_dir`] (`~/Downloads/dodoer-uploads/`). The names are
//! resolved and canonicalized before they are compared with the folder, so
//! neither a `../` nor a symbolic link inside it reaches anything outside
//! ([`check_upload_paths`]). An agent on a server puts its files there first,
//! over the shell the person lends (`ssh <device>`, `docs/host-ssh.md`).
//!
//! Downloading: nothing about where Chrome saves is changed. The person's
//! everyday Chrome has one browser context, and `Browser.setDownloadBehavior`
//! with a folder of its own would send the person's own downloads there too
//! and skip their "ask where to save". So the one call made is
//! [`download_events_params`] — behaviour `default`, which leaves every
//! decision to Chrome's own settings — for the events alone. Chrome takes
//! both back by itself when the connection ends: the browser handler's
//! `Disable` drops the behaviour it was given and turns the events off with
//! the session (`content/browser/devtools/protocol/browser_handler.cc`), so
//! there is nothing to undo on the way out.
//!
//! [`ChromeDownloads`] follows those events for as long as the connection
//! lasts, and keeps the downloads an agent's click started: one that begins
//! in a frame of a tab within [`CLAIM_WINDOW`] of an agent clicking there.
//! The rest — the person's own downloads, anywhere — are not looked at.
//!
//! Pure bookkeeping and plain file checks, compiled in both runtimes for
//! the sake of their tests; the desktop app is the only user.

use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tokio::sync::Notify;

use crate::browser::agent::{DownloadReport, DownloadState};

/// The folder under the person's download folder that uploads come from.
pub const UPLOAD_DIR_NAME: &str = "dodoer-uploads";

/// The most files one upload gives a page.
pub const MAX_UPLOAD_FILES: usize = 20;

/// How long after an agent's click a download that begins in that tab is
/// taken to be the click's.
pub const CLAIM_WINDOW: Duration = Duration::from_secs(10);

/// Downloads kept per connection; the oldest go first.
const KEPT: usize = 100;

/// `~/Downloads/dodoer-uploads/` on this computer.
pub fn upload_dir() -> Option<PathBuf> {
    dirs::home_dir().map(|home| home.join("Downloads").join(UPLOAD_DIR_NAME))
}

/// The folder as the agent is told of it.
pub fn upload_dir_display() -> String {
    format!("~/Downloads/{UPLOAD_DIR_NAME}/")
}

/// Why an upload's files were refused, in words the agent can act on.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum UploadPathError {
    #[error("browser_upload needs at least one file in `paths`")]
    NoFiles,
    /// Says [`MAX_UPLOAD_FILES`] in words; the test keeps the two together.
    #[error("browser_upload takes at most 20 files at a time")]
    TooMany,
    #[error(
        "the upload folder {0} does not exist on the user's computer. Create it and put the files \
         there first"
    )]
    NoFolder(String),
    #[error("{path} does not exist on the user's computer")]
    Missing { path: String },
    #[error(
        "{path} is not inside {folder}. Only files in that folder of the user's computer can be \
         uploaded; copy the file there first"
    )]
    Outside { path: String, folder: String },
    #[error("{path} is not a file")]
    NotAFile { path: String },
}

/// The files `paths` names, each canonicalized and inside `root`, or why
/// not. A path is absolute, starts with `~/` (this computer's home), or is
/// taken as relative to `root` — so `a.pdf` is `root/a.pdf`. Canonicalizing
/// before the comparison is what keeps `../` and symbolic links from
/// leading out of the folder: what is compared is where the path really
/// ends up.
pub fn check_upload_paths(
    root: &Path,
    home: Option<&Path>,
    paths: &[String],
) -> Result<Vec<PathBuf>, UploadPathError> {
    if paths.is_empty() {
        return Err(UploadPathError::NoFiles);
    }
    if paths.len() > MAX_UPLOAD_FILES {
        return Err(UploadPathError::TooMany);
    }
    let shown = root.display().to_string();
    let root = root
        .canonicalize()
        .map_err(|_| UploadPathError::NoFolder(shown.clone()))?;
    let mut files = Vec::with_capacity(paths.len());
    for raw in paths {
        let raw = raw.trim();
        let asked = match (raw.strip_prefix("~/"), home) {
            (Some(rest), Some(home)) => home.join(rest),
            _ if Path::new(raw).is_absolute() => PathBuf::from(raw),
            _ => root.join(raw),
        };
        let real = asked.canonicalize().map_err(|_| UploadPathError::Missing {
            path: raw.to_string(),
        })?;
        if !real.starts_with(&root) || real == root {
            return Err(UploadPathError::Outside {
                path: raw.to_string(),
                folder: shown,
            });
        }
        if !real.is_file() {
            return Err(UploadPathError::NotAFile {
                path: raw.to_string(),
            });
        }
        files.push(real);
    }
    Ok(files)
}

/// What `Browser.setDownloadBehavior` is sent: Chrome's own behaviour, as
/// the person set it, and its download events on or off. Never a folder.
pub fn download_events_params(enabled: bool) -> Value {
    json!({ "behavior": "default", "eventsEnabled": enabled })
}

/// A download of an agent's that ended, for the activity record.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinishedDownload {
    pub tab_id: String,
    /// Whose agent clicked (`chrome::lending`'s scopes).
    pub scope: String,
    pub file_name: String,
    pub completed: bool,
}

struct Click {
    tab_id: String,
    scope: String,
    frames: Vec<String>,
    at: Instant,
}

struct Download {
    guid: String,
    tab_id: String,
    scope: String,
    seq: u64,
    file_name: String,
    file_path: Option<String>,
    state: DownloadState,
    /// The state the agent was last told of.
    told: Option<DownloadState>,
}

#[derive(Default)]
struct Inner {
    clicks: Vec<Click>,
    downloads: Vec<Download>,
    next: u64,
}

/// The downloads agents' clicks started in the connected Chrome.
#[derive(Default)]
pub struct ChromeDownloads {
    inner: Mutex<Inner>,
    changed: Notify,
}

impl ChromeDownloads {
    fn inner(&self) -> MutexGuard<'_, Inner> {
        self.inner
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// An agent of `scope` is about to click in `tab_id`, whose frames are
    /// `frames` (the main frame's id is the tab's target id in Chrome). The
    /// answer is the mark [`Self::wait_for`] counts new downloads from.
    pub fn clicked(&self, tab_id: &str, scope: &str, frames: Vec<String>, now: Instant) -> u64 {
        let mut inner = self.inner();
        inner
            .clicks
            .retain(|click| click.tab_id != tab_id && now.duration_since(click.at) < CLAIM_WINDOW);
        inner.clicks.push(Click {
            tab_id: tab_id.to_string(),
            scope: scope.to_string(),
            frames,
            at: now,
        });
        inner.next
    }

    /// Take in what Chrome said, if it is about downloads. The answer is a
    /// download of an agent's that has just ended.
    pub fn take_in(&self, method: &str, params: &Value, now: Instant) -> Option<FinishedDownload> {
        let finished = {
            let mut inner = self.inner();
            match method {
                "Browser.downloadWillBegin" => {
                    inner.begin(params, now);
                    None
                }
                "Browser.downloadProgress" => inner.progress(params),
                _ => return None,
            }
        };
        self.changed.notify_waiters();
        finished
    }

    /// Wait for a download in `tab_id` counted from `mark` to begin, up to
    /// `begin`, and for every such one to end, up to `finish` in all.
    pub async fn wait_for(&self, tab_id: &str, mark: u64, begin: Duration, finish: Duration) {
        let start = tokio::time::Instant::now();
        loop {
            let changed = self.changed.notified();
            tokio::pin!(changed);
            let _ = changed.as_mut().enable();
            let (begun, running) = {
                let inner = self.inner();
                let mine = inner
                    .downloads
                    .iter()
                    .filter(|download| download.tab_id == tab_id && download.seq >= mark);
                let mut begun = false;
                let mut running = false;
                for download in mine {
                    begun = true;
                    running |= download.state == DownloadState::InProgress;
                }
                (begun, running)
            };
            let limit = match (begun, running) {
                (true, false) => return,
                (false, _) => begin,
                (true, true) => finish,
            };
            let deadline = start + limit;
            if tokio::time::timeout_at(deadline, changed).await.is_err() {
                return;
            }
        }
    }

    /// What the agent has not been told yet of `tab_id`'s downloads, in the
    /// order they began; each is told once in each state.
    pub fn take_reports(&self, tab_id: &str) -> Vec<DownloadReport> {
        let mut inner = self.inner();
        inner
            .downloads
            .iter_mut()
            .filter(|download| download.tab_id == tab_id && download.told != Some(download.state))
            .map(|download| {
                download.told = Some(download.state);
                DownloadReport {
                    file_name: download.file_name.clone(),
                    file_path: download.file_path.clone(),
                    state: download.state,
                }
            })
            .collect()
    }

    /// Forget everything: the connection ended.
    pub fn clear(&self) {
        *self.inner() = Inner::default();
    }
}

impl Inner {
    fn begin(&mut self, params: &Value, now: Instant) {
        let (Some(frame), Some(guid)) = (params["frameId"].as_str(), params["guid"].as_str())
        else {
            return;
        };
        let Some(click) = self.clicks.iter().rev().find(|click| {
            now.duration_since(click.at) < CLAIM_WINDOW && click.frames.iter().any(|f| f == frame)
        }) else {
            // Not after an agent's click: the person's own, not looked at.
            return;
        };
        let file_name = params["suggestedFilename"]
            .as_str()
            .filter(|name| !name.is_empty())
            .unwrap_or("download")
            .to_string();
        let download = Download {
            guid: guid.to_string(),
            tab_id: click.tab_id.clone(),
            scope: click.scope.clone(),
            seq: self.next,
            file_name,
            file_path: None,
            state: DownloadState::InProgress,
            told: None,
        };
        self.next += 1;
        self.downloads.push(download);
        if self.downloads.len() > KEPT {
            self.downloads.remove(0);
        }
    }

    fn progress(&mut self, params: &Value) -> Option<FinishedDownload> {
        let guid = params["guid"].as_str()?;
        let download = self
            .downloads
            .iter_mut()
            .find(|download| download.guid == guid)?;
        let state = match params["state"].as_str()? {
            "completed" => DownloadState::Completed,
            "canceled" => DownloadState::Canceled,
            _ => return None,
        };
        if download.state != DownloadState::InProgress {
            return None;
        }
        download.state = state;
        download.file_path = params["filePath"]
            .as_str()
            .filter(|path| !path.is_empty())
            .map(str::to_string);
        Some(FinishedDownload {
            tab_id: download.tab_id.clone(),
            scope: download.scope.clone(),
            file_name: download.file_name.clone(),
            completed: state == DownloadState::Completed,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folder() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(UPLOAD_DIR_NAME);
        std::fs::create_dir(&root).unwrap();
        std::fs::write(root.join("a.pdf"), b"a").unwrap();
        std::fs::write(dir.path().join("secret.txt"), b"s").unwrap();
        (dir, root)
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|path| path.to_string()).collect()
    }

    #[test]
    fn a_file_in_the_folder_is_taken_by_name_or_by_path() {
        let (_dir, root) = folder();
        let real = root.canonicalize().unwrap().join("a.pdf");
        let by_name = check_upload_paths(&root, None, &paths(&["a.pdf"])).unwrap();
        assert_eq!(by_name, vec![real.clone()]);
        let full = root.join("a.pdf").display().to_string();
        assert_eq!(
            check_upload_paths(&root, None, &[full]).unwrap(),
            vec![real]
        );
    }

    #[test]
    fn a_home_relative_path_is_this_computers_home() {
        let (dir, root) = folder();
        let home = dir.path();
        let asked = format!("~/{UPLOAD_DIR_NAME}/a.pdf");
        let files = check_upload_paths(&root, Some(home), &[asked]).unwrap();
        assert_eq!(files, vec![root.canonicalize().unwrap().join("a.pdf")]);
        // The same file named through the home, from outside the folder.
        let outside = check_upload_paths(&root, Some(home), &paths(&["~/secret.txt"]));
        assert!(
            matches!(outside, Err(UploadPathError::Outside { .. })),
            "{outside:?}"
        );
    }

    #[test]
    fn a_file_outside_the_folder_is_refused() {
        let (dir, root) = folder();
        let outside = dir.path().join("secret.txt").display().to_string();
        let refused = check_upload_paths(&root, None, &[outside]);
        assert!(
            matches!(refused, Err(UploadPathError::Outside { .. })),
            "{refused:?}"
        );
        // One refused file refuses the whole upload.
        let mixed = check_upload_paths(&root, None, &paths(&["a.pdf", "/etc/hosts"]));
        assert!(matches!(
            mixed,
            Err(UploadPathError::Outside { .. }) | Err(UploadPathError::Missing { .. })
        ));
    }

    #[test]
    fn dot_dot_cannot_climb_out() {
        let (_dir, root) = folder();
        for asked in ["../secret.txt", "./../secret.txt", "sub/../../secret.txt"] {
            let refused = check_upload_paths(&root, None, &paths(&[asked]));
            assert!(
                matches!(
                    refused,
                    Err(UploadPathError::Outside { .. }) | Err(UploadPathError::Missing { .. })
                ),
                "{asked}: {refused:?}"
            );
        }
        let full = format!("{}/../secret.txt", root.display());
        let refused = check_upload_paths(&root, None, &[full]);
        assert!(
            matches!(refused, Err(UploadPathError::Outside { .. })),
            "{refused:?}"
        );
        // The folder itself is not a file in it.
        let itself = check_upload_paths(&root, None, &paths(&["."]));
        assert!(
            matches!(itself, Err(UploadPathError::Outside { .. })),
            "{itself:?}"
        );
    }

    #[cfg(unix)]
    #[test]
    fn a_symbolic_link_out_of_the_folder_is_refused() {
        let (dir, root) = folder();
        std::os::unix::fs::symlink(dir.path().join("secret.txt"), root.join("link.txt")).unwrap();
        std::os::unix::fs::symlink(dir.path(), root.join("up")).unwrap();
        for asked in ["link.txt", "up/secret.txt"] {
            let refused = check_upload_paths(&root, None, &paths(&[asked]));
            assert!(
                matches!(refused, Err(UploadPathError::Outside { .. })),
                "{asked}: {refused:?}"
            );
        }
        // A link that stays inside is the file it points at.
        std::os::unix::fs::symlink(root.join("a.pdf"), root.join("same.pdf")).unwrap();
        let inside = check_upload_paths(&root, None, &paths(&["same.pdf"])).unwrap();
        assert_eq!(inside, vec![root.canonicalize().unwrap().join("a.pdf")]);
    }

    #[test]
    fn missing_files_and_folders_say_so() {
        let (dir, root) = folder();
        let missing = check_upload_paths(&root, None, &paths(&["nope.pdf"]));
        assert_eq!(
            missing,
            Err(UploadPathError::Missing {
                path: "nope.pdf".into()
            })
        );
        std::fs::create_dir(root.join("sub")).unwrap();
        let folder_not_file = check_upload_paths(&root, None, &paths(&["sub"]));
        assert!(matches!(
            folder_not_file,
            Err(UploadPathError::NotAFile { .. })
        ));
        let no_folder = check_upload_paths(&dir.path().join("absent"), None, &paths(&["a.pdf"]));
        assert!(matches!(no_folder, Err(UploadPathError::NoFolder(_))));
        assert_eq!(
            check_upload_paths(&root, None, &[]),
            Err(UploadPathError::NoFiles)
        );
        let many: Vec<String> = (0..=MAX_UPLOAD_FILES)
            .map(|_| "a.pdf".to_string())
            .collect();
        assert_eq!(
            check_upload_paths(&root, None, &many),
            Err(UploadPathError::TooMany)
        );
        assert!(UploadPathError::TooMany
            .to_string()
            .contains(&MAX_UPLOAD_FILES.to_string()));
    }

    #[test]
    fn the_refusal_names_the_folder() {
        let err = UploadPathError::Outside {
            path: "/tmp/x".into(),
            folder: upload_dir_display(),
        };
        assert!(
            err.to_string().contains("~/Downloads/dodoer-uploads/"),
            "{err}"
        );
    }

    /// Only the events are asked for: Chrome's own behaviour, no folder of
    /// ours, so the person's downloads go where they always did and "ask
    /// where to save" still asks.
    #[test]
    fn download_events_leave_the_persons_settings_alone() {
        for enabled in [true, false] {
            let params = download_events_params(enabled);
            assert_eq!(params["behavior"], "default");
            assert_eq!(params["eventsEnabled"], enabled);
            assert!(params.get("downloadPath").is_none());
            assert!(params.get("browserContextId").is_none());
            assert_eq!(params.as_object().unwrap().len(), 2);
        }
    }

    fn begin(frame: &str, guid: &str, name: &str) -> Value {
        json!({ "frameId": frame, "guid": guid, "url": "https://example.com/f", "suggestedFilename": name })
    }

    #[test]
    fn a_download_after_an_agents_click_is_kept_and_reported_once_per_state() {
        let downloads = ChromeDownloads::default();
        let now = Instant::now();
        downloads.clicked("t1", "local", vec!["T1".into()], now);
        assert_eq!(
            downloads.take_in(
                "Browser.downloadWillBegin",
                &begin("T1", "g1", "a.pdf"),
                now
            ),
            None
        );
        let reports = downloads.take_reports("t1");
        assert_eq!(
            reports,
            vec![DownloadReport {
                file_name: "a.pdf".into(),
                file_path: None,
                state: DownloadState::InProgress
            }]
        );
        assert!(downloads.take_reports("t1").is_empty());
        let done = downloads.take_in(
            "Browser.downloadProgress",
            &json!({ "guid": "g1", "state": "completed", "filePath": "/Users/someone/Downloads/a.pdf" }),
            now,
        );
        assert_eq!(
            done,
            Some(FinishedDownload {
                tab_id: "t1".into(),
                scope: "local".into(),
                file_name: "a.pdf".into(),
                completed: true
            })
        );
        let reports = downloads.take_reports("t1");
        assert_eq!(reports[0].state, DownloadState::Completed);
        assert_eq!(
            reports[0].file_path.as_deref(),
            Some("/Users/someone/Downloads/a.pdf")
        );
        // Said once: a repeated event changes nothing.
        let again = downloads.take_in(
            "Browser.downloadProgress",
            &json!({ "guid": "g1", "state": "completed" }),
            now,
        );
        assert_eq!(again, None);
        assert!(downloads.take_reports("t1").is_empty());
    }

    #[test]
    fn the_persons_own_downloads_are_not_looked_at() {
        let downloads = ChromeDownloads::default();
        let now = Instant::now();
        downloads.clicked("t1", "local", vec!["T1".into()], now);
        // Another tab.
        downloads.take_in(
            "Browser.downloadWillBegin",
            &begin("OTHER", "g1", "mine.zip"),
            now,
        );
        // The agent's tab, long after its click.
        downloads.take_in(
            "Browser.downloadWillBegin",
            &begin("T1", "g2", "later.zip"),
            now + CLAIM_WINDOW + Duration::from_secs(1),
        );
        assert!(downloads.take_reports("t1").is_empty());
        assert!(downloads.take_reports("OTHER").is_empty());
        assert_eq!(
            downloads.take_in(
                "Browser.downloadProgress",
                &json!({ "guid": "g1", "state": "completed" }),
                now
            ),
            None
        );
    }

    #[test]
    fn a_cancelled_download_ends_as_cancelled() {
        let downloads = ChromeDownloads::default();
        let now = Instant::now();
        downloads.clicked("t1", "remote-a", vec!["T1".into()], now);
        downloads.take_in("Browser.downloadWillBegin", &begin("T1", "g1", ""), now);
        let ended = downloads
            .take_in(
                "Browser.downloadProgress",
                &json!({ "guid": "g1", "state": "canceled" }),
                now,
            )
            .unwrap();
        assert!(!ended.completed);
        assert_eq!(ended.scope, "remote-a");
        // No name from Chrome: still something to call it by.
        assert_eq!(ended.file_name, "download");
        downloads.clear();
        assert!(downloads.take_reports("t1").is_empty());
    }

    #[tokio::test]
    async fn waiting_ends_when_the_download_does() {
        let downloads = std::sync::Arc::new(ChromeDownloads::default());
        let now = Instant::now();
        let mark = downloads.clicked("t1", "local", vec!["T1".into()], now);
        // Nothing begins: the wait is the short one.
        let started = tokio::time::Instant::now();
        downloads
            .wait_for(
                "t1",
                mark,
                Duration::from_millis(50),
                Duration::from_secs(30),
            )
            .await;
        assert!(started.elapsed() < Duration::from_secs(5));

        let follower = downloads.clone();
        let feed = tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(20)).await;
            follower.take_in(
                "Browser.downloadWillBegin",
                &begin("T1", "g1", "a.pdf"),
                Instant::now(),
            );
            tokio::time::sleep(Duration::from_millis(20)).await;
            follower.take_in(
                "Browser.downloadProgress",
                &json!({ "guid": "g1", "state": "completed" }),
                Instant::now(),
            );
        });
        downloads
            .wait_for("t1", mark, Duration::from_secs(5), Duration::from_secs(30))
            .await;
        feed.await.unwrap();
        assert_eq!(
            downloads.take_reports("t1")[0].state,
            DownloadState::Completed
        );
    }
}
