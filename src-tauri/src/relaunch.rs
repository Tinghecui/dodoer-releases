//! Restarting on macOS without leaving a second Dock icon behind.
//!
//! tauri's restart (2.12.2 and later) runs `open -n <bundle>` and waits for
//! LaunchServices to finish the launch before this process exits, so for a
//! moment two codegs are running. The Dock gives the new one a tile of its own,
//! because the old one still holds the app's tile, and when the old one is
//! gone the tile it held stays where the user kept it: codeg is in the Dock
//! twice, the kept icon idle and the running codeg at the end, until the user
//! quits that one. The update from 0.36.0 to 0.37.0 did exactly this on
//! macOS 27 — the Dock logged "Inserting tile … for reason: -[DockBar
//! _handleLaunchNotification:data:]" for the new instance while the old one
//! was still exiting.
//!
//! So on macOS the restart is handed to a detached `/bin/sh` that waits until
//! this process is gone, from the process table and from LaunchServices, and
//! only then runs `open -n`. The Dock gives the new instance the tile the old
//! one left ("Launch of tile with child processes"). Chromium and Electron
//! relaunch the same way, for the same reason.
//!
//! Every restart codeg asks for comes through here: `restart_app` after an
//! update, and the renderer's `relaunch()` (`tauri-plugin-process`). Both
//! request the exit with `RESTART_EXIT_CODE`, which [`note_exit_requested`]
//! records, and reach `RunEvent::Exit`, where [`relaunch_after_exit`] takes
//! over before tauri's own restart would run. `AppHandle::restart()` on the
//! main thread skips both events and stays tauri's; codeg never calls it there
//! (see `commands::app_update::restart_app`).

use std::ffi::OsString;
use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};

/// Set once an exit has been requested in order to restart.
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);

/// Cowork fork (issue #412): the pending restart is the one an idle Mac
/// does on its own to put an update in place, and the new instance comes
/// back behind the app in use ([`set_background`]).
static BACKGROUND: AtomicBool = AtomicBool::new(false);

/// What launches the new instance, as in tauri's restart.
const OPEN: &str = "/usr/bin/open";

/// How many times the relauncher looks for the old instance, 50 ms apart,
/// before it launches anyway: about ten seconds. Past that something is
/// holding this process up, and a second icon is better than no codeg.
const WAIT_TRIES: u32 = 200;

/// The relauncher. Run as
/// `/bin/sh -c RELAUNCHER codeg-relaunch <pid> <tries> <open> <bundle> <exe> <how> [args…]`.
///
/// It waits until `<pid>` has left the process table, or is a zombie nobody
/// has reaped yet (`kill -0` would still find one), and LaunchServices no
/// longer lists it, so the Dock has heard that the old instance quit before it
/// hears about the new one. Then `open -n`, as tauri does, or, if that fails,
/// the executable itself, as tauri's fallback does. Paths are absolute: PATH is
/// whatever codeg's was.
///
/// Cowork fork: `<how>` is `background` for the restart an idle Mac does on
/// its own (issue #412): `open -g` leaves the app in front where it is.
/// Anything else (`front`) opens it as before.
const RELAUNCHER: &str = r#"pid=$1 tries=$2 open=$3 bundle=$4 exe=$5 how=$6
shift 6
while [ "$tries" -gt 0 ]; do
  case $(/bin/ps -o stat= -p "$pid" 2>/dev/null) in
    '' | Z*) [ -z "$(/usr/bin/lsappinfo find "pid=$pid" 2>/dev/null)" ] && break ;;
  esac
  tries=$((tries - 1))
  /bin/sleep 0.05
done
case $how in
  background) "$open" -g -n "$bundle" --args "$@" && exit 0 ;;
  *) "$open" -n "$bundle" --args "$@" && exit 0 ;;
esac
exec "$exe" "$@"
"#;

/// Cowork fork (issue #412): whether the next restart reopens in the
/// background — `open -g`, and the new instance started with
/// [`crate::update::idle::RELAUNCHED_IN_BACKGROUND`], so that it neither
/// focuses its windows nor activates. Set by the idle restart just before it
/// installs, and cleared again when that fails.
pub(crate) fn set_background(background: bool) {
    BACKGROUND.store(background, Ordering::SeqCst);
}

/// From `RunEvent::ExitRequested`: remembers whether the exit is a restart.
/// tauri requests one with `RESTART_EXIT_CODE` and nothing else uses it.
pub(crate) fn note_exit_requested(code: Option<i32>) {
    if code == Some(tauri::RESTART_EXIT_CODE) && !RESTART_PENDING.swap(true, Ordering::SeqCst) {
        // Logged here, while the app still runs: the process ends inside
        // `RunEvent::Exit`, before the log writer would get to anything said
        // there.
        tracing::info!("[relaunch] restart requested; relaunching once this process has exited");
    }
}

/// From `RunEvent::Exit`, after `shut_down`. With a restart pending, starts the
/// relauncher and ends the process: tauri's own restart would come next and run
/// `open -n` while this process is still alive.
///
/// Returns, leaving the restart to tauri, when codeg is not running from an app
/// bundle — tauri then spawns the executable directly, which gets no Dock tile
/// of its own until this process is gone — or when the relauncher cannot be
/// started.
pub(crate) fn relaunch_after_exit(app: &tauri::AppHandle) {
    use tauri::Manager;

    if !RESTART_PENDING.load(Ordering::SeqCst) {
        return;
    }
    let env = app.env();
    let Ok(exe) = tauri::process::current_binary(&env) else {
        return;
    };
    let Some(mut relauncher) = relauncher_for(
        std::process::id(),
        WAIT_TRIES,
        Path::new(OPEN),
        &exe,
        &env.args_os,
        BACKGROUND.load(Ordering::SeqCst),
    ) else {
        return;
    };
    match relauncher.spawn() {
        Ok(_) => {
            // What tauri does after this event before it restarts.
            app.cleanup_before_exit();
            std::process::exit(0);
        }
        Err(err) => {
            tracing::error!(
                "[relaunch] cannot start the relauncher, tauri restarts instead: {err}"
            );
        }
    }
}

/// Cowork fork: relaunch right away, from `setup` before anything has
/// started — the update put in place at launch
/// (`commands::app_update::apply_at_launch`, issue #412). Not through
/// `request_restart()`: `shut_down` would remember the open windows, of which
/// there are none yet, and there is nothing else for it to stop. Starts the
/// relauncher with this launch's own arguments (`open -n`, in front, as a
/// restart the user asked for), then ends the process the way
/// [`relaunch_after_exit`] does. Returns only when it cannot: not running from
/// an app bundle, or the relauncher would not start.
pub(crate) fn relaunch_now(app: &tauri::AppHandle) -> Result<std::convert::Infallible, String> {
    use tauri::Manager;

    let env = app.env();
    let exe = tauri::process::current_binary(&env).map_err(|e| e.to_string())?;
    let mut relauncher = relauncher_for(
        std::process::id(),
        WAIT_TRIES,
        Path::new(OPEN),
        &exe,
        &env.args_os,
        false,
    )
    .ok_or_else(|| format!("{} is not in an app bundle", exe.display()))?;
    relauncher.spawn().map_err(|e| e.to_string())?;
    app.cleanup_before_exit();
    std::process::exit(0);
}

/// The relauncher for `exe`, given this process's command line `args_os`
/// (the program first, as in `Env::args_os`): what follows the program is
/// passed on to the new instance — without the background flag of an earlier
/// background relaunch, and with it when this one is in the `background`
/// ([`crate::update::idle::relaunch_args`]). None when `exe` is not in an app
/// bundle.
fn relauncher_for(
    pid: u32,
    tries: u32,
    open: &Path,
    exe: &Path,
    args_os: &[OsString],
    background: bool,
) -> Option<Command> {
    let bundle = app_bundle(exe)?;
    let args = crate::update::idle::relaunch_args(args_os.get(1..).unwrap_or_default(), background);
    Some(relauncher(pid, tries, open, bundle, exe, &args, background))
}

/// The `.app` bundle `exe` runs from, `<bundle>.app/Contents/MacOS/<exe>`: the
/// layout tauri restarts through `open -n`.
pub(crate) fn app_bundle(exe: &Path) -> Option<&Path> {
    let macos = exe.parent()?;
    let contents = macos.parent()?;
    let bundle = contents.parent()?;
    (macos.file_name()? == "MacOS"
        && contents.file_name()? == "Contents"
        && bundle
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("app")))
    .then_some(bundle)
}

/// The relauncher's command line. It gets a process group of its own, because
/// a codeg started at login is the process of a launchd job
/// (`~/Library/LaunchAgents/codeg.plist`), and launchd kills whatever is left
/// in the job's process group when the job exits. No stdio of codeg's.
#[allow(clippy::too_many_arguments)]
fn relauncher(
    pid: u32,
    tries: u32,
    open: &Path,
    bundle: &Path,
    exe: &Path,
    args: &[OsString],
    background: bool,
) -> Command {
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(RELAUNCHER)
        .arg("codeg-relaunch")
        .arg(pid.to_string())
        .arg(tries.to_string())
        .arg(open)
        .arg(bundle)
        .arg(exe)
        .arg(if background { "background" } else { "front" })
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0);
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;
    use std::process::Child;
    use std::time::{Duration, Instant};

    #[test]
    fn finds_the_bundle_an_executable_runs_from() {
        assert_eq!(
            app_bundle(Path::new("/Applications/codeg.app/Contents/MacOS/codeg")),
            Some(Path::new("/Applications/codeg.app"))
        );
        assert_eq!(
            app_bundle(Path::new(
                "/Users/me/Apps/Codeg Beta.APP/Contents/MacOS/codeg"
            )),
            Some(Path::new("/Users/me/Apps/Codeg Beta.APP"))
        );
        // Not in a bundle: a development build, a bare binary.
        assert_eq!(
            app_bundle(Path::new("/src/codeg/src-tauri/target/debug/codeg")),
            None
        );
        assert_eq!(
            app_bundle(Path::new("/Applications/codeg/Contents/MacOS/codeg")),
            None
        );
        assert_eq!(app_bundle(Path::new("/Contents/MacOS/codeg")), None);
        assert_eq!(app_bundle(Path::new("codeg")), None);
    }

    /// A stand-in for `open` or the executable that writes the arguments it
    /// was given, one per line, to `<script>.out`, then exits with `code`.
    fn recorder(dir: &Path, name: &str, code: i32) -> PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let script = dir.join(name);
        std::fs::write(
            &script,
            format!("#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.tmp\" && mv \"$0.tmp\" \"$0.out\"\nexit {code}\n"),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
        script
    }

    fn recorded(script: &Path) -> PathBuf {
        script.with_extension("out")
    }

    fn wait_for(path: &Path, within: Duration) -> Option<String> {
        let deadline = Instant::now() + within;
        loop {
            if let Ok(text) = std::fs::read_to_string(path) {
                return Some(text);
            }
            if Instant::now() >= deadline {
                return None;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    /// Bounded, so a relauncher that never finishes fails the test instead of
    /// hanging it.
    fn reap(child: &mut Child) {
        let deadline = Instant::now() + Duration::from_secs(20);
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "the relauncher did not finish");
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn args(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn opens_the_bundle_only_once_the_old_instance_is_gone() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 0);
        let exe = recorder(dir.path(), "exe", 0);
        // The quitting codeg. Killed below and deliberately not reaped until
        // the end: a zombie must count as gone.
        let mut old = Command::new("/bin/sleep").arg("30").spawn().unwrap();
        let bundle = Path::new("/Applications/Some App.app");
        let mut relauncher = relauncher(
            old.id(),
            WAIT_TRIES,
            &open,
            bundle,
            &exe,
            &args(&["--flag", "two words"]),
            false,
        )
        .spawn()
        .unwrap();

        // Its own process group, out of reach of launchd's cleanup of codeg's.
        let pid = relauncher.id() as libc::pid_t;
        assert_eq!(unsafe { libc::getpgid(pid) }, pid);

        std::thread::sleep(Duration::from_millis(400));
        assert!(
            !recorded(&open).exists(),
            "launched while the old instance was still running"
        );

        old.kill().unwrap();
        let launched = wait_for(&recorded(&open), Duration::from_secs(10))
            .expect("not relaunched after the old instance exited");
        assert_eq!(
            launched,
            "-n\n/Applications/Some App.app\n--args\n--flag\ntwo words\n"
        );
        reap(&mut relauncher);
        assert!(
            !recorded(&exe).exists(),
            "fell back although open succeeded"
        );
        old.wait().unwrap();
    }

    #[test]
    fn runs_the_executable_itself_when_open_fails() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 1);
        let exe = recorder(dir.path(), "exe", 0);
        let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
        gone.wait().unwrap();

        // A small budget, in case the reaped pid is already someone else's.
        let mut relauncher = relauncher(
            gone.id(),
            3,
            &open,
            Path::new("/Applications/codeg.app"),
            &exe,
            &args(&["--x"]),
            false,
        )
        .spawn()
        .unwrap();

        let ran = wait_for(&recorded(&exe), Duration::from_secs(10))
            .expect("did not fall back to the executable");
        assert_eq!(ran, "--x\n");
        assert_eq!(
            std::fs::read_to_string(recorded(&open)).unwrap(),
            "-n\n/Applications/codeg.app\n--args\n--x\n"
        );
        reap(&mut relauncher);
    }

    #[test]
    fn relaunching_straight_away_passes_this_launch_s_arguments_on() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 0);
        let macos = dir.path().join("Some App.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let exe = recorder(&macos, "codeg", 0);
        let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
        gone.wait().unwrap();

        // `Env::args_os`: the program first, then what it was started with.
        let mut relauncher = relauncher_for(
            gone.id(),
            3,
            &open,
            &exe,
            &args(&[exe.to_str().unwrap(), "--flag", "two words"]),
            false,
        )
        .expect("the executable is in a bundle")
        .spawn()
        .unwrap();
        let launched = wait_for(&recorded(&open), Duration::from_secs(10)).expect("not relaunched");
        assert_eq!(
            launched,
            format!(
                "-n\n{}\n--args\n--flag\ntwo words\n",
                dir.path().join("Some App.app").display()
            )
        );
        reap(&mut relauncher);
        assert!(
            !recorded(&exe).exists(),
            "fell back although open succeeded"
        );

        // Started without arguments: nothing after `--args`.
        let mut relauncher = relauncher_for(gone.id(), 3, &open, &exe, &args(&["codeg"]), false)
            .unwrap()
            .spawn()
            .unwrap();
        reap(&mut relauncher);
        assert!(std::fs::read_to_string(recorded(&open))
            .unwrap()
            .ends_with("--args\n"));

        // Not in a bundle: no relauncher.
        assert!(relauncher_for(1, 3, &open, &open, &args(&["x"]), false).is_none());
    }

    /// Cowork fork (issue #412): the idle restart reopens with `open -g` and
    /// the background flag; every other restart has neither.
    #[test]
    fn a_background_relaunch_opens_with_g_and_the_flag() {
        use crate::update::idle::RELAUNCHED_IN_BACKGROUND;
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 0);
        let macos = dir.path().join("Some App.app/Contents/MacOS");
        std::fs::create_dir_all(&macos).unwrap();
        let exe = recorder(&macos, "codeg", 0);
        let bundle = dir.path().join("Some App.app");
        let mut gone = Command::new("/usr/bin/true").spawn().unwrap();
        gone.wait().unwrap();

        let launched_with = |launch_args: &[&str], background: bool| {
            let _ = std::fs::remove_file(recorded(&open));
            let mut relauncher =
                relauncher_for(gone.id(), 3, &open, &exe, &args(launch_args), background)
                    .unwrap()
                    .spawn()
                    .unwrap();
            let launched =
                wait_for(&recorded(&open), Duration::from_secs(10)).expect("not relaunched");
            reap(&mut relauncher);
            launched
        };

        assert_eq!(
            launched_with(&["codeg", "--flag"], true),
            format!(
                "-g\n-n\n{}\n--args\n--flag\n{RELAUNCHED_IN_BACKGROUND}\n",
                bundle.display()
            )
        );
        assert_eq!(
            launched_with(&["codeg", "--flag"], false),
            format!("-n\n{}\n--args\n--flag\n", bundle.display())
        );
        // The instance that came back in the background, restarted by a
        // click: in front, and without the flag.
        assert_eq!(
            launched_with(&["codeg", "--flag", RELAUNCHED_IN_BACKGROUND], false),
            format!("-n\n{}\n--args\n--flag\n", bundle.display())
        );
    }

    #[test]
    fn launches_anyway_when_the_old_instance_never_exits() {
        let dir = tempfile::tempdir().unwrap();
        let open = recorder(dir.path(), "open", 0);
        let exe = recorder(dir.path(), "exe", 0);
        let mut stuck = Command::new("/bin/sleep").arg("30").spawn().unwrap();

        let started = Instant::now();
        let mut relauncher = relauncher(
            stuck.id(),
            3,
            &open,
            Path::new("/Applications/codeg.app"),
            &exe,
            &[],
            false,
        )
        .spawn()
        .unwrap();

        let launched =
            wait_for(&recorded(&open), Duration::from_secs(10)).expect("waited past its budget");
        assert_eq!(launched, "-n\n/Applications/codeg.app\n--args\n");
        // Three looks, 50 ms apart.
        assert!(started.elapsed() >= Duration::from_millis(150));
        reap(&mut relauncher);
        stuck.kill().unwrap();
        stuck.wait().unwrap();
    }
}
