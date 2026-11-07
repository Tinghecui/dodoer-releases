//! The taxonomy operations the app, the CLI and the Jev hook share: which
//! conversations a project has, the project list and export the nightly
//! agent reads, applying its plan, and moving one conversation by hand.

use std::collections::{BTreeMap, BTreeSet, HashMap};

use chrono::{DateTime, Utc};
use sea_orm::{ColumnTrait, DatabaseConnection, EntityTrait, QueryFilter, QueryOrder};
use serde::{Deserialize, Serialize};

use super::model::{self, ApplyReport, Assignment, Category, Plan, PlanError, Source, Taxonomy};
use super::store;
use crate::db::entities::conversation::{self, ConversationKind};
use crate::db::entities::folder::{self, FolderKind};
use crate::db::error::DbError;
use crate::web::event_bridge::EventEmitter;

/// Projects smaller than this are left out of the nightly review: a map
/// needs something to sort.
pub const MIN_CONVERSATIONS_FOR_REVIEW: usize = 3;

#[derive(Debug, thiserror::Error)]
pub enum TaxonomyError {
    #[error(transparent)]
    Db(#[from] DbError),
    #[error("no folder {0:?} in codeg")]
    FolderNotFound(String),
    #[error("folder {0:?} is not a project (a chat folder)")]
    NotAProject(String),
    #[error("no conversation {0}")]
    ConversationNotFound(i32),
    #[error("conversation {0} is not on its project's mind map (a sub-session or loop row)")]
    NotPlaceable(i32),
    #[error("no category {0:?} in this project")]
    CategoryNotFound(String),
    #[error("the plan is not valid JSON for a plan: {0}")]
    PlanShape(String),
    #[error("the plan is refused: {0}")]
    Plan(#[from] PlanError),
}

impl From<sea_orm::DbErr> for TaxonomyError {
    fn from(e: sea_orm::DbErr) -> Self {
        TaxonomyError::Db(DbError::from(e))
    }
}

/// One conversation of a project, as much of it as the taxonomy needs.
#[derive(Debug, Clone)]
pub struct ProjectConversation {
    pub id: i32,
    pub title: Option<String>,
    pub agent_type: String,
    pub created_at: DateTime<Utc>,
}

/// The folder ids a project spans: the root and its live worktree children.
async fn project_folder_ids(conn: &DatabaseConnection, root_id: i32) -> Result<Vec<i32>, DbError> {
    let mut ids = vec![root_id];
    let children = folder::Entity::find()
        .filter(folder::Column::ParentId.eq(root_id))
        .filter(folder::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    ids.extend(children.into_iter().map(|f| f.id));
    Ok(ids)
}

/// Whether a conversation row belongs on a mind map at all: live, top-level,
/// ordinary work (not a chat, a loop row or a delegated sub-session).
fn placeable(c: &conversation::Model) -> bool {
    c.deleted_at.is_none() && c.parent_id.is_none() && c.kind == ConversationKind::Regular
}

/// The rows of the project's conversations, oldest first.
pub async fn project_conversation_rows(
    conn: &DatabaseConnection,
    root_id: i32,
) -> Result<Vec<conversation::Model>, DbError> {
    let folder_ids = project_folder_ids(conn, root_id).await?;
    Ok(conversation::Entity::find()
        .filter(conversation::Column::FolderId.is_in(folder_ids))
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::ParentId.is_null())
        .filter(conversation::Column::Kind.eq(ConversationKind::Regular))
        .order_by_asc(conversation::Column::CreatedAt)
        .order_by_asc(conversation::Column::Id)
        .all(conn)
        .await?)
}

/// The project's conversations, oldest first.
pub async fn project_conversations(
    conn: &DatabaseConnection,
    root_id: i32,
) -> Result<Vec<ProjectConversation>, DbError> {
    let rows = project_conversation_rows(conn, root_id).await?;
    Ok(rows
        .into_iter()
        .map(|c| ProjectConversation {
            id: c.id,
            title: c.title,
            agent_type: c.agent_type,
            created_at: c.created_at,
        })
        .collect())
}

/// The root folder of a live, user-facing folder.
pub async fn root_of_folder(
    conn: &DatabaseConnection,
    folder_id: i32,
) -> Result<folder::Model, TaxonomyError> {
    let row = folder::Entity::find_by_id(folder_id)
        .filter(folder::Column::DeletedAt.is_null())
        .one(conn)
        .await?
        .ok_or_else(|| TaxonomyError::FolderNotFound(folder_id.to_string()))?;
    let root = match row.parent_id {
        Some(parent) => folder::Entity::find_by_id(parent)
            .one(conn)
            .await?
            .ok_or_else(|| TaxonomyError::FolderNotFound(parent.to_string()))?,
        None => row,
    };
    if root.kind != FolderKind::Regular {
        return Err(TaxonomyError::NotAProject(folder_id.to_string()));
    }
    Ok(root)
}

/// A project named on the command line: a folder id, or a path codeg knows.
pub async fn resolve_project(
    conn: &DatabaseConnection,
    folder: &str,
) -> Result<folder::Model, TaxonomyError> {
    let wanted = folder.trim();
    if let Ok(id) = wanted.parse::<i32>() {
        return root_of_folder(conn, id).await;
    }
    let path = wanted.trim_end_matches('/');
    let row = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .filter(folder::Column::Path.is_in([path.to_string(), format!("{path}/")]))
        .one(conn)
        .await?
        .ok_or_else(|| TaxonomyError::FolderNotFound(folder.to_string()))?;
    root_of_folder(conn, row.id).await
}

pub fn display_name(f: &folder::Model) -> String {
    f.alias
        .as_deref()
        .map(str::trim)
        .filter(|a| !a.is_empty())
        .unwrap_or(&f.name)
        .to_string()
}

fn rfc3339(t: Option<DateTime<Utc>>) -> Option<String> {
    t.map(|t| t.to_rfc3339())
}

/// The mind map as the app draws it: the tree and the placements, without
/// the prompt excerpts (the export's business, and the bulk of the document).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaxonomyView {
    pub folder_id: i32,
    pub revision: i64,
    pub categories: Vec<Category>,
    pub assignments: BTreeMap<i32, Assignment>,
    pub reorganized_at: Option<DateTime<Utc>>,
    pub reorganize_summary: Option<String>,
}

impl TaxonomyView {
    fn of(root_id: i32, t: Taxonomy) -> Self {
        TaxonomyView {
            folder_id: root_id,
            revision: t.revision,
            categories: t.categories,
            assignments: t.assignments,
            reorganized_at: t.reorganized_at,
            reorganize_summary: t.reorganize_summary,
        }
    }
}

/// The mind map of the project `folder_id` belongs to.
pub async fn view(conn: &DatabaseConnection, folder_id: i32) -> Result<TaxonomyView, TaxonomyError> {
    let root = root_of_folder(conn, folder_id).await?;
    let t = store::load(conn, root.id).await?;
    Ok(TaxonomyView::of(root.id, t))
}

/// Put one conversation into `category_id` (or take it out of every
/// category with `None`) by hand. Nightly plans leave a manual placement
/// alone while its category lives, and a removal always; Jev places neither.
pub async fn assign_manual(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    conversation_id: i32,
    category_id: Option<String>,
) -> Result<TaxonomyView, TaxonomyError> {
    let row = conversation::Entity::find_by_id(conversation_id)
        .one(conn)
        .await?
        .filter(|c| c.deleted_at.is_none())
        .ok_or(TaxonomyError::ConversationNotFound(conversation_id))?;
    if !placeable(&row) {
        return Err(TaxonomyError::NotPlaceable(conversation_id));
    }
    let root = root_of_folder(conn, row.folder_id).await?;
    let _guard = store::lock(root.id).await;
    let mut t = store::load(conn, root.id).await?;
    let category_id = category_id.as_deref().map(str::trim);
    if let Some(id) = category_id.filter(|id| t.category(id).is_none()) {
        return Err(TaxonomyError::CategoryNotFound(id.to_string()));
    }
    t.assignments.insert(
        conversation_id,
        Assignment {
            category_id: category_id.map(str::to_string),
            source: Source::Manual,
            confidence: None,
            assigned_at: Utc::now(),
        },
    );
    t.version = 1;
    t.revision += 1;
    store::save(conn, root.id, &t).await?;
    store::emit_changed(emitter, root.id, t.revision);
    Ok(TaxonomyView::of(root.id, t))
}

/// One row of `codeg-cli taxonomy projects`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectEntry {
    pub id: i32,
    pub name: String,
    pub path: String,
    /// In the sidebar.
    pub open: bool,
    pub conversations: usize,
    pub categories: usize,
    pub unclassified: usize,
    /// Conversations started since the last nightly plan (all of them when
    /// there has been none).
    pub new_since_reorganized: usize,
    pub reorganized_at: Option<String>,
    /// Worth a nightly look: big enough, and never organized or grown since.
    pub needs_review: bool,
}

/// The projects the nightly agent looks at: those in the sidebar and those
/// that already have a mind map; with `all`, every project with at least one
/// conversation. Busiest first.
pub async fn projects(conn: &DatabaseConnection, all: bool) -> Result<Vec<ProjectEntry>, DbError> {
    let folders = folder::Entity::find()
        .filter(folder::Column::DeletedAt.is_null())
        .all(conn)
        .await?;
    let root_of: HashMap<i32, i32> = folders
        .iter()
        .map(|f| (f.id, f.parent_id.unwrap_or(f.id)))
        .collect();
    let rows = conversation::Entity::find()
        .filter(conversation::Column::DeletedAt.is_null())
        .filter(conversation::Column::ParentId.is_null())
        .filter(conversation::Column::Kind.eq(ConversationKind::Regular))
        .all(conn)
        .await?;
    let mut by_root: HashMap<i32, Vec<(i32, DateTime<Utc>)>> = HashMap::new();
    for c in rows {
        if let Some(root) = root_of.get(&c.folder_id) {
            by_root.entry(*root).or_default().push((c.id, c.created_at));
        }
    }
    let taxonomies = store::load_all(conn).await?;

    let mut out = Vec::new();
    for f in folders
        .iter()
        .filter(|f| f.parent_id.is_none() && f.kind == FolderKind::Regular)
    {
        let members = by_root.get(&f.id).map(Vec::as_slice).unwrap_or(&[]);
        let empty = Taxonomy::default();
        let t = taxonomies.get(&f.id).unwrap_or(&empty);
        let has_map = !t.categories.is_empty();
        let listed = if all {
            !members.is_empty()
        } else {
            (f.is_open && !members.is_empty()) || has_map
        };
        if !listed {
            continue;
        }
        let unclassified = members
            .iter()
            .filter(|(id, _)| t.placement(*id).is_none())
            .count();
        let new_since = members
            .iter()
            .filter(|(_, created)| t.reorganized_at.is_none_or(|r| *created > r))
            .count();
        out.push(ProjectEntry {
            id: f.id,
            name: display_name(f),
            path: f.path.clone(),
            open: f.is_open,
            conversations: members.len(),
            categories: t.categories.len(),
            unclassified,
            new_since_reorganized: new_since,
            reorganized_at: rfc3339(t.reorganized_at),
            needs_review: members.len() >= MIN_CONVERSATIONS_FOR_REVIEW
                && (t.reorganized_at.is_none() || new_since > 0),
        });
    }
    out.sort_by(|a, b| {
        b.conversations
            .cmp(&a.conversations)
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(out)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportFolder {
    pub id: i32,
    pub name: String,
    pub path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportCategory {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub rule: String,
    /// Conversations placed directly in it.
    pub count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportConversation {
    pub id: i32,
    pub title: Option<String>,
    /// The start of the first prompt, when it was captured as it was sent.
    pub first_prompt: Option<String>,
    pub agent: String,
    pub created_at: String,
    pub category_id: Option<String>,
    pub source: Option<Source>,
    pub confidence: Option<f64>,
    /// Started since the last nightly plan.
    pub new: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportStats {
    pub conversations: usize,
    pub unclassified: usize,
    pub new_since_reorganized: usize,
    pub placed_by_jev: usize,
    pub placed_by_hand: usize,
}

/// What `codeg-cli taxonomy export` prints: everything the nightly agent
/// reads to judge one project.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportDoc {
    pub v: u32,
    pub folder: ExportFolder,
    /// When this export was taken; a plan made from it passes it back.
    pub exported_at: String,
    pub revision: i64,
    pub reorganized_at: Option<String>,
    pub reorganize_summary: Option<String>,
    pub categories: Vec<ExportCategory>,
    pub stats: ExportStats,
    pub conversations: Vec<ExportConversation>,
}

pub async fn export(conn: &DatabaseConnection, folder: &str) -> Result<ExportDoc, TaxonomyError> {
    let root = resolve_project(conn, folder).await?;
    // Read the clock first: a conversation started while the export is read
    // is then new to the next one.
    let now = Utc::now();
    let t = store::load(conn, root.id).await?;
    let conversations = project_conversations(conn, root.id).await?;
    Ok(export_doc(&root, &t, &conversations, now))
}

fn export_doc(
    root: &folder::Model,
    t: &Taxonomy,
    conversations: &[ProjectConversation],
    now: DateTime<Utc>,
) -> ExportDoc {
    let mut counts: HashMap<&str, usize> = HashMap::new();
    let mut rows = Vec::with_capacity(conversations.len());
    let (mut unclassified, mut new_since, mut by_jev, mut by_hand) = (0, 0, 0, 0);
    for c in conversations {
        let placement = t.placement(c.id);
        match placement.and_then(|a| a.category_id.as_deref().map(|id| (id, a.source))) {
            Some((category, source)) => {
                *counts.entry(category).or_default() += 1;
                match source {
                    Source::Jev => by_jev += 1,
                    Source::Manual => by_hand += 1,
                    Source::Nightly => {}
                }
            }
            None => unclassified += 1,
        }
        let new = t.reorganized_at.is_none_or(|r| c.created_at > r);
        if new {
            new_since += 1;
        }
        rows.push(ExportConversation {
            id: c.id,
            title: c.title.clone(),
            first_prompt: t.prompts.get(&c.id).cloned(),
            agent: c.agent_type.clone(),
            created_at: c.created_at.to_rfc3339(),
            category_id: placement.and_then(|a| a.category_id.clone()),
            // Taken out by hand: `manual` with no category, so the agent
            // leaves it out.
            source: placement
                .map(|a| a.source)
                .or_else(|| t.removed_by_hand(c.id).then_some(Source::Manual)),
            confidence: placement.and_then(|a| a.confidence),
            new,
        });
    }
    ExportDoc {
        v: 1,
        folder: ExportFolder {
            id: root.id,
            name: display_name(root),
            path: root.path.clone(),
        },
        exported_at: now.to_rfc3339(),
        revision: t.revision,
        reorganized_at: rfc3339(t.reorganized_at),
        reorganize_summary: t.reorganize_summary.clone(),
        categories: t
            .categories
            .iter()
            .map(|c| ExportCategory {
                id: c.id.clone(),
                parent_id: c.parent_id.clone(),
                name: c.name.clone(),
                rule: c.rule.clone(),
                count: counts.get(c.id.as_str()).copied().unwrap_or(0),
            })
            .collect(),
        stats: ExportStats {
            conversations: conversations.len(),
            unclassified,
            new_since_reorganized: new_since,
            placed_by_jev: by_jev,
            placed_by_hand: by_hand,
        },
        conversations: rows,
    }
}

/// What `codeg-cli taxonomy apply` prints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApplyOutcome {
    pub folder_id: i32,
    pub dry_run: bool,
    /// The revision now stored (unchanged on a dry run).
    pub revision: i64,
    pub report: ApplyReport,
}

/// Check `plan` and, unless `dry_run`, store it as the project's new mind map.
pub async fn apply(
    conn: &DatabaseConnection,
    emitter: &EventEmitter,
    folder: &str,
    plan: serde_json::Value,
    dry_run: bool,
) -> Result<ApplyOutcome, TaxonomyError> {
    let plan: Plan =
        serde_json::from_value(plan).map_err(|e| TaxonomyError::PlanShape(e.to_string()))?;
    let categories = model::validate_plan(&plan)?;
    let root = resolve_project(conn, folder).await?;

    let _guard = store::lock(root.id).await;
    // Under the lock: a conversation started before it is in the set, so its
    // first prompt, kept by Jev's hook, is not pruned as a stranger's.
    let project: BTreeSet<i32> = project_conversations(conn, root.id)
        .await?
        .into_iter()
        .map(|c| c.id)
        .collect();
    let current = store::load(conn, root.id).await?;
    let (next, report) = model::apply_plan(&current, categories, &plan, &project, Utc::now());
    if dry_run {
        return Ok(ApplyOutcome {
            folder_id: root.id,
            dry_run: true,
            revision: current.revision,
            report,
        });
    }
    store::save(conn, root.id, &next).await?;
    store::emit_changed(emitter, root.id, next.revision);
    Ok(ApplyOutcome {
        folder_id: root.id,
        dry_run: false,
        revision: next.revision,
        report,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::service::{conversation_service, folder_service};
    use crate::db::test_helpers;
    use crate::models::agent::AgentType;
    use crate::web::event_bridge::WebEventBroadcaster;
    use std::sync::Arc;

    async fn seed(db: &crate::db::AppDatabase, folder: i32, title: &str) -> i32 {
        conversation_service::create(
            &db.conn,
            folder,
            AgentType::Codex,
            Some(title.to_string()),
            None,
        )
        .await
        .unwrap()
        .id
    }

    fn plan_json(assign: &[(i32, &str)]) -> serde_json::Value {
        let assignments: serde_json::Map<String, serde_json::Value> = assign
            .iter()
            .map(|(id, c)| (id.to_string(), serde_json::Value::String(c.to_string())))
            .collect();
        serde_json::json!({
            "categories": [
                {"id": "ui", "name": "界面", "rule": "Frontend and UI work"},
                {"id": "ui-css", "parent_id": "ui", "name": "样式", "rule": "CSS"},
                {"id": "ops", "name": "运维", "rule": "Deploys"}
            ],
            "assignments": assignments,
            "summary": "首次整理"
        })
    }

    #[tokio::test]
    async fn export_apply_and_view_round_trip() {
        let db = test_helpers::fresh_in_memory_db().await;
        let root = test_helpers::seed_folder(&db, "/p/app").await;
        let wt = folder_service::add_folder_with_parent(&db.conn, "/p/app-wt", Some(root))
            .await
            .unwrap()
            .id;
        let a = seed(&db, root, "fix the button").await;
        let b = seed(&db, wt, "deploy to prod").await;
        let other = test_helpers::seed_folder(&db, "/p/other").await;
        let c = seed(&db, other, "elsewhere").await;

        let broadcaster = Arc::new(WebEventBroadcaster::new());
        let mut rx = broadcaster.subscribe();
        let emitter = EventEmitter::test_web_only(broadcaster.clone());

        // By path (with a trailing slash), and through the worktree's id.
        let doc = export(&db.conn, "/p/app/").await.unwrap();
        assert_eq!(doc.folder.id, root);
        assert_eq!(
            doc.conversations.iter().map(|c| c.id).collect::<Vec<_>>(),
            vec![a, b]
        );
        assert!(doc.conversations.iter().all(|c| c.new && c.category_id.is_none()));
        assert_eq!(doc.stats.unclassified, 2);
        assert_eq!(export(&db.conn, &wt.to_string()).await.unwrap().folder.id, root);

        // A dry run changes nothing.
        let dry = apply(&db.conn, &emitter, "/p/app", plan_json(&[(a, "ui-css")]), true)
            .await
            .unwrap();
        assert!(dry.dry_run);
        assert_eq!(dry.report.placed, 1);
        assert_eq!(view(&db.conn, root).await.unwrap().revision, 0);
        assert!(rx.try_recv().is_err());

        // `c` is another project's: skipped, not an error.
        let applied = apply(
            &db.conn,
            &emitter,
            &root.to_string(),
            plan_json(&[(a, "ui-css"), (b, "ops"), (c, "ui")]),
            false,
        )
        .await
        .unwrap();
        assert_eq!(applied.revision, 1);
        assert_eq!(applied.report.placed, 2);
        assert_eq!(applied.report.skipped_unknown, vec![c]);
        let evt = rx.try_recv().expect("apply broadcasts");
        assert_eq!(evt.channel, store::CONVERSATION_TAXONOMY_CHANGED_EVENT);
        assert_eq!(evt.payload["folder_id"], root);
        assert_eq!(evt.payload["revision"], 1);

        let v = view(&db.conn, wt).await.unwrap();
        assert_eq!(v.folder_id, root);
        assert_eq!(v.categories.len(), 3);
        assert_eq!(v.assignments[&a].category_id.as_deref(), Some("ui-css"));
        assert_eq!(v.reorganize_summary.as_deref(), Some("首次整理"));

        let doc = export(&db.conn, "/p/app").await.unwrap();
        assert!(doc.conversations.iter().all(|c| !c.new));
        assert_eq!(doc.categories.iter().find(|c| c.id == "ops").unwrap().count, 1);

        // A plan that passes the export's time back dates the night to it.
        let mut plan = plan_json(&[]);
        plan["exported_at"] = doc.exported_at.clone().into();
        apply(&db.conn, &emitter, "/p/app", plan, false).await.unwrap();
        let exported_at = DateTime::parse_from_rfc3339(&doc.exported_at).unwrap();
        assert_eq!(
            view(&db.conn, root).await.unwrap().reorganized_at,
            Some(exported_at.with_timezone(&Utc))
        );
    }

    #[tokio::test]
    async fn a_bad_plan_is_refused_and_stores_nothing() {
        let db = test_helpers::fresh_in_memory_db().await;
        let root = test_helpers::seed_folder(&db, "/p/app").await;
        let emitter = EventEmitter::Noop;
        let err = apply(
            &db.conn,
            &emitter,
            "/p/app",
            serde_json::json!({"categories": [{"id": "Bad Id", "name": "x", "rule": "r"}]}),
            false,
        )
        .await
        .unwrap_err();
        assert!(matches!(err, TaxonomyError::Plan(PlanError::BadId(_))), "{err}");
        let err = apply(&db.conn, &emitter, "/p/app", serde_json::json!({"cats": []}), false)
            .await
            .unwrap_err();
        assert!(matches!(err, TaxonomyError::PlanShape(_)), "{err}");
        assert_eq!(view(&db.conn, root).await.unwrap().revision, 0);
        assert!(matches!(
            export(&db.conn, "/nowhere").await.unwrap_err(),
            TaxonomyError::FolderNotFound(_)
        ));
    }

    #[tokio::test]
    async fn manual_moves_validate_and_stick() {
        let db = test_helpers::fresh_in_memory_db().await;
        let root = test_helpers::seed_folder(&db, "/p/app").await;
        let a = seed(&db, root, "fix").await;
        let emitter = EventEmitter::Noop;
        apply(&db.conn, &emitter, "/p/app", plan_json(&[(a, "ui")]), false)
            .await
            .unwrap();

        let v = assign_manual(&db.conn, &emitter, a, Some("ops".into()))
            .await
            .unwrap();
        assert_eq!(v.assignments[&a].source, Source::Manual);
        assert!(matches!(
            assign_manual(&db.conn, &emitter, a, Some("nope".into()))
                .await
                .unwrap_err(),
            TaxonomyError::CategoryNotFound(_)
        ));
        assert!(matches!(
            assign_manual(&db.conn, &emitter, 9999, None).await.unwrap_err(),
            TaxonomyError::ConversationNotFound(9999)
        ));

        // The next night does not undo the move.
        let outcome = apply(&db.conn, &emitter, "/p/app", plan_json(&[(a, "ui")]), false)
            .await
            .unwrap();
        assert_eq!(outcome.report.kept_manual, vec![a]);
        assert_eq!(
            view(&db.conn, root).await.unwrap().assignments[&a].category_id.as_deref(),
            Some("ops")
        );

        // Taking it out sticks too: the night sees it as left out by hand.
        let v = assign_manual(&db.conn, &emitter, a, None).await.unwrap();
        assert_eq!(v.assignments[&a].category_id, None);
        assert_eq!(v.assignments[&a].source, Source::Manual);
        let outcome = apply(&db.conn, &emitter, "/p/app", plan_json(&[(a, "ui")]), false)
            .await
            .unwrap();
        assert_eq!(outcome.report.kept_manual, vec![a]);
        let doc = export(&db.conn, "/p/app").await.unwrap();
        let row = doc.conversations.iter().find(|c| c.id == a).unwrap();
        assert_eq!((row.category_id.as_deref(), row.source), (None, Some(Source::Manual)));
        assert_eq!(doc.stats.unclassified, 1);
    }

    #[tokio::test]
    async fn the_project_list_flags_what_needs_a_look() {
        let db = test_helpers::fresh_in_memory_db().await;
        let big = test_helpers::seed_folder(&db, "/p/big").await;
        let small = test_helpers::seed_folder(&db, "/p/small").await;
        let closed = test_helpers::seed_folder(&db, "/p/closed").await;
        folder_service::set_folder_open(&db.conn, big, true).await.unwrap();
        folder_service::set_folder_open(&db.conn, small, true).await.unwrap();
        folder_service::set_folder_open(&db.conn, closed, false).await.unwrap();
        let mut ids = Vec::new();
        for t in ["a", "b", "c"] {
            ids.push(seed(&db, big, t).await);
        }
        seed(&db, small, "one").await;
        seed(&db, closed, "x").await;

        let list = projects(&db.conn, false).await.unwrap();
        assert_eq!(list.iter().map(|p| p.id).collect::<Vec<_>>(), vec![big, small]);
        assert!(list[0].needs_review, "never organized, three conversations");
        assert!(!list[1].needs_review, "too small");
        assert_eq!(projects(&db.conn, true).await.unwrap().len(), 3);

        apply(
            &db.conn,
            &EventEmitter::Noop,
            "/p/big",
            plan_json(&[(ids[0], "ui"), (ids[1], "ops")]),
            false,
        )
        .await
        .unwrap();
        let list = projects(&db.conn, false).await.unwrap();
        let big_row = list.iter().find(|p| p.id == big).unwrap();
        assert_eq!(big_row.categories, 3);
        assert_eq!(big_row.unclassified, 1);
        assert_eq!(big_row.new_since_reorganized, 0);
        assert!(!big_row.needs_review);
    }
}
