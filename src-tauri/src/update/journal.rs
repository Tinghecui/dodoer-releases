//! Cowork fork: 桌面版的升级日志（issue #412）。
//!
//! 一个文件 `<数据目录>/update/journal.json`，里面是「当前这一次升级」
//! （`attempt`）和「上一次的结果」（`last`）。每一次升级从开始下载到新版本
//! 确认跑起来（或者失败）都在这里留下记录，结束时产生一条 [`Outcome`]，由
//! `crash_report` 经崩溃报告的通道上报（docs/telemetry.md「软件更新的记录」）。
//!
//! 状态怎么变的规则都是 [`Journal`] 上不碰文件系统的方法，单元测试覆盖；
//! 读写文件的只有 [`load`] 和 [`save`]（读出来、改、写临时文件、改名）。
//! 接线在 `commands::app_update`（只在桌面编译）。

use std::io;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::idle::BlockReason;

/// 数据目录下放升级相关文件的目录。
pub const DIR_NAME: &str = "update";
/// 日志文件名。
pub const FILE_NAME: &str = "journal.json";
/// 下好以后等了这么久还没换上，报一条 `waiting_long`。
pub const WAITING_LONG_SECS: i64 = 72 * 60 * 60;
/// 新版本启动了这么多次都没确认过，报 `boot_unconfirmed`。
pub const MAX_BOOTS: u32 = 3;
/// 自动下载失败最多这么久报一条。
pub const DOWNLOAD_FAILURE_REPORT_EVERY_SECS: i64 = 24 * 60 * 60;
/// 新版本的 daemon 和主窗口都起来以后，再活这么久就算确认。
pub const CONFIRM_AFTER_SECS: u64 = 60;

/// 这次升级是怎么开始的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Trigger {
    /// 后台自动开始的下载。
    Auto,
    /// 用户点的。
    Manual,
    /// 回退到上一版。
    Rollback,
}

impl Trigger {
    pub fn as_str(self) -> &'static str {
        match self {
            Trigger::Auto => "auto",
            Trigger::Manual => "manual",
            Trigger::Rollback => "rollback",
        }
    }

    /// `perform_app_update` 的 `trigger` 参数：只有 `"auto"` 算自动，
    /// 没带、别的值都算用户点的。
    pub fn from_param(param: Option<&str>) -> Self {
        match param {
            Some("auto") => Trigger::Auto,
            _ => Trigger::Manual,
        }
    }
}

/// `attempt` 走到哪一步了。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptState {
    Downloading,
    Ready,
    Applying,
}

/// 新版本是怎么换上的。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ApplyHow {
    /// 空闲时自己重启。
    Idle,
    /// 用户点了「重启以更新」。
    Click,
    /// 启动时换上。
    Launch,
}

impl ApplyHow {
    pub fn as_str(self) -> &'static str {
        match self {
            ApplyHow::Idle => "idle",
            ApplyHow::Click => "click",
            ApplyHow::Launch => "launch",
        }
    }
}

/// 一次升级的结果，也是上报时 `update_result` 标签的值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UpdateResult {
    Applied,
    DownloadFailed,
    InstallFailed,
    BootUnconfirmed,
    /// 不是结束：下好以后等了很久还没换上，`attempt` 继续。
    WaitingLong,
}

impl UpdateResult {
    pub fn as_str(self) -> &'static str {
        match self {
            UpdateResult::Applied => "applied",
            UpdateResult::DownloadFailed => "download_failed",
            UpdateResult::InstallFailed => "install_failed",
            UpdateResult::BootUnconfirmed => "boot_unconfirmed",
            UpdateResult::WaitingLong => "waiting_long",
        }
    }
}

/// 失败的类别，照前端 `normalizeAppUpdateError` 那几类（`src/lib/updater.ts`），
/// 外加「包没换上」。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ErrorKind {
    Network,
    SourceUnreachable,
    Signature,
    PermissionDenied,
    Disk,
    /// 换上以后启动的还是旧版本。
    NotApplied,
    Unknown,
}

impl ErrorKind {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorKind::Network => "network",
            ErrorKind::SourceUnreachable => "source_unreachable",
            ErrorKind::Signature => "signature",
            ErrorKind::PermissionDenied => "permission_denied",
            ErrorKind::Disk => "disk",
            ErrorKind::NotApplied => "not_applied",
            ErrorKind::Unknown => "unknown",
        }
    }

    /// 从插件（或我们自己）的报错文字认出类别。
    pub fn classify(message: &str) -> Self {
        let m = message.to_lowercase();
        let any = |needles: &[&str]| needles.iter().any(|n| m.contains(n));
        // server 原地升级的可写探测（`update/install.rs` 的 `check_writable`）。
        if m.starts_with("update target is not writable:") {
            return ErrorKind::PermissionDenied;
        }
        if any(&[
            "latest.json",
            "/releases/latest/download/",
            "valid release json",
        ]) {
            return ErrorKind::SourceUnreachable;
        }
        if any(&[
            "error sending request for url",
            "failed to send request",
            "network",
            "timed out",
            "dns",
            "connection refused",
        ]) {
            return ErrorKind::Network;
        }
        if any(&["signature", "minisign", "public key"]) {
            return ErrorKind::Signature;
        }
        if any(&[
            "no space left",
            "disk full",
            "os error 28",
            "quota exceeded",
        ]) {
            return ErrorKind::Disk;
        }
        if any(&[
            "permission denied",
            "operation not permitted",
            "os error 13",
            "os error 1)",
            "not writable",
        ]) {
            return ErrorKind::PermissionDenied;
        }
        ErrorKind::Unknown
    }
}

/// 等空闲时被什么挡住了，每一种各数了几次（第 5 行的空闲判断往里加）。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct Blocked {
    pub local_turn: u64,
    pub terminal: u64,
    pub lent_device: u64,
    pub user_active: u64,
    pub unknown: u64,
}

impl Blocked {
    /// 被 `reason` 挡了一次。
    pub fn add(&mut self, reason: BlockReason) {
        let count = match reason {
            BlockReason::LocalTurn => &mut self.local_turn,
            BlockReason::Terminal => &mut self.terminal,
            BlockReason::LentDevice => &mut self.lent_device,
            BlockReason::UserActive => &mut self.user_active,
            BlockReason::Unknown => &mut self.unknown,
        };
        *count = count.saturating_add(1);
    }
}

/// 当前这一次升级。
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Attempt {
    pub id: String,
    pub from: String,
    pub to: String,
    pub trigger: Trigger,
    pub state: AttemptState,
    pub started_at: DateTime<Utc>,
    #[serde(default)]
    pub download_ms: Option<u64>,
    #[serde(default)]
    pub bytes: Option<u64>,
    #[serde(default)]
    pub reused_package: bool,
    #[serde(default)]
    pub ready_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub blocked: Blocked,
    #[serde(default)]
    pub apply_how: Option<ApplyHow>,
    #[serde(default)]
    pub apply_started_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub install_ms: Option<u64>,
    #[serde(default)]
    pub boots: u32,
    #[serde(default)]
    pub waiting_long_reported: bool,
}

/// 上一次升级的结果。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Last {
    pub to: String,
    pub result: UpdateResult,
    pub finished_at: DateTime<Utc>,
    /// 「已更新到…」提示过了（第 5 行的 `take_update_announcement`）。
    #[serde(default)]
    pub announced: bool,
}

/// `journal.json` 的内容。
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Journal {
    pub attempt: Option<Attempt>,
    pub last: Option<Last>,
    pub last_download_failure_reported_at: Option<DateTime<Utc>>,
    /// 哪一版已经在启动时换过（第 4 行）：每一版启动时只试一次，试之前先写。
    /// 不跟着 `attempt` 清空，换失败了下次启动也不再试这一版。
    pub launch_apply_tried: Option<String>,
    /// 空闲时自动重启试过几次、试的是哪一版（第 5 行）：同一版最多试
    /// `idle::MAX_IDLE_TRIES` 次。不跟着 `attempt` 清空，安装失败以后再下好
    /// 同一版也不会接着试。
    pub idle_apply: Option<IdleApply>,
}

/// 空闲时自动重启试过的那一版和次数。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdleApply {
    pub version: String,
    pub tries: u32,
}

/// `take_update_announcement` 回给窗口的：已经换上的版本。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Announcement {
    pub version: String,
}

/// 一条要上报的升级记录：`crash_report` 把它做成一条非致命的报告。
/// `error` 还没脱敏，做报告时才过 `scrub_text`。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Outcome {
    pub result: UpdateResult,
    pub from: String,
    pub to: String,
    pub trigger: Trigger,
    pub how: Option<ApplyHow>,
    /// 产生这条记录的进程是哪一版。
    pub running: String,
    pub at: DateTime<Utc>,
    pub download_ms: Option<u64>,
    pub bytes: Option<u64>,
    pub reused_package: bool,
    /// 下好到开始换上（`waiting_long` 是下好到现在）。
    pub wait_ms: Option<u64>,
    pub install_ms: Option<u64>,
    /// 开始换上到确认。
    pub boot_ms: Option<u64>,
    pub boots: u32,
    pub blocked: Blocked,
    pub error_kind: Option<ErrorKind>,
    pub error: Option<String>,
}

impl Outcome {
    fn of(attempt: &Attempt, result: UpdateResult, running: &str, now: DateTime<Utc>) -> Self {
        let wait_ms = match (attempt.ready_at, attempt.apply_started_at) {
            (Some(ready), Some(apply)) => Some(millis_between(ready, apply)),
            (Some(ready), None) if result == UpdateResult::WaitingLong => {
                Some(millis_between(ready, now))
            }
            _ => None,
        };
        let boot_ms = match (result, attempt.apply_started_at) {
            (UpdateResult::Applied, Some(apply)) => Some(millis_between(apply, now)),
            _ => None,
        };
        Self {
            result,
            from: attempt.from.clone(),
            to: attempt.to.clone(),
            trigger: attempt.trigger,
            how: attempt.apply_how,
            running: running.to_string(),
            at: now,
            download_ms: attempt.download_ms,
            bytes: attempt.bytes,
            reused_package: attempt.reused_package,
            wait_ms,
            install_ms: attempt.install_ms,
            boot_ms,
            boots: attempt.boots,
            blocked: attempt.blocked,
            error_kind: None,
            error: None,
        }
    }

    fn with_error(mut self, kind: ErrorKind, error: Option<&str>) -> Self {
        self.error_kind = Some(kind);
        self.error = error.map(str::to_string);
        self
    }

    /// 报告记在哪一版下：换上了记新版本，别的记正在运行的版本。
    pub fn release_version(&self) -> &str {
        if self.result == UpdateResult::Applied {
            &self.to
        } else {
            &self.running
        }
    }
}

fn new_attempt(from: &str, to: &str, trigger: Trigger, now: DateTime<Utc>) -> Attempt {
    Attempt {
        id: uuid::Uuid::new_v4().to_string(),
        from: from.to_string(),
        to: to.to_string(),
        trigger,
        state: AttemptState::Downloading,
        started_at: now,
        download_ms: None,
        bytes: None,
        reused_package: false,
        ready_at: None,
        blocked: Blocked::default(),
        apply_how: None,
        apply_started_at: None,
        install_ms: None,
        boots: 0,
        waiting_long_reported: false,
    }
}

fn millis_between(from: DateTime<Utc>, to: DateTime<Utc>) -> u64 {
    u64::try_from((to - from).num_milliseconds()).unwrap_or(0)
}

impl Journal {
    /// 读出来以后先过一遍：`attempt.from` 不是正在运行的版本、又不在换上的
    /// 过程中（`applying`），说明这条早就过时了（比如中间手动装过别的版本），
    /// 当没有。
    pub fn sanitize(&mut self, running: &str) {
        if self
            .attempt
            .as_ref()
            .is_some_and(|a| a.state != AttemptState::Applying && a.from != running)
        {
            self.attempt = None;
        }
    }

    fn finish(&mut self, to: String, result: UpdateResult, now: DateTime<Utc>) {
        self.attempt = None;
        self.last = Some(Last {
            to,
            result,
            finished_at: now,
            // 只有换上了的才要提示「已更新到…」。
            announced: result != UpdateResult::Applied,
        });
    }

    /// 开始下载 `to`（查到更新以后）。之前没结束的那次就此作废。
    pub fn begin_download(&mut self, from: &str, to: &str, trigger: Trigger, now: DateTime<Utc>) {
        self.attempt = Some(new_attempt(from, to, trigger, now));
    }

    /// 下完了（验签也过了），等换上。
    pub fn download_done(&mut self, bytes: u64, now: DateTime<Utc>) {
        if let Some(a) = self
            .attempt
            .as_mut()
            .filter(|a| a.state == AttemptState::Downloading)
        {
            a.state = AttemptState::Ready;
            a.download_ms = Some(millis_between(a.started_at, now));
            a.bytes = Some(bytes);
            a.ready_at = Some(now);
        }
    }

    /// 磁盘上存着的包验过了、直接用（不下载）：`attempt` 是 `ready`，
    /// `reused_package = true`。已经有同一版下好的那条（上次运行下的）就接着
    /// 用它，等待的时间从当时下好算起；别的（没有、别的版本）换成新的一条。
    pub fn package_reused(
        &mut self,
        from: &str,
        to: &str,
        trigger: Trigger,
        bytes: u64,
        now: DateTime<Utc>,
    ) {
        match self.attempt.as_mut() {
            Some(a) if a.to == to && a.state == AttemptState::Ready => {
                a.reused_package = true;
            }
            _ => {
                let mut a = new_attempt(from, to, trigger, now);
                a.state = AttemptState::Ready;
                a.bytes = Some(bytes);
                a.reused_package = true;
                a.ready_at = Some(now);
                self.attempt = Some(a);
            }
        }
    }

    /// 下载（或下载前的检查）失败了。`attempt` 清空；只有自动下载的才报，
    /// 而且 24 小时内最多报一条，用户手动点的界面上已经看得到。
    /// 还没查到要下哪一版就失败的，`to` 记 `unknown`。
    pub fn download_failed(
        &mut self,
        running: &str,
        trigger: Trigger,
        error: &str,
        now: DateTime<Utc>,
    ) -> Option<Outcome> {
        let attempt = match self.attempt.take() {
            Some(a) if a.state == AttemptState::Downloading => a,
            other => {
                // 不是正在下的那条（还没查到要下哪一版就失败了）：原样放回。
                self.attempt = other;
                new_attempt(running, "unknown", trigger, now)
            }
        };
        let mut outcome = Outcome::of(&attempt, UpdateResult::DownloadFailed, running, now)
            .with_error(ErrorKind::classify(error), Some(error));
        outcome.download_ms = Some(millis_between(attempt.started_at, now));
        if self.attempt.is_none() {
            self.finish(attempt.to.clone(), UpdateResult::DownloadFailed, now);
        }
        let due = self
            .last_download_failure_reported_at
            .is_none_or(|at| (now - at).num_seconds() >= DOWNLOAD_FAILURE_REPORT_EVERY_SECS);
        if attempt.trigger != Trigger::Auto || !due {
            return None;
        }
        self.last_download_failure_reported_at = Some(now);
        Some(outcome)
    }

    /// 开始换上。没有下好的那条（日志丢了）时什么都不记，返回 false。
    pub fn apply_started(&mut self, how: ApplyHow, now: DateTime<Utc>) -> bool {
        let Some(a) = self.attempt.as_mut() else {
            return false;
        };
        a.state = AttemptState::Applying;
        a.apply_how = Some(how);
        a.apply_started_at = Some(now);
        true
    }

    /// 启动时换上 `to`（磁盘上存着的包，第 4 行）：先记下这一版在启动时
    /// 试过了，再把 `attempt` 记成 `applying` / `launch`。日志里没有同一版
    /// 下好的那条（丢了）就照 [`Journal::package_reused`] 新开一条。
    pub fn launch_apply_started(&mut self, from: &str, to: &str, bytes: u64, now: DateTime<Utc>) {
        self.launch_apply_tried = Some(to.to_string());
        self.package_reused(from, to, Trigger::Auto, bytes, now);
        self.apply_started(ApplyHow::Launch, now);
    }

    /// 安装这一步做完了（还要等新版本启动后确认）。
    pub fn install_done(&mut self, now: DateTime<Utc>) {
        if let Some(a) = self
            .attempt
            .as_mut()
            .filter(|a| a.state == AttemptState::Applying)
        {
            a.install_ms = a.apply_started_at.map(|at| millis_between(at, now));
        }
    }

    /// 安装失败（插件报错）。
    pub fn install_failed(
        &mut self,
        running: &str,
        error: &str,
        now: DateTime<Utc>,
    ) -> Option<Outcome> {
        let mut attempt = self.attempt.take()?;
        attempt.install_ms = attempt.apply_started_at.map(|at| millis_between(at, now));
        let outcome = Outcome::of(&attempt, UpdateResult::InstallFailed, running, now)
            .with_error(ErrorKind::classify(error), Some(error));
        self.finish(attempt.to, UpdateResult::InstallFailed, now);
        Some(outcome)
    }

    /// 启动时：处于 `applying` 的，看换上没有。
    ///
    /// - 正在运行的是 `to`：`boots` 加 1，等确认；加到超过 [`MAX_BOOTS`]
    ///   （启动了 3 次都没确认）就是 `boot_unconfirmed`。
    /// - 正在运行的还是 `from`：包没换上，`install_failed` / `not_applied`。
    /// - 都不是（中间手动装了别的版本）：当没有。
    ///
    /// 在下载的中途退出了（`downloading`）：下了一半的包已经没了，当没有。
    pub fn on_boot(&mut self, running: &str, now: DateTime<Utc>) -> Option<Outcome> {
        let attempt = self.attempt.as_mut()?;
        match attempt.state {
            AttemptState::Applying if attempt.to == running => {
                attempt.boots += 1;
                if attempt.boots <= MAX_BOOTS {
                    return None;
                }
                attempt.boots = MAX_BOOTS;
                let attempt = self.attempt.take()?;
                let outcome = Outcome::of(&attempt, UpdateResult::BootUnconfirmed, running, now);
                self.finish(attempt.to, UpdateResult::BootUnconfirmed, now);
                Some(outcome)
            }
            AttemptState::Applying if attempt.from == running => {
                let attempt = self.attempt.take()?;
                let outcome = Outcome::of(&attempt, UpdateResult::InstallFailed, running, now)
                    .with_error(ErrorKind::NotApplied, None);
                self.finish(attempt.to, UpdateResult::InstallFailed, now);
                Some(outcome)
            }
            AttemptState::Applying | AttemptState::Downloading => {
                self.attempt = None;
                None
            }
            AttemptState::Ready => None,
        }
    }

    /// 这个进程是不是刚换上的新版本、还在等确认。
    pub fn awaiting_confirmation(&self, running: &str) -> bool {
        self.attempt
            .as_ref()
            .is_some_and(|a| a.state == AttemptState::Applying && a.to == running)
    }

    /// 启动确认：新版本跑起来了，结果 `applied`，等着提示「已更新到…」。
    pub fn confirm(&mut self, running: &str, now: DateTime<Utc>) -> Option<Outcome> {
        if !self.awaiting_confirmation(running) {
            return None;
        }
        let attempt = self.attempt.take()?;
        let outcome = Outcome::of(&attempt, UpdateResult::Applied, running, now);
        self.finish(attempt.to, UpdateResult::Applied, now);
        Some(outcome)
    }

    /// 每分钟一次：下好了超过 72 小时还没换上、又没报过，报一条
    /// `waiting_long`，`attempt` 继续。
    pub fn check_waiting_long(&mut self, running: &str, now: DateTime<Utc>) -> Option<Outcome> {
        let attempt = self.attempt.as_mut()?;
        let ready_at = attempt.ready_at?;
        if attempt.state != AttemptState::Ready
            || attempt.waiting_long_reported
            || (now - ready_at).num_seconds() < WAITING_LONG_SECS
        {
            return None;
        }
        attempt.waiting_long_reported = true;
        Some(Outcome::of(
            attempt,
            UpdateResult::WaitingLong,
            running,
            now,
        ))
    }
}

impl Journal {
    /// 等空闲时被 `reason` 挡了一次：记在下好了、等换上的那条上。
    pub fn note_blocked(&mut self, reason: BlockReason) {
        if let Some(a) = self
            .attempt
            .as_mut()
            .filter(|a| a.state == AttemptState::Ready)
        {
            a.blocked.add(reason);
        }
    }

    /// `version` 空闲时自动重启试过几次。
    pub fn idle_tries(&self, version: &str) -> u32 {
        self.idle_apply
            .as_ref()
            .filter(|tried| tried.version == version)
            .map_or(0, |tried| tried.tries)
    }

    /// 空闲时自动重启 `version` 又试了一次（开始安装之前记）。
    pub fn note_idle_try(&mut self, version: &str) {
        let tries = self.idle_tries(version).saturating_add(1);
        self.idle_apply = Some(IdleApply {
            version: version.to_string(),
            tries,
        });
    }

    /// 「已更新到…」：上一次是换上了、还没提示过的，而且换上的就是正在运行
    /// 的版本，置成提示过并回它的版本；别的都是 `None`。只看正在运行的版本：
    /// 上一次换上的还没提示过、这次又换了新版但没确认下来时，`last` 还是
    /// 上一次的，不能当成这次的结果提示。调用方在一次加锁里读、改、写，几个
    /// 窗口同时问只有一个拿到。
    pub fn take_announcement(&mut self, running: &str) -> Option<Announcement> {
        let last = self.last.as_mut().filter(|last| {
            last.result == UpdateResult::Applied && !last.announced && last.to == running
        })?;
        last.announced = true;
        Some(Announcement {
            version: last.to.clone(),
        })
    }
}

/// 状态变化的那行日志（`commands::app_update` 每次状态变化都打）。
pub fn transition_line(from: &str, to: &str, version: Option<&str>) -> String {
    format!("[update] {from} -> {to} version={}", version.unwrap_or("-"))
}

/// `<数据目录>/update/journal.json`。
pub fn path(data_dir: &Path) -> PathBuf {
    data_dir.join(DIR_NAME).join(FILE_NAME)
}

/// 读日志：没有、坏了都当空的，再按正在运行的版本过一遍（[`Journal::sanitize`]）。
pub fn load(path: &Path, running: &str) -> Journal {
    let mut journal: Journal = std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    journal.sanitize(running);
    journal
}

/// 启动时换上之前，把「这一版在启动时试过了、正在换上」写进日志文件
/// （[`Journal::launch_apply_started`]），并读回来确认真的写进去了。
/// 写不进去（数据目录只读、磁盘满）就回错：调用方不换，不然换失败了
/// 每次启动都会再试，换成功了新版本也没有这一条可确认、可上报。
pub fn record_launch_apply(
    path: &Path,
    running: &str,
    to: &str,
    bytes: u64,
    now: DateTime<Utc>,
) -> io::Result<()> {
    let mut journal = load(path, running);
    journal.launch_apply_started(running, to, bytes, now);
    save(path, &journal)?;
    let back = load(path, running);
    if back.launch_apply_tried.as_deref() != Some(to) || back.attempt != journal.attempt {
        return Err(io::Error::other(
            "the update journal did not keep the record",
        ));
    }
    Ok(())
}

/// 「已更新到…」从文件里拿：读、置成提示过、写回，写回成功才回版本。日志
/// 读得出、写不进去时回 `None`：不然这次提示了，文件里却还是「没提示过」，
/// 别的窗口、下次启动会再提示一遍。调用方在一次加锁里调它。
pub fn take_announcement_at(path: &Path, running: &str) -> Option<Announcement> {
    let mut journal = load(path, running);
    let announcement = journal.take_announcement(running)?;
    save(path, &journal).ok()?;
    Some(announcement)
}

/// 启动确认有了结果（确认了、没确认、或者这次不用确认）就放行的闸。
/// 「已更新到…」要等它：新版本启动后要等本机服务起来再跑满
/// [`CONFIRM_AFTER_SECS`] 才确认，之前 `last` 还是上一次的结果，早问了
/// 就拿不到这次的提示。
#[derive(Debug, Default)]
pub struct ConfirmGate {
    settled: std::sync::Mutex<bool>,
    cv: std::sync::Condvar,
}

impl ConfirmGate {
    pub const fn new() -> Self {
        Self {
            settled: std::sync::Mutex::new(false),
            cv: std::sync::Condvar::new(),
        }
    }

    /// 启动确认结束了（不管确认没确认）。
    pub fn settle(&self) {
        *self.settled.lock().unwrap_or_else(|p| p.into_inner()) = true;
        self.cv.notify_all();
    }

    /// 等到放行，最多等 `wait`；放行了回 true。
    pub fn wait(&self, wait: std::time::Duration) -> bool {
        let settled = self.settled.lock().unwrap_or_else(|p| p.into_inner());
        let (settled, _) = self
            .cv
            .wait_timeout_while(settled, wait, |settled| !*settled)
            .unwrap_or_else(|p| p.into_inner());
        *settled
    }
}

/// 「已更新到…」：这次启动还在等启动确认（正在换上的就是正在运行的
/// 版本）时，先等 `gate` 放行（最多 `wait`），再在 `lock` 下照
/// [`take_announcement_at`] 拿。等的时候不占着 `lock`，确认要写日志。
pub fn take_announcement_once_confirmed(
    path: &Path,
    running: &str,
    lock: &std::sync::Mutex<()>,
    gate: &ConfirmGate,
    wait: std::time::Duration,
) -> Option<Announcement> {
    let awaiting = {
        let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
        load(path, running).awaiting_confirmation(running)
    };
    if awaiting {
        gate.wait(wait);
    }
    let _guard = lock.lock().unwrap_or_else(|p| p.into_inner());
    take_announcement_at(path, running)
}

/// 写日志：先写临时文件再改名，读的人不会看到写了一半的。
pub fn save(path: &Path, journal: &Journal) -> io::Result<()> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let bytes = serde_json::to_vec_pretty(journal).map_err(io::Error::other)?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(secs: i64) -> DateTime<Utc> {
        DateTime::from_timestamp(1_763_000_000 + secs, 0).unwrap()
    }

    /// 1.6.40 → 1.6.41，已经下好。
    fn ready(trigger: Trigger) -> Journal {
        let mut j = Journal::default();
        j.begin_download("1.6.40", "1.6.41", trigger, at(0));
        j.download_done(140_512_345, at(41));
        j
    }

    #[test]
    fn a_whole_update_ends_applied_and_waits_to_be_announced() {
        let mut j = ready(Trigger::Auto);
        let a = j.attempt.clone().unwrap();
        assert_eq!(a.state, AttemptState::Ready);
        assert_eq!(a.download_ms, Some(41_000));
        assert_eq!(a.bytes, Some(140_512_345));
        assert_eq!(a.ready_at, Some(at(41)));

        assert!(j.apply_started(ApplyHow::Idle, at(100)));
        j.install_done(at(105));
        let a = j.attempt.clone().unwrap();
        assert_eq!(a.state, AttemptState::Applying);
        assert_eq!(a.apply_how, Some(ApplyHow::Idle));
        assert_eq!(a.install_ms, Some(5_000));

        // 新版本启动了。
        assert_eq!(j.on_boot("1.6.41", at(110)), None);
        assert_eq!(j.attempt.as_ref().unwrap().boots, 1);
        assert!(j.awaiting_confirmation("1.6.41"));
        assert!(!j.awaiting_confirmation("1.6.40"));

        let o = j.confirm("1.6.41", at(170)).unwrap();
        assert_eq!(o.result, UpdateResult::Applied);
        assert_eq!(o.release_version(), "1.6.41");
        assert_eq!(o.how, Some(ApplyHow::Idle));
        assert_eq!(o.trigger, Trigger::Auto);
        assert_eq!(o.wait_ms, Some(59_000));
        assert_eq!(o.install_ms, Some(5_000));
        assert_eq!(o.boot_ms, Some(70_000));
        assert_eq!(o.boots, 1);
        assert_eq!(o.error_kind, None);
        assert!(j.attempt.is_none());
        let last = j.last.clone().unwrap();
        assert_eq!(last.to, "1.6.41");
        assert_eq!(last.result, UpdateResult::Applied);
        assert!(!last.announced);
        // 确认只有一次。
        assert_eq!(j.confirm("1.6.41", at(200)), None);
    }

    #[test]
    fn each_way_of_applying_is_recorded() {
        for how in [ApplyHow::Idle, ApplyHow::Click, ApplyHow::Launch] {
            let mut j = ready(Trigger::Manual);
            j.apply_started(how, at(100));
            j.on_boot("1.6.41", at(110));
            assert_eq!(j.confirm("1.6.41", at(170)).unwrap().how, Some(how));
        }
    }

    #[test]
    fn a_reused_package_is_ready_without_a_download() {
        // 上次运行下好的同一版：接着用那一条，等待从当时算起。
        let mut j = ready(Trigger::Manual);
        j.package_reused("1.6.40", "1.6.41", Trigger::Auto, 140_512_345, at(5_000));
        let a = j.attempt.clone().unwrap();
        assert_eq!(a.state, AttemptState::Ready);
        assert!(a.reused_package);
        assert_eq!(a.trigger, Trigger::Manual);
        assert_eq!(a.ready_at, Some(at(41)));
        assert_eq!(a.download_ms, Some(41_000));

        // 日志里没有（或是别的版本）：新开一条，没有下载时间。
        let mut j = Journal::default();
        j.package_reused("1.6.40", "1.6.41", Trigger::Auto, 7, at(100));
        let a = j.attempt.clone().unwrap();
        assert_eq!(
            (a.from.as_str(), a.to.as_str(), a.state),
            ("1.6.40", "1.6.41", AttemptState::Ready)
        );
        assert!(a.reused_package);
        assert_eq!(
            (a.bytes, a.download_ms, a.ready_at),
            (Some(7), None, Some(at(100)))
        );
        let mut other = ready(Trigger::Auto);
        other.package_reused("1.6.40", "1.6.42", Trigger::Manual, 7, at(100));
        let a = other.attempt.unwrap();
        assert_eq!((a.to.as_str(), a.trigger), ("1.6.42", Trigger::Manual));

        // 换上、确认以后照样是 applied，上报里带着 reused_package。
        j.apply_started(ApplyHow::Launch, at(200));
        j.install_done(at(205));
        j.on_boot("1.6.41", at(210));
        let outcome = j.confirm("1.6.41", at(300)).unwrap();
        assert_eq!(outcome.result, UpdateResult::Applied);
        assert!(outcome.reused_package);
    }

    #[test]
    fn a_launch_apply_is_tried_once_per_version_and_recorded_as_launch() {
        // 上次运行下好、存着的那一版：接着用那一条。
        let mut j = ready(Trigger::Auto);
        j.launch_apply_started("1.6.40", "1.6.41", 140_512_345, at(5_000));
        assert_eq!(j.launch_apply_tried.as_deref(), Some("1.6.41"));
        let a = j.attempt.clone().unwrap();
        assert_eq!(a.state, AttemptState::Applying);
        assert_eq!(a.apply_how, Some(ApplyHow::Launch));
        assert_eq!(a.apply_started_at, Some(at(5_000)));
        assert_eq!(a.ready_at, Some(at(41)));
        assert!(a.reused_package);

        // 换失败了：attempt 清空，「试过」留着，下次启动不再试这一版。
        let o = j.install_failed("1.6.40", "x", at(5_003)).unwrap();
        assert_eq!(o.how, Some(ApplyHow::Launch));
        assert_eq!(j.launch_apply_tried.as_deref(), Some("1.6.41"));

        // 日志里没有那一条（丢了）：新开一条，照样记成启动时换上。
        let mut j = Journal::default();
        j.launch_apply_started("1.6.40", "1.6.41", 7, at(100));
        let a = j.attempt.clone().unwrap();
        assert_eq!(
            (a.from.as_str(), a.to.as_str(), a.state, a.apply_how),
            (
                "1.6.40",
                "1.6.41",
                AttemptState::Applying,
                Some(ApplyHow::Launch)
            )
        );
        // 新版本起来以后照常确认。
        j.install_done(at(103));
        assert_eq!(j.on_boot("1.6.41", at(110)), None);
        let o = j.confirm("1.6.41", at(170)).unwrap();
        assert_eq!(o.result, UpdateResult::Applied);
        assert_eq!(o.how, Some(ApplyHow::Launch));

        // 存进文件、读回来还在；老文件没有这一项也读得出来。
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &j).unwrap();
        assert_eq!(
            load(&file, "1.6.41").launch_apply_tried.as_deref(),
            Some("1.6.41")
        );
        std::fs::write(&file, br#"{"attempt": null, "last": null}"#).unwrap();
        assert_eq!(load(&file, "1.6.41").launch_apply_tried, None);
    }

    #[test]
    fn a_launch_apply_is_recorded_on_disk_or_reported_as_not() {
        // 写得进去：文件里有「试过」和 applying / launch。
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &ready(Trigger::Auto)).unwrap();
        record_launch_apply(&file, "1.6.40", "1.6.41", 140_512_345, at(5_000)).unwrap();
        let j = load(&file, "1.6.40");
        assert_eq!(j.launch_apply_tried.as_deref(), Some("1.6.41"));
        let a = j.attempt.unwrap();
        assert_eq!(
            (a.state, a.apply_how),
            (AttemptState::Applying, Some(ApplyHow::Launch))
        );

        // 写不进去（日志该在的目录其实是个文件）：回错，不能当作记下了。
        let blocked = dir.path().join("not-a-dir");
        std::fs::write(&blocked, b"x").unwrap();
        let file = path(&blocked);
        assert!(record_launch_apply(&file, "1.6.40", "1.6.41", 7, at(100)).is_err());
    }

    #[test]
    fn a_failed_download_clears_the_attempt() {
        let mut j = Journal::default();
        j.begin_download("1.6.40", "1.6.41", Trigger::Auto, at(0));
        let o = j
            .download_failed(
                "1.6.40",
                Trigger::Auto,
                "error sending request for url",
                at(5),
            )
            .unwrap();
        assert_eq!(o.result, UpdateResult::DownloadFailed);
        assert_eq!(o.error_kind, Some(ErrorKind::Network));
        assert_eq!(o.release_version(), "1.6.40");
        assert_eq!(o.to, "1.6.41");
        assert_eq!(o.download_ms, Some(5_000));
        assert!(j.attempt.is_none());
        assert_eq!(
            j.last.as_ref().unwrap().result,
            UpdateResult::DownloadFailed
        );
        assert!(j.last.as_ref().unwrap().announced);
    }

    #[test]
    fn download_failures_are_reported_for_automatic_downloads_once_a_day() {
        let mut j = Journal::default();
        j.begin_download("1.6.40", "1.6.41", Trigger::Auto, at(0));
        assert!(j
            .download_failed("1.6.40", Trigger::Auto, "x", at(10))
            .is_some());
        assert_eq!(j.last_download_failure_reported_at, Some(at(10)));

        // 23 小时后又失败：不报。
        j.begin_download("1.6.40", "1.6.41", Trigger::Auto, at(23 * 3600));
        assert!(j
            .download_failed("1.6.40", Trigger::Auto, "x", at(23 * 3600 + 10))
            .is_none());
        assert!(j.attempt.is_none());
        assert_eq!(j.last_download_failure_reported_at, Some(at(10)));

        // 满 24 小时：再报一条。
        j.begin_download("1.6.40", "1.6.41", Trigger::Auto, at(24 * 3600));
        assert!(j
            .download_failed("1.6.40", Trigger::Auto, "x", at(24 * 3600 + 10))
            .is_some());

        // 用户点的、回退的：不报，也不占这 24 小时。
        let mut j = Journal::default();
        for trigger in [Trigger::Manual, Trigger::Rollback] {
            j.begin_download("1.6.40", "1.6.41", trigger, at(0));
            assert!(j.download_failed("1.6.40", trigger, "x", at(10)).is_none());
            assert!(j.attempt.is_none());
        }
        assert_eq!(j.last_download_failure_reported_at, None);
    }

    #[test]
    fn a_check_that_fails_before_the_download_is_reported_without_a_version() {
        let mut j = Journal::default();
        let o = j
            .download_failed("1.6.40", Trigger::Auto, "Update check timed out", at(0))
            .unwrap();
        assert_eq!(o.to, "unknown");
        assert_eq!(o.from, "1.6.40");
        assert_eq!(o.error_kind, Some(ErrorKind::Network));
        assert!(j
            .download_failed("1.6.40", Trigger::Manual, "x", at(0))
            .is_none());
    }

    #[test]
    fn a_failed_install_clears_the_attempt() {
        let mut j = ready(Trigger::Manual);
        j.apply_started(ApplyHow::Click, at(100));
        let o = j
            .install_failed("1.6.40", "Permission denied (os error 13)", at(103))
            .unwrap();
        assert_eq!(o.result, UpdateResult::InstallFailed);
        assert_eq!(o.error_kind, Some(ErrorKind::PermissionDenied));
        assert_eq!(o.install_ms, Some(3_000));
        assert_eq!(o.how, Some(ApplyHow::Click));
        assert_eq!(o.release_version(), "1.6.40");
        assert!(j.attempt.is_none());
        assert_eq!(j.last.as_ref().unwrap().result, UpdateResult::InstallFailed);
        // 没有在换的：什么都不记。
        assert_eq!(j.install_failed("1.6.40", "x", at(110)), None);
    }

    #[test]
    fn a_boot_into_the_old_version_means_the_package_was_not_applied() {
        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Click, at(100));
        let o = j.on_boot("1.6.40", at(120)).unwrap();
        assert_eq!(o.result, UpdateResult::InstallFailed);
        assert_eq!(o.error_kind, Some(ErrorKind::NotApplied));
        assert_eq!(o.error, None);
        assert!(j.attempt.is_none());
    }

    #[test]
    fn three_boots_without_a_confirmation_are_reported() {
        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Idle, at(100));
        for boot in 1..=MAX_BOOTS {
            assert_eq!(j.on_boot("1.6.41", at(100 + i64::from(boot))), None);
            assert_eq!(j.attempt.as_ref().unwrap().boots, boot);
        }
        let o = j.on_boot("1.6.41", at(200)).unwrap();
        assert_eq!(o.result, UpdateResult::BootUnconfirmed);
        assert_eq!(o.boots, MAX_BOOTS);
        assert_eq!(o.release_version(), "1.6.41");
        assert!(j.attempt.is_none());
        assert_eq!(
            j.last.as_ref().unwrap().result,
            UpdateResult::BootUnconfirmed
        );
    }

    #[test]
    fn a_boot_leaves_a_ready_attempt_and_drops_a_half_download() {
        let mut j = ready(Trigger::Auto);
        assert_eq!(j.on_boot("1.6.40", at(100)), None);
        assert_eq!(j.attempt.as_ref().unwrap().state, AttemptState::Ready);

        let mut j = Journal::default();
        j.begin_download("1.6.40", "1.6.41", Trigger::Auto, at(0));
        assert_eq!(j.on_boot("1.6.40", at(100)), None);
        assert!(j.attempt.is_none());
    }

    #[test]
    fn waiting_long_is_reported_once_and_the_attempt_goes_on() {
        let mut j = ready(Trigger::Auto);
        assert_eq!(
            j.check_waiting_long("1.6.40", at(41 + WAITING_LONG_SECS - 1)),
            None
        );
        let o = j
            .check_waiting_long("1.6.40", at(41 + WAITING_LONG_SECS))
            .unwrap();
        assert_eq!(o.result, UpdateResult::WaitingLong);
        assert_eq!(o.wait_ms, Some(WAITING_LONG_SECS as u64 * 1000));
        assert_eq!(o.release_version(), "1.6.40");
        let a = j.attempt.as_ref().unwrap();
        assert!(a.waiting_long_reported);
        assert_eq!(a.state, AttemptState::Ready);
        assert_eq!(
            j.check_waiting_long("1.6.40", at(41 + 2 * WAITING_LONG_SECS)),
            None
        );
        // 还在下的、已经在换的：不算。
        let mut j = Journal::default();
        j.begin_download("1.6.40", "1.6.41", Trigger::Auto, at(0));
        assert_eq!(
            j.check_waiting_long("1.6.40", at(10 * WAITING_LONG_SECS)),
            None
        );
    }

    #[test]
    fn a_stale_attempt_is_dropped_on_load_unless_it_is_applying() {
        let mut j = ready(Trigger::Auto);
        j.sanitize("1.6.40");
        assert!(j.attempt.is_some());
        j.sanitize("1.6.39");
        assert!(j.attempt.is_none());

        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Click, at(100));
        j.sanitize("1.6.41");
        assert!(j.attempt.is_some());
    }

    #[test]
    fn the_file_round_trips_and_a_broken_one_counts_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        assert!(file.ends_with("update/journal.json"));
        assert_eq!(load(&file, "1.6.40"), Journal::default());

        let j = ready(Trigger::Auto);
        save(&file, &j).unwrap();
        assert_eq!(load(&file, "1.6.40"), j);
        // 字段名和 issue 里写的格式对得上。
        let raw: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
        assert_eq!(raw["attempt"]["state"], "ready");
        assert_eq!(raw["attempt"]["trigger"], "auto");
        assert_eq!(raw["attempt"]["blocked"]["lent_device"], 0);
        assert!(raw["attempt"]["apply_how"].is_null());
        assert!(raw["last_download_failure_reported_at"].is_null());

        std::fs::write(&file, b"{not json").unwrap();
        assert_eq!(load(&file, "1.6.40"), Journal::default());
    }

    #[test]
    fn errors_are_sorted_into_kinds() {
        let cases = [
            (
                "Could not fetch a valid release JSON from the remote",
                ErrorKind::SourceUnreachable,
            ),
            (
                "error sending request for url (https://example.com/a.tar.gz)",
                ErrorKind::Network,
            ),
            ("Update check timed out", ErrorKind::Network),
            ("signature verification failed", ErrorKind::Signature),
            ("No space left on device (os error 28)", ErrorKind::Disk),
            (
                "Operation not permitted (os error 1)",
                ErrorKind::PermissionDenied,
            ),
            (
                "update target is not writable: /Applications",
                ErrorKind::PermissionDenied,
            ),
            ("something else", ErrorKind::Unknown),
        ];
        for (message, kind) in cases {
            assert_eq!(ErrorKind::classify(message), kind, "{message}");
        }
    }

    #[test]
    fn the_trigger_param_only_counts_auto_as_automatic() {
        assert_eq!(Trigger::from_param(Some("auto")), Trigger::Auto);
        assert_eq!(Trigger::from_param(Some("manual")), Trigger::Manual);
        assert_eq!(Trigger::from_param(Some("rollback")), Trigger::Manual);
        assert_eq!(Trigger::from_param(None), Trigger::Manual);
    }

    #[test]
    fn an_applied_update_is_announced_once() {
        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Idle, at(100));
        j.on_boot("1.6.41", at(110));
        j.confirm("1.6.41", at(170)).unwrap();
        assert_eq!(
            j.take_announcement("1.6.41"),
            Some(Announcement {
                version: "1.6.41".to_string()
            })
        );
        assert!(j.last.as_ref().unwrap().announced);
        assert_eq!(j.take_announcement("1.6.41"), None);
        // 回给窗口的格式：`{"version": "1.6.41"}`。
        assert_eq!(
            serde_json::to_value(Announcement {
                version: "1.6.41".to_string()
            })
            .unwrap(),
            serde_json::json!({"version": "1.6.41"})
        );
    }

    #[test]
    fn an_announcement_asked_before_the_confirmation_waits_for_it() {
        // 新版本刚起来：还在等启动确认，窗口几秒后就来问。
        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Idle, at(100));
        j.on_boot("1.6.41", at(110));
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &j).unwrap();
        let lock = std::sync::Mutex::new(());
        let gate = ConfirmGate::new();

        let got = std::thread::scope(|s| {
            s.spawn(|| {
                std::thread::sleep(std::time::Duration::from_millis(200));
                let _guard = lock.lock().unwrap();
                let mut j = load(&file, "1.6.41");
                j.confirm("1.6.41", at(170)).unwrap();
                save(&file, &j).unwrap();
                drop(_guard);
                gate.settle();
            });
            take_announcement_once_confirmed(
                &file,
                "1.6.41",
                &lock,
                &gate,
                std::time::Duration::from_secs(30),
            )
        });
        assert_eq!(
            got,
            Some(Announcement {
                version: "1.6.41".to_string()
            })
        );
        assert!(load(&file, "1.6.41").last.unwrap().announced);
    }

    #[test]
    fn an_announcement_does_not_wait_forever_or_when_nothing_is_awaited() {
        let lock = std::sync::Mutex::new(());
        // 一直没确认：等到头回 None，日志里还在等。
        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Idle, at(100));
        j.on_boot("1.6.41", at(110));
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &j).unwrap();
        let gate = ConfirmGate::new();
        let wait = std::time::Duration::from_millis(100);
        assert_eq!(
            take_announcement_once_confirmed(&file, "1.6.41", &lock, &gate, wait),
            None
        );
        assert!(!gate.wait(std::time::Duration::ZERO));
        assert!(load(&file, "1.6.41").awaiting_confirmation("1.6.41"));

        // 早就确认过了（这次启动不用确认）：不等闸，直接拿。
        let mut j = load(&file, "1.6.41");
        j.confirm("1.6.41", at(170)).unwrap();
        save(&file, &j).unwrap();
        let started = std::time::Instant::now();
        assert_eq!(
            take_announcement_once_confirmed(
                &file,
                "1.6.41",
                &lock,
                &gate,
                std::time::Duration::from_secs(30),
            ),
            Some(Announcement {
                version: "1.6.41".to_string()
            })
        );
        assert!(started.elapsed() < std::time::Duration::from_secs(5));

        // 放行以后再等立刻回 true。
        gate.settle();
        assert!(gate.wait(std::time::Duration::from_secs(30)));
    }

    #[test]
    fn an_earlier_update_is_not_announced_by_a_version_that_was_not_confirmed() {
        // 上一次换上的 1.6.40 还没提示过，这次换上 1.6.41 以后本机服务没起来，
        // 确认放弃了（闸放行了、日志里还在等）：不能把 1.6.40 当成这次的结果提示。
        let mut j = ready(Trigger::Auto);
        j.last = Some(Last {
            to: "1.6.40".to_string(),
            result: UpdateResult::Applied,
            finished_at: at(0),
            announced: false,
        });
        j.apply_started(ApplyHow::Idle, at(100));
        j.on_boot("1.6.41", at(110));
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &j).unwrap();
        let lock = std::sync::Mutex::new(());
        let gate = ConfirmGate::new();
        gate.settle();
        assert_eq!(
            take_announcement_once_confirmed(
                &file,
                "1.6.41",
                &lock,
                &gate,
                std::time::Duration::from_secs(30),
            ),
            None
        );
        assert_eq!(take_announcement_at(&file, "1.6.41"), None);

        // 还在跑 1.6.40（新版没换上过）时，它自己的那次照常提示。
        let mut j = Journal {
            last: j.last.clone(),
            ..Default::default()
        };
        assert_eq!(j.take_announcement("1.6.41"), None);
        assert_eq!(
            j.take_announcement("1.6.40"),
            Some(Announcement {
                version: "1.6.40".to_string()
            })
        );
    }

    #[test]
    fn an_announcement_that_cannot_be_saved_is_not_handed_out() {
        let mut j = ready(Trigger::Auto);
        j.apply_started(ApplyHow::Idle, at(100));
        j.on_boot("1.6.41", at(110));
        j.confirm("1.6.41", at(170)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &j).unwrap();

        // 读得出、写不进去（临时文件的位置被一个目录占着）：不提示，文件里
        // 还是没提示过。
        let tmp = file.with_extension("json.tmp");
        std::fs::create_dir(&tmp).unwrap();
        assert_eq!(take_announcement_at(&file, "1.6.41"), None);
        assert!(!load(&file, "1.6.41").last.unwrap().announced);

        // 写得进去了：提示一次，第二次没有。
        std::fs::remove_dir(&tmp).unwrap();
        assert_eq!(
            take_announcement_at(&file, "1.6.41"),
            Some(Announcement {
                version: "1.6.41".to_string()
            })
        );
        assert_eq!(take_announcement_at(&file, "1.6.41"), None);
    }

    #[test]
    fn other_outcomes_are_never_announced() {
        assert_eq!(Journal::default().take_announcement("1.6.41"), None);
        for result in [
            UpdateResult::DownloadFailed,
            UpdateResult::InstallFailed,
            UpdateResult::BootUnconfirmed,
            UpdateResult::WaitingLong,
        ] {
            let mut j = Journal {
                last: Some(Last {
                    to: "1.6.41".to_string(),
                    result,
                    finished_at: at(0),
                    // 就算没标成提示过，也不提示。
                    announced: false,
                }),
                ..Default::default()
            };
            assert_eq!(j.take_announcement("1.6.41"), None, "{result:?}");
            assert_eq!(j.take_announcement("1.6.41"), None, "{result:?}");
        }
    }

    #[test]
    fn blocked_checks_are_counted_on_the_ready_attempt() {
        let mut j = ready(Trigger::Auto);
        j.note_blocked(BlockReason::LocalTurn);
        j.note_blocked(BlockReason::LocalTurn);
        j.note_blocked(BlockReason::Terminal);
        j.note_blocked(BlockReason::LentDevice);
        j.note_blocked(BlockReason::UserActive);
        j.note_blocked(BlockReason::Unknown);
        assert_eq!(
            j.attempt.as_ref().unwrap().blocked,
            Blocked {
                local_turn: 2,
                terminal: 1,
                lent_device: 1,
                user_active: 1,
                unknown: 1,
            }
        );
        // 上报时带着。
        j.apply_started(ApplyHow::Idle, at(100));
        j.on_boot("1.6.41", at(110));
        assert_eq!(j.confirm("1.6.41", at(170)).unwrap().blocked.local_turn, 2);

        // 没有下好的那条：不记。
        let mut j = Journal::default();
        j.note_blocked(BlockReason::Terminal);
        assert_eq!(j, Journal::default());
    }

    #[test]
    fn idle_restarts_are_counted_per_version() {
        let mut j = Journal::default();
        assert_eq!(j.idle_tries("1.6.41"), 0);
        j.note_idle_try("1.6.41");
        assert_eq!(j.idle_tries("1.6.41"), 1);
        j.note_idle_try("1.6.41");
        assert_eq!(j.idle_tries("1.6.41"), 2);
        assert_eq!(j.idle_tries("1.6.42"), 0);
        // 换了一版从头数。
        j.note_idle_try("1.6.42");
        assert_eq!(j.idle_tries("1.6.42"), 1);
        assert_eq!(j.idle_tries("1.6.41"), 0);

        // 存进文件、读回来还在；老文件没有这一项也读得出来。
        let dir = tempfile::tempdir().unwrap();
        let file = path(dir.path());
        save(&file, &j).unwrap();
        assert_eq!(load(&file, "1.6.40").idle_tries("1.6.42"), 1);
        std::fs::write(&file, br#"{"attempt": null}"#).unwrap();
        assert_eq!(load(&file, "1.6.40").idle_apply, None);
    }

    #[test]
    fn transitions_are_logged_in_one_line() {
        assert_eq!(
            transition_line("idle", "downloading", None),
            "[update] idle -> downloading version=-"
        );
        assert_eq!(
            transition_line("downloading", "ready_to_restart", Some("1.6.41")),
            "[update] downloading -> ready_to_restart version=1.6.41"
        );
    }
}
