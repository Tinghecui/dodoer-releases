//! Rolling the desktop app back to the release before the one it runs.
//!
//! Every desktop release in the update repository carries its own signed
//! manifest (`latest.json`) pointing at its own package, so going back is the
//! normal update with that release's manifest as the endpoint and a version
//! comparator that takes the older version
//! (`commands::app_update::perform_app_rollback`). This module holds the parts
//! that are plain data: where the releases are, which one is the previous one,
//! and whether that one can open this app's database.
//!
//! The database is the catch. An app migrates it when it starts, and an older
//! one refuses to start on a database holding a migration it does not know
//! (sea-orm-migration: "this migration has been applied but its file is
//! missing"). So before going back, the previous release's migrations are read
//! from its source at its tag (the update repository is the public mirror of
//! the source), and a rollback across a migration is refused up front rather
//! than leaving an app that no longer opens.

use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;

use crate::app_error::AppCommandError;

/// The file in the source that registers the migrations.
const MIGRATION_LIST_PATH: &str = "src-tauri/src/db/migration/mod.rs";

/// The GitHub repository the updater checks, and the manifest's file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSource {
    /// `<owner>/<repo>`.
    pub repo: String,
    pub manifest: String,
}

impl ReleaseSource {
    /// From the first updater endpoint of the form
    /// `https://github.com/<owner>/<repo>/releases/latest/download/<file>`.
    /// None when there is none (a build without such an update source has no
    /// releases to go back to).
    pub fn from_endpoints(endpoints: &[String]) -> Option<Self> {
        endpoints.iter().find_map(|endpoint| Self::parse(endpoint))
    }

    fn parse(endpoint: &str) -> Option<Self> {
        let url = Url::parse(endpoint).ok()?;
        if url.scheme() != "https" || url.host_str() != Some("github.com") {
            return None;
        }
        let segments: Vec<&str> = url.path_segments()?.collect();
        match segments.as_slice() {
            [owner, repo, "releases", "latest", "download", file]
                if !owner.is_empty() && !repo.is_empty() && !file.is_empty() =>
            {
                Some(Self {
                    repo: format!("{owner}/{repo}"),
                    manifest: (*file).to_string(),
                })
            }
            _ => None,
        }
    }

    /// The repository's releases, newest first. 100 reach back far enough:
    /// the release train keeps 30 of each kind.
    fn releases_url(&self) -> String {
        format!(
            "https://api.github.com/repos/{}/releases?per_page=100",
            self.repo
        )
    }

    /// The manifest the release `tag` was published with.
    pub fn manifest_url(&self, tag: &str) -> String {
        format!(
            "https://github.com/{}/releases/download/{tag}/{}",
            self.repo, self.manifest
        )
    }

    /// The migration list in the source at `tag`.
    fn migration_list_url(&self, tag: &str) -> String {
        format!(
            "https://api.github.com/repos/{}/contents/{MIGRATION_LIST_PATH}?ref={tag}",
            self.repo
        )
    }
}

#[derive(Debug, Deserialize)]
pub struct GithubRelease {
    pub tag_name: String,
    #[serde(default)]
    pub draft: bool,
    #[serde(default)]
    pub prerelease: bool,
    #[serde(default)]
    pub published_at: Option<String>,
    #[serde(default)]
    pub assets: Vec<GithubAsset>,
}

#[derive(Debug, Deserialize)]
pub struct GithubAsset {
    pub name: String,
}

/// The release a rollback goes to: the newest published (neither draft nor
/// prerelease) `v<version>` release older than `current` that has the
/// manifest. Other tags in the repository (the server packages'
/// `cowork-codeg-v…`) do not parse and are passed over.
pub fn previous_release<'a>(
    releases: &'a [GithubRelease],
    current: &Version,
    manifest: &str,
) -> Option<(Version, &'a GithubRelease)> {
    releases
        .iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter(|release| release.assets.iter().any(|asset| asset.name == manifest))
        .filter_map(|release| {
            let version = Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
            (version.pre.is_empty() && version < *current).then_some((version, release))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
}

/// The migrations a `db/migration/mod.rs` registers: every
/// `Box::new(<name>::Migration)`. The names are the module names, which is
/// what `DeriveMigrationName` records in `seaql_migrations`.
pub fn registered_migrations(source: &str) -> Vec<String> {
    const OPEN: &str = "Box::new(";
    const CLOSE: &str = "::Migration)";
    let mut names = Vec::new();
    let mut rest = source;
    while let Some(start) = rest.find(OPEN) {
        rest = &rest[start + OPEN.len()..];
        let Some(end) = rest.find(CLOSE) else {
            break;
        };
        let name = &rest[..end];
        if name.starts_with('m')
            && name
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
        {
            names.push(name.to_string());
            rest = &rest[end + CLOSE.len()..];
        }
    }
    names
}

/// The migrations this app knows. It ran all of them when it started, so
/// they are exactly what its database holds.
pub fn own_migrations() -> Vec<String> {
    use sea_orm_migration::MigratorTrait;
    crate::db::migration::Migrator::migrations()
        .iter()
        .map(|migration| migration.name().to_string())
        .collect()
}

/// Of the migrations in the database (`current`), those `target` does not
/// know.
pub fn unknown_to(target: &[String], current: &[String]) -> Vec<String> {
    current
        .iter()
        .filter(|migration| !target.contains(migration))
        .cloned()
        .collect()
}

/// Where a rollback would go.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppRollbackTarget {
    pub version: String,
    pub tag: String,
    /// When the release was published.
    pub date: Option<String>,
    /// The migrations in this app's database that `version` does not know.
    /// When there are any, it would not start on this database, and the
    /// rollback is refused.
    pub unknown_migrations: Vec<String>,
}

/// The release before `current`, and whether it can open this app's
/// database. None when there is no older release.
pub async fn find_target(
    source: &ReleaseSource,
    current: &Version,
) -> Result<Option<AppRollbackTarget>, AppCommandError> {
    let releases: Vec<GithubRelease> =
        github_get(&source.releases_url(), "application/vnd.github+json")
            .await?
            .json()
            .await
            .map_err(|e| {
                AppCommandError::network("Failed to read the list of releases")
                    .with_detail(e.to_string())
            })?;
    let Some((version, release)) = previous_release(&releases, current, &source.manifest)
    else {
        return Ok(None);
    };
    let list = github_get(
        &source.migration_list_url(&release.tag_name),
        "application/vnd.github.raw+json",
    )
    .await?
    .text()
    .await
    .map_err(|e| {
        AppCommandError::network("Failed to read the release's database migrations")
            .with_detail(e.to_string())
    })?;
    let migrations = registered_migrations(&list);
    if migrations.is_empty() {
        return Err(AppCommandError::network(format!(
            "No database migrations found in {MIGRATION_LIST_PATH} at {}",
            release.tag_name
        )));
    }
    Ok(Some(AppRollbackTarget {
        version: version.to_string(),
        tag: release.tag_name.clone(),
        date: release.published_at.clone(),
        unknown_migrations: unknown_to(&migrations, &own_migrations()),
    }))
}

async fn github_get(url: &str, accept: &str) -> Result<reqwest::Response, AppCommandError> {
    let response = super::version::manifest_client()?
        .get(url)
        .header(reqwest::header::ACCEPT, accept)
        .header("X-GitHub-Api-Version", "2022-11-28")
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to reach GitHub").with_detail(e.to_string())
        })?;
    if !response.status().is_success() {
        // 403 here is mostly GitHub's limit of 60 unauthenticated API
        // requests an hour per address.
        return Err(AppCommandError::network(format!(
            "GitHub returned status {} for {url}",
            response.status()
        )));
    }
    Ok(response)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn release(tag: &str, assets: &[&str]) -> GithubRelease {
        GithubRelease {
            tag_name: tag.to_string(),
            draft: false,
            prerelease: false,
            published_at: None,
            assets: assets
                .iter()
                .map(|name| GithubAsset {
                    name: name.to_string(),
                })
                .collect(),
        }
    }

    #[test]
    fn source_from_the_latest_download_endpoint() {
        let endpoints = vec![
            "https://example.com/update.json".to_string(),
            "https://github.com/Tinghecui/dodoer-releases/releases/latest/download/latest.json"
                .to_string(),
        ];
        let source = ReleaseSource::from_endpoints(&endpoints).unwrap();
        assert_eq!(
            source,
            ReleaseSource {
                repo: "Tinghecui/dodoer-releases".to_string(),
                manifest: "latest.json".to_string(),
            }
        );
        assert_eq!(
            source.manifest_url("v1.6.0"),
            "https://github.com/Tinghecui/dodoer-releases/releases/download/v1.6.0/latest.json"
        );
    }

    #[test]
    fn no_source_without_a_github_latest_endpoint() {
        for endpoint in [
            "http://github.com/a/b/releases/latest/download/latest.json",
            "https://github.com/a/b/releases/download/v1.0.0/latest.json",
            "https://example.com/a/b/releases/latest/download/latest.json",
            "not a url",
        ] {
            assert_eq!(
                ReleaseSource::from_endpoints(&[endpoint.to_string()]),
                None,
                "{endpoint}"
            );
        }
        assert_eq!(ReleaseSource::from_endpoints(&[]), None);
    }

    #[test]
    fn previous_is_the_newest_older_desktop_release_with_the_manifest() {
        let mut draft = release("v1.6.1", &["latest.json"]);
        draft.draft = true;
        let releases = vec![
            release("v1.6.3", &["latest.json"]),
            draft,
            release("cowork-codeg-v0.6.1", &["cowork-codeg-server-linux-x64.tar.gz"]),
            release("v1.6.0", &["latest.json"]),
            release("v1.5.9", &["other.json"]),
            release("v1.5.0", &["latest.json"]),
            release("v1.6.1-jenny.1", &["latest.json"]),
        ];
        let current = Version::parse("1.6.2").unwrap();
        let (version, found) = previous_release(&releases, &current, "latest.json").unwrap();
        assert_eq!(version, Version::parse("1.6.0").unwrap());
        assert_eq!(found.tag_name, "v1.6.0");

        let oldest = Version::parse("1.5.0").unwrap();
        assert!(previous_release(&releases, &oldest, "latest.json").is_none());
    }

    #[test]
    fn registered_migrations_reads_the_boxed_modules() {
        let source = r#"
            mod m20260211_000001_init;
            fn migrations() -> Vec<Box<dyn MigrationTrait>> {
                vec![
                    Box::new(m20260211_000001_init::Migration),
                    Box::new(Other(1)),
                    Box::new(m20261112_000001_work_task_writeback_drafts::Migration),
                ]
            }
        "#;
        assert_eq!(
            registered_migrations(source),
            vec![
                "m20260211_000001_init".to_string(),
                "m20261112_000001_work_task_writeback_drafts".to_string(),
            ]
        );
    }

    #[test]
    fn own_migrations_match_the_source_list() {
        let source = include_str!("../db/migration/mod.rs");
        assert_eq!(registered_migrations(source), own_migrations());
    }

    #[test]
    fn unknown_to_lists_what_the_target_lacks() {
        let target = vec!["a".to_string(), "b".to_string()];
        let current = vec!["a".to_string(), "b".to_string(), "c".to_string()];
        assert_eq!(unknown_to(&target, &current), vec!["c".to_string()]);
        assert!(unknown_to(&current, &target).is_empty());
    }
}
