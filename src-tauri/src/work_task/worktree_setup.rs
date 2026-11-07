//! What happens inside a conversation's freshly created worktree before the
//! agent gets to it — the Paseo-style `.worktreeinclude` + `worktree.setup`
//! pair (see `commands::folders::create_conversation_worktree_core`).
//!
//! 1. **`.worktreeinclude`** (in the source checkout's root, `.gitignore`
//!    syntax): a new worktree only has the tracked files, so local files the
//!    project needs but never commits — `.env` above all — are missing. Every
//!    file that matches a pattern in it AND is ignored by git is copied over
//!    from the source checkout, keeping its relative path. A tracked file is
//!    never copied (the worktree already has its own version), nor is an
//!    untracked one git does not ignore; a file that already exists in the
//!    worktree is left alone. No file, no copy — there is no default list.
//! 2. **Setup command**: the folder's work-task `init_command` (the same
//!    setting task worktrees run, so a project configures "install deps" once),
//!    run in the worktree with the same shell invocation the task engine uses.
//!    Unlike a task, a conversation never waits for it: it runs in the
//!    background while the conversation starts, and its outcome is reported on
//!    [`CONVERSATION_WORKTREE_SETUP_EVENT`] — a failed install is something to
//!    show the user, not a reason to hold their message back.

use std::path::{Component, Path};
use std::process::Stdio;

use serde::Serialize;
use tokio::io::AsyncWriteExt;

use super::engine::{combine_capture, shell_command};

/// File name, in the source checkout's root, that lists the ignored files to
/// copy into a new worktree.
pub const WORKTREE_INCLUDE_FILE: &str = ".worktreeinclude";

/// What [`copy_worktree_includes`] did, relative paths throughout.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct WorktreeIncludeCopy {
    /// Copied from the source checkout into the worktree.
    pub copied: Vec<String>,
    /// Matched, but the worktree already has something at that path.
    pub skipped: Vec<String>,
    /// Matched, but the copy failed — `"<path>: <error>"`.
    pub failed: Vec<String>,
}

/// The files `.worktreeinclude` selects in `source_root`: untracked, ignored by
/// git, and matching one of its patterns. Empty when there is no
/// `.worktreeinclude`.
///
/// Matching is git's own (`ls-files --exclude-from`), so the file means exactly
/// what the same lines would mean in a `.gitignore` — anchoring, `**`,
/// negation, directory patterns. `check-ignore` then keeps only what the
/// repo's real ignore rules ignore.
pub async fn worktree_include_paths(source_root: &str) -> Result<Vec<String>, String> {
    let include = Path::new(source_root).join(WORKTREE_INCLUDE_FILE);
    if !include.is_file() {
        return Ok(Vec::new());
    }
    let exclude_from = format!("--exclude-from={}", include.to_string_lossy());
    let listed = crate::process::tokio_command("git")
        .args(["ls-files", "-z", "--others", "--ignored", &exclude_from])
        .current_dir(source_root)
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("git ls-files: {e}"))?;
    if !listed.status.success() {
        return Err(format!(
            "git ls-files: {}",
            String::from_utf8_lossy(&listed.stderr).trim()
        ));
    }
    let candidates = split_nul(&listed.stdout);
    if candidates.is_empty() {
        return Ok(Vec::new());
    }

    let mut child = crate::process::tokio_command("git")
        .args(["check-ignore", "-z", "--stdin"])
        .current_dir(source_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("git check-ignore: {e}"))?;
    let mut input = Vec::new();
    for path in &candidates {
        input.extend_from_slice(path.as_bytes());
        input.push(0);
    }
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(&input)
            .await
            .map_err(|e| format!("git check-ignore: {e}"))?;
        // Dropping closes the pipe, which is what ends git's input.
    }
    let out = child
        .wait_with_output()
        .await
        .map_err(|e| format!("git check-ignore: {e}"))?;
    // 0 = some paths are ignored, 1 = none are; anything else is an error.
    match out.status.code() {
        Some(0) => {}
        Some(1) => return Ok(Vec::new()),
        _ => {
            return Err(format!(
                "git check-ignore: {}",
                String::from_utf8_lossy(&out.stderr).trim()
            ))
        }
    }
    let mut paths = split_nul(&out.stdout);
    paths.sort();
    paths.dedup();
    Ok(paths)
}

/// NUL-separated git output → relative paths. Directory entries (a trailing
/// `/` — git's spelling of a nested repository it does not descend into) are
/// dropped: another repo is never something to copy wholesale.
fn split_nul(bytes: &[u8]) -> Vec<String> {
    bytes
        .split(|b| *b == 0)
        .filter(|s| !s.is_empty())
        .map(|s| String::from_utf8_lossy(s).into_owned())
        .filter(|s| !s.ends_with('/'))
        .collect()
}

/// A path git reported relative to the repo, safe to join onto another root:
/// only normal components, so it can neither climb out (`..`) nor replace the
/// root (absolute / prefixed).
fn is_plain_relative(rel: &str) -> bool {
    let path = Path::new(rel);
    !rel.is_empty() && path.components().all(|c| matches!(c, Component::Normal(_)))
}

/// Copy each `rel` from `source_root` to the same place under `worktree`.
/// Never overwrites: something already at the destination (a file the branch
/// tracks, say) wins. A symlink is recreated as a symlink on Unix — copying
/// its target could duplicate a whole directory tree the link only pointed at.
pub fn copy_worktree_includes(
    source_root: &Path,
    worktree: &Path,
    rel_paths: &[String],
) -> WorktreeIncludeCopy {
    let mut report = WorktreeIncludeCopy::default();
    for rel in rel_paths {
        if !is_plain_relative(rel) {
            report.failed.push(format!("{rel}: not a relative path"));
            continue;
        }
        let from = source_root.join(rel);
        let to = worktree.join(rel);
        if to.symlink_metadata().is_ok() {
            report.skipped.push(rel.clone());
            continue;
        }
        match copy_one(&from, &to) {
            Ok(()) => report.copied.push(rel.clone()),
            Err(e) => report.failed.push(format!("{rel}: {e}")),
        }
    }
    report
}

fn copy_one(from: &Path, to: &Path) -> std::io::Result<()> {
    if let Some(parent) = to.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let meta = from.symlink_metadata()?;
    #[cfg(unix)]
    if meta.file_type().is_symlink() {
        return std::os::unix::fs::symlink(std::fs::read_link(from)?, to);
    }
    if meta.is_dir() {
        // `ls-files` lists files only; a directory here means the tree changed
        // under us. Nothing sensible to copy.
        return Err(std::io::Error::other("is a directory"));
    }
    // `fs::copy` carries the permission bits over (an executable script stays
    // executable).
    std::fs::copy(from, to).map(|_| ())
}

/// `.worktreeinclude` end to end: select in `source_root`, copy into
/// `worktree`. A selection failure (git missing, unreadable file) is reported
/// as a single `failed` entry rather than an error — like the copies
/// themselves, it must not cost the user the worktree they just got.
pub async fn apply_worktree_include(source_root: &str, worktree: &str) -> WorktreeIncludeCopy {
    let paths = match worktree_include_paths(source_root).await {
        Ok(paths) => paths,
        Err(e) => {
            return WorktreeIncludeCopy {
                failed: vec![format!("{WORKTREE_INCLUDE_FILE}: {e}")],
                ..Default::default()
            }
        }
    };
    if paths.is_empty() {
        return WorktreeIncludeCopy::default();
    }
    let source = Path::new(source_root).to_path_buf();
    let target = Path::new(worktree).to_path_buf();
    tokio::task::spawn_blocking(move || copy_worktree_includes(&source, &target, &paths))
        .await
        .unwrap_or_else(|e| WorktreeIncludeCopy {
            failed: vec![format!("{WORKTREE_INCLUDE_FILE}: {e}")],
            ..Default::default()
        })
}

/// The event a conversation worktree's background setup command reports on
/// when it finishes. Payload: [`WorktreeSetupResult`].
pub const CONVERSATION_WORKTREE_SETUP_EVENT: &str = "conversation-worktree://setup";

/// How the setup command ended — the payload of
/// [`CONVERSATION_WORKTREE_SETUP_EVENT`].
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct WorktreeSetupResult {
    /// The worktree's folder id (what the client that created it waits on).
    pub folder_id: i32,
    pub worktree_path: String,
    pub command: String,
    /// Exit 0.
    pub ok: bool,
    /// `None` when the command could not be started or was killed by a signal.
    pub exit_code: Option<i32>,
    /// Trailing combined stdout+stderr on failure (or the spawn error); empty
    /// on success.
    pub output_tail: String,
}

/// Environment the setup command sees on top of the server's own, so a
/// command can reach back into the checkout it was forked from (Paseo's
/// `PASEO_SOURCE_CHECKOUT_PATH` / `PASEO_WORKTREE_PATH` / `PASEO_BRANCH_NAME`).
pub fn setup_env(source_root: &str, worktree: &str, branch: &str) -> Vec<(&'static str, String)> {
    vec![
        ("CODEG_SOURCE_CHECKOUT_PATH", source_root.to_string()),
        ("CODEG_WORKTREE_PATH", worktree.to_string()),
        ("CODEG_BRANCH_NAME", branch.to_string()),
    ]
}

/// Run `command` in `worktree` exactly the way the task engine runs a task's
/// `init_command` (`sh -c` / `cmd /C`, stdin closed, combined output tail).
pub async fn run_worktree_setup(
    folder_id: i32,
    worktree: &str,
    command: &str,
    env: &[(&'static str, String)],
) -> WorktreeSetupResult {
    let mut cmd = shell_command(command, worktree);
    for (key, value) in env {
        cmd.env(key, value);
    }
    let (exit_code, tail) = match cmd.output().await {
        Ok(out) => combine_capture(&out),
        Err(e) => (None, e.to_string()),
    };
    let ok = exit_code == Some(0);
    WorktreeSetupResult {
        folder_id,
        worktree_path: worktree.to_string(),
        command: command.to_string(),
        ok,
        exit_code,
        output_tail: if ok { String::new() } else { tail },
    }
}

/// Run the setup command in the background and report on
/// [`CONVERSATION_WORKTREE_SETUP_EVENT`] (and the log) when it is done.
pub fn spawn_worktree_setup(
    emitter: crate::web::event_bridge::EventEmitter,
    folder_id: i32,
    worktree: String,
    command: String,
    env: Vec<(&'static str, String)>,
) {
    tokio::spawn(async move {
        tracing::info!("[worktree-setup] running `{command}` in {worktree}");
        let result = run_worktree_setup(folder_id, &worktree, &command, &env).await;
        if result.ok {
            tracing::info!("[worktree-setup] `{command}` finished in {worktree}");
        } else {
            tracing::warn!(
                "[worktree-setup] `{command}` failed in {worktree} (exit {:?}): {}",
                result.exit_code,
                result.output_tail
            );
        }
        crate::web::event_bridge::emit_event(&emitter, CONVERSATION_WORKTREE_SETUP_EVENT, &result);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn git_run(dir: &Path, args: &[&str]) {
        let out = std::process::Command::new("git")
            .args(args)
            .current_dir(dir)
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .env("GIT_CONFIG_SYSTEM", "/dev/null")
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@example.com")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@example.com")
            .output()
            .expect("spawn git");
        assert!(
            out.status.success(),
            "git {args:?} failed: {}",
            String::from_utf8_lossy(&out.stderr)
        );
    }

    fn write(root: &Path, rel: &str, contents: &str) {
        let full = root.join(rel);
        std::fs::create_dir_all(full.parent().unwrap()).unwrap();
        std::fs::write(full, contents).unwrap();
    }

    /// A repo whose ignore rules and `.worktreeinclude` disagree in every way
    /// that matters: matched+ignored, matched-but-tracked,
    /// matched-but-not-ignored, ignored-but-not-matched, anchored vs not.
    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git_run(root, &["init", "-q", "-b", "main"]);
        write(
            root,
            ".gitignore",
            ".env\n*.local\nnode_modules/\nbuild.log\n",
        );
        write(
            root,
            WORKTREE_INCLUDE_FILE,
            "# local secrets\n/.env\nconfig/*.local\nREADME.md\nnotes.txt\n",
        );
        write(root, "README.md", "tracked\n");
        git_run(
            root,
            &["add", ".gitignore", WORKTREE_INCLUDE_FILE, "README.md"],
        );
        git_run(root, &["commit", "-q", "-m", "base"]);
        write(root, ".env", "SECRET=1\n");
        write(
            root,
            "pkg/.env",
            "nested, not matched by the anchored /.env\n",
        );
        write(root, "config/db.local", "local db\n");
        write(root, "config/db.txt", "untracked, ignored by nothing\n");
        write(root, "notes.txt", "matched but not ignored\n");
        write(root, "build.log", "ignored but not matched\n");
        write(root, "node_modules/x/index.js", "ignored but not matched\n");
        dir
    }

    #[tokio::test]
    async fn include_selects_only_matched_ignored_files() {
        let dir = fixture();
        let paths = worktree_include_paths(dir.path().to_str().unwrap())
            .await
            .expect("selection");
        assert_eq!(
            paths,
            vec![".env".to_string(), "config/db.local".to_string()]
        );
    }

    #[tokio::test]
    async fn no_include_file_selects_nothing() {
        let dir = fixture();
        std::fs::remove_file(dir.path().join(WORKTREE_INCLUDE_FILE)).unwrap();
        let paths = worktree_include_paths(dir.path().to_str().unwrap())
            .await
            .expect("selection");
        assert!(paths.is_empty());
    }

    #[tokio::test]
    async fn include_with_no_ignored_match_selects_nothing() {
        let dir = fixture();
        // Only patterns that hit tracked or non-ignored files.
        write(dir.path(), WORKTREE_INCLUDE_FILE, "README.md\nnotes.txt\n");
        let paths = worktree_include_paths(dir.path().to_str().unwrap())
            .await
            .expect("selection");
        assert!(paths.is_empty());
    }

    #[tokio::test]
    async fn apply_copies_into_a_new_worktree_without_overwriting() {
        let dir = fixture();
        let root = dir.path();
        let wt_parent = tempfile::tempdir().unwrap();
        let wt = wt_parent.path().join("wt");
        git_run(
            root,
            &["worktree", "add", "-q", "-b", "wt", wt.to_str().unwrap()],
        );
        // Something the worktree already has at a matched path is kept.
        write(&wt, "config/db.local", "worktree's own\n");

        let report = apply_worktree_include(root.to_str().unwrap(), wt.to_str().unwrap()).await;

        assert_eq!(report.copied, vec![".env".to_string()]);
        assert_eq!(report.skipped, vec!["config/db.local".to_string()]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(
            std::fs::read_to_string(wt.join(".env")).unwrap(),
            "SECRET=1\n"
        );
        assert_eq!(
            std::fs::read_to_string(wt.join("config/db.local")).unwrap(),
            "worktree's own\n"
        );
        assert!(!wt.join("notes.txt").exists());
        assert!(!wt.join("build.log").exists());
        assert!(!wt.join("pkg/.env").exists());
    }

    #[test]
    fn copy_refuses_paths_that_leave_the_root() {
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        let report = copy_worktree_includes(
            src.path(),
            dst.path(),
            &["../escape".to_string(), "/etc/passwd".to_string()],
        );
        assert!(report.copied.is_empty());
        assert_eq!(report.failed.len(), 2);
    }

    #[cfg(unix)]
    #[test]
    fn copy_recreates_symlinks_and_keeps_the_mode() {
        use std::os::unix::fs::PermissionsExt;
        let src = tempfile::tempdir().unwrap();
        let dst = tempfile::tempdir().unwrap();
        write(src.path(), "bin/run.sh", "#!/bin/sh\n");
        std::fs::set_permissions(
            src.path().join("bin/run.sh"),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        std::os::unix::fs::symlink("bin/run.sh", src.path().join("run")).unwrap();

        let report = copy_worktree_includes(
            src.path(),
            dst.path(),
            &["bin/run.sh".to_string(), "run".to_string()],
        );

        assert_eq!(report.copied.len(), 2, "{report:?}");
        let mode = std::fs::metadata(dst.path().join("bin/run.sh"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o755);
        assert_eq!(
            std::fs::read_link(dst.path().join("run")).unwrap(),
            Path::new("bin/run.sh")
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn setup_runs_in_the_worktree_with_the_source_env() {
        let wt = tempfile::tempdir().unwrap();
        let wt_path = wt.path().to_str().unwrap();
        let env = setup_env("/src/repo", wt_path, "cv/tidy-fox");
        let result = run_worktree_setup(
            7,
            wt_path,
            "printf '%s|%s' \"$CODEG_SOURCE_CHECKOUT_PATH\" \"$CODEG_BRANCH_NAME\" > ran.txt",
            &env,
        )
        .await;
        assert!(result.ok, "{result:?}");
        assert_eq!(result.exit_code, Some(0));
        assert_eq!(result.folder_id, 7);
        assert!(result.output_tail.is_empty());
        assert_eq!(
            std::fs::read_to_string(wt.path().join("ran.txt")).unwrap(),
            "/src/repo|cv/tidy-fox"
        );
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn a_failing_setup_reports_its_exit_code_and_output() {
        let wt = tempfile::tempdir().unwrap();
        let wt_path = wt.path().to_str().unwrap();
        let result = run_worktree_setup(1, wt_path, "echo boom >&2; exit 3", &[]).await;
        assert!(!result.ok);
        assert_eq!(result.exit_code, Some(3));
        assert!(result.output_tail.contains("boom"), "{result:?}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn spawned_setup_reports_on_the_setup_event() {
        use crate::web::event_bridge::{EventEmitter, WebEventBroadcaster};
        use std::sync::Arc;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());
        let wt = tempfile::tempdir().unwrap();

        spawn_worktree_setup(
            emitter,
            42,
            wt.path().to_str().unwrap().to_string(),
            "exit 5".to_string(),
            Vec::new(),
        );

        let evt = tokio::time::timeout(std::time::Duration::from_secs(30), rx.recv())
            .await
            .expect("setup event within 30s")
            .expect("broadcast open");
        assert_eq!(evt.channel, CONVERSATION_WORKTREE_SETUP_EVENT);
        let p = &*evt.payload;
        assert_eq!(p["folder_id"], 42);
        assert_eq!(p["ok"], false);
        assert_eq!(p["exit_code"], 5);
        assert_eq!(p["command"], "exit 5");
    }
}
