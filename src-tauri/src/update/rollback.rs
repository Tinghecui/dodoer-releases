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

use super::channel::{self, StableHistory, UpdateChannel};
use crate::app_error::AppCommandError;

/// The file in the source that registers the migrations.
const MIGRATION_LIST_PATH: &str = "src-tauri/src/db/migration/mod.rs";

/// GitHub's web and API addresses, where a [`ReleaseSource`] normally is.
const GITHUB_WEB: &str = "https://github.com";
const GITHUB_API: &str = "https://api.github.com";

/// The GitHub repository the updater checks, and the manifest's file name.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReleaseSource {
    /// `<owner>/<repo>`.
    pub repo: String,
    pub manifest: String,
    /// Where the releases' files are (`https://github.com`), and the API
    /// that lists them (`https://api.github.com`). Only an `e2e` test build
    /// has others: a fake update feed on this machine
    /// ([`ReleaseSource::parse_with`]).
    pub web: String,
    pub api: String,
}

impl ReleaseSource {
    /// From the first updater endpoint of the form
    /// `https://github.com/<owner>/<repo>/releases/latest/download/<file>`.
    /// None when there is none (a build without such an update source has no
    /// releases to go back to).
    pub fn from_endpoints(endpoints: &[String]) -> Option<Self> {
        let loopback = cfg!(feature = "e2e");
        endpoints
            .iter()
            .find_map(|endpoint| Self::parse_with(endpoint, loopback))
    }

    /// `loopback`: also take
    /// `http://127.0.0.1:<port>/<owner>/<repo>/releases/latest/download/<file>`,
    /// a fake update feed laid out like GitHub, with the API under `/api`.
    /// Only `e2e` test builds do (the updater endpoint is overridden there,
    /// `crate::e2e::updater_endpoints`).
    fn parse_with(endpoint: &str, loopback: bool) -> Option<Self> {
        let url = Url::parse(endpoint).ok()?;
        let (web, api) = match (url.scheme(), url.host_str()) {
            ("https", Some("github.com")) if url.port().is_none() => {
                (GITHUB_WEB.to_string(), GITHUB_API.to_string())
            }
            ("http", Some("127.0.0.1")) if loopback => {
                let origin = url.origin().ascii_serialization();
                (origin.clone(), format!("{origin}/api"))
            }
            _ => return None,
        };
        let segments: Vec<&str> = url.path_segments()?.collect();
        match segments.as_slice() {
            [owner, repo, "releases", "latest", "download", file]
                if !owner.is_empty() && !repo.is_empty() && !file.is_empty() =>
            {
                Some(Self {
                    repo: format!("{owner}/{repo}"),
                    manifest: (*file).to_string(),
                    web,
                    api,
                })
            }
            _ => None,
        }
    }

    /// The repository's releases, newest first. 100 reach back far enough:
    /// the release train keeps 30 of each kind.
    fn releases_url(&self) -> String {
        format!("{}/repos/{}/releases?per_page=100", self.api, self.repo)
    }

    /// The manifest the release `tag` was published with.
    pub fn manifest_url(&self, tag: &str) -> String {
        format!(
            "{}/{}/releases/download/{tag}/{}",
            self.web, self.repo, self.manifest
        )
    }

    /// Cowork fork (issue #413): the stable channel's `history.json`, the
    /// versions promoted to it, newest first.
    pub fn stable_history_url(&self) -> String {
        format!(
            "{}/{}/releases/download/{}/{}",
            self.web,
            self.repo,
            channel::STABLE_TAG,
            channel::HISTORY_FILE
        )
    }

    /// The migration list in the source at `tag`.
    fn migration_list_url(&self, tag: &str) -> String {
        format!(
            "{}/repos/{}/contents/{MIGRATION_LIST_PATH}?ref={tag}",
            self.api, self.repo
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

/// The architecture in the update package's file name
/// (`dodoer-<version>-macos-<arch>.app.tar.gz`, scripts/cowork-desktop-build.sh).
pub fn package_arch() -> &'static str {
    match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        other => other,
    }
}

/// The release a rollback goes to: the newest published (neither draft nor
/// prerelease) `v<version>` release older than `current` that has the
/// manifest and its own update package for `arch`. Other tags in the
/// repository (the server packages' `cowork-codeg-v…`) do not parse and are
/// passed over.
///
/// The package matters for Intel: its builds come once a day, and every
/// release in between carries the last Intel manifest as it was so that
/// `releases/latest/download/latest-x64.json` resolves. Such a copy points at
/// an older release's package; only the release holding the package has the
/// manifest of its own version.
pub fn previous_release<'a>(
    releases: &'a [GithubRelease],
    current: &Version,
    manifest: &str,
    arch: &str,
) -> Option<(Version, &'a GithubRelease)> {
    releases
        .iter()
        .filter(|release| !release.draft && !release.prerelease)
        .filter(|release| release.assets.iter().any(|asset| asset.name == manifest))
        .filter_map(|release| {
            let version = Version::parse(release.tag_name.strip_prefix('v')?).ok()?;
            let package = format!("-{version}-macos-{arch}.app.tar.gz");
            let has_package = release
                .assets
                .iter()
                .any(|asset| asset.name.ends_with(&package));
            (version.pre.is_empty() && version < *current && has_package)
                .then_some((version, release))
        })
        .max_by(|a, b| a.0.cmp(&b.0))
}

/// Cowork fork (issue #413): the stable release a rollback goes to: the first
/// version older than `current` in the stable `history` whose release (by
/// tag) is published with the manifest and its own update package for
/// `arch`, as [`previous_release`] checks it. An Intel app's history entry can
/// be a release that only carries an older Intel manifest; going there would
/// download that older package, so it is passed over.
pub fn previous_stable_with_package<'a>(
    history: &'a StableHistory,
    releases: &[GithubRelease],
    current: &Version,
    manifest: &str,
    arch: &str,
) -> Option<(Version, &'a channel::StableEntry)> {
    channel::previous_stable_where(history, current, |version, entry| {
        let package = format!("-{version}-macos-{arch}.app.tar.gz");
        releases.iter().any(|release| {
            release.tag_name == entry.tag
                && !release.draft
                && release.assets.iter().any(|asset| asset.name == manifest)
                && release
                    .assets
                    .iter()
                    .any(|asset| asset.name.ends_with(&package))
        })
    })
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
///
/// Cowork fork (issue #413): which release is "before" depends on the update
/// channel. Early: the newest older release in the repository. Stable: the
/// first version older than `current` in the stable channel's
/// `history.json` that has its own package for this machine
/// ([`previous_stable_with_package`]); a history that cannot be read, or
/// holds nothing older, is no release to go back to.
pub async fn find_target(
    source: &ReleaseSource,
    current: &Version,
    update_channel: UpdateChannel,
) -> Result<Option<AppRollbackTarget>, AppCommandError> {
    let picked = match update_channel {
        UpdateChannel::Early => previous_early(source, current).await?,
        UpdateChannel::Stable => previous_stable_release(source, current).await?,
    };
    let Some(picked) = picked else {
        return Ok(None);
    };
    let list = github_get(
        &source.migration_list_url(&picked.tag),
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
            picked.tag
        )));
    }
    Ok(Some(AppRollbackTarget {
        version: picked.version.to_string(),
        tag: picked.tag,
        date: picked.date,
        unknown_migrations: unknown_to(&migrations, &own_migrations()),
    }))
}

/// The release [`find_target`] picked, before its migrations are read.
struct Picked {
    version: Version,
    tag: String,
    date: Option<String>,
}

/// Early channel: the newest older release in the repository
/// ([`previous_release`]).
async fn previous_early(
    source: &ReleaseSource,
    current: &Version,
) -> Result<Option<Picked>, AppCommandError> {
    let releases = release_list(source).await?;
    Ok(
        previous_release(&releases, current, &source.manifest, package_arch()).map(
            |(version, release)| Picked {
                version,
                tag: release.tag_name.clone(),
                date: release.published_at.clone(),
            },
        ),
    )
}

/// The repository's releases ([`ReleaseSource::releases_url`]).
async fn release_list(source: &ReleaseSource) -> Result<Vec<GithubRelease>, AppCommandError> {
    github_get(&source.releases_url(), "application/vnd.github+json")
        .await?
        .json()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to read the list of releases")
                .with_detail(e.to_string())
        })
}

/// Stable channel: the first older version in `history.json` that has its
/// own update package for this machine ([`previous_stable_with_package`]);
/// its date is when it was promoted. None when the history cannot be read.
async fn previous_stable_release(
    source: &ReleaseSource,
    current: &Version,
) -> Result<Option<Picked>, AppCommandError> {
    let url = source.stable_history_url();
    let history = match fetch_stable_history(&url).await {
        Ok(history) => history,
        Err(e) => {
            tracing::warn!("[update] could not read the stable history {url}: {e}");
            return Ok(None);
        }
    };
    let releases = release_list(source).await?;
    Ok(previous_stable_with_package(
        &history,
        &releases,
        current,
        &source.manifest,
        package_arch(),
    )
    .map(|(version, entry)| Picked {
        version,
        tag: entry.tag.clone(),
        date: entry.promoted_at.clone(),
    }))
}

async fn fetch_stable_history(url: &str) -> Result<StableHistory, String> {
    let response = super::version::manifest_client()
        .map_err(|e| e.to_string())?
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("status {}", response.status()));
    }
    response
        .json::<StableHistory>()
        .await
        .map_err(|e| e.to_string())
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
                web: "https://github.com".to_string(),
                api: "https://api.github.com".to_string(),
            }
        );
        assert_eq!(
            source.releases_url(),
            "https://api.github.com/repos/Tinghecui/dodoer-releases/releases?per_page=100"
        );
        assert_eq!(
            source.migration_list_url("v1.6.0"),
            "https://api.github.com/repos/Tinghecui/dodoer-releases/contents/\
             src-tauri/src/db/migration/mod.rs?ref=v1.6.0"
        );
        assert_eq!(
            source.manifest_url("v1.6.0"),
            "https://github.com/Tinghecui/dodoer-releases/releases/download/v1.6.0/latest.json"
        );
        assert_eq!(
            source.stable_history_url(),
            "https://github.com/Tinghecui/dodoer-releases/releases/download/stable/history.json"
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
    fn a_loopback_feed_is_a_source_only_when_allowed() {
        let feed = "http://127.0.0.1:47001/e2e/fake/releases/latest/download/latest-client.json";
        assert_eq!(ReleaseSource::parse_with(feed, false), None);
        let source = ReleaseSource::parse_with(feed, true).unwrap();
        assert_eq!(source.repo, "e2e/fake");
        assert_eq!(source.manifest, "latest-client.json");
        assert_eq!(
            source.manifest_url("v1.999.0"),
            "http://127.0.0.1:47001/e2e/fake/releases/download/v1.999.0/latest-client.json"
        );
        assert_eq!(
            source.stable_history_url(),
            "http://127.0.0.1:47001/e2e/fake/releases/download/stable/history.json"
        );
        assert_eq!(
            source.releases_url(),
            "http://127.0.0.1:47001/api/repos/e2e/fake/releases?per_page=100"
        );
        // GitHub stays GitHub; other hosts and https on the loopback are not taken
        for other in [
            "http://localhost:47001/e2e/fake/releases/latest/download/latest.json",
            "https://127.0.0.1:47001/e2e/fake/releases/latest/download/latest.json",
            "https://github.com:8443/a/b/releases/latest/download/latest.json",
        ] {
            assert_eq!(ReleaseSource::parse_with(other, true), None, "{other}");
        }
    }

    #[test]
    fn previous_is_the_newest_older_desktop_release_with_the_manifest() {
        let mut draft = release(
            "v1.6.1",
            &["latest.json", "dodoer-1.6.1-macos-arm64.app.tar.gz"],
        );
        draft.draft = true;
        let releases = vec![
            release(
                "v1.6.3",
                &["latest.json", "dodoer-1.6.3-macos-arm64.app.tar.gz"],
            ),
            draft,
            release(
                "cowork-codeg-v0.6.1",
                &["cowork-codeg-server-linux-x64.tar.gz"],
            ),
            release(
                "v1.6.0",
                &["latest.json", "dodoer-1.6.0-macos-arm64.app.tar.gz"],
            ),
            release(
                "v1.5.9",
                &["other.json", "dodoer-1.5.9-macos-arm64.app.tar.gz"],
            ),
            release(
                "v1.5.0",
                &["latest.json", "dodoer-1.5.0-macos-arm64.app.tar.gz"],
            ),
            release(
                "v1.6.1-jenny.1",
                &["latest.json", "dodoer-1.6.1-jenny.1-macos-arm64.app.tar.gz"],
            ),
        ];
        let current = Version::parse("1.6.2").unwrap();
        let (version, found) =
            previous_release(&releases, &current, "latest.json", "arm64").unwrap();
        assert_eq!(version, Version::parse("1.6.0").unwrap());
        assert_eq!(found.tag_name, "v1.6.0");

        let oldest = Version::parse("1.5.0").unwrap();
        assert!(previous_release(&releases, &oldest, "latest.json", "arm64").is_none());
    }

    #[test]
    fn previous_intel_release_is_one_with_its_own_package() {
        // v1.6.4 and v1.6.3 carry the latest-x64.json of v1.6.2 as it was
        let releases = vec![
            release(
                "v1.6.5",
                &["latest-x64.json", "dodoer-1.6.5-macos-x64.app.tar.gz"],
            ),
            release(
                "v1.6.4",
                &["latest-x64.json", "dodoer-1.6.4-macos-arm64.app.tar.gz"],
            ),
            release(
                "v1.6.3",
                &["latest-x64.json", "dodoer-1.6.3-macos-arm64.app.tar.gz"],
            ),
            release(
                "v1.6.2",
                &["latest-x64.json", "dodoer-1.6.2-macos-x64.app.tar.gz"],
            ),
        ];
        let current = Version::parse("1.6.5").unwrap();
        let found = previous_release(&releases, &current, "latest-x64.json", "x64");
        assert_eq!(found.unwrap().0, Version::parse("1.6.2").unwrap());
        // an arm64 app goes back to the newest older release with an arm64 package
        let arm64 = previous_release(&releases, &current, "latest-x64.json", "arm64");
        assert_eq!(arm64.unwrap().0, Version::parse("1.6.4").unwrap());
    }

    fn stable(versions: &[&str]) -> StableHistory {
        StableHistory {
            versions: versions
                .iter()
                .map(|v| channel::StableEntry {
                    version: v.to_string(),
                    tag: format!("v{v}"),
                    promoted_at: None,
                })
                .collect(),
        }
    }

    #[test]
    fn previous_stable_intel_release_is_one_with_its_own_package() {
        // v1.6.4 只带着 v1.6.2 那份 Intel 清单，没有自己的 Intel 包
        let releases = vec![
            release(
                "v1.6.5",
                &["latest-x64.json", "dodoer-1.6.5-macos-x64.app.tar.gz"],
            ),
            release(
                "v1.6.4",
                &["latest-x64.json", "dodoer-1.6.4-macos-arm64.app.tar.gz"],
            ),
            release(
                "v1.6.2",
                &["latest-x64.json", "dodoer-1.6.2-macos-x64.app.tar.gz"],
            ),
        ];
        let history = stable(&["1.6.5", "1.6.4", "1.6.2"]);
        let current = Version::parse("1.6.5").unwrap();
        let pick = |arch: &str| {
            previous_stable_with_package(&history, &releases, &current, "latest-x64.json", arch)
                .map(|(version, entry)| (version.to_string(), entry.tag.clone()))
        };
        assert_eq!(
            pick("x64"),
            Some(("1.6.2".to_string(), "v1.6.2".to_string()))
        );
        assert_eq!(
            pick("arm64"),
            Some(("1.6.4".to_string(), "v1.6.4".to_string()))
        );
        // history 里的版本在 Release 列表里找不到：不回退到它
        let missing = stable(&["1.6.5", "1.6.3"]);
        assert_eq!(
            previous_stable_with_package(&missing, &releases, &current, "latest-x64.json", "x64"),
            None
        );
    }

    #[test]
    fn package_arch_names_this_build() {
        let arch = package_arch();
        if cfg!(target_arch = "aarch64") {
            assert_eq!(arch, "arm64");
        } else if cfg!(target_arch = "x86_64") {
            assert_eq!(arch, "x64");
        }
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
