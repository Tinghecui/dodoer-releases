//! Cowork fork: how loaded the machine this daemon runs on is — CPU, memory,
//! swap and the disk the projects are on — for the workspace's resource meter
//! (`src/components/cowork/resource-meter.tsx`).
//!
//! The meter answers "is this machine about to run out of memory?" before an
//! agent's build does: on 2026-11-07 one `rustc` took 6.5 GB of an 8 GB
//! server and the OOM killer stopped the employee's whole codeg service.
//!
//! * Clients poll `get_system_resources`; nothing is sampled while nobody
//!   asks. Answers are cached for [`MIN_SAMPLE_INTERVAL`], so any number of
//!   windows cost one sample a second at most, and CPU usage — a difference
//!   between two readings — is always taken over a window that long.
//! * [`Pressure`] is decided here, not in the client: on Linux from the
//!   headroom left (the host's, and the cgroup limit's when the service has
//!   one), on macOS from the kernel's own verdict, since macOS keeps memory
//!   full on purpose and a percentage says little there.
//! * No crate for it: Linux needs nothing beyond `/proc` and `/sys/fs/cgroup`,
//!   macOS nothing beyond the `libc` calls in `platform`. Windows reports
//!   nothing, and the meter stays hidden.

use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use axum::Json;
use serde::Serialize;

use crate::app_error::AppCommandError;

/// How long an answer is reused. Also the shortest window CPU usage is
/// measured over.
const MIN_SAMPLE_INTERVAL: Duration = Duration::from_secs(1);

/// The window the very first sample measures CPU usage over, so the first
/// answer already carries a figure instead of "unknown until the next poll".
const FIRST_CPU_WINDOW: Duration = Duration::from_millis(150);

/// Share of memory still available below which [`Pressure`] is `Warning` /
/// `Critical` (Linux; macOS asks the kernel).
const WARNING_HEADROOM: f64 = 0.15;
const CRITICAL_HEADROOM: f64 = 0.07;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Pressure {
    Normal,
    Warning,
    Critical,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct CpuUsage {
    /// 0–100 across all cores; `None` until two readings exist.
    pub usage_percent: Option<f64>,
    pub cores: u32,
    /// 1, 5 and 15 minute load averages.
    pub load_average: Option<[f64; 3]>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemoryUsage {
    pub total_bytes: u64,
    /// What a new process could still get without swapping: free memory plus
    /// reclaimable caches (Linux `MemAvailable`; on macOS, everything that is
    /// not app memory, wired or compressed — Activity Monitor's reading).
    pub available_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SwapUsage {
    pub total_bytes: u64,
    pub used_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct DiskUsage {
    /// The directory whose filesystem this is.
    pub path: String,
    pub total_bytes: u64,
    /// Available to this user (excludes root's reserve).
    pub available_bytes: u64,
}

/// A cgroup memory limit and how much of it is used, at the level the limit
/// is set on (the service itself, or a slice above it).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct MemoryLimit {
    pub limit_bytes: u64,
    pub used_bytes: u64,
}

impl MemoryLimit {
    fn headroom(&self) -> f64 {
        headroom(
            self.limit_bytes,
            self.limit_bytes.saturating_sub(self.used_bytes),
        )
    }
}

/// Linux, as a service or in a container: the memory of this daemon and
/// everything it started (agents, terminals, builds), from its cgroup.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct WorkspaceMemory {
    /// Without the page cache that can be dropped (`inactive_file`).
    pub used_bytes: u64,
    /// The tightest limit on the way up, if any.
    pub limit: Option<MemoryLimit>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct SystemResources {
    /// Unix millis of the sample.
    pub sampled_at: u64,
    pub cpu: Option<CpuUsage>,
    pub memory: Option<MemoryUsage>,
    pub swap: Option<SwapUsage>,
    pub disk: Option<DiskUsage>,
    pub workspace: Option<WorkspaceMemory>,
    pub memory_pressure: Pressure,
}

/// Cumulative CPU time, in whatever unit the platform counts in.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct CpuTicks {
    idle: u64,
    total: u64,
}

fn cpu_usage_percent(prev: CpuTicks, now: CpuTicks) -> Option<f64> {
    // A counter that went backwards (wrapped, or a CPU went offline) gives no
    // figure for this window rather than a wrong one.
    let total = now.total.checked_sub(prev.total)?;
    let idle = now.idle.checked_sub(prev.idle)?;
    if total == 0 {
        return None;
    }
    let busy = total.saturating_sub(idle) as f64 / total as f64 * 100.0;
    Some((busy * 10.0).round() / 10.0)
}

/// The share of `total` still available, 0–1.
fn headroom(total: u64, available: u64) -> f64 {
    if total == 0 {
        return 1.0;
    }
    available.min(total) as f64 / total as f64
}

fn memory_pressure(
    memory: Option<&MemoryUsage>,
    limit: Option<&MemoryLimit>,
    kernel: Option<Pressure>,
) -> Pressure {
    if let Some(level) = kernel {
        return level;
    }
    let tightest = [
        memory.map(|m| headroom(m.total_bytes, m.available_bytes)),
        limit.map(MemoryLimit::headroom),
    ]
    .into_iter()
    .flatten()
    .fold(1.0, f64::min);
    if tightest < CRITICAL_HEADROOM {
        Pressure::Critical
    } else if tightest < WARNING_HEADROOM {
        Pressure::Warning
    } else {
        Pressure::Normal
    }
}

/// Space on the filesystem `path` is on.
#[cfg(unix)]
// The fields' widths differ by platform (blocks are u32 on macOS, u64 on
// Linux), so the casts are needed on one and not on the other.
#[allow(clippy::unnecessary_cast)]
fn disk_usage(path: &Path) -> Option<DiskUsage> {
    use std::os::unix::ffi::OsStrExt;

    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
    let mut stat = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
    // SAFETY: `c_path` is NUL-terminated and `stat` is room for one `statvfs`,
    // which the call fills in when it returns 0.
    let rc = unsafe { libc::statvfs(c_path.as_ptr(), stat.as_mut_ptr()) };
    if rc != 0 {
        return None;
    }
    // SAFETY: the call succeeded, so it initialized `stat`.
    let stat = unsafe { stat.assume_init() };
    let block = stat.f_frsize as u64;
    let total = (stat.f_blocks as u64).saturating_mul(block);
    if total == 0 {
        return None;
    }
    Some(DiskUsage {
        path: path.display().to_string(),
        total_bytes: total,
        available_bytes: (stat.f_bavail as u64).saturating_mul(block),
    })
}

#[cfg(not(unix))]
fn disk_usage(_path: &Path) -> Option<DiskUsage> {
    None
}

/// The disk worth watching: where Cowork creates projects, else the home
/// directory (workspaces, agent caches and codeg's own data all sit under it).
fn watched_disk() -> Option<DiskUsage> {
    crate::cowork::settings()
        .projects_root
        .as_deref()
        .and_then(disk_usage)
        .or_else(|| dirs::home_dir().as_deref().and_then(disk_usage))
}

#[cfg(target_os = "linux")]
mod platform {
    use std::path::Path;

    use super::{CpuTicks, MemoryLimit, MemoryUsage, Pressure, SwapUsage, WorkspaceMemory};

    pub fn cpu() -> Option<(CpuTicks, u32)> {
        let stat = std::fs::read_to_string("/proc/stat").ok()?;
        Some((parse_cpu_ticks(&stat)?, count_cpus(&stat)))
    }

    /// The aggregate `cpu` line of `/proc/stat`: user, nice, system, idle,
    /// iowait, irq, softirq, steal. The guest columns after them are already
    /// counted in user and nice.
    pub(super) fn parse_cpu_ticks(stat: &str) -> Option<CpuTicks> {
        let line = stat.lines().find(|line| line.starts_with("cpu "))?;
        let fields = line
            .split_ascii_whitespace()
            .skip(1)
            .take(8)
            .map(|field| field.parse::<u64>().ok())
            .collect::<Option<Vec<u64>>>()?;
        if fields.len() < 4 {
            return None;
        }
        Some(CpuTicks {
            idle: fields[3] + fields.get(4).copied().unwrap_or(0),
            total: fields.iter().sum(),
        })
    }

    /// The per-CPU lines (`cpu0`, `cpu1`, …): the CPUs online.
    pub(super) fn count_cpus(stat: &str) -> u32 {
        let cpus = stat
            .lines()
            .filter(|line| {
                line.strip_prefix("cpu")
                    .is_some_and(|rest| rest.starts_with(|c: char| c.is_ascii_digit()))
            })
            .count();
        (cpus as u32).max(1)
    }

    pub fn load_average() -> Option<[f64; 3]> {
        parse_load_average(&std::fs::read_to_string("/proc/loadavg").ok()?)
    }

    pub(super) fn parse_load_average(loadavg: &str) -> Option<[f64; 3]> {
        let mut fields = loadavg.split_ascii_whitespace();
        let mut next = || fields.next()?.parse::<f64>().ok();
        Some([next()?, next()?, next()?])
    }

    pub fn memory() -> Option<(MemoryUsage, Option<SwapUsage>)> {
        parse_meminfo(&std::fs::read_to_string("/proc/meminfo").ok()?)
    }

    pub(super) fn parse_meminfo(meminfo: &str) -> Option<(MemoryUsage, Option<SwapUsage>)> {
        // `Key:   12345 kB`
        let bytes = |key: &str| -> Option<u64> {
            meminfo.lines().find_map(|line| {
                let value = line.strip_prefix(key)?.strip_prefix(':')?;
                let kb = value.split_ascii_whitespace().next()?.parse::<u64>().ok()?;
                Some(kb.saturating_mul(1024))
            })
        };
        let total = bytes("MemTotal")?;
        // Kernels before 3.14 have no MemAvailable; free + caches is the
        // estimate everyone used then.
        let available = bytes("MemAvailable").or_else(|| {
            Some(bytes("MemFree")? + bytes("Buffers").unwrap_or(0) + bytes("Cached").unwrap_or(0))
        })?;
        let swap = bytes("SwapTotal")
            .filter(|total| *total > 0)
            .map(|total| SwapUsage {
                total_bytes: total,
                used_bytes: total.saturating_sub(bytes("SwapFree").unwrap_or(0)),
            });
        Some((
            MemoryUsage {
                total_bytes: total,
                available_bytes: available.min(total),
            },
            swap,
        ))
    }

    pub fn workspace_memory() -> Option<WorkspaceMemory> {
        let cgroup = std::fs::read_to_string("/proc/self/cgroup").ok()?;
        workspace_memory_in(&cgroup, Path::new("/sys/fs/cgroup"))
    }

    /// This process's cgroup (v2), read under `root`. Reported when it is a
    /// systemd service — then it holds this daemon and what it started, and
    /// nothing else — or when a memory limit applies, as in a container.
    /// A desktop session's scope is neither: it holds the whole login.
    ///
    /// cgroup v1 hosts report nothing; the host's figures still show.
    pub(super) fn workspace_memory_in(proc_cgroup: &str, root: &Path) -> Option<WorkspaceMemory> {
        let path = proc_cgroup
            .lines()
            .find_map(|line| line.strip_prefix("0::"))?
            .trim();
        // `/../…` is how the kernel writes a cgroup outside this namespace's
        // root: not ours to read.
        if path.split('/').any(|part| part == "..") {
            return None;
        }
        let leaf = root.join(path.trim_start_matches('/'));
        let used_bytes = used(&leaf)?;
        // A limit on a parent (a slice shared by every employee's service)
        // binds as much as one on the service: keep the one closest to full,
        // with the usage at its own level.
        let mut limit: Option<MemoryLimit> = None;
        for dir in leaf.ancestors().take_while(|dir| dir.starts_with(root)) {
            // `memory.max` reads `max` when unlimited, which is not a number.
            let (Some(limit_bytes), Some(used_bytes)) =
                (number(&dir.join("memory.max")), used(dir))
            else {
                continue;
            };
            let candidate = MemoryLimit {
                limit_bytes,
                used_bytes,
            };
            if limit
                .as_ref()
                .is_none_or(|tightest| candidate.headroom() < tightest.headroom())
            {
                limit = Some(candidate);
            }
        }
        if limit.is_none() && !path.ends_with(".service") {
            return None;
        }
        Some(WorkspaceMemory { used_bytes, limit })
    }

    /// `memory.current` without the file cache the kernel drops first — the
    /// figure the OOM killer effectively goes by.
    fn used(cgroup: &Path) -> Option<u64> {
        let current = number(&cgroup.join("memory.current"))?;
        let inactive_file = std::fs::read_to_string(cgroup.join("memory.stat"))
            .ok()
            .and_then(|stat| {
                stat.lines().find_map(|line| {
                    line.strip_prefix("inactive_file ")?
                        .trim()
                        .parse::<u64>()
                        .ok()
                })
            })
            .unwrap_or(0);
        Some(current.saturating_sub(inactive_file))
    }

    fn number(file: &Path) -> Option<u64> {
        std::fs::read_to_string(file).ok()?.trim().parse().ok()
    }

    pub fn kernel_pressure() -> Option<Pressure> {
        None
    }
}

#[cfg(target_os = "macos")]
mod platform {
    use std::ffi::CStr;
    use std::mem::MaybeUninit;
    use std::sync::OnceLock;

    use super::{CpuTicks, MemoryUsage, Pressure, SwapUsage, WorkspaceMemory};

    /// The host port, asked for once: every `mach_host_self` call adds a
    /// reference to it that nothing here would give back.
    // libc points at the `mach2` crate for this; one call does not earn a
    // dependency.
    #[allow(deprecated)]
    fn host() -> libc::mach_port_t {
        static HOST: OnceLock<libc::mach_port_t> = OnceLock::new();
        // SAFETY: no arguments, no preconditions; returns a port name.
        *HOST.get_or_init(|| unsafe { libc::mach_host_self() })
    }

    /// A fixed-size `sysctl` value by name.
    fn sysctl<T: Copy>(name: &CStr) -> Option<T> {
        let mut value = MaybeUninit::<T>::zeroed();
        let mut len = std::mem::size_of::<T>();
        // SAFETY: `name` is NUL-terminated, `value` is `len` writable bytes,
        // and the kernel writes no more than `len`, reporting how many.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || len != std::mem::size_of::<T>() {
            return None;
        }
        // SAFETY: the kernel filled all `size_of::<T>()` bytes, and the `T`s
        // asked for here are plain integers and C structs of them.
        Some(unsafe { value.assume_init() })
    }

    pub fn cpu() -> Option<(CpuTicks, u32)> {
        let mut info = MaybeUninit::<libc::host_cpu_load_info>::zeroed();
        let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
        // SAFETY: `info` is `count` integers long, the size this flavor fills.
        let rc = unsafe {
            libc::host_statistics(
                host(),
                libc::HOST_CPU_LOAD_INFO,
                info.as_mut_ptr().cast(),
                &mut count,
            )
        };
        if rc != libc::KERN_SUCCESS {
            return None;
        }
        // SAFETY: the call succeeded, so it initialized `info`.
        let ticks = unsafe { info.assume_init() }.cpu_ticks;
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        Some((
            CpuTicks {
                idle: u64::from(ticks[libc::CPU_STATE_IDLE as usize]),
                total: ticks.iter().map(|&t| u64::from(t)).sum(),
            },
            cores,
        ))
    }

    pub fn load_average() -> Option<[f64; 3]> {
        let mut load = [0f64; 3];
        // SAFETY: `load` has room for the three values asked for.
        let filled = unsafe { libc::getloadavg(load.as_mut_ptr(), 3) };
        (filled == 3).then_some(load)
    }

    pub fn memory() -> Option<(MemoryUsage, Option<SwapUsage>)> {
        let total: u64 = sysctl(c"hw.memsize")?;
        // SAFETY: no preconditions.
        let page = u64::try_from(unsafe { libc::sysconf(libc::_SC_PAGESIZE) }).ok()?;

        let mut stat = MaybeUninit::<libc::vm_statistics64>::zeroed();
        let mut count = libc::HOST_VM_INFO64_COUNT;
        // SAFETY: `stat` is `count` integers long, the size this flavor fills.
        let rc = unsafe {
            libc::host_statistics64(
                host(),
                libc::HOST_VM_INFO64,
                stat.as_mut_ptr().cast(),
                &mut count,
            )
        };
        if rc != libc::KERN_SUCCESS {
            return None;
        }
        // SAFETY: the call succeeded, so it initialized `stat`.
        let stat = unsafe { stat.assume_init() };
        // Activity Monitor's "Memory Used": app memory (anonymous pages that
        // cannot simply be dropped) + wired + compressed. File cache and
        // purgeable memory are given up on demand, so they count as available.
        let used_pages = u64::from(stat.internal_page_count)
            .saturating_sub(u64::from(stat.purgeable_count))
            .saturating_add(u64::from(stat.wire_count))
            .saturating_add(u64::from(stat.compressor_page_count));
        let used = used_pages.saturating_mul(page).min(total);

        let swap = sysctl::<libc::xsw_usage>(c"vm.swapusage")
            .filter(|swap| swap.xsu_total > 0)
            .map(|swap| SwapUsage {
                total_bytes: swap.xsu_total,
                used_bytes: swap.xsu_used,
            });
        Some((
            MemoryUsage {
                total_bytes: total,
                available_bytes: total - used,
            },
            swap,
        ))
    }

    pub fn workspace_memory() -> Option<WorkspaceMemory> {
        None
    }

    /// The kernel's memory pressure level — what Activity Monitor's pressure
    /// graph colours by: 1 normal, 2 warning, 4 critical.
    pub fn kernel_pressure() -> Option<Pressure> {
        match sysctl::<libc::c_int>(c"kern.memorystatus_vm_pressure_level")? {
            1 => Some(Pressure::Normal),
            2 => Some(Pressure::Warning),
            4 => Some(Pressure::Critical),
            _ => None,
        }
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
mod platform {
    use super::{CpuTicks, MemoryUsage, Pressure, SwapUsage, WorkspaceMemory};

    pub fn cpu() -> Option<(CpuTicks, u32)> {
        None
    }

    pub fn load_average() -> Option<[f64; 3]> {
        None
    }

    pub fn memory() -> Option<(MemoryUsage, Option<SwapUsage>)> {
        None
    }

    pub fn workspace_memory() -> Option<WorkspaceMemory> {
        None
    }

    pub fn kernel_pressure() -> Option<Pressure> {
        None
    }
}

struct Sampler {
    /// The CPU counters of the last sample, to take the next difference from.
    ticks: Option<CpuTicks>,
    last: Option<(Instant, SystemResources)>,
}

static SAMPLER: Mutex<Sampler> = Mutex::new(Sampler {
    ticks: None,
    last: None,
});

/// The current reading, at most [`MIN_SAMPLE_INTERVAL`] old. Blocking (file
/// reads, and a short sleep on the very first call): run it off the runtime.
pub fn snapshot() -> SystemResources {
    let mut sampler = SAMPLER
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some((at, cached)) = &sampler.last {
        if at.elapsed() < MIN_SAMPLE_INTERVAL {
            return cached.clone();
        }
    }

    let mut reading = platform::cpu();
    if sampler.ticks.is_none() {
        if let Some((ticks, _)) = reading {
            sampler.ticks = Some(ticks);
            std::thread::sleep(FIRST_CPU_WINDOW);
            reading = platform::cpu();
        }
    }
    let cpu = reading.map(|(ticks, cores)| {
        let usage_percent = sampler
            .ticks
            .and_then(|prev| cpu_usage_percent(prev, ticks));
        sampler.ticks = Some(ticks);
        CpuUsage {
            usage_percent,
            cores,
            load_average: platform::load_average(),
        }
    });

    let (memory, swap) = match platform::memory() {
        Some((memory, swap)) => (Some(memory), swap),
        None => (None, None),
    };
    let workspace = platform::workspace_memory();
    let memory_pressure = memory_pressure(
        memory.as_ref(),
        workspace.as_ref().and_then(|w| w.limit.as_ref()),
        platform::kernel_pressure(),
    );
    let resources = SystemResources {
        sampled_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_or(0, |since| since.as_millis() as u64),
        cpu,
        memory,
        swap,
        disk: watched_disk(),
        workspace,
        memory_pressure,
    };
    sampler.last = Some((Instant::now(), resources.clone()));
    resources
}

pub async fn system_resources_core() -> Result<SystemResources, AppCommandError> {
    tokio::task::spawn_blocking(snapshot)
        .await
        .map_err(|e| AppCommandError::task_execution_failed(e.to_string()))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_system_resources() -> Result<SystemResources, AppCommandError> {
    system_resources_core().await
}

/// `POST /api/get_system_resources` (`cowork::api_routes`).
pub async fn get_system_resources_http() -> Result<Json<SystemResources>, AppCommandError> {
    Ok(Json(system_resources_core().await?))
}

#[cfg(test)]
mod tests {
    use super::*;

    const GIB: u64 = 1024 * 1024 * 1024;

    fn memory(total_gib: u64, available_bytes: u64) -> MemoryUsage {
        MemoryUsage {
            total_bytes: total_gib * GIB,
            available_bytes,
        }
    }

    #[test]
    fn cpu_usage_is_the_busy_share_of_the_window() {
        let prev = CpuTicks {
            idle: 900,
            total: 1000,
        };
        let now = CpuTicks {
            idle: 1050,
            total: 1200,
        };
        // 200 ticks passed, 150 of them idle.
        assert_eq!(cpu_usage_percent(prev, now), Some(25.0));
    }

    #[test]
    fn cpu_usage_is_unknown_without_a_forward_window() {
        let at = CpuTicks {
            idle: 900,
            total: 1000,
        };
        assert_eq!(cpu_usage_percent(at, at), None);
        let wrapped = CpuTicks {
            idle: 10,
            total: 20,
        };
        assert_eq!(cpu_usage_percent(at, wrapped), None);
    }

    #[test]
    fn pressure_follows_the_headroom_left() {
        let level = |available| memory_pressure(Some(&memory(8, available)), None, None);
        assert_eq!(level(4 * GIB), Pressure::Normal);
        // 1 GiB of 8 is 12.5%: under 15%, over 7%.
        assert_eq!(level(GIB), Pressure::Warning);
        // 0.5 GiB of 8 is 6.25%.
        assert_eq!(level(GIB / 2), Pressure::Critical);
        assert_eq!(memory_pressure(None, None, None), Pressure::Normal);
    }

    #[test]
    fn pressure_takes_the_tighter_of_host_and_cgroup_limit() {
        let roomy_host = memory(64, 48 * GIB);
        let nearly_full = MemoryLimit {
            limit_bytes: 4 * GIB,
            used_bytes: 4 * GIB - 100 * 1024 * 1024,
        };
        assert_eq!(
            memory_pressure(Some(&roomy_host), Some(&nearly_full), None),
            Pressure::Critical
        );
        let half_used = MemoryLimit {
            limit_bytes: 4 * GIB,
            used_bytes: 2 * GIB,
        };
        assert_eq!(
            memory_pressure(Some(&roomy_host), Some(&half_used), None),
            Pressure::Normal
        );
    }

    #[test]
    fn the_kernels_verdict_wins_over_percentages() {
        // macOS at 95% "used" with the kernel saying normal is normal.
        let full = memory(16, GIB / 2);
        assert_eq!(
            memory_pressure(Some(&full), None, Some(Pressure::Normal)),
            Pressure::Normal
        );
        assert_eq!(
            memory_pressure(Some(&memory(16, 8 * GIB)), None, Some(Pressure::Critical)),
            Pressure::Critical
        );
    }

    #[test]
    fn serializes_the_shape_the_meter_reads() {
        let resources = SystemResources {
            sampled_at: 1,
            cpu: Some(CpuUsage {
                usage_percent: Some(12.5),
                cores: 8,
                load_average: Some([0.5, 0.4, 0.3]),
            }),
            memory: Some(memory(8, 2 * GIB)),
            swap: None,
            disk: None,
            workspace: Some(WorkspaceMemory {
                used_bytes: GIB,
                limit: None,
            }),
            memory_pressure: Pressure::Warning,
        };
        assert_eq!(
            serde_json::to_value(resources).unwrap(),
            serde_json::json!({
                "sampled_at": 1,
                "cpu": { "usage_percent": 12.5, "cores": 8, "load_average": [0.5, 0.4, 0.3] },
                "memory": { "total_bytes": 8 * GIB, "available_bytes": 2 * GIB },
                "swap": null,
                "disk": null,
                "workspace": { "used_bytes": GIB, "limit": null },
                "memory_pressure": "warning",
            })
        );
    }

    #[cfg(unix)]
    #[test]
    fn disk_usage_reads_a_real_filesystem() {
        let dir = tempfile::tempdir().unwrap();
        let disk = disk_usage(dir.path()).expect("statvfs on a temp dir");
        assert!(disk.total_bytes > 0);
        assert!(disk.available_bytes <= disk.total_bytes);
        assert!(disk_usage(&dir.path().join("missing")).is_none());
    }

    #[cfg(any(target_os = "linux", target_os = "macos"))]
    #[test]
    fn snapshot_reads_this_machine() {
        let resources = snapshot();
        let memory = resources.memory.expect("memory");
        assert!(memory.total_bytes > 0);
        assert!(memory.available_bytes <= memory.total_bytes);
        let cpu = resources.cpu.expect("cpu");
        assert!(cpu.cores >= 1);
        // The first sample waits for its own window, so even it has a figure.
        let usage = cpu.usage_percent.expect("cpu usage");
        assert!((0.0..=100.0).contains(&usage));
        // Asked again at once, the cached sample answers.
        assert_eq!(snapshot().sampled_at, resources.sampled_at);
    }

    #[cfg(target_os = "linux")]
    mod linux {
        use super::super::platform::*;
        use super::super::*;

        const STAT: &str = "\
cpu  1000 50 300 8000 150 0 20 10 5 0
cpu0 500 25 150 4000 75 0 10 5 0 0
cpu1 500 25 150 4000 75 0 10 5 0 0
intr 12345 0 0
ctxt 67890
";

        #[test]
        fn reads_the_aggregate_cpu_line() {
            assert_eq!(
                parse_cpu_ticks(STAT),
                Some(CpuTicks {
                    // idle + iowait
                    idle: 8150,
                    // The first eight columns; guest (5) is inside user.
                    total: 9530,
                })
            );
            assert_eq!(count_cpus(STAT), 2);
            assert_eq!(parse_cpu_ticks("intr 1 2 3\n"), None);
            assert_eq!(parse_cpu_ticks("cpu  1 2 x 4\n"), None);
        }

        #[test]
        fn reads_load_averages() {
            assert_eq!(
                parse_load_average("0.52 1.04 2.10 3/1234 56789\n"),
                Some([0.52, 1.04, 2.10])
            );
            assert_eq!(parse_load_average("0.52 1.04\n"), None);
        }

        #[test]
        fn reads_meminfo() {
            let meminfo = "\
MemTotal:        8130000 kB
MemFree:          757000 kB
MemAvailable:    3350000 kB
Buffers:          120000 kB
Cached:          2500000 kB
SwapCached:         9000 kB
SwapTotal:       4194300 kB
SwapFree:        4116000 kB
";
            let (memory, swap) = parse_meminfo(meminfo).unwrap();
            assert_eq!(memory.total_bytes, 8_130_000 * 1024);
            assert_eq!(memory.available_bytes, 3_350_000 * 1024);
            assert_eq!(
                swap,
                Some(SwapUsage {
                    total_bytes: 4_194_300 * 1024,
                    used_bytes: 78_300 * 1024,
                })
            );
        }

        #[test]
        fn meminfo_without_memavailable_or_swap() {
            let meminfo = "\
MemTotal:        1000 kB
MemFree:          100 kB
Buffers:           50 kB
Cached:           250 kB
SwapCached:       999 kB
SwapTotal:          0 kB
SwapFree:           0 kB
";
            let (memory, swap) = parse_meminfo(meminfo).unwrap();
            // MemFree + Buffers + Cached; SwapCached is not Cached.
            assert_eq!(memory.available_bytes, 400 * 1024);
            assert_eq!(swap, None);
            assert!(parse_meminfo("MemFree: 1 kB\n").is_none());
        }

        fn cgroup(root: &Path, path: &str, max: &str, current: u64, inactive_file: u64) {
            let dir = root.join(path);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("memory.max"), format!("{max}\n")).unwrap();
            std::fs::write(dir.join("memory.current"), format!("{current}\n")).unwrap();
            std::fs::write(
                dir.join("memory.stat"),
                format!("anon 1\nfile 2\ninactive_file {inactive_file}\nactive_file 3\n"),
            )
            .unwrap();
        }

        const SERVICE: &str = "system.slice/system-codeg.slice/codeg@ann.service";

        #[test]
        fn a_service_reports_its_own_memory_without_droppable_cache() {
            let root = tempfile::tempdir().unwrap();
            cgroup(root.path(), SERVICE, "max", 6_000, 4_000);
            assert_eq!(
                workspace_memory_in(&format!("0::/{SERVICE}\n"), root.path()),
                Some(WorkspaceMemory {
                    used_bytes: 2_000,
                    limit: None,
                })
            );
        }

        #[test]
        fn the_limit_closest_to_full_is_reported_with_its_own_usage() {
            let root = tempfile::tempdir().unwrap();
            // The service may use 4000 and uses 1000; the slice above it, shared
            // with the other services, may use 10000 and is at 9500.
            cgroup(root.path(), SERVICE, "4000", 1_000, 0);
            cgroup(
                root.path(),
                "system.slice/system-codeg.slice",
                "10000",
                9_500,
                0,
            );
            assert_eq!(
                workspace_memory_in(&format!("0::/{SERVICE}\n"), root.path()),
                Some(WorkspaceMemory {
                    used_bytes: 1_000,
                    limit: Some(MemoryLimit {
                        limit_bytes: 10_000,
                        used_bytes: 9_500,
                    }),
                })
            );
        }

        #[test]
        fn a_container_reports_the_limit_on_its_root() {
            let root = tempfile::tempdir().unwrap();
            cgroup(root.path(), "", "2000", 1_500, 500);
            assert_eq!(
                workspace_memory_in("0::/\n", root.path()),
                Some(WorkspaceMemory {
                    used_bytes: 1_000,
                    limit: Some(MemoryLimit {
                        limit_bytes: 2_000,
                        used_bytes: 1_000,
                    }),
                })
            );
        }

        #[test]
        fn a_login_session_or_cgroup_v1_reports_nothing() {
            let root = tempfile::tempdir().unwrap();
            let scope = "user.slice/user-1000.slice/session-3.scope";
            cgroup(root.path(), scope, "max", 9_000, 0);
            assert_eq!(
                workspace_memory_in(&format!("0::/{scope}\n"), root.path()),
                None
            );
            assert_eq!(
                workspace_memory_in("12:memory:/user.slice\n1:name=systemd:/x\n", root.path()),
                None
            );
            assert_eq!(
                workspace_memory_in("0::/../other.service\n", root.path()),
                None
            );
        }
    }
}
