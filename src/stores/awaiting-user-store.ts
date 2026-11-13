import { create } from "zustand"
import {
  blockingPrompts,
  isPlanApprovalPermission,
} from "@/lib/blocking-prompts"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { isTaskAwaitingUser } from "@/components/tasks/task-acceptance"
import type { WorkTask } from "@/lib/types"

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
 *
 * A second, coarser source covers the sessions the task engine runs headless
 * (#167): a merge generation parked on the user (`merge_awaiting_input`), or a
 * task run the engine flipped to `awaiting_input`, has no connection here
 * until someone opens it, so the tasks view publishes those tasks'
 * conversation ids (`publishTaskAwaiting`). The engine only knows that a
 * request is out, not which kind, so such a row reads as "permission" — until
 * a connection attaches and names the real kind, which wins.
 */
export type AwaitingUserKind = "permission" | "question" | "plan"

interface AwaitingUserState {
  bySession: ReadonlyMap<string, AwaitingUserKind>
  /** Conversation ids (`conversation.id`) of task-engine sessions waiting on
   *  the user, from the task list (#167). */
  byTaskConversation: ReadonlySet<number>
}

export const useAwaitingUserStore = create<AwaitingUserState>(() => ({
  bySession: new Map(),
  byTaskConversation: new Set(),
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

/**
 * Replace the task-engine source from the full task list (#167): the
 * conversations of the tasks parked on the user — a merge waiting on it, or a
 * run at `awaiting_input` (`isTaskAwaitingUser`). A no-op (same reference)
 * when the set did not change, so a task refetch that moved nothing here
 * re-renders no row.
 */
export function publishTaskAwaiting(tasks: Iterable<WorkTask>): void {
  const next = new Set<number>()
  for (const task of tasks) {
    if (isTaskAwaitingUser(task) && task.conversation_id != null) {
      next.add(task.conversation_id)
    }
  }
  const prev = useAwaitingUserStore.getState().byTaskConversation
  if (prev.size === next.size && [...next].every((id) => prev.has(id))) return
  useAwaitingUserStore.setState({ byTaskConversation: next })
}

/** What one conversation waits on the user for, or `null`: its connection's
 *  own kind when one is attached, else "permission" when the task engine
 *  says its headless session waits (#167). */
export function awaitingUserFor(
  state: AwaitingUserState,
  externalId: string | null | undefined,
  conversationId?: number | null
): AwaitingUserKind | null {
  const live = externalId ? state.bySession.get(externalId) : undefined
  if (live) return live
  return conversationId != null && state.byTaskConversation.has(conversationId)
    ? "permission"
    : null
}

/** What the session behind `externalId` — or the task-engine session of
 *  conversation `conversationId` — waits on the user for, or `null`. */
export function useAwaitingUser(
  externalId: string | null | undefined,
  conversationId?: number | null
): AwaitingUserKind | null {
  return useAwaitingUserStore((s) =>
    awaitingUserFor(s, externalId, conversationId)
  )
}
