"use client"

import { useEffect, useMemo } from "react"
import { useAcpAgents } from "@/hooks/use-acp-agents"
import { installedFirst } from "@/lib/resolve-default-agent"
import { AGENT_DISPLAY_ORDER, type AgentType } from "@/lib/types"

const STORAGE_KEY = "workspace:sorted-available-agents"

// Allow-list of known agent types. A polluted localStorage value (older
// build wrote an extra type, hand-edited dev tools, future-build downgrade)
// should not leak unknown strings into `tab.agentType` — they'd survive all
// the way to ACP connect, which would fail with a confusing error far from
// the source. Gate the seed read on this set.
const VALID_AGENT_TYPES = new Set<string>(AGENT_DISPLAY_ORDER)

function readSeed(): AgentType[] {
  if (typeof window === "undefined") return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is AgentType => typeof v === "string" && VALID_AGENT_TYPES.has(v)
    )
  } catch {
    return []
  }
}

function writeSeed(types: AgentType[]): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(types))
  } catch {
    // Quota exceeded or storage disabled — ignore.
  }
}

// Module-level seed snapshot read once at import. Avoids re-reading
// localStorage on every consumer mount and gives a synchronous default
// even before the first `useAcpAgents` reload resolves.
const initialSeed: AgentType[] = readSeed()

export interface UseSortedAvailableAgentsResult {
  /**
   * Enabled + available agent types in the user-defined sort order. While
   * the first `acpListAgents()` call is in flight, this falls back to the
   * last persisted snapshot from localStorage. Empty array means no usable
   * agents are known yet.
   */
  sortedTypes: AgentType[]
  /**
   * The same agents ranked for picking a DEFAULT (Cowork fork, AI QA #129):
   * the installed ones first, the user's order kept within each group
   * (`installedFirst`). While not fresh, the persisted snapshot, which is
   * stored in this order.
   */
  defaultOrder: AgentType[]
  /** True once the first successful reload has completed this session. */
  fresh: boolean
  refresh: () => Promise<void>
}

/**
 * Thin wrapper over `useAcpAgents()` that applies the
 * `enabled && available` filter, projects to agent types, and persists
 * the result so cold starts have a synchronous (if possibly stale) seed.
 *
 * Used by both TabProvider (to resolve default agents for new draft
 * tabs) and SidebarConversationList (to populate the per-folder "set
 * default agent" submenu). AgentSelector uses `useAcpAgents` directly
 * because it needs the full `AcpAgentInfo[]` to render icons and labels.
 */
export function useSortedAvailableAgents(): UseSortedAvailableAgentsResult {
  const { agents, fresh, refresh } = useAcpAgents()

  const usable = useMemo(
    () => agents.filter((a) => a.enabled && a.available),
    [agents]
  )
  const liveSortedTypes = useMemo(
    () => usable.map((a) => a.agent_type),
    [usable]
  )
  const liveDefaultOrder = useMemo(() => installedFirst(usable), [usable])

  // While not fresh, expose the localStorage seed so consumers can
  // resolve a sensible default without waiting on the API. Once fresh,
  // the live list takes over even if it temporarily shrinks (e.g. user
  // disabled an agent).
  const sortedTypes = fresh ? liveSortedTypes : initialSeed
  const defaultOrder = fresh ? liveDefaultOrder : initialSeed

  // The seed only stands in for the default before the list arrives, so it
  // is kept in the default order; it holds the same agents either way.
  useEffect(() => {
    if (!fresh) return
    writeSeed(liveDefaultOrder)
  }, [fresh, liveDefaultOrder])

  return { sortedTypes, defaultOrder, fresh, refresh }
}
