//! Cowork 加的：服务器模式下数据目录里的 `live-state.json`，给 CoTeam 的团队视图用。
//!
//! CoTeam 的收集服务只读数据目录（`codeg.db` 旁边）里的文件，不来问这个进程。库里的
//! `status` 只有「一轮开始了」「一轮做完了」，看不出一轮停在用户身上（权限请求、提问、
//! 计划审批），所以这里把内存里的实时状态写成一个小文件：
//!
//! ```json
//! {"version":1,"updated_at":"…","running":[3,7],
//!  "awaiting":{"7":{"reason":"permission","since":"…","title":"Run ls","via_child":false}}}
//! ```
//!
//! - `running`：有一轮在跑的对话，和空闲重启的忙碌判断一样（`ConnectionManager::busy_reason`
//!   的回合那一条）。
//! - `awaiting`：和侧栏「等你回答」、列表行 `awaiting` 同一份判断
//!   （[`ConnectionManager::awaiting_by_conversation`] / [`super::awaiting::derive`]），
//!   另外带一个给人看的 `title`（原样，打码由 CoTeam 做）。
//!
//! 启动时立刻写一次空的（盖掉上次留下的），之后每 [`TICK`] 算一次，内容变了就写，
//! 没变也至少每 [`REFRESH_SECS`] 秒写一次刷新 `updated_at`（CoTeam 认为 180 秒没更新的
//! 文件过时），正常退出时写一次空的。几个服务器共用一个数据目录时，各自的那一份放在
//! [`PARTS_DIR`] 里，`live-state.json` 写的是合起来的（[`Publisher`]），退出时只撤掉自己的。只在服务器模式写，桌面版自己的 daemon 不写
//! （[`enabled_for`]）。不改库、不改 `status`、不发任何事件；写失败只记警告。

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::awaiting::{AwaitingReason, BlockingPrompt, ConversationAwaiting};
use super::manager::ConnectionManager;
use super::session_state::SessionState;

/// 数据目录里的文件名。
pub const FILE_NAME: &str = "live-state.json";
/// 文件格式的版本。
pub const VERSION: u32 = 1;
/// 多久算一次。
pub const TICK: Duration = Duration::from_secs(2);
/// 内容没变时最多隔多久重写一次（刷新 `updated_at`）。
pub const REFRESH_SECS: i64 = 60;
/// `title` 最多多少个字符。
pub const TITLE_MAX_CHARS: usize = 200;

/// 写进文件的整个对象。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveState {
    pub version: u32,
    pub updated_at: DateTime<Utc>,
    pub running: Vec<i32>,
    /// 键是对话 id 的十进制字符串。
    pub awaiting: BTreeMap<String, LiveAwaiting>,
}

/// `awaiting` 里的一项。
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LiveAwaiting {
    pub reason: AwaitingReason,
    pub since: DateTime<Utc>,
    /// 在等什么：权限请求是工具调用的标题，提问是第一个问题，计划审批是 `null`。
    pub title: Option<String>,
    pub via_child: bool,
}

/// 文件里除了 `version`、`updated_at` 以外的内容，用来比较变没变。
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LiveContent {
    pub running: Vec<i32>,
    pub awaiting: BTreeMap<String, LiveAwaiting>,
}

impl LiveContent {
    /// 从 [`ConnectionManager::running_conversations`] 和
    /// [`ConnectionManager::awaiting_titled_by_conversation`] 的结果拼出来。
    pub fn from_parts(
        running: Vec<i32>,
        awaiting: impl IntoIterator<Item = (i32, (ConversationAwaiting, Option<String>))>,
    ) -> Self {
        let mut running = running;
        running.sort_unstable();
        running.dedup();
        let awaiting = awaiting
            .into_iter()
            .map(|(id, (awaiting, title))| {
                let entry = LiveAwaiting {
                    reason: awaiting.reason,
                    since: awaiting.since,
                    title,
                    via_child: awaiting.via_child,
                };
                (id.to_string(), entry)
            })
            .collect();
        Self { running, awaiting }
    }

    /// 盖上写文件的时间。
    pub fn stamp(&self, now: DateTime<Utc>) -> LiveState {
        LiveState {
            version: VERSION,
            updated_at: now,
            running: self.running.clone(),
            awaiting: self.awaiting.clone(),
        }
    }
}

/// 现在这一刻的内容。连接表的读法和 `awaiting_by_conversation` 一样（只读、只看最新连接）。
pub async fn snapshot(manager: &ConnectionManager) -> LiveContent {
    LiveContent::from_parts(
        manager.running_conversations().await,
        manager.awaiting_titled_by_conversation().await,
    )
}

/// 这个提示给人看的标题。计划审批（包括其实是计划审批的权限请求）没有标题，调用的人
/// 按 `reason` 自己跳过。
pub(crate) fn prompt_title(state: &SessionState) -> Option<String> {
    let raw = match super::awaiting::blocking_prompt(state)? {
        BlockingPrompt::Permission(permission) => {
            tool_call_title(&permission.tool_call).or_else(|| {
                // 请求里没写标题的，用会话里记着的这条工具调用的标题。
                state
                    .active_tool_calls
                    .get(&permission.tool_call_id)
                    .map(|live| live.label.clone())
            })?
        }
        BlockingPrompt::Question(question) => question.questions.first()?.question.clone(),
        BlockingPrompt::Plan(_) => return None,
    };
    clean_title(&raw)
}

/// 权限请求的工具调用里的 `title`（请求里可能是对象，也可能是 JSON 字符串）。
fn tool_call_title(tool_call: &Value) -> Option<String> {
    let parsed;
    let call = match tool_call {
        Value::String(text) => {
            parsed = serde_json::from_str::<Value>(text).ok();
            parsed.as_ref()?
        }
        other => other,
    };
    call.get("title")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// 去掉首尾空白，换行换成空格，超过 [`TITLE_MAX_CHARS`] 个字符截断，空的给 `None`。
pub fn clean_title(raw: &str) -> Option<String> {
    let flat = raw.replace("\r\n", " ").replace(['\r', '\n'], " ");
    let trimmed = flat.trim();
    if trimmed.is_empty() {
        return None;
    }
    let cut: String = trimmed.chars().take(TITLE_MAX_CHARS).collect();
    Some(cut.trim_end().to_string())
}

/// 这个进程该不该写：桌面版自己的 daemon（`CODEG_DESKTOP_CHILD=1`）不写。
pub fn enabled_for(desktop_child: Option<&str>) -> bool {
    desktop_child != Some("1")
}

/// 写到同目录的临时文件（权限 0600）再改名替换。
pub fn write_file(path: &Path, state: &LiveState) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(state).map_err(std::io::Error::other)?;
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| FILE_NAME.to_string());
    let tmp = path.with_file_name(format!(".{file_name}.{}.tmp", std::process::id()));
    let result = write_private(&tmp, &bytes).and_then(|()| std::fs::rename(&tmp, path));
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

fn write_private(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    // 上次没删掉的临时文件可能权限更宽：mode 只管新建的文件。
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)?;
    file.flush()
}

/// 记着上次写了什么、什么时候写的，决定这一次写不写。
pub struct LiveStateWriter {
    path: PathBuf,
    last: Option<(LiveContent, DateTime<Utc>)>,
    /// 上一次写失败了：连续失败只记一条警告。
    failing: bool,
}

impl LiveStateWriter {
    pub fn new(data_dir: &Path) -> Self {
        Self::at(data_dir.join(FILE_NAME))
    }

    /// 写到 `path`（每个进程自己的那一份用）。
    pub fn at(path: PathBuf) -> Self {
        Self {
            path,
            last: None,
            failing: false,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// 内容变了、从没写过、或者离上次写满了 [`REFRESH_SECS`] 秒就该写。
    pub fn due(&self, content: &LiveContent, now: DateTime<Utc>) -> bool {
        match &self.last {
            None => true,
            Some((last, at)) => {
                last != content || now.signed_duration_since(*at).num_seconds() >= REFRESH_SECS
            }
        }
    }

    /// 该写就写，返回这次写成了没有。写失败只记警告，下一次接着试。
    pub async fn tick(&mut self, content: LiveContent, now: DateTime<Utc>) -> bool {
        if !self.due(&content, now) {
            return false;
        }
        self.write_now(content, now).await
    }

    /// 不管变没变，现在就写。
    pub async fn write_now(&mut self, content: LiveContent, now: DateTime<Utc>) -> bool {
        let state = content.stamp(now);
        let path = self.path.clone();
        let result = tokio::task::spawn_blocking(move || write_file(&path, &state))
            .await
            .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())));
        match result {
            Ok(()) => {
                if self.failing {
                    tracing::info!(path = %self.path.display(), "live-state: writing again");
                }
                self.failing = false;
                self.last = Some((content, now));
                true
            }
            Err(error) => {
                if !self.failing {
                    tracing::warn!(path = %self.path.display(), %error, "live-state: write failed");
                }
                self.failing = true;
                false
            }
        }
    }
}

/// 每个进程自己那一份放在数据目录的这个子目录里（`<名字>.json` 是内容，`<名字>.lock`
/// 进程活着时一直锁着）。`live-state.json` 是所有活着的进程合起来的：几个 codeg-server
/// 共用一个数据目录（`runtime_lock` 允许）时，谁写都带着别人的会话，谁退出也只撤掉自己的。
pub const PARTS_DIR: &str = "live-state.d";
/// 文件系统不支持加锁时，别人的那一份多久没更新就当那个进程不在了（和 CoTeam 的过时
/// 规则一样）。
pub const PART_STALE_SECS: i64 = 180;

/// 合起来：`running` 取并集（升序去重），同一个对话在几份里都在等的，留最早开始等的那条。
pub fn merge(own: LiveContent, others: impl IntoIterator<Item = LiveContent>) -> LiveContent {
    let mut merged = own;
    for other in others {
        merged.running.extend(other.running);
        for (id, entry) in other.awaiting {
            match merged.awaiting.get(&id) {
                Some(kept) if kept.since <= entry.since => {}
                _ => {
                    merged.awaiting.insert(id, entry);
                }
            }
        }
    }
    merged.running.sort_unstable();
    merged.running.dedup();
    merged
}

/// 别的进程的那一份还算不算：它的锁文件有人锁着就算；锁文件没了、能锁上（进程已经
/// 退出）就不算；锁不了（文件系统不支持）就看它多久没更新。
fn owner_alive(lock_path: &Path, part: &LiveState, now: DateTime<Utc>) -> bool {
    let fresh = || now.signed_duration_since(part.updated_at).num_seconds() < PART_STALE_SECS;
    let file = match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)
    {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return false,
        Err(_) => return fresh(),
    };
    match file.try_lock() {
        // 锁上了说明没人拿着；`file` 一 drop 就放掉。
        Ok(()) => false,
        Err(std::fs::TryLockError::WouldBlock) => true,
        Err(std::fs::TryLockError::Error(_)) => fresh(),
    }
}

/// 读别的进程的那几份（`own` 是自己的名字，跳过）；已经不在的进程留下的顺手删掉。
pub fn read_others(dir: &Path, own: &str, now: DateTime<Utc>) -> Vec<LiveContent> {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return Vec::new();
    };
    let mut others = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(name) = path.file_stem().and_then(|n| n.to_str()) else {
            continue;
        };
        if name == own {
            continue;
        }
        let lock_path = dir.join(format!("{name}.lock"));
        // 读不了、格式不对的（对方正写到一半不会出现：写法是改名替换）当不在。
        let part = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<LiveState>(&bytes).ok());
        match part {
            Some(part) if owner_alive(&lock_path, &part, now) => others.push(LiveContent {
                running: part.running,
                awaiting: part.awaiting,
            }),
            _ => {
                let _ = std::fs::remove_file(&path);
                let _ = std::fs::remove_file(&lock_path);
            }
        }
    }
    others
}

/// 这个进程自己在 [`PARTS_DIR`] 里的那一份。
struct OwnPart {
    dir: PathBuf,
    name: String,
    /// 活着时一直锁着；文件系统不支持加锁时是 `None`，别人按更新时间判断。
    _lock: Option<std::fs::File>,
    writer: LiveStateWriter,
}

impl OwnPart {
    fn open(data_dir: &Path) -> std::io::Result<Self> {
        let dir = data_dir.join(PARTS_DIR);
        std::fs::create_dir_all(&dir)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700))?;
        }
        // 进程号加启动时刻：进程号被重用也不会撞上已经退出的那个留下的文件。
        let nanos = Utc::now().timestamp_nanos_opt().unwrap_or_default();
        let name = format!("{}-{nanos}", std::process::id());
        let lock_file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(dir.join(format!("{name}.lock")))?;
        let lock = match lock_file.try_lock() {
            Ok(()) => Some(lock_file),
            Err(e) => {
                tracing::warn!(%e, "live-state: cannot lock this server's part; others go by its age");
                None
            }
        };
        let writer = LiveStateWriter::at(dir.join(format!("{name}.json")));
        Ok(Self {
            dir,
            name,
            _lock: lock,
            writer,
        })
    }
}

/// 写 `live-state.json`：自己的那一份写进 [`PARTS_DIR`]，再和别的活着的进程的合起来写。
pub struct Publisher {
    main: LiveStateWriter,
    data_dir: PathBuf,
    part: Option<OwnPart>,
    /// 自己的那一份建不出来，已经警告过了（连续失败不重复记）。
    part_failing: bool,
}

impl Publisher {
    pub async fn open(data_dir: &Path) -> Self {
        let mut publisher = Self {
            main: LiveStateWriter::new(data_dir),
            data_dir: data_dir.to_path_buf(),
            part: None,
            part_failing: false,
        };
        publisher.ensure_part().await;
        publisher
    }

    /// 自己的那一份还没有就（再）建一次：启动时建不出来，之后每次都接着试。
    async fn ensure_part(&mut self) {
        if self.part.is_some() {
            return;
        }
        let dir = self.data_dir.clone();
        let part = tokio::task::spawn_blocking(move || OwnPart::open(&dir))
            .await
            .unwrap_or_else(|e| Err(std::io::Error::other(e.to_string())));
        match part {
            Ok(part) => {
                if self.part_failing {
                    tracing::info!("live-state: this server's part is back");
                }
                self.part_failing = false;
                self.part = Some(part);
            }
            Err(error) => {
                if !self.part_failing {
                    // 建出来之前也照样读别的进程的那几份合进来，不盖掉它们。
                    tracing::warn!(%error, "live-state: no part of its own yet; will retry");
                }
                self.part_failing = true;
            }
        }
    }

    /// 别的活着的进程的那几份；自己的那一份没建出来时也读（跳过的名字为空）。
    async fn others(&self, now: DateTime<Utc>) -> Vec<LiveContent> {
        let (dir, name) = match &self.part {
            Some(part) => (part.dir.clone(), part.name.clone()),
            None => (self.data_dir.join(PARTS_DIR), String::new()),
        };
        tokio::task::spawn_blocking(move || read_others(&dir, &name, now))
            .await
            .unwrap_or_default()
    }

    /// 这个进程现在的内容是 `own`。`force` 是不管变没变都写（启动时）。返回
    /// `live-state.json` 这次写了没有。
    pub async fn publish(&mut self, own: LiveContent, now: DateTime<Utc>, force: bool) -> bool {
        self.ensure_part().await;
        if let Some(part) = &mut self.part {
            // 刚补建出来的那一份是新的写入器，`tick` 第一次也会写。
            if force {
                part.writer.write_now(own.clone(), now).await;
            } else {
                part.writer.tick(own.clone(), now).await;
            }
        }
        let others = self.others(now).await;
        let merged = merge(own, others);
        if force {
            self.main.write_now(merged, now).await
        } else {
            self.main.tick(merged, now).await
        }
    }

    /// 退出：撤掉自己的那一份，把剩下的（只有自己时是空的）写一次。
    pub async fn close(self, now: DateTime<Utc>) -> bool {
        let Self {
            mut main,
            data_dir,
            part,
            ..
        } = self;
        let others = tokio::task::spawn_blocking(move || match part {
            Some(part) => {
                let OwnPart {
                    dir,
                    name,
                    _lock,
                    writer,
                } = part;
                let _ = std::fs::remove_file(writer.path());
                drop(_lock);
                let _ = std::fs::remove_file(dir.join(format!("{name}.lock")));
                read_others(&dir, &name, now)
            }
            // 自己的那一份一直没建出来：别人的照样留着。
            None => read_others(&data_dir.join(PARTS_DIR), "", now),
        })
        .await
        .unwrap_or_default();
        main.write_now(merge(LiveContent::default(), others), now)
            .await
    }
}

/// 在跑的写文件任务。[`Self::stop`] 停下它并写一次空的。
pub struct LiveStateTask {
    stop: tokio_util::sync::CancellationToken,
    handle: tokio::task::JoinHandle<()>,
}

impl LiveStateTask {
    /// 先写一次（这时这个进程还没有连接，只有自己时就是空的），再起每 [`TICK`] 一次的任务。
    pub async fn start(manager: ConnectionManager, data_dir: &Path) -> Self {
        let mut publisher = Publisher::open(data_dir).await;
        publisher
            .publish(LiveContent::default(), Utc::now(), true)
            .await;
        let stop = tokio_util::sync::CancellationToken::new();
        let token = stop.clone();
        let handle = tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = token.cancelled() => break,
                    _ = tokio::time::sleep(TICK) => {}
                }
                let content = snapshot(&manager).await;
                publisher.publish(content, Utc::now(), false).await;
            }
            // 停下以后（这时不会再有别的写）撤掉自己的那一份。
            publisher.close(Utc::now()).await;
        });
        Self { stop, handle }
    }

    /// 停下任务；任务退出前撤掉自己的那一份再写一次（只有自己时是空的）。正在写的那一次
    /// 写完才停，不会盖掉最后这次。
    pub async fn stop(self) {
        self.stop.cancel();
        let _ = self.handle.await;
    }
}

#[cfg(test)]
#[path = "live_state_tests.rs"]
mod tests;
