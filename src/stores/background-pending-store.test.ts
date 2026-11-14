import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { AsyncTaskRecord, BackgroundPendingEntry } from "@/lib/types"
import {
  applyServerBackgroundPending,
  backgroundPendingOf,
  publishBackgroundPending,
  replaceServerBackgroundPending,
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
