import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  channel: null as null | string,
  handler: null as null | ((entry: unknown) => void),
  reconnect: null as null | (() => void),
  dispose: vi.fn(),
  offReconnect: vi.fn(),
  call: vi.fn(async (): Promise<unknown> => []),
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

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: h.call }),
}))

import {
  SESSION_USAGE_EVENT,
  applySessionUsage,
  replaceSessionUsage,
  useSessionUsage,
  useSessionUsageStore,
  useSessionUsageSync,
  type SessionUse,
  type SessionUsageEntry,
} from "./session-usage"

const chromeOnLaptop: SessionUse = {
  kind: "browser",
  device: "laptop",
  chrome: true,
  since: 1_000,
}
const shellOnLaptop: SessionUse = { kind: "shell", device: "laptop", since: 2 }

const entry = (
  conversationId: number,
  uses: SessionUse[]
): SessionUsageEntry => ({ conversationId, uses })

beforeEach(() => {
  useSessionUsageStore.setState({ byConversation: new Map() })
  h.call.mockReset()
  h.call.mockResolvedValue([])
  h.dispose.mockReset()
  h.offReconnect.mockReset()
})

describe("session usage store", () => {
  it("applies a conversation's uses and clears them with an empty list", () => {
    applySessionUsage(entry(7, [chromeOnLaptop]))
    expect(useSessionUsageStore.getState().byConversation.get(7)).toEqual([
      chromeOnLaptop,
    ])
    applySessionUsage(entry(7, []))
    expect(useSessionUsageStore.getState().byConversation.size).toBe(0)
  })

  it("changes nothing for the same uses, or for clearing one it never had", () => {
    applySessionUsage(entry(7, [chromeOnLaptop]))
    const before = useSessionUsageStore.getState().byConversation
    applySessionUsage(entry(7, [{ ...chromeOnLaptop }]))
    expect(useSessionUsageStore.getState().byConversation).toBe(before)
    applySessionUsage(entry(8, []))
    expect(useSessionUsageStore.getState().byConversation).toBe(before)
  })

  it("replaces everything from a listing, leaving out empty entries", () => {
    applySessionUsage(entry(1, [shellOnLaptop]))
    replaceSessionUsage([entry(2, [chromeOnLaptop]), entry(3, [])])
    const map = useSessionUsageStore.getState().byConversation
    expect([...map.keys()]).toEqual([2])
  })

  it("gives a conversation its uses, and none for one without", () => {
    applySessionUsage(entry(4, [chromeOnLaptop, shellOnLaptop]))
    const { result, rerender } = renderHook(
      ({ id }: { id: number | null }) => useSessionUsage(id),
      { initialProps: { id: 4 as number | null } }
    )
    expect(result.current).toHaveLength(2)
    rerender({ id: 5 })
    expect(result.current).toEqual([])
    rerender({ id: null })
    expect(result.current).toEqual([])
  })

  it("syncs: subscribes, then reads the listing, and re-reads after a reconnect", async () => {
    h.call.mockResolvedValueOnce([entry(7, [chromeOnLaptop])])
    const { unmount } = renderHook(() => useSessionUsageSync())
    await waitFor(() =>
      expect(useSessionUsageStore.getState().byConversation.get(7)).toEqual([
        chromeOnLaptop,
      ])
    )
    expect(h.channel).toBe(SESSION_USAGE_EVENT)
    expect(h.channel).toBe("conversation://device-usage")
    expect(h.call).toHaveBeenCalledWith("list_session_usage", {})

    act(() => h.handler?.(entry(7, [])))
    expect(useSessionUsageStore.getState().byConversation.size).toBe(0)

    h.call.mockResolvedValueOnce([entry(8, [shellOnLaptop])])
    act(() => h.reconnect?.())
    await waitFor(() =>
      expect(useSessionUsageStore.getState().byConversation.has(8)).toBe(true)
    )

    unmount()
    expect(h.dispose).toHaveBeenCalledTimes(1)
    expect(h.offReconnect).toHaveBeenCalledTimes(1)
  })

  it("shows nothing when the server has no such route", async () => {
    h.call.mockRejectedValueOnce(new Error("not_found"))
    renderHook(() => useSessionUsageSync())
    await waitFor(() => expect(h.call).toHaveBeenCalled())
    expect(useSessionUsageStore.getState().byConversation.size).toBe(0)
  })
})
