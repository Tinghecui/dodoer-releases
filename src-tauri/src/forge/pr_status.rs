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

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::StreamExt;
use serde::Serialize;

use super::deliver::ForgePr;
use super::{
    auth, cnb, deliver, gitea, github, gitlab, ForgeChangeDetail, ForgeCheckList, ForgeCheckState,
    ForgeError, ForgeProvider, ResolvedAuth,
};
use crate::commands::folders::get_folder_core;
use crate::commands::forge::folder_forge_remote_core;
use crate::db::AppDatabase;
use crate::web::event_bridge::{emit_event, EventEmitter};

/// Pushed with one [`FolderPrStatusEntry`] whenever a folder's answer changes.
pub const FOLDER_PR_STATUS_EVENT: &str = "folder://pr-status";

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
    /// The worktree's branch has no pull request.
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

// ── cache ───────────────────────────────────────────────────────────────────

struct Slot {
    status: FolderPrStatus,
    fetched_at: Instant,
    due: Instant,
}

#[derive(Default)]
struct Cache {
    slots: HashMap<i32, Slot>,
    /// Folders a request is looking up right now, and since when.
    claims: HashMap<i32, Instant>,
}

impl Cache {
    /// Which of `ids` this request should look up now, claiming them so a
    /// concurrent request does not look them up too.
    fn claim(&mut self, ids: &[i32], force: bool, now: Instant) -> Vec<i32> {
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

    /// Record a lookup's outcome. Returns the entry to push when the answer
    /// changed.
    fn settle(
        &mut self,
        id: i32,
        outcome: Result<FolderPrStatus, ForgeError>,
        now: Instant,
    ) -> Option<FolderPrStatusEntry> {
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
        changed.then_some(FolderPrStatusEntry {
            folder_id: id,
            status,
        })
    }

    fn snapshot(&self, ids: &[i32]) -> Vec<FolderPrStatusEntry> {
        ids.iter()
            .filter_map(|id| {
                self.slots.get(id).map(|slot| FolderPrStatusEntry {
                    folder_id: *id,
                    status: slot.status.clone(),
                })
            })
            .collect()
    }
}

static CACHE: LazyLock<Mutex<Cache>> = LazyLock::new(Default::default);

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
    let mut ids = folder_ids;
    ids.sort_unstable();
    ids.dedup();
    ids.truncate(MAX_FOLDERS_PER_REQUEST);

    let claimed = match CACHE.lock() {
        Ok(mut cache) => cache.claim(&ids, force, Instant::now()),
        Err(_) => return Vec::new(),
    };

    let outcomes: Vec<(i32, Result<FolderPrStatus, ForgeError>)> = futures::stream::iter(claimed)
        .map(|id| async move { (id, lookup(db, id).await) })
        .buffer_unordered(CONCURRENT_LOOKUPS)
        .collect()
        .await;

    let (changed, entries) = match CACHE.lock() {
        Ok(mut cache) => {
            let now = Instant::now();
            let changed: Vec<FolderPrStatusEntry> = outcomes
                .into_iter()
                .filter_map(|(id, outcome)| cache.settle(id, outcome, now))
                .collect();
            (changed, cache.snapshot(&ids))
        }
        Err(_) => return Vec::new(),
    };
    for entry in &changed {
        emit_event(emitter, FOLDER_PR_STATUS_EVENT, entry);
    }
    entries
}

// ── lookup ──────────────────────────────────────────────────────────────────

async fn lookup(db: &AppDatabase, folder_id: i32) -> Result<FolderPrStatus, ForgeError> {
    let Ok(folder) = get_folder_core(db, folder_id).await else {
        return Ok(FolderPrStatus::Unavailable);
    };
    if folder.parent_id.is_none() {
        return Ok(FolderPrStatus::Unavailable);
    }
    let Some(branch) = current_branch(&folder.path).await else {
        return Ok(FolderPrStatus::Unavailable);
    };
    let remote = match folder_forge_remote_core(db, folder_id).await {
        Ok(Some(remote)) if remote.supported => remote,
        _ => return Ok(FolderPrStatus::Unavailable),
    };
    let auth = match auth::resolve_read_auth(&db.conn, remote.provider, &remote.server_host).await {
        Ok(auth) => auth,
        Err(ForgeError::NoAccount { provider, host }) => {
            return Ok(FolderPrStatus::NoAccount { provider, host })
        }
        // A pinned account without a token, a host codeg cannot read: adding
        // an account would not help, so there is nothing to say.
        Err(ForgeError::Auth(_)) | Err(ForgeError::UnsupportedHost { .. }) => {
            return Ok(FolderPrStatus::Unavailable)
        }
        Err(err) => return Err(err),
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

    let detail: ForgeChangeDetail = match remote.provider {
        ForgeProvider::GitHub => {
            github::change_detail(&auth, &remote.owner_repo, pull.number).await?
        }
        ForgeProvider::GitLab => {
            gitlab::change_detail(&auth, &remote.owner_repo, pull.number).await?
        }
        ForgeProvider::Gitea => {
            gitea::change_detail(&auth, &remote.owner_repo, pull.number).await?
        }
        ForgeProvider::Cnb => cnb::change_detail(&auth, &remote.owner_repo, pull.number).await?,
    };
    let review_decision = match remote.provider {
        ForgeProvider::GitHub => {
            github_review_decision(&auth, &remote.owner_repo, pull.number).await
        }
        ForgeProvider::GitLab | ForgeProvider::Gitea | ForgeProvider::Cnb => None,
    };

    Ok(FolderPrStatus::Pr(PrHint {
        provider: remote.provider,
        number: pull.number,
        url,
        state,
        draft: detail.draft,
        branch,
        base_ref: pull.base_ref,
        mergeable: detail.mergeable,
        merge_state: detail.merge_state,
        review_decision,
        checks: summarize_checks(&detail.checks),
    }))
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
        assert_eq!(cache.snapshot(&[1])[0].status, open_hint(1));
    }

    #[test]
    fn an_abandoned_claim_expires() {
        let mut cache = Cache::default();
        let t0 = Instant::now();
        assert_eq!(cache.claim(&[1], false, t0), vec![1]);
        assert_eq!(cache.claim(&[1], false, t0 + CLAIM_EXPIRY), vec![1]);
    }
}
