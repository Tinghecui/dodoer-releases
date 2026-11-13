import {
  AGENT_DISPLAY_ORDER,
  type AcpAgentInfo,
  type AgentType,
} from "@/lib/types"

export interface ResolveDefaultAgentInput {
  /** Folder's saved `default_agent_type`, or null if none set. */
  folderDefault: AgentType | null
  /**
   * Agent to inherit when "new conversation" is launched from inside a
   * real conversation context (caller passes the active tab's agentType
   * only when its `conversationId != null`).
   */
  inherit: AgentType | null
  /**
   * User-sorted list of enabled+available agents. Empty during cold start
   * before the first successful `acpListAgents()` call.
   */
  sortedTypes: AgentType[]
  /** True once `acpListAgents()` has succeeded at least once this session. */
  fresh: boolean
}

export interface ResolveDefaultAgentResult {
  agentType: AgentType
  /**
   * True when the returned `agentType` is a "best guess" tentative value
   * that should be re-evaluated once the agent list becomes fresh — the
   * caller (TabProvider) tracks this on draft tabs and patches them when
   * fresh data arrives. Always false when `agentType` came from either
   * `folderDefault` or `inherit` (those are explicit user intent).
   */
  provisional: boolean
}

/**
 * Decide which agent a freshly-opened conversation should use. Pure
 * function — no side effects, no React, no DB. Lives outside hooks so the
 * priority rules can be reasoned about (and one day unit-tested) without
 * spinning up a renderer.
 *
 * Priority (highest first):
 *   1. `folderDefault` — the user explicitly pinned a default on this folder.
 *   2. `inherit` — "new conversation" launched from inside an existing
 *      conversation should produce another conversation with the same agent.
 *   3. `sortedTypes[0]` — first entry of the list the caller ranks for
 *      defaults: the user's drag-sorted order with the installed agents
 *      moved ahead ([`installedFirst`]), so the default is one that can
 *      start.
 *   4. `AGENT_DISPLAY_ORDER[0]` — final fallback when even the sorted list
 *      isn't available yet (cold start).
 *
 * The result is marked `provisional: true` for cases 3 and 4 when `fresh`
 * is false — i.e. the sorted list might still be stale or empty seed data
 * from localStorage, and the caller should re-resolve once fresh data
 * arrives.
 */
export function resolveDefaultAgent(
  input: ResolveDefaultAgentInput
): ResolveDefaultAgentResult {
  const { folderDefault, inherit, sortedTypes, fresh } = input
  if (folderDefault) {
    return { agentType: folderDefault, provisional: false }
  }
  if (inherit) {
    return { agentType: inherit, provisional: false }
  }
  if (sortedTypes.length > 0) {
    return { agentType: sortedTypes[0], provisional: !fresh }
  }
  return { agentType: AGENT_DISPLAY_ORDER[0], provisional: !fresh }
}

/**
 * Cowork fork (AI QA #129): agent types in `agents` order, the installed ones
 * (`installed_version` set) first. Stable within each group, so the user's
 * drag order still decides among the installed agents, and among the rest
 * when none is installed.
 *
 * Only for choosing a DEFAULT: the selector row and every other list keep the
 * user's order. Without this a fresh workspace whose first agent is Codex
 * (dragged there, or the built-in order) opened every new conversation on
 * "Codex's ACP adapter is not installed" while Claude Code was ready.
 */
export function installedFirst(
  agents: readonly Pick<AcpAgentInfo, "agent_type" | "installed_version">[]
): AgentType[] {
  const installed = agents.filter((a) => !!a.installed_version)
  const missing = agents.filter((a) => !a.installed_version)
  return [...installed, ...missing].map((a) => a.agent_type)
}

/**
 * The agent a picker falls back to when the requested one is not usable: the
 * first available agent that is installed, else the first available one.
 */
export function firstUsableAgent<
  T extends Pick<AcpAgentInfo, "available" | "installed_version">,
>(agents: readonly T[]): T | undefined {
  return (
    agents.find((a) => a.available && !!a.installed_version) ??
    agents.find((a) => a.available)
  )
}
