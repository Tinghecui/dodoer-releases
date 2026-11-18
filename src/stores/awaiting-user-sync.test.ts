import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AwaitingUserEntry } from "@/lib/types"

const listing = vi.fn<() => Promise<AwaitingUserEntry[]>>()
const statusHandlers: Array<(change: { kind: string }) => void> = []
const reconnectHandlers: Array<() => void> = []

vi.mock("@/lib/api", () => ({
  acpListAwaitingUser: () => listing(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (_event: string, handler: (c: { kind: string }) => void) => {
    statusHandlers.push(handler)
    return () => {}
  },
  onTransportReconnect: (cb: () => void) => {
    reconnectHandlers.push(cb)
    return () => {}
  },
}))

import {
  awaitingUserFor,
  useAwaitingUserStore,
  useAwaitingUserSync,
} from "./awaiting-user-store"

const waiting: AwaitingUserEntry[] = [
  { conversation_id: 1, external_id: "sess-a", kind: "question" },
]

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe("useAwaitingUserSync (#707)", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    listing.mockReset()
    statusHandlers.length = 0
    reconnectHandlers.length = 0
    useAwaitingUserStore.setState({
      bySession: new Map(),
      byTaskConversation: new Set(),
      byConversation: new Map(),
      attachedSessions: new Set(),
    })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  const kindOf1 = () =>
    awaitingUserFor(useAwaitingUserStore.getState(), "sess-a", 1)

  it("reads the listing on mount", async () => {
    listing.mockResolvedValue(waiting)
    renderHook(() => useAwaitingUserSync())
    await flush()
    expect(listing).toHaveBeenCalledTimes(1)
    expect(kindOf1()).toBe("question")
  })

  it("re-reads after a reconnect", async () => {
    listing.mockResolvedValue([])
    renderHook(() => useAwaitingUserSync())
    await flush()
    listing.mockResolvedValue(waiting)
    act(() => reconnectHandlers.forEach((cb) => cb()))
    await flush()
    expect(kindOf1()).toBe("question")
  })

  it("re-reads shortly after a status change, not on an upsert", async () => {
    listing.mockResolvedValue([])
    renderHook(() => useAwaitingUserSync())
    await flush()
    listing.mockClear()
    listing.mockResolvedValue(waiting)
    act(() => statusHandlers.forEach((h) => h({ kind: "upsert" })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(listing).not.toHaveBeenCalled()
    act(() => statusHandlers.forEach((h) => h({ kind: "status" })))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(listing).toHaveBeenCalledTimes(1)
    expect(kindOf1()).toBe("question")
  })

  it("clears a row answered elsewhere while its turn keeps running", async () => {
    listing.mockResolvedValue(waiting)
    renderHook(() => useAwaitingUserSync())
    await flush()
    expect(kindOf1()).toBe("question")
    // Another browser answers: no status change reaches this window.
    listing.mockResolvedValue([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(kindOf1()).toBeNull()
  })

  it("keeps polling after one listing request fails", async () => {
    listing.mockResolvedValue(waiting)
    renderHook(() => useAwaitingUserSync())
    await flush()
    expect(kindOf1()).toBe("question")
    // A passing network or server error on one poll…
    listing.mockRejectedValueOnce(new Error("502"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6_000)
    })
    // …then another browser answers: the next poll must still come.
    listing.mockResolvedValue([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(kindOf1()).toBeNull()
  })

  it("does not retry when the listing never named anyone", async () => {
    listing.mockRejectedValue(new Error("unknown command"))
    renderHook(() => useAwaitingUserSync())
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(listing).toHaveBeenCalledTimes(1)
  })

  it("does not keep re-reading once nothing waits on the user", async () => {
    listing.mockResolvedValue([])
    renderHook(() => useAwaitingUserSync())
    await flush()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000)
    })
    expect(listing).toHaveBeenCalledTimes(1)
  })
})
