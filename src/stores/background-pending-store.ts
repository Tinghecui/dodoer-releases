import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import { liveAsyncTasks } from "@/lib/async-tasks"
import type { AsyncTaskRecord } from "@/lib/types"

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
}

export const useBackgroundPendingStore = create<BackgroundPendingState>(() => ({
  bySession: new Map(),
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

/** The live background work of the session behind `externalId`, or `null`. */
export function useBackgroundPending(
  externalId: string | null | undefined
): BackgroundPending | null {
  return useBackgroundPendingStore(
    useShallow((s) =>
      externalId ? (s.bySession.get(externalId) ?? null) : null
    )
  )
}
