//! Cowork fork: macOS 桌面版空闲时自动重启换上新版（issue #412 第 5 行）。
//!
//! 下好的新版（更新状态是 `ready_to_restart`）等到这台 Mac 没人在用、本机
//! 也没有活在跑的时候，自己重启换上：每 60 秒取一次快照（[`IdleSnapshot`]），
//! [`idle_verdict`] 说空闲、而且连续两次都是（[`IdleStreak`]），就走和点
//! 「重启以更新」同一条路，重开时用 `open -g`、带
//! [`RELAUNCHED_IN_BACKGROUND`]，新实例不抢前台。
//!
//! 这里都是不碰系统、不碰文件的纯函数，单元测试覆盖；取快照、计时、
//! 重启的接线在 `commands::app_update`（只在桌面编译）。

use std::ffi::{OsStr, OsString};

use super::restart_install::DesktopPlatform;

/// 空闲时自动重启以后，新实例带着这个启动参数：恢复窗口照旧，但不抢焦点、
/// 不激活 app。
pub const RELAUNCHED_IN_BACKGROUND: &str = "--relaunched-in-background";
/// 键盘鼠标这么久没动才算没人在用（5 分钟）。
pub const USER_IDLE_SECS: u64 = 300;
/// 借出去的浏览器、电脑操作最后一次调用以后这么久才算没在用（10 分钟）。
pub const LENT_QUIET_SECS: u64 = 600;
/// 多久取一次快照。
pub const CHECK_EVERY_SECS: u64 = 60;
/// 连续这么多次空闲才重启（相隔 [`CHECK_EVERY_SECS`]）。
pub const IDLE_CHECKS_IN_A_ROW: u32 = 2;
/// 同一个版本空闲时自动重启最多试这么多次，之后只留「重启以更新」给人点。
pub const MAX_IDLE_TRIES: u32 = 2;
/// 问本机 daemon 的每一项最多等这么久。
pub const QUERY_TIMEOUT_SECS: u64 = 5;

/// 设置里的「自动更新」三档（偏好 `update_mode`）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UpdateMode {
    /// 自动安装（默认）：空闲时自己重启换上，退出过就下次启动时换上。
    Auto,
    /// 只下载，由我重启：不自动重启，下次启动时照样换上。
    Download,
    /// 关闭：不自动下载、不自动重启、不在启动时换上。
    Off,
}

impl UpdateMode {
    /// 偏好里存的值：没有、不认识的都算 [`UpdateMode::Auto`]。
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("download") => UpdateMode::Download,
            Some("off") => UpdateMode::Off,
            _ => UpdateMode::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            UpdateMode::Auto => "auto",
            UpdateMode::Download => "download",
            UpdateMode::Off => "off",
        }
    }

    /// 空闲时自动重启：只有「自动安装」。
    pub fn restarts_when_idle(self) -> bool {
        self == UpdateMode::Auto
    }

    /// 启动时换上存着的包：除了「关闭」都做。
    pub fn applies_at_launch(self) -> bool {
        self != UpdateMode::Off
    }
}

/// 哪个平台做空闲时自动重启：只有 macOS。
pub const fn restarts_when_idle_on(platform: DesktopPlatform) -> bool {
    matches!(platform, DesktopPlatform::MacOs)
}

/// 一次快照：本机和借出去的设备上有没有活在跑、人在不在。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct IdleSnapshot {
    /// 本机 daemon 里在跑的回合数加上等人点权限的。
    pub local_turns: u32,
    /// 后台任务还没回来的对话数。
    pub local_background: u32,
    /// 本机 daemon 里活着的终端数。
    pub local_terminals: u32,
    /// 开着的借出 shell 隧道数。
    pub lent_tunnels: u32,
    /// 距上一次借出设备的调用（浏览器、电脑操作）过了多少秒；没有过是 `None`。
    pub lent_last_call_secs: Option<u64>,
    /// 这台 Mac 距上一次键盘鼠标输入过了多少秒。
    pub user_idle_secs: u64,
    /// 上面本机的几项问没问到。
    pub daemon_reachable: bool,
}

/// 被什么挡住了，也是升级日志 `blocked` 里的计数名。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BlockReason {
    LocalTurn,
    Terminal,
    LentDevice,
    UserActive,
    Unknown,
}

impl BlockReason {
    pub fn as_str(self) -> &'static str {
        match self {
            BlockReason::LocalTurn => "local_turn",
            BlockReason::Terminal => "terminal",
            BlockReason::LentDevice => "lent_device",
            BlockReason::UserActive => "user_active",
            BlockReason::Unknown => "unknown",
        }
    }
}

/// [`idle_verdict`] 的结论。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IdleVerdict {
    Ok,
    Blocked(BlockReason),
}

/// 从本机 daemon 的三个回答数出（回合数，等后台的对话数，活着的终端数）：
/// 宠物面板的列表（`pet_list_active_sessions`，`runningCount` 加
/// `waitingCount`，等人点权限的算在 waiting 里）、侧栏的后台列表
/// （`acp_list_background_pending`，`count > 0` 的条目）、终端列表
/// （`terminal_list`，列的时候已经把退出了的收掉了）。哪个回答的形状不对
/// 就是 `None`（当没问到）。
pub fn count_activity(
    pets: &serde_json::Value,
    background: &serde_json::Value,
    terminals: &serde_json::Value,
) -> Option<(u32, u32, u32)> {
    let to_u32 = |n: u64| u32::try_from(n).unwrap_or(u32::MAX);
    let count = |key: &str| pets.get(key).and_then(serde_json::Value::as_u64);
    let turns = count("runningCount")?.saturating_add(count("waitingCount")?);
    let waiting = background
        .as_array()?
        .iter()
        .filter(|entry| {
            entry
                .get("count")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|n| n > 0)
        })
        .count();
    let terminals = terminals.as_array()?.len();
    Some((
        to_u32(turns),
        to_u32(waiting as u64),
        to_u32(terminals as u64),
    ))
}

/// 现在能不能为了更新重启。规则按顺序看，第一条挡住的就是原因：
/// 问不到本机 → `unknown`；有在跑的回合或后台任务 → `local_turn`；有活着的
/// 终端 → `terminal`；有开着的借出隧道、或 10 分钟内借出设备被调用过 →
/// `lent_device`；5 分钟内碰过键盘鼠标 → `user_active`；否则空闲。
pub fn idle_verdict(snapshot: &IdleSnapshot) -> IdleVerdict {
    let s = snapshot;
    let blocked = if !s.daemon_reachable {
        Some(BlockReason::Unknown)
    } else if s.local_turns > 0 || s.local_background > 0 {
        Some(BlockReason::LocalTurn)
    } else if s.local_terminals > 0 {
        Some(BlockReason::Terminal)
    } else if s.lent_tunnels > 0
        || s.lent_last_call_secs
            .is_some_and(|secs| secs < LENT_QUIET_SECS)
    {
        Some(BlockReason::LentDevice)
    } else if s.user_idle_secs < USER_IDLE_SECS {
        Some(BlockReason::UserActive)
    } else {
        None
    };
    blocked.map_or(IdleVerdict::Ok, IdleVerdict::Blocked)
}

/// 这一分钟要不要取快照、看空闲：自动更新是「自动安装」、更新状态是
/// `ready_to_restart`、这次不是回退、这一版自动重启还没试满
/// [`MAX_IDLE_TRIES`] 次。
pub fn should_watch(mode: UpdateMode, ready: bool, rollback: bool, idle_tries: u32) -> bool {
    mode.restarts_when_idle() && ready && !rollback && idle_tries < MAX_IDLE_TRIES
}

/// 本进程里记的、不靠升级日志的那一份：这一版自动重启在本进程里试过几次。
/// 升级日志读不到、写不进去时，次数照样数，不会无限重试。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct IdleTries {
    version: String,
    tries: u32,
}

impl IdleTries {
    /// 还没试过。
    pub const fn new() -> Self {
        Self {
            version: String::new(),
            tries: 0,
        }
    }

    /// 给 `version` 记一次自动重启。`tried_before` 是这次决定重启时合起来
    /// 数的次数（[`watch_facts`]，含升级日志里以前几次运行记下的）。
    pub fn note(&mut self, version: &str, tried_before: u32) {
        let tries = self.count(version).max(tried_before).saturating_add(1);
        self.version = version.to_string();
        self.tries = tries;
    }

    /// `version` 在本进程里试过几次。
    pub fn count(&self, version: &str) -> u32 {
        if self.version == version {
            self.tries
        } else {
            0
        }
    }
}

/// 交给 [`should_watch`] 的「是不是回退」和「试过几次」：本进程内存里记的
/// （`ready_is_rollback`：下好的这一版是不是回退下的；`tried_here`）和升级
/// 日志里的（`journal`，读不到是 None）合起来，任一边说是回退就是回退，次数取
/// 大的。升级日志丢了、坏了，回退下好的包也不会被当成普通升级自动装上。
pub fn watch_facts(
    ready_is_rollback: bool,
    journal: Option<(bool, u32)>,
    tried_here: u32,
) -> (bool, u32) {
    let (journal_rollback, journal_tries) = journal.unwrap_or((false, 0));
    (
        ready_is_rollback || journal_rollback,
        journal_tries.max(tried_here),
    )
}

/// 连续几次空闲。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct IdleStreak {
    ok_in_a_row: u32,
}

impl IdleStreak {
    /// 记下这一次的结论；连续 [`IDLE_CHECKS_IN_A_ROW`] 次空闲时回 true（并从头
    /// 数起）。挡住了就从头数。
    pub fn observe(&mut self, verdict: IdleVerdict) -> bool {
        if verdict != IdleVerdict::Ok {
            self.ok_in_a_row = 0;
            return false;
        }
        self.ok_in_a_row += 1;
        if self.ok_in_a_row < IDLE_CHECKS_IN_A_ROW {
            return false;
        }
        self.ok_in_a_row = 0;
        true
    }

    /// 不在看的时候（没下好、不是自动安装…）从头数。
    pub fn reset(&mut self) {
        self.ok_in_a_row = 0;
    }
}

/// 有没有 [`RELAUNCHED_IN_BACKGROUND`]（`args` 是启动参数，程序名在不在
/// 前面都行）。
pub fn has_background_flag<S: AsRef<OsStr>>(args: &[S]) -> bool {
    args.iter()
        .any(|arg| arg.as_ref() == OsStr::new(RELAUNCHED_IN_BACKGROUND))
}

/// 这个进程是不是空闲时自动重启以后在后台重开的（启动参数里有
/// [`RELAUNCHED_IN_BACKGROUND`]）：恢复窗口时不抢焦点。
pub fn relaunched_in_background() -> bool {
    static FLAG: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *FLAG.get_or_init(|| has_background_flag(&std::env::args_os().collect::<Vec<_>>()))
}

/// 重开新实例时带的启动参数：原来的参数（不含程序名）里去掉旧的
/// [`RELAUNCHED_IN_BACKGROUND`]，后台重开时再加上一个。去掉旧的，是因为
/// 后台重开出来的实例下次被人点「重启以更新」时也会把参数原样传下去，
/// 那次要到前台。
pub fn relaunch_args(args: &[OsString], background: bool) -> Vec<OsString> {
    let mut out: Vec<OsString> = args
        .iter()
        .filter(|arg| arg.as_os_str() != OsStr::new(RELAUNCHED_IN_BACKGROUND))
        .cloned()
        .collect();
    if background {
        out.push(OsString::from(RELAUNCHED_IN_BACKGROUND));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quiet() -> IdleSnapshot {
        IdleSnapshot {
            local_turns: 0,
            local_background: 0,
            local_terminals: 0,
            lent_tunnels: 0,
            lent_last_call_secs: None,
            user_idle_secs: 3_600,
            daemon_reachable: true,
        }
    }

    #[test]
    fn a_quiet_mac_is_idle() {
        assert_eq!(idle_verdict(&quiet()), IdleVerdict::Ok);
        // 借出设备很久以前用过、人刚好离开满 5 分钟：也算空闲。
        let s = IdleSnapshot {
            lent_last_call_secs: Some(LENT_QUIET_SECS),
            user_idle_secs: USER_IDLE_SECS,
            ..quiet()
        };
        assert_eq!(idle_verdict(&s), IdleVerdict::Ok);
    }

    #[test]
    fn an_unreachable_daemon_blocks_as_unknown() {
        let s = IdleSnapshot {
            daemon_reachable: false,
            ..quiet()
        };
        assert_eq!(idle_verdict(&s), IdleVerdict::Blocked(BlockReason::Unknown));
        // 问不到的时候别的读数不可信，先报 unknown。
        let s = IdleSnapshot {
            daemon_reachable: false,
            local_turns: 2,
            user_idle_secs: 0,
            ..quiet()
        };
        assert_eq!(idle_verdict(&s), IdleVerdict::Blocked(BlockReason::Unknown));
    }

    #[test]
    fn a_running_turn_or_background_task_blocks_as_local_turn() {
        for s in [
            IdleSnapshot {
                local_turns: 1,
                ..quiet()
            },
            IdleSnapshot {
                local_background: 1,
                ..quiet()
            },
            // 回合和终端都有：先报回合。
            IdleSnapshot {
                local_turns: 1,
                local_terminals: 3,
                ..quiet()
            },
        ] {
            assert_eq!(
                idle_verdict(&s),
                IdleVerdict::Blocked(BlockReason::LocalTurn),
                "{s:?}"
            );
        }
    }

    #[test]
    fn a_live_terminal_blocks_as_terminal() {
        let s = IdleSnapshot {
            local_terminals: 1,
            lent_tunnels: 1,
            ..quiet()
        };
        assert_eq!(
            idle_verdict(&s),
            IdleVerdict::Blocked(BlockReason::Terminal)
        );
    }

    #[test]
    fn a_lent_device_in_use_blocks_as_lent_device() {
        for s in [
            IdleSnapshot {
                lent_tunnels: 1,
                ..quiet()
            },
            IdleSnapshot {
                lent_last_call_secs: Some(0),
                ..quiet()
            },
            IdleSnapshot {
                lent_last_call_secs: Some(LENT_QUIET_SECS - 1),
                user_idle_secs: 0,
                ..quiet()
            },
        ] {
            assert_eq!(
                idle_verdict(&s),
                IdleVerdict::Blocked(BlockReason::LentDevice),
                "{s:?}"
            );
        }
    }

    #[test]
    fn someone_at_the_keyboard_blocks_as_user_active() {
        for secs in [0, USER_IDLE_SECS - 1] {
            let s = IdleSnapshot {
                user_idle_secs: secs,
                ..quiet()
            };
            assert_eq!(
                idle_verdict(&s),
                IdleVerdict::Blocked(BlockReason::UserActive)
            );
        }
    }

    #[test]
    fn block_reasons_are_the_journal_s_counter_names() {
        let names: Vec<_> = [
            BlockReason::LocalTurn,
            BlockReason::Terminal,
            BlockReason::LentDevice,
            BlockReason::UserActive,
            BlockReason::Unknown,
        ]
        .iter()
        .map(|r| r.as_str())
        .collect();
        assert_eq!(
            names,
            [
                "local_turn",
                "terminal",
                "lent_device",
                "user_active",
                "unknown"
            ]
        );
    }

    #[test]
    fn two_idle_checks_in_a_row_restart() {
        let mut streak = IdleStreak::default();
        assert!(!streak.observe(IdleVerdict::Ok));
        assert!(streak.observe(IdleVerdict::Ok));
        // 重启的那次以后从头数。
        assert!(!streak.observe(IdleVerdict::Ok));

        // 中间被挡一次就从头数。
        let mut streak = IdleStreak::default();
        assert!(!streak.observe(IdleVerdict::Ok));
        assert!(!streak.observe(IdleVerdict::Blocked(BlockReason::UserActive)));
        assert!(!streak.observe(IdleVerdict::Ok));
        assert!(streak.observe(IdleVerdict::Ok));

        // 不在看的那一分钟也从头数。
        let mut streak = IdleStreak::default();
        assert!(!streak.observe(IdleVerdict::Ok));
        streak.reset();
        assert!(!streak.observe(IdleVerdict::Ok));
    }

    #[test]
    fn the_update_mode_reads_unknown_values_as_auto() {
        assert_eq!(UpdateMode::parse(None), UpdateMode::Auto);
        assert_eq!(UpdateMode::parse(Some("auto")), UpdateMode::Auto);
        assert_eq!(UpdateMode::parse(Some("download")), UpdateMode::Download);
        assert_eq!(UpdateMode::parse(Some("off")), UpdateMode::Off);
        assert_eq!(UpdateMode::parse(Some("OFF?")), UpdateMode::Auto);
        assert_eq!(UpdateMode::parse(Some("")), UpdateMode::Auto);
        for mode in [UpdateMode::Auto, UpdateMode::Download, UpdateMode::Off] {
            assert_eq!(UpdateMode::parse(Some(mode.as_str())), mode);
        }
    }

    #[test]
    fn only_auto_restarts_when_idle_and_only_off_skips_the_launch_apply() {
        assert!(UpdateMode::Auto.restarts_when_idle());
        assert!(!UpdateMode::Download.restarts_when_idle());
        assert!(!UpdateMode::Off.restarts_when_idle());

        assert!(UpdateMode::Auto.applies_at_launch());
        assert!(UpdateMode::Download.applies_at_launch());
        assert!(!UpdateMode::Off.applies_at_launch());

        assert!(restarts_when_idle_on(DesktopPlatform::MacOs));
        assert!(!restarts_when_idle_on(DesktopPlatform::Windows));
        assert!(!restarts_when_idle_on(DesktopPlatform::Linux));
    }

    #[test]
    fn a_fresh_count_has_tried_nothing() {
        // 进程里共用的那一份（`IDLE_TRIED_HERE`）从这里开始。
        assert_eq!(IdleTries::new(), IdleTries::default());
        assert_eq!(IdleTries::new().count("1.6.41"), 0);
    }

    #[test]
    fn idle_restarts_are_watched_for_only_when_they_may_happen() {
        assert!(should_watch(UpdateMode::Auto, true, false, 0));
        assert!(should_watch(
            UpdateMode::Auto,
            true,
            false,
            MAX_IDLE_TRIES - 1
        ));
        // 试满了、没下好、回退、不是自动安装：都不看。
        assert!(!should_watch(UpdateMode::Auto, true, false, MAX_IDLE_TRIES));
        assert!(!should_watch(UpdateMode::Auto, false, false, 0));
        assert!(!should_watch(UpdateMode::Auto, true, true, 0));
        assert!(!should_watch(UpdateMode::Download, true, false, 0));
        assert!(!should_watch(UpdateMode::Off, true, false, 0));
    }

    #[test]
    fn a_rollback_is_not_watched_even_when_the_journal_is_lost() {
        // 升级日志读不到（None）、或者坏了读成空的（不是回退、0 次）：内存里
        // 记着是回退，就还是回退，不看空闲。
        let (rollback, tries) = watch_facts(true, None, 0);
        assert!(rollback);
        assert!(!should_watch(UpdateMode::Auto, true, rollback, tries));
        let (rollback, _) = watch_facts(true, Some((false, 0)), 0);
        assert!(rollback);
        // 内存里没记着回退时，照升级日志的。
        assert_eq!(watch_facts(false, Some((true, 1)), 0), (true, 1));
        assert_eq!(watch_facts(false, None, 0), (false, 0));
    }

    #[test]
    fn idle_tries_are_capped_even_when_the_journal_is_lost() {
        let mut here = IdleTries::default();
        here.note("1.6.41", 0);
        here.note("1.6.41", 1);
        assert_eq!(here.count("1.6.41"), 2);
        assert_eq!(here.count("1.6.42"), 0);
        let (rollback, tries) = watch_facts(false, None, here.count("1.6.41"));
        assert_eq!(tries, MAX_IDLE_TRIES);
        assert!(!should_watch(UpdateMode::Auto, true, rollback, tries));
        // 次数取大的。
        assert_eq!(watch_facts(false, Some((false, 1)), 2), (false, 2));
        assert_eq!(watch_facts(false, Some((false, 2)), 1), (false, 2));
        // 换了一版从头数。
        here.note("1.6.42", 0);
        assert_eq!(here.count("1.6.42"), 1);
        assert_eq!(here.count("1.6.41"), 0);
    }

    #[test]
    fn tries_from_an_earlier_run_add_up_when_the_journal_cannot_be_written() {
        // 升级日志里以前那次运行记了 1 次；这次运行又试了一次，但日志写不进去，
        // 还是 1。合起来是 2，不许第三次。
        let mut here = IdleTries::default();
        let (_, tries) = watch_facts(false, Some((false, 1)), here.count("1.6.41"));
        assert_eq!(tries, 1);
        here.note("1.6.41", tries);
        let (rollback, tries) = watch_facts(false, Some((false, 1)), here.count("1.6.41"));
        assert_eq!(tries, MAX_IDLE_TRIES);
        assert!(!should_watch(UpdateMode::Auto, true, rollback, tries));
    }

    #[test]
    fn the_local_daemon_s_answers_are_counted() {
        use serde_json::json;
        let pets = json!({"runningCount": 2, "waitingCount": 1, "errorCount": 4, "sessions": []});
        let background = json!([
            {"conversation_id": 1, "count": 2, "state": "waiting"},
            {"conversation_id": 2, "count": 0, "state": "uncertain"},
            {"conversation_id": 3, "count": 1}
        ]);
        let terminals = json!([{"id": "a", "title": "zsh"}]);
        assert_eq!(
            count_activity(&pets, &background, &terminals),
            Some((3, 2, 1))
        );
        // 什么都没有。
        let none = json!({"runningCount": 0, "waitingCount": 0});
        assert_eq!(
            count_activity(&none, &json!([]), &json!([])),
            Some((0, 0, 0))
        );
        // 形状不对：当没问到。
        assert_eq!(count_activity(&json!({}), &json!([]), &json!([])), None);
        assert_eq!(count_activity(&none, &json!({}), &json!([])), None);
        assert_eq!(count_activity(&none, &json!([]), &json!(null)), None);
    }

    fn os(list: &[&str]) -> Vec<OsString> {
        list.iter().map(OsString::from).collect()
    }

    #[test]
    fn a_background_relaunch_carries_the_flag_and_a_front_one_does_not() {
        let original = os(&["--flag", "two words"]);
        assert_eq!(
            relaunch_args(&original, true),
            os(&["--flag", "two words", RELAUNCHED_IN_BACKGROUND])
        );
        assert_eq!(relaunch_args(&original, false), original);

        // 后台重开出来的实例再重开：到前台的不带，到后台的只带一个。
        let relaunched = os(&["--flag", RELAUNCHED_IN_BACKGROUND]);
        assert_eq!(relaunch_args(&relaunched, false), os(&["--flag"]));
        assert_eq!(
            relaunch_args(&relaunched, true),
            os(&["--flag", RELAUNCHED_IN_BACKGROUND])
        );

        assert!(has_background_flag(&["codeg", RELAUNCHED_IN_BACKGROUND]));
        assert!(has_background_flag(&relaunch_args(&[], true)));
        assert!(!has_background_flag(&["codeg", "--flag"]));
        assert!(!has_background_flag::<&str>(&[]));
    }
}
