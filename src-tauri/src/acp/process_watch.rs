//! 只看自己子进程的读法：从一条连接自己的智能体 pid 出发，读
//! `<proc_root>/<pid>/task/*/children` 往下找子孙，按 pid 读
//! `<proc_root>/<pid>/stat` 判断死活和身份，读 `fd` / `fdinfo` 找谁在写某个
//! 文件。不列 `/proc` 下所有进程、不起 `ps`、不用 `kill_tree`（它们都要走一遍
//! 整张进程表，一台服务器上跑着很多 codeg-server 时代价成倍，还会读到别人的
//! 进程）。
//!
//! 每个函数都带一个 `proc_root`：生产传 `/proc`（[`PROC_ROOT`]），测试传临时
//! 目录里搭的假树。只在 Linux 上真去读；macOS / Windows 上一律返回「不知道」，
//! 所以那边只会有 `agent_exited`（断开、pid 格子清零）这一种「?」。
//!
//! 「不知道」和「没有」一定要分开（宁可漏报，不误报）：文件不存在 = 进程不在
//! 了，是确定的答案；读不了（没权限等别的错）= 不知道。
//!
//! 后半是判「?」：[`sample`] 在放开所有锁以后照 [`WatchTarget`] 读一次，
//! [`observe`] / [`judge`] 把读到的东西变成结论。15 秒一次的轮询在
//! `ConnectionManager::refresh_process_watch`。

use std::collections::{BTreeMap, HashSet};
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};

use crate::acp::types::BackgroundUncertainReason;

/// 生产上读的进程目录。
pub(crate) const PROC_ROOT: &str = "/proc";

/// 从一个 pid 往下找子孙时最多收这么多个进程。
pub(crate) const MAX_DESCENDANTS: usize = 256;

/// 从一个 pid 往下最多找这么多层。
pub(crate) const MAX_DEPTH: usize = 16;

/// 一个进程的身份：pid 加上 `starttime`（`/proc/<pid>/stat` 第 22 个字段），
/// pid 被别的进程重用时 `starttime` 对不上。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub(crate) struct ProcessIdentity {
    pub pid: u32,
    pub start: u64,
}

/// 按 pid 查一个进程的结果。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProcessProbe {
    /// 活着，`start` 是它的 `starttime`。
    Alive { start: u64 },
    /// 确定不在了：`/proc/<pid>` 不存在，或者是僵尸（`Z`）/ 已死（`X`）。
    Gone,
    /// 不知道：读不了、内容读不懂，或者不是 Linux。
    Unknown,
}

impl ProcessProbe {
    /// 这个进程是不是还是 `identity` 那一个：`Some(true)` 活着而且身份对得上，
    /// `Some(false)` 确定不在了或 pid 被重用，`None` 不知道。
    pub(crate) fn matches(self, identity: ProcessIdentity) -> Option<bool> {
        match self {
            ProcessProbe::Alive { start } => Some(start == identity.start),
            ProcessProbe::Gone => Some(false),
            ProcessProbe::Unknown => None,
        }
    }
}

fn pid_dir(proc_root: &Path, pid: u32) -> PathBuf {
    proc_root.join(pid.to_string())
}

/// `/proc/<pid>/stat` 的第 3 个字段（状态）和第 22 个字段（`starttime`）。
/// 第 2 个字段是括号里的命令名，里面可能有空格和括号，所以从最后一个 `)`
/// 往后数（和 `computer/procinfo.rs` 的 `parse_stat_start` 同一个读法）。
fn parse_stat(stat: &str) -> Option<(char, u64)> {
    let after_comm = &stat[stat.rfind(')')? + 1..];
    let mut fields = after_comm.split_whitespace();
    let state = fields.next()?.chars().next()?;
    // 状态是第 3 个字段，已经取走了；`starttime` 是第 22 个，再往后第 19 个。
    let start = fields.nth(18)?.parse().ok()?;
    Some((state, start))
}

/// 按 pid 查一个进程还在不在、身份是什么。
pub(crate) fn probe_process(proc_root: &Path, pid: u32) -> ProcessProbe {
    if !cfg!(target_os = "linux") || pid == 0 {
        return ProcessProbe::Unknown;
    }
    let stat = match std::fs::read_to_string(pid_dir(proc_root, pid).join("stat")) {
        Ok(stat) => stat,
        Err(err) if err.kind() == ErrorKind::NotFound => return ProcessProbe::Gone,
        Err(_) => return ProcessProbe::Unknown,
    };
    match parse_stat(&stat) {
        Some(('Z' | 'X', _)) => ProcessProbe::Gone,
        Some((_, start)) => ProcessProbe::Alive { start },
        None => ProcessProbe::Unknown,
    }
}

/// 一个进程直接的子进程：每个线程一份 `task/<tid>/children`，都读。
/// `Ok(None)` 是进程不在了（目录不存在），`Err(())` 是读不了。
fn direct_children(proc_root: &Path, pid: u32) -> Result<Option<Vec<u32>>, ()> {
    let tasks = match std::fs::read_dir(pid_dir(proc_root, pid).join("task")) {
        Ok(tasks) => tasks,
        Err(err) if err.kind() == ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(()),
    };
    let mut children = Vec::new();
    for task in tasks {
        let Ok(task) = task else {
            return Err(());
        };
        match std::fs::read_to_string(task.path().join("children")) {
            Ok(text) => children.extend(
                text.split_whitespace()
                    .filter_map(|pid| pid.parse::<u32>().ok())
                    .filter(|pid| *pid != 0),
            ),
            // 线程在读的过程中退出了：它的那一份没了，不算读不了。
            Err(err) if err.kind() == ErrorKind::NotFound => {}
            Err(_) => return Err(()),
        }
    }
    Ok(Some(children))
}

/// 一个进程直接的子进程（只一层），顺序照 `task/*/children` 里读到的。
///
/// `None` 是不知道：不是 Linux，或者读不了。进程不在了时是空列表。
pub(crate) fn children_of(proc_root: &Path, pid: u32) -> Option<Vec<u32>> {
    if !cfg!(target_os = "linux") || pid == 0 {
        return None;
    }
    match direct_children(proc_root, pid) {
        Ok(Some(children)) => Some(children),
        Ok(None) => Some(Vec::new()),
        Err(()) => None,
    }
}

/// 从 `root` 出发一层层往下找子孙进程（不含 `root` 自己），最多
/// [`MAX_DESCENDANTS`] 个、[`MAX_DEPTH`] 层，超了就停（已经找到的照用）。
///
/// `None` 是不知道：不是 Linux，或者 `root` 自己的子进程读不了。`root` 不在了
/// 时是空列表。更深的某个进程读不了时跳过它的那一支，已经找到的照用。
pub(crate) fn descendants(proc_root: &Path, root: u32) -> Option<Vec<u32>> {
    if !cfg!(target_os = "linux") || root == 0 {
        return None;
    }
    let mut seen: HashSet<u32> = HashSet::from([root]);
    let mut found = Vec::new();
    let mut layer = match direct_children(proc_root, root) {
        Ok(Some(children)) => children,
        Ok(None) => return Some(found),
        Err(()) => return None,
    };
    for depth in 0..MAX_DEPTH {
        let mut next = Vec::new();
        for pid in layer {
            if !seen.insert(pid) {
                continue;
            }
            if found.len() >= MAX_DESCENDANTS {
                return Some(found);
            }
            found.push(pid);
            // 最后一层的子进程不再往下读。
            if depth + 1 < MAX_DEPTH {
                if let Ok(Some(children)) = direct_children(proc_root, pid) {
                    next.extend(children);
                }
            }
        }
        if next.is_empty() {
            break;
        }
        layer = next;
    }
    Some(found)
}

/// `fdinfo` 里的 `flags`（八进制）是不是以写方式打开的（`O_WRONLY` 或
/// `O_RDWR`）。读不出来的不算。
fn fdinfo_is_write(fdinfo: &str) -> bool {
    let Some(flags) = fdinfo.lines().find_map(|line| {
        let value = line.strip_prefix("flags:")?;
        u32::from_str_radix(value.trim(), 8).ok()
    }) else {
        return false;
    };
    // 访问方式在最低两位：0 只读、1 只写、2 读写（3 不合法）。
    matches!(flags & 0o3, 0o1 | 0o2)
}

/// 这个进程是不是以写方式打开着 `path`。
fn writes_file(proc_root: &Path, pid: u32, path: &Path) -> bool {
    let dir = pid_dir(proc_root, pid);
    let Ok(fds) = std::fs::read_dir(dir.join("fd")) else {
        return false;
    };
    fds.filter_map(Result::ok).any(|fd| {
        if std::fs::read_link(fd.path()).ok().as_deref() != Some(path) {
            return false;
        }
        std::fs::read_to_string(dir.join("fdinfo").join(fd.file_name()))
            .is_ok_and(|info| fdinfo_is_write(&info))
    })
}

/// 在给定的几个 pid 里找以写方式打开着 `path` 的进程，带上它们的身份
/// （pid + `starttime`），以后按身份查它们还在不在。只读打开的（比如适配器
/// 在 tail 这个文件）不算；`flags` 读不出来、身份读不出来的不算。
///
/// `None` 是不知道（不是 Linux）。
pub(crate) fn writers_of(
    proc_root: &Path,
    pids: &[u32],
    path: &Path,
) -> Option<Vec<ProcessIdentity>> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    let mut writers = Vec::new();
    for &pid in pids {
        if pid == 0 || !writes_file(proc_root, pid, path) {
            continue;
        }
        if let ProcessProbe::Alive { start } = probe_process(proc_root, pid) {
            writers.push(ProcessIdentity { pid, start });
        }
    }
    Some(writers)
}

/// 读进程信息的办法：生产读 `/proc`（[`LiveProc`]），测试注入假的。
pub(crate) trait ProcReader: Send + Sync {
    /// 按 pid 查一个进程，见 [`probe_process`]。
    fn probe(&self, pid: u32) -> ProcessProbe;
    /// 子孙进程，见 [`descendants`]。
    fn descendants(&self, pid: u32) -> Option<Vec<u32>>;
    /// 直接的子进程（只一层），见 [`children_of`]。
    fn children(&self, pid: u32) -> Option<Vec<u32>>;
    /// 在 `pids` 里找以写方式打开着 `path` 的进程，见 [`writers_of`]。
    fn writers_of(&self, pids: &[u32], path: &Path) -> Option<Vec<ProcessIdentity>>;
}

/// 生产用的读法：读 [`PROC_ROOT`]。
pub(crate) struct LiveProc;

impl ProcReader for LiveProc {
    fn probe(&self, pid: u32) -> ProcessProbe {
        probe_process(Path::new(PROC_ROOT), pid)
    }

    fn descendants(&self, pid: u32) -> Option<Vec<u32>> {
        descendants(Path::new(PROC_ROOT), pid)
    }

    fn children(&self, pid: u32) -> Option<Vec<u32>> {
        children_of(Path::new(PROC_ROOT), pid)
    }

    fn writers_of(&self, pids: &[u32], path: &Path) -> Option<Vec<ProcessIdentity>> {
        // `fd/*` 的链接目标是解析过符号链接的绝对路径，先把任务给的路径也解析一遍。
        let resolved = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        writers_of(Path::new(PROC_ROOT), pids, &resolved)
    }
}

/// 安静时限的环境变量（秒）。
pub(crate) const SILENCE_TIMEOUT_ENV: &str = "CODEG_ACP_SILENCE_TIMEOUT_SECS";

/// 安静时限的默认值：30 分钟。
pub(crate) const DEFAULT_SILENCE_TIMEOUT_SECS: i64 = 1800;

/// 读安静时限的设置：没设、`0`、负数、不是数字、大到换算会溢出的，都用默认值。
fn parse_silence_timeout(raw: Option<&str>) -> chrono::Duration {
    raw.and_then(|v| v.trim().parse::<i64>().ok())
        .filter(|v| *v > 0)
        // `chrono::Duration::seconds` 超出范围会 panic，读设置的地方在定时器里，没人看着。
        .and_then(chrono::Duration::try_seconds)
        .unwrap_or_else(|| chrono::Duration::seconds(DEFAULT_SILENCE_TIMEOUT_SECS))
}

/// 安静时限（[`SILENCE_TIMEOUT_ENV`]），每个进程只读一次。
pub(crate) fn silence_timeout() -> chrono::Duration {
    static SECS: std::sync::OnceLock<chrono::Duration> = std::sync::OnceLock::new();
    *SECS.get_or_init(|| parse_silence_timeout(std::env::var(SILENCE_TIMEOUT_ENV).ok().as_deref()))
}

/// 一条连接上观察进程攒下来的东西，放在 [`crate::acp::SessionState`] 里。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(crate) struct ProcessWatch {
    /// pid 格子读到过的最后一个非 0 值；0 是还没读到过（还没启动）。
    pub seen_pid: u32,
    /// 第一次看到的智能体身份，以后 `starttime` 对不上就是 pid 被重用了。
    pub agent: Option<ProcessIdentity>,
    /// 后台任务 id → 绑上的写它输出文件的进程。没绑上的任务不在这里。
    pub writers: BTreeMap<String, Vec<ProcessIdentity>>,
    /// 只有 Claude 连接用：在跑、等后台或空闲（#1643）时第一次看到的、转接进程（pid 格子里那个）下面的
    /// 直接子进程，也就是真正的 Claude 进程。之后只认这一个，不猜新冒出来的子进程。
    /// pid 格子换了时丢掉；空闲时留着（#1554，空闲时它没了就把连接停掉）。
    pub claude_child: Option<ProcessIdentity>,
    /// 上一次观察时在等后台（`count > 0`）。#1452：Claude 进程被杀以后适配器会把后台任务
    /// 报成结束，计数先归零，所以刚从等后台变成不等的那一次观察还要按记下的 Claude 进程判一次。
    pub was_waiting: bool,
    /// 上一次观察的结论：`Some` 是「?」。有进展时清掉。
    pub uncertain: Option<BackgroundUncertainReason>,
}

/// 一个要看写进程的后台任务：还没完、`task_type` 是 `shell` / `monitor`、带输出文件。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WatchedTask {
    pub task_id: String,
    pub output: PathBuf,
}

/// 一次采样要读什么，在会话读锁下记下来，放开锁以后再读 `/proc`。
#[derive(Debug, Clone)]
pub(crate) struct WatchTarget {
    /// 采样时 pid 格子的值。
    pub pid: u32,
    /// 采样时的 [`ProcessWatch`]（只读，看哪些任务已经绑过）。
    pub watch: ProcessWatch,
    pub tasks: Vec<WatchedTask>,
    /// 要不要数活着的子进程（已经安静过了时限才要）。
    pub needs_children: bool,
    /// 要不要看转接进程下面的 Claude 进程：Claude 连接（在跑或等后台，或空闲但记下过）才看。
    pub claude_child: bool,
}

/// 一次采样读到的东西。`None` / [`ProcessProbe::Unknown`] 都是不知道。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct WatchSample {
    /// 智能体；pid 格子是 0 时是不知道。
    pub agent: ProcessProbe,
    /// 有没有活着的子孙进程。
    pub has_children: Option<bool>,
    /// 这次新绑上的写进程（之前没绑过的任务）。
    pub new_writers: Vec<(String, Vec<ProcessIdentity>)>,
    /// 绑过的任务：写进程里还有没有活着的。
    pub writers_alive: Vec<(String, Option<bool>)>,
    /// 记下过的 Claude 进程还是不是那一个：`Some(false)` 确定不在了或 pid 被重用，
    /// `None` 不知道（没看、没记下过、读不了）。
    pub claude_child_alive: Option<bool>,
    /// 还没记下过 Claude 进程时，这次看到的第一个活着的直接子进程。
    pub new_claude_child: Option<ProcessIdentity>,
}

impl WatchSample {
    fn unknown() -> Self {
        Self {
            agent: ProcessProbe::Unknown,
            has_children: None,
            new_writers: Vec::new(),
            writers_alive: Vec::new(),
            claude_child_alive: None,
            new_claude_child: None,
        }
    }
}

/// 照 `target` 读一次进程信息（会碰文件系统，在 `spawn_blocking` 里调）。
pub(crate) fn sample(reader: &dyn ProcReader, target: &WatchTarget) -> WatchSample {
    if target.pid == 0 {
        return WatchSample::unknown();
    }
    let mut out = WatchSample {
        agent: reader.probe(target.pid),
        ..WatchSample::unknown()
    };

    // 绑过的任务：按身份直接查写进程，pid 被重用（`starttime` 对不上）也算不活。
    for task in &target.tasks {
        let Some(writers) = target.watch.writers.get(&task.task_id) else {
            continue;
        };
        let mut alive = Some(false);
        for writer in writers {
            match reader.probe(writer.pid).matches(*writer) {
                Some(true) => {
                    alive = Some(true);
                    break;
                }
                Some(false) => {}
                None => alive = None,
            }
        }
        out.writers_alive.push((task.task_id.clone(), alive));
    }

    // 子孙只在智能体活着、而且真要用（有没绑的任务，或者已经安静过了时限）时才找。
    let unbound: Vec<&WatchedTask> = target
        .tasks
        .iter()
        .filter(|t| !target.watch.writers.contains_key(&t.task_id))
        .collect();
    let agent_alive = matches!(out.agent, ProcessProbe::Alive { .. });

    // Claude 进程：转接进程活着才看。记下过的按身份查；没记下过的读一层直接子进程，
    // 取第一个活着的（它要是又起了自己的子进程，不往下猜）。
    if agent_alive && target.claude_child {
        match target.watch.claude_child {
            Some(child) => out.claude_child_alive = reader.probe(child.pid).matches(child),
            None => {
                out.new_claude_child = reader.children(target.pid).and_then(|children| {
                    children
                        .into_iter()
                        .find_map(|pid| match reader.probe(pid) {
                            ProcessProbe::Alive { start } => Some(ProcessIdentity { pid, start }),
                            _ => None,
                        })
                });
            }
        }
    }

    if !agent_alive || (unbound.is_empty() && !target.needs_children) {
        return out;
    }
    let Some(found) = reader.descendants(target.pid) else {
        return out;
    };
    for task in unbound {
        if let Some(writers) = reader.writers_of(&found, &task.output) {
            if !writers.is_empty() {
                out.new_writers.push((task.task_id.clone(), writers));
            }
        }
    }
    if target.needs_children {
        // 僵尸不算活的；有一个活的就是有，全都确定不在才是没有。
        let mut has = Some(false);
        for pid in &found {
            match reader.probe(*pid) {
                ProcessProbe::Alive { .. } => {
                    has = Some(true);
                    break;
                }
                ProcessProbe::Gone => {}
                ProcessProbe::Unknown => has = None,
            }
        }
        out.has_children = has;
    }
    out
}

/// 判「?」时连接自己的样子（不碰进程）。
#[derive(Debug, Clone, Copy)]
pub(crate) struct WatchInput {
    /// 在跑：连接是 `Prompting`，或者最后一次 `ConversationStatusChanged` 是 `in_progress`。
    pub running: bool,
    /// 在等后台：`count > 0`。
    pub waiting: bool,
    /// 现在 pid 格子的值。
    pub pid: u32,
    pub last_progress_at: DateTime<Utc>,
    pub now: DateTime<Utc>,
    pub silence: chrono::Duration,
}

/// 判「?」（纯函数）：原因按 `agent_exited`（含 Claude 连接里转接进程下面的 Claude
/// 进程没了）、`background_process_exited`、
/// `silent_without_children` 的顺序取第一个成立的；任何一样不知道，那一条就不成立。
pub(crate) fn judge(
    watch: &ProcessWatch,
    input: &WatchInput,
    sample: &WatchSample,
) -> Option<BackgroundUncertainReason> {
    // #1452：上一次还在等后台、这一次不在跑也不等了（计数归零）：只看智能体和 Claude 进程
    // 还在不在，后台任务那两条不看。
    let settling = !input.running && !input.waiting && watch.was_waiting;
    if !(input.running || input.waiting || settling) {
        return None;
    }
    // 智能体：pid 格子先前非 0、现在 0（`on_exit` 只在真回收时清零）是退出；
    // 从来没见过非 0 是还没启动，不知道。
    let agent_alive = if input.pid == 0 {
        if watch.seen_pid != 0 {
            return Some(BackgroundUncertainReason::AgentExited);
        }
        None
    } else {
        match sample.agent {
            ProcessProbe::Gone => return Some(BackgroundUncertainReason::AgentExited),
            ProcessProbe::Alive { start } => {
                let first_seen = watch.agent.filter(|a| a.pid == input.pid);
                if first_seen.is_some_and(|a| a.start != start) {
                    return Some(BackgroundUncertainReason::AgentExited);
                }
                Some(true)
            }
            ProcessProbe::Unknown => None,
        }
    };
    // Claude 进程：在等后台（或刚等完）、转接进程活着、先前记下过的那个 Claude 进程确定不在了。
    if (input.waiting || settling)
        && agent_alive == Some(true)
        && watch.claude_child.is_some()
        && sample.claude_child_alive == Some(false)
    {
        return Some(BackgroundUncertainReason::AgentExited);
    }
    if settling {
        return None;
    }
    if sample
        .writers_alive
        .iter()
        .any(|(_, alive)| *alive == Some(false))
    {
        return Some(BackgroundUncertainReason::BackgroundProcessExited);
    }
    let quiet = input.now.signed_duration_since(input.last_progress_at) >= input.silence;
    if quiet && agent_alive == Some(true) && sample.has_children == Some(false) {
        return Some(BackgroundUncertainReason::SilentWithoutChildren);
    }
    None
}

/// #1554：一轮已经回完、不在等后台（也不是刚等完）的 Claude 连接，转接进程还活着（还是
/// 先前那一个），先前记下的 Claude 进程确定不在了。这时连接已经用不了，但不进「?」
/// （「?」会让侧栏把会话算成在跑），由调用方按智能体进程退出把连接停掉（纯函数）。
pub(crate) fn idle_claude_exited(
    watch: &ProcessWatch,
    input: &WatchInput,
    sample: &WatchSample,
) -> bool {
    if input.running || input.waiting || watch.was_waiting {
        return false;
    }
    if input.pid == 0 || watch.seen_pid != input.pid || watch.claude_child.is_none() {
        return false;
    }
    let ProcessProbe::Alive { start } = sample.agent else {
        return false;
    };
    let same_agent = watch
        .agent
        .filter(|a| a.pid == input.pid)
        .is_none_or(|a| a.start == start);
    same_agent && sample.claude_child_alive == Some(false)
}

/// #1643：空闲的 Claude 连接的一次（没过期的）采样记进 `watch`（纯函数）：记下 pid 格子、
/// 转接进程的身份，还没记下过 Claude 进程时记下这次看到的那一个。一轮很快回完、巡检从没在它
/// 在跑时看过的连接，靠这里补记，之后才能按 [`idle_claude_exited`] 发现 Claude 进程没了。
/// 不判「?」，不碰后台任务那几样。
pub(crate) fn record_idle_claude(
    watch: &mut ProcessWatch,
    input: &WatchInput,
    sample: &WatchSample,
) {
    if input.pid == 0 {
        return;
    }
    if watch.seen_pid != input.pid {
        watch.agent = None;
        watch.claude_child = None;
    }
    watch.seen_pid = input.pid;
    let ProcessProbe::Alive { start } = sample.agent else {
        return;
    };
    if watch.agent.is_none() {
        watch.agent = Some(ProcessIdentity {
            pid: input.pid,
            start,
        });
    }
    if watch.claude_child.is_none() {
        watch.claude_child = sample.new_claude_child;
    }
}

/// 把一次（没过期的）采样记进 `watch`，返回新的结论（也写进 `watch.uncertain`）。
/// `tasks` 是采样时要看的任务，不在里面的任务的绑定丢掉。
pub(crate) fn observe(
    watch: &mut ProcessWatch,
    input: &WatchInput,
    tasks: &[WatchedTask],
    sample: &WatchSample,
) -> Option<BackgroundUncertainReason> {
    let reason = judge(watch, input, sample);
    if input.pid != 0 {
        if watch.seen_pid != input.pid {
            watch.agent = None;
            watch.claude_child = None;
        }
        watch.seen_pid = input.pid;
        if let (None, ProcessProbe::Alive { start }) = (watch.agent, sample.agent) {
            watch.agent = Some(ProcessIdentity {
                pid: input.pid,
                start,
            });
        }
    }
    watch.was_waiting = input.waiting;
    // #1554：空闲时也留着（空闲时按它判 [`idle_claude_exited`]），只在 pid 格子换了时丢掉（上面）。
    if (input.running || input.waiting) && watch.claude_child.is_none() && input.pid != 0 {
        watch.claude_child = sample.new_claude_child;
    }
    watch
        .writers
        .retain(|task_id, _| tasks.iter().any(|t| &t.task_id == task_id));
    for (task_id, writers) in &sample.new_writers {
        if tasks.iter().any(|t| &t.task_id == task_id) {
            watch
                .writers
                .entry(task_id.clone())
                .or_insert_with(|| writers.clone());
        }
    }
    watch.uncertain = reason;
    reason
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 在临时目录里搭一棵假的 `/proc`。只有 Linux 上的测试用它（建符号链接用的
    /// `std::os::unix` 在 Windows 上也没有）。
    #[cfg(target_os = "linux")]
    struct FakeProc {
        dir: tempfile::TempDir,
    }

    #[cfg(target_os = "linux")]
    impl FakeProc {
        fn new() -> Self {
            Self {
                dir: tempfile::tempdir().unwrap(),
            }
        }

        fn root(&self) -> &Path {
            self.dir.path()
        }

        /// 一个进程：状态、`starttime`，和主线程的子进程。
        fn process(&self, pid: u32, state: char, start: u64, children: &[u32]) -> &Self {
            let dir = self.root().join(pid.to_string());
            std::fs::create_dir_all(dir.join("task").join(pid.to_string())).unwrap();
            // 命令名里故意带空格和括号，验证从最后一个 `)` 往后数。
            let mut stat = format!("{pid} (fake (cmd) x) {state}");
            for field in 4..=21 {
                stat.push_str(&format!(" {field}"));
            }
            stat.push_str(&format!(" {start} 99 100\n"));
            std::fs::write(dir.join("stat"), stat).unwrap();
            self.thread_children(pid, pid, children)
        }

        /// 另一个线程的子进程。
        fn thread_children(&self, pid: u32, tid: u32, children: &[u32]) -> &Self {
            let task = self
                .root()
                .join(pid.to_string())
                .join("task")
                .join(tid.to_string());
            std::fs::create_dir_all(&task).unwrap();
            let text: Vec<String> = children.iter().map(u32::to_string).collect();
            std::fs::write(task.join("children"), format!("{} ", text.join(" "))).unwrap();
            self
        }

        /// 进程 `pid` 的第 `fd` 号描述符指向 `target`，`fdinfo` 的 `flags` 是
        /// `flags`（原样写进去，可以是坏值）。
        fn open_fd(&self, pid: u32, fd: u32, target: &Path, flags: &str) -> &Self {
            let dir = self.root().join(pid.to_string());
            std::fs::create_dir_all(dir.join("fd")).unwrap();
            std::fs::create_dir_all(dir.join("fdinfo")).unwrap();
            std::os::unix::fs::symlink(target, dir.join("fd").join(fd.to_string())).unwrap();
            std::fs::write(
                dir.join("fdinfo").join(fd.to_string()),
                format!("pos:\t0\nflags:\t{flags}\nmnt_id:\t25\n"),
            )
            .unwrap();
            self
        }
    }

    #[test]
    fn parse_stat_counts_from_the_last_paren() {
        let stat = "42 (a) b) (c) S 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 777 1 2";
        assert_eq!(parse_stat(stat), Some(('S', 777)));
        assert_eq!(parse_stat("42 (no close paren S 1"), None);
        assert_eq!(parse_stat("42 (short) S 1 2"), None);
    }

    #[test]
    fn fdinfo_flags_count_only_write_access() {
        assert!(fdinfo_is_write("pos:\t0\nflags:\t0100001\n"));
        assert!(fdinfo_is_write("pos:\t0\nflags:\t0100002\n"));
        assert!(!fdinfo_is_write("pos:\t0\nflags:\t0100000\n"));
        assert!(!fdinfo_is_write("pos:\t0\nflags:\tnot-octal\n"));
        assert!(!fdinfo_is_write("pos:\t0\n"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descendants_walk_two_levels_and_every_thread() {
        let proc = FakeProc::new();
        proc.process(100, 'S', 1, &[200])
            // 子进程挂在另一个线程下面，也要找到。
            .thread_children(100, 101, &[201])
            .process(200, 'S', 2, &[300])
            .process(201, 'S', 3, &[])
            .process(300, 'S', 4, &[]);
        let mut found = descendants(proc.root(), 100).unwrap();
        found.sort_unstable();
        assert_eq!(found, vec![200, 201, 300]);
        // 叶子进程：确定没有子进程。
        assert_eq!(descendants(proc.root(), 300), Some(vec![]));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descendants_stop_at_the_process_cap() {
        let proc = FakeProc::new();
        let children: Vec<u32> = (1000..1000 + MAX_DESCENDANTS as u32 + 50).collect();
        proc.process(100, 'S', 1, &children);
        let found = descendants(proc.root(), 100).unwrap();
        assert_eq!(found.len(), MAX_DESCENDANTS);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descendants_stop_at_the_depth_cap() {
        let proc = FakeProc::new();
        // 一条 30 层的链：100 → 101 → … → 130。
        for pid in 100..130 {
            proc.process(pid, 'S', 1, &[pid + 1]);
        }
        proc.process(130, 'S', 1, &[]);
        let found = descendants(proc.root(), 100).unwrap();
        assert_eq!(found.len(), MAX_DEPTH);
        assert_eq!(found.last(), Some(&(100 + MAX_DEPTH as u32)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn missing_proc_tree_yields_nothing() {
        let proc = FakeProc::new();
        let missing = proc.root().join("no-such-dir");
        assert_eq!(descendants(&missing, 100), Some(vec![]));
        assert_eq!(probe_process(&missing, 100), ProcessProbe::Gone);
        assert_eq!(
            writers_of(&missing, &[100], Path::new("/tmp/out.log")),
            Some(vec![])
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn probe_treats_zombies_as_dead_and_reads_the_start_time() {
        let proc = FakeProc::new();
        proc.process(100, 'S', 4242, &[])
            .process(101, 'Z', 7, &[])
            .process(102, 'X', 7, &[]);
        assert_eq!(
            probe_process(proc.root(), 100),
            ProcessProbe::Alive { start: 4242 }
        );
        assert_eq!(probe_process(proc.root(), 101), ProcessProbe::Gone);
        assert_eq!(probe_process(proc.root(), 102), ProcessProbe::Gone);
        assert_eq!(probe_process(proc.root(), 103), ProcessProbe::Gone);

        let same = ProcessIdentity {
            pid: 100,
            start: 4242,
        };
        let reused = ProcessIdentity { pid: 100, start: 1 };
        assert_eq!(probe_process(proc.root(), 100).matches(same), Some(true));
        assert_eq!(probe_process(proc.root(), 100).matches(reused), Some(false));
        assert_eq!(probe_process(proc.root(), 101).matches(same), Some(false));
        assert_eq!(ProcessProbe::Unknown.matches(same), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn probe_reports_unreadable_stat_as_unknown() {
        let proc = FakeProc::new();
        let dir = proc.root().join("100");
        std::fs::create_dir_all(&dir).unwrap();
        // 内容读不懂：不知道。
        std::fs::write(dir.join("stat"), "garbage").unwrap();
        assert_eq!(probe_process(proc.root(), 100), ProcessProbe::Unknown);
        // 读不了（不是不存在，这里用目录代替文件）：不知道。
        std::fs::create_dir_all(proc.root().join("101").join("stat")).unwrap();
        assert_eq!(probe_process(proc.root(), 101), ProcessProbe::Unknown);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn descendants_of_an_unreadable_root_are_unknown() {
        let proc = FakeProc::new();
        // `task` 是个文件而不是目录：读不了，不是不存在。
        std::fs::create_dir_all(proc.root().join("100")).unwrap();
        std::fs::write(proc.root().join("100").join("task"), "").unwrap();
        assert_eq!(descendants(proc.root(), 100), None);
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_descriptor_binding_uses_access_flags_and_rejects_unknowns() {
        let proc = FakeProc::new();
        let out = proc.root().join("task-output.log");
        let other = proc.root().join("other.log");
        std::fs::write(&out, "").unwrap();
        std::fs::write(&other, "").unwrap();
        proc.process(200, 'S', 20, &[])
            .open_fd(200, 1, &out, "0100001")
            .process(201, 'S', 21, &[])
            .open_fd(201, 3, &out, "0100002")
            // 只读打开（适配器在 tail）：不算。
            .process(202, 'S', 22, &[])
            .open_fd(202, 4, &out, "0100000")
            // flags 是坏值：不算。
            .process(203, 'S', 23, &[])
            .open_fd(203, 5, &out, "garbage")
            // 写的是别的文件：不算。
            .process(204, 'S', 24, &[])
            .open_fd(204, 1, &other, "0100001");

        let writers = writers_of(proc.root(), &[200, 201, 202, 203, 204, 205], &out).unwrap();
        assert_eq!(
            writers,
            vec![
                ProcessIdentity {
                    pid: 200,
                    start: 20
                },
                ProcessIdentity {
                    pid: 201,
                    start: 21
                },
            ]
        );
    }

    /// 真进程：起一个子进程把标准输出接到临时文件，从测试进程自己出发能
    /// 在子孙里找到它、认出它在写这个文件；杀掉回收以后它就不在了。
    #[cfg(target_os = "linux")]
    #[test]
    fn real_child_writing_a_file_is_found_from_this_process() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("sleep.out");
        let file = std::fs::File::create(&out).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("600")
            .stdout(file)
            .spawn()
            .unwrap();
        let pid = child.id();
        let root = Path::new(PROC_ROOT);
        let out = out.canonicalize().unwrap();

        let found = descendants(root, std::process::id()).unwrap();
        assert!(found.contains(&pid), "{pid} not in {found:?}");
        let writers = writers_of(root, &found, &out).unwrap();
        let identity = writers
            .iter()
            .copied()
            .find(|writer| writer.pid == pid)
            .expect("the sleep child writes its stdout file");
        assert_eq!(probe_process(root, pid).matches(identity), Some(true));

        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(probe_process(root, pid).matches(identity), Some(false));
    }

    // ---- 判「?」（完成标准 10、12、14） ----

    use BackgroundUncertainReason::{AgentExited, BackgroundProcessExited, SilentWithoutChildren};

    fn t0() -> DateTime<Utc> {
        DateTime::from_timestamp(1_800_000_000, 0).unwrap()
    }

    /// 在跑、pid 100、一分钟前刚有进展、时限 30 分钟。
    fn input() -> WatchInput {
        WatchInput {
            running: true,
            waiting: false,
            pid: 100,
            last_progress_at: t0(),
            now: t0() + chrono::Duration::minutes(1),
            silence: chrono::Duration::seconds(DEFAULT_SILENCE_TIMEOUT_SECS),
        }
    }

    /// 已经见过 pid 100（starttime 7）。
    fn watched() -> ProcessWatch {
        ProcessWatch {
            seen_pid: 100,
            agent: Some(ProcessIdentity { pid: 100, start: 7 }),
            ..ProcessWatch::default()
        }
    }

    /// 智能体活着（starttime 7）、有活着的子进程。
    fn healthy() -> WatchSample {
        WatchSample {
            agent: ProcessProbe::Alive { start: 7 },
            has_children: Some(true),
            new_writers: Vec::new(),
            writers_alive: Vec::new(),
            claude_child_alive: None,
            new_claude_child: None,
        }
    }

    fn quiet_for(minutes: i64) -> WatchInput {
        WatchInput {
            now: t0() + chrono::Duration::minutes(minutes),
            ..input()
        }
    }

    #[test]
    fn silence_marks_only_at_the_deadline_and_without_children() {
        let lonely = WatchSample {
            has_children: Some(false),
            ..healthy()
        };
        let just_before = WatchInput {
            now: t0() + chrono::Duration::seconds(DEFAULT_SILENCE_TIMEOUT_SECS - 1),
            ..input()
        };
        assert_eq!(judge(&watched(), &just_before, &lonely), None);
        let at_deadline = WatchInput {
            now: t0() + chrono::Duration::seconds(DEFAULT_SILENCE_TIMEOUT_SECS),
            ..input()
        };
        assert_eq!(
            judge(&watched(), &at_deadline, &lonely),
            Some(SilentWithoutChildren)
        );
        // 子进程不知道或者有：2 小时也不标。
        let unknown_children = WatchSample {
            has_children: None,
            ..healthy()
        };
        assert_eq!(judge(&watched(), &quiet_for(120), &unknown_children), None);
        assert_eq!(judge(&watched(), &quiet_for(120), &healthy()), None);
        // 智能体活不活不知道：也不标。
        let unknown_agent = WatchSample {
            agent: ProcessProbe::Unknown,
            ..lonely.clone()
        };
        assert_eq!(judge(&watched(), &quiet_for(120), &unknown_agent), None);
    }

    #[test]
    fn a_live_agent_with_children_is_never_marked_while_running_or_waiting() {
        for minutes in [15, 31, 120] {
            assert_eq!(judge(&watched(), &quiet_for(minutes), &healthy()), None);
            let waiting = WatchInput {
                running: false,
                waiting: true,
                ..quiet_for(minutes)
            };
            assert_eq!(judge(&watched(), &waiting, &healthy()), None);
        }
    }

    #[test]
    fn neither_running_nor_waiting_is_never_marked() {
        let idle = WatchInput {
            running: false,
            waiting: false,
            pid: 0,
            ..quiet_for(120)
        };
        let gone = WatchSample {
            agent: ProcessProbe::Gone,
            has_children: Some(false),
            ..healthy()
        };
        assert_eq!(judge(&watched(), &idle, &gone), None);
    }

    #[test]
    fn agent_exit_is_read_from_the_pid_cell_and_the_process_table() {
        // pid 格子先前非 0、现在 0：回收了。
        let reaped = WatchInput { pid: 0, ..input() };
        assert_eq!(
            judge(&watched(), &reaped, &WatchSample::unknown()),
            Some(AgentExited)
        );
        // 还没启动（从来没见过非 0）：不算退出。
        assert_eq!(
            judge(&ProcessWatch::default(), &reaped, &WatchSample::unknown()),
            None
        );
        // `/proc/<pid>` 不在了 / 僵尸：退出。
        let gone = WatchSample {
            agent: ProcessProbe::Gone,
            ..healthy()
        };
        assert_eq!(judge(&watched(), &input(), &gone), Some(AgentExited));
        // pid 被重用：starttime 对不上。
        let reused = WatchSample {
            agent: ProcessProbe::Alive { start: 99 },
            ..healthy()
        };
        assert_eq!(judge(&watched(), &input(), &reused), Some(AgentExited));
        // 读进程表失败：不知道，不标。
        let unknown = WatchSample {
            agent: ProcessProbe::Unknown,
            ..healthy()
        };
        assert_eq!(judge(&watched(), &input(), &unknown), None);
    }

    #[test]
    fn bound_writers_that_died_mark_the_task_and_unknowns_do_not() {
        let waiting = WatchInput {
            running: false,
            waiting: true,
            ..input()
        };
        let dead = WatchSample {
            writers_alive: vec![("t1".into(), Some(false))],
            ..healthy()
        };
        assert_eq!(
            judge(&watched(), &waiting, &dead),
            Some(BackgroundProcessExited)
        );
        let unknown = WatchSample {
            writers_alive: vec![("t1".into(), None)],
            ..healthy()
        };
        assert_eq!(judge(&watched(), &waiting, &unknown), None);
        let alive = WatchSample {
            writers_alive: vec![("t1".into(), Some(true))],
            ..healthy()
        };
        assert_eq!(judge(&watched(), &waiting, &alive), None);
        // 智能体自己退出排在前面。
        let both = WatchSample {
            agent: ProcessProbe::Gone,
            ..dead
        };
        assert_eq!(judge(&watched(), &waiting, &both), Some(AgentExited));
    }

    /// 假的进程表：按 pid 给死活，子孙和写进程是固定的。
    struct FakeReader {
        probes: BTreeMap<u32, ProcessProbe>,
        children: Option<Vec<u32>>,
        writers: Option<Vec<ProcessIdentity>>,
    }

    impl ProcReader for FakeReader {
        fn probe(&self, pid: u32) -> ProcessProbe {
            self.probes.get(&pid).copied().unwrap_or(ProcessProbe::Gone)
        }
        fn descendants(&self, _pid: u32) -> Option<Vec<u32>> {
            self.children.clone()
        }
        fn children(&self, _pid: u32) -> Option<Vec<u32>> {
            self.children.clone()
        }
        fn writers_of(&self, _pids: &[u32], _path: &Path) -> Option<Vec<ProcessIdentity>> {
            self.writers.clone()
        }
    }

    fn sample_task() -> WatchedTask {
        WatchedTask {
            task_id: "t1".into(),
            output: PathBuf::from("/tmp/fake-task.out"),
        }
    }

    #[test]
    fn writers_are_bound_once_then_checked_by_identity() {
        let task = sample_task();
        let writer = ProcessIdentity {
            pid: 300,
            start: 30,
        };
        let mut reader = FakeReader {
            probes: BTreeMap::from([
                (100, ProcessProbe::Alive { start: 7 }),
                (300, ProcessProbe::Alive { start: 30 }),
            ]),
            children: Some(vec![300]),
            writers: Some(vec![writer]),
        };
        let waiting = WatchInput {
            running: false,
            waiting: true,
            ..input()
        };
        let mut watch = ProcessWatch::default();
        let target = |watch: &ProcessWatch| WatchTarget {
            pid: 100,
            watch: watch.clone(),
            tasks: vec![task.clone()],
            needs_children: false,
            claude_child: false,
        };

        // 第一次：绑上写进程，记下智能体身份，没有「?」。
        let first = sample(&reader, &target(&watch));
        assert_eq!(first.new_writers, vec![("t1".to_string(), vec![writer])]);
        assert_eq!(
            observe(&mut watch, &waiting, std::slice::from_ref(&task), &first),
            None
        );
        assert_eq!(watch.seen_pid, 100);
        assert_eq!(watch.agent, Some(ProcessIdentity { pid: 100, start: 7 }));
        assert_eq!(watch.writers["t1"], vec![writer]);

        // 写进程的 pid 被重用（starttime 对不上）：算不活。
        reader.probes.insert(300, ProcessProbe::Alive { start: 31 });
        let reused = sample(&reader, &target(&watch));
        assert_eq!(reused.writers_alive, vec![("t1".to_string(), Some(false))]);
        assert_eq!(
            observe(&mut watch, &waiting, std::slice::from_ref(&task), &reused),
            Some(BackgroundProcessExited)
        );
        assert_eq!(watch.uncertain, Some(BackgroundProcessExited));

        // 读进程表失败：不知道，不标。
        reader.probes.insert(300, ProcessProbe::Unknown);
        let unknown = sample(&reader, &target(&watch));
        assert_eq!(
            observe(&mut watch, &waiting, std::slice::from_ref(&task), &unknown),
            None
        );

        // 任务结束了（不在要看的列表里）：绑定丢掉。
        let done = sample(
            &reader,
            &WatchTarget {
                tasks: vec![],
                ..target(&watch)
            },
        );
        observe(&mut watch, &waiting, &[], &done);
        assert!(watch.writers.is_empty());
    }

    #[test]
    fn a_task_never_bound_is_never_marked() {
        let reader = FakeReader {
            probes: BTreeMap::from([(100, ProcessProbe::Alive { start: 7 })]),
            children: Some(vec![]),
            writers: Some(vec![]),
        };
        let waiting = WatchInput {
            running: false,
            waiting: true,
            ..input()
        };
        let mut watch = watched();
        let target = WatchTarget {
            pid: 100,
            watch: watch.clone(),
            tasks: vec![sample_task()],
            needs_children: false,
            claude_child: false,
        };
        let got = sample(&reader, &target);
        assert!(got.new_writers.is_empty());
        assert!(got.writers_alive.is_empty());
        assert_eq!(
            observe(
                &mut watch,
                &waiting,
                std::slice::from_ref(&sample_task()),
                &got
            ),
            None
        );
        assert!(watch.writers.is_empty());
    }

    #[test]
    fn children_are_counted_only_when_needed_and_zombies_do_not_count() {
        let reader = FakeReader {
            probes: BTreeMap::from([
                (100, ProcessProbe::Alive { start: 7 }),
                (200, ProcessProbe::Gone),
            ]),
            children: Some(vec![200]),
            writers: None,
        };
        let mut target = WatchTarget {
            pid: 100,
            watch: watched(),
            tasks: vec![],
            needs_children: false,
            claude_child: false,
        };
        assert_eq!(sample(&reader, &target).has_children, None);
        target.needs_children = true;
        assert_eq!(sample(&reader, &target).has_children, Some(false));
        // pid 格子是 0：什么都不读，全是不知道。
        target.pid = 0;
        assert_eq!(sample(&reader, &target), WatchSample::unknown());
    }

    // ---- Claude 连接：转接进程下面的 Claude 进程没了（#529 完成标准 1、2） ----

    /// 在等后台（不在跑）。
    fn waiting() -> WatchInput {
        WatchInput {
            running: false,
            waiting: true,
            ..input()
        }
    }

    /// 已经见过转接进程 100，也记下过它下面的 Claude 进程 200（starttime 20）。
    fn watched_with_claude() -> ProcessWatch {
        ProcessWatch {
            claude_child: Some(ProcessIdentity {
                pid: 200,
                start: 20,
            }),
            ..watched()
        }
    }

    #[test]
    fn a_vanished_claude_child_under_a_live_adapter_is_agent_exited() {
        // 转接进程活着、记下过的 Claude 进程确定不在了：智能体进程已经退出。
        let gone = WatchSample {
            claude_child_alive: Some(false),
            ..healthy()
        };
        assert_eq!(
            judge(&watched_with_claude(), &waiting(), &gone),
            Some(AgentExited)
        );

        // 用假的进程表走一遍 sample：200 不在了、pid 200 被别的进程重用，都算不在了。
        let target = WatchTarget {
            pid: 100,
            watch: watched_with_claude(),
            tasks: vec![],
            needs_children: false,
            claude_child: true,
        };
        for child in [ProcessProbe::Gone, ProcessProbe::Alive { start: 21 }] {
            let reader = FakeReader {
                probes: BTreeMap::from([(100, ProcessProbe::Alive { start: 7 }), (200, child)]),
                children: Some(vec![200]),
                writers: None,
            };
            let got = sample(&reader, &target);
            assert_eq!(got.claude_child_alive, Some(false), "{child:?}");
            let mut watch = watched_with_claude();
            assert_eq!(
                observe(&mut watch, &waiting(), &[], &got),
                Some(AgentExited),
                "{child:?}"
            );
            assert_eq!(watch.uncertain, Some(AgentExited));
        }
    }

    #[test]
    fn a_claude_child_is_not_marked_unless_seen_before_and_surely_gone() {
        let gone = WatchSample {
            claude_child_alive: Some(false),
            ..healthy()
        };
        // 从没见过 Claude 子进程（比如别的智能体本来就没有子进程）：不标。
        assert_eq!(judge(&watched(), &waiting(), &gone), None);
        // 子进程读不到（不知道）：不标。
        let unknown = WatchSample {
            claude_child_alive: None,
            ..healthy()
        };
        assert_eq!(judge(&watched_with_claude(), &waiting(), &unknown), None);
        // 子进程还在：不标。
        let alive = WatchSample {
            claude_child_alive: Some(true),
            ..healthy()
        };
        assert_eq!(judge(&watched_with_claude(), &waiting(), &alive), None);
        // 连接空闲（不在跑也不在等后台）：不标。
        let idle = WatchInput {
            running: false,
            waiting: false,
            ..input()
        };
        assert_eq!(judge(&watched_with_claude(), &idle, &gone), None);
        // 转接进程活不活不知道：不标。
        let unknown_agent = WatchSample {
            agent: ProcessProbe::Unknown,
            ..gone.clone()
        };
        assert_eq!(
            judge(&watched_with_claude(), &waiting(), &unknown_agent),
            None
        );

        // sample：进程表读不到时是不知道；没要看 Claude 进程时一个子进程都不读。
        let unreadable = FakeReader {
            probes: BTreeMap::from([
                (100, ProcessProbe::Alive { start: 7 }),
                (200, ProcessProbe::Unknown),
            ]),
            children: None,
            writers: None,
        };
        let mut target = WatchTarget {
            pid: 100,
            watch: watched_with_claude(),
            tasks: vec![],
            needs_children: false,
            claude_child: true,
        };
        assert_eq!(sample(&unreadable, &target).claude_child_alive, None);
        target.watch = watched();
        assert_eq!(sample(&unreadable, &target).new_claude_child, None);
        target.claude_child = false;
        target.watch = watched_with_claude();
        let skipped = sample(&unreadable, &target);
        assert_eq!(skipped.claude_child_alive, None);
        assert_eq!(skipped.new_claude_child, None);
    }

    #[test]
    fn the_first_live_direct_child_is_remembered_while_waiting_only() {
        let reader = FakeReader {
            probes: BTreeMap::from([
                (100, ProcessProbe::Alive { start: 7 }),
                (199, ProcessProbe::Gone),
                (200, ProcessProbe::Alive { start: 20 }),
                (201, ProcessProbe::Alive { start: 21 }),
            ]),
            children: Some(vec![199, 200, 201]),
            writers: None,
        };
        let target = |watch: &ProcessWatch| WatchTarget {
            pid: 100,
            watch: watch.clone(),
            tasks: vec![],
            needs_children: false,
            claude_child: true,
        };
        let mut watch = watched();
        let first = sample(&reader, &target(&watch));
        assert_eq!(
            first.new_claude_child,
            Some(ProcessIdentity {
                pid: 200,
                start: 20
            })
        );
        assert_eq!(observe(&mut watch, &waiting(), &[], &first), None);
        assert_eq!(
            watch.claude_child,
            Some(ProcessIdentity {
                pid: 200,
                start: 20
            })
        );
        // 记下以后只按身份查这一个。
        let again = sample(&reader, &target(&watch));
        assert_eq!(again.claude_child_alive, Some(true));
        assert_eq!(again.new_claude_child, None);
        assert_eq!(observe(&mut watch, &waiting(), &[], &again), None);
        // 又开始跑一轮：留着。
        observe(&mut watch, &input(), &[], &again);
        assert!(watch.claude_child.is_some());
        // 不在跑也不在等后台了：留着（#1554）。
        let idle = WatchInput {
            running: false,
            ..input()
        };
        observe(&mut watch, &idle, &[], &again);
        assert!(watch.claude_child.is_some());
        // pid 格子换了：丢掉。
        let mut watch = watched_with_claude();
        let other = WatchInput {
            pid: 101,
            ..waiting()
        };
        observe(&mut watch, &other, &[], &WatchSample::unknown());
        assert_eq!(watch.claude_child, None);
    }

    /// 已定的决定 2：在跑的时候就记下 Claude 进程；它在这一轮里没了不标（一轮内被杀走
    /// 另一条路），这一轮结束、开始等后台以后才按记下的身份判「?」。
    #[test]
    fn a_claude_child_seen_while_running_is_checked_once_waiting() {
        let reader = FakeReader {
            probes: BTreeMap::from([
                (100, ProcessProbe::Alive { start: 7 }),
                (200, ProcessProbe::Alive { start: 20 }),
            ]),
            children: Some(vec![200]),
            writers: None,
        };
        let target = |watch: &ProcessWatch| WatchTarget {
            pid: 100,
            watch: watch.clone(),
            tasks: vec![],
            needs_children: false,
            claude_child: true,
        };
        let mut watch = watched();
        let first = sample(&reader, &target(&watch));
        assert_eq!(observe(&mut watch, &input(), &[], &first), None);
        let remembered = Some(ProcessIdentity {
            pid: 200,
            start: 20,
        });
        assert_eq!(watch.claude_child, remembered);

        // 还在跑：Claude 进程没了也不标，记下的身份留着。
        let gone = FakeReader {
            probes: BTreeMap::from([
                (100, ProcessProbe::Alive { start: 7 }),
                (200, ProcessProbe::Gone),
            ]),
            children: Some(vec![]),
            writers: None,
        };
        let during = sample(&gone, &target(&watch));
        assert_eq!(during.claude_child_alive, Some(false));
        assert_eq!(observe(&mut watch, &input(), &[], &during), None);
        assert_eq!(watch.claude_child, remembered);

        // 这一轮结束、开始等后台：标「?」。
        let after = sample(&gone, &target(&watch));
        assert_eq!(
            observe(&mut watch, &waiting(), &[], &after),
            Some(BackgroundUncertainReason::AgentExited)
        );
    }

    /// #1452：Claude 进程被杀、后台任务跟着被报成结束，计数先归零。上一次还在等后台的话，
    /// 这一次（不在跑也不在等）照样按记下的 Claude 进程判「?」；后台任务那两条不看；
    /// 看完一次就不再看。
    #[test]
    fn a_vanished_claude_child_is_agent_exited_right_after_waiting_ends() {
        let idle = WatchInput {
            running: false,
            waiting: false,
            ..input()
        };
        let gone = WatchSample {
            claude_child_alive: Some(false),
            ..healthy()
        };
        let mut watch = watched_with_claude();
        assert_eq!(observe(&mut watch, &waiting(), &[], &healthy()), None);
        assert!(watch.was_waiting);
        assert_eq!(
            observe(&mut watch, &idle, &[], &gone),
            Some(BackgroundUncertainReason::AgentExited)
        );
        assert!(!watch.was_waiting);
        // #1554：记下的留着，之后空闲时按它判 `idle_claude_exited`，不再进「?」。
        assert!(watch.claude_child.is_some());
        assert_eq!(judge(&watch, &idle, &gone), None);
        assert!(idle_claude_exited(&watch, &idle, &gone));

        // Claude 进程还活着：后台任务正常做完，不标；写进程不在了、安静太久也不看。
        let mut watch = ProcessWatch {
            was_waiting: true,
            ..watched_with_claude()
        };
        let finished = WatchSample {
            claude_child_alive: Some(true),
            has_children: Some(false),
            writers_alive: vec![("bg".into(), Some(false))],
            ..healthy()
        };
        let quiet = WatchInput {
            now: t0() + chrono::Duration::hours(2),
            ..idle
        };
        assert_eq!(observe(&mut watch, &quiet, &[], &finished), None);

        // 上一次就不在等后台（一轮正常跑完）：不看。
        let plain = watched_with_claude();
        assert_eq!(judge(&plain, &idle, &gone), None);
    }

    /// #1554：一轮回完、空闲的 Claude 连接，记下的 Claude 进程留着；它确定不在了（转接进程
    /// 还活着）不进「?」，而是得出「空闲时 Claude 进程退出」，由调用方把连接停掉。
    #[test]
    fn an_idle_claude_child_is_kept_and_its_exit_is_reported_without_uncertain() {
        let idle = WatchInput {
            running: false,
            waiting: false,
            ..input()
        };
        let alive = WatchSample {
            claude_child_alive: Some(true),
            ..healthy()
        };
        let gone = WatchSample {
            claude_child_alive: Some(false),
            ..healthy()
        };
        let mut watch = watched_with_claude();
        assert_eq!(observe(&mut watch, &idle, &[], &alive), None);
        assert_eq!(
            watch.claude_child,
            Some(ProcessIdentity {
                pid: 200,
                start: 20
            })
        );
        assert!(!idle_claude_exited(&watch, &idle, &alive));
        assert_eq!(judge(&watch, &idle, &gone), None);
        assert!(idle_claude_exited(&watch, &idle, &gone));

        // 不知道（读不了）、转接进程不在了或被换了、没记下过、在跑或在等后台：都不算。
        let unknown = WatchSample {
            claude_child_alive: None,
            ..healthy()
        };
        assert!(!idle_claude_exited(&watch, &idle, &unknown));
        let adapter_gone = WatchSample {
            agent: ProcessProbe::Gone,
            ..gone.clone()
        };
        assert!(!idle_claude_exited(&watch, &idle, &adapter_gone));
        let reused = WatchSample {
            agent: ProcessProbe::Alive { start: 8 },
            ..gone.clone()
        };
        assert!(!idle_claude_exited(&watch, &idle, &reused));
        assert!(!idle_claude_exited(&watched(), &idle, &gone));
        assert!(!idle_claude_exited(&watch, &input(), &gone));
        assert!(!idle_claude_exited(&watch, &waiting(), &gone));
        let settling = ProcessWatch {
            was_waiting: true,
            ..watch.clone()
        };
        assert!(!idle_claude_exited(&settling, &idle, &gone));
    }

    /// #1643：从没在在跑时看过的空闲 Claude 连接：第一次采样记下 pid、转接进程身份和 Claude
    /// 进程，之后按记下的判；已经记下的不换，pid 格子换了重新记，转接进程不在了不记。
    #[test]
    fn an_idle_claude_connection_first_seen_idle_records_its_claude_child() {
        let idle = WatchInput {
            running: false,
            waiting: false,
            ..input()
        };
        let child = ProcessIdentity {
            pid: 200,
            start: 20,
        };
        let first = WatchSample {
            new_claude_child: Some(child),
            ..healthy()
        };
        let mut watch = ProcessWatch::default();
        assert!(!idle_claude_exited(&watch, &idle, &first));
        record_idle_claude(&mut watch, &idle, &first);
        assert_eq!(watch, watched_with_claude());
        let gone = WatchSample {
            claude_child_alive: Some(false),
            ..healthy()
        };
        assert!(idle_claude_exited(&watch, &idle, &gone));

        // 已经记下的不换成新冒出来的子进程。
        let other = WatchSample {
            new_claude_child: Some(ProcessIdentity {
                pid: 300,
                start: 30,
            }),
            ..healthy()
        };
        record_idle_claude(&mut watch, &idle, &other);
        assert_eq!(watch.claude_child, Some(child));

        // pid 格子换了：上一个转接进程的身份和 Claude 进程丢掉，记新的。
        let moved = WatchInput { pid: 101, ..idle };
        let fresh = WatchSample {
            agent: ProcessProbe::Alive { start: 9 },
            ..other.clone()
        };
        record_idle_claude(&mut watch, &moved, &fresh);
        assert_eq!(watch.seen_pid, 101);
        assert_eq!(watch.agent, Some(ProcessIdentity { pid: 101, start: 9 }));
        assert_eq!(watch.claude_child, other.new_claude_child);

        // 转接进程不在了、读不了：只记 pid，不记身份和 Claude 进程；pid 格子是 0 不动。
        for agent in [ProcessProbe::Gone, ProcessProbe::Unknown] {
            let mut watch = ProcessWatch::default();
            let s = WatchSample {
                agent,
                ..first.clone()
            };
            record_idle_claude(&mut watch, &idle, &s);
            assert_eq!(watch.seen_pid, 100);
            assert_eq!(watch.agent, None);
            assert_eq!(watch.claude_child, None);
        }
        let mut watch = ProcessWatch::default();
        record_idle_claude(&mut watch, &WatchInput { pid: 0, ..idle }, &first);
        assert_eq!(watch, ProcessWatch::default());
    }

    #[test]
    fn silence_timeout_falls_back_to_the_default_on_bad_values() {
        let default = chrono::Duration::seconds(DEFAULT_SILENCE_TIMEOUT_SECS);
        assert_eq!(parse_silence_timeout(None), default);
        assert_eq!(parse_silence_timeout(Some("0")), default);
        assert_eq!(parse_silence_timeout(Some("-5")), default);
        assert_eq!(parse_silence_timeout(Some("soon")), default);
        assert_eq!(parse_silence_timeout(Some("")), default);
        assert_eq!(parse_silence_timeout(Some(&i64::MAX.to_string())), default);
        assert_eq!(
            parse_silence_timeout(Some("99999999999999999999999")),
            default
        );
        assert_eq!(
            parse_silence_timeout(Some(" 600 ")),
            chrono::Duration::seconds(600)
        );
    }

    /// 完成标准 14：真进程。测试进程起一个 `sleep 600`，标准输出接到临时文件，从测试
    /// 进程自己出发绑上它；`SIGKILL` 它、回收以后再观察一次，这个任务变成
    /// `background_process_exited`。
    #[cfg(target_os = "linux")]
    #[test]
    fn a_killed_background_writer_is_reported_as_exited() {
        let dir = tempfile::tempdir().unwrap();
        let out = dir.path().join("sleep.out");
        let file = std::fs::File::create(&out).unwrap();
        let mut child = std::process::Command::new("sleep")
            .arg("600")
            .stdout(file)
            .spawn()
            .unwrap();
        let pid = child.id();
        let task = WatchedTask {
            task_id: "bg".into(),
            output: out,
        };
        let me = std::process::id();
        let waiting = WatchInput {
            running: false,
            waiting: true,
            pid: me,
            ..input()
        };
        let mut watch = ProcessWatch::default();
        let target = |watch: &ProcessWatch| WatchTarget {
            pid: me,
            watch: watch.clone(),
            tasks: vec![task.clone()],
            needs_children: false,
            claude_child: false,
        };

        let first = sample(&LiveProc, &target(&watch));
        assert_eq!(
            observe(&mut watch, &waiting, std::slice::from_ref(&task), &first),
            None
        );
        assert!(
            watch.writers["bg"].iter().any(|w| w.pid == pid),
            "the sleep child is bound as the writer: {watch:?}"
        );

        child.kill().unwrap();
        child.wait().unwrap();
        let after = sample(&LiveProc, &target(&watch));
        assert_eq!(
            observe(&mut watch, &waiting, std::slice::from_ref(&task), &after),
            Some(BackgroundProcessExited)
        );
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn other_platforms_always_answer_unknown() {
        let root = Path::new(PROC_ROOT);
        let me = std::process::id();
        assert_eq!(descendants(root, me), None);
        assert_eq!(probe_process(root, me), ProcessProbe::Unknown);
        assert_eq!(writers_of(root, &[me], Path::new("/tmp/x")), None);
    }
}
