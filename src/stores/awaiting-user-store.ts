import { useEffect } from "react"
import { create } from "zustand"
import { acpListAwaitingUser } from "@/lib/api"
import {
  blockingPrompts,
  isPlanApprovalPermission,
} from "@/lib/blocking-prompts"
import type { ConnectionState } from "@/contexts/acp-connections-context"
import { isTaskAwaitingUser } from "@/components/tasks/task-acceptance"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CONVERSATION_CHANGED_EVENT,
  type AwaitingUserEntry,
  type ConversationChange,
  type WorkTask,
} from "@/lib/types"

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
 *
 * Cowork fork (#707): a third source covers the sessions this window holds no
 * connection to — after a reload only the open conversation re-attaches, so
 * every other row parked on the user fell back to spinning. The server lists
 * what each live connection waits on (`acp_list_awaiting_user`, by
 * `conversation.id`), read on load, after a reconnect, whenever a
 * conversation's status moves, and every few seconds while it names any
 * session (`AwaitingUserSync`). A session with a
 * connection here goes by that connection alone, even once it waits on
 * nobody: the listing is older than what the connection just saw.
 */
export type AwaitingUserKind = "permission" | "question" | "plan"

interface AwaitingUserState {
  bySession: ReadonlyMap<string, AwaitingUserKind>
  /** Conversation ids (`conversation.id`) of task-engine sessions waiting on
   *  the user, from the task list (#167). */
  byTaskConversation: ReadonlySet<number>
  /** Cowork fork (#707): the server's reading, by `conversation.id`. */
  byConversation: ReadonlyMap<number, AwaitingUserKind>
  /** Cowork fork (#707): external session ids with a connection in this
   *  window — those rows go by `bySession`, not the server's reading. */
  attachedSessions: ReadonlySet<string>
}

export const useAwaitingUserStore = create<AwaitingUserState>(() => ({
  bySession: new Map(),
  byTaskConversation: new Set(),
  byConversation: new Map(),
  attachedSessions: new Set(),
}))

type AwaitingConn = Pick<
  ConnectionState,
  | "connectionId"
  | "sessionId"
  | "parentConnectionId"
  | "pendingPermission"
  | "pendingAskQuestion"
  | "pendingPlanApproval"
> &
  // Cowork fork (#707): left out means a live connection.
  Partial<Pick<ConnectionState, "status">>

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
  const attached = new Set<string>()
  // Cowork fork (#707): a dropped connection is kept in the list but sees
  // nothing new — another window may have reattached and been asked since, or
  // answered the prompt it still holds — so only a live one speaks for its
  // session over the server's reading, and a dropped one's prompts count for
  // nothing.
  const isLive = (conn: AwaitingConn) =>
    conn.status !== "disconnected" && conn.status !== "error"
  for (const conn of all) {
    if (conn.sessionId && isLive(conn)) attached.add(conn.sessionId)
  }
  const mark = (sessionId: string | null, kind: AwaitingUserKind) => {
    if (!sessionId) return
    const have = next.get(sessionId)
    if (have === undefined || KIND_RANK[kind] < KIND_RANK[have]) {
      next.set(sessionId, kind)
    }
  }
  for (const conn of all) {
    if (!isLive(conn)) continue
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

  const state = useAwaitingUserStore.getState()
  const update: Partial<AwaitingUserState> = {}
  if (!sameKinds(state.bySession, next)) update.bySession = next
  const prevAttached = state.attachedSessions
  if (
    prevAttached.size !== attached.size ||
    ![...attached].every((id) => prevAttached.has(id))
  ) {
    update.attachedSessions = attached
  }
  if (update.bySession || update.attachedSessions) {
    useAwaitingUserStore.setState(update)
  }
}

function sameKinds<K>(
  prev: ReadonlyMap<K, AwaitingUserKind>,
  next: ReadonlyMap<K, AwaitingUserKind>
): boolean {
  if (prev.size !== next.size) return false
  for (const [id, kind] of next) {
    if (prev.get(id) !== kind) return false
  }
  return true
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

/** Cowork fork (#707): what one server entry asks the user for. A permission
 *  that is really a plan approval reads as "plan", as `awaitingUserOf` does. */
function kindOfEntry(entry: AwaitingUserEntry): AwaitingUserKind {
  if (entry.kind === "permission") {
    return isPlanApprovalPermission({ tool_call: entry.tool_call })
      ? "plan"
      : "permission"
  }
  return entry.kind
}

/** Cowork fork (#707): replace the server source from a full listing
 *  (`acp_list_awaiting_user`). A no-op (same reference) when nothing
 *  changed. */
export function replaceServerAwaitingUser(
  entries: Iterable<AwaitingUserEntry>
): void {
  const next = new Map<number, AwaitingUserKind>()
  for (const entry of entries) {
    next.set(entry.conversation_id, kindOfEntry(entry))
  }
  if (sameKinds(useAwaitingUserStore.getState().byConversation, next)) return
  useAwaitingUserStore.setState({ byConversation: next })
}

/** What one conversation waits on the user for, or `null`: its connection's
 *  own kind when one is attached; with none here, what the server says about
 *  conversation `conversationId` (Cowork fork, #707); else "permission" when
 *  the task engine says its headless session waits (#167). */
export function awaitingUserFor(
  state: AwaitingUserState,
  externalId: string | null | undefined,
  conversationId?: number | null
): AwaitingUserKind | null {
  const live = externalId ? state.bySession.get(externalId) : undefined
  if (live) return live
  const attached = externalId ? state.attachedSessions.has(externalId) : false
  if (!attached && conversationId != null) {
    const server = state.byConversation.get(conversationId)
    if (server) return server
  }
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

/** Cowork fork (#707): how long a burst of status changes is gathered into
 *  one re-read of the listing. */
const RESYNC_DELAY_MS = 300

/** Cowork fork (#707): while the listing still names a session parked on the
 *  user, how often it is re-read. A prompt answered from another browser on a
 *  session whose turn keeps running moves no status here, so without this the
 *  row would stay marked until the next status change. */
const POLL_WHILE_WAITING_MS = 5000

/**
 * Cowork fork (#707): keep the server source current — read the listing on
 * mount, after a WebSocket reconnect, and shortly after any conversation's
 * status moves (`conversation://changed`): a turn that ends or starts is when
 * a prompt is most likely raised or withdrawn on a session this window does
 * not watch. While the listing names any session, it is also re-read every
 * few seconds, so a prompt answered elsewhere clears here too. Mount once per
 * window — the workspace layout does.
 */
export function useAwaitingUserSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let pollTimer: ReturnType<typeof setTimeout> | undefined

    // While the listing still names a session, read it again in a while.
    const pollIfWaiting = () => {
      if (disposed) return
      if (useAwaitingUserStore.getState().byConversation.size === 0) return
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = setTimeout(() => {
        pollTimer = undefined
        if (!disposed) seed()
      }, POLL_WHILE_WAITING_MS)
    }
    const seed = () => {
      if (pollTimer) clearTimeout(pollTimer)
      pollTimer = undefined
      Promise.resolve()
        .then(() => acpListAwaitingUser())
        .then((entries) => {
          if (disposed) return
          replaceServerAwaitingUser(entries)
          pollIfWaiting()
        })
        .catch(() => {
          // An older server has no such command: rows fall back to what this
          // client's own connections know, and with nothing listed no retry
          // is scheduled. A passing error while rows are still marked keeps
          // the poll going, so they clear once the server answers again.
          pollIfWaiting()
        })
    }
    const resyncSoon = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = undefined
        if (!disposed) seed()
      }, RESYNC_DELAY_MS)
    }

    void (async () => {
      try {
        const dispose = await subscribe<ConversationChange>(
          CONVERSATION_CHANGED_EVENT,
          (change) => {
            if (change.kind !== "upsert") resyncSoon()
          }
        )
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
      } catch (err) {
        console.error("[AwaitingUser] subscribe failed:", err)
      }
      if (!disposed) seed()
    })()

    const offReconnect = onTransportReconnect(seed)

    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      if (pollTimer) clearTimeout(pollTimer)
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}

/** The bridge component for layouts: mounts {@link useAwaitingUserSync}. */
export function AwaitingUserSync(): null {
  useAwaitingUserSync()
  return null
}
