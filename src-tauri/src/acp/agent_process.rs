//! Spawning an external ACP agent as a child process and connecting to it
//! over stdio.
//!
//! codeg's own copy of the `AcpAgent` transport. It started life as the
//! `sacp-tokio` crate (vendored with codeg's patches) and moved in-tree when
//! codeg switched to the official `agent-client-protocol` runtime. That crate
//! ships an `AcpAgent` too — built on `async-process`; on Unix it starts the
//! child in its own process group and kills the group on drop — but it has no
//! room for the rest of what codeg depends on:
//!
//! * the whole process TREE is killed on drop (`kill_tree`), on every platform
//!   and including descendants that left the child's process group, so an
//!   `npx`/`node` launcher cannot leave the real agent behind;
//! * [`AcpAgent::with_current_dir`] sets the child's cwd (Hermes derives its
//!   working directory from the process cwd, not from `session/new`);
//! * an EMPTY env value means "remove the inherited variable" rather than "set
//!   it empty" (see `spawn_process`);
//! * [`AcpAgent::on_spawn`] publishes the pid, and [`AcpAgent::on_exit`] fires
//!   only once the child is really reaped, so a host's shutdown backstop never
//!   aims a kill at a recycled pid;
//! * a UNC workspace behind a Windows batch launcher takes a `pushd` detour so
//!   `cmd.exe` does not silently swap the cwd for `C:\Windows`.

use std::future::Future;
use std::path::PathBuf;
use std::sync::Arc;

use agent_client_protocol::schema::v1::{EnvVariable, McpServer, McpServerStdio};
use agent_client_protocol::{Client, Conductor, ConnectTo, Lines, Role};
use tokio::process::Child;
use tokio_util::compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt};

/// Which of the agent's stdio streams a line crossed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineDirection {
    /// Sent to the agent.
    Stdin,
    /// Received from the agent.
    Stdout,
    /// Written by the agent to stderr.
    Stderr,
}

/// Observer for every line crossing the agent's stdio, and which way it went.
type DebugCallback = Arc<dyn Fn(&str, LineDirection) + Send + Sync + 'static>;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;
const MAX_STDERR_CAPTURE_BYTES: usize = 1024 * 1024;

/// How long `monitor_child` keeps reading stderr once a failed child has been
/// reaped. By then whatever the agent wrote is already in the pipe's kernel
/// buffer, so reading it out takes milliseconds; 250 ms leaves room for a busy
/// machine while staying far below the 2 s `CONNECTION_LOSS_GRACE` the
/// connection gives this exit report to arrive. The cap matters when the pipe
/// never closes: a launcher that left a child of its own holding stderr would
/// otherwise stall the report until that child exits.
const STDERR_DRAIN_LIMIT: std::time::Duration = std::time::Duration::from_millis(250);

/// Windows' extended-length spelling of a UNC path, e.g. what
/// `fs::canonicalize` returns for `\\server\share`.
const VERBATIM_UNC_PREFIX: &str = r"\\?\UNC\";

fn is_windows_unc_path(path: &str) -> bool {
    let lower = path.to_ascii_lowercase();
    lower.starts_with(r"\\?\unc\")
        || (path.starts_with(r"\\") && !path.starts_with(r"\\?\") && !path.starts_with(r"\\.\"))
}

fn is_windows_batch_file(command: &std::path::Path) -> bool {
    let lower = command.to_string_lossy().to_ascii_lowercase();
    lower.ends_with(".cmd") || lower.ends_with(".bat")
}

/// True for a path `cmd.exe` runs outright, without consulting a search order:
/// drive-absolute (`C:\…`, `C:/…`) or UNC (`\\…`).
///
/// `Path::is_absolute` cannot answer this — it follows the HOST's rules, and
/// this decision has to hold (and be testable) on the Linux CI that runs this
/// crate's tests. Drive-relative (`C:x`) and root-relative (`\x`) both resolve
/// against the *current* drive and directory, so neither counts.
///
/// A forward-slash UNC spelling (`//server/share/agent.cmd`) is deliberately
/// NOT recognised, and neither is one as the cwd. Win32 accepts it, but cmd
/// reads a leading `/` inconsistently, and nothing reaches this crate spelled
/// that way — `which`, `PathBuf::join` and the OS dialogs all hand back
/// backslashes. Such a launch keeps the direct spawn, which is to say the
/// behaviour it already had; widening a hand-built cmd command line to cover
/// a shape no caller produces would cost more than it buys.
fn is_absolute_windows_path(path: &std::path::Path) -> bool {
    let Some(text) = path.to_str() else {
        return false;
    };
    if text.starts_with(r"\\") {
        return true;
    }
    let bytes = text.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && matches!(bytes[2], b'\\' | b'/')
}

/// The directory `pushd` has to map for this launch, or `None` when the plain
/// direct spawn is the right one.
///
/// This is the ONLY place that decides a launch takes the cmd detour: both the
/// command line and the `current_dir` call read it, so they cannot drift apart
/// and leave `cmd.exe` holding a UNC cwd it would silently trade for
/// `C:\Windows` — the very bug the detour exists to fix.
///
/// The launcher must already be an absolute path. Rust resolves a bare program
/// name against PATH and pointedly NOT against the child's cwd; cmd.exe's own
/// search order starts at the current directory, which `pushd` has just pointed
/// at the workspace. Taking the detour with a relative launcher would therefore
/// let an `agent.cmd` committed to the repo shadow the trusted one on PATH, so
/// that shape keeps the direct spawn instead — the cwd stays wrong there, which
/// is exactly what it already was.
///
/// The answer is the plain `\\server\share\…` spelling with any trailing
/// separator removed, because `pushd` is a cmd BUILT-IN rather than a batch
/// file, and cmd parses its own command line:
///
/// * it cannot resolve an extended-length `\\?\UNC\…` path at all (the shape
///   `fs::canonicalize` hands back on Windows), and
/// * it never undoes the `\` doubling `append_windows_batch_arg` applies to a
///   trailing backslash — right for an argument a batch file re-parses, wrong
///   here, where the doubled pair would reach `pushd` verbatim.
///
/// Either shape makes `pushd` fail, and `&&` then takes the whole agent launch
/// down with it. Every other path survives that quoting byte-for-byte, so the
/// two agree once these two shapes are ruled out.
fn windows_pushd_cwd(
    current_dir: Option<&std::path::Path>,
    command: &std::path::Path,
) -> Option<String> {
    if !is_windows_batch_file(command) || !is_absolute_windows_path(command) {
        return None;
    }
    let dir = current_dir?.to_str()?;
    if !is_windows_unc_path(dir) {
        return None;
    }
    // `\\?\UNC\server\share` → `\\server\share`; a plain UNC path keeps its
    // own leading pair. Casing is not ours to predict — Windows accepts
    // `\\?\unc\` as readily as `\\?\UNC\`.
    let rest = match dir.get(..VERBATIM_UNC_PREFIX.len()) {
        Some(head) if head.eq_ignore_ascii_case(VERBATIM_UNC_PREFIX) => {
            &dir[VERBATIM_UNC_PREFIX.len()..]
        }
        // `is_windows_unc_path` already proved the first two bytes are ASCII
        // backslashes, so this can neither split a character nor run past the
        // end.
        _ => &dir[2..],
    };
    Some(format!(r"\\{}", rest.trim_end_matches(['\\', '/'])))
}

#[cfg(windows)]
fn system_cmd_exe() -> PathBuf {
    // Avoid resolving cmd.exe from a potentially untrusted workspace. Agent
    // environment overrides are applied only after this path is selected.
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("cmd.exe")
}

/// Append one argument using the same defensive quoting rules Rust's standard
/// library applies when it launches a Windows batch file. In particular, cmd
/// metacharacters stay quoted and percent signs cannot expand environment vars.
#[cfg(any(windows, test))]
fn append_windows_batch_arg(output: &mut String, arg: &str) -> std::io::Result<()> {
    if arg.contains(['\r', '\n', '\0']) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "batch file arguments may not contain line breaks or NUL bytes",
        ));
    }

    const UNQUOTED: &str = r"#$*+-./:?@\_";
    let quote = arg.is_empty()
        || arg.ends_with('\\')
        || arg.chars().any(|ch| {
            (ch.is_ascii() && !(ch.is_ascii_alphanumeric() || UNQUOTED.contains(ch)))
                || ch.is_control()
        });

    if quote {
        output.push('"');
    }
    let mut backslashes = 0;
    for ch in arg.chars() {
        if ch == '\\' {
            backslashes += 1;
            continue;
        }
        if ch == '"' {
            output.extend(std::iter::repeat_n('\\', backslashes * 2));
            output.push_str("\"\"");
        } else {
            output.extend(std::iter::repeat_n('\\', backslashes));
            if ch == '%' || ch == '\r' {
                output.push_str("%%cd:~,");
            }
            output.push(ch);
        }
        backslashes = 0;
    }
    if quote {
        output.extend(std::iter::repeat_n('\\', backslashes * 2));
        output.push('"');
    } else {
        output.extend(std::iter::repeat_n('\\', backslashes));
    }
    Ok(())
}

#[cfg(any(windows, test))]
fn make_unc_batch_command_line(
    cwd: &str,
    command: &std::path::Path,
    args: &[String],
) -> std::io::Result<String> {
    let mut line = String::from("/e:ON /v:OFF /d /s /c \"pushd ");
    append_windows_batch_arg(&mut line, cwd)?;
    // Do not use `call`: it reparses arguments and can expand metacharacters a
    // second time. The batch file may take over this short-lived cmd process.
    line.push_str(" && ");
    append_windows_batch_arg(
        &mut line,
        command.to_str().ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "batch file path is not valid Unicode",
            )
        })?,
    )?;
    for arg in args {
        line.push(' ');
        append_windows_batch_arg(&mut line, arg)?;
    }
    line.push('"');
    Ok(line)
}

/// An external ACP agent running as a child process, connected over stdio.
///
/// Implements [`ConnectTo`] so it can be handed straight to
/// `Client.builder().connect_with(...)`: the process is spawned when the
/// connection starts, its stdout/stdin become the JSON-RPC line streams, and
/// the connection ends with an error if the process exits early.
pub struct AcpAgent {
    server: McpServer,
    debug_callback: Option<DebugCallback>,
    current_dir: Option<PathBuf>,
    spawn_callback: Option<Arc<dyn Fn(u32) + Send + Sync + 'static>>,
    exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
}

impl std::fmt::Debug for AcpAgent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AcpAgent")
            .field("server", &self.server)
            .field(
                "debug_callback",
                &self.debug_callback.as_ref().map(|_| "..."),
            )
            .field("current_dir", &self.current_dir)
            .field(
                "spawn_callback",
                &self.spawn_callback.as_ref().map(|_| "..."),
            )
            .field("exit_callback", &self.exit_callback.as_ref().map(|_| "..."))
            .finish()
    }
}

impl AcpAgent {
    /// Create a new `AcpAgent` from an [`McpServer`] launch configuration.
    pub fn new(server: McpServer) -> Self {
        Self {
            server,
            debug_callback: None,
            current_dir: None,
            spawn_callback: None,
            exit_callback: None,
        }
    }

    /// Add a debug callback that will be invoked for each line sent/received.
    ///
    /// The callback receives the line content and the direction (stdin/stdout/stderr).
    /// This is useful for logging, debugging, or monitoring agent communication.
    ///
    pub fn with_debug<F>(mut self, callback: F) -> Self
    where
        F: Fn(&str, LineDirection) + Send + Sync + 'static,
    {
        self.debug_callback = Some(Arc::new(callback));
        self
    }

    /// Set the working directory for the spawned agent process.
    ///
    /// Without this the child inherits the parent process's cwd. Agents that
    /// derive their effective working directory from the process cwd (e.g.
    /// Hermes' local backend force-exports `TERMINAL_CWD = os.getcwd()`)
    /// rather than from the ACP `session/new` `cwd` need this to run in the
    /// right place.
    pub fn with_current_dir(mut self, dir: impl Into<PathBuf>) -> Self {
        self.current_dir = Some(dir.into());
        self
    }

    /// Register a callback invoked once with the OS process id (pid) of the
    /// spawned agent process, right after it launches.
    ///
    /// The child is otherwise owned entirely by
    /// [`ConnectTo::connect_to`]'s internal `ChildGuard`, which kills the
    /// whole process tree on drop. But that drop
    /// only runs when the driving future completes — during a host-process
    /// shutdown the driver may be torn down before it can, leaking the agent
    /// (and its own child processes) as orphans. Exposing the pid lets the host
    /// record it and force a synchronous `kill_tree` on exit as a backstop.
    ///
    pub fn on_spawn<F>(mut self, callback: F) -> Self
    where
        F: Fn(u32) + Send + Sync + 'static,
    {
        self.spawn_callback = Some(Arc::new(callback));
        self
    }

    /// Register a callback invoked once when the agent process has been
    /// *reaped* — the counterpart to [`on_spawn`](Self::on_spawn), telling a
    /// host that the pid it recorded no longer names this process.
    ///
    /// It deliberately does NOT fire merely because the connection ended. When
    /// the protocol future finishes first, the internal `ChildGuard` kills the
    /// tree on drop, but `kill_tree` only signals (SIGTERM on Unix) and does
    /// not wait — the process can still be alive, so a host that cleared its
    /// pid record there would disarm its own shutdown backstop.
    ///
    /// The callback fires only where the pid genuinely stops being ours: after
    /// a successful `wait`, on drop of an already-reaped child, or from the
    /// detached reaper that `drop` hands a still-running child to. That last
    /// one is why the guard keeps owning the child instead of letting it fall
    /// into Tokio's orphan queue — a pid reaped out of sight would go stale
    /// while the host still believed it named this agent.
    ///
    pub fn on_exit<F>(mut self, callback: F) -> Self
    where
        F: Fn() + Send + Sync + 'static,
    {
        self.exit_callback = Some(Arc::new(callback));
        self
    }

    /// Spawn the process and get stdio streams.
    /// Used internally by the Component trait implementation.
    pub fn spawn_process(
        &self,
    ) -> Result<
        (
            tokio::process::ChildStdin,
            tokio::process::ChildStdout,
            tokio::process::ChildStderr,
            Child,
        ),
        agent_client_protocol::Error,
    > {
        match &self.server {
            McpServer::Stdio(stdio) => {
                // cmd.exe cannot use a UNC path as its process cwd, and a
                // batch launcher always runs under cmd.exe (std spawns one for
                // any `.cmd`/`.bat` program). Left alone it drops the cwd for
                // `C:\Windows`, so that one combination is launched through a
                // `pushd` detour instead, which maps the share to a temporary
                // drive first. `None` on every other host and every other
                // launch — and the single decision both branches below read.
                let pushd_cwd = if cfg!(windows) {
                    windows_pushd_cwd(self.current_dir.as_deref(), &stdio.command)
                } else {
                    None
                };
                #[cfg(windows)]
                let mut cmd = {
                    use std::os::windows::process::CommandExt;

                    if let Some(dir) = pushd_cwd.as_deref() {
                        let command_line =
                            make_unc_batch_command_line(dir, &stdio.command, &stdio.args)
                                .map_err(agent_client_protocol::Error::into_internal_error)?;
                        let mut command = tokio::process::Command::new(system_cmd_exe());
                        command.as_std_mut().raw_arg(command_line);
                        command
                    } else {
                        let mut command = tokio::process::Command::new(&stdio.command);
                        command.args(&stdio.args);
                        command
                    }
                };
                #[cfg(not(windows))]
                let mut cmd = {
                    let mut command = tokio::process::Command::new(&stdio.command);
                    command.args(&stdio.args);
                    command
                };
                for env_var in &stdio.env {
                    // codeg convention: an empty value means "ensure this var is
                    // ABSENT from the child" (strip an inherited value) rather
                    // than setting it empty. The child otherwise inherits this
                    // process's environment, so this lets the launch layer
                    // deterministically clear a leaked credential — e.g. Cursor
                    // subscription mode removing an inherited CURSOR_API_KEY so
                    // the CLI uses its browser-login credential. No current
                    // caller passes an intentional empty value.
                    if env_var.value.is_empty() {
                        cmd.env_remove(&env_var.name);
                    } else {
                        cmd.env(&env_var.name, &env_var.value);
                    }
                }
                // The session's environment, not the one an AppImage's
                // launcher set up for codeg itself. After the launch env,
                // whose PATH is built from codeg's own.
                crate::appimage_env::restore_tokio(&mut cmd);
                if let Some(dir) = &self.current_dir {
                    // The `pushd` detour already owns the cwd for this launch,
                    // and handing the same UNC path to `CreateProcess` is the
                    // very thing cmd.exe would refuse.
                    if pushd_cwd.is_none() {
                        cmd.current_dir(dir);
                    }
                }
                #[cfg(windows)]
                {
                    cmd.creation_flags(CREATE_NO_WINDOW);
                }
                // 智能体自己当组长（pgid = pid）。它起的命令默认留在这一组里，
                // 智能体死了以后它们被过继给 1 号进程、不在进程树里了，
                // `ChildGuard` 照样能按组把它们收掉。
                #[cfg(unix)]
                cmd.process_group(0);
                // 每次起智能体一个唯一的标记。它起的命令都继承这个环境变量，
                // 用 setsid 离组、被过继给 1 号进程都不影响，收尾时按标记再找一遍
                // （见 [`RunMarker::sweep`]）。
                let run_marker = uuid::Uuid::new_v4().to_string();
                cmd.env(AGENT_RUN_ENV, &run_marker);
                // 智能体自己当「收养人」（child subreaper）：它下面的命令父进程先退出时，
                // 过继给智能体而不是 1 号进程，智能体活着时就一直在它的进程树里。
                // 这样连 `env -i` 清掉了标记的命令，断开时也能按进程树找到
                // （见 [`RunMarker::with_descendants_of`]）。这个设置跨 exec 保留。
                #[cfg(target_os = "linux")]
                // SAFETY: 闭包在 fork 之后、exec 之前跑，只调一个系统调用，
                // 不分配内存、不碰锁，满足 `pre_exec` 的要求。
                unsafe {
                    cmd.pre_exec(|| {
                        libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0);
                        Ok(())
                    });
                }
                cmd.stdin(std::process::Stdio::piped())
                    .stdout(std::process::Stdio::piped())
                    .stderr(std::process::Stdio::piped());

                let mut child = cmd.spawn().map_err(agent_client_protocol::Error::into_internal_error)?;
                if let Some(pid) = child.id() {
                    register_run_marker(pid, run_marker);
                }

                let child_stdin = child
                    .stdin
                    .take()
                    .ok_or_else(|| agent_client_protocol::util::internal_error("Failed to open stdin"))?;
                let child_stdout = child
                    .stdout
                    .take()
                    .ok_or_else(|| agent_client_protocol::util::internal_error("Failed to open stdout"))?;
                let child_stderr = child
                    .stderr
                    .take()
                    .ok_or_else(|| agent_client_protocol::util::internal_error("Failed to open stderr"))?;

                Ok((child_stdin, child_stdout, child_stderr, child))
            }
            McpServer::Http(_) => Err(agent_client_protocol::util::internal_error(
                "HTTP transport not yet supported by AcpAgent",
            )),
            McpServer::Sse(_) => Err(agent_client_protocol::util::internal_error(
                "SSE transport not yet supported by AcpAgent",
            )),
            _ => Err(agent_client_protocol::util::internal_error(
                "Unknown MCP server transport type",
            )),
        }
    }
}

/// A wrapper around Child that kills the process when dropped.
struct ChildGuard {
    /// `None` once the child has been handed to the detached reaper in `drop`.
    child: Option<Child>,
    /// Fired exactly once, at the moment the child is *reaped* — see
    /// [`AcpAgent::on_exit`] for why that moment, and only that moment, is the
    /// one worth reporting.
    exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
    /// 子进程自己当组长的那个进程组（见 [`own_process_group`]）。子进程收尸
    /// 以后，组里剩下的进程（智能体起的命令、放到后台的服务）一起结束。
    process_group: Option<u32>,
    /// `spawn_process` 给这个智能体打的标记（见 [`AGENT_RUN_ENV`]）。收尸以后
    /// 按它把离开了进程组、进程树的命令也收掉。
    run_marker: Option<RunMarker>,
}

impl ChildGuard {
    fn new(child: Child, exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>) -> Self {
        let process_group = child.id().and_then(own_process_group);
        let run_marker = child.id().and_then(RunMarker::for_pid);
        Self {
            child: Some(child),
            exit_callback,
            process_group,
            run_marker,
        }
    }

    async fn wait(&mut self) -> std::io::Result<std::process::ExitStatus> {
        let Some(child) = self.child.as_mut() else {
            return Err(std::io::Error::other("child already handed to the reaper"));
        };
        // Linux 上智能体活着时定期记下它的进程树：它被直接杀掉时，收养关系
        // 跟着没了，`env -i` 清掉标记的命令只能靠记下的树找到；它下面的 CLI
        // 死了（智能体还活着、连接不断）时，CLI 起的命令当场结束。
        #[cfg(target_os = "linux")]
        let status = match (child.id(), self.run_marker.as_mut()) {
            (Some(root), Some(marker)) => {
                let mut tick = tokio::time::interval(TREE_SNAPSHOT_INTERVAL);
                tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                loop {
                    tokio::select! {
                        status = child.wait() => break status,
                        _ = tick.tick() => {
                            // 智能体这时还没收尸（只有上面的 `wait` 会收），号还是它的。
                            let now = tokio::task::spawn_blocking(move || descendant_tree(root))
                                .await
                                .unwrap_or_default();
                            let orphaned = marker.refresh_tree(root, now);
                            if !orphaned.is_empty() {
                                tokio::task::spawn_blocking(move || {
                                    finish_marked_processes_blocking(
                                        None,
                                        &orphaned,
                                        PROCESS_GROUP_KILL_GRACE,
                                    );
                                });
                            }
                        }
                    }
                }
            }
            _ => child.wait().await,
        };
        #[cfg(not(target_os = "linux"))]
        let status = child.wait().await;
        if status.is_ok() {
            // `wait` succeeded, so the child has been reaped and its pid is
            // free for the OS to reassign.
            if let Some(pgid) = self.process_group.take() {
                sweep_process_group(pgid);
            }
            if let Some(marker) = self.run_marker.take() {
                marker.sweep();
            }
            self.notify_exit();
        }
        status
    }

    fn notify_exit(&mut self) {
        if let Some(callback) = self.exit_callback.take() {
            callback();
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        let Some(mut child) = self.child.take() else {
            return;
        };
        let Some(pid) = child.id() else {
            // Already reaped, so the pid is free — report the exit.
            let _ = child.start_kill();
            if let Some(pgid) = self.process_group.take() {
                sweep_process_group(pgid);
            }
            if let Some(marker) = self.run_marker.take() {
                marker.sweep();
            }
            self.notify_exit();
            return;
        };

        // 智能体还没收尸、还是收养人：趁现在记下它整棵进程树（含 `env -i`
        // 清掉了标记、被它收养的命令），收尸后它们会被过继给 1 号进程。
        let run_marker = self
            .run_marker
            .take()
            .map(|marker| marker.with_descendants_of(pid));
        let _ = kill_tree::blocking::kill_tree(pid);
        // 子进程还没收尸，组号不会被别人占去：现在就给整组发 SIGTERM，
        // 进程树里够不着的（已经被过继走的）也一起收到。
        let process_group = self.process_group.take();
        if let Some(pgid) = process_group {
            signal_process_group(pgid, ProcessGroupSignal::Terminate);
        }

        // `kill_tree` only signals (SIGTERM on Unix) and does not wait, so the
        // process may well outlive this call. Keep OWNING the child until it is
        // really reaped, and report the exit from there.
        //
        // Simply dropping it here would hand it to Tokio's orphan queue, which
        // reaps it out of sight: the pid would silently become reusable while a
        // host still held it as "this agent", and a later kill could land on an
        // unrelated process tree. Holding the child keeps the pid pinned — a
        // zombie on Unix, an open process handle on Windows — until we ourselves
        // observe the exit and say so.
        let exit_callback = self.exit_callback.take();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn(async move {
                    // Same gate as `ChildGuard::wait`: only a successful `wait`
                    // proves the child was reaped. Reporting an exit we failed
                    // to observe would tell the host to stop tracking a pid
                    // whose process may still be running.
                    let waited = match process_group {
                        // 智能体自己当组长时，不理 SIGTERM 的不能一直等下去：
                        // 半秒后给整组补 SIGKILL。组长这时还没收尸，组号还是
                        // 我们的，打不到别人。
                        Some(pgid) => {
                            match tokio::time::timeout(PROCESS_GROUP_KILL_GRACE, child.wait()).await
                            {
                                Ok(waited) => waited,
                                Err(_) => {
                                    signal_process_group(pgid, ProcessGroupSignal::Kill);
                                    child.wait().await
                                }
                            }
                        }
                        None => child.wait().await,
                    };
                    if waited.is_ok() {
                        if let Some(pgid) = process_group {
                            sweep_process_group(pgid);
                        }
                        if let Some(marker) = run_marker {
                            marker.sweep();
                        }
                        if let Some(callback) = exit_callback {
                            callback();
                        }
                    }
                });
            }
            Err(_) => {
                // Dropped outside a runtime, so there is nothing to reap on.
                // Fall back to the previous behaviour and deliberately stay
                // silent about an exit we cannot observe.
                drop(child);
                // 等不了收尸，按标记找到的进程现在就收掉。
                if let Some(marker) = run_marker {
                    marker.sweep();
                }
            }
        }
    }
}

/// 组长收尸以后，组里还不走的进程等多久补 SIGKILL。和 `manager.rs` 的
/// `ESCALATE_TO_SIGKILL_AFTER` 一样长。
const PROCESS_GROUP_KILL_GRACE: std::time::Duration = std::time::Duration::from_millis(500);

/// 智能体活着时多久记一次它的进程树（见 [`RunMarker::refresh_tree`]）。
#[cfg(target_os = "linux")]
const TREE_SNAPSHOT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(1);

/// 给进程组发的信号。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessGroupSignal {
    Terminate,
    Kill,
}

/// `pid` 自己当组长时返回它的组号：`spawn_process` 在 unix 上用
/// `process_group(0)` 起智能体，组号就是它的 pid。别的情况（Windows、测试里
/// 没单独分组的子进程）返回 `None`，免得把信号发到 codeg 自己所在的组。
/// 只能在子进程还没收尸时调，pid 才不会是别人的。
fn own_process_group(pid: u32) -> Option<u32> {
    #[cfg(unix)]
    {
        // SAFETY: `getpgid` 只读进程表，不碰我们的内存。
        let pgid = unsafe { libc::getpgid(pid as libc::pid_t) };
        (pgid > 0 && pgid as u32 == pid).then_some(pid)
    }
    #[cfg(not(unix))]
    {
        let _ = pid;
        None
    }
}

/// 给整组发信号。组里已经没有进程（ESRCH）返回 `false`。
pub(crate) fn signal_process_group(pgid: u32, signal: ProcessGroupSignal) -> bool {
    #[cfg(unix)]
    {
        let signal = match signal {
            ProcessGroupSignal::Terminate => libc::SIGTERM,
            ProcessGroupSignal::Kill => libc::SIGKILL,
        };
        // SAFETY: `killpg` 只收整数，不碰我们的内存。
        unsafe { libc::killpg(pgid as libc::pid_t, signal) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = (pgid, signal);
        false
    }
}

/// 组长（智能体）已经收尸以后，把组里剩下的进程收掉：先 SIGTERM，
/// [`PROCESS_GROUP_KILL_GRACE`] 后还有就 SIGKILL。不阻塞调用方，等待放在
/// 单独的任务里；没有 tokio 运行时就直接 SIGKILL。
///
/// 组里还有进程时，内核不会把这个组号当 pid 分给新进程，所以 SIGTERM
/// 打不到别人；半秒后补的 SIGKILL 赶上组刚好空了、号又被一个自己当组长的
/// 新进程拿去，才会打错，和 `workbench_apps` 停应用时冒的险一样。
fn sweep_process_group(pgid: u32) {
    if !signal_process_group(pgid, ProcessGroupSignal::Terminate) {
        return;
    }
    match tokio::runtime::Handle::try_current() {
        Ok(handle) => {
            handle.spawn(async move {
                tokio::time::sleep(PROCESS_GROUP_KILL_GRACE).await;
                signal_process_group(pgid, ProcessGroupSignal::Kill);
            });
        }
        Err(_) => {
            signal_process_group(pgid, ProcessGroupSignal::Kill);
        }
    }
}

/// 组里还有进程（僵尸也算）。
fn process_group_alive(pgid: u32) -> bool {
    #[cfg(unix)]
    {
        // SAFETY: 信号 0 只查组在不在，什么也不发。
        unsafe { libc::killpg(pgid as libc::pid_t, 0) == 0 }
    }
    #[cfg(not(unix))]
    {
        let _ = pgid;
        false
    }
}

/// 阻塞版的 [`sweep_process_group`]，给程序退出、断开兜底这些等不了后台任务的
/// 地方用：组长已经收尸（或者已经收到 SIGTERM）以后，在当前线程上最多等
/// `grace`，组里还有进程就直接补 SIGKILL 再返回。`sweep_process_group` 挂在
/// 运行时上的那次 SIGKILL 赶上运行时关掉会被取消，这里不靠它。
///
/// 只在 `spawn_blocking` 这类阻塞线程上调。
pub(crate) fn finish_process_group_blocking(pgid: u32, grace: std::time::Duration) {
    let started = std::time::Instant::now();
    while process_group_alive(pgid) {
        if started.elapsed() >= grace {
            signal_process_group(pgid, ProcessGroupSignal::Kill);
            return;
        }
        std::thread::sleep(std::time::Duration::from_millis(50));
    }
}

/// 给智能体打标记的环境变量名。值是每次起智能体时新生成的 uuid，
/// 它起的所有命令都继承下来。
pub(crate) const AGENT_RUN_ENV: &str = "CODEG_AGENT_RUN";

/// 还没收完尾的智能体：pid → 标记。退出兜底（`manager.rs` 的
/// `kill_tree_and_wait`）手里只有 pid，靠这张表找到标记。
fn run_markers() -> &'static std::sync::Mutex<std::collections::HashMap<u32, String>> {
    static MARKERS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<u32, String>>> =
        std::sync::OnceLock::new();
    MARKERS.get_or_init(Default::default)
}

fn register_run_marker(pid: u32, marker: String) {
    if let Ok(mut markers) = run_markers().lock() {
        markers.insert(pid, marker);
    }
}

/// 一个智能体的标记。只在 [`ChildGuard`] 收尾时从表里摘掉，
/// 摘之前先核对值，免得把同一个 pid 号上后来起的智能体的标记摘了。
pub(crate) struct RunMarker {
    pid: u32,
    value: String,
    /// 智能体收尸前记下的它整棵进程树：pid 和启动时刻（见 [`process_stat`]），
    /// 收尸后按启动时刻核对，号被别人占去了也打不到别人。
    descendants: Vec<(u32, u64)>,
    /// 上一次记下的进程树：pid、父进程号、启动时刻。用来看出智能体的哪个
    /// 直接子进程（CLI）死了、它下面原来有哪些命令。只 Linux 读它。
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    tree: Vec<(u32, u32, u64)>,
    /// 上一次记树时智能体的直接子进程跑的程序：pid、启动时刻、`/proc/<pid>/exe`。
    /// CLI 死了以后才读不到它的程序，所以每次记树时先记下来。只 Linux 读它。
    #[cfg_attr(not(target_os = "linux"), allow(dead_code))]
    child_programs: Vec<(u32, u64, PathBuf)>,
}

impl RunMarker {
    /// `pid` 的智能体还没收尸时调，号才不会是别人的。
    pub(crate) fn for_pid(pid: u32) -> Option<Self> {
        let markers = run_markers().lock().ok()?;
        markers.get(&pid).map(|value| Self {
            pid,
            value: value.clone(),
            descendants: Vec::new(),
            tree: Vec::new(),
            child_programs: Vec::new(),
        })
    }

    /// 记下 `root`（智能体）现在的整棵进程树，收尾时连同带标记的进程一起收。
    /// 智能体是收养人（见 `spawn_process`），离组又被过继的命令、`env -i`
    /// 清掉了标记的命令，只要智能体还活着就都在这棵树里。
    /// 只能在智能体还没收尸时调。
    /// 和之前定期记下的合在一起（之前记下、现在已经不在树里但还活着的也留着）。
    pub(crate) fn with_descendants_of(mut self, root: u32) -> Self {
        self.merge_tree(descendant_tree(root));
        self
    }

    /// 把这次记下的树 `now` 并进来：树里的都记下，之前记下、这次不在树里、
    /// 启动时刻还对得上的也留着（智能体刚死、它们刚被过继走的那一下）。
    fn merge_tree(&mut self, now: Vec<(u32, u32, u64)>) {
        let still_live = live_descendants(&self.descendants);
        let mut merged: Vec<(u32, u64)> =
            now.iter().map(|(pid, _, start)| (*pid, *start)).collect();
        for entry in &self.descendants {
            if !merged.contains(entry) && still_live.contains(&entry.0) {
                merged.push(*entry);
            }
        }
        self.descendants = merged;
        self.tree = now;
    }

    /// 智能体活着时定期调：记下它现在的进程树，返回上次记下以后死掉的直接
    /// 子进程（claude-agent-acp 下面的 Claude CLI）原来下面的命令，调用方把它们
    /// 收掉。它们已经被智能体收养，连接也不会因此断开，不收就一直跑到重新连接。
    ///
    /// CLI 在两次记树之间才起的命令、又跟着 CLI 一起没了主人的，上一次的树里
    /// 没有，这一次成了智能体新冒出来的直接子进程：跑的程序和智能体自己、
    /// 死掉的 CLI 都不一样的，算 CLI 留下的，连它下面的一起收。和它们跑同一个
    /// 程序的新直接子进程当成智能体新起的 CLI，不碰。
    #[cfg(target_os = "linux")]
    fn refresh_tree(&mut self, root: u32, now: Vec<(u32, u32, u64)>) -> Vec<(u32, u64)> {
        let program = |pid: u32| std::fs::read_link(format!("/proc/{pid}/exe")).ok();
        let mut orphaned = orphaned_by_dead_children(root, &self.tree, &now);
        let dead = dead_direct_children(root, &self.tree, &now);
        if !dead.is_empty() {
            let mut known: Vec<PathBuf> = self
                .child_programs
                .iter()
                .filter(|(pid, start, _)| dead.contains(&(*pid, *start)))
                .map(|(_, _, exe)| exe.clone())
                .collect();
            known.extend(program(root));
            for entry in adopted_in_the_gap(root, &self.tree, &now, |pid| {
                program(pid).is_some_and(|exe| !known.contains(&exe))
            }) {
                if !orphaned.contains(&entry) {
                    orphaned.push(entry);
                }
            }
        }
        self.child_programs = now
            .iter()
            .filter(|(_, ppid, _)| *ppid == root)
            .filter_map(|(pid, _, start)| Some((*pid, *start, program(*pid)?)))
            .collect();
        self.merge_tree(now);
        orphaned
    }

    fn forget(&self) {
        if let Ok(mut markers) = run_markers().lock() {
            if markers.get(&self.pid) == Some(&self.value) {
                markers.remove(&self.pid);
            }
        }
    }

    /// 智能体收尸以后调：把带这个标记、还在跑的进程收掉（先 SIGTERM，
    /// [`PROCESS_GROUP_KILL_GRACE`] 后还在就 SIGKILL）。扫进程表放在阻塞线程上，
    /// 不阻塞调用方；没有 tokio 运行时就当场 SIGTERM 加 SIGKILL。
    fn sweep(self) {
        self.forget();
        match tokio::runtime::Handle::try_current() {
            Ok(handle) => {
                handle.spawn_blocking(move || {
                    finish_marked_processes_blocking(
                        Some(&self.value),
                        &self.descendants,
                        PROCESS_GROUP_KILL_GRACE,
                    );
                });
            }
            Err(_) => finish_marked_processes_blocking(
                Some(&self.value),
                &self.descendants,
                std::time::Duration::ZERO,
            ),
        }
    }

    /// 阻塞版，给退出兜底用：返回时带标记的进程已经收到 SIGTERM，
    /// `grace` 内没走的也补了 SIGKILL。只在阻塞线程上调。
    pub(crate) fn finish_blocking(self, grace: std::time::Duration) {
        self.forget();
        finish_marked_processes_blocking(Some(&self.value), &self.descendants, grace);
    }
}

/// 进程表里带 `CODEG_AGENT_RUN=<marker>` 的进程（不含 codeg 自己）。
/// 只有 Linux 能读别的进程的初始环境（`/proc/<pid>/environ`，只读得到同一用户的）；
/// 别的系统返回空，照旧只靠进程组和进程树。
fn marked_processes(marker: &str) -> Vec<u32> {
    #[cfg(target_os = "linux")]
    {
        let needle = format!("{AGENT_RUN_ENV}={marker}");
        let me = std::process::id();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        entries
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .filter(|pid| *pid != me)
            .filter(|pid| {
                std::fs::read(format!("/proc/{pid}/environ")).is_ok_and(|environ| {
                    environ
                        .split(|byte| *byte == 0)
                        .any(|entry| entry == needle.as_bytes())
                })
            })
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = marker;
        Vec::new()
    }
}

/// `/proc/<pid>/stat` 里的状态、父进程号和启动时刻（开机后的时钟滴答数）。
/// 同一个 pid 号换了进程，启动时刻就不一样。只 Linux。
#[cfg(target_os = "linux")]
fn process_stat(pid: u32) -> Option<(char, u32, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    // 进程名在括号里、自己也可能带括号和空格，从最后一个 `)` 往后数。
    let fields: Vec<&str> = stat
        .get(stat.rfind(')')? + 1..)?
        .split_whitespace()
        .collect();
    let state = fields.first()?.chars().next()?;
    let ppid = fields.get(1)?.parse().ok()?;
    let start = fields.get(19)?.parse().ok()?;
    Some((state, ppid, start))
}

/// `root` 现在的所有后代（不含 `root`、codeg 自己和僵尸）：pid、父进程号和
/// 启动时刻。别的系统返回空。
fn descendant_tree(root: u32) -> Vec<(u32, u32, u64)> {
    #[cfg(target_os = "linux")]
    {
        let me = std::process::id();
        let Ok(entries) = std::fs::read_dir("/proc") else {
            return Vec::new();
        };
        let table: Vec<(u32, u32, u64)> = entries
            .filter_map(|entry| entry.ok()?.file_name().to_str()?.parse::<u32>().ok())
            .filter_map(|pid| {
                let (state, ppid, start) = process_stat(pid)?;
                (state != 'Z').then_some((pid, ppid, start))
            })
            .collect();
        let mut found: Vec<(u32, u32, u64)> = Vec::new();
        let mut frontier = vec![root];
        while let Some(parent) = frontier.pop() {
            for (pid, ppid, start) in &table {
                if *ppid == parent
                    && *pid != me
                    && *pid != root
                    && !found.iter().any(|(p, _, _)| p == pid)
                {
                    found.push((*pid, *ppid, *start));
                    frontier.push(*pid);
                }
            }
        }
        found
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = root;
        Vec::new()
    }
}

/// 上次记下的树 `prev` 里 `root` 的直接子进程，这次（`now`）不在了的，它们
/// 原来下面的所有后代（pid 和启动时刻，不含死掉的那个本身）。
#[cfg(target_os = "linux")]
fn orphaned_by_dead_children(
    root: u32,
    prev: &[(u32, u32, u64)],
    now: &[(u32, u32, u64)],
) -> Vec<(u32, u64)> {
    let alive = |pid: u32, start: u64| now.iter().any(|(p, _, s)| *p == pid && *s == start);
    let mut frontier: Vec<u32> = prev
        .iter()
        .filter(|(pid, ppid, start)| *ppid == root && !alive(*pid, *start))
        .map(|(pid, _, _)| *pid)
        .collect();
    let mut orphaned: Vec<(u32, u64)> = Vec::new();
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, start) in prev {
            if *ppid == parent && !orphaned.iter().any(|(p, _)| p == pid) {
                orphaned.push((*pid, *start));
                frontier.push(*pid);
            }
        }
    }
    orphaned
}

/// 上次记下的树 `prev` 里 `root` 的直接子进程，这次（`now`）不在了的：pid 和启动时刻。
#[cfg(target_os = "linux")]
fn dead_direct_children(
    root: u32,
    prev: &[(u32, u32, u64)],
    now: &[(u32, u32, u64)],
) -> Vec<(u32, u64)> {
    prev.iter()
        .filter(|(pid, ppid, start)| {
            *ppid == root && !now.iter().any(|(p, _, s)| p == pid && s == start)
        })
        .map(|(pid, _, start)| (*pid, *start))
        .collect()
}

/// 这次（`now`）`root` 新冒出来的直接子进程（上次 `prev` 里没有这个 pid 和
/// 启动时刻）里，`is_orphan` 认定是别人留下的，连同它们这次的整棵子树：
/// pid 和启动时刻。
#[cfg(target_os = "linux")]
fn adopted_in_the_gap(
    root: u32,
    prev: &[(u32, u32, u64)],
    now: &[(u32, u32, u64)],
    is_orphan: impl Fn(u32) -> bool,
) -> Vec<(u32, u64)> {
    let mut found: Vec<(u32, u64)> = now
        .iter()
        .filter(|(pid, ppid, start)| {
            *ppid == root && !prev.iter().any(|(p, _, s)| p == pid && s == start) && is_orphan(*pid)
        })
        .map(|(pid, _, start)| (*pid, *start))
        .collect();
    let mut frontier: Vec<u32> = found.iter().map(|(pid, _)| *pid).collect();
    while let Some(parent) = frontier.pop() {
        for (pid, ppid, start) in now {
            if *ppid == parent && !found.iter().any(|(p, _)| p == pid) {
                found.push((*pid, *start));
                frontier.push(*pid);
            }
        }
    }
    found
}

/// 收尸前记下的后代里还活着的：启动时刻对得上（号没被别人占去）、不是僵尸。
fn live_descendants(descendants: &[(u32, u64)]) -> Vec<u32> {
    #[cfg(target_os = "linux")]
    {
        descendants
            .iter()
            .filter(|(pid, start)| {
                process_stat(*pid).is_some_and(|(state, _, now)| now == *start && state != 'Z')
            })
            .map(|(pid, _)| *pid)
            .collect()
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = descendants;
        Vec::new()
    }
}

/// 这次要收的进程：带标记的，加上收尸前记下、还活着的后代。
fn marked_or_remembered(marker: Option<&str>, descendants: &[(u32, u64)]) -> Vec<u32> {
    let mut pids = marker.map(marked_processes).unwrap_or_default();
    for pid in live_descendants(descendants) {
        if !pids.contains(&pid) {
            pids.push(pid);
        }
    }
    pids
}

/// 给带标记的进程和收尸前记下的后代发 SIGTERM，最多等 `grace`，还在的补 SIGKILL。
/// `marker` 为 `None` 时只收 `descendants`。
/// 每次都重新扫：带标记的按标记，记下的后代按启动时刻核对，pid 号被别人占去
/// 也打不到别人（扫完到发信号之间那一下除外）。僵尸的 environ 读出来是空的，
/// 记下的后代成了僵尸也不算，都不在内。
fn finish_marked_processes_blocking(
    marker: Option<&str>,
    descendants: &[(u32, u64)],
    grace: std::time::Duration,
) {
    #[cfg(unix)]
    {
        let signal_all = |signal: libc::c_int| {
            let pids = marked_or_remembered(marker, descendants);
            for pid in &pids {
                // SAFETY: `kill` 只收整数，不碰我们的内存。
                unsafe {
                    libc::kill(*pid as libc::pid_t, signal);
                }
            }
            !pids.is_empty()
        };
        if !signal_all(libc::SIGTERM) {
            return;
        }
        let started = std::time::Instant::now();
        while started.elapsed() < grace {
            std::thread::sleep(std::time::Duration::from_millis(50));
            if marked_or_remembered(marker, descendants).is_empty() {
                return;
            }
        }
        // 收的时候又起了新的也一起收：最多补两轮。
        for _ in 0..2 {
            if !signal_all(libc::SIGKILL) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (marked_or_remembered(marker, descendants), grace);
    }
}

fn append_limited_utf8(output: &mut String, chunk: &str, limit: usize) -> bool {
    output.push_str(chunk);
    if output.len() <= limit {
        return false;
    }

    let mut start = output.len().saturating_sub(limit);
    while start < output.len() && !output.is_char_boundary(start) {
        start += 1;
    }

    output.drain(..start);
    true
}

/// `line` from the agent, without the `"data": null` of an error response.
///
/// agent-client-protocol 3 keeps an explicit `null` there as data
/// (`Some(Value::Null)`; 2.x read it as absent), and the error's `Display`
/// then ends in ": null", so every message codeg shows from such an error
/// would read "Authentication required: null". The Python ACP SDK writes the
/// key into every error it sends (`RequestError.to_error_obj`). A null carries
/// nothing to act on, so dropping the key loses nothing.
///
/// Only an error response's own `error.data` goes, alone or in a batch: a
/// message with a `method` keeps whatever it carries. JSON has one spelling of
/// `null`, so a line without it is passed on without being read. The rest are
/// first read without being built ([`has_null_error_data`]), and a line is
/// re-serialized only when a key actually went.
fn omit_null_error_data(line: String) -> String {
    if !line.contains("null") || has_null_error_data(&line) == Some(false) {
        return line;
    }
    let Ok(mut message) = serde_json::from_str::<serde_json::Value>(&line) else {
        return line;
    };
    let omit = |message: &mut serde_json::Value| {
        message.get("method").is_none()
            && message
                .get_mut("error")
                .and_then(serde_json::Value::as_object_mut)
                .filter(|error| error.get("data").is_some_and(serde_json::Value::is_null))
                .and_then(|error| error.remove("data"))
                .is_some()
    };
    let omitted = match &mut message {
        serde_json::Value::Array(batch) => batch
            .iter_mut()
            .fold(false, |any, message| omit(message) | any),
        message => omit(message),
    };
    if !omitted {
        return line;
    }
    serde_json::to_string(&message).unwrap_or(line)
}

/// Whether `line` is an error response whose `error.data` is null, or a batch
/// that holds one. Every value is skipped rather than built, and keys are
/// matched as JSON decodes them, escapes included. `None` when the line does
/// not read this way: a repeated key does that, and since the runtime takes the
/// last one, such a line is left to the full parse.
fn has_null_error_data(line: &str) -> Option<bool> {
    #[derive(serde::Deserialize)]
    struct Message {
        method: Option<serde::de::IgnoredAny>,
        error: Option<ErrorObject>,
    }
    #[derive(serde::Deserialize)]
    struct ErrorObject {
        #[serde(default, rename = "data", deserialize_with = "is_null")]
        data_is_null: bool,
    }
    fn is_null<'de, D: serde::Deserializer<'de>>(data: D) -> Result<bool, D::Error> {
        Ok(<Option<serde::de::IgnoredAny> as serde::Deserialize>::deserialize(data)?.is_none())
    }
    let holds = |message: &Message| {
        message.method.is_none()
            && message
                .error
                .as_ref()
                .is_some_and(|error| error.data_is_null)
    };
    if line.trim_start().starts_with('[') {
        serde_json::from_str::<Vec<Message>>(line)
            .ok()
            .map(|batch| batch.iter().any(holds))
    } else {
        serde_json::from_str::<Message>(line)
            .ok()
            .map(|message| holds(&message))
    }
}

/// The agent's stderr as read so far. The reader task appends each line as it
/// arrives, so an exit report can use what is here even if the pipe never
/// closes.
#[derive(Default)]
struct StderrCapture {
    collected: String,
    truncated: bool,
}

impl StderrCapture {
    fn push_line(&mut self, line: &str) {
        if !self.collected.is_empty() {
            self.truncated |=
                append_limited_utf8(&mut self.collected, "\n", MAX_STDERR_CAPTURE_BYTES);
        }
        self.truncated |= append_limited_utf8(&mut self.collected, line, MAX_STDERR_CAPTURE_BYTES);
    }

    fn text(&self) -> String {
        if !self.truncated {
            return self.collected.clone();
        }
        let prefix = "[stderr truncated to last 1 MiB]\n";
        let mut marked = String::with_capacity(prefix.len() + self.collected.len());
        marked.push_str(prefix);
        marked.push_str(&self.collected);
        marked
    }
}

/// `monitor_child`'s view of the stderr reader: the shared capture, and a
/// channel that resolves (sent or dropped) once the reader has hit end of file.
struct StderrCollector {
    capture: Arc<std::sync::Mutex<StderrCapture>>,
    closed: tokio::sync::oneshot::Receiver<()>,
}

impl StderrCollector {
    /// Waits up to `limit` for the pipe to close, then returns what was read.
    async fn drain(self, limit: std::time::Duration) -> String {
        let _ = tokio::time::timeout(limit, self.closed).await;
        self.capture
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .text()
    }
}

/// Reads the agent's stderr line by line until it closes, handing each line to
/// `debug_callback` and appending it to the returned collector's capture.
fn spawn_stderr_reader(
    child_stderr: tokio::process::ChildStderr,
    debug_callback: Option<DebugCallback>,
) -> StderrCollector {
    use futures::io::{AsyncBufReadExt, BufReader};
    use futures::StreamExt;

    let capture = Arc::new(std::sync::Mutex::new(StderrCapture::default()));
    let (closed_tx, closed) = tokio::sync::oneshot::channel();
    let writer = Arc::clone(&capture);
    tokio::spawn(async move {
        let mut stderr_lines = BufReader::new(child_stderr.compat()).lines();
        while let Some(line_result) = stderr_lines.next().await {
            if let Ok(line) = line_result {
                if let Some(ref callback) = debug_callback {
                    callback(&line, LineDirection::Stderr);
                }
                writer
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push_line(&line);
            }
        }
        let _ = closed_tx.send(());
    });
    StderrCollector { capture, closed }
}

/// Waits for a child process and returns an error if it exits with non-zero status.
///
/// The error message includes the stderr collected by the background reader.
/// After a failed exit it waits at most `stderr_drain_limit` for that pipe to
/// close and then uses whatever was read by then; a successful exit returns at
/// once without waiting on stderr at all.
/// Dropping the returned future drops a [`ChildGuard`], which signals the
/// child's process tree and — given a runtime to reap on — keeps owning the
/// child until it is really gone. Neither half is unconditional: see
/// [`AcpAgent::on_exit`] for why the kill is only a signal, and
/// `ChildGuard::drop` for why a drop outside a runtime stays silent.
///
/// That much has to survive a drop landing *before the first poll*, which is
/// why this is deliberately NOT an `async fn`: an `async fn` body does not run
/// until it is first polled, so the guard below would not exist yet and the
/// captured raw `Child` would be dropped on its own instead. Tokio never kills
/// on that path and reaps the child out of sight (at once if it has already
/// exited, via the orphan queue otherwise), so a live agent survives as an
/// orphan, `exit_callback` never fires, and the host is left publishing a pid
/// the OS may since have reassigned. The test
/// `dropping_an_unpolled_child_monitor_still_reaps_and_reports_exit` is what
/// catches a change back to `async fn`.
///
/// `+ Send` is stated rather than left to auto-trait leakage because
/// `ConnectTo::connect_to` promises a `Send` future and holds this one
/// across an await: without the bound, a non-`Send` capture added here would be
/// reported against that impl rather than against this function.
fn monitor_child(
    child: Child,
    stderr: StderrCollector,
    stderr_drain_limit: std::time::Duration,
    exit_callback: Option<Arc<dyn Fn() + Send + Sync + 'static>>,
) -> impl Future<Output = Result<(), agent_client_protocol::Error>> + Send {
    // Construct the guard before returning the future. `connect_to` races this
    // future against the protocol driver; when that driver wins before the
    // child monitor's first poll, dropping the future must still drop a guard
    // that owns the child and starts the detached reap.
    let guard = ChildGuard::new(child, exit_callback);

    async move {
        let mut guard = guard;

        // Wait for the child to exit
        let status = guard.wait().await.map_err(|e| {
            agent_client_protocol::util::internal_error(format!("Failed to wait for process: {}", e))
        })?;

        if status.success() {
            Ok(())
        } else {
            // Get stderr content if available
            let stderr = stderr.drain(stderr_drain_limit).await;

            let message = if stderr.is_empty() {
                format!("Process exited with {}", status)
            } else {
                format!("Process exited with {}: {}", status, stderr)
            };

            Err(agent_client_protocol::util::internal_error(message))
        }
    }
}

/// Roles that an ACP agent executable can potentially serve.
pub trait AcpAgentCounterpartRole: Role {}

impl AcpAgentCounterpartRole for Client {}

impl AcpAgentCounterpartRole for Conductor {}

impl<Counterpart: AcpAgentCounterpartRole> ConnectTo<Counterpart> for AcpAgent {
    async fn connect_to(
        self,
        client: impl ConnectTo<Counterpart::Counterpart>,
    ) -> Result<(), agent_client_protocol::Error> {
        use futures::AsyncBufReadExt;
        use futures::AsyncWriteExt;
        use futures::StreamExt;
        use futures::io::BufReader;

        let (child_stdin, child_stdout, child_stderr, child) = self.spawn_process()?;

        // Publish the OS pid to the spawn callback so the host can kill the
        // process tree deterministically at shutdown rather than relying solely
        // on `ChildGuard::drop` (which never runs if the driving thread is torn
        // down by process exit before the connect future unwinds).
        if let Some(callback) = self.spawn_callback.as_ref() {
            if let Some(pid) = child.id() {
                callback(pid);
            }
        }

        // Read stderr in the background, for the debug callback and for the
        // exit report.
        let stderr = spawn_stderr_reader(child_stderr, self.debug_callback.clone());

        // Create a future that monitors the child process for early exit
        let child_monitor = monitor_child(
            child,
            stderr,
            STDERR_DRAIN_LIMIT,
            self.exit_callback.clone(),
        );

        // Convert stdio to line streams with optional debug inspection
        let incoming_lines = if let Some(callback) = self.debug_callback.clone() {
            Box::pin(
                BufReader::new(child_stdout.compat())
                    .lines()
                    .inspect(move |result| {
                        if let Ok(line) = result {
                            callback(line, LineDirection::Stdout);
                        }
                    }),
            )
                as std::pin::Pin<Box<dyn futures::Stream<Item = std::io::Result<String>> + Send>>
        } else {
            Box::pin(BufReader::new(child_stdout.compat()).lines())
        };
        let incoming_lines = incoming_lines.map(|line| line.map(omit_null_error_data));

        // Create a sink that writes lines (with newlines) to stdin with optional debug logging
        let outgoing_sink = if let Some(callback) = self.debug_callback.clone() {
            Box::pin(futures::sink::unfold(
                (child_stdin.compat_write(), callback),
                async move |(mut writer, callback), line: String| {
                    callback(&line, LineDirection::Stdin);
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await?;
                    Ok::<_, std::io::Error>((writer, callback))
                },
            ))
                as std::pin::Pin<Box<dyn futures::Sink<String, Error = std::io::Error> + Send>>
        } else {
            Box::pin(futures::sink::unfold(
                child_stdin.compat_write(),
                async move |mut writer, line: String| {
                    let mut bytes = line.into_bytes();
                    bytes.push(b'\n');
                    writer.write_all(&bytes).await?;
                    Ok::<_, std::io::Error>(writer)
                },
            ))
        };

        // Race the protocol against child process exit
        // If the child exits early (e.g., with an error), we return that error
        let protocol_future = ConnectTo::<Counterpart>::connect_to(
            Lines::new(outgoing_sink, incoming_lines),
            client,
        );

        tokio::select! {
            result = protocol_future => result,
            result = child_monitor => result,
        }
    }
}

impl AcpAgent {
    /// Create an `AcpAgent` from an iterator of command-line arguments.
    ///
    /// Leading arguments of the form `NAME=value` are parsed as environment variables.
    /// The first non-env argument is the command, and the rest are arguments.
    ///
    pub fn from_args<I, T>(args: I) -> Result<Self, agent_client_protocol::Error>
    where
        I: IntoIterator<Item = T>,
        T: ToString,
    {
        let args: Vec<String> = args.into_iter().map(|s| s.to_string()).collect();

        if args.is_empty() {
            return Err(agent_client_protocol::util::internal_error("Arguments cannot be empty"));
        }

        let mut env = vec![];
        let mut command_idx = 0;

        // Parse leading FOO=bar arguments as environment variables
        for (i, arg) in args.iter().enumerate() {
            if let Some((name, value)) = parse_env_var(arg) {
                env.push(EnvVariable::new(name, value));
                command_idx = i + 1;
            } else {
                break;
            }
        }

        if command_idx >= args.len() {
            return Err(agent_client_protocol::util::internal_error(
                "No command found (only environment variables provided)",
            ));
        }

        let command = PathBuf::from(&args[command_idx]);
        let cmd_args = args[command_idx + 1..].to_vec();

        // Generate a name from the command
        let name = command
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("agent")
            .to_string();

        Ok(AcpAgent {
            server: McpServer::Stdio(
                McpServerStdio::new(name, command)
                    .args(cmd_args)
                    .env(env),
            ),
            debug_callback: None,
            current_dir: None,
            spawn_callback: None,
            exit_callback: None,
        })
    }
}

/// Parse a string as an environment variable assignment (NAME=value).
/// Returns None if it doesn't match the pattern.
fn parse_env_var(s: &str) -> Option<(String, String)> {
    // Must contain '=' and the part before must be a valid env var name
    let eq_pos = s.find('=')?;
    if eq_pos == 0 {
        return None;
    }

    let name = &s[..eq_pos];
    let value = &s[eq_pos + 1..];

    // Env var names must start with a letter or underscore, and contain only
    // alphanumeric characters and underscores
    let mut chars = name.chars();
    let first = chars.next()?;
    if !first.is_ascii_alphabetic() && first != '_' {
        return None;
    }
    if !chars.all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return None;
    }

    Some((name.to_string(), value.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_append_limited_utf8_truncates_ascii() {
        let mut output = String::new();
        let truncated = append_limited_utf8(&mut output, "abcdefghij", 6);
        assert!(truncated);
        assert_eq!(output, "efghij");
    }

    #[test]
    fn test_append_limited_utf8_keeps_char_boundaries() {
        let mut output = String::new();
        let truncated = append_limited_utf8(&mut output, "A中文B", 5);
        assert!(truncated);
        assert_eq!(output, "文B");
    }

    #[test]
    fn with_current_dir_sets_field() {
        let agent = AcpAgent::from_args(["python", "agent.py"])
            .unwrap()
            .with_current_dir("/some/dir");
        // The directory is private; surfaced via Debug so callers can confirm.
        assert!(format!("{agent:?}").contains("/some/dir"));
    }

    /// The exit callback is a promise about ONE thing: the pid has stopped
    /// naming this child and the OS may reassign it. These tests pin the three
    /// moments that promise is (and isn't) true. A host records the pid at spawn
    /// and kills that tree at shutdown, so firing early aims its kill at a
    /// stranger, and firing late leaves an orphan alive.
    ///
    /// Unix-only: they need a process that can refuse a kill signal, which has
    /// no Windows analogue (`TerminateProcess` is unconditional). The ownership
    /// property they cover is platform-neutral though — holding the `Child`
    /// keeps a Windows process handle open, which is exactly what stops the OS
    /// from reusing the pid there.
    #[cfg(unix)]
    fn counting_callback(calls: &Arc<std::sync::atomic::AtomicUsize>) -> Arc<dyn Fn() + Send + Sync>
    {
        let calls = Arc::clone(calls);
        Arc::new(move || {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        })
    }

    /// A reaped child means its pid is free for the OS to reassign, so the exit
    /// callback has to fire — a host still holding that pid would aim its
    /// shutdown kill at whatever inherits the number next.
    #[cfg(unix)]
    #[test]
    fn exit_callback_fires_once_the_child_is_reaped() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        rt.block_on(async {
            let child = tokio::process::Command::new("/bin/sh")
                .args(["-c", "exit 0"])
                .spawn()
                .expect("spawn sh");
            let mut guard = ChildGuard {
                child: Some(child),
                exit_callback: Some(counting_callback(&calls)),
                process_group: None,
                run_marker: None,
            };
            guard.wait().await.expect("wait");
            assert_eq!(
                calls.load(Ordering::SeqCst),
                1,
                "a reaped child must report its exit"
            );
            drop(guard);
        });
        // Exactly once, even though `drop` also runs its own notify path.
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Long enough that a pipe which does close is always read to the end,
    /// even on a busy machine; the tests that need the cap itself pass
    /// `STDERR_DRAIN_LIMIT` on a paused clock instead.
    #[cfg(unix)]
    const TEST_DRAIN_WAIT: std::time::Duration = std::time::Duration::from_secs(60);

    /// Spawns `/bin/sh -c script` as an agent would be: stderr piped into
    /// the real reader, stdout piped so a script can report a pid on it.
    #[cfg(unix)]
    fn spawn_sh(script: &str) -> (Child, StderrCollector) {
        let mut child = tokio::process::Command::new("/bin/sh")
            .args(["-c", script])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .expect("spawn sh");
        let stderr = spawn_stderr_reader(child.stderr.take().expect("stderr"), None);
        (child, stderr)
    }

    /// A script that leaves `sleep` holding its stderr reports the sleeper's
    /// pid as its first stdout line; the returned guard kills it.
    ///
    /// Also waits for the script itself to exit. On a paused clock any armed
    /// timer would be auto-advanced while the runtime idles on that exit, so
    /// the exit is awaited here with none armed; `monitor_child` then finds
    /// the status already reaped, and only its drain wait is measured.
    #[cfg(unix)]
    async fn exit_leaving_a_sleeper(child: &mut Child) -> StraySleeper {
        use tokio::io::AsyncBufReadExt;
        let stdout = child.stdout.take().expect("stdout");
        let mut line = String::new();
        tokio::io::BufReader::new(stdout)
            .read_line(&mut line)
            .await
            .expect("read pid");
        let sleeper = StraySleeper(line.trim().to_string());
        child.wait().await.expect("wait for sh");
        sleeper
    }

    #[cfg(unix)]
    struct StraySleeper(String);

    #[cfg(unix)]
    impl Drop for StraySleeper {
        fn drop(&mut self) {
            // It may already be gone with the agent's process tree.
            let _ = std::process::Command::new("kill")
                .arg(&self.0)
                .stderr(std::process::Stdio::null())
                .status();
        }
    }

    // An agent that explains itself on stderr and quits at once: the exit
    // error ends with that explanation.
    #[cfg(unix)]
    #[tokio::test]
    async fn an_exit_error_carries_the_last_stderr_line() {
        let (child, stderr) =
            spawn_sh("echo 'starting up' >&2; echo 'error: please log in first' >&2; exit 1");
        let err = monitor_child(child, stderr, TEST_DRAIN_WAIT, None)
            .await
            .unwrap_err();
        let text = format!("{err:?}");
        assert!(text.contains("Process exited with"), "{text}");
        assert!(text.contains("error: please log in first"), "{text}");
    }

    // A launcher that exits but leaves a child holding stderr: the pipe never
    // closes, so the report must stop waiting at the cap and use the lines
    // read by then. The clock is paused, so the cap is measured, not slept.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn an_exit_error_stops_draining_a_held_pipe_at_the_cap() {
        let (mut child, stderr) =
            spawn_sh("echo 'error: please log in first' >&2; sleep 30 & echo $!; exit 1");
        let _sleeper = exit_leaving_a_sleeper(&mut child).await;
        let started = tokio::time::Instant::now();
        let err = tokio::time::timeout(
            std::time::Duration::from_secs(5),
            monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None),
        )
        .await
        .expect("the exit report waited past the drain cap")
        .unwrap_err();
        assert!(
            started.elapsed() <= STDERR_DRAIN_LIMIT + std::time::Duration::from_millis(50),
            "took {:?}",
            started.elapsed()
        );
        let text = format!("{err:?}");
        assert!(text.contains("error: please log in first"), "{text}");
    }

    // A clean exit is not a failure to explain: it returns at once, without
    // waiting on a stderr pipe that something else still holds.
    #[cfg(unix)]
    #[tokio::test(start_paused = true)]
    async fn a_clean_exit_does_not_wait_for_stderr() {
        let (mut child, stderr) = spawn_sh("echo 'bye' >&2; sleep 30 & echo $!; exit 0");
        let _sleeper = exit_leaving_a_sleeper(&mut child).await;
        let started = tokio::time::Instant::now();
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None),
        )
        .await
        .expect("a clean exit waited")
        .expect("a clean exit is a success");
        assert!(
            started.elapsed() < STDERR_DRAIN_LIMIT,
            "took {:?}",
            started.elapsed()
        );
    }

    /// Regression for the select race in `connect_to`: the protocol side may
    /// finish before the child-monitor future receives its first poll. The
    /// monitor must already own a `ChildGuard`, otherwise dropping that
    /// unpolled future bypasses kill/reap and never fires `on_exit`.
    #[cfg(unix)]
    #[test]
    fn dropping_an_unpolled_child_monitor_still_reaps_and_reports_exit() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            let mut command = tokio::process::Command::new("/bin/sh");
            command.args(["-c", "sleep 30"]);
            command.stderr(std::process::Stdio::piped());
            let mut child = command.spawn().expect("spawn sh");
            let stderr = child.stderr.take().expect("stderr");
            let stderr = spawn_stderr_reader(stderr, None);

            let monitor = monitor_child(
                child,
                stderr,
                STDERR_DRAIN_LIMIT,
                Some(counting_callback(&calls)),
            );
            // Deliberately never poll it.
            drop(monitor);

            let mut reported = false;
            for _ in 0..200 {
                if calls.load(Ordering::SeqCst) == 1 {
                    reported = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(reported, "unpolled monitor bypassed the reap callback");
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// Dropping the guard kills the tree but does not wait, so the exit is not
    /// observed yet — and must not be reported yet. It has to be reported once
    /// the child actually dies, which only works because `drop` keeps owning the
    /// child instead of letting Tokio's orphan queue reap it out of sight.
    ///
    /// A current-thread runtime makes the ordering exact: the detached reaper
    /// cannot run during the synchronous assertion right after `drop`.
    #[cfg(unix)]
    #[test]
    fn dropping_the_guard_reports_the_exit_only_once_the_child_is_reaped() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("tokio runtime");
        rt.block_on(async {
            let child = tokio::process::Command::new("/bin/sh")
                .args(["-c", "sleep 30"])
                .spawn()
                .expect("spawn sh");
            let guard = ChildGuard {
                child: Some(child),
                exit_callback: Some(counting_callback(&calls)),
                process_group: None,
                run_marker: None,
            };

            drop(guard);
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "the kill was only signalled — the exit has not been observed yet"
            );

            let mut reported = false;
            for _ in 0..200 {
                if calls.load(Ordering::SeqCst) > 0 {
                    reported = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(
                reported,
                "the killed child was never reaped — its pid would stay published forever"
            );
        });
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    /// The case that makes the whole design necessary: a child that ignores the
    /// kill signal is STILL RUNNING after `drop`. Its pid must stay published so
    /// a host's shutdown backstop still sweeps it — reporting an exit here would
    /// disarm that backstop and leave a real orphan behind.
    #[cfg(unix)]
    #[test]
    fn a_child_that_survives_the_kill_keeps_its_pid_published() {
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        // The shell announces itself only AFTER installing the trap. Killing it
        // before that point would hit the default disposition and the test would
        // "fail" for a reason it isn't testing.
        let ready = std::env::temp_dir().join(format!(
            "codeg-agent-process-trap-ready-{}-{:p}",
            std::process::id(),
            &calls
        ));
        let _ = std::fs::remove_file(&ready);

        rt.block_on(async {
            // Ignores SIGTERM and respawns the `sleep` that `kill_tree` reaches,
            // so the whole tree outlives the guard's kill.
            let child = tokio::process::Command::new("/bin/sh")
                .args([
                    "-c",
                    &format!(
                        "trap '' TERM; echo ready > '{}'; while true; do sleep 1; done",
                        ready.display()
                    ),
                ])
                .spawn()
                .expect("spawn sh");
            let pid = child.id().expect("child has a pid").to_string();
            let guard = ChildGuard {
                child: Some(child),
                exit_callback: Some(counting_callback(&calls)),
                process_group: None,
                run_marker: None,
            };

            let mut trapped = false;
            for _ in 0..200 {
                if ready.exists() {
                    trapped = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(trapped, "the shell never installed its SIGTERM trap");

            drop(guard);

            // Well past the signal it ignored. `kill -0` probes for existence
            // without sending anything (no `libc` dependency in this crate).
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
            let alive = std::process::Command::new("kill")
                .args(["-0", &pid])
                .status()
                .expect("run kill -0")
                .success();
            assert!(
                alive,
                "test setup is wrong — the child was supposed to survive SIGTERM"
            );
            assert_eq!(
                calls.load(Ordering::SeqCst),
                0,
                "a still-running child must keep its pid published"
            );

            // And once it really dies, the exit is reported — the reaper is
            // armed the whole time, not abandoned.
            let _ = std::process::Command::new("kill")
                .args(["-9", &pid])
                .status();
            let mut reported = false;
            for _ in 0..200 {
                if calls.load(Ordering::SeqCst) > 0 {
                    reported = true;
                    break;
                }
                tokio::time::sleep(std::time::Duration::from_millis(20)).await;
            }
            assert!(reported, "the reaper never observed the child's death");
        });
        let _ = std::fs::remove_file(&ready);
    }

    #[test]
    fn detects_windows_unc_paths_without_misclassifying_device_or_drive_paths() {
        assert!(is_windows_unc_path(
            r"\\wsl.localhost\Ubuntu\home\user\repo"
        ));
        assert!(is_windows_unc_path(r"\\wsl$\Ubuntu\home\user\repo"));
        assert!(is_windows_unc_path(r"\\?\UNC\server\share\repo"));
        assert!(!is_windows_unc_path(r"C:\Users\user\repo"));
        assert!(!is_windows_unc_path(r"\\?\C:\Users\user\repo"));
        assert!(!is_windows_unc_path(r"\\.\pipe\codeg"));
    }

    #[test]
    fn detects_batch_launchers_case_insensitively() {
        assert!(is_windows_batch_file(std::path::Path::new("hermes.CmD")));
        assert!(is_windows_batch_file(std::path::Path::new("agent.BAT")));
        assert!(!is_windows_batch_file(std::path::Path::new("agent.exe")));
        assert!(!is_windows_batch_file(std::path::Path::new("hermes")));
    }

    /// The detour is a rescue for exactly one combination. Widening it would
    /// put a cmd.exe in front of agents that do not need one; narrowing it
    /// puts the agent back in `C:\Windows`.
    #[test]
    fn pushd_is_reserved_for_a_unc_workspace_behind_a_batch_launcher() {
        use std::path::Path;

        let batch = Path::new(r"C:\npm\hermes.cmd");
        let unc = Path::new(r"\\wsl.localhost\Ubuntu\home\user\repo");

        assert_eq!(
            windows_pushd_cwd(Some(unc), batch).as_deref(),
            Some(r"\\wsl.localhost\Ubuntu\home\user\repo")
        );
        // A native executable takes a UNC cwd fine — no cmd.exe involved.
        assert_eq!(
            windows_pushd_cwd(Some(unc), Path::new(r"C:\npm\uvx.exe")),
            None
        );
        assert_eq!(
            windows_pushd_cwd(Some(Path::new(r"C:\Users\user\repo")), batch),
            None
        );
        assert_eq!(windows_pushd_cwd(None, batch), None);
    }

    /// Rust resolves a bare program name against PATH and never against the
    /// child's cwd. cmd.exe searches the current directory FIRST — which
    /// `pushd` has just pointed at the workspace — so handing it a relative
    /// launcher would let a `hermes.cmd` committed to the repo run instead of
    /// the trusted one on PATH. Those launches keep the direct spawn.
    #[test]
    fn a_relative_launcher_never_takes_the_detour() {
        use std::path::Path;

        let unc = Path::new(r"\\wsl.localhost\Ubuntu\home\user\repo");
        for relative in [
            "hermes.cmd",
            r".\hermes.cmd",
            r"node_modules\.bin\hermes.cmd",
            // Root-relative and drive-relative both resolve against the drive
            // and directory `pushd` just changed.
            r"\hermes.cmd",
            "C:hermes.cmd",
        ] {
            assert_eq!(
                windows_pushd_cwd(Some(unc), Path::new(relative)),
                None,
                "{relative} would be resolved out of the workspace"
            );
        }
        for absolute in [
            r"C:\npm\hermes.cmd",
            r"c:/npm/hermes.cmd",
            r"\\tools\share\hermes.cmd",
        ] {
            assert!(
                windows_pushd_cwd(Some(unc), Path::new(absolute)).is_some(),
                "{absolute} needs the detour"
            );
        }
    }

    /// `pushd` is a cmd built-in, so cmd parses this argument itself: the two
    /// spellings it cannot resolve have to be gone before it ever sees them,
    /// or `&&` takes the whole agent launch down with the failed `pushd`.
    #[test]
    fn pushd_cwd_is_spelled_the_only_way_cmd_can_resolve_it() {
        use std::path::Path;

        let batch = Path::new(r"C:\npm\hermes.cmd");
        // The extended-length form is what `fs::canonicalize` hands back on
        // Windows, and cmd.exe supports none of it.
        for verbatim in [
            r"\\?\UNC\wsl.localhost\Ubuntu\home\user\repo",
            r"\\?\unc\wsl.localhost\Ubuntu\home\user\repo",
        ] {
            assert_eq!(
                windows_pushd_cwd(Some(Path::new(verbatim)), batch).as_deref(),
                Some(r"\\wsl.localhost\Ubuntu\home\user\repo")
            );
        }
        // A trailing separator comes out of `append_windows_batch_arg` as a
        // doubled backslash — correct for an argument a batch file re-parses,
        // but cmd never unescapes its own command line, so `pushd` would
        // receive the pair verbatim and reject the path.
        assert_eq!(
            windows_pushd_cwd(Some(Path::new(r"\\srv\share\repo\")), batch).as_deref(),
            Some(r"\\srv\share\repo")
        );
        assert_eq!(
            windows_pushd_cwd(Some(Path::new(r"\\srv\share\repo/")), batch).as_deref(),
            Some(r"\\srv\share\repo")
        );
    }

    #[test]
    fn unc_batch_command_uses_pushd_and_escapes_cmd_metacharacters() {
        let command = make_unc_batch_command_line(
            r"\\wsl.localhost\Ubuntu\home\a&b\repo",
            std::path::Path::new(r"C:\Program Files\nodejs\hermes.cmd"),
            &["acp".into(), "100% ready".into(), "x&whoami".into()],
        )
        .expect("valid command line");

        assert_eq!(
            command,
            r#"/e:ON /v:OFF /d /s /c "pushd "\\wsl.localhost\Ubuntu\home\a&b\repo" && "C:\Program Files\nodejs\hermes.cmd" acp "100%%cd:~,% ready" "x&whoami"""#
        );
    }

    #[test]
    fn unc_batch_command_rejects_line_breaks() {
        assert!(make_unc_batch_command_line(
            r"\\wsl.localhost\Ubuntu\home\user\repo",
            std::path::Path::new("hermes.cmd"),
            &["line\nbreak".into()],
        )
        .is_err());
    }

    #[cfg(unix)]
    #[test]
    fn spawn_process_honors_current_dir() {
        use tokio::io::AsyncReadExt;
        // A real, canonical directory distinct from the test process's own cwd.
        let dir = std::env::temp_dir()
            .canonicalize()
            .expect("temp dir canonicalizes");
        let agent = AcpAgent::from_args(["/bin/sh", "-c", "pwd -P"])
            .unwrap()
            .with_current_dir(&dir);
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let out = rt.block_on(async {
            let (_stdin, mut stdout, _stderr, mut child) =
                agent.spawn_process().expect("spawn");
            let mut out = String::new();
            stdout.read_to_string(&mut out).await.expect("read stdout");
            let _ = child.wait().await;
            out
        });
        // The child ran `pwd -P` from `dir`, so it must print exactly `dir`.
        assert_eq!(out.trim(), dir.to_string_lossy());
    }

    #[test]
    fn an_error_responses_null_data_is_dropped() {
        // As the Python ACP SDK writes it, spaces included.
        assert_eq!(
            omit_null_error_data(
                r#"{"jsonrpc": "2.0", "id": 3, "error": {"code": -32000, "message": "Authentication required", "data": null}}"#
                    .to_string()
            ),
            r#"{"jsonrpc":"2.0","id":3,"error":{"code":-32000,"message":"Authentication required"}}"#
        );
        // Wherever the words "method" or "error" appear, and however a key is
        // spelled, only the response's own decoded `error.data` decides.
        for (line, without) in [
            (
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method","data":null}}"#,
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"method"}}"#,
            ),
            (
                r#"{"jsonrpc":"2.0","id":1,"\u0065rror":{"code":1,"message":"x","\u0064ata":null}}"#,
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"x"}}"#,
            ),
            (
                r#"[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"error":{"code":1,"message":"x","data":null}}]"#,
                r#"[{"jsonrpc":"2.0","id":1,"result":{}},{"jsonrpc":"2.0","id":2,"error":{"code":1,"message":"x"}}]"#,
            ),
            (
                r#"[{"jsonrpc":"2.0","method":"session/update","params":{"error":{"data":null}}},{"jsonrpc":"2.0","id":2,"error":{"code":1,"message":"x","data":null}}]"#,
                r#"[{"jsonrpc":"2.0","method":"session/update","params":{"error":{"data":null}}},{"jsonrpc":"2.0","id":2,"error":{"code":1,"message":"x"}}]"#,
            ),
            // A repeated key reads as its last value, as the runtime reads it.
            (
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"boom","data":0,"data":null}}"#,
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"boom"}}"#,
            ),
            (
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":1,"message":"a"},"error":{"code":2,"message":"b","data":null}}"#,
                r#"{"jsonrpc":"2.0","id":1,"error":{"code":2,"message":"b"}}"#,
            ),
        ] {
            assert_eq!(omit_null_error_data(line.to_string()), without, "{line}");
        }
    }

    #[test]
    fn a_line_without_an_errors_null_data_passes_unchanged() {
        for line in [
            r#"{"jsonrpc": "2.0", "id": 3, "error": {"code": -32603, "message": "boom", "data": {"details": null}}}"#,
            r#"{"jsonrpc": "2.0", "id": 3, "error": {"code": -32603, "message": "boom"}}"#,
            r#"{"jsonrpc": "2.0", "id": 3, "result": {"error": {"data": null}}}"#,
            r#"{"jsonrpc": "2.0", "method": "session/update", "params": {"error": {"data": null}}}"#,
            r#"{"jsonrpc": "2.0", "method": "x/y", "error": {"data": null}}"#,
            r#"{"jsonrpc": "2.0", "id": 1, "method": null, "error": {"data": null}}"#,
            r#"{"jsonrpc": "2.0", "id": 1, "error": {"data": 0, "data": 1}, "x": null}"#,
            r#"[{"jsonrpc": "2.0", "id": 1, "result": null}, {"jsonrpc": "2.0", "method": "x/y", "params": null}]"#,
            r#"not json, "error": null"#,
        ] {
            assert_eq!(omit_null_error_data(line.to_string()), line);
        }
    }

    /// The agent answers `initialize` with the Python ACP SDK's error, whose
    /// `data` is null: the client sees no data, and the message alone.
    #[cfg(unix)]
    #[test]
    fn a_null_error_data_from_the_agent_reaches_the_client_as_none() {
        use agent_client_protocol::schema::v1::InitializeRequest;
        use agent_client_protocol::schema::ProtocolVersion;
        use agent_client_protocol::{Agent, ConnectionTo};

        let script = r#"read -r line
id=$(printf '%s' "$line" | sed -E 's/.*"id":"([^"]*)".*/\1/')
printf '{"jsonrpc": "2.0", "id": "%s", "error": {"code": -32000, "message": "Authentication required", "data": null}}\n' "$id"
read -r _"#;
        let agent = AcpAgent::from_args(["/bin/sh", "-c", script]).unwrap();
        let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
        let error = rt
            .block_on(
                Client
                    .builder()
                    .connect_with(agent, async |cx: ConnectionTo<Agent>| {
                        Ok(cx
                            .send_request(InitializeRequest::new(ProtocolVersion::V1))
                            .block_task()
                            .await)
                    }),
            )
            .expect("connection")
            .expect_err("the agent refused initialize");
        assert_eq!(error.data, None);
        assert_eq!(error.to_string(), "Authentication required");
    }

    /// 进程还在跑（僵尸不算：被过继给 1 号进程以后，收尸可能慢一拍）。
    #[cfg(target_os = "linux")]
    fn process_is_running(pid: &str) -> bool {
        match std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            // 状态字段在最后一个 `)` 后面，进程名里可能带括号。
            Ok(stat) => stat
                .rsplit_once(')')
                .and_then(|(_, rest)| rest.trim_start().chars().next())
                .is_some_and(|state| state != 'Z'),
            Err(_) => false,
        }
    }

    /// 智能体被外部 `kill -9` 以后，它起的命令已经被过继给 1 号进程，不在
    /// 它的进程树里了；也得跟着结束，不能留在机器上空跑。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn killing_the_agent_ends_the_commands_it_started() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "sleep 300 & echo $!; sleep 300 & echo $!; wait",
        ])
        .unwrap();
        let (_stdin, stdout, stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut sleepers = Vec::new();
        for _ in 0..2 {
            let pid = lines.next_line().await.expect("read").expect("sleeper pid");
            sleepers.push(StraySleeper(pid.trim().to_string()));
        }

        let stderr = spawn_stderr_reader(stderr, None);
        let monitor = monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None);
        // SAFETY: 只给自己刚起的、还没收尸的子进程发信号。
        unsafe {
            libc::kill(agent_pid as libc::pid_t, libc::SIGKILL);
        }
        let _ = monitor.await;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while sleepers.iter().any(|s| process_is_running(&s.0))
            && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let survivors: Vec<&str> = sleepers
            .iter()
            .filter(|s| process_is_running(&s.0))
            .map(|s| s.0.as_str())
            .collect();
        assert!(
            survivors.is_empty(),
            "智能体死后它起的命令还在跑：{survivors:?}"
        );
    }

    /// 测试收尾：不理 SIGTERM 的进程用 SIGKILL 收掉。
    #[cfg(target_os = "linux")]
    struct HardKillOnDrop(String);

    #[cfg(target_os = "linux")]
    impl Drop for HardKillOnDrop {
        fn drop(&mut self) {
            let _ = std::process::Command::new("kill")
                .args(["-9", &self.0])
                .stderr(std::process::Stdio::null())
                .status();
        }
    }

    /// 用户断开会话（`ChildGuard` 被丢掉）时，智能体和它起的命令都不理
    /// SIGTERM，也不能一直留着：半秒后整组补 SIGKILL。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn dropping_the_guard_hard_kills_a_group_that_ignores_sigterm() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "trap '' TERM; echo $$; sleep 300 & echo $!; while :; do sleep 1; done",
        ])
        .unwrap();
        let (_stdin, stdout, _stderr, child) = agent.spawn_process().expect("spawn agent");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let mut pids = Vec::new();
        for _ in 0..2 {
            let pid = lines.next_line().await.expect("read").expect("pid");
            pids.push(HardKillOnDrop(pid.trim().to_string()));
        }

        drop(ChildGuard::new(child, None));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while pids.iter().any(|p| process_is_running(&p.0)) && std::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let survivors: Vec<&str> = pids
            .iter()
            .filter(|p| process_is_running(&p.0))
            .map(|p| p.0.as_str())
            .collect();
        assert!(
            survivors.is_empty(),
            "断开 3 秒后不理 SIGTERM 的智能体和命令还在跑：{survivors:?}"
        );
    }

    /// 起一个用 `setsid` 离开智能体进程组和会话的后台命令，读出它的 pid，
    /// 等它真的换成 sleep 再返回。
    #[cfg(target_os = "linux")]
    async fn read_detached_sleeper(
        lines: &mut tokio::io::Lines<tokio::io::BufReader<tokio::process::ChildStdout>>,
        agent_pid: u32,
    ) -> HardKillOnDrop {
        let pid = lines.next_line().await.expect("read").expect("sleeper pid");
        let sleeper = HardKillOnDrop(pid.trim().to_string());
        for _ in 0..100 {
            let comm =
                std::fs::read_to_string(format!("/proc/{}/comm", sleeper.0)).unwrap_or_default();
            if comm.trim() == "sleep" {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(20)).await;
        }
        let pid: libc::pid_t = sleeper.0.parse().expect("pid");
        // SAFETY: 只读进程表。
        let (pgid, sid) = unsafe { (libc::getpgid(pid), libc::getsid(pid)) };
        assert!(
            pgid > 0 && pgid as u32 != agent_pid && sid as u32 != agent_pid,
            "测试前提：sleep 已经离开智能体的进程组和会话"
        );
        sleeper
    }

    /// 智能体（这里是 sh）用 `setsid nohup … &` 起的后台命令离开了它的进程组，
    /// 智能体先退出以后又被过继给 1 号进程：按组、按进程树都找不到它，
    /// 也得跟着智能体一起结束。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn an_agent_exit_ends_commands_that_left_its_process_group() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "(setsid nohup sleep 300 >/dev/null 2>&1 & echo $!); sleep 0.3; exit 0",
        ])
        .unwrap();
        let (_stdin, stdout, stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let sleeper = read_detached_sleeper(&mut lines, agent_pid).await;

        let stderr = spawn_stderr_reader(stderr, None);
        let _ = monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None).await;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while process_is_running(&sleeper.0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            !process_is_running(&sleeper.0),
            "智能体退出 3 秒后，它用 setsid 起的后台命令还在跑：{}",
            sleeper.0
        );
    }

    /// 用户断开会话（`ChildGuard` 被丢掉）时，离开了智能体进程组、又被过继
    /// 走（子 shell 先退出）的后台命令也一起结束：智能体还活着，但进程树里
    /// 已经没有它了。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn dropping_the_guard_ends_commands_that_left_the_process_group() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "(setsid nohup sleep 300 >/dev/null 2>&1 & echo $!); while :; do sleep 1; done",
        ])
        .unwrap();
        let (_stdin, stdout, _stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let sleeper = read_detached_sleeper(&mut lines, agent_pid).await;

        drop(ChildGuard::new(child, None));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while process_is_running(&sleeper.0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            !process_is_running(&sleeper.0),
            "断开 3 秒后，智能体用 setsid 起的后台命令还在跑：{}",
            sleeper.0
        );
    }

    /// 智能体用 `env -i` 清空环境（标记也跟着没了）、`setsid` 离组、子 shell
    /// 先退出的后台命令，还不理 SIGTERM：用户断开会话（`ChildGuard` 被丢掉）
    /// 以后也得结束。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn dropping_the_guard_ends_commands_that_cleared_their_environment() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "(env -i /usr/bin/setsid /bin/sh -c 'trap \"\" TERM; exec /bin/sleep 300' >/dev/null 2>&1 & echo $!); while :; do sleep 1; done",
        ])
        .unwrap();
        let (_stdin, stdout, _stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let sleeper = read_detached_sleeper(&mut lines, agent_pid).await;
        let environ = std::fs::read(format!("/proc/{}/environ", sleeper.0)).unwrap_or_default();
        assert!(
            !environ
                .windows(AGENT_RUN_ENV.len())
                .any(|w| w == AGENT_RUN_ENV.as_bytes()),
            "测试前提：sleep 的环境里已经没有标记"
        );

        drop(ChildGuard::new(child, None));

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while process_is_running(&sleeper.0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            !process_is_running(&sleeper.0),
            "断开 3 秒后，智能体用 env -i 起的后台命令还在跑：{}",
            sleeper.0
        );
    }

    /// 智能体被直接杀掉（不是 codeg 去收的，走 `ChildGuard::wait`）时，
    /// 它用 `env -i` 清空环境、`setsid` 离组、不理 SIGTERM 的命令也得结束：
    /// 收养关系跟着智能体一起没了，只能靠它活着时定期记下的进程树。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_killed_agent_ends_commands_that_cleared_their_environment() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "(env -i /usr/bin/setsid /bin/sh -c 'trap \"\" TERM; exec /bin/sleep 300' >/dev/null 2>&1 & echo $!); while :; do sleep 1; done",
        ])
        .unwrap();
        let (_stdin, stdout, stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let sleeper = read_detached_sleeper(&mut lines, agent_pid).await;

        let stderr = spawn_stderr_reader(stderr, None);
        let monitor = tokio::spawn(monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None));
        // 让监视的那一头看到过一次进程树。
        tokio::time::sleep(TREE_SNAPSHOT_INTERVAL * 2).await;
        // SAFETY: 只给测试自己起的 sh 发信号。
        unsafe {
            libc::kill(agent_pid as libc::pid_t, libc::SIGKILL);
        }
        let _ = monitor.await;

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while process_is_running(&sleeper.0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        assert!(
            !process_is_running(&sleeper.0),
            "智能体被杀 3 秒后，它用 env -i 起的后台命令还在跑：{}",
            sleeper.0
        );
    }

    /// 智能体（claude-agent-acp）还活着、只有它下面的 CLI（这里是里层的 sh）
    /// 被杀了：CLI 起的命令被智能体收养，连接也不会断，可它们的主人已经没了，
    /// 不等重新连接就得结束。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_dead_agent_child_ends_the_commands_it_started() {
        use tokio::io::AsyncBufReadExt;

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "/bin/sh -c 'env -i /usr/bin/setsid /bin/sh -c \"trap \\\"\\\" TERM; exec /bin/sleep 300\" >/dev/null 2>&1 & echo $!; echo $$; wait'; while :; do sleep 1; done",
        ])
        .unwrap();
        let (_stdin, stdout, stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let sleeper = read_detached_sleeper(&mut lines, agent_pid).await;
        let cli = lines
            .next_line()
            .await
            .expect("read")
            .expect("cli pid")
            .trim()
            .parse::<libc::pid_t>()
            .expect("pid");

        let stderr = spawn_stderr_reader(stderr, None);
        let monitor = tokio::spawn(monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None));
        tokio::time::sleep(TREE_SNAPSHOT_INTERVAL * 2).await;
        // SAFETY: 只给测试自己起的里层 sh 发信号。
        unsafe {
            libc::kill(cli, libc::SIGKILL);
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        while process_is_running(&sleeper.0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let still_running = process_is_running(&sleeper.0);
        // 收掉智能体本身（丢掉监视它的任务就会丢掉 `ChildGuard`）。
        monitor.abort();
        let _ = monitor.await;
        assert!(
            !still_running,
            "智能体下面的 CLI 被杀 4 秒后，CLI 起的命令还在跑：{}",
            sleeper.0
        );
    }
    /// CLI 在两次记树之间才起命令、紧接着又被杀：上一次的树里没有这条命令，
    /// 它被智能体收养后成了智能体新冒出来的直接子进程，也得跟着 CLI 结束，
    /// 不能一直跑到重新连接。
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn a_command_started_between_snapshots_ends_with_its_dead_cli() {
        use tokio::io::{AsyncBufReadExt, AsyncWriteExt};

        let agent = AcpAgent::from_args([
            "/bin/sh",
            "-c",
            "/bin/sh -c 'echo $$; read go; env -i /usr/bin/setsid /bin/sh -c \"trap \\\"\\\" TERM; exec /bin/sleep 300\" >/dev/null 2>&1 & echo $!; wait'; while :; do sleep 1; done",
        ])
        .unwrap();
        let (mut stdin, stdout, stderr, child) = agent.spawn_process().expect("spawn agent");
        let agent_pid = child.id().expect("agent pid");
        let mut lines = tokio::io::BufReader::new(stdout).lines();
        let cli = lines
            .next_line()
            .await
            .expect("read")
            .expect("cli pid")
            .trim()
            .parse::<libc::pid_t>()
            .expect("pid");

        let stderr = spawn_stderr_reader(stderr, None);
        let monitor = tokio::spawn(monitor_child(child, stderr, STDERR_DRAIN_LIMIT, None));
        // 让 CLI 进过记下的树，再在两次记树中间起命令、杀 CLI。
        tokio::time::sleep(TREE_SNAPSHOT_INTERVAL * 5 / 2).await;
        stdin.write_all(b"go\n").await.expect("write");
        stdin.flush().await.expect("flush");
        let sleeper = read_detached_sleeper(&mut lines, agent_pid).await;
        // SAFETY: 只给测试自己起的里层 sh 发信号。
        unsafe {
            libc::kill(cli, libc::SIGKILL);
        }

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(4);
        while process_is_running(&sleeper.0) && std::time::Instant::now() < deadline {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        }
        let still_running = process_is_running(&sleeper.0);
        monitor.abort();
        let _ = monitor.await;
        assert!(
            !still_running,
            "CLI 起了命令随即被杀，4 秒后命令还在跑：{}",
            sleeper.0
        );
    }
}
