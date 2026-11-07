import { create } from "zustand"
import { getConversationGoalMarkers } from "@/lib/api"
import {
  findLatestGoalStatus,
  type ConversationGoalStatus,
} from "@/lib/conversation-goal-status"

/**
 * The goal status of sidebar rows this client holds NO runtime copy of — a
 * session never opened since the reload. The runtime store answers for opened
 * tabs from their live timeline; everything else is looked up here from the
 * backend's goal markers (`get_conversation_goal_markers`), so the sidebar's
 * goal badge depends only on whether the session holds a goal (issue #83).
 *
 * Keyed by DB conversation id and stamped with the row's `updated_at` at
 * lookup time: a goal change always comes with a turn, and a turn bumps
 * `updated_at`, so a row whose stamp moved is looked up again and an
 * unchanged one never is. Lookups requested in the same tick go out as ONE
 * batched call. Client-only, not persisted.
 */
interface GoalSnapshot {
  /** The `updated_at` the lookup was made for. */
  key: string
  goal: ConversationGoalStatus | null
}

interface GoalSnapshotState {
  byId: Record<number, GoalSnapshot>
}

export const useConversationGoalSnapshotStore = create<GoalSnapshotState>(
  () => ({ byId: {} })
)

/** In flight or queued: id → the key it is being looked up for. */
const requested = new Map<number, string>()
let queue = new Map<number, string>()
let flushScheduled = false
/** Bumped by reset so a lookup from before it cannot commit after it. */
let epoch = 0

/**
 * The last looked-up goal of `conversationId`, or `null`. While a re-lookup
 * for a newer `updated_at` is under way the previous answer keeps showing, so
 * the badge does not blink off on every turn.
 */
export function selectGoalSnapshot(
  state: GoalSnapshotState,
  conversationId: number
): ConversationGoalStatus | null {
  return state.byId[conversationId]?.goal ?? null
}

/**
 * Ask for `conversationId`'s goal as of `key` (its `updated_at`). A no-op when
 * that exact lookup already landed or is under way.
 */
export function requestConversationGoalSnapshot(
  conversationId: number,
  key: string
): void {
  if (
    useConversationGoalSnapshotStore.getState().byId[conversationId]?.key ===
    key
  )
    return
  if (requested.get(conversationId) === key) return
  requested.set(conversationId, key)
  queue.set(conversationId, key)
  if (flushScheduled) return
  flushScheduled = true
  // A macrotask, not a microtask: every row of a list mounts (and runs its
  // effect) before the batch leaves.
  setTimeout(flush, 0)
}

/** Mirrors the backend's `GOAL_MARKERS_BATCH_MAX`. */
const BATCH_MAX = 200

function flush(): void {
  flushScheduled = false
  const all = [...queue]
  queue = new Map()
  for (let i = 0; i < all.length; i += BATCH_MAX) {
    lookUp(new Map(all.slice(i, i + BATCH_MAX)))
  }
}

function lookUp(batch: Map<number, string>): void {
  const startedEpoch = epoch
  getConversationGoalMarkers([...batch.keys()])
    .then((results) => {
      if (startedEpoch !== epoch) return
      const turnsById = new Map(
        results.map((r) => [r.conversation_id, r.turns] as const)
      )
      useConversationGoalSnapshotStore.setState((state) => {
        const byId = { ...state.byId }
        for (const [id, key] of batch) {
          // A newer lookup for this row superseded this one.
          if (requested.get(id) !== key) continue
          requested.delete(id)
          const turns = turnsById.get(id)
          byId[id] = { key, goal: turns ? findLatestGoalStatus(turns) : null }
        }
        return { byId }
      })
    })
    .catch(() => {
      if (startedEpoch !== epoch) return
      // Best-effort: leave the rows unknown (no badge) and let the next
      // change of the row retry.
      for (const [id, key] of batch) {
        if (requested.get(id) === key) requested.delete(id)
      }
    })
}

export function resetConversationGoalSnapshotStore(): void {
  epoch++
  requested.clear()
  queue = new Map()
  flushScheduled = false
  useConversationGoalSnapshotStore.setState({ byId: {} })
}
