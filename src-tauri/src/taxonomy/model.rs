//! The taxonomy document and the two ways it changes: a nightly plan (the
//! whole tree, plus whichever placements the agent decided) and one
//! placement at a time (Jev, or the user). Pure: no database, no clock of its
//! own — callers pass `now`.

use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

/// Label Jev answers with when no category fits, and so an id no category
/// may take.
pub const UNCLASSIFIED: &str = "unclassified";
/// The frontend's id for the unclassified branch; reserved for the same
/// reason.
const UNCLASSIFIED_BRANCH: &str = "__unclassified__";

pub const MAX_CATEGORIES: usize = 48;
pub const MAX_TOP_LEVEL: usize = 16;
pub const MAX_ID_CHARS: usize = 48;
pub const MAX_NAME_CHARS: usize = 40;
pub const MAX_RULE_CHARS: usize = 600;
pub const MAX_SUMMARY_CHARS: usize = 600;
/// First-prompt text kept per conversation for the nightly export.
pub const PROMPT_EXCERPT_CHARS: usize = 400;

/// Who placed a conversation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Source {
    /// The nightly reorganization (Codex, through `codeg-cli taxonomy apply`).
    Nightly,
    /// Jev, right after the conversation's first prompt went out.
    Jev,
    /// The user, on the mind map. Nightly plans leave these alone.
    Manual,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Category {
    pub id: String,
    #[serde(default)]
    pub parent_id: Option<String>,
    pub name: String,
    #[serde(default)]
    pub rule: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Assignment {
    /// `None`: the user took the conversation out of every category (always
    /// [`Source::Manual`]). Kept so that the night and Jev leave it out.
    pub category_id: Option<String>,
    pub source: Source,
    /// Jev's confidence (0–1); `None` for the other sources.
    #[serde(default)]
    pub confidence: Option<f64>,
    pub assigned_at: DateTime<Utc>,
}

/// One project's mind map as stored (an `app_metadata` value, JSON).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Taxonomy {
    pub version: u32,
    /// Bumped by every write a client can see.
    pub revision: i64,
    pub categories: Vec<Category>,
    /// Conversation id → placement.
    pub assignments: BTreeMap<i32, Assignment>,
    /// Conversation id → the start of its first prompt, captured as it was
    /// sent. Feeds the nightly export; never shown in the UI.
    pub prompts: BTreeMap<i32, String>,
    pub reorganized_at: Option<DateTime<Utc>>,
    pub reorganize_summary: Option<String>,
}

impl Taxonomy {
    pub fn category(&self, id: &str) -> Option<&Category> {
        self.categories.iter().find(|c| c.id == id)
    }

    /// The live placement of `conversation_id`: one whose category exists.
    pub fn placement(&self, conversation_id: i32) -> Option<&Assignment> {
        self.assignments.get(&conversation_id).filter(|a| {
            a.category_id
                .as_deref()
                .is_some_and(|id| self.category(id).is_some())
        })
    }

    /// Whether the user took `conversation_id` out of every category.
    pub fn removed_by_hand(&self, conversation_id: i32) -> bool {
        self.assignments
            .get(&conversation_id)
            .is_some_and(|a| a.category_id.is_none())
    }

    /// `Parent / Child` for a sub-category, the name alone otherwise.
    pub fn path_name(&self, category: &Category) -> String {
        match category.parent_id.as_deref().and_then(|p| self.category(p)) {
            Some(parent) => format!("{} / {}", parent.name, category.name),
            None => category.name.clone(),
        }
    }
}

/// What the nightly agent hands in: the complete new tree, the placements it
/// decided (`null` = unclassified), and a line on what changed.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Plan {
    pub categories: Vec<Category>,
    #[serde(default)]
    pub assignments: BTreeMap<i32, Option<String>>,
    #[serde(default)]
    pub summary: Option<String>,
    /// The `exported_at` of the export the plan was made from. Conversations
    /// started after it count as new next time, even those started while the
    /// agent was still at work. Without it, the time of the apply.
    #[serde(default)]
    pub exported_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, PartialEq, thiserror::Error)]
pub enum PlanError {
    #[error("the plan has no categories; a project needs at least one")]
    NoCategories,
    #[error("too many categories: {0} (at most {MAX_CATEGORIES})")]
    TooManyCategories(usize),
    #[error("too many top-level categories: {0} (at most {MAX_TOP_LEVEL})")]
    TooManyTopLevel(usize),
    #[error(
        "category id {0:?} is not a slug: 1–{MAX_ID_CHARS} of a-z, 0-9, '-' and '_', starting with a letter or digit"
    )]
    BadId(String),
    #[error("category id {0:?} is reserved")]
    ReservedId(String),
    #[error("category id {0:?} appears twice")]
    DuplicateId(String),
    #[error("category {0:?} has no name")]
    EmptyName(String),
    #[error("category {0:?}: the name is longer than {MAX_NAME_CHARS} characters")]
    NameTooLong(String),
    #[error("category {0:?} has no rule: every category needs one")]
    EmptyRule(String),
    #[error("category {0:?}: the rule is longer than {MAX_RULE_CHARS} characters")]
    RuleTooLong(String),
    #[error("categories {0:?} share the name {1:?} under the same parent")]
    DuplicateName(String, String),
    #[error("category {0:?}: parent {1:?} does not exist")]
    UnknownParent(String, String),
    #[error(
        "category {0:?}: parent {1:?} is itself a sub-category; the tree has two levels"
    )]
    TooDeep(String, String),
    #[error("conversation {0}: category {1:?} is not in the plan")]
    UnknownCategory(i32, String),
    #[error("the summary is longer than {MAX_SUMMARY_CHARS} characters")]
    SummaryTooLong,
}

fn is_slug(id: &str) -> bool {
    let mut chars = id.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().count() <= MAX_ID_CHARS
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

/// Check `plan` and return its categories trimmed. Placements of
/// conversations outside `project` are not errors — a conversation deleted
/// between export and apply would otherwise sink a whole night — they are
/// skipped (see [`apply_plan`]).
pub fn validate_plan(plan: &Plan) -> Result<Vec<Category>, PlanError> {
    if plan.categories.is_empty() {
        return Err(PlanError::NoCategories);
    }
    if plan.categories.len() > MAX_CATEGORIES {
        return Err(PlanError::TooManyCategories(plan.categories.len()));
    }
    if let Some(summary) = &plan.summary {
        if summary.chars().count() > MAX_SUMMARY_CHARS {
            return Err(PlanError::SummaryTooLong);
        }
    }

    let mut categories = Vec::with_capacity(plan.categories.len());
    let mut ids = HashSet::new();
    for c in &plan.categories {
        let id = c.id.trim().to_string();
        if id == UNCLASSIFIED || id == UNCLASSIFIED_BRANCH {
            return Err(PlanError::ReservedId(id));
        }
        if !is_slug(&id) {
            return Err(PlanError::BadId(c.id.clone()));
        }
        if !ids.insert(id.clone()) {
            return Err(PlanError::DuplicateId(id));
        }
        let name = c.name.trim().to_string();
        if name.is_empty() {
            return Err(PlanError::EmptyName(id));
        }
        if name.chars().count() > MAX_NAME_CHARS {
            return Err(PlanError::NameTooLong(id));
        }
        let rule = c.rule.trim().to_string();
        if rule.is_empty() {
            return Err(PlanError::EmptyRule(id));
        }
        if rule.chars().count() > MAX_RULE_CHARS {
            return Err(PlanError::RuleTooLong(id));
        }
        let parent_id = c
            .parent_id
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(str::to_string);
        categories.push(Category {
            id,
            parent_id,
            name,
            rule,
        });
    }

    let parents: HashMap<&str, Option<&str>> = categories
        .iter()
        .map(|c| (c.id.as_str(), c.parent_id.as_deref()))
        .collect();
    let mut top_level = 0;
    let mut sibling_names: HashMap<(Option<&str>, String), &str> = HashMap::new();
    for c in &categories {
        match c.parent_id.as_deref() {
            None => top_level += 1,
            Some(parent) => match parents.get(parent) {
                None => return Err(PlanError::UnknownParent(c.id.clone(), parent.to_string())),
                // Two levels: a parent must be top-level. This also rules out
                // cycles, self-parenting included.
                Some(Some(_)) => return Err(PlanError::TooDeep(c.id.clone(), parent.to_string())),
                Some(None) => {}
            },
        }
        let key = (c.parent_id.as_deref(), c.name.to_lowercase());
        if let Some(other) = sibling_names.insert(key, &c.id) {
            return Err(PlanError::DuplicateName(
                format!("{other}, {}", c.id),
                c.name.clone(),
            ));
        }
    }
    if top_level > MAX_TOP_LEVEL {
        return Err(PlanError::TooManyTopLevel(top_level));
    }

    for (conversation_id, category) in &plan.assignments {
        if let Some(category) = category {
            if !ids.contains(category.trim()) {
                return Err(PlanError::UnknownCategory(
                    *conversation_id,
                    category.clone(),
                ));
            }
        }
    }
    Ok(categories)
}

/// What a plan did (or, on a dry run, would do).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct ApplyReport {
    pub categories_added: Vec<String>,
    pub categories_removed: Vec<String>,
    pub categories_renamed: Vec<String>,
    pub rules_changed: Vec<String>,
    pub categories_moved: Vec<String>,
    /// Placements the plan set or changed.
    pub placed: usize,
    /// Placements the plan cleared (`null`).
    pub cleared: usize,
    /// Placements already as the plan has them.
    pub unchanged: usize,
    /// Conversations left unclassified because their category went away and
    /// the plan did not place them again.
    pub orphaned: usize,
    /// Plan entries not followed because the user placed that conversation by
    /// hand into a category that still exists.
    pub kept_manual: Vec<i32>,
    /// Plan entries for conversations that are not (or no longer) in the
    /// project.
    pub skipped_unknown: Vec<i32>,
    /// Conversations of the project without a live category afterwards.
    pub unclassified_after: usize,
}

/// Apply a validated plan to `current` for a project whose conversations are
/// `project`. The tree is replaced whole; placements the plan does not name
/// stay as they are while their category lives. Manual decisions win over
/// the plan: a placement while its category lives, a removal always. Prompts
/// and placements of conversations gone from the project are dropped.
pub fn apply_plan(
    current: &Taxonomy,
    categories: Vec<Category>,
    plan: &Plan,
    project: &BTreeSet<i32>,
    now: DateTime<Utc>,
) -> (Taxonomy, ApplyReport) {
    let mut report = ApplyReport::default();

    let old: HashMap<&str, &Category> = current
        .categories
        .iter()
        .map(|c| (c.id.as_str(), c))
        .collect();
    let new_ids: HashSet<&str> = categories.iter().map(|c| c.id.as_str()).collect();
    for c in &categories {
        match old.get(c.id.as_str()) {
            None => report.categories_added.push(c.id.clone()),
            Some(prev) => {
                if prev.name != c.name {
                    report.categories_renamed.push(c.id.clone());
                }
                if prev.rule != c.rule {
                    report.rules_changed.push(c.id.clone());
                }
                if prev.parent_id != c.parent_id {
                    report.categories_moved.push(c.id.clone());
                }
            }
        }
    }
    for c in &current.categories {
        if !new_ids.contains(c.id.as_str()) {
            report.categories_removed.push(c.id.clone());
        }
    }

    let mut assignments: BTreeMap<i32, Assignment> = BTreeMap::new();
    for (id, a) in &current.assignments {
        if !project.contains(id) {
            continue;
        }
        // A removal by hand names no category, so no tree change ends it.
        if a.category_id.as_deref().is_none_or(|c| new_ids.contains(c)) {
            assignments.insert(*id, a.clone());
        } else if !plan.assignments.contains_key(id) {
            report.orphaned += 1;
        }
    }

    for (id, wanted) in &plan.assignments {
        if !project.contains(id) {
            report.skipped_unknown.push(*id);
            continue;
        }
        let wanted = wanted.as_deref().map(str::trim);
        let existing = assignments.get(id);
        if let Some(manual) = existing.filter(|a| a.source == Source::Manual) {
            if manual.category_id.as_deref() == wanted {
                report.unchanged += 1;
            } else {
                report.kept_manual.push(*id);
            }
            continue;
        }
        match wanted {
            Some(category) => {
                if existing.is_some_and(|a| {
                    a.category_id.as_deref() == Some(category) && a.source == Source::Nightly
                }) {
                    report.unchanged += 1;
                } else {
                    assignments.insert(
                        *id,
                        Assignment {
                            category_id: Some(category.to_string()),
                            source: Source::Nightly,
                            confidence: None,
                            assigned_at: now,
                        },
                    );
                    report.placed += 1;
                }
            }
            None => {
                if assignments.remove(id).is_some() {
                    report.cleared += 1;
                } else {
                    report.unchanged += 1;
                }
            }
        }
    }

    report.unclassified_after = project
        .iter()
        .filter(|id| assignments.get(id).is_none_or(|a| a.category_id.is_none()))
        .count();

    let prompts = current
        .prompts
        .iter()
        .filter(|(id, _)| project.contains(id))
        .map(|(id, p)| (*id, p.clone()))
        .collect();

    let next = Taxonomy {
        version: 1,
        revision: current.revision + 1,
        categories,
        assignments,
        prompts,
        reorganized_at: Some(plan.exported_at.map_or(now, |t| t.min(now))),
        reorganize_summary: plan
            .summary
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_string),
    };
    (next, report)
}

/// The start of a prompt, as kept in [`Taxonomy::prompts`].
pub fn prompt_excerpt(text: &str) -> String {
    let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
    crate::parsers::truncate_str(&collapsed, PROMPT_EXCERPT_CHARS)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cat(id: &str, parent: Option<&str>, name: &str) -> Category {
        Category {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            name: name.into(),
            rule: format!("rule of {name}"),
        }
    }

    fn plan(categories: Vec<Category>, assignments: &[(i32, Option<&str>)]) -> Plan {
        Plan {
            categories,
            assignments: assignments
                .iter()
                .map(|(id, c)| (*id, c.map(str::to_string)))
                .collect(),
            summary: Some("  added ui  ".into()),
            exported_at: None,
        }
    }

    fn at(category: &str, source: Source) -> Assignment {
        Assignment {
            category_id: Some(category.into()),
            source,
            confidence: None,
            assigned_at: DateTime::parse_from_rfc3339("2026-10-01T00:00:00Z")
                .unwrap()
                .with_timezone(&Utc),
        }
    }

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-29T19:30:00Z")
            .unwrap()
            .with_timezone(&Utc)
    }

    #[test]
    fn a_good_plan_validates_and_is_trimmed() {
        let mut p = plan(
            vec![cat(" ui ", None, " UI "), cat("ui-css", Some("ui"), "CSS")],
            &[(1, Some("ui"))],
        );
        p.categories[0].rule = "  frontend work  ".into();
        let cats = validate_plan(&p).unwrap();
        assert_eq!(cats[0].id, "ui");
        assert_eq!(cats[0].name, "UI");
        assert_eq!(cats[0].rule, "frontend work");
    }

    #[test]
    fn bad_plans_say_what_is_wrong() {
        let cases: Vec<(Plan, PlanError)> = vec![
            (plan(vec![], &[]), PlanError::NoCategories),
            (
                plan(vec![cat("Bad Id", None, "x")], &[]),
                PlanError::BadId("Bad Id".into()),
            ),
            (
                plan(vec![cat("unclassified", None, "x")], &[]),
                PlanError::ReservedId("unclassified".into()),
            ),
            (
                plan(vec![cat("a", None, "x"), cat("a", None, "y")], &[]),
                PlanError::DuplicateId("a".into()),
            ),
            (
                plan(vec![cat("a", Some("nope"), "x")], &[]),
                PlanError::UnknownParent("a".into(), "nope".into()),
            ),
            (
                plan(
                    vec![
                        cat("a", None, "A"),
                        cat("b", Some("a"), "B"),
                        cat("c", Some("b"), "C"),
                    ],
                    &[],
                ),
                PlanError::TooDeep("c".into(), "b".into()),
            ),
            (
                plan(vec![cat("a", Some("a"), "A")], &[]),
                PlanError::TooDeep("a".into(), "a".into()),
            ),
            (
                plan(vec![cat("a", None, "Same"), cat("b", None, "same")], &[]),
                PlanError::DuplicateName("a, b".into(), "same".into()),
            ),
            (
                plan(vec![cat("a", None, "A")], &[(5, Some("b"))]),
                PlanError::UnknownCategory(5, "b".into()),
            ),
        ];
        for (p, expected) in cases {
            assert_eq!(validate_plan(&p).unwrap_err(), expected);
        }
        let mut no_rule = plan(vec![cat("a", None, "A")], &[]);
        no_rule.categories[0].rule = "  ".into();
        assert_eq!(
            validate_plan(&no_rule).unwrap_err(),
            PlanError::EmptyRule("a".into())
        );
        let many: Vec<Category> = (0..17).map(|i| cat(&format!("c{i}"), None, &format!("C{i}"))).collect();
        assert_eq!(
            validate_plan(&plan(many, &[])).unwrap_err(),
            PlanError::TooManyTopLevel(17)
        );
    }

    #[test]
    fn the_same_name_under_different_parents_is_fine() {
        let p = plan(
            vec![
                cat("a", None, "A"),
                cat("b", None, "B"),
                cat("a-misc", Some("a"), "Misc"),
                cat("b-misc", Some("b"), "Misc"),
            ],
            &[],
        );
        assert!(validate_plan(&p).is_ok());
    }

    #[test]
    fn unknown_plan_fields_are_refused() {
        let err = serde_json::from_str::<Plan>(r#"{"categories": [], "assignment": {}}"#)
            .unwrap_err()
            .to_string();
        assert!(err.contains("unknown field"), "{err}");
        // Extra keys on a category (an export's `count`) are fine.
        let p: Plan = serde_json::from_str(
            r#"{"categories": [{"id": "a", "name": "A", "rule": "r", "count": 3}], "assignments": {"7": "a", "8": null}}"#,
        )
        .unwrap();
        assert_eq!(p.assignments.get(&7), Some(&Some("a".to_string())));
        assert_eq!(p.assignments.get(&8), Some(&None));
    }

    #[test]
    fn applying_replaces_the_tree_and_merges_placements() {
        let current = Taxonomy {
            version: 1,
            revision: 4,
            categories: vec![cat("ui", None, "UI"), cat("old", None, "Old")],
            assignments: BTreeMap::from([
                (1, at("ui", Source::Jev)),
                (2, at("old", Source::Nightly)),
                (3, at("ui", Source::Manual)),
                (4, at("ui", Source::Nightly)),
                (99, at("ui", Source::Nightly)), // gone from the project
            ]),
            prompts: BTreeMap::from([(1, "fix".into()), (99, "gone".into())]),
            reorganized_at: None,
            reorganize_summary: None,
        };
        let mut next_ui = cat("ui", None, "Frontend");
        next_ui.rule = "new rule".into();
        let p = plan(
            vec![next_ui, cat("api", None, "API")],
            &[
                (1, Some("api")),  // jev → nightly, moved
                (3, Some("api")),  // manual stays
                (4, Some("ui")),   // already there
                (5, Some("api")),  // newly placed
                (6, None),         // nothing to clear
                (77, Some("ui")),  // not in the project
            ],
        );
        let categories = validate_plan(&p).unwrap();
        let project = BTreeSet::from([1, 2, 3, 4, 5, 6]);
        let (next, report) = apply_plan(&current, categories, &p, &project, now());

        assert_eq!(next.revision, 5);
        assert_eq!(next.reorganized_at, Some(now()));
        assert_eq!(next.reorganize_summary.as_deref(), Some("added ui"));
        assert_eq!(next.assignments[&1].category_id.as_deref(), Some("api"));
        assert_eq!(next.assignments[&1].source, Source::Nightly);
        assert!(!next.assignments.contains_key(&2), "category `old` is gone");
        assert_eq!(next.assignments[&3].category_id.as_deref(), Some("ui"));
        assert_eq!(next.assignments[&3].source, Source::Manual);
        assert_eq!(next.assignments[&5].category_id.as_deref(), Some("api"));
        assert!(!next.assignments.contains_key(&99));
        assert_eq!(next.prompts.keys().copied().collect::<Vec<_>>(), vec![1]);

        assert_eq!(report.categories_added, vec!["api".to_string()]);
        assert_eq!(report.categories_removed, vec!["old".to_string()]);
        assert_eq!(report.categories_renamed, vec!["ui".to_string()]);
        assert_eq!(report.rules_changed, vec!["ui".to_string()]);
        assert_eq!(report.placed, 2);
        assert_eq!(report.unchanged, 2);
        assert_eq!(report.orphaned, 1);
        assert_eq!(report.kept_manual, vec![3]);
        assert_eq!(report.skipped_unknown, vec![77]);
        // 2 lost its category, 6 never had one.
        assert_eq!(report.unclassified_after, 2);
    }

    #[test]
    fn a_plan_can_clear_a_placement_but_not_a_manual_one() {
        let current = Taxonomy {
            categories: vec![cat("ui", None, "UI")],
            assignments: BTreeMap::from([
                (1, at("ui", Source::Jev)),
                (2, at("ui", Source::Manual)),
            ]),
            ..Default::default()
        };
        let p = plan(vec![cat("ui", None, "UI")], &[(1, None), (2, None)]);
        let categories = validate_plan(&p).unwrap();
        let (next, report) =
            apply_plan(&current, categories, &p, &BTreeSet::from([1, 2]), now());
        assert!(!next.assignments.contains_key(&1));
        assert_eq!(next.assignments[&2].source, Source::Manual);
        assert_eq!(report.cleared, 1);
        assert_eq!(report.kept_manual, vec![2]);
    }

    #[test]
    fn a_manual_placement_whose_category_goes_away_is_replaced() {
        let current = Taxonomy {
            categories: vec![cat("old", None, "Old")],
            assignments: BTreeMap::from([(1, at("old", Source::Manual))]),
            ..Default::default()
        };
        let p = plan(vec![cat("new", None, "New")], &[(1, Some("new"))]);
        let categories = validate_plan(&p).unwrap();
        let (next, report) = apply_plan(&current, categories, &p, &BTreeSet::from([1]), now());
        assert_eq!(next.assignments[&1].category_id.as_deref(), Some("new"));
        assert_eq!(next.assignments[&1].source, Source::Nightly);
        assert!(report.kept_manual.is_empty());
    }

    #[test]
    fn a_removal_by_hand_outlasts_every_plan() {
        let removed = Assignment {
            category_id: None,
            ..at("ui", Source::Manual)
        };
        let current = Taxonomy {
            categories: vec![cat("ui", None, "UI")],
            assignments: BTreeMap::from([(1, removed.clone()), (2, removed.clone())]),
            ..Default::default()
        };
        // A new tree that wants 1 placed and 2 left out.
        let p = plan(vec![cat("api", None, "API")], &[(1, Some("api")), (2, None)]);
        let categories = validate_plan(&p).unwrap();
        let (next, report) =
            apply_plan(&current, categories, &p, &BTreeSet::from([1, 2]), now());
        assert_eq!(next.assignments[&1], removed);
        assert_eq!(next.assignments[&2], removed);
        assert!(next.removed_by_hand(1));
        assert!(next.placement(1).is_none());
        assert_eq!(report.kept_manual, vec![1]);
        assert_eq!(report.unchanged, 1);
        assert_eq!(report.orphaned, 0);
        assert_eq!(report.unclassified_after, 2);
    }

    #[test]
    fn the_night_counts_from_the_export_it_read() {
        let p = |exported_at| Plan {
            exported_at,
            ..plan(vec![cat("ui", None, "UI")], &[])
        };
        let apply = |p: &Plan| {
            let categories = validate_plan(p).unwrap();
            apply_plan(&Taxonomy::default(), categories, p, &BTreeSet::new(), now()).0
        };
        let earlier = now() - chrono::TimeDelta::minutes(12);
        assert_eq!(apply(&p(Some(earlier))).reorganized_at, Some(earlier));
        // A clock ahead of ours, or no export time at all: now.
        let ahead = now() + chrono::TimeDelta::minutes(5);
        assert_eq!(apply(&p(Some(ahead))).reorganized_at, Some(now()));
        assert_eq!(apply(&p(None)).reorganized_at, Some(now()));
        let read: Plan = serde_json::from_str(
            r#"{"categories": [], "exported_at": "2026-10-29T19:18:00+00:00"}"#,
        )
        .unwrap();
        assert_eq!(read.exported_at, Some(earlier));
    }

    #[test]
    fn the_document_round_trips_with_integer_keys() {
        let t = Taxonomy {
            version: 1,
            revision: 2,
            categories: vec![cat("ui", None, "UI")],
            assignments: BTreeMap::from([(12, at("ui", Source::Jev))]),
            prompts: BTreeMap::from([(12, "hello".into())]),
            reorganized_at: Some(now()),
            reorganize_summary: None,
        };
        let json = serde_json::to_string(&t).unwrap();
        assert!(json.contains(r#""12":{"category_id":"ui""#), "{json}");
        let back: Taxonomy = serde_json::from_str(&json).unwrap();
        assert_eq!(back, t);
        // Missing fields read as empty: an older or hand-trimmed document
        // still loads.
        let sparse: Taxonomy = serde_json::from_str(r#"{"revision": 3}"#).unwrap();
        assert_eq!(sparse.revision, 3);
        assert!(sparse.categories.is_empty());
    }

    #[test]
    fn placement_ignores_dead_categories_and_path_names_nest() {
        let t = Taxonomy {
            categories: vec![cat("ui", None, "UI"), cat("css", Some("ui"), "CSS")],
            assignments: BTreeMap::from([
                (1, at("css", Source::Jev)),
                (2, at("gone", Source::Jev)),
            ]),
            ..Default::default()
        };
        assert_eq!(t.placement(1).unwrap().category_id.as_deref(), Some("css"));
        assert!(t.placement(2).is_none());
        assert_eq!(t.path_name(t.category("css").unwrap()), "UI / CSS");
        assert_eq!(t.path_name(t.category("ui").unwrap()), "UI");
    }

    #[test]
    fn prompt_excerpts_collapse_whitespace_and_cap() {
        assert_eq!(prompt_excerpt("  fix\n\n the   bug "), "fix the bug");
        let long = "字".repeat(PROMPT_EXCERPT_CHARS + 10);
        assert_eq!(
            prompt_excerpt(&long).chars().count(),
            PROMPT_EXCERPT_CHARS + 3
        );
    }
}
