import { useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import type { ConversationGoalStatus } from "@/lib/conversation-goal-status"
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
 */
export function useConversationGoalStatus(
  conversationId: number,
  lookupKey: string | null
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
  const fromRuntime = hasHistory || runtimeGoal !== null
  useEffect(() => {
    if (!fromRuntime && lookupKey !== null) {
      requestConversationGoalSnapshot(conversationId, lookupKey)
    }
  }, [fromRuntime, conversationId, lookupKey])
  if (fromRuntime) return runtimeGoal
  return lookupKey === null ? null : snapshotGoal
}
