import { useShallow } from "zustand/react/shallow"
import type { ConversationGoalStatus } from "@/lib/conversation-goal-status"
import {
  selectConversationGoalStatus,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

/**
 * The goal the conversation's agent currently holds (see
 * `findLatestGoalStatus`), or `null`. Only sessions this client has a runtime
 * copy of can answer — an opened tab, or a session whose background activity
 * reached the store — so a never-opened row reads as "no goal". Re-renders
 * only when the status/objective pair changes, not on every streaming delta.
 */
export function useConversationGoalStatus(
  conversationId: number
): ConversationGoalStatus | null {
  return useConversationRuntimeStore(
    useShallow((s) => selectConversationGoalStatus(s, conversationId))
  )
}
