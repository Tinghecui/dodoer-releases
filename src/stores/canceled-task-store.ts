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
 *
 * 任务删掉以后就不在列表里了（#788），这时看会话摘要里服务器带的
 * `task_canceled`；列表里还有的任务以列表为准（重新排队的任务，摘要里的
 * 标记可能还是旧的）。
 */
interface CanceledTaskState {
  conversationIds: ReadonlySet<number>
  /** 列表里所有任务（不管什么状态）的会话。 */
  taskConversationIds: ReadonlySet<number>
}

export const useCanceledTaskStore = create<CanceledTaskState>(() => ({
  conversationIds: new Set(),
  taskConversationIds: new Set(),
}))

function sameSet(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  return a.size === b.size && [...b].every((id) => a.has(id))
}

/** Replace the set from the full task list. A no-op (same reference) when it
 *  did not change, so a refetch that moved nothing here re-renders no row. */
export function publishCanceledTasks(tasks: Iterable<WorkTask>): void {
  const next = new Set<number>()
  const owned = new Set<number>()
  for (const task of tasks) {
    if (task.conversation_id == null) continue
    owned.add(task.conversation_id)
    if (task.status === "canceled") next.add(task.conversation_id)
  }
  const prev = useCanceledTaskStore.getState()
  if (
    sameSet(prev.conversationIds, next) &&
    sameSet(prev.taskConversationIds, owned)
  ) {
    return
  }
  useCanceledTaskStore.setState({
    conversationIds: sameSet(prev.conversationIds, next)
      ? prev.conversationIds
      : next,
    taskConversationIds: sameSet(prev.taskConversationIds, owned)
      ? prev.taskConversationIds
      : owned,
  })
}

/** Whether conversation `conversationId` is the session of a canceled task.
 *  `persisted` 是会话摘要里的 `task_canceled`：列表里没有哪个任务用这个会话
 *  （任务已删除，或列表还没加载）时用它。 */
export function useIsCanceledTaskConversation(
  conversationId: number | null | undefined,
  persisted?: boolean
): boolean {
  return useCanceledTaskStore((s) => {
    if (conversationId == null) return false
    if (s.conversationIds.has(conversationId)) return true
    if (s.taskConversationIds.has(conversationId)) return false
    return persisted === true
  })
}
