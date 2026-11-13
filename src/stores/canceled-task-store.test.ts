import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import type { WorkTask } from "@/lib/types"
import {
  publishCanceledTasks,
  useCanceledTaskStore,
  useIsCanceledTaskConversation,
} from "./canceled-task-store"

beforeEach(() => {
  useCanceledTaskStore.setState({ conversationIds: new Set() })
})

/** A task row, reduced to what `publishCanceledTasks` reads. */
function task(
  id: number,
  status: WorkTask["status"],
  over: Partial<WorkTask> = {}
): WorkTask {
  return { id, status, conversation_id: id * 10, ...over } as WorkTask
}
const ids = () => useCanceledTaskStore.getState().conversationIds

// #178: which sidebar rows belong to a task the user canceled.
describe("publishCanceledTasks", () => {
  it("collects the conversations of canceled tasks, and only those", () => {
    publishCanceledTasks([
      task(1, "canceled"),
      task(2, "done"),
      task(3, "failed"),
      task(4, "review"),
      // Archived, still canceled.
      task(5, "canceled", { archived_at: "2026-11-13T00:00:00Z" }),
      // Canceled before it ever ran: no session.
      task(6, "canceled", { conversation_id: null }),
    ])
    expect([...ids()].sort((a, b) => a - b)).toEqual([10, 50])
  })

  it("keeps the set when nothing moved, and drops a requeued task", () => {
    publishCanceledTasks([task(1, "canceled"), task(2, "canceled")])
    const before = ids()
    publishCanceledTasks([task(2, "canceled"), task(1, "canceled")])
    expect(ids()).toBe(before)
    publishCanceledTasks([task(1, "queued"), task(2, "canceled")])
    expect([...ids()]).toEqual([20])
    publishCanceledTasks([])
    expect(ids().size).toBe(0)
  })
})

describe("useIsCanceledTaskConversation", () => {
  it("follows the published list", () => {
    const { result } = renderHook(() => useIsCanceledTaskConversation(10))
    expect(result.current).toBe(false)
    act(() => publishCanceledTasks([task(1, "canceled")]))
    expect(result.current).toBe(true)
    act(() => publishCanceledTasks([task(1, "queued")]))
    expect(result.current).toBe(false)
  })

  it("is false without a conversation id", () => {
    act(() => publishCanceledTasks([task(1, "canceled")]))
    const { result } = renderHook(() => useIsCanceledTaskConversation(null))
    expect(result.current).toBe(false)
  })
})
