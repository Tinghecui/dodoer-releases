import { useEffect } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import { acpListBackgroundPending } from "@/lib/api"
import { liveAsyncTasks } from "@/lib/async-tasks"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  BACKGROUND_PENDING_EVENT,
  type AsyncTaskRecord,
  type BackgroundPendingEntry,
  type BackgroundUncertainReason,
  type ConnectionStatus,
} from "@/lib/types"

/**
 * Background work an agent session still has outstanding after its turn
 * ended — Claude's `run_in_background` shells, monitors, workflows. While it
 * is non-empty the agent is not done: it will be woken again when the work
 * settles, so the sidebar must not read "finished, unread" yet.
 *
 * Fed by the ACP connections store (`publishBackgroundPending`), which holds
 * the two overlapping sources per connection; keyed by the agent's external
 * session id so a sidebar row can find it from `conversation.external_id`
 * without knowing which connection key the conversation is open under.
 * Client-only and not persisted: a reload starts empty until the backend
 * re-sends its snapshot.
 *
 * Cowork fork: a second source covers the sessions this client holds no
 * connection to (a row never opened in this window, another browser's): the
 * server's own reading of every live connection, by `conversation.id` —
 * listed by `acp_list_background_pending`, kept current by
 * `conversation://background` (`BackgroundPendingSync`). Where both
 * know a session, the connection here wins.
 */
export interface BackgroundPending {
  /** How many pieces of background work are still live (at least 1; 0 for
   *  a「?」, whose work went down with its process). */
  count: number
  /** Labels of the live async tasks (may be fewer than `count`: the
   *  transcript watcher only counts). For a「?」, the tasks that were out. */
  names: string[]
  /** Cowork fork (#386): only the server sets it — it claims to run or wait,
   *  but no live process is moving it. Absent: plain waiting.
   *  `abandoned`（#817）：回合没跑完就断开，`names` 是跟着没了的后台任务；
   *  只给取消（红叉）的行写任务名，不画沙漏也不画「?」。 */
  state?: "uncertain" | "abandoned"
  /** Why it is a「?」(with `state` only). */
  reason?: BackgroundUncertainReason | null
}

interface BackgroundPendingState {
  bySession: ReadonlyMap<string, BackgroundPending>
  /** Cowork fork: the server's reading, by `conversation.id`. */
  byConversation: ReadonlyMap<number, BackgroundPending>
}

export const useBackgroundPendingStore = create<BackgroundPendingState>(() => ({
  bySession: new Map(),
  byConversation: new Map(),
}))

/** What one connection contributes; `null` when it has nothing live. */
export function backgroundPendingOf(conn: {
  asyncTasks: AsyncTaskRecord[]
  backgroundOutstanding: number
}): BackgroundPending | null {
  const live = liveAsyncTasks(conn.asyncTasks)
  // The two sources observe overlapping work (an AIR async task is also a
  // transcript launch), so take the larger count rather than the sum.
  const count = Math.max(live.length, conn.backgroundOutstanding)
  if (count <= 0) return null
  const names = live.map((t) => t.name || t.description).filter(Boolean)
  return { count, names }
}

/** Cowork fork (#529): whether a connection in this window still reports its
 *  background count. A disconnected / errored one does not: its count is the
 *  last thing the agent said before the link went, and once the server clears
 *  the row (its「?」withdrawn, the conversation closed) that stale count would
 *  bring the hourglass back. After a disconnect only the server speaks. The
 *  connection itself stays in the list (reconnect, history). Absent status
 *  (callers that don't track one) counts as live. */
export function reportsBackgroundPending(
  status?: ConnectionStatus | null
): boolean {
  return status !== "disconnected" && status !== "error"
}

function samePending(a: BackgroundPending, b: BackgroundPending): boolean {
  return (
    a.count === b.count &&
    a.state === b.state &&
    (a.reason ?? null) === (b.reason ?? null) &&
    a.names.length === b.names.length &&
    a.names.every((n, i) => n === b.names[i])
  )
}

/**
 * Replace the whole map from the current connections. Several connections can
 * share a session (a viewer window, a re-keyed tab): the one with the most
 * outstanding work wins. A disconnected / errored connection reports nothing
 * ({@link reportsBackgroundPending}). A no-op (same reference) when nothing
 * changed.
 */
export function publishBackgroundPending(
  connections: Iterable<{
    sessionId: string | null
    asyncTasks: AsyncTaskRecord[]
    backgroundOutstanding: number
    status?: ConnectionStatus | null
  }>
): void {
  const next = new Map<string, BackgroundPending>()
  for (const conn of connections) {
    if (!conn.sessionId) continue
    if (!reportsBackgroundPending(conn.status)) continue
    const pending = backgroundPendingOf(conn)
    if (!pending) continue
    const have = next.get(conn.sessionId)
    if (!have || pending.count > have.count) next.set(conn.sessionId, pending)
  }
  const prev = useBackgroundPendingStore.getState().bySession
  if (prev.size === next.size) {
    let same = true
    for (const [id, p] of next) {
      const q = prev.get(id)
      if (!q || !samePending(p, q)) {
        same = false
        break
      }
    }
    if (same) return
  }
  useBackgroundPendingStore.setState({ bySession: next })
}

/** What a server entry puts on its row; `null` when it clears the row.
 *  Cowork fork (#386): an entry with `state` goes by it — `uncertain` stays
 *  even at `count: 0`, `idle` clears; one without (an older server) goes by
 *  `count` as before. */
function pendingOfEntry(
  entry: BackgroundPendingEntry
): BackgroundPending | null {
  if (entry.state === "uncertain") {
    return {
      count: entry.count,
      names: (entry.tasks ?? []).map((t) => t.name || t.task_id),
      state: "uncertain",
      reason: entry.reason ?? null,
    }
  }
  if (entry.state === "abandoned") {
    return {
      count: 0,
      names: (entry.tasks ?? []).map((t) => t.name || t.task_id),
      state: "abandoned",
    }
  }
  if (entry.state === "idle" || entry.count <= 0) return null
  return { count: entry.count, names: entry.names ?? [] }
}

/** Cowork fork: replace the server source from a full listing
 *  (`acp_list_background_pending`), on load and after a reconnect. */
export function replaceServerBackgroundPending(
  entries: Iterable<BackgroundPendingEntry>
): void {
  const next = new Map<number, BackgroundPending>()
  for (const entry of entries) {
    const pending = pendingOfEntry(entry)
    if (pending) next.set(entry.conversation_id, pending)
  }
  useBackgroundPendingStore.setState({ byConversation: next })
}

/** Cowork fork: apply one `conversation://background` broadcast — the
 *  conversation's whole current state, `count: 0` (or `state: "idle"`)
 *  clearing it. A no-op (same reference) when it changes nothing. */
export function applyServerBackgroundPending(
  entry: BackgroundPendingEntry
): void {
  const prev = useBackgroundPendingStore.getState().byConversation
  const have = prev.get(entry.conversation_id)
  const pending = pendingOfEntry(entry)
  if (!pending) {
    if (!have) return
    const next = new Map(prev)
    next.delete(entry.conversation_id)
    useBackgroundPendingStore.setState({ byConversation: next })
    return
  }
  if (have && samePending(have, pending)) return
  const next = new Map(prev)
  next.set(entry.conversation_id, pending)
  useBackgroundPendingStore.setState({ byConversation: next })
}

/** The live background work of a conversation: its connection's here when one
 *  is attached, else what the server says about conversation `conversationId`
 *  (Cowork fork), else `null`. A server「?」(#386) wins over this window's
 *  connection: the server watches the process, the connection here only
 *  relays what the agent last said. */
export function backgroundPendingFor(
  state: BackgroundPendingState,
  externalId: string | null | undefined,
  conversationId?: number | null
): BackgroundPending | null {
  const server =
    conversationId != null
      ? state.byConversation.get(conversationId)
      : undefined
  if (server?.state === "uncertain") return server
  const live = externalId ? state.bySession.get(externalId) : undefined
  if (live) return live
  return server ?? null
}

/** Cowork fork (#386): what a row shows for its background work — the
 *  hourglass (`waiting`: the turn ended, work still out) or the「?」
 *  (`uncertain`); at most one is set. A completed / cancelled conversation
 *  never shows a「?」: the user (or the agent) has closed it. */
export interface BackgroundMark {
  waiting: BackgroundPending | null
  uncertain: BackgroundPending | null
  /** #817：取消的行上没跑完的后台任务（红叉的悬停写任务名），只在有的时候带。 */
  abandoned?: BackgroundPending
}

const NO_MARK: BackgroundMark = { waiting: null, uncertain: null }

export function backgroundMarkOf(
  status: string,
  pending: BackgroundPending | null
): BackgroundMark {
  if (!pending) return NO_MARK
  if (pending.state === "abandoned") {
    return status === "cancelled"
      ? { waiting: null, uncertain: null, abandoned: pending }
      : NO_MARK
  }
  if (pending.state === "uncertain") {
    return status === "completed" || status === "cancelled"
      ? NO_MARK
      : { waiting: null, uncertain: pending }
  }
  return status === "in_progress"
    ? NO_MARK
    : { waiting: pending, uncertain: null }
}

type MarkInput = { id: number; external_id: string | null; status: string }

/** {@link backgroundMarkOf} of a conversation, read from a store snapshot. */
export function backgroundMarkFor(
  state: BackgroundPendingState,
  conv: MarkInput
): BackgroundMark {
  return backgroundMarkOf(
    conv.status,
    backgroundPendingFor(state, conv.external_id, conv.id)
  )
}

/** Cowork fork (#386): the background work holds the row's unread back —
 *  waiting or「?」, the agent is not done yet. */
export function holdsBackUnread(
  state: BackgroundPendingState,
  conv: MarkInput
): boolean {
  const mark = backgroundMarkFor(state, conv)
  return mark.waiting != null || mark.uncertain != null
}

/** Cowork fork (#386): first in the sidebar's attention order — its turn
 *  runs, or it waits on background work, or the server marked it「?」. The
 *  running counts go by {@link countsAsRunning} instead (#435). */
export function isConversationActive(
  state: BackgroundPendingState,
  conv: MarkInput
): boolean {
  return conv.status === "in_progress" || holdsBackUnread(state, conv)
}

/** Cowork fork (#435): counts in「N sessions running」(the bell, folder and
 *  group badges) — its turn runs, or it waits on background work. A「?」is
 *  left out: no live process moves it. */
export function countsAsRunning(
  state: BackgroundPendingState,
  conv: MarkInput
): boolean {
  return (
    conv.status === "in_progress" ||
    backgroundMarkFor(state, conv).waiting != null
  )
}

/** The live background work of the session behind `externalId` — or, with no
 *  connection to it here, of conversation `conversationId` — or `null`. */
export function useBackgroundPending(
  externalId: string | null | undefined,
  conversationId?: number | null
): BackgroundPending | null {
  return useBackgroundPendingStore(
    useShallow((s) => backgroundPendingFor(s, externalId, conversationId))
  )
}

/**
 * Cowork fork: keep the server source current — subscribe to
 * `conversation://background`, then read the full listing, and read it again
 * after a WebSocket reconnect (the broadcaster drops what fires while nobody
 * is listening). The read waits for the subscription, as
 * `useConversationTagsSync` does, so a change can't fall between the two.
 * Mount once per window — the workspace layout does.
 */
export function useBackgroundPendingSync(): void {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    const seed = () => {
      Promise.resolve()
        .then(() => acpListBackgroundPending())
        .then((entries) => {
          if (!disposed) replaceServerBackgroundPending(entries)
        })
        .catch(() => {
          // An older server has no such command: rows fall back to what this
          // client's own connections know.
        })
    }

    void (async () => {
      try {
        const dispose = await subscribe<BackgroundPendingEntry>(
          BACKGROUND_PENDING_EVENT,
          (entry) => applyServerBackgroundPending(entry)
        )
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
      } catch (err) {
        // Not live, but still worth a read: a reconnect re-reads again.
        console.error("[BackgroundPending] subscribe failed:", err)
      }
      if (!disposed) seed()
    })()

    const offReconnect = onTransportReconnect(seed)

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}

/** The bridge component for layouts: mounts {@link useBackgroundPendingSync}. */
export function BackgroundPendingSync(): null {
  useBackgroundPendingSync()
  return null
}
