use serde::Serialize;

use crate::app_error::{AppCommandError, AppErrorCode};

#[derive(Debug, thiserror::Error)]
pub enum AcpError {
    #[error("agent process failed to spawn: {0}")]
    SpawnFailed(String),
    #[error("connection not found: {0}")]
    ConnectionNotFound(String),
    #[error("ACP protocol error: {0}")]
    Protocol(String),
    #[error("agent process exited unexpectedly")]
    ProcessExited,
    /// A prompt arrived while this connection already had a turn in flight.
    /// The connection loop processes one turn at a time; a second concurrent
    /// prompt (e.g. two co-controlling clients sending near-simultaneously)
    /// is rejected here rather than silently dropped after a false success.
    /// The frontend recognizes this (via the stable Display text, carried as
    /// the error message on both transports) and re-queues the draft in the
    /// message queue above the input box instead of surfacing an error.
    #[error("turn already in progress for this connection")]
    TurnInProgress,
    /// Live feedback was submitted while no turn was in flight. Feedback only
    /// makes sense while the agent is working (it is pulled mid-turn via the
    /// `check_user_feedback` MCP tool); with no active turn there is nothing to
    /// steer. The frontend recognizes this (stable Display text) and falls back
    /// to sending the text as an ordinary prompt instead.
    #[error("no active turn to send feedback to")]
    NoActiveTurn,
    /// Live feedback was submitted while the feature is disabled. The settings
    /// toggle gates both MCP tool injection and the UI affordance; this is the
    /// backend's defense-in-depth for a direct/stale call.
    #[error("live feedback is disabled")]
    FeedbackDisabled,
    /// The submitted feedback note is empty or exceeds the per-note size bound.
    /// The full text rides in the broadcast event + snapshot + MCP response, so
    /// a sanity bound keeps a single pathological note from bloating them.
    #[error("invalid feedback: {0}")]
    InvalidFeedback(String),
    /// pi was asked to start in a folder that pi's own trust store already marks
    /// trusted, without anyone in codeg having confirmed that grant. Trusting a
    /// folder lets the repository execute its `.pi/extensions` at pi startup, and
    /// older codeg builds wrote those grants automatically for every folder they
    /// opened — so the launch fails closed until the user answers for it. Carries
    /// the explanation shown to the user; the project-trust notice resolves it.
    #[error("{0}")]
    PiProjectTrustRequired(String),
    #[error("binary download failed: {0}")]
    DownloadFailed(String),
    #[error("platform not supported: {0}")]
    PlatformNotSupported(String),
    #[error("{0}")]
    SdkNotInstalled(String),
    #[error("Agent did not respond to Initialize within 60 seconds. The cached binary may be outdated or incompatible. Try upgrading it from Agent Settings.")]
    InitializeTimeout,
    #[error("Agent did not publish its configurable options within 60 seconds. The probe was aborted; the agent may be slow, idle, or not ACP-compliant — try again or check the agent binary.")]
    ProbeTimedOut,
    /// `session/new` failed on a **custom** agent that codeg had just handed
    /// MCP servers on the wire. That is the exact failure
    /// `CustomAgentDef::supports_mcp` exists to let the user avoid: an
    /// arbitrary third-party ACP binary may reject a non-empty `mcpServers`
    /// outright and never open a session.
    ///
    /// codeg cannot distinguish this from an unrelated `session/new` failure,
    /// so it is a *hint*, not a diagnosis — the payload stays the agent's own
    /// message and the frontend renders the suggestion alongside it.
    #[error("{0}")]
    McpRejectedByAgent(String),
    /// The agent refused to OPEN a session with ACP's `authRequired` (-32000):
    /// it launched fine and simply has no credential it can use. Distinct from
    /// the same rejection on `session/prompt`, which is turn-scoped and leaves
    /// the connection alive (`turn_failed_auth_required`).
    ///
    /// It earns a code of its own because the agent's own wording is the part
    /// the user cannot act on. cursor-agent, for one, answers `Please run
    /// 'agent login' first` — and `agent` is not a command that exists: the
    /// binary is `cursor-agent`, and codeg's managed copy is not on `$PATH`
    /// either. The frontend renders codeg's instruction from the code instead
    /// and points at the agent's own settings panel, which knows the path.
    #[error("{0}")]
    AgentAuthRequired(String),
    /// The agent launched, but its own runtime is too old for the ACP adapter
    /// codeg pins, so no session can open. pi is the case today: pi-acp asks pi
    /// for the current model's thinking levels while opening every session, and
    /// a pi that predates that RPC answers `Unknown command`. Recognised from that
    /// answer rather than predicted from a version string (see
    /// `acp::connection::pi_runtime_is_outdated`). Carries codeg's upgrade
    /// instructions — which version is needed and how to get it — shown as the
    /// notification's detail under the localized headline.
    #[error("{0}")]
    AgentRuntimeOutdated(String),
    /// A prompt for a conversation the user moved to another folder arrived on
    /// a connection that was started in the folder it left. Sending it would
    /// run the turn in the old directory, so it is refused before any side
    /// effect; the client re-points its tab at `folder_id` and the next
    /// connection starts there. The frontend recognizes the stable Display
    /// text (both transports carry it as the message).
    #[error("conversation moved to another folder (folder {folder_id})")]
    ConversationMoved {
        conversation_id: i32,
        folder_id: i32,
    },
    /// 调用方给的参数不对（如技能 id 带路径分隔符）。和 `Protocol` 分开，
    /// 是为了网页接口能回 400 而不是 500；文字原样显示，没有前缀。
    #[error("{0}")]
    InvalidInput(String),
    /// The images in one prompt would not fit in one message to the agent:
    /// the Claude and Codex adapters drop the connection on a message over
    /// 32 MiB, and the user saw only "Broken pipe". Refused before anything is
    /// sent (`acp::prompt_hydration`). Carries the English sentence built by
    /// [`AcpError::prompt_images_too_large`]; the frontend recognizes its
    /// stable wording (both transports carry it as the message) and reads the
    /// two sizes back out of it for its own localized message.
    #[error("{0}")]
    PromptImagesTooLarge(String),
    /// Cowork 加的（#423）：智能体对这条消息回了 `ResourceNotFound`——它那边已经没有
    /// 这个会话了（比如底下的 Claude CLI 被杀了、适配器还活着），这一轮根本没开始。
    /// 连接照旧结束；前端按代码 `session_lost` 自动重连、把这条消息再发一次，
    /// 再失败才显示本地化的说明。不带智能体的原文（里面是 sessionId 的 JSON）。
    #[error("the agent's session has ended; this message was not run")]
    SessionLost,
}

impl AcpError {
    pub fn protocol(raw: impl Into<String>) -> Self {
        let raw = raw.into();
        let sanitized = sanitize_protocol_message(&raw);

        if is_executable_format_error(&sanitized) {
            return Self::Protocol(
                "Agent executable appears incompatible or corrupted. Please retry to re-download it."
                    .into(),
            );
        }

        Self::Protocol(sanitized)
    }

    /// [`Self::InvalidInput`]，和 [`Self::protocol`] 一样去掉启动元数据。
    pub fn invalid_input(raw: impl Into<String>) -> Self {
        Self::InvalidInput(sanitize_protocol_message(&raw.into()))
    }

    /// [`Self::McpRejectedByAgent`] with the same sanitization
    /// [`Self::protocol`] applies — the agent's message is still shown, so it
    /// drops the spawn metadata too.
    pub fn mcp_rejected(raw: impl Into<String>) -> Self {
        Self::McpRejectedByAgent(sanitize_protocol_message(&raw.into()))
    }

    /// [`Self::AgentAuthRequired`] with the same sanitization. The payload is
    /// only a fallback (logs, and any surface that has no code mapping); the
    /// user-facing wording comes from the code.
    pub fn agent_auth_required(raw: impl Into<String>) -> Self {
        Self::AgentAuthRequired(sanitize_protocol_message(&raw.into()))
    }

    /// [`Self::PromptImagesTooLarge`] for images that come to `encoded_bytes`
    /// once base64-encoded, against a cap of `limit_bytes`. The wording is
    /// read by `src/lib/prompt-images-too-large.ts`: keep the two in step.
    pub fn prompt_images_too_large(encoded_bytes: u64, limit_bytes: u64) -> Self {
        const MIB: u64 = 1024 * 1024;
        Self::PromptImagesTooLarge(format!(
            "the images in this message are too big for the agent to accept \
             ({:.1} MiB once encoded, the limit is {} MiB). Send fewer or smaller images.",
            encoded_bytes as f64 / MIB as f64,
            limit_bytes / MIB
        ))
    }

    /// Stable machine-readable identifier for this error kind.
    ///
    /// Returned to the frontend alongside the human-readable message so
    /// the UI can render a localized message based on the code instead
    /// of parsing English text. `None` means "no stable code — show the
    /// raw message as a fallback".
    pub fn code(&self) -> Option<&'static str> {
        match self {
            Self::SdkNotInstalled(_) => Some("sdk_not_installed"),
            Self::PiProjectTrustRequired(_) => Some("pi_project_trust_required"),
            Self::PlatformNotSupported(_) => Some("platform_not_supported"),
            Self::InitializeTimeout => Some("initialize_timeout"),
            Self::ProbeTimedOut => Some("probe_timed_out"),
            Self::ProcessExited => Some("process_exited"),
            Self::TurnInProgress => Some("turn_in_progress"),
            Self::NoActiveTurn => Some("no_active_turn"),
            Self::FeedbackDisabled => Some("feedback_disabled"),
            Self::InvalidFeedback(_) => Some("invalid_feedback"),
            Self::SpawnFailed(_) => Some("spawn_failed"),
            Self::DownloadFailed(_) => Some("download_failed"),
            Self::ConnectionNotFound(_) => Some("connection_not_found"),
            Self::McpRejectedByAgent(_) => Some("mcp_rejected_by_agent"),
            Self::AgentAuthRequired(_) => Some("agent_auth_required"),
            Self::AgentRuntimeOutdated(_) => Some("agent_runtime_outdated"),
            Self::ConversationMoved { .. } => Some("conversation_moved"),
            Self::PromptImagesTooLarge(_) => Some("prompt_images_too_large"),
            Self::SessionLost => Some("session_lost"),
            Self::Protocol(_) | Self::InvalidInput(_) => None,
        }
    }
}

/// 网页接口按种类回状态码。`match` 写全、不用 `_`：以后加了变体，编译器逼着选。
/// `message` 一律是 Display 原文，前端有几处按文字认错误。
impl From<AcpError> for AppCommandError {
    fn from(err: AcpError) -> Self {
        let code = match &err {
            AcpError::ConnectionNotFound(_) => AppErrorCode::NotFound,
            AcpError::TurnInProgress => AppErrorCode::TurnInProgress,
            AcpError::NoActiveTurn
            | AcpError::FeedbackDisabled
            | AcpError::InvalidFeedback(_)
            | AcpError::InvalidInput(_)
            // 一条消息里的图片太大是调用方发的东西不行，发之前就拒了。
            | AcpError::PromptImagesTooLarge(_)
            | AcpError::ConversationMoved { .. } => AppErrorCode::InvalidInput,
            AcpError::SdkNotInstalled(_)
            | AcpError::PlatformNotSupported(_)
            | AcpError::AgentRuntimeOutdated(_) => AppErrorCode::DependencyMissing,
            AcpError::PiProjectTrustRequired(_) => AppErrorCode::PermissionDenied,
            // agent 登录失效（如中继令牌过期）留 500：这是要在 Sentry 里看得见的事。
            AcpError::SpawnFailed(_)
            | AcpError::Protocol(_)
            | AcpError::ProcessExited
            // 智能体那边的会话没了（#423）：是智能体自己的事，和 ProcessExited 一样留 500。
            | AcpError::SessionLost
            | AcpError::DownloadFailed(_)
            | AcpError::InitializeTimeout
            | AcpError::ProbeTimedOut
            | AcpError::McpRejectedByAgent(_)
            | AcpError::AgentAuthRequired(_) => AppErrorCode::TaskExecutionFailed,
        };
        AppCommandError::new(code, err.to_string())
    }
}

impl Serialize for AcpError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

/// Drops the spawn metadata (`"spawned_at": "…"`) an error's JSON can carry,
/// which tells the user nothing.
///
/// Local paths are kept. codeg is run by the person whose machine it runs on,
/// and the path is often the part of the message they act on: Claude Code's
/// `config_file_invalid` names the settings file to fix, and codeg's own
/// messages name the file they could not lock or write. These paths used to be
/// replaced with `<local-path>`, which hid exactly that, swallowed the
/// punctuation after each path, and only ever caught `/Users/` and `/home/`
/// (a Windows path showed in full).
fn sanitize_protocol_message(raw: &str) -> String {
    let without_spawned_at = regex::Regex::new(r#"\s*,?\s*"spawned_at"\s*:\s*"[^"]*"\s*,?"#)
        .ok()
        .map(|re| re.replace_all(raw, "").into_owned())
        .unwrap_or_else(|| raw.to_string());

    regex::Regex::new(r#",\s*([}\]])"#)
        .ok()
        .map(|re| re.replace_all(&without_spawned_at, "$1").into_owned())
        .unwrap_or(without_spawned_at)
}

fn is_executable_format_error(message: &str) -> bool {
    let lowered = message.to_lowercase();
    lowered.contains("malformed mach-o file")
        || lowered.contains("exec format error")
        || lowered.contains("bad cpu type in executable")
        || lowered.contains("not a valid win32 application")
        || lowered.contains("is not a valid application for this os platform")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Claude Code 2.1.318 refusing to start over a broken settings file
    /// (claude-agent-acp 0.101.0, `startupFailureReason: config_file_invalid`).
    const CONFIG_FILE_INVALID: &str = "Internal error: Configuration error in \
        /Users/me/.claude/.claude.json: JSON Parse error: Expected '}'\n\
        No backup of this file was found.\n\
        Fix the JSON in /Users/me/.claude/.claude.json, or move the file aside \
        to start with default settings.";

    fn payload(err: AcpError) -> String {
        match err {
            AcpError::Protocol(message)
            | AcpError::McpRejectedByAgent(message)
            | AcpError::AgentAuthRequired(message) => message,
            other => panic!("unexpected variant: {other:?}"),
        }
    }

    #[test]
    fn a_protocol_error_keeps_the_paths_it_names() {
        assert_eq!(
            payload(AcpError::protocol(CONFIG_FILE_INVALID)),
            CONFIG_FILE_INVALID
        );
        let raw = "ENOENT: no such file or directory, open '/home/me/.codex/config.toml'";
        assert_eq!(payload(AcpError::protocol(raw)), raw);
    }

    #[test]
    fn the_agent_worded_errors_keep_their_paths_too() {
        let raw = "Please run 'agent login' first (reading /Users/me/.cursor/cli-config.json)";
        assert_eq!(payload(AcpError::agent_auth_required(raw)), raw);
        let raw = "cannot start MCP server /home/me/bin/codeg-mcp: permission denied";
        assert_eq!(payload(AcpError::mcp_rejected(raw)), raw);
    }

    /// `src/lib/prompt-images-too-large.ts` reads this sentence back: the
    /// marker and both sizes must stay where it looks for them.
    #[test]
    fn the_too_big_images_message_names_both_sizes() {
        const MIB: u64 = 1024 * 1024;
        let err = AcpError::prompt_images_too_large(40 * MIB + MIB / 2, 30 * MIB);
        assert_eq!(err.code(), Some("prompt_images_too_large"));
        assert_eq!(
            err.to_string(),
            "the images in this message are too big for the agent to accept \
             (40.5 MiB once encoded, the limit is 30 MiB). Send fewer or smaller images."
        );
    }

    #[test]
    fn spawn_metadata_is_still_dropped() {
        assert_eq!(
            payload(AcpError::protocol(
                r#"{"error":"boom","spawned_at":"2026-11-06T01:02:03Z"}"#
            )),
            r#"{"error":"boom"}"#
        );
    }

    fn kind(err: AcpError) -> (AppErrorCode, String) {
        let message = err.to_string();
        let converted = AppCommandError::from(err);
        assert_eq!(converted.message, message, "message 必须是 Display 原文");
        (converted.code, converted.message)
    }

    #[test]
    fn caller_side_acp_errors_are_client_codes() {
        assert_eq!(
            kind(AcpError::ConnectionNotFound("c1".into())),
            (AppErrorCode::NotFound, "connection not found: c1".into())
        );
        assert_eq!(
            kind(AcpError::TurnInProgress).0,
            AppErrorCode::TurnInProgress
        );
        for err in [
            AcpError::NoActiveTurn,
            AcpError::FeedbackDisabled,
            AcpError::InvalidFeedback("empty".into()),
            AcpError::invalid_input("skill id cannot be empty"),
            AcpError::prompt_images_too_large(40 * 1024 * 1024, 30 * 1024 * 1024),
            AcpError::ConversationMoved {
                conversation_id: 3,
                folder_id: 4,
            },
        ] {
            let label = format!("{err:?}");
            assert_eq!(kind(err).0, AppErrorCode::InvalidInput, "{label}");
        }
        for err in [
            AcpError::SdkNotInstalled("claude is not installed".into()),
            AcpError::PlatformNotSupported("plan9".into()),
            AcpError::AgentRuntimeOutdated("upgrade pi".into()),
        ] {
            let label = format!("{err:?}");
            assert_eq!(kind(err).0, AppErrorCode::DependencyMissing, "{label}");
        }
        assert_eq!(
            kind(AcpError::PiProjectTrustRequired("trust it first".into())).0,
            AppErrorCode::PermissionDenied
        );
    }

    #[test]
    fn server_and_agent_side_acp_errors_stay_task_execution_failed() {
        for err in [
            AcpError::SpawnFailed("boom".into()),
            AcpError::protocol("boom"),
            AcpError::ProcessExited,
            AcpError::DownloadFailed("offline".into()),
            AcpError::InitializeTimeout,
            AcpError::ProbeTimedOut,
            AcpError::mcp_rejected("no mcp"),
            AcpError::agent_auth_required("relay token expired"),
        ] {
            let label = format!("{err:?}");
            assert_eq!(kind(err).0, AppErrorCode::TaskExecutionFailed, "{label}");
        }
    }

    #[test]
    fn invalid_input_has_no_stable_code_and_no_prefix() {
        let err = AcpError::invalid_input("skill id cannot be empty");
        assert_eq!(err.code(), None);
        assert_eq!(err.to_string(), "skill id cannot be empty");
    }

    #[test]
    fn a_bad_skill_id_is_invalid_input() {
        for raw in ["", "  ", ".hidden", "../x", "a/b", "a b"] {
            let err = crate::commands::acp::validate_skill_id(raw).expect_err(raw);
            assert!(matches!(err, AcpError::InvalidInput(_)), "{raw:?}: {err:?}");
            assert_eq!(AppCommandError::from(err).code, AppErrorCode::InvalidInput);
        }
        let err = crate::commands::acp::validate_skill_id("").unwrap_err();
        assert_eq!(err.to_string(), "skill id cannot be empty");
        assert_eq!(
            crate::commands::acp::validate_skill_id(" ok-skill_1 ").unwrap(),
            "ok-skill_1"
        );
    }
}
