//! jenny fork: `codeg-cli taxonomy` — how the nightly Codex automation reads
//! and rewrites each project's conversation mind map (see `crate::taxonomy`
//! and `docs/conversation-mindmap.md`).
//!
//! - `projects` lists the projects worth a look tonight.
//! - `export PROJECT` prints one project's tree and its conversations (title
//!   and first prompt) as JSON.
//! - `apply PROJECT PLAN` stores a plan — the whole new tree and the
//!   placements decided — after the runtime has checked it; `--dry-run` only
//!   checks it.

use std::path::Path;
use std::time::Duration;

use crate::cli_run::wire::{
    capability, Subtype, TaxonomyApplyRequest, TaxonomyExportRequest, TaxonomyProjectsRequest,
};
use crate::taxonomy::service::{ApplyOutcome, ExportDoc, ProjectEntry};

use super::args::{
    GlobalArgs, OutputFormat, TaxonomyAction, TaxonomyApplyArgs, TaxonomyArgs,
    TaxonomyExportArgs, TaxonomyProjectsArgs,
};
use super::connect::{self, Env};
use super::render::{Output, RunRef};
use super::Failure;

/// A big project's export or plan is a few hundred KiB; reading thousands of
/// rows takes the runtime a moment.
const TIMEOUT: Duration = Duration::from_secs(120);

pub async fn taxonomy(global: &GlobalArgs, args: &TaxonomyArgs, env: &Env) -> i32 {
    match &args.action {
        TaxonomyAction::Projects(a) => projects(global, a, env).await,
        TaxonomyAction::Export(a) => export(global, a, env).await,
        TaxonomyAction::Apply(a) => apply(global, a, env).await,
    }
}

/// The format a `taxonomy` command prints in (and fails in).
pub fn output_format(args: &TaxonomyArgs) -> OutputFormat {
    let json = match &args.action {
        TaxonomyAction::Projects(a) => a.json,
        TaxonomyAction::Export(_) => true,
        TaxonomyAction::Apply(a) => a.json,
    };
    if json {
        OutputFormat::Json
    } else {
        OutputFormat::Text
    }
}

async fn connected(global: &GlobalArgs, env: &Env) -> Result<connect::Connection, Failure> {
    let (conn, _) = connect::connect(global, env).await?;
    if !conn.has(capability::TAXONOMY) {
        return Err(Failure::new(
            Subtype::ErrorRuntimeIncompatible,
            "runtime_incompatible",
            format!(
                "the codeg at {} ({}) has no conversation mind map; install a build that does",
                conn.source, conn.hello.version
            ),
        ));
    }
    Ok(conn)
}

fn finish<T>(out: &Output, result: Result<T, Failure>, print: impl FnOnce(T)) -> i32 {
    match result {
        Ok(value) => {
            print(value);
            0
        }
        Err(f) => {
            out.failure(&f, &RunRef::default());
            f.exit_code()
        }
    }
}

async fn projects(global: &GlobalArgs, args: &TaxonomyProjectsArgs, env: &Env) -> i32 {
    let out = Output::new(
        if args.json {
            OutputFormat::Json
        } else {
            OutputFormat::Text
        },
        global,
    );
    let listed = async {
        let conn = connected(global, env).await?;
        conn.post::<_, Vec<ProjectEntry>>(
            "cli_taxonomy_projects",
            &TaxonomyProjectsRequest { all: args.all },
            TIMEOUT,
        )
        .await
    };
    finish(&out, listed.await, |projects| {
        if args.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&projects).expect("serializes")
            );
            return;
        }
        if projects.is_empty() {
            println!("no projects with conversations");
            return;
        }
        println!(
            "{:>5}  {:>6}  {:>5}  {:>6}  {:>4}  {:6}  PROJECT",
            "ID", "CONVS", "CATS", "UNCLS", "NEW", "REVIEW"
        );
        for p in &projects {
            println!(
                "{:>5}  {:>6}  {:>5}  {:>6}  {:>4}  {:6}  {} ({})",
                p.id,
                p.conversations,
                p.categories,
                p.unclassified,
                p.new_since_reorganized,
                if p.needs_review { "yes" } else { "no" },
                p.name,
                p.path
            );
        }
    })
}

async fn export(global: &GlobalArgs, args: &TaxonomyExportArgs, env: &Env) -> i32 {
    let out = Output::new(OutputFormat::Json, global);
    let exported = async {
        let conn = connected(global, env).await?;
        let doc = conn
            .post::<_, ExportDoc>(
                "cli_taxonomy_export",
                &TaxonomyExportRequest {
                    folder: args.folder.clone(),
                },
                TIMEOUT,
            )
            .await?;
        let text = serde_json::to_string_pretty(&doc).expect("serializes") + "\n";
        if let Some(path) = &args.output {
            super::run::write_atomically(path, &text).map_err(|e| {
                Failure::new(
                    Subtype::ErrorDuringExecution,
                    "output_unwritable",
                    format!("cannot write {}: {e}", path.display()),
                )
            })?;
        }
        Ok((text, args.output.is_some()))
    };
    finish(&out, exported.await, |(text, written)| {
        if !written {
            print!("{text}");
        }
    })
}

/// The plan from a file, or stdin for `-`, parsed here so a broken file is a
/// usage error before anything is sent.
fn read_plan(path: &str) -> Result<serde_json::Value, Failure> {
    let text = if path == "-" {
        let mut buf = String::new();
        std::io::Read::read_to_string(&mut std::io::stdin(), &mut buf)
            .map_err(|e| Failure::usage("bad_plan", format!("cannot read the plan from stdin: {e}")))?;
        buf
    } else {
        std::fs::read_to_string(Path::new(path))
            .map_err(|e| Failure::usage("bad_plan", format!("cannot read {path}: {e}")))?
    };
    serde_json::from_str(&text)
        .map_err(|e| Failure::usage("bad_plan", format!("the plan is not JSON: {e}")))
}

async fn apply(global: &GlobalArgs, args: &TaxonomyApplyArgs, env: &Env) -> i32 {
    let out = Output::new(
        if args.json {
            OutputFormat::Json
        } else {
            OutputFormat::Text
        },
        global,
    );
    let applied = async {
        let plan = read_plan(&args.plan)?;
        let conn = connected(global, env).await?;
        conn.post::<_, ApplyOutcome>(
            "cli_taxonomy_apply",
            &TaxonomyApplyRequest {
                folder: args.folder.clone(),
                plan,
                dry_run: args.dry_run,
            },
            TIMEOUT,
        )
        .await
    };
    finish(&out, applied.await, |outcome| {
        if args.json {
            println!(
                "{}",
                serde_json::to_string_pretty(&outcome).expect("serializes")
            );
            return;
        }
        let r = &outcome.report;
        if outcome.dry_run {
            println!(
                "dry run for project {}: the plan is valid; nothing was stored",
                outcome.folder_id
            );
        } else {
            println!(
                "applied to project {} (revision {})",
                outcome.folder_id, outcome.revision
            );
        }
        println!(
            "  categories: {} added, {} removed, {} renamed, {} rules changed, {} moved",
            r.categories_added.len(),
            r.categories_removed.len(),
            r.categories_renamed.len(),
            r.rules_changed.len(),
            r.categories_moved.len()
        );
        println!(
            "  placements: {} placed, {} cleared, {} unchanged, {} orphaned",
            r.placed, r.cleared, r.unchanged, r.orphaned
        );
        if !r.kept_manual.is_empty() {
            println!(
                "  kept as the user placed them: {}",
                join_ids(&r.kept_manual)
            );
        }
        if !r.skipped_unknown.is_empty() {
            println!(
                "  not in this project (skipped): {}",
                join_ids(&r.skipped_unknown)
            );
        }
        println!("  unclassified afterwards: {}", r.unclassified_after);
    })
}

fn join_ids(ids: &[i32]) -> String {
    ids.iter()
        .map(i32::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_plan_that_is_not_json_is_a_usage_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("plan.json");
        std::fs::write(&path, "{nope").unwrap();
        let err = read_plan(path.to_str().unwrap()).unwrap_err();
        assert_eq!(err.code, "bad_plan");
        assert_eq!(err.exit_code(), 2);
        let err = read_plan(dir.path().join("missing.json").to_str().unwrap()).unwrap_err();
        assert!(err.message.contains("cannot read"), "{}", err.message);
        std::fs::write(&path, r#"{"categories": []}"#).unwrap();
        assert!(read_plan(path.to_str().unwrap()).is_ok());
    }
}
