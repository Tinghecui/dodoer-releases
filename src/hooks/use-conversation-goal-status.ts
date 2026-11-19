import { useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import {
  isGoalOpen,
  type ConversationGoalStatus,
} from "@/lib/conversation-goal-status"
import {
  selectConversationGoalStatus,
  selectHasConversationHistory,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import {
  requestConversationGoalSnapshot,
  selectGoalSnapshot,
  useConversationGoalSnapshotStore,
} from "@/stores/conversation-goal-snapshot-store"

/**
 * The goal the conversation's agent currently holds (see
 * `findLatestGoalStatus`), or `null`. A session this client has a runtime
 * copy of answers from its live timeline when that copy has the history
 * loaded (an opened tab) or already shows a goal. Any other row — including
 * one whose background activity alone reached the store — is looked up from
 * the backend (`conversation-goal-snapshot-store`) as of `lookupKey`: pass
 * the row's `updated_at` so a changed row is re-checked, or `null` when the
 * row has no session to read (it then reads "no goal"). Re-renders only when
 * the status/objective pair changes, not on every streaming delta.
 *
 * `turnSettled` is whether the row's turn has ended (not `in_progress`). The
 * live timeline only learns a goal closed when the adapter sends a closing
 * `_meta.goal`; Claude's `/goal` can end without one, leaving the last live
 * marker `create_goal(active)` while the transcript already says `met` — so
 * the badge said "goal in progress" until a reload, then vanished (#896).
 * Once the turn has ended with the live copy still showing an open goal, the
 * backend is asked too, and its answer for the current `lookupKey` wins when
 * it says the goal is closed. "No goal at all" from the backend does not
 * override (an unreadable transcript must not hide a live goal).
 */
export function useConversationGoalStatus(
  conversationId: number,
  lookupKey: string | null,
  turnSettled = false
): ConversationGoalStatus | null {
  const hasHistory = useConversationRuntimeStore((s) =>
    selectHasConversationHistory(s, conversationId)
  )
  const runtimeGoal = useConversationRuntimeStore(
    useShallow((s) => selectConversationGoalStatus(s, conversationId))
  )
  const snapshotGoal = useConversationGoalSnapshotStore(
    useShallow((s) => selectGoalSnapshot(s, conversationId))
  )
  const snapshotKey = useConversationGoalSnapshotStore(
    (s) => s.byId[conversationId]?.key ?? null
  )
  const fromRuntime = hasHistory || runtimeGoal !== null
  // The live copy still says "open" after the turn ended: double-check it
  // against the transcript.
  const verifyRuntime =
    fromRuntime && turnSettled && lookupKey !== null && isGoalOpen(runtimeGoal)
  const lookUp = !fromRuntime || verifyRuntime
  useEffect(() => {
    if (lookUp && lookupKey !== null) {
      requestConversationGoalSnapshot(conversationId, lookupKey)
    }
  }, [lookUp, conversationId, lookupKey])
  if (fromRuntime) {
    if (
      verifyRuntime &&
      snapshotKey === lookupKey &&
      snapshotGoal !== null &&
      !isGoalOpen(snapshotGoal)
    ) {
      return snapshotGoal
    }
    return runtimeGoal
  }
  return lookupKey === null ? null : snapshotGoal
}
