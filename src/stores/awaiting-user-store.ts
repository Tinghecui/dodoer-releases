import { create } from "zustand"
import {
  blockingPrompts,
  isPlanApprovalPermission,
} from "@/lib/blocking-prompts"
import type { ConnectionState } from "@/contexts/acp-connections-context"

/**
 * Sessions whose agent is parked on the user: a codeg-mcp `ask_user_question`,
 * a permission request, a plan approval (`blockingPrompts`). The turn is still
 * `in_progress` while it waits, so without this the sidebar row keeps spinning
 * as if the agent were working — and nothing outside the conversation itself
 * says "this one needs you".
 *
 * Fed by the ACP connections store (`publishAwaitingUser`), like
 * `background-pending-store`: keyed by the agent's external session id so a
 * sidebar row can find it from `conversation.external_id`. A delegated
 * sub-agent's prompt is answered from its parent's conversation, so it marks
 * every ancestor's session as well. Client-only and not persisted: a reload
 * starts empty until the backend re-sends its snapshot.
 */
export type AwaitingUserKind = "permission" | "question" | "plan"

interface AwaitingUserState {
  bySession: ReadonlyMap<string, AwaitingUserKind>
}

export const useAwaitingUserStore = create<AwaitingUserState>(() => ({
  bySession: new Map(),
}))

type AwaitingConn = Pick<
  ConnectionState,
  | "connectionId"
  | "sessionId"
  | "parentConnectionId"
  | "pendingPermission"
  | "pendingAskQuestion"
  | "pendingPlanApproval"
>

/** What one connection waits on; `null` when it waits on nobody. With more
 *  than one prompt up, the order they stack in above the composer wins. A
 *  permission request that is a plan approval (Claude Code's ExitPlanMode,
 *  codex's plan review) reads as "plan", like Grok's own plan approval. */
export function awaitingUserOf(
  conn: Pick<
    AwaitingConn,
    "pendingPermission" | "pendingAskQuestion" | "pendingPlanApproval"
  >
): AwaitingUserKind | null {
  const prompts = blockingPrompts(conn)
  if (!prompts) return null
  if (prompts.permission) {
    return isPlanApprovalPermission(prompts.permission) ? "plan" : "permission"
  }
  if (prompts.askQuestion) return "question"
  return "plan"
}

const KIND_RANK: Record<AwaitingUserKind, number> = {
  permission: 0,
  question: 1,
  plan: 2,
}

/**
 * Replace the whole map from the current connections. Several connections can
 * land on one session (a viewer window, a sub-agent rolling up to its parent):
 * the kind that stacks first wins. A no-op (same reference) when nothing
 * changed.
 */
export function publishAwaitingUser(connections: Iterable<AwaitingConn>): void {
  const all = [...connections]
  const byConnectionId = new Map<string, AwaitingConn>()
  for (const conn of all) byConnectionId.set(conn.connectionId, conn)

  const next = new Map<string, AwaitingUserKind>()
  const mark = (sessionId: string | null, kind: AwaitingUserKind) => {
    if (!sessionId) return
    const have = next.get(sessionId)
    if (have === undefined || KIND_RANK[kind] < KIND_RANK[have]) {
      next.set(sessionId, kind)
    }
  }
  for (const conn of all) {
    const kind = awaitingUserOf(conn)
    if (!kind) continue
    mark(conn.sessionId, kind)
    // Up the delegation chain; `seen` guards against a cycle in bad data.
    const seen = new Set([conn.connectionId])
    let parentId = conn.parentConnectionId
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId)
      const parent = byConnectionId.get(parentId)
      if (!parent) break
      mark(parent.sessionId, kind)
      parentId = parent.parentConnectionId
    }
  }

  const prev = useAwaitingUserStore.getState().bySession
  if (prev.size === next.size) {
    let same = true
    for (const [id, kind] of next) {
      if (prev.get(id) !== kind) {
        same = false
        break
      }
    }
    if (same) return
  }
  useAwaitingUserStore.setState({ bySession: next })
}

/** What the session behind `externalId` waits on the user for, or `null`. */
export function useAwaitingUser(
  externalId: string | null | undefined
): AwaitingUserKind | null {
  return useAwaitingUserStore((s) =>
    externalId ? (s.bySession.get(externalId) ?? null) : null
  )
}
