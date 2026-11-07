use std::path::PathBuf;
use std::process::Stdio;

use crate::app_error::AppCommandError;
use crate::terminal::shell_flavor::{append_cmd_line, shell_invocation, ShellInvocation};

/// Run a folder command on the machine this desktop app runs on, even when the
/// window is bound to a remote codeg-server.
///
/// Every other folder-command path goes through the window's transport, which
/// in a remote-desktop window means the remote host. This one is only ever
/// called through the local shell transport, and is not routed in the web
/// server, so the command can only ever land on the user's own machine.
///
/// The command runs detached through the user's shell with nothing attached to
/// stdio — it is meant for launchers (`zed ssh://…`, `open …`), not for jobs
/// whose output matters. A successful return only means the shell was spawned.
///
/// `folder_path` is the active folder's path *on its host* (the remote path in a
/// remote-desktop window) and `remote_host` the remote server's host name; both
/// reach the command as `CODEG_FOLDER_PATH` / `CODEG_REMOTE_HOST`. `remote_host`
/// is present exactly when the window is bound to a remote server (empty when
/// its name can't be read), and so exactly when `folder_path` came from that
/// server rather than from this machine. The command runs in `working_dir` —
/// the folder, when the window is a local one — or, failing that, the home
/// directory: a remote folder's path names nothing here.
///
/// `async` because the spawn needs a tokio runtime in scope, not because it
/// awaits anything.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn run_local_command(
    command: String,
    folder_path: Option<String>,
    remote_host: Option<String>,
    working_dir: Option<String>,
) -> Result<(), AppCommandError> {
    let shell = crate::terminal::manager::resolve_shell();
    spawn_local_command(&shell, &command, folder_path, remote_host, working_dir)
}

/// [`run_local_command`] in `shell`.
fn spawn_local_command(
    shell: &str,
    command: &str,
    folder_path: Option<String>,
    remote_host: Option<String>,
    working_dir: Option<String>,
) -> Result<(), AppCommandError> {
    let command = validate_local_command(command)?;
    let remote = remote_host.is_some();
    let folder_path = folder_path.unwrap_or_default();
    let remote_host = remote_host.unwrap_or_default();
    let mut child = tokio::process::Command::new(shell);
    match shell_invocation(shell, command) {
        ShellInvocation::Args(args) => {
            child.args(args);
        }
        ShellInvocation::CmdLine(line) => {
            if remote {
                for (name, value) in [
                    ("CODEG_FOLDER_PATH", &folder_path),
                    ("CODEG_REMOTE_HOST", &remote_host),
                ] {
                    reject_unsafe_cmd_variable(command, name)?;
                    reject_cmd_syntax(name, value)?;
                }
            }
            append_cmd_line(&mut child, line)?;
        }
    }
    child
        .env("CODEG_CMD", command)
        .env("CODEG_FOLDER_PATH", folder_path)
        .env("CODEG_REMOTE_HOST", remote_host)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(dir) = resolve_working_dir(working_dir.as_deref()) {
        child.current_dir(dir);
    }
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        child.creation_flags(CREATE_NO_WINDOW);
    }

    // Dropping tokio's `Child` hands it to the runtime's orphan queue, which
    // reaps it once it exits (see `open_in::spawn_vscode`).
    child.spawn().map(|_| ()).map_err(|err| {
        AppCommandError::external_command("Failed to run local command", format!("{shell}: {err}"))
    })
}

/// Refuse `value`, the variable `name`, when it holds a character cmd.exe reads
/// as syntax. cmd splices a `%VAR%` value into its command line before it
/// parses that line, so such a value can close a quoted argument or chain a
/// command of its own: a remote folder named `/srv/x" & calc.exe & rem "` turns
/// `echo "%CODEG_FOLDER_PATH%"` into a launch of calc.exe. Only a remote
/// window's values are checked: they come from the remote server, which is not
/// trusted with this machine, while a local window's are this machine's own.
fn reject_cmd_syntax(name: &str, value: &str) -> Result<(), AppCommandError> {
    let syntax = value
        .chars()
        .find(|c| c.is_control() || matches!(c, '"' | '&' | '|' | '<' | '>' | '^' | '%' | '!'));
    match syntax {
        Some(c) => Err(AppCommandError::invalid_input(format!(
            "{name} from the remote server holds {c:?}, which cmd.exe would read as part of the command"
        ))),
        None => Ok(()),
    }
}

/// Refuse `command` unless cmd.exe is sure to splice the variable `name` inside
/// double quotes, the one place a remote window's value stays a single argument
/// (`reject_cmd_syntax` then keeps the value from closing those quotes). Outside
/// them cmd parses the spliced value like the rest of the line, so its spaces or
/// parentheses can put a command where cmd expects one: a remote folder named
/// `C:\Windows calc.exe` turns `if exist %CODEG_FOLDER_PATH% code .` into a
/// launch of calc.exe. For a remote window's commands only, as elsewhere.
///
/// The quoting is read off the source text, so the check refuses — rather than
/// try to model — anything that would make that reading lie. cmd runs `%…%`
/// expansion over the whole line before it parses quotes, and a reference's
/// `:` modifier or an embedded quote is consumed in that pass (so a
/// `%VAR:"=%` could swallow a quote the reading counts); a caret escapes the
/// quote after it; and a bare `%` can pair with a later one in ways cmd alone
/// resolves. So every `%` must open a plain `%IDENT%` reference and the command
/// must hold no caret; then each `"` is a real quote and a plain reference
/// carries none, so the count is exact.
fn reject_unsafe_cmd_variable(command: &str, name: &str) -> Result<(), AppCommandError> {
    let refuse = |why: &str| -> Result<(), AppCommandError> {
        Err(AppCommandError::invalid_input(format!(
            "a command cmd.exe runs on this computer from a remote window {why}, \
             so the remote server's %{name}% can't be read as quoted; \
             write it as plain `\"%{name}%\"`"
        )))
    };
    if command.contains('^') {
        return refuse("uses a caret (^), which can escape a double quote");
    }
    let mut quoted = false;
    let mut chars = command.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '%' => {
                // A plain `%IDENT%` reference: letters, digits, `_`, then `%`.
                let mut ident = String::new();
                loop {
                    match chars.next() {
                        Some('%') => break,
                        Some(ch) if ch.is_ascii_alphanumeric() || ch == '_' => ident.push(ch),
                        _ => {
                            return refuse(
                                "has a `%` that isn't a plain `%VAR%` reference \
                                 (a `%VAR:…%` modifier, a `for` loop's `%i`, or a literal `%`)",
                            )
                        }
                    }
                }
                if ident.is_empty() {
                    return refuse("has an empty `%%`");
                }
                if ident.eq_ignore_ascii_case(name) && !quoted {
                    return refuse("names it outside double quotes");
                }
            }
            _ => {}
        }
    }
    Ok(())
}

/// `requested` when it is a directory on this machine, else the home directory.
/// Never trimmed: a path is used exactly as given.
fn resolve_working_dir(requested: Option<&str>) -> Option<PathBuf> {
    requested
        .map(PathBuf::from)
        .filter(|dir| dir.is_dir())
        .or_else(dirs::home_dir)
}

fn validate_local_command(command: &str) -> Result<&str, AppCommandError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("command is required"));
    }
    if trimmed.contains('\0') {
        return Err(AppCommandError::invalid_input(
            "command must not contain NUL characters",
        ));
    }
    Ok(trimmed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_rejects_blank_command() {
        let err = validate_local_command("   ").expect_err("blank");
        assert!(err.message.contains("required"), "{err:?}");
    }

    #[test]
    fn validate_trims_command() {
        assert_eq!(validate_local_command("  zed .  ").unwrap(), "zed .");
    }

    #[test]
    fn runs_in_the_requested_directory_when_it_exists() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().to_str().expect("utf-8 temp path");
        assert_eq!(resolve_working_dir(Some(path)), Some(dir.path().into()));
    }

    #[test]
    fn falls_back_to_home_for_a_path_that_names_nothing_here() {
        let dir = tempfile::tempdir().expect("tempdir");
        let missing = dir.path().join("not-here");
        let missing = missing.to_str().expect("utf-8 temp path");
        assert_eq!(resolve_working_dir(Some(missing)), dirs::home_dir());
        assert_eq!(resolve_working_dir(Some("")), dirs::home_dir());
        assert_eq!(resolve_working_dir(None), dirs::home_dir());
    }

    #[test]
    fn cmd_refuses_a_remote_folder_path_it_would_read_as_syntax() {
        // Refused before anything is spawned, on every platform.
        let err = spawn_local_command(
            "cmd.exe",
            r#"echo "%CODEG_FOLDER_PATH%""#,
            Some(r#"/srv/repo" & calc.exe & rem ""#.into()),
            Some("devbox".into()),
            None,
        )
        .expect_err("refused");
        // Off Windows, cmd.exe not running would be an error naming the
        // variable too, through the command line it quotes.
        assert!(
            err.message
                .contains(r#"CODEG_FOLDER_PATH from the remote server holds '"'"#),
            "{err:?}"
        );
    }

    #[test]
    fn cmd_refuses_a_remote_variable_outside_double_quotes() {
        // Spaces alone put `calc.exe` where `if` expects its command; refused
        // before anything is spawned, on every platform.
        let err = spawn_local_command(
            "cmd.exe",
            "if exist %CODEG_FOLDER_PATH% code .",
            Some(r"C:\Windows calc.exe".into()),
            Some("devbox".into()),
            None,
        )
        .expect_err("refused");
        assert!(
            err.message.contains("names it outside double quotes")
                && err.message.contains("%CODEG_FOLDER_PATH%"),
            "{err:?}"
        );
        // Where a command runs is a switch now; there is no prefix to name.
        assert!(!err.message.contains("local:"), "{err:?}");
    }

    #[test]
    fn cmd_allows_only_plainly_quoted_remote_variables() {
        // Quoted plain references — alone, beside quoted text, or two in a row.
        for command in [
            r#"code "%CODEG_FOLDER_PATH%""#,
            r#"code "%codeg_folder_path%""#, // the name is matched case-blind
            r#"zed "ssh://me@%CODEG_REMOTE_HOST%%CODEG_FOLDER_PATH%""#,
            r#"code "a" "%CODEG_FOLDER_PATH%""#,
            // No reference to this variable: a longer name, another var, text.
            "echo %CODEG_FOLDER_PATHS% %USERPROFILE% CODEG_FOLDER_PATH",
        ] {
            assert!(
                reject_unsafe_cmd_variable(command, "CODEG_FOLDER_PATH").is_ok(),
                "{command}"
            );
        }
        // Refused: unquoted, or a construct whose quoting can't be read off the
        // text — a `:` modifier (even one that eats a quote), a caret, a `for`
        // loop's bare `%i`, or a literal `%`.
        for command in [
            "code %CODEG_FOLDER_PATH%",
            "code %codeg_folder_path%", // unquoted, found case-blind
            r#"echo "a" %CODEG_FOLDER_PATH%"#,
            r#"code "%CODEG_FOLDER_PATH:~3%""#,
            r#"code "%CODEG_FOLDER_PATH:%""#, // a bare `:` modifier
            r#"echo "%CODEG_REMOTE_HOST:"=%" %CODEG_FOLDER_PATH%"#,
            // The variable is quoted here, so only the other construct — a
            // `for` loop's `%i`, a literal `%`, a caret — draws the refusal.
            r#"for %i in ("%CODEG_FOLDER_PATH%") do echo %i"#,
            r#"echo 100% done "%CODEG_FOLDER_PATH%""#,
            r#"echo ^"%CODEG_FOLDER_PATH%^""#,
        ] {
            assert!(
                reject_unsafe_cmd_variable(command, "CODEG_FOLDER_PATH").is_err(),
                "{command}"
            );
        }
    }

    #[test]
    fn cmd_syntax_is_refused_and_ordinary_paths_pass() {
        for path in ["/home/me/My Projects/repo-1.0_x", "/srv/仓库/@scope+x=1,y~"] {
            assert!(
                reject_cmd_syntax("CODEG_FOLDER_PATH", path).is_ok(),
                "{path}"
            );
        }
        for path in [
            "/a\"b", "/a&b", "/a|b", "/a<b", "/a>b", "/a^b", "/a%PATH%", "/a!b", "/a\nb",
        ] {
            assert!(
                reject_cmd_syntax("CODEG_FOLDER_PATH", path).is_err(),
                "{path}"
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn cmd_takes_a_local_windows_folder_path_as_it_is() {
        // `C:\R&D` is a folder of this machine: no refusal, so the only error
        // left off Windows is that cmd.exe does not run here.
        let err = spawn_local_command(
            "cmd.exe",
            "echo %CODEG_FOLDER_PATH%",
            Some(r"C:\R&D".into()),
            None,
            None,
        )
        .expect_err("cmd.exe off Windows");
        assert!(err.message.contains("only on Windows"), "{err:?}");
    }

    #[cfg(not(windows))]
    #[tokio::test]
    async fn runs_command_with_folder_env_in_the_working_dir() {
        use std::time::{Duration, Instant};

        let dir = tempfile::tempdir().expect("tempdir");
        let marker = dir.path().join("marker.txt");
        run_local_command(
            format!(
                "printf '%s|%s|%s' \"$CODEG_FOLDER_PATH\" \"$CODEG_REMOTE_HOST\" \"$(pwd -P)\" > '{}'",
                marker.display()
            ),
            Some("/srv/repo".into()),
            Some("devbox".into()),
            Some(dir.path().to_str().expect("utf-8 temp path").into()),
        )
        .await
        .expect("spawn");
        // `pwd -P` resolves symlinks (macOS's /var is one).
        let expected = format!(
            "/srv/repo|devbox|{}",
            std::fs::canonicalize(dir.path())
                .expect("canonical temp dir")
                .display()
        );

        // Generous: the wait ends as soon as the marker appears, and a login
        // shell's profile (nvm, conda, …) on a busy machine can take seconds.
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            if let Ok(contents) = std::fs::read_to_string(&marker) {
                if !contents.is_empty() {
                    assert_eq!(contents, expected);
                    return;
                }
            }
            assert!(Instant::now() < deadline, "command never wrote the marker");
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}
