import { create } from "zustand"
import type { WorkTask } from "@/lib/types"

/**
 * Conversations (`conversation.id`) of the work tasks the user canceled
 * (#178), published from the always-mounted task list (`publishCanceledTasks`
 * in `TasksViewProvider`).
 *
 * A sidebar row cannot tell this on its own. Canceling a running task stores
 * its turn as `cancelled` — but the backend stores a turn the agent refused or
 * could not run (not signed in) as `cancelled` too, so the row's cross only
 * says "this turn did not finish" (#102). And a task canceled after its turn
 * already ended (in review) leaves the conversation `pending_review`, whose
 * unread dot says "finished". With this set, the row of a canceled task says
 * "cancelled, not viewed yet" in both cases.
 *
 * Client-only, like the task source of `awaiting-user-store`: empty until the
 * task list first loads. A task put back in the queue leaves the set with the
 * next list.
 */
interface CanceledTaskState {
  conversationIds: ReadonlySet<number>
}

export const useCanceledTaskStore = create<CanceledTaskState>(() => ({
  conversationIds: new Set(),
}))

/** Replace the set from the full task list. A no-op (same reference) when it
 *  did not change, so a refetch that moved nothing here re-renders no row. */
export function publishCanceledTasks(tasks: Iterable<WorkTask>): void {
  const next = new Set<number>()
  for (const task of tasks) {
    if (task.status === "canceled" && task.conversation_id != null) {
      next.add(task.conversation_id)
    }
  }
  const prev = useCanceledTaskStore.getState().conversationIds
  if (prev.size === next.size && [...next].every((id) => prev.has(id))) return
  useCanceledTaskStore.setState({ conversationIds: next })
}

/** Whether conversation `conversationId` is the session of a canceled task. */
export function useIsCanceledTaskConversation(
  conversationId: number | null | undefined
): boolean {
  return useCanceledTaskStore(
    (s) => conversationId != null && s.conversationIds.has(conversationId)
  )
}
