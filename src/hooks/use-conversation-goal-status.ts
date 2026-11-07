import { useEffect } from "react"
import { useShallow } from "zustand/react/shallow"
import type { ConversationGoalStatus } from "@/lib/conversation-goal-status"
import {
  selectConversationGoalStatus,
  selectHasConversationRuntime,
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
 * copy of (an opened tab, or one whose background activity reached the store)
 * answers from its live timeline. Any other row is looked up from the backend
 * (`conversation-goal-snapshot-store`) as of `lookupKey` — pass the row's
 * `updated_at` so a changed row is re-checked, or `null` when the row has no
 * session to read (it then reads "no goal"). Re-renders only when the
 * status/objective pair changes, not on every streaming delta.
 */
export function useConversationGoalStatus(
  conversationId: number,
  lookupKey: string | null
): ConversationGoalStatus | null {
  const hasRuntime = useConversationRuntimeStore((s) =>
    selectHasConversationRuntime(s, conversationId)
  )
  const runtimeGoal = useConversationRuntimeStore(
    useShallow((s) => selectConversationGoalStatus(s, conversationId))
  )
  const snapshotGoal = useConversationGoalSnapshotStore(
    useShallow((s) => selectGoalSnapshot(s, conversationId))
  )
  useEffect(() => {
    if (!hasRuntime && lookupKey !== null) {
      requestConversationGoalSnapshot(conversationId, lookupKey)
    }
  }, [hasRuntime, conversationId, lookupKey])
  if (hasRuntime) return runtimeGoal
  return lookupKey === null ? null : snapshotGoal
}
