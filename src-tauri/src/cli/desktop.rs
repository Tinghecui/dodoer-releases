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
