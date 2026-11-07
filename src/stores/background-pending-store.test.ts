import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import type { AsyncTaskRecord } from "@/lib/types"
import {
  backgroundPendingOf,
  publishBackgroundPending,
  useBackgroundPending,
  useBackgroundPendingStore,
} from "./background-pending-store"

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
  useBackgroundPendingStore.setState({ bySession: new Map() })
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
