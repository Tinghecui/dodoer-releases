//! Cowork portal → desktop app: `codeg://cowork/connect?url=<workspace>&code=<one-time code>`.
//!
//! The portal's "open in the desktop app" button mints a one-time code (valid
//! for a few minutes, single use) for the signed-in employee and navigates to
//! this link, so the employee never copies a URL or a token by hand. The
//! desktop app:
//!
//! 1. asks the user to confirm the host (anyone can craft a `codeg://` link;
//!    the dialog is what keeps a stray link from adding a server);
//! 2. trades the code for the employee's workspace token at
//!    `<url>/_cowork/desktop-token` — Cowork's nginx forwards that path on
//!    every employee domain to cowork-web, which only answers when the code
//!    was minted for that domain's employee;
//! 3. saves it as a Remote Workspace connection, or refreshes the token of an
//!    existing connection to the same address (so re-linking after a password
//!    change — which rotates the token — is the same click);
//! 4. opens that connection's window, which then takes the place of the local
//!    one like any remote workspace opened from `main`.
//!
//! The parser lives in `deep_link` (`DeepLink::CoworkConnect`); only the
//! desktop runtime acts on it.

use serde::Deserialize;

/// Path the token exchange is posted to, on the workspace's own origin.
pub const TOKEN_PATH: &str = "/_cowork/desktop-token";

#[derive(Debug, Deserialize)]
struct TokenResponse {
    token: String,
    /// Display name for the connection (the employee's label); optional.
    #[serde(default)]
    name: Option<String>,
}

/// What a successful exchange hands back.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Exchanged {
    pub token: String,
    pub name: Option<String>,
}

/// Parse cowork-web's answer. A blank token is an error, not a connection
/// that fails later with a confusing 401.
pub fn parse_token_response(body: &[u8]) -> Result<Exchanged, String> {
    let parsed: TokenResponse =
        serde_json::from_slice(body).map_err(|e| format!("服务器的回答看不懂：{e}"))?;
    let token = parsed.token.trim().to_string();
    if token.is_empty() {
        return Err("服务器没有给出令牌".into());
    }
    let name = parsed
        .name
        .map(|n| n.trim().to_string())
        .filter(|n| !n.is_empty());
    Ok(Exchanged { token, name })
}

/// Two saved base URLs name the same workspace (scheme and host are
/// case-insensitive; a trailing slash is not part of the address).
pub fn same_workspace(a: &str, b: &str) -> bool {
    let norm = |s: &str| s.trim().trim_end_matches('/').to_ascii_lowercase();
    norm(a) == norm(b)
}

/// Host shown in the confirmation dialog.
pub fn display_host(url: &str) -> String {
    reqwest::Url::parse(url)
        .ok()
        .and_then(|u| {
            u.host_str().map(|h| match u.port() {
                Some(p) => format!("{h}:{p}"),
                None => h.to_string(),
            })
        })
        .unwrap_or_else(|| url.to_string())
}

#[cfg(feature = "tauri-runtime")]
pub use desktop::start;

#[cfg(feature = "tauri-runtime")]
mod desktop {
    use std::time::Duration;

    use tauri::{AppHandle, Manager};
    use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

    use super::{display_host, parse_token_response, same_workspace, Exchanged, TOKEN_PATH};
    use crate::commands::remote_workspace::{
        build_remote_workspace_window, validate_remote_health,
    };
    use crate::commands::workspace_windows::WorkspaceWindow;
    use crate::db::service::remote_workspace_connection_service as connections;
    use crate::db::AppDatabase;

    const EXCHANGE_TIMEOUT: Duration = Duration::from_secs(15);
    const EXPIRED: &str =
        "这个链接已经失效（几分钟内有效，只能用一次）。回到 Cowork 门户「我的账户」再点一次「在桌面 app 里打开」。";

    /// Run the whole flow in the background; failures end in an error dialog.
    pub fn start(app: &AppHandle, url: String, code: String) {
        let app = app.clone();
        tauri::async_runtime::spawn(async move {
            if let Err(message) = run(&app, &url, &code).await {
                tracing::warn!("[cowork-connect] {url}: {message}");
                app.dialog()
                    .message(message)
                    .title("Cowork")
                    .kind(MessageDialogKind::Error)
                    .show(|_| {});
            }
        });
    }

    async fn run(app: &AppHandle, url: &str, code: &str) -> Result<(), String> {
        let host = display_host(url);
        if !confirm(app, &host).await {
            return Ok(());
        }
        let Exchanged { token, name } = exchange(url, code).await?;

        let db = app
            .try_state::<AppDatabase>()
            .ok_or_else(|| "应用还没准备好，稍后再点一次链接".to_string())?;
        let saved = connections::list(&db.conn)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|c| same_workspace(&c.base_url, url));
        let connection = match saved {
            Some(c) => {
                let updated =
                    connections::update(&db.conn, c.id, &c.name, &c.base_url, &token, &c.headers)
                        .await
                        .map_err(|e| e.to_string())?;
                if c.token != token {
                    // Same as editing the token by hand: the built-in
                    // browser's tunnel follows the connection.
                    crate::browser::remote::connection_changed(app, c.id).await;
                }
                updated
            }
            None => {
                let label = name.unwrap_or_else(|| host.clone());
                connections::create(&db.conn, &format!("Cowork · {label}"), url, &token, &[])
                    .await
                    .map_err(|e| e.to_string())?
            }
        };

        let label = WorkspaceWindow::Remote {
            connection_id: connection.id,
        }
        .label();
        if app.get_webview_window(&label).is_some() {
            // Its transport picks the new token up on the next reconnect.
            crate::commands::windows::show_and_focus_window(app, &label);
        } else {
            validate_remote_health(&connection.base_url, &connection.token, &connection.headers)
                .await
                .map_err(|e| e.to_string())?;
            build_remote_workspace_window(app, &connection, true).map_err(|e| e.to_string())?;
        }
        if crate::commands::windows::can_hide_to_tray() {
            crate::commands::windows::hide_main_to_tray(app);
        }
        Ok(())
    }

    async fn confirm(app: &AppHandle, host: &str) -> bool {
        let (tx, rx) = tokio::sync::oneshot::channel();
        app.dialog()
            .message(format!(
                "要把 {host} 添加为远端工作区并打开吗？\n\n这是 Cowork 门户「在桌面 app 里打开」生成的链接。如果不是你刚刚在门户里点的，请选「取消」。"
            ))
            .title("Cowork")
            .kind(MessageDialogKind::Info)
            .buttons(MessageDialogButtons::OkCancelCustom(
                "连接".into(),
                "取消".into(),
            ))
            .show(move |ok| {
                let _ = tx.send(ok);
            });
        rx.await.unwrap_or(false)
    }

    async fn exchange(url: &str, code: &str) -> Result<Exchanged, String> {
        let client = reqwest::Client::builder()
            .timeout(EXCHANGE_TIMEOUT)
            // The code is only good for this host; never follow it elsewhere.
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|e| e.to_string())?;
        let response = client
            .post(format!("{}{TOKEN_PATH}", url.trim_end_matches('/')))
            .json(&serde_json::json!({ "code": code }))
            .send()
            .await
            .map_err(|e| {
                format!(
                    "连不上 {}：{}",
                    display_host(url),
                    crate::commands::remote_proxy::request_error_detail(&e)
                )
            })?;
        let status = response.status();
        if status.is_success() {
            let body = response.bytes().await.map_err(|e| e.to_string())?;
            return parse_token_response(&body);
        }
        // 404 from an older cowork (no such location) reads the same as an
        // unknown code: the user's next step is the portal either way.
        if matches!(status.as_u16(), 400 | 401 | 403 | 404 | 410) {
            return Err(EXPIRED.into());
        }
        Err(format!("{} 回答 HTTP {status}", display_host(url)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_token_and_optional_name() {
        assert_eq!(
            parse_token_response(br#"{"token":" s3cret ","name":"James"}"#),
            Ok(Exchanged {
                token: "s3cret".into(),
                name: Some("James".into())
            })
        );
        assert_eq!(
            parse_token_response(br#"{"token":"s3cret","name":"  "}"#),
            Ok(Exchanged {
                token: "s3cret".into(),
                name: None
            })
        );
        assert_eq!(
            parse_token_response(br#"{"token":"s3cret"}"#).map(|e| e.name),
            Ok(None)
        );
    }

    #[test]
    fn rejects_blank_or_malformed_answers() {
        assert!(parse_token_response(br#"{"token":"  "}"#).is_err());
        assert!(parse_token_response(br#"{"name":"x"}"#).is_err());
        assert!(parse_token_response(b"<html>").is_err());
    }

    #[test]
    fn same_workspace_ignores_case_and_trailing_slash() {
        assert!(same_workspace(
            "https://James.Example.com/",
            "https://james.example.com"
        ));
        assert!(!same_workspace(
            "https://james.example.com",
            "https://jenny.example.com"
        ));
    }

    #[test]
    fn display_host_keeps_a_non_default_port() {
        assert_eq!(
            display_host("https://james.example.com"),
            "james.example.com"
        );
        assert_eq!(
            display_host("https://james.example.com:8443"),
            "james.example.com:8443"
        );
    }
}
