//! Shell family classification shared by the built-in terminal and the ACP
//! terminal runtime.
//!
//! Both need the same question answered — "what dialect does this shell path
//! speak?" — and both used to answer it with their own copy of the same
//! basename-lowercase-match logic. The copies drifted: on Windows the built-in
//! terminal treated an unrecognized shell as cmd while the ACP runtime treated
//! it as POSIX, so a `COMSPEC` pointing at a cmd-compatible replacement got
//! `-c` instead of `/C`. One classifier keeps them honest.

use std::ffi::OsString;

use crate::app_error::AppCommandError;

/// Lowercased file name of a shell path, falling back to the raw value when the
/// path has no file-name component (e.g. `"pwsh.exe"` → `"pwsh.exe"`).
pub(crate) fn shell_basename(shell: &str) -> String {
    std::path::Path::new(shell)
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or(shell)
        .to_ascii_lowercase()
}

/// The command-line dialect a shell speaks. This is about *invocation syntax*
/// (`-c` vs `/C` vs `-Command`), not about which login/interactive flags the
/// shell accepts — see `detect_posix_shell_flavor` in `manager.rs` for that
/// narrower question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ShellFamily {
    /// `pwsh` / `powershell`: `-Command <script>`.
    PowerShell,
    /// `cmd.exe` and cmd-compatible replacements: `/D /S /C <line>`.
    Cmd,
    /// Everything with the POSIX `-c <line>` convention.
    Posix,
}

impl ShellFamily {
    /// Whether the shell resolves names the OS cannot exec on its own — its
    /// builtins and aliases. `Get-ChildItem` and `dir` are real commands to
    /// PowerShell and cmd but not to `execvp`, so a bare no-argv command that
    /// fails to spawn is worth retrying through these shells. POSIX shells
    /// have builtins too, but the ones agents send arrive inside whole command
    /// lines, which already qualify on their own.
    pub(crate) fn resolves_bare_builtins(self) -> bool {
        matches!(self, ShellFamily::PowerShell | ShellFamily::Cmd)
    }
}

/// Classify a shell path. The unknown-shell fallback is platform-specific on
/// purpose: on Windows an unrecognized `COMSPEC` is overwhelmingly a cmd
/// replacement, while on unix an unrecognized shell is overwhelmingly a
/// POSIX-ish one.
pub(crate) fn classify_shell_family(shell: &str) -> ShellFamily {
    let name = shell_basename(shell);

    if name.contains("pwsh") || name.contains("powershell") {
        return ShellFamily::PowerShell;
    }
    if name == "cmd" || name == "cmd.exe" {
        return ShellFamily::Cmd;
    }

    #[cfg(target_os = "windows")]
    {
        // Git Bash / MSYS-style shells installed on Windows still speak POSIX;
        // anything else reached through COMSPEC is a cmd replacement.
        if name.contains("bash")
            || name.contains("zsh")
            || name.contains("fish")
            || name.ends_with("sh.exe")
        {
            ShellFamily::Posix
        } else {
            ShellFamily::Cmd
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        ShellFamily::Posix
    }
}

/// How a command is handed to the shell that runs it.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ShellInvocation {
    /// Arguments, quoted for the program the usual way.
    Args(Vec<OsString>),
    /// cmd.exe's whole command line, appended verbatim (Windows only).
    CmdLine(String),
}

/// Run `command` and exit. Where the shell can evaluate a variable, the
/// command travels in `$CODEG_CMD` rather than argv to sidestep quoting — the
/// same indirection the built-in terminal uses. POSIX shells get `-l` so the
/// user's login profile (PATH for `zed`, `code`, …) applies; no `-i`, as there
/// is no TTY here. PowerShell runs the user's `$PROFILE` for the same reason:
/// it has no login mode, so that only means leaving out `-NoProfile`.
///
/// cmd.exe is the exception: it expands `%VAR%` once, over its own command
/// line, and never inside a value it expanded, so behind `%CODEG_CMD%` the
/// `%CODEG_FOLDER_PATH%` in a command would reach the program literally. The
/// command is the command line itself instead, as if typed at a prompt; `/S`
/// strips only the outer quotes around it, and `/V:OFF` keeps a `!` literal
/// even where the registry turns delayed expansion on. Splicing values into the
/// line is what `local_command`'s `reject_unsafe_cmd_variable` and
/// `reject_cmd_syntax` guard.
pub(crate) fn shell_invocation(shell: &str, command: &str) -> ShellInvocation {
    let args: Vec<&str> = match classify_shell_family(shell) {
        ShellFamily::PowerShell => vec!["-NoLogo", "-Command", "Invoke-Expression $env:CODEG_CMD"],
        ShellFamily::Cmd => {
            return ShellInvocation::CmdLine(format!("/D /V:OFF /S /C \"{command}\""))
        }
        ShellFamily::Posix if is_bash_like(shell) => vec!["-l", "-c", "eval \"$CODEG_CMD\""],
        // nu / xonsh / elvish: no assumptions about `-l` or `eval`.
        ShellFamily::Posix => vec!["-c", command],
    };
    ShellInvocation::Args(args.into_iter().map(OsString::from).collect())
}

fn is_bash_like(shell: &str) -> bool {
    matches!(
        shell_basename(shell).trim_end_matches(".exe"),
        "bash" | "zsh" | "sh" | "dash" | "ksh" | "ash" | "mksh" | "busybox" | "fish"
    )
}

/// Hand cmd.exe its command line as it is. Passed as an argument, std would
/// quote it the MSVC way, which cmd does not undo.
#[cfg(windows)]
pub(crate) fn append_cmd_line(
    child: &mut tokio::process::Command,
    line: String,
) -> Result<(), AppCommandError> {
    use std::os::windows::process::CommandExt;
    child.as_std_mut().raw_arg(line);
    Ok(())
}

/// Only a Windows host resolves its shell to cmd.exe.
#[cfg(not(windows))]
pub(crate) fn append_cmd_line(
    _child: &mut tokio::process::Command,
    line: String,
) -> Result<(), AppCommandError> {
    Err(AppCommandError::invalid_input(format!(
        "cmd.exe runs only on Windows: {line}"
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(items: &[&str]) -> ShellInvocation {
        ShellInvocation::Args(items.iter().map(OsString::from).collect())
    }

    #[test]
    fn bash_like_shells_eval_the_env_var_in_a_login_shell() {
        assert_eq!(
            shell_invocation("/bin/zsh", "zed ."),
            args(&["-l", "-c", "eval \"$CODEG_CMD\""])
        );
    }

    #[test]
    fn powershell_runs_the_users_profile_like_a_login_shell() {
        // No `-NoProfile`: the PATH that fnm, conda, … set up in `$PROFILE`
        // applies to the command, as the login profile does for POSIX shells.
        assert_eq!(
            shell_invocation("pwsh.exe", "code ."),
            args(&["-NoLogo", "-Command", "Invoke-Expression $env:CODEG_CMD"])
        );
    }

    #[test]
    fn cmd_runs_the_command_as_its_own_command_line() {
        // So cmd's one expansion pass reaches the variables in the command.
        assert_eq!(
            shell_invocation("cmd.exe", r#"code "%CODEG_FOLDER_PATH%""#),
            ShellInvocation::CmdLine(r#"/D /V:OFF /S /C "code "%CODEG_FOLDER_PATH%"""#.into())
        );
    }

    // On Windows a shell it does not recognize is taken for a cmd replacement.
    #[cfg(not(windows))]
    #[test]
    fn unknown_posix_shells_get_the_command_verbatim() {
        assert_eq!(
            shell_invocation("/usr/bin/nu", "zed ."),
            args(&["-c", "zed ."])
        );
    }

    #[test]
    fn basename_lowercases_and_strips_directories() {
        assert_eq!(shell_basename("/bin/ZSH"), "zsh");
        assert_eq!(shell_basename("pwsh.exe"), "pwsh.exe");
        assert_eq!(shell_basename("C:\\tools\\nu.exe"), {
            // On unix the backslash path has no directory component, so the
            // whole string is the file name; on Windows it is stripped.
            if cfg!(target_os = "windows") {
                "nu.exe".to_string()
            } else {
                "c:\\tools\\nu.exe".to_string()
            }
        });
    }

    #[test]
    fn powershell_is_recognized_on_every_platform() {
        assert_eq!(classify_shell_family("pwsh"), ShellFamily::PowerShell);
        assert_eq!(classify_shell_family("pwsh.exe"), ShellFamily::PowerShell);
        assert_eq!(
            classify_shell_family("C:\\Program Files\\PowerShell\\7\\powershell.exe"),
            ShellFamily::PowerShell
        );
    }

    /// `cmd` is matched by name on every platform so the ACP wrapper's cmd arm
    /// stays reachable from unix test runs.
    #[test]
    fn cmd_is_recognized_by_name_on_every_platform() {
        assert_eq!(classify_shell_family("cmd.exe"), ShellFamily::Cmd);
        assert_eq!(classify_shell_family("CMD.EXE"), ShellFamily::Cmd);
        assert_eq!(classify_shell_family("cmd"), ShellFamily::Cmd);
    }

    #[cfg(not(target_os = "windows"))]
    #[test]
    fn unknown_unix_shells_are_posix() {
        assert_eq!(classify_shell_family("/bin/sh"), ShellFamily::Posix);
        assert_eq!(
            classify_shell_family("/usr/local/bin/fish"),
            ShellFamily::Posix
        );
        assert_eq!(classify_shell_family("/opt/nu"), ShellFamily::Posix);
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn unknown_windows_shells_fall_back_to_cmd() {
        assert_eq!(
            classify_shell_family("C:\\Windows\\System32\\cmd.exe"),
            ShellFamily::Cmd
        );
        // A cmd-compatible replacement reached through COMSPEC must still get
        // cmd's `/C` convention, not POSIX `-c`.
        assert_eq!(classify_shell_family("C:\\tools\\tcc.exe"), ShellFamily::Cmd);
        assert_eq!(
            classify_shell_family("C:\\Program Files\\Git\\bin\\bash.exe"),
            ShellFamily::Posix
        );
        assert_eq!(classify_shell_family("sh.exe"), ShellFamily::Posix);
    }

    #[test]
    fn only_windows_shells_resolve_bare_builtins() {
        assert!(ShellFamily::PowerShell.resolves_bare_builtins());
        assert!(ShellFamily::Cmd.resolves_bare_builtins());
        assert!(!ShellFamily::Posix.resolves_bare_builtins());
    }
}
