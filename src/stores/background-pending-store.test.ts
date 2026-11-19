import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type {
  AsyncTaskRecord,
  BackgroundPendingEntry,
  BackgroundUncertainReason,
  ConnectionStatus,
} from "@/lib/types"
import {
  applyServerBackgroundPending,
  backgroundMarkFor,
  backgroundMarkOf,
  backgroundPendingOf,
  countsAsRunning,
  isConversationActive,
  publishBackgroundPending,
  replaceServerBackgroundPending,
  reportsBackgroundPending,
  useBackgroundPending,
  useBackgroundPendingStore,
  useBackgroundPendingSync,
} from "./background-pending-store"

// Cowork fork: the server feed the sync hook wires up.
const h = vi.hoisted(() => ({
  channel: null as null | string,
  handler: null as null | ((entry: unknown) => void),
  reconnect: null as null | (() => void),
  dispose: vi.fn(),
  offReconnect: vi.fn(),
  list: vi.fn(async (): Promise<unknown[]> => []),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async (channel: string, handler: (e: unknown) => void) => {
    h.channel = channel
    h.handler = handler
    return h.dispose
  }),
  onTransportReconnect: vi.fn((cb: () => void) => {
    h.reconnect = cb
    return h.offReconnect
  }),
}))

vi.mock("@/lib/api", () => ({
  acpListBackgroundPending: h.list,
}))

const entry = (
  conversationId: number,
  count: number,
  names: string[] = []
): BackgroundPendingEntry => ({ conversation_id: conversationId, count, names })

function task(id: string, state: string, name = `task ${id}`): AsyncTaskRecord {
  return {
    task_id: id,
    name,
    task_type: "shell",
    description: "",
    show_in_transcript: false,
    can_stop: true,
    state,
  }
}

const conn = (
  sessionId: string | null,
  asyncTasks: AsyncTaskRecord[] = [],
  backgroundOutstanding = 0
) => ({ sessionId, asyncTasks, backgroundOutstanding })

beforeEach(() => {
  useBackgroundPendingStore.setState({
    bySession: new Map(),
    byConversation: new Map(),
  })
})

describe("backgroundPendingOf", () => {
  it("is null with nothing live", () => {
    expect(backgroundPendingOf(conn("s"))).toBeNull()
    expect(
      backgroundPendingOf(
        conn("s", [task("1", "completed"), task("2", "failed")])
      )
    ).toBeNull()
  })

  it("counts live tasks and the watcher's outstanding as overlapping, not summed", () => {
    expect(
      backgroundPendingOf(
        conn(
          "s",
          [task("1", "running", "Wait for CI"), task("2", "stopped")],
          1
        )
      )
    ).toEqual({ count: 1, names: ["Wait for CI"] })
    // The watcher can see work AIR never announced (and vice versa).
    expect(backgroundPendingOf(conn("s", [], 2))).toEqual({
      count: 2,
      names: [],
    })
    expect(
      backgroundPendingOf(
        conn("s", [task("1", "paused"), task("2", "running")])
      )
    ).toEqual({ count: 2, names: ["task 1", "task 2"] })
  })
})

describe("publishBackgroundPending", () => {
  it("keys by session, skips sessionless connections, keeps the busiest of a shared session", () => {
    publishBackgroundPending([
      conn(null, [task("1", "running")]),
      conn("a", [task("1", "running")]),
      conn("a", [task("1", "running"), task("2", "running")]),
      conn("b"),
    ])
    const map = useBackgroundPendingStore.getState().bySession
    expect([...map.keys()]).toEqual(["a"])
    expect(map.get("a")?.count).toBe(2)
  })

  it("leaves the map reference alone when nothing changed", () => {
    publishBackgroundPending([conn("a", [task("1", "running")])])
    const before = useBackgroundPendingStore.getState().bySession
    publishBackgroundPending([conn("a", [task("1", "running")])])
    expect(useBackgroundPendingStore.getState().bySession).toBe(before)
    publishBackgroundPending([conn("a", [task("1", "completed")])])
    expect(useBackgroundPendingStore.getState().bySession.size).toBe(0)
  })

  it("skips a disconnected or errored connection, keeps a live one of the same session", () => {
    const disconnected: ConnectionStatus = "disconnected"
    const errored: ConnectionStatus = "error"
    const connected: ConnectionStatus = "connected"
    publishBackgroundPending([
      {
        ...conn("a", [task("1", "running"), task("2", "running")]),
        status: disconnected,
      },
      { ...conn("b", [], 3), status: errored },
      { ...conn("a", [task("1", "running")]), status: connected },
      { ...conn("c", [], 1), status: "prompting" as const },
    ])
    const map = useBackgroundPendingStore.getState().bySession
    expect([...map.keys()].sort()).toEqual(["a", "c"])
    expect(map.get("a")?.count).toBe(1)
  })

  it("drops a session's count once its only connection disconnects", () => {
    publishBackgroundPending([
      { ...conn("a", [], 2), status: "connected" as const },
    ])
    expect(useBackgroundPendingStore.getState().bySession.get("a")?.count).toBe(
      2
    )
    publishBackgroundPending([
      { ...conn("a", [], 2), status: "disconnected" as const },
    ])
    expect(useBackgroundPendingStore.getState().bySession.size).toBe(0)
  })
})

describe("reportsBackgroundPending", () => {
  it("is false only for a disconnected or errored connection", () => {
    expect(reportsBackgroundPending("disconnected")).toBe(false)
    expect(reportsBackgroundPending("error")).toBe(false)
    expect(reportsBackgroundPending("connected")).toBe(true)
    expect(reportsBackgroundPending("prompting")).toBe(true)
    expect(reportsBackgroundPending("connecting")).toBe(true)
    expect(reportsBackgroundPending(undefined)).toBe(true)
  })
})

describe("useBackgroundPending", () => {
  it("follows the session behind an external id", () => {
    const { result } = renderHook(() => useBackgroundPending("a"))
    expect(result.current).toBeNull()
    act(() => publishBackgroundPending([conn("a", [task("1", "running")])]))
    expect(result.current).toEqual({ count: 1, names: ["task 1"] })
    act(() => publishBackgroundPending([conn("a", [task("1", "completed")])]))
    expect(result.current).toBeNull()
  })

  it("is null for a conversation without an external id", () => {
    act(() => publishBackgroundPending([conn("a", [task("1", "running")])]))
    const { result } = renderHook(() => useBackgroundPending(null))
    expect(result.current).toBeNull()
  })
})

describe("server background pending (Cowork fork)", () => {
  beforeEach(() => {
    h.list.mockClear()
    h.dispose.mockClear()
    h.offReconnect.mockClear()
  })

  it("covers a conversation this client holds no connection to", () => {
    const { result } = renderHook(() => useBackgroundPending("sess-9", 9))
    expect(result.current).toBeNull()
    act(() => replaceServerBackgroundPending([entry(9, 1, ["Watch CI"])]))
    expect(result.current).toEqual({ count: 1, names: ["Watch CI"] })
    act(() => applyServerBackgroundPending(entry(9, 0)))
    expect(result.current).toBeNull()
  })

  it("lets this client's own connection win where both know the session", () => {
    act(() => {
      replaceServerBackgroundPending([entry(9, 2)])
      publishBackgroundPending([conn("sess-9", [task("1", "running")])])
    })
    const { result } = renderHook(() => useBackgroundPending("sess-9", 9))
    expect(result.current).toEqual({ count: 1, names: ["task 1"] })
  })

  it("applies a broadcast as the conversation's whole state, a no-op when unchanged", () => {
    applyServerBackgroundPending(entry(4, 1, ["a"]))
    const before = useBackgroundPendingStore.getState().byConversation
    applyServerBackgroundPending(entry(4, 1, ["a"]))
    expect(useBackgroundPendingStore.getState().byConversation).toBe(before)
    applyServerBackgroundPending(entry(4, 2, ["a", "b"]))
    expect(useBackgroundPendingStore.getState().byConversation.get(4)).toEqual({
      count: 2,
      names: ["a", "b"],
    })
    // Clearing one it never had is a no-op too.
    const after = useBackgroundPendingStore.getState().byConversation
    applyServerBackgroundPending(entry(5, 0))
    expect(useBackgroundPendingStore.getState().byConversation).toBe(after)
  })

  it("syncs: subscribes, then reads the listing, and re-reads after a reconnect", async () => {
    h.list.mockResolvedValueOnce([entry(7, 1, ["Watch CI"])])
    const { unmount } = renderHook(() => useBackgroundPendingSync())
    await waitFor(() =>
      expect(
        useBackgroundPendingStore.getState().byConversation.get(7)
      ).toEqual({ count: 1, names: ["Watch CI"] })
    )
    expect(h.channel).toBe("conversation://background")

    act(() => h.handler?.(entry(7, 0)))
    expect(useBackgroundPendingStore.getState().byConversation.size).toBe(0)

    h.list.mockResolvedValueOnce([entry(8, 2)])
    act(() => h.reconnect?.())
    await waitFor(() =>
      expect(
        useBackgroundPendingStore.getState().byConversation.get(8)?.count
      ).toBe(2)
    )

    unmount()
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(h.offReconnect).toHaveBeenCalledTimes(1)
  })

  it("keeps the rows to what connections know when the server lacks the command", async () => {
    h.list.mockRejectedValueOnce(new Error("not_implemented"))
    renderHook(() => useBackgroundPendingSync())
    await waitFor(() => expect(h.list).toHaveBeenCalled())
    expect(useBackgroundPendingStore.getState().byConversation.size).toBe(0)
  })
})

const uncertain = (
  conversationId: number,
  reason: BackgroundUncertainReason | null = "agent_exited",
  tasks: { task_id: string; name: string }[] = []
): BackgroundPendingEntry => ({
  conversation_id: conversationId,
  count: 0,
  names: [],
  state: "uncertain",
  reason,
  tasks,
})

// Cowork fork (#386): the server's「?」— a conversation that claims to run or
// wait on background work, but no live process is moving it.
describe("server uncertain entries (Cowork fork)", () => {
  const idle = (conversationId: number): BackgroundPendingEntry => ({
    conversation_id: conversationId,
    count: 0,
    names: [],
    state: "idle",
    reason: null,
    tasks: [],
  })

  it("keeps a count-0 uncertain entry from a full listing", () => {
    replaceServerBackgroundPending([
      uncertain(3, "agent_exited", [{ task_id: "t1", name: "Watch CI" }]),
    ])
    expect(useBackgroundPendingStore.getState().byConversation.get(3)).toEqual({
      count: 0,
      names: ["Watch CI"],
      state: "uncertain",
      reason: "agent_exited",
    })
  })

  it("keeps a count-0 uncertain broadcast, and an idle one clears it", () => {
    applyServerBackgroundPending(uncertain(3, "background_process_exited"))
    expect(
      useBackgroundPendingStore.getState().byConversation.get(3)?.state
    ).toBe("uncertain")
    const before = useBackgroundPendingStore.getState().byConversation
    applyServerBackgroundPending(uncertain(3, "background_process_exited"))
    expect(useBackgroundPendingStore.getState().byConversation).toBe(before)
    applyServerBackgroundPending(idle(3))
    expect(useBackgroundPendingStore.getState().byConversation.has(3)).toBe(
      false
    )
  })

  it("drops idle entries from a listing, and reads waiting ones as before", () => {
    replaceServerBackgroundPending([
      idle(1),
      {
        ...entry(2, 1, ["a"]),
        state: "waiting",
        reason: null,
        tasks: [{ task_id: "t", name: "a" }],
      },
    ])
    const map = useBackgroundPendingStore.getState().byConversation
    expect(map.has(1)).toBe(false)
    expect(map.get(2)).toEqual({ count: 1, names: ["a"] })
  })

  it("lets the server's「?」win over this client's own waiting connection", () => {
    act(() => {
      publishBackgroundPending([conn("sess-9", [task("1", "running")])])
      replaceServerBackgroundPending([uncertain(9)])
    })
    const { result } = renderHook(() => useBackgroundPending("sess-9", 9))
    expect(result.current?.state).toBe("uncertain")
    expect(result.current?.reason).toBe("agent_exited")
  })

  it("shows no hourglass once the server clears a session whose connection here is disconnected", () => {
    act(() => {
      replaceServerBackgroundPending([uncertain(9)])
      publishBackgroundPending([
        {
          ...conn("sess-9", [task("1", "running")], 1),
          status: "disconnected" as const,
        },
      ])
    })
    const conv = { id: 9, external_id: "sess-9", status: "pending_review" }
    expect(
      backgroundMarkFor(useBackgroundPendingStore.getState(), conv).uncertain
    ).not.toBeNull()
    act(() =>
      applyServerBackgroundPending({
        conversation_id: 9,
        count: 0,
        names: [],
        state: "idle",
      })
    )
    const { result } = renderHook(() => useBackgroundPending("sess-9", 9))
    expect(result.current).toBeNull()
    expect(
      backgroundMarkFor(useBackgroundPendingStore.getState(), conv)
    ).toEqual({ waiting: null, uncertain: null })
    expect(
      backgroundMarkFor(useBackgroundPendingStore.getState(), {
        ...conv,
        status: "completed",
      })
    ).toEqual({ waiting: null, uncertain: null })
  })
})

describe("backgroundMarkOf (Cowork fork)", () => {
  const waiting = { count: 1, names: ["a"] }
  const unclear = {
    count: 0,
    names: [],
    state: "uncertain" as const,
    reason: "agent_exited" as const,
  }

  it("shows the hourglass only after the turn ended", () => {
    expect(backgroundMarkOf("pending_review", waiting)).toEqual({
      waiting,
      uncertain: null,
    })
    expect(backgroundMarkOf("in_progress", waiting)).toEqual({
      waiting: null,
      uncertain: null,
    })
  })

  it("shows「?」unless the conversation is completed or cancelled", () => {
    expect(backgroundMarkOf("pending_review", unclear).uncertain).toBe(unclear)
    expect(backgroundMarkOf("in_progress", unclear).uncertain).toBe(unclear)
    expect(backgroundMarkOf("completed", unclear)).toEqual({
      waiting: null,
      uncertain: null,
    })
    expect(backgroundMarkOf("cancelled", unclear)).toEqual({
      waiting: null,
      uncertain: null,
    })
  })

  // #817：回合没跑完就断开，服务器发「没跑完的后台任务」而不是「?」。只给取消（红叉）的
  // 行写任务名，不画沙漏、不画「?」，也不压住未读。
  it("puts a server's abandoned tasks on a cancelled row only, never as hourglass or「?」", () => {
    replaceServerBackgroundPending([
      {
        conversation_id: 5,
        count: 0,
        names: [],
        state: "abandoned",
        reason: null,
        tasks: [{ task_id: "b1", name: "Watch CI" }],
      },
    ])
    const state = useBackgroundPendingStore.getState()
    const abandoned = {
      count: 0,
      names: ["Watch CI"],
      state: "abandoned" as const,
    }
    expect(state.byConversation.get(5)).toEqual(abandoned)
    const conv = { id: 5, external_id: null, status: "cancelled" }
    expect(backgroundMarkFor(state, conv)).toEqual({
      waiting: null,
      uncertain: null,
      abandoned,
    })
    expect(isConversationActive(state, conv)).toBe(false)
    expect(countsAsRunning(state, conv)).toBe(false)
    expect(
      backgroundMarkFor(state, { ...conv, status: "pending_review" })
    ).toEqual({ waiting: null, uncertain: null })
  })

  it("reads a conversation's mark straight from the store", () => {
    replaceServerBackgroundPending([uncertain(5)])
    const state = useBackgroundPendingStore.getState()
    expect(
      backgroundMarkFor(state, {
        id: 5,
        external_id: null,
        status: "pending_review",
      }).uncertain?.reason
    ).toBe("agent_exited")
    expect(
      isConversationActive(state, {
        id: 5,
        external_id: null,
        status: "pending_review",
      })
    ).toBe(true)
    expect(
      isConversationActive(state, {
        id: 6,
        external_id: null,
        status: "pending_review",
      })
    ).toBe(false)
  })
})

// Cowork fork (#435): the running counts (bell, folder, group) leave「?」out —
// no live process moves it — while it stays first in the attention order.
describe("countsAsRunning (Cowork fork)", () => {
  it("counts a running turn and background waiting, not「?」or idle", () => {
    replaceServerBackgroundPending([
      uncertain(5),
      { conversation_id: 7, count: 1, names: ["Watch CI"] },
    ])
    const state = useBackgroundPendingStore.getState()
    const at = (id: number, status: string) => ({
      id,
      external_id: null,
      status,
    })
    expect(countsAsRunning(state, at(6, "in_progress"))).toBe(true)
    expect(countsAsRunning(state, at(7, "pending_review"))).toBe(true)
    expect(countsAsRunning(state, at(5, "pending_review"))).toBe(false)
    expect(countsAsRunning(state, at(5, "in_progress"))).toBe(true)
    expect(countsAsRunning(state, at(6, "pending_review"))).toBe(false)
    // 「?」still leads the attention order.
    expect(isConversationActive(state, at(5, "pending_review"))).toBe(true)
  })
})
