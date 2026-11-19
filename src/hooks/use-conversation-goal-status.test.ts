import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { StoreApi, UseBoundStore } from "zustand"
import * as api from "@/lib/api"
import type { ConversationGoalStatus } from "@/lib/conversation-goal-status"
import type { MessageTurn } from "@/lib/types"
import { resetConversationGoalSnapshotStore } from "@/stores/conversation-goal-snapshot-store"
import { useConversationGoalStatus } from "./use-conversation-goal-status"

// 实时那份只留这个 hook 读的两项：有没有历史、时间线上最后一个目标标记。
interface FakeRuntime {
  hasHistory: boolean
  goal: ConversationGoalStatus | null
}
const fakeRuntime = vi.hoisted(() => ({
  store: null as unknown as UseBoundStore<StoreApi<FakeRuntime>>,
}))
vi.mock("@/stores/conversation-runtime-store", async () => {
  const { create } = await import("zustand")
  fakeRuntime.store = create<FakeRuntime>(() => ({
    hasHistory: false,
    goal: null,
  }))
  return {
    useConversationRuntimeStore: fakeRuntime.store,
    selectHasConversationHistory: (s: FakeRuntime) => s.hasHistory,
    selectConversationGoalStatus: (s: FakeRuntime) => s.goal,
  }
})

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  getConversationGoalMarkers: vi.fn(async () => []),
}))

const goalMarkers = vi.mocked(api.getConversationGoalMarkers)

function goalTurn(
  toolName: "create_goal" | "update_goal",
  goal: { status: string; objective: string }
): MessageTurn {
  return {
    id: "t1",
    role: "assistant",
    timestamp: "2026-11-19T00:00:00Z",
    blocks: [
      {
        type: "tool_use",
        tool_use_id: "t1-call",
        tool_name: toolName,
        input_preview: JSON.stringify(goal),
      },
      {
        type: "tool_result",
        tool_use_id: "t1-call",
        output_preview: JSON.stringify({ goal }),
        is_error: false,
      },
    ],
  }
}

const ACTIVE: ConversationGoalStatus = {
  status: "active",
  objective: "write g.txt",
}

describe("useConversationGoalStatus on an opened session", () => {
  beforeEach(() => {
    resetConversationGoalSnapshotStore()
    goalMarkers.mockReset()
    goalMarkers.mockResolvedValue([])
    fakeRuntime.store.setState({ hasHistory: true, goal: ACTIVE })
  })

  // #896：Claude 的 /goal 做完了，适配器没发结束的快照，实时时间线最后一个标记
  // 还是 create_goal(active)；会话记录里已经写着完成。
  it("a goal the transcript closed after the turn ended no longer reads open", async () => {
    goalMarkers.mockResolvedValue([
      {
        conversation_id: 7,
        turns: [
          goalTurn("update_goal", {
            status: "complete",
            objective: "write g.txt",
          }),
        ],
      },
    ])
    const { result } = renderHook(() =>
      useConversationGoalStatus(7, "2026-11-19T00:01:00Z", true)
    )
    await waitFor(() => expect(result.current?.status).toBe("complete"))
  })

  it("while the turn is still running the live timeline answers, no lookup", async () => {
    const { result } = renderHook(() =>
      useConversationGoalStatus(7, "2026-11-19T00:01:00Z", false)
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
    expect(goalMarkers).not.toHaveBeenCalled()
    expect(result.current).toEqual(ACTIVE)
  })

  it("a backend with no goal markers does not hide a live open goal", async () => {
    const { result } = renderHook(() =>
      useConversationGoalStatus(7, "2026-11-19T00:01:00Z", true)
    )
    await waitFor(() => expect(goalMarkers).toHaveBeenCalledTimes(1))
    await act(async () => {})
    expect(result.current).toEqual(ACTIVE)
  })

  it("a backend answer for an older row state does not override", async () => {
    goalMarkers.mockResolvedValue([
      {
        conversation_id: 7,
        turns: [
          goalTurn("update_goal", {
            status: "complete",
            objective: "old goal",
          }),
        ],
      },
    ])
    const { result, rerender } = renderHook(
      ({ key }: { key: string }) => useConversationGoalStatus(7, key, true),
      { initialProps: { key: "2026-11-19T00:01:00Z" } }
    )
    await waitFor(() => expect(result.current?.status).toBe("complete"))
    // 新一轮又开了目标，行的 updated_at 变了，新的查询还没回来。
    goalMarkers.mockImplementation(() => new Promise(() => {}))
    rerender({ key: "2026-11-19T00:05:00Z" })
    expect(result.current).toEqual(ACTIVE)
  })
})
