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
  /** How many pieces of background work are still live (at least 1). */
  count: number
  /** Labels of the live async tasks (may be fewer than `count`: the
   *  transcript watcher only counts). */
  names: string[]
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

function samePending(a: BackgroundPending, b: BackgroundPending): boolean {
  return (
    a.count === b.count &&
    a.names.length === b.names.length &&
    a.names.every((n, i) => n === b.names[i])
  )
}

/**
 * Replace the whole map from the current connections. Several connections can
 * share a session (a viewer window, a re-keyed tab): the one with the most
 * outstanding work wins. A no-op (same reference) when nothing changed.
 */
export function publishBackgroundPending(
  connections: Iterable<{
    sessionId: string | null
    asyncTasks: AsyncTaskRecord[]
    backgroundOutstanding: number
  }>
): void {
  const next = new Map<string, BackgroundPending>()
  for (const conn of connections) {
    if (!conn.sessionId) continue
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

function pendingOfEntry(entry: BackgroundPendingEntry): BackgroundPending {
  return { count: entry.count, names: entry.names ?? [] }
}

/** Cowork fork: replace the server source from a full listing
 *  (`acp_list_background_pending`), on load and after a reconnect. */
export function replaceServerBackgroundPending(
  entries: Iterable<BackgroundPendingEntry>
): void {
  const next = new Map<number, BackgroundPending>()
  for (const entry of entries) {
    if (entry.count > 0) next.set(entry.conversation_id, pendingOfEntry(entry))
  }
  useBackgroundPendingStore.setState({ byConversation: next })
}

/** Cowork fork: apply one `conversation://background` broadcast — the
 *  conversation's whole current state, `count: 0` clearing it. A no-op (same
 *  reference) when it changes nothing. */
export function applyServerBackgroundPending(
  entry: BackgroundPendingEntry
): void {
  const prev = useBackgroundPendingStore.getState().byConversation
  const have = prev.get(entry.conversation_id)
  if (entry.count <= 0) {
    if (!have) return
    const next = new Map(prev)
    next.delete(entry.conversation_id)
    useBackgroundPendingStore.setState({ byConversation: next })
    return
  }
  const pending = pendingOfEntry(entry)
  if (have && samePending(have, pending)) return
  const next = new Map(prev)
  next.set(entry.conversation_id, pending)
  useBackgroundPendingStore.setState({ byConversation: next })
}

/** The live background work of a conversation: its connection's here when one
 *  is attached, else what the server says about conversation `conversationId`
 *  (Cowork fork), else `null`. */
export function backgroundPendingFor(
  state: BackgroundPendingState,
  externalId: string | null | undefined,
  conversationId?: number | null
): BackgroundPending | null {
  const live = externalId ? state.bySession.get(externalId) : undefined
  if (live) return live
  return conversationId != null
    ? (state.byConversation.get(conversationId) ?? null)
    : null
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
