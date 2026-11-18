//! Cowork fork (issue #413): 桌面版的更新通道，稳定版 / 抢先版。
//!
//! - 抢先版：配置里的更新源原样，即公开仓库的 Latest，每合一个改动发一版。
//! - 稳定版：同一个仓库里固定 tag `stable` 的 Release，抢先版跑满 24 小时
//!   没出问题时由发版那边指过去（#410）。里面有 `latest.json`（和配置里的
//!   清单同名）和 `history.json`（晋级过的版本，新的在前）。
//!
//! 两个地址都从配置里的更新源算出来（[`ReleaseSource::from_endpoints`]），
//! 不用再加配置项。配置里的更新源不是这种 GitHub 地址时（上游自己的构建）
//! 没有通道这回事，两档都用配置里的地址。

use semver::Version;
use serde::{Deserialize, Serialize};
use url::Url;

use super::rollback::ReleaseSource;

/// 稳定版的 Release 的 tag。
pub const STABLE_TAG: &str = "stable";
/// 稳定版晋级过的版本列表，在 [`STABLE_TAG`] 的 Release 里。
pub const HISTORY_FILE: &str = "history.json";

/// 更新通道。偏好里没有这一项、不认识的值都算稳定版。
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum UpdateChannel {
    #[default]
    Stable,
    Early,
}

impl UpdateChannel {
    /// 偏好里存的值：`"early"` 是抢先版，别的（没有、`"stable"`、不认识的）
    /// 都是稳定版。
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("early") => Self::Early,
            _ => Self::Stable,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stable => "stable",
            Self::Early => "early",
        }
    }
}

/// 这个构建有没有通道可选：配置里的更新源是 GitHub 仓库的 Latest。
pub fn channels_available(config_endpoints: &[String]) -> bool {
    ReleaseSource::from_endpoints(config_endpoints).is_some()
}

/// `channel` 查更新、下载用的清单地址。
///
/// - 抢先版，或者没有通道（配置里不是 GitHub 的 Latest）：配置里的地址原样。
/// - 稳定版：`https://github.com/<仓库>/releases/download/stable/<清单>`。
pub fn channel_endpoints(channel: UpdateChannel, config_endpoints: &[String]) -> Vec<Url> {
    if channel == UpdateChannel::Stable {
        if let Some(source) = ReleaseSource::from_endpoints(config_endpoints) {
            return Url::parse(&source.manifest_url(STABLE_TAG))
                .into_iter()
                .collect();
        }
    }
    config_endpoints
        .iter()
        .filter_map(|endpoint| Url::parse(endpoint).ok())
        .collect()
}

/// `history.json`：稳定版晋级过的版本，新的在前。
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize)]
pub struct StableHistory {
    #[serde(default)]
    pub versions: Vec<StableEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct StableEntry {
    pub version: String,
    pub tag: String,
    #[serde(default)]
    pub promoted_at: Option<String>,
}

/// 稳定版上回退到哪一版：`history` 里（新的在前）第一个比正在运行的
/// `current` 旧的。从抢先版切过来、正在运行的比稳定版还新时，就是现在的
/// 稳定版。版本号读不出来的跳过；没有更旧的回 `None`。
pub fn previous_stable<'a>(
    history: &'a StableHistory,
    current: &Version,
) -> Option<(Version, &'a StableEntry)> {
    previous_stable_where(history, current, |_, _| true)
}

/// 同 [`previous_stable`]，只是 `keep` 回假的版本跳过（回退时用它跳过
/// 没有本机架构自己更新包的那些，见 `rollback::previous_stable_with_package`）。
pub fn previous_stable_where<'a>(
    history: &'a StableHistory,
    current: &Version,
    keep: impl Fn(&Version, &StableEntry) -> bool,
) -> Option<(Version, &'a StableEntry)> {
    history.versions.iter().find_map(|entry| {
        let raw = entry.version.strip_prefix('v').unwrap_or(&entry.version);
        let version = Version::parse(raw).ok()?;
        (version < *current && keep(&version, entry)).then_some((version, entry))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const LATEST: &str =
        "https://github.com/someone/some-releases/releases/latest/download/latest.json";

    fn urls(list: &[Url]) -> Vec<&str> {
        list.iter().map(Url::as_str).collect()
    }

    #[test]
    fn the_channel_is_stable_unless_early() {
        assert_eq!(UpdateChannel::parse(None), UpdateChannel::Stable);
        assert_eq!(UpdateChannel::parse(Some("stable")), UpdateChannel::Stable);
        assert_eq!(UpdateChannel::parse(Some("early")), UpdateChannel::Early);
        assert_eq!(UpdateChannel::parse(Some("beta")), UpdateChannel::Stable);
        assert_eq!(UpdateChannel::Early.as_str(), "early");
        assert_eq!(UpdateChannel::Stable.as_str(), "stable");
        assert_eq!(
            serde_json::to_value(UpdateChannel::Early).unwrap(),
            serde_json::json!("early")
        );
    }

    #[test]
    fn early_uses_the_configured_endpoint() {
        let endpoints = urls_of(&[LATEST]);
        assert_eq!(
            urls(&channel_endpoints(UpdateChannel::Early, &endpoints)),
            vec![LATEST]
        );
        assert!(channels_available(&endpoints));
    }

    #[test]
    fn stable_uses_the_stable_release_of_the_same_repository() {
        let endpoints = urls_of(&[LATEST]);
        assert_eq!(
            urls(&channel_endpoints(UpdateChannel::Stable, &endpoints)),
            vec!["https://github.com/someone/some-releases/releases/download/stable/latest.json"]
        );
        // Intel 的清单名跟着配置走
        let intel = urls_of(&[
            "https://github.com/someone/some-releases/releases/latest/download/latest-x64.json",
        ]);
        assert_eq!(
            urls(&channel_endpoints(UpdateChannel::Stable, &intel)),
            vec![
                "https://github.com/someone/some-releases/releases/download/stable/latest-x64.json"
            ]
        );
    }

    #[test]
    fn without_a_github_latest_source_both_channels_use_the_config() {
        let endpoints = urls_of(&["https://updates.example.com/codeg/latest.json"]);
        for channel in [UpdateChannel::Stable, UpdateChannel::Early] {
            assert_eq!(
                urls(&channel_endpoints(channel, &endpoints)),
                vec!["https://updates.example.com/codeg/latest.json"],
                "{channel:?}"
            );
        }
        assert!(!channels_available(&endpoints));
        assert!(!channels_available(&[]));
        assert!(channel_endpoints(UpdateChannel::Stable, &[]).is_empty());
    }

    fn urls_of(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn history(versions: &[&str]) -> StableHistory {
        StableHistory {
            versions: versions
                .iter()
                .map(|v| StableEntry {
                    version: v.to_string(),
                    tag: format!("v{v}"),
                    promoted_at: Some("2026-11-17T00:00:00Z".to_string()),
                })
                .collect(),
        }
    }

    fn pick(history: &StableHistory, current: &str) -> Option<String> {
        previous_stable(history, &Version::parse(current).unwrap()).map(|(version, entry)| {
            assert_eq!(entry.tag, format!("v{version}"));
            version.to_string()
        })
    }

    #[test]
    fn stable_rollback_goes_to_the_first_older_promoted_version() {
        let promoted = history(&["1.6.41", "1.6.40", "1.6.31"]);
        assert_eq!(pick(&promoted, "1.6.41").as_deref(), Some("1.6.40"));
        // 从抢先版切过来、比稳定版新：回到现在的稳定版
        assert_eq!(pick(&promoted, "1.6.45").as_deref(), Some("1.6.41"));
        assert_eq!(pick(&promoted, "1.6.31"), None);
        assert_eq!(pick(&history(&[]), "1.6.41"), None);
    }

    #[test]
    fn the_history_file_parses() {
        let raw = r#"{"versions":[
            {"version":"1.6.41","tag":"v1.6.41","promoted_at":"2026-11-17T08:00:00Z"},
            {"version":"1.6.40","tag":"v1.6.40"}
        ]}"#;
        let parsed: StableHistory = serde_json::from_str(raw).unwrap();
        assert_eq!(parsed.versions.len(), 2);
        assert_eq!(parsed.versions[1].promoted_at, None);
        assert_eq!(
            serde_json::from_str::<StableHistory>("{}").unwrap(),
            StableHistory::default()
        );
    }
}
