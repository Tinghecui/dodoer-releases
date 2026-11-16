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
//! 这一步只有读法和测试，还没接进轮询，函数暂时没有调用方。

// 判「?」的轮询接上以后去掉。非 Linux 上用到这些读法的测试不编，测试构建里
// 也会有没用到的（`ProcessProbe::matches` 等），一起放过。
#![cfg_attr(any(not(test), not(target_os = "linux")), allow(dead_code))]

use std::collections::HashSet;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};

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
