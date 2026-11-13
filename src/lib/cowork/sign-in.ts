// Where "Sign in" goes for an agent (AI QA #158).
//
// Behind the Cowork portal, the credentials of Claude Code, Codex and Grok are
// the employee's AI accounts in the portal ("My account → AI accounts", cowork
// `src/runtime/codeg/accounts.ts` projects them into this server's agent
// settings). The agent's own settings page here has no way to sign in to them,
// so "Sign in" opens the portal's AI accounts in a new tab instead. Every other
// agent, and every non-portal deployment, keeps the upstream target: the
// agent's settings page.

import { openSettingsWindow } from "@/lib/api"
import { isRemoteDesktopWindow, openUrl } from "@/lib/platform"
import { getServerBaseUrl } from "@/lib/transport"
import type { AgentType } from "@/lib/types"
import { COWORK_ACCOUNT_URL } from "./account"
import { getCachedCoworkInfo, type CoworkInfo } from "./info"

/** The agents whose credentials the portal manages (cowork's `CODEG_AGENT`:
 *  claude → claude_code, codex → codex, grok → grok; ccr is claude_code). */
export const PORTAL_SIGN_IN_AGENTS: ReadonlySet<AgentType> = new Set<AgentType>(
  ["claude_code", "codex", "grok"]
)

/** The AI accounts part of the portal's /me. nginx answers the path on every
 *  employee domain with a 302 to the portal's /me, and the browser carries the
 *  fragment over the redirect. */
export const COWORK_AI_ACCOUNTS_URL = `${COWORK_ACCOUNT_URL}#ai-accounts`

/** Whether signing `agentType` in is the portal's job here. `info` defaults to
 *  the cached Cowork info; unknown (not loaded yet) reads as "not portal". */
export function signInViaPortal(
  agentType: AgentType | null | undefined,
  info: CoworkInfo | null = getCachedCoworkInfo()
): boolean {
  return (
    info?.portal === true &&
    agentType != null &&
    PORTAL_SIGN_IN_AGENTS.has(agentType)
  )
}

/** Open the portal's AI accounts in a new tab (the system browser from a
 *  desktop window bound to a remote workspace, on that workspace's domain). */
export function openCoworkAiAccounts(): void {
  const url = isRemoteDesktopWindow()
    ? `${getServerBaseUrl()}${COWORK_AI_ACCOUNTS_URL}`
    : COWORK_AI_ACCOUNTS_URL
  void openUrl(url).catch((err) => {
    console.error("[cowork] open AI accounts:", err)
  })
}

/** "Sign in" for `agentType`: the portal's AI accounts when it manages them
 *  (see {@link signInViaPortal}), otherwise the agent's settings page. */
export function openAgentSignIn(agentType: AgentType | null | undefined): void {
  if (signInViaPortal(agentType)) {
    openCoworkAiAccounts()
    return
  }
  openSettingsWindow("agents", { agentType: agentType ?? null }).catch(
    (err) => {
      console.error("[cowork] open agent settings:", err)
    }
  )
}

/**
 * Whether a failed turn's own words (`turn_error`, what a reopened
 * conversation reads from the agent's record) say the agent is not signed in.
 * claude-agent-acp settles the same texts as `auth_required` ("Not logged in ·
 * Please run /login", "Invalid API key · Please run /login", "Login expired ·
 * Run /login …"); a usage-limit banner that mentions /login is not one.
 */
export function isSignInFailureText(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  if (/\blimit\b/i.test(text)) return false
  return (
    /\bnot logged in\b/i.test(text) ||
    /\brun \/login\b/i.test(text) ||
    /\blogin expired\b/i.test(text) ||
    /\binvalid api key\b/i.test(text) ||
    /\bauthentication_error\b/i.test(text)
  )
}
