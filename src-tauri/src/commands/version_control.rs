use serde::Deserialize;
#[cfg(feature = "tauri-runtime")]
use tauri::State;

use crate::app_error::AppCommandError;
use crate::db::service::app_metadata_service;
#[cfg(feature = "tauri-runtime")]
use crate::db::AppDatabase;
use crate::models::GitDetectResult;
#[cfg(feature = "tauri-runtime")]
use crate::models::GitHubAccountsSettings;
use crate::models::{GitHubTokenValidation, GitSettings};

const GIT_SETTINGS_KEY: &str = "git_settings";
#[cfg(feature = "tauri-runtime")]
const GITHUB_ACCOUNTS_KEY: &str = "github_accounts";

// ---------------------------------------------------------------------------
// Git detection
// ---------------------------------------------------------------------------

async fn run_git_version(git_path: &str) -> Result<GitDetectResult, AppCommandError> {
    let output = crate::process::tokio_command(git_path)
        .arg("--version")
        .output()
        .await
        .map_err(|_| AppCommandError::not_found(format!("Cannot execute git at: {git_path}")))?;

    if !output.status.success() {
        return Ok(GitDetectResult {
            installed: false,
            version: None,
            path: Some(git_path.to_string()),
        });
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    let version = stdout
        .trim()
        .strip_prefix("git version ")
        .unwrap_or(stdout.trim())
        .to_string();

    Ok(GitDetectResult {
        installed: true,
        version: Some(version),
        path: Some(git_path.to_string()),
    })
}

async fn detect_git_path() -> Option<String> {
    let which_cmd = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };

    let output = crate::process::tokio_command(which_cmd)
        .arg("git")
        .output()
        .await
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let path = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();

    if path.is_empty() {
        None
    } else {
        Some(path)
    }
}

pub(crate) async fn detect_git_core(
    conn: &sea_orm::DatabaseConnection,
) -> Result<GitDetectResult, AppCommandError> {
    let settings = load_git_settings(conn).await?;

    if let Some(custom) = &settings.custom_path {
        let trimmed = custom.trim();
        if !trimmed.is_empty() {
            return run_git_version(trimmed).await;
        }
    }

    if let Some(path) = detect_git_path().await {
        return run_git_version(&path).await;
    }

    match run_git_version("git").await {
        Ok(result) if result.installed => Ok(result),
        _ => Ok(GitDetectResult {
            installed: false,
            version: None,
            path: None,
        }),
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn detect_git(db: State<'_, AppDatabase>) -> Result<GitDetectResult, AppCommandError> {
    detect_git_core(&db.conn).await
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn test_git_path(path: String) -> Result<GitDetectResult, AppCommandError> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("Git path cannot be empty"));
    }
    run_git_version(trimmed).await
}

// ---------------------------------------------------------------------------
// Git settings
// ---------------------------------------------------------------------------

async fn load_git_settings(
    conn: &sea_orm::DatabaseConnection,
) -> Result<GitSettings, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, GIT_SETTINGS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    match raw {
        Some(raw) => serde_json::from_str::<GitSettings>(&raw).map_err(|e| {
            AppCommandError::configuration_invalid("Failed to parse stored git settings")
                .with_detail(e.to_string())
        }),
        None => Ok(GitSettings::default()),
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_git_settings(db: State<'_, AppDatabase>) -> Result<GitSettings, AppCommandError> {
    load_git_settings(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_git_settings(
    settings: GitSettings,
    db: State<'_, AppDatabase>,
) -> Result<GitSettings, AppCommandError> {
    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize git settings")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, GIT_SETTINGS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    Ok(settings)
}

// ---------------------------------------------------------------------------
// GitHub accounts
// ---------------------------------------------------------------------------

#[cfg(feature = "tauri-runtime")]
async fn load_github_accounts(
    conn: &sea_orm::DatabaseConnection,
) -> Result<GitHubAccountsSettings, AppCommandError> {
    let raw = app_metadata_service::get_value(conn, GITHUB_ACCOUNTS_KEY)
        .await
        .map_err(AppCommandError::from)?;

    match raw {
        Some(raw) => serde_json::from_str::<GitHubAccountsSettings>(&raw).map_err(|e| {
            AppCommandError::configuration_invalid("Failed to parse stored GitHub accounts")
                .with_detail(e.to_string())
        }),
        None => Ok(GitHubAccountsSettings::default()),
    }
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_github_accounts(
    db: State<'_, AppDatabase>,
) -> Result<GitHubAccountsSettings, AppCommandError> {
    load_github_accounts(&db.conn).await
}

#[cfg(feature = "tauri-runtime")]
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn update_github_accounts(
    settings: GitHubAccountsSettings,
    db: State<'_, AppDatabase>,
) -> Result<GitHubAccountsSettings, AppCommandError> {
    let serialized = serde_json::to_string(&settings).map_err(|e| {
        AppCommandError::invalid_input("Failed to serialize GitHub accounts")
            .with_detail(e.to_string())
    })?;

    app_metadata_service::upsert_value(&db.conn, GITHUB_ACCOUNTS_KEY, &serialized)
        .await
        .map_err(AppCommandError::from)?;

    Ok(settings)
}

// ---------------------------------------------------------------------------
// Keyring token management
// ---------------------------------------------------------------------------

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn save_account_token(account_id: String, token: String) -> Result<(), AppCommandError> {
    crate::keyring_store::set_token(&account_id, &token)
        .map_err(|e| AppCommandError::io_error("Failed to save token to keyring").with_detail(e))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn get_account_token(account_id: String) -> Result<Option<String>, AppCommandError> {
    Ok(crate::keyring_store::get_token(&account_id))
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn delete_account_token(account_id: String) -> Result<(), AppCommandError> {
    crate::keyring_store::delete_token(&account_id).map_err(|e| {
        AppCommandError::io_error("Failed to delete token from keyring").with_detail(e)
    })
}

// ---------------------------------------------------------------------------
// GitHub token validation
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GitHubUserResponse {
    login: String,
    avatar_url: Option<String>,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn validate_github_token(
    server_url: String,
    token: String,
) -> Result<GitHubTokenValidation, AppCommandError> {
    let trimmed_url = server_url.trim().trim_end_matches('/');
    let trimmed_token = token.trim();

    if trimmed_token.is_empty() {
        return Err(AppCommandError::invalid_input("Token cannot be empty"));
    }

    // Build API URL: github.com uses api.github.com, enterprise uses {url}/api/v3
    let api_url = if trimmed_url.is_empty()
        || trimmed_url == "https://github.com"
        || trimmed_url == "http://github.com"
    {
        "https://api.github.com/user".to_string()
    } else {
        format!("{trimmed_url}/api/v3/user")
    };

    let response = reqwest::Client::new()
        .get(&api_url)
        .header("Authorization", format!("Bearer {trimmed_token}"))
        .header("User-Agent", "codeg")
        .header("Accept", "application/vnd.github+json")
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to connect to GitHub API").with_detail(e.to_string())
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let message = if status == 401 {
            "Invalid or expired token".to_string()
        } else {
            format!("GitHub API returned status {status}: {body}")
        };
        return Ok(GitHubTokenValidation {
            success: false,
            username: None,
            scopes: vec![],
            avatar_url: None,
            message: Some(message),
        });
    }

    // Parse scopes from x-oauth-scopes header
    let scopes: Vec<String> = response
        .headers()
        .get("x-oauth-scopes")
        .and_then(|v| v.to_str().ok())
        .map(|s| {
            s.split(',')
                .map(|scope| scope.trim().to_string())
                .filter(|scope| !scope.is_empty())
                .collect()
        })
        .unwrap_or_default();

    let user = response.json::<GitHubUserResponse>().await.map_err(|e| {
        AppCommandError::network("Failed to parse GitHub API response").with_detail(e.to_string())
    })?;

    Ok(GitHubTokenValidation {
        success: true,
        username: Some(user.login),
        scopes,
        avatar_url: user.avatar_url,
        message: None,
    })
}

// ---------------------------------------------------------------------------
// GitLab token validation
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct GitLabUserResponse {
    username: String,
    avatar_url: Option<String>,
}

/// Validate a GitLab personal access token against `GET /api/v4/user`.
///
/// GitLab has no `gh auth token` equivalent to lift a credential from, so a
/// PAT typed into the dialog is the only way in — which makes checking it here
/// worth the round trip: the alternative is finding out at delivery time, on a
/// task that already ran.
///
/// Scopes come from `GET /api/v4/personal_access_tokens/self` (a separate
/// endpoint; unlike GitHub, they are not a response header). That call is
/// best-effort: it needs the token to be a PAT and the instance to be recent
/// enough, and an empty scope list is only ever used for an advisory warning.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn validate_gitlab_token(
    server_url: String,
    token: String,
) -> Result<GitHubTokenValidation, AppCommandError> {
    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(AppCommandError::invalid_input("Token cannot be empty"));
    }
    let origin = {
        let base = server_url.trim().trim_end_matches('/');
        if base.is_empty() {
            "https://gitlab.com".to_string()
        } else if base.contains("://") {
            base.to_string()
        } else {
            format!("https://{base}")
        }
    };

    let client = reqwest::Client::new();
    let response = client
        .get(format!("{origin}/api/v4/user"))
        .header("PRIVATE-TOKEN", trimmed_token)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to connect to GitLab API").with_detail(e.to_string())
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let message = if status == 401 {
            "Invalid or expired token".to_string()
        } else {
            format!("GitLab API returned status {status}: {body}")
        };
        return Ok(GitHubTokenValidation {
            success: false,
            username: None,
            scopes: vec![],
            avatar_url: None,
            message: Some(message),
        });
    }

    let user = response.json::<GitLabUserResponse>().await.map_err(|e| {
        AppCommandError::network("Failed to parse GitLab API response").with_detail(e.to_string())
    })?;

    #[derive(Deserialize)]
    struct GitLabTokenSelf {
        #[serde(default)]
        scopes: Vec<String>,
    }
    let mut scopes = Vec::new();
    if let Ok(response) = client
        .get(format!("{origin}/api/v4/personal_access_tokens/self"))
        .header("PRIVATE-TOKEN", trimmed_token)
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
    {
        if response.status().is_success() {
            if let Ok(token_self) = response.json::<GitLabTokenSelf>().await {
                scopes = token_self.scopes;
            }
        }
    }

    Ok(GitHubTokenValidation {
        success: true,
        username: Some(user.username),
        scopes,
        avatar_url: user.avatar_url,
        message: None,
    })
}

// ---------------------------------------------------------------------------
// Gitea token validation
// ---------------------------------------------------------------------------

/// Validate a Gitea (or Forgejo) access token against `GET /api/v1/user`.
///
/// The response is GitHub's shape — `login`, `avatar_url` — which is the first
/// of many places Gitea is easier to read as a GitHub dialect than as its own
/// thing. The AUTH is not: `Authorization: token <t>`, not `Bearer`.
///
/// Scopes come back EMPTY, always, and that is a limitation rather than an
/// oversight: Gitea reports a token's scopes only from
/// `GET /users/{name}/tokens`, which requires basic auth with the user's
/// password and refuses the very token being checked. An empty list is
/// already what a GitHub fine-grained token produces, and nothing gates on it
/// (see `ResolvedAuth::scopes`) — it is shown, not enforced.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn validate_gitea_token(
    server_url: String,
    token: String,
) -> Result<GitHubTokenValidation, AppCommandError> {
    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(AppCommandError::invalid_input("Token cannot be empty"));
    }
    // No public-service special case, unlike GitHub's `api.github.com`: every
    // Gitea — gitea.com and codeberg.org included — mounts its API under its
    // own origin, so there is one derivation and no host to exempt from it.
    let origin = {
        let base = server_url.trim().trim_end_matches('/');
        if base.is_empty() {
            return Err(AppCommandError::invalid_input(
                "A Gitea server URL is required",
            ));
        } else if base.contains("://") {
            base.to_string()
        } else {
            format!("https://{base}")
        }
    };

    let response = reqwest::Client::new()
        .get(format!("{origin}/api/v1/user"))
        .header("Authorization", format!("token {trimmed_token}"))
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to connect to Gitea API").with_detail(e.to_string())
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let message = if status == 401 {
            "Invalid or expired token".to_string()
        } else {
            format!("Gitea API returned status {status}: {body}")
        };
        return Ok(GitHubTokenValidation {
            success: false,
            username: None,
            scopes: vec![],
            avatar_url: None,
            message: Some(message),
        });
    }

    let user = response.json::<GitHubUserResponse>().await.map_err(|e| {
        AppCommandError::network("Failed to parse Gitea API response").with_detail(e.to_string())
    })?;

    Ok(GitHubTokenValidation {
        success: true,
        username: Some(user.login),
        scopes: vec![],
        avatar_url: user.avatar_url,
        message: None,
    })
}

// ---------------------------------------------------------------------------
// CNB token validation
// ---------------------------------------------------------------------------

/// Validate a CNB access token against `GET /user`.
///
/// CNB is the one forge whose API is NOT under the instance origin: the web UI
/// is `https://cnb.cool`, the OpenAPI is `https://api.cnb.cool`, and the auth
/// header is `Bearer <token>`. The response shape is CNB's own —
/// `{username, nickname, avatar}`.
///
/// Scopes are not reported by this endpoint, so the list is empty. Nothing
/// gates on scopes (see `ResolvedAuth::scopes`); a token missing a permission
/// says so at the first API call, with CNB's own `errmsg`.
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn validate_cnb_token(
    server_url: String,
    token: String,
) -> Result<GitHubTokenValidation, AppCommandError> {
    let trimmed_token = token.trim();
    if trimmed_token.is_empty() {
        return Err(AppCommandError::invalid_input("Token cannot be empty"));
    }
    let origin = {
        let base = server_url.trim().trim_end_matches('/');
        if base.is_empty() {
            "https://cnb.cool".to_string()
        } else if base.contains("://") {
            base.to_string()
        } else {
            format!("https://{base}")
        }
    };
    // The SaaS separates UI and API hosts; anything else is assumed to mount
    // the API under `/api`, which is what `forge::auth::api_base_for` does.
    let host = origin
        .split_once("://")
        .map(|(_, rest)| rest)
        .unwrap_or(&origin)
        .split('/')
        .next()
        .unwrap_or("")
        .split(':')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    let api_base = if host == "cnb.cool" {
        "https://api.cnb.cool".to_string()
    } else {
        format!("{origin}/api")
    };

    let response = reqwest::Client::new()
        .get(format!("{api_base}/user"))
        .header("Authorization", format!("Bearer {trimmed_token}"))
        .header("User-Agent", "codeg")
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| {
            AppCommandError::network("Failed to connect to CNB API").with_detail(e.to_string())
        })?;

    if !response.status().is_success() {
        let status = response.status().as_u16();
        let body = response.text().await.unwrap_or_default();
        let detail = serde_json::from_str::<CnbError>(&body)
            .ok()
            .and_then(|e| e.errmsg)
            .filter(|m| !m.trim().is_empty())
            .unwrap_or(body);
        // 403 is NOT a bad token here: CNB answers it when the token is valid
        // but was minted without the `account-profile:r` scope this check
        // needs, and its `errmsg` names the missing scope. Reporting that as
        // "invalid token" sends the user to re-mint the same token again.
        let message = match status {
            401 => "Invalid or expired token".to_string(),
            403 => format!("The token is valid but lacks a required scope: {detail}"),
            _ => format!("CNB API returned status {status}: {detail}"),
        };
        return Ok(GitHubTokenValidation {
            success: false,
            username: None,
            scopes: vec![],
            avatar_url: None,
            message: Some(message),
        });
    }

    let user = response.json::<CnbUserResponse>().await.map_err(|e| {
        AppCommandError::network("Failed to parse CNB API response").with_detail(e.to_string())
    })?;

    Ok(GitHubTokenValidation {
        success: true,
        username: user
            .username
            .filter(|u| !u.trim().is_empty())
            .or(user.nickname.filter(|n| !n.trim().is_empty())),
        scopes: vec![],
        avatar_url: user.avatar,
        message: None,
    })
}

#[derive(Debug, Deserialize)]
struct CnbUserResponse {
    #[serde(default)]
    username: Option<String>,
    #[serde(default)]
    nickname: Option<String>,
    #[serde(default)]
    avatar: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CnbError {
    #[serde(default)]
    errmsg: Option<String>,
}

// ---------------------------------------------------------------------------
// Plain git server probe
// ---------------------------------------------------------------------------

/// 普通 Git 服务器账号的「测试」用到的超时：连不上的地址不该让按钮一直转。
const GIT_SERVER_PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(8);

/// 把账号里存的服务器地址规范成 http(s) 地址：没写协议的补 `https://`，
/// 协议不是 http/https、没有主机名、根本解析不了的都拒绝。
fn parse_git_server_url(server_url: &str) -> Result<reqwest::Url, AppCommandError> {
    let trimmed = server_url.trim();
    if trimmed.is_empty() {
        return Err(AppCommandError::invalid_input("A server URL is required"));
    }
    let candidate = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let invalid =
        || AppCommandError::invalid_input(format!("Not an http(s) server URL: {trimmed}"));
    if candidate.chars().any(char::is_whitespace) {
        return Err(invalid());
    }
    let url = reqwest::Url::parse(&candidate).map_err(|_| invalid())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none_or(str::is_empty) {
        return Err(invalid());
    }
    Ok(url)
}

/// 普通 Git 服务器（Bitbucket、自建服务等）没有统一的令牌校验接口，
/// 只能确认服务器能不能连上：对地址发一次 GET，收到任何 HTTP 响应（包括 401、404）
/// 都算连得上；DNS 解析失败、连不上、超时、TLS 出错时 `success: false`，
/// `message` 里写原因。地址本身不合法时直接返回错误。
#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn probe_git_server(
    server_url: String,
) -> Result<GitHubTokenValidation, AppCommandError> {
    let url = parse_git_server_url(&server_url)?;
    // 不跟随重定向：3xx 本身就是服务器回的 HTTP 响应，跟过去目标连不上会被误报成连不上
    let client = reqwest::Client::builder()
        .timeout(GIT_SERVER_PROBE_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| {
            AppCommandError::network("Failed to build HTTP client").with_detail(e.to_string())
        })?;
    let (success, message) = match client.get(url).header("User-Agent", "codeg").send().await {
        Ok(_) => (true, None),
        Err(e) => (false, Some(describe_probe_error(&e))),
    };
    Ok(GitHubTokenValidation {
        success,
        username: None,
        scopes: vec![],
        avatar_url: None,
        message,
    })
}

/// reqwest 自己的错误文字只有「error sending request for url (…)」，
/// 真正的原因（DNS、拒绝连接、证书）在 source 链里，一起拼出来。
fn describe_probe_error(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        return format!("timed out after {}s", GIT_SERVER_PROBE_TIMEOUT.as_secs());
    }
    let mut parts: Vec<String> = Vec::new();
    let mut source = std::error::Error::source(e);
    while let Some(cause) = source {
        let text = cause.to_string();
        if !text.is_empty() && !parts.iter().any(|p| p.contains(&text)) {
            parts.push(text);
        }
        source = cause.source();
    }
    if parts.is_empty() {
        e.to_string()
    } else {
        parts.join(": ")
    }
}

#[cfg(test)]
mod probe_tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    #[test]
    fn rejects_addresses_that_are_not_http_urls() {
        for bad in [
            "not a url !!",
            "ftp://git.example.test",
            "",
            "https://",
            "file:///tmp/x",
        ] {
            assert!(
                parse_git_server_url(bad).is_err(),
                "{bad:?} should be rejected"
            );
        }
    }

    #[test]
    fn adds_https_to_a_bare_host() {
        let url = parse_git_server_url(" git.example.test ").unwrap();
        assert_eq!(url.as_str(), "https://git.example.test/");
    }

    #[tokio::test]
    async fn invalid_address_is_an_error() {
        assert!(probe_git_server("not a url !!".into()).await.is_err());
    }

    #[tokio::test]
    async fn unreachable_server_reports_failure_with_reason() {
        // 先占一个端口再放掉，保证这个端口上没人监听
        let listener = std::net::TcpListener::bind("localhost:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let result = probe_git_server(format!("http://localhost:{port}"))
            .await
            .unwrap();
        assert!(!result.success, "a closed port must not count as reachable");
        let message = result.message.unwrap_or_default();
        assert!(!message.is_empty());
        // 原因要写出来，不能只有 reqwest 那句笼统的 error sending request
        assert!(!message.starts_with("error sending request"), "{message}");
    }

    #[tokio::test]
    async fn any_http_response_counts_as_reachable() {
        let listener = tokio::net::TcpListener::bind("localhost:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let _ = sock
                .write_all(
                    b"HTTP/1.1 401 Unauthorized\r\ncontent-length: 0\r\nconnection: close\r\n\r\n",
                )
                .await;
        });

        let result = probe_git_server(format!("http://localhost:{port}/scm"))
            .await
            .unwrap();
        assert!(result.success, "{:?}", result.message);
    }

    #[tokio::test]
    async fn redirect_response_counts_as_reachable_without_following() {
        // 重定向指向一个没人监听的端口：服务器已经回了 HTTP 响应，不能跟过去再报失败
        let closed = std::net::TcpListener::bind("localhost:0").unwrap();
        let closed_port = closed.local_addr().unwrap().port();
        drop(closed);

        let listener = tokio::net::TcpListener::bind("localhost:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = sock.read(&mut buf).await;
            let response = format!(
                "HTTP/1.1 302 Found\r\nlocation: http://localhost:{closed_port}/login\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = sock.write_all(response.as_bytes()).await;
        });

        let result = probe_git_server(format!("http://localhost:{port}"))
            .await
            .unwrap();
        assert!(result.success, "{:?}", result.message);
    }
}
