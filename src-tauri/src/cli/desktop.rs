//! `desktop proxy --device <id>`: the `ProxyCommand` of a server's
//! `ssh <device>` (`docs/devices.md` 5.1, `docs/host-ssh.md` 5.3).
//!
//! Carries one SSH connection between this process's stdin and stdout and
//! that one of the person's computers, through the runtime this command
//! finds as every other command does (an agent's shell names its own in
//! `CODEG_CLI_ENDPOINT_FILE`). The runtime asks the desktop app on it to dial
//! back (`web::host_tunnel`); nothing here knows where that computer is.
//!
//! stdout is the connection: whatever goes wrong is told on stderr, where
//! `ssh` shows it to whoever ran it.

use std::time::Duration;

use crate::cli_run::wire::capability;
use crate::host_ssh::tunnel;

use super::args::GlobalArgs;
use super::connect::{self, Env};

pub async fn proxy(global: &GlobalArgs, env: &Env, device: Option<&str>) -> i32 {
    let (conn, _) = match connect::connect(global, env).await {
        Ok(found) => found,
        Err(failure) => {
            eprintln!("codeg-cli desktop proxy: {}", failure.message);
            for step in &failure.next_steps {
                eprintln!("  {step}");
            }
            return failure.exit_code();
        }
    };
    if !conn.has(capability::HOST_TUNNEL) {
        eprintln!(
            "codeg-cli desktop proxy: {} reaches no desktop's command line (a desktop app's own \
             runtime never does; an older codeg-server does not yet).",
            conn.source
        );
        return 1;
    }
    let socket =
        match tunnel::dial_cli_end(&conn.url, &conn.token, device, env.caller.as_deref()).await {
            Ok(socket) => socket,
            Err(said) => {
                eprintln!("codeg-cli desktop proxy: {said}");
                return 1;
            }
        };
    match tunnel::relay(
        socket,
        tokio::io::stdin(),
        tokio::io::stdout(),
        std::future::pending(),
    )
    .await
    {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("codeg-cli desktop proxy: the connection to the desktop broke: {e}");
            1
        }
    }
}

/// How long `desktop check` waits for the runtime's answer: `ssh` waits on it.
const CHECK_TIMEOUT: Duration = Duration::from_secs(10);

/// Cowork fork（#991）：`desktop check --device <id>`，`ssh` 配置的
/// `Match … !exec` 每次连之前跑它。只问服务器这条 `ssh` 让不让连
/// （`/api/cli_host_check`，和开隧道时一样的检查），不开隧道。放行退出 0；
/// 不让连就把服务器的说明写到 stderr（这时 `ssh` 还没把它重定向走），退出 1。
pub async fn check(global: &GlobalArgs, env: &Env, device: Option<&str>) -> i32 {
    let (conn, _) = match connect::connect(global, env).await {
        Ok(found) => found,
        Err(failure) => {
            eprintln!("codeg-cli desktop check: {}", failure.message);
            for step in &failure.next_steps {
                eprintln!("  {step}");
            }
            return failure.exit_code();
        }
    };
    if !conn.has(capability::HOST_TUNNEL) {
        eprintln!(
            "codeg-cli desktop check: {} reaches no desktop's command line.",
            conn.source
        );
        return 1;
    }
    let path = match tunnel::cli_check_path(device, env.caller.as_deref()) {
        Ok(path) => path,
        Err(said) => {
            eprintln!("codeg-cli desktop check: {said}");
            return 1;
        }
    };
    let answer = conn
        .client
        .get(format!("{}{path}", conn.url))
        .bearer_auth(conn.token.trim())
        .timeout(CHECK_TIMEOUT)
        .send()
        .await;
    match answer {
        Ok(resp) if resp.status().is_success() => 0,
        Ok(resp) => {
            let status = resp.status();
            let said = resp.text().await.unwrap_or_default();
            eprintln!(
                "codeg-cli desktop check: {}",
                refused_words(status.as_u16(), &said)
            );
            1
        }
        Err(e) => {
            eprintln!("codeg-cli desktop check: could not reach the runtime: {e}");
            1
        }
    }
}

/// What to print for a refusal: the runtime's own words, or its status when
/// it said none.
fn refused_words(status: u16, said: &str) -> String {
    let said = said.trim();
    if !said.is_empty() {
        said.to_string()
    } else if status == 503 {
        tunnel::NO_DESKTOP_NOTE.to_string()
    } else {
        format!("the runtime answered HTTP {status}")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_refusal_is_said_in_the_runtimes_words() {
        assert_eq!(refused_words(428, " not picked \n"), "not picked");
        assert_eq!(refused_words(503, ""), tunnel::NO_DESKTOP_NOTE);
        assert_eq!(refused_words(500, ""), "the runtime answered HTTP 500");
    }
}
