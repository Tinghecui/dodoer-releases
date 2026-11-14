//! Pull-request status of a conversation worktree, for the sidebar.
//!
//! A worktree folder has exactly one branch, so "this conversation's pull
//! request" is well defined there and nowhere else: conversations sharing the
//! main checkout would all show whatever the checkout happens to have checked
//! out. So only worktree folders (`parent_id` set) are looked up; everything
//! else answers [`FolderPrStatus::Unavailable`] without a request.
//!
//! The branch is read from the worktree's HEAD on every refresh, NOT from
//! `conversation.git_branch` — that one is the branch the conversation was
//! started on, a snapshot by design.
//!
//! Pull model with a shared cache: clients ask for the folders they show, every
//! few seconds while visible; a folder is only looked up again once its
//! interval has passed, and a changed answer is also pushed as
//! [`FOLDER_PR_STATUS_EVENT`] so other clients pick it up between their own
//! polls. Nobody looking means nothing is fetched.
//!
//! Conversations NOT in a codeg worktree are asked about separately, per
//! conversation ([`conversation_pr_statuses_core`]): a Claude agent may have
//! made a worktree of its own, or opened a pull request from wherever it was.
//! Its transcript says which ([`super::agent_pr`]); same cache rules, own map.

use std::collections::HashMap;
use std::future::Future;
use std::hash::Hash;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;

use super::deliver::ForgePr;
use super::{
    agent_pr, auth, cnb, deliver, gitea, github, gitlab, ForgeChangeDetail, ForgeCheckList,
    ForgeCheckState, ForgeError, ForgeProvider, ResolvedAuth,
};
use crate::commands::folders::get_folder_core;
use crate::commands::forge::forge_remote_at;
use crate::db::service::{agent_setting_service, conversation_service};
use crate::db::AppDatabase;
use crate::models::AgentType;
use crate::parsers::claude;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Pushed with one [`FolderPrStatusEntry`] whenever a folder's answer changes.
pub const FOLDER_PR_STATUS_EVENT: &str = "folder://pr-status";
/// Pushed with one [`ConversationPrStatusEntry`] whenever a conversation's
/// answer changes.
pub const CONVERSATION_PR_STATUS_EVENT: &str = "conversation://pr-status";

/// At most this many folders per request — a sidebar shows a handful of
/// worktrees, and the cap keeps one request from fanning out without bound.
const MAX_FOLDERS_PER_REQUEST: usize = 64;
/// Lookups in flight at once within one request.
const CONCURRENT_LOOKUPS: usize = 4;
/// A forced refresh (a turn just ended, a push just landed) is still ignored
/// when the folder was looked up this recently.
const FORCE_MIN_GAP: Duration = Duration::from_secs(5);
/// A lookup claimed longer ago than this is assumed abandoned (its request was
/// dropped mid-flight) and may be claimed again.
const CLAIM_EXPIRY: Duration = Duration::from_secs(90);

/// Checks still running: the pie moves, so look often.
const TTL_CHECKS_PENDING: Duration = Duration::from_secs(20);
const TTL_OPEN: Duration = Duration::from_secs(120);
/// Merged or closed hardly changes again.
const TTL_FINISHED: Duration = Duration::from_secs(600);
const TTL_NO_PR: Duration = Duration::from_secs(120);
/// Matches how often `gh` is asked again for a host it had no login for, so a
/// `gh auth login` shows up within a minute.
const TTL_NO_ACCOUNT: Duration = Duration::from_secs(60);
const TTL_UNAVAILABLE: Duration = Duration::from_secs(300);
/// After a failed lookup (network, rate limit): keep showing the last answer.
const RETRY_AFTER_ERROR: Duration = Duration::from_secs(120);

/// What the sidebar shows for one folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FolderPrStatus {
    Pr(PrHint),
    /// The worktree's branch has no pull request (and, for a conversation,
    /// its agent opened none).
    NoPr {
        branch: String,
    },
    /// The remote is a forge codeg speaks, but there is no account for it in
    /// settings and (for GitHub) no `gh` login either — the one case the user
    /// can fix, so the sidebar says how.
    NoAccount {
        provider: ForgeProvider,
        host: String,
    },
    /// Not a worktree, no branch, no forge remote, or nothing readable.
    /// Shown as nothing at all.
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PrHint {
    pub provider: ForgeProvider,
    pub number: i64,
    pub url: String,
    /// open | closed | merged
    pub state: String,
    pub draft: bool,
    /// The worktree branch the pull request was found for.
    pub branch: String,
    pub base_ref: String,
    /// See [`ForgeChangeDetail::mergeable`]; `None` is "not known yet".
    pub mergeable: Option<bool>,
    pub merge_state: Option<String>,
    /// `approved` | `changes_requested`, from each reviewer's latest review.
    /// GitHub only, and only while open.
    pub review_decision: Option<String>,
    pub checks: PrChecksSummary,
}

/// The head commit's checks, counted. `available: false` means the forge
/// would not say (see [`ForgeCheckList`]), which is not "no checks".
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct PrChecksSummary {
    pub available: bool,
    pub total: u32,
    pub success: u32,
    pub failure: u32,
    /// Skipped, cancelled, neutral — and failures the forge says may fail.
    pub neutral: u32,
    /// Queued or running.
    pub pending: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct FolderPrStatusEntry {
    pub folder_id: i32,
    pub status: FolderPrStatus,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ConversationPrStatusEntry {
    pub conversation_id: i32,
    pub status: FolderPrStatus,
}

// ── cache ───────────────────────────────────────────────────────────────────

struct Slot {
    status: FolderPrStatus,
    fetched_at: Instant,
    due: Instant,
}

/// Keyed by folder id or by conversation id — one cache each.
struct Cache<K> {
    slots: HashMap<K, Slot>,
    /// Keys a request is looking up right now, and since when.
    claims: HashMap<K, Instant>,
}

impl<K> Default for Cache<K> {
    fn default() -> Self {
        Self {
            slots: HashMap::new(),
            claims: HashMap::new(),
        }
    }
}

impl<K: Copy + Eq + Hash> Cache<K> {
    /// Which of `ids` this request should look up now, claiming them so a
    /// concurrent request does not look them up too.
    fn claim(&mut self, ids: &[K], force: bool, now: Instant) -> Vec<K> {
        let mut claimed = Vec::new();
        for &id in ids {
            if let Some(since) = self.claims.get(&id) {
                if now.saturating_duration_since(*since) < CLAIM_EXPIRY {
                    continue;
                }
            }
            let due = match self.slots.get(&id) {
                None => true,
                Some(slot) => {
                    now >= slot.due
                        || (force
                            && now.saturating_duration_since(slot.fetched_at) >= FORCE_MIN_GAP)
                }
            };
            if due {
                self.claims.insert(id, now);
                claimed.push(id);
            }
        }
        claimed
    }

    /// Record a lookup's outcome. Returns the status to push when the answer
    /// changed.
    fn settle(
        &mut self,
        id: K,
        outcome: Result<FolderPrStatus, ForgeError>,
        now: Instant,
    ) -> Option<FolderPrStatus> {
        self.claims.remove(&id);
        let previous = self.slots.get(&id).map(|slot| slot.status.clone());
        let (status, wait) = match outcome {
            Ok(status) => {
                let wait = ttl_for(&status);
                (status, wait)
            }
            // A failed lookup says nothing new about the pull request: keep
            // the last answer rather than blanking the sidebar over a blip.
            Err(err) => {
                let wait = match err {
                    ForgeError::RateLimited {
                        retry_after: Some(secs),
                    } => Duration::from_secs(secs).max(RETRY_AFTER_ERROR),
                    _ => RETRY_AFTER_ERROR,
                };
                (
                    previous.clone().unwrap_or(FolderPrStatus::Unavailable),
                    wait,
                )
            }
        };
        let changed = previous.as_ref() != Some(&status);
        self.slots.insert(
            id,
            Slot {
                status: status.clone(),
                fetched_at: now,
                due: now + wait,
            },
        );
        changed.then_some(status)
    }

    fn snapshot(&self, ids: &[K]) -> Vec<(K, FolderPrStatus)> {
        ids.iter()
            .filter_map(|id| self.slots.get(id).map(|slot| (*id, slot.status.clone())))
            .collect()
    }
}

static CACHE: LazyLock<Mutex<Cache<i32>>> = LazyLock::new(Default::default);
static CONVERSATION_CACHE: LazyLock<Mutex<Cache<i32>>> = LazyLock::new(Default::default);

fn ttl_for(status: &FolderPrStatus) -> Duration {
    match status {
        FolderPrStatus::Pr(hint) if hint.state != "open" => TTL_FINISHED,
        FolderPrStatus::Pr(hint) if hint.checks.pending > 0 => TTL_CHECKS_PENDING,
        FolderPrStatus::Pr(_) => TTL_OPEN,
        FolderPrStatus::NoPr { .. } => TTL_NO_PR,
        FolderPrStatus::NoAccount { .. } => TTL_NO_ACCOUNT,
        FolderPrStatus::Unavailable => TTL_UNAVAILABLE,
    }
}

// ── entry point ─────────────────────────────────────────────────────────────

/// The status of each of `folder_ids` that has one, after looking up the ones
/// that are due (or, with `force`, all of them that were not looked up in the
/// last few seconds). Folders never looked up before are looked up here, so
/// the first answer may take a moment; later calls answer from the cache.
pub async fn folder_pr_statuses_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    folder_ids: Vec<i32>,
    force: bool,
) -> Vec<FolderPrStatusEntry> {
    let (changed, entries) =
        cached_statuses(&CACHE, folder_ids, force, |id| lookup(db, id)).await;
    let entry =
        |(folder_id, status): (i32, FolderPrStatus)| FolderPrStatusEntry { folder_id, status };
    for entry in changed.into_iter().map(entry) {
        emit_event(emitter, FOLDER_PR_STATUS_EVENT, &entry);
    }
    entries.into_iter().map(entry).collect()
}

/// [`folder_pr_statuses_core`] for conversations outside codeg worktrees:
/// the pull request of the worktree their agent is in now, else the one it
/// opened (see [`lookup_conversation`]).
pub async fn conversation_pr_statuses_core(
    db: &AppDatabase,
    emitter: &EventEmitter,
    conversation_ids: Vec<i32>,
    force: bool,
) -> Vec<ConversationPrStatusEntry> {
    let (changed, entries) = cached_statuses(&CONVERSATION_CACHE, conversation_ids, force, |id| {
        lookup_conversation(db, id)
    })
    .await;
    let entry = |(conversation_id, status): (i32, FolderPrStatus)| ConversationPrStatusEntry {
        conversation_id,
        status,
    };
    for entry in changed.into_iter().map(entry) {
        emit_event(emitter, CONVERSATION_PR_STATUS_EVENT, &entry);
    }
    entries.into_iter().map(entry).collect()
}

/// Look up the due ones of `ids` with `lookup`, then answer all of them from
/// `cache`: `(changed, all)`.
async fn cached_statuses<F, Fut>(
    cache: &Mutex<Cache<i32>>,
    ids: Vec<i32>,
    force: bool,
    lookup: F,
) -> (Vec<(i32, FolderPrStatus)>, Vec<(i32, FolderPrStatus)>)
where
    F: Fn(i32) -> Fut,
    Fut: Future<Output = Result<FolderPrStatus, ForgeError>>,
{
    let mut ids = ids;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_FOLDERS_PER_REQUEST);

    let claimed = match cache.lock() {
        Ok(mut cache) => cache.claim(&ids, force, Instant::now()),
        Err(_) => return (Vec::new(), Vec::new()),
    };

    let lookup = &lookup;
    let outcomes: Vec<(i32, Result<FolderPrStatus, ForgeError>)> = futures::stream::iter(claimed)
        .map(|id| async move { (id, lookup(id).await) })
        .buffer_unordered(CONCURRENT_LOOKUPS)
        .collect()
        .await;

    match cache.lock() {
        Ok(mut cache) => {
            let now = Instant::now();
            let changed = outcomes
                .into_iter()
                .filter_map(|(id, outcome)| cache.settle(id, outcome, now).map(|s| (id, s)))
                .collect();
            (changed, cache.snapshot(&ids))
        }
        Err(_) => (Vec::new(), Vec::new()),
    }
}

// ── lookup ──────────────────────────────────────────────────────────────────

async fn lookup(db: &AppDatabase, folder_id: i32) -> Result<FolderPrStatus, ForgeError> {
    let Ok(folder) = get_folder_core(db, folder_id).await else {
        return Ok(FolderPrStatus::Unavailable);
    };
    if folder.parent_id.is_none() {
        return Ok(FolderPrStatus::Unavailable);
    }
    lookup_branch_at(db, &folder.path).await
}

/// A conversation outside codeg's worktrees. Claude only: its transcript is
/// the one that says where the agent is ([`agent_pr`]).
///
/// The worktree the agent is in now wins when its branch has a pull request
/// (or the forge needs an account); otherwise the newest pull request the
/// agent opened — from a worktree it has left since, or with a `git -C` that
/// never moved its `cwd`. The main checkout itself never counts: its branch
/// is shared with every other conversation there.
async fn lookup_conversation(
    db: &AppDatabase,
    conversation_id: i32,
) -> Result<FolderPrStatus, ForgeError> {
    let Ok(conversation) = conversation_service::get_by_id(&db.conn, conversation_id).await else {
        return Ok(FolderPrStatus::Unavailable);
    };
    if !matches!(conversation.agent_type, AgentType::ClaudeCode) {
        return Ok(FolderPrStatus::Unavailable);
    }
    let Some(session_id) = conversation.external_id.clone() else {
        return Ok(FolderPrStatus::Unavailable);
    };
    let folder_path = get_folder_core(db, conversation.folder_id)
        .await
        .map(|folder| folder.path)
        .unwrap_or_default();
    // The agent's own environment: a `CLAUDE_CONFIG_DIR` in its settings
    // (ccr's `~/.claudr`) moves the transcripts.
    let env = agent_setting_service::load_agent_env(&db.conn, AgentType::ClaudeCode).await;
    let roots = claude::resolve_claude_projects_dirs_for_env(&env);
    let trail = tokio::task::spawn_blocking(move || {
        agent_pr::read_trail(conversation_id, &roots, &session_id, &folder_path)
    })
    .await
    .ok()
    .flatten();
    let Some(trail) = trail else {
        return Ok(FolderPrStatus::Unavailable);
    };

    let mut in_worktree = None;
    if let Some(cwd) = trail.cwd.as_deref() {
        if let Some(root) = linked_worktree_root(cwd).await {
            let status = lookup_branch_at(db, &root).await?;
            if matches!(
                status,
                FolderPrStatus::Pr(_) | FolderPrStatus::NoAccount { .. }
            ) {
                return Ok(status);
            }
            in_worktree = Some(status);
        }
    }
    if let Some(url) = trail.created_pr.as_deref() {
        let status = lookup_pr_url(db, url).await?;
        if !matches!(status, FolderPrStatus::Unavailable) {
            return Ok(status);
        }
    }
    Ok(in_worktree.unwrap_or(FolderPrStatus::Unavailable))
}

/// The pull request of the branch checked out at `path`.
async fn lookup_branch_at(db: &AppDatabase, path: &str) -> Result<FolderPrStatus, ForgeError> {
    let Some(branch) = current_branch(path).await else {
        return Ok(FolderPrStatus::Unavailable);
    };
    let remote = match forge_remote_at(&db.conn, path).await {
        Ok(Some(remote)) if remote.supported => remote,
        _ => return Ok(FolderPrStatus::Unavailable),
    };
    let auth = match read_auth(db, remote.provider, &remote.server_host).await? {
        Ok(auth) => auth,
        Err(answer) => return Ok(answer),
    };

    let pulls = match remote.provider {
        ForgeProvider::GitHub => deliver::find_pulls(&auth, &remote.owner_repo, &branch).await?,
        ForgeProvider::GitLab => {
            gitlab::find_merge_requests(&auth, &remote.owner_repo, &branch).await?
        }
        ForgeProvider::Gitea => gitea::find_pulls(&auth, &remote.owner_repo, &branch).await?,
        ForgeProvider::Cnb => cnb::find_pulls(&auth, &remote.owner_repo, &branch).await?,
    };
    let Some(pull) = pick_pull(&pulls, &branch).cloned() else {
        return Ok(FolderPrStatus::NoPr { branch });
    };
    let state = normalize_state(&pull);
    let url = super::sanitize_web_url(&pull.html_url).unwrap_or_default();

    // A merged or closed change needs no CI or review: two to three requests
    // saved on the rows least likely to change.
    if state != "open" {
        return Ok(FolderPrStatus::Pr(PrHint {
            provider: remote.provider,
            number: pull.number,
            url,
            state,
            draft: false,
            branch,
            base_ref: pull.base_ref,
            mergeable: None,
            merge_state: None,
            review_decision: None,
            checks: PrChecksSummary::default(),
        }));
    }

    let detail =
        change_detail(&auth, remote.provider, &remote.owner_repo, pull.number).await?;
    let review_decision =
        review_decision(&auth, remote.provider, &remote.owner_repo, pull.number).await;
    Ok(FolderPrStatus::Pr(hint_from_detail(
        remote.provider,
        url,
        detail,
        review_decision,
    )))
}

/// The pull request at `url` (one the agent opened), by its number.
async fn lookup_pr_url(db: &AppDatabase, url: &str) -> Result<FolderPrStatus, ForgeError> {
    let Some(pr) = agent_pr::parse_pr_url(url) else {
        return Ok(FolderPrStatus::Unavailable);
    };
    // The same normalization a git remote of that repository gets.
    let Some((host, owner_repo)) =
        super::parse_remote_url(&format!("https://{}/{}", pr.host, pr.repo))
    else {
        return Ok(FolderPrStatus::Unavailable);
    };
    let profile = super::host_profile(&db.conn, &host).await;
    if !profile.recognized {
        return Ok(FolderPrStatus::Unavailable);
    }
    let owner_repo = super::strip_base_path(&owner_repo, &profile.base_path);
    let auth = match read_auth(db, profile.provider, &host).await? {
        Ok(auth) => auth,
        Err(answer) => return Ok(answer),
    };
    let detail = change_detail(&auth, profile.provider, &owner_repo, pr.number).await?;
    let review_decision = if detail.state == "open" {
        review_decision(&auth, profile.provider, &owner_repo, pr.number).await
    } else {
        None
    };
    let url = super::sanitize_web_url(url).unwrap_or_default();
    Ok(FolderPrStatus::Pr(hint_from_detail(
        profile.provider,
        url,
        detail,
        review_decision,
    )))
}

/// Credentials to read `host` with — or, as `Ok(Err(..))`, the answer to
/// give without asking the forge.
async fn read_auth(
    db: &AppDatabase,
    provider: ForgeProvider,
    host: &str,
) -> Result<Result<ResolvedAuth, FolderPrStatus>, ForgeError> {
    match auth::resolve_read_auth(&db.conn, provider, host).await {
        Ok(auth) => Ok(Ok(auth)),
        Err(ForgeError::NoAccount { provider, host }) => {
            Ok(Err(FolderPrStatus::NoAccount { provider, host }))
        }
        // A pinned account without a token, a host codeg cannot read: adding
        // an account would not help, so there is nothing to say.
        Err(ForgeError::Auth(_)) | Err(ForgeError::UnsupportedHost { .. }) => {
            Ok(Err(FolderPrStatus::Unavailable))
        }
        Err(err) => Err(err),
    }
}

async fn change_detail(
    auth: &ResolvedAuth,
    provider: ForgeProvider,
    owner_repo: &str,
    number: i64,
) -> Result<ForgeChangeDetail, ForgeError> {
    match provider {
        ForgeProvider::GitHub => github::change_detail(auth, owner_repo, number).await,
        ForgeProvider::GitLab => gitlab::change_detail(auth, owner_repo, number).await,
        ForgeProvider::Gitea => gitea::change_detail(auth, owner_repo, number).await,
        ForgeProvider::Cnb => cnb::change_detail(auth, owner_repo, number).await,
    }
}

async fn review_decision(
    auth: &ResolvedAuth,
    provider: ForgeProvider,
    owner_repo: &str,
    number: i64,
) -> Option<String> {
    match provider {
        ForgeProvider::GitHub => github_review_decision(auth, owner_repo, number).await,
        ForgeProvider::GitLab | ForgeProvider::Gitea | ForgeProvider::Cnb => None,
    }
}

/// A change's detail as the sidebar shows it; CI, review and mergeability
/// only while it is open.
fn hint_from_detail(
    provider: ForgeProvider,
    url: String,
    detail: ForgeChangeDetail,
    review_decision: Option<String>,
) -> PrHint {
    let open = detail.state == "open";
    PrHint {
        provider,
        number: detail.number,
        url,
        draft: open && detail.draft,
        branch: detail.head_ref,
        base_ref: detail.base_ref,
        mergeable: detail.mergeable.filter(|_| open),
        merge_state: detail.merge_state.filter(|_| open),
        review_decision: review_decision.filter(|_| open),
        checks: if open {
            summarize_checks(&detail.checks)
        } else {
            PrChecksSummary::default()
        },
        state: detail.state,
    }
}

/// The top of the linked worktree `cwd` is in; `None` for a main checkout,
/// a path that is gone, or no repository at all.
async fn linked_worktree_root(cwd: &str) -> Option<String> {
    let output = crate::process::tokio_command("git")
        .args([
            "-C",
            cwd,
            "rev-parse",
            "--path-format=absolute",
            "--git-dir",
            "--git-common-dir",
            "--show-toplevel",
        ])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let mut lines = text.lines();
    let (git_dir, common_dir, top) = (lines.next()?, lines.next()?, lines.next()?);
    (git_dir != common_dir && !top.is_empty()).then(|| top.to_string())
}

/// The worktree's checked-out branch; `None` when detached or not a repo.
async fn current_branch(path: &str) -> Option<String> {
    let output = crate::process::tokio_command("git")
        .args(["-C", path, "rev-parse", "--abbrev-ref", "HEAD"])
        .output()
        .await
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if branch.is_empty() || branch == "HEAD" {
        return None;
    }
    Some(branch)
}

/// The pull request a branch is "on": the newest open one, else the newest of
/// the rest. The head filter on the request is a pre-select; the branch is
/// matched again here.
fn pick_pull<'a>(pulls: &'a [ForgePr], branch: &str) -> Option<&'a ForgePr> {
    let mut candidates: Vec<&ForgePr> = pulls.iter().filter(|p| p.head_ref == branch).collect();
    candidates.sort_by_key(|p| std::cmp::Reverse(p.number));
    let newest_open = candidates
        .iter()
        .copied()
        .find(|p| normalize_state(p) == "open");
    newest_open.or_else(|| candidates.first().copied())
}

/// open | closed | merged, whatever the forge's own spelling.
fn normalize_state(pull: &ForgePr) -> String {
    if pull.merged || pull.state.eq_ignore_ascii_case("merged") {
        return "merged".to_string();
    }
    match pull.state.to_ascii_lowercase().as_str() {
        "open" | "opened" => "open".to_string(),
        _ => "closed".to_string(),
    }
}

fn summarize_checks(list: &ForgeCheckList) -> PrChecksSummary {
    let mut summary = PrChecksSummary {
        available: list.available,
        ..PrChecksSummary::default()
    };
    for check in &list.checks {
        summary.total += 1;
        match check.state {
            ForgeCheckState::Success => summary.success += 1,
            ForgeCheckState::Failure if check.allow_failure => summary.neutral += 1,
            ForgeCheckState::Failure => summary.failure += 1,
            ForgeCheckState::Neutral => summary.neutral += 1,
            ForgeCheckState::Queued | ForgeCheckState::Running => summary.pending += 1,
        }
    }
    summary
}

/// GitHub's reviews, folded per reviewer to their latest decisive review.
/// Not GitHub's own `reviewDecision` (that one weighs required reviewers and
/// is GraphQL-only), and said as such in the UI.
async fn github_review_decision(
    auth: &ResolvedAuth,
    owner_repo: &str,
    number: i64,
) -> Option<String> {
    let repo = super::normalize_repo(owner_repo)?;
    let url = format!(
        "{}/repos/{repo}/pulls/{number}/reviews?per_page=100",
        auth.api_base
    );
    let raw: Vec<serde_json::Value> = github::api_get(auth, &url).await.ok()?.json().await.ok()?;
    let reviews: Vec<(String, String)> = raw
        .iter()
        .filter_map(|review| {
            let login = review.get("user")?.get("login")?.as_str()?;
            let state = review.get("state")?.as_str()?;
            Some((login.to_string(), state.to_string()))
        })
        .collect();
    fold_reviews(&reviews)
}

/// `(reviewer, state)` in chronological order → the overall decision.
fn fold_reviews(reviews: &[(String, String)]) -> Option<String> {
    let mut latest: HashMap<&str, &str> = HashMap::new();
    for (login, state) in reviews {
        match state.as_str() {
            "APPROVED" | "CHANGES_REQUESTED" => {
                latest.insert(login.as_str(), state.as_str());
            }
            "DISMISSED" => {
                latest.remove(login.as_str());
            }
            // COMMENTED and PENDING leave a reviewer's standing as it was.
            _ => {}
        }
    }
    if latest.values().any(|state| *state == "CHANGES_REQUESTED") {
        Some("changes_requested".to_string())
    } else if latest.values().any(|state| *state == "APPROVED") {
        Some("approved".to_string())
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::forge::ForgeCheck;

    fn pull(number: i64, state: &str, merged: bool, head_ref: &str) -> ForgePr {
        ForgePr {
            number,
            html_url: format!("https://github.com/acme/app/pull/{number}"),
            state: state.to_string(),
            merged,
            head_sha: "abc123".to_string(),
            head_ref: head_ref.to_string(),
            head_repo: "acme/app".to_string(),
            base_ref: "main".to_string(),
        }
    }

    fn check(state: ForgeCheckState, allow_failure: bool) -> ForgeCheck {
        ForgeCheck {
            id: "run-1".to_string(),
            name: "ci".to_string(),
            state,
            summary: None,
            url: None,
            allow_failure,
        }
    }

    fn open_hint(pending: u32) -> FolderPrStatus {
        FolderPrStatus::Pr(PrHint {
            provider: ForgeProvider::GitHub,
            number: 7,
            url: "https://github.com/acme/app/pull/7".to_string(),
            state: "open".to_string(),
            draft: false,
            branch: "feat".to_string(),
            base_ref: "main".to_string(),
            mergeable: None,
            merge_state: None,
            review_decision: None,
            checks: PrChecksSummary {
                available: true,
                total: pending + 1,
                success: 1,
                pending,
                ..PrChecksSummary::default()
            },
        })
    }

    #[test]
    fn an_open_pull_wins_over_a_newer_closed_one() {
        let pulls = vec![
            pull(3, "open", false, "feat"),
            pull(9, "closed", false, "feat"),
            pull(12, "open", false, "other"),
        ];
        assert_eq!(pick_pull(&pulls, "feat").map(|p| p.number), Some(3));
    }

    #[test]
    fn without_an_open_pull_the_newest_is_shown() {
        let pulls = vec![
            pull(3, "closed", true, "feat"),
            pull(9, "closed", false, "feat"),
        ];
        assert_eq!(pick_pull(&pulls, "feat").map(|p| p.number), Some(9));
        assert_eq!(pick_pull(&pulls, "nope"), None);
    }

    #[test]
    fn states_are_folded_to_three() {
        assert_eq!(normalize_state(&pull(1, "open", false, "b")), "open");
        assert_eq!(normalize_state(&pull(1, "opened", false, "b")), "open");
        assert_eq!(normalize_state(&pull(1, "closed", true, "b")), "merged");
        assert_eq!(normalize_state(&pull(1, "merged", false, "b")), "merged");
        assert_eq!(normalize_state(&pull(1, "closed", false, "b")), "closed");
        assert_eq!(normalize_state(&pull(1, "locked", false, "b")), "closed");
    }

    #[test]
    fn checks_are_counted_with_allowed_failures_as_neutral() {
        let list = ForgeCheckList::available(vec![
            check(ForgeCheckState::Success, false),
            check(ForgeCheckState::Failure, false),
            check(ForgeCheckState::Failure, true),
            check(ForgeCheckState::Running, false),
            check(ForgeCheckState::Queued, false),
            check(ForgeCheckState::Neutral, false),
        ]);
        let summary = summarize_checks(&list);
        assert_eq!(
            summary,
            PrChecksSummary {
                available: true,
                total: 6,
                success: 1,
                failure: 1,
                neutral: 2,
                pending: 2,
            }
        );
        assert!(!summarize_checks(&ForgeCheckList::unavailable()).available);
    }

    #[test]
    fn each_reviewers_latest_decisive_review_counts() {
        let r = |login: &str, state: &str| (login.to_string(), state.to_string());
        assert_eq!(fold_reviews(&[]), None);
        assert_eq!(
            fold_reviews(&[r("a", "CHANGES_REQUESTED"), r("a", "APPROVED")]),
            Some("approved".to_string())
        );
        assert_eq!(
            fold_reviews(&[r("a", "APPROVED"), r("b", "CHANGES_REQUESTED")]),
            Some("changes_requested".to_string())
        );
        assert_eq!(
            fold_reviews(&[r("a", "APPROVED"), r("a", "COMMENTED")]),
            Some("approved".to_string())
        );
        assert_eq!(
            fold_reviews(&[r("a", "APPROVED"), r("a", "DISMISSED")]),
            None
        );
    }

    #[test]
    fn running_checks_are_polled_more_often_than_settled_ones() {
        assert_eq!(ttl_for(&open_hint(2)), TTL_CHECKS_PENDING);
        assert_eq!(ttl_for(&open_hint(0)), TTL_OPEN);
        assert_eq!(ttl_for(&FolderPrStatus::Unavailable), TTL_UNAVAILABLE);
    }

    #[test]
    fn a_folder_is_claimed_once_until_it_is_due_again() {
        let mut cache = Cache::default();
        let t0 = Instant::now();
        assert_eq!(cache.claim(&[1, 2], false, t0), vec![1, 2]);
        // In flight: a concurrent request does not look it up again.
        assert!(cache.claim(&[1, 2], true, t0).is_empty());

        assert!(cache.settle(1, Ok(open_hint(0)), t0).is_some());
        // Same answer again is not a change.
        assert_eq!(cache.claim(&[1], false, t0 + TTL_OPEN), vec![1]);
        assert!(cache.settle(1, Ok(open_hint(0)), t0 + TTL_OPEN).is_none());

        let t1 = t0 + TTL_OPEN;
        assert!(cache
            .claim(&[1], false, t1 + Duration::from_secs(1))
            .is_empty());
        // Forced, but too soon after the last lookup.
        assert!(cache
            .claim(&[1], true, t1 + Duration::from_secs(1))
            .is_empty());
        assert_eq!(cache.claim(&[1], true, t1 + FORCE_MIN_GAP), vec![1]);
    }

    #[test]
    fn a_failed_lookup_keeps_the_last_answer() {
        let mut cache = Cache::default();
        let t0 = Instant::now();
        cache.claim(&[1], false, t0);
        cache.settle(1, Ok(open_hint(1)), t0);
        cache.claim(&[1], true, t0 + FORCE_MIN_GAP);
        let pushed = cache.settle(
            1,
            Err(ForgeError::Network("down".into())),
            t0 + FORCE_MIN_GAP,
        );
        assert!(pushed.is_none());
        assert_eq!(cache.snapshot(&[1])[0].1, open_hint(1));
    }

    #[test]
    fn an_abandoned_claim_expires() {
        let mut cache = Cache::default();
        let t0 = Instant::now();
        assert_eq!(cache.claim(&[1], false, t0), vec![1]);
        assert_eq!(cache.claim(&[1], false, t0 + CLAIM_EXPIRY), vec![1]);
    }
}
