import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
}))

import {
  HISTORY_MS,
  MAX_FAILURES,
  POLL_MS,
  WATCH_POLL_MS,
  formatBytes,
  formatBytesOf,
  formatPercent,
  memoryHeadline,
  normalizeSystemResources,
  resetSystemResourcesForTests,
  shouldAnnounceCritical,
  useResourceWatch,
  useSystemResources,
  type SystemResources,
} from "./resources"

const GIB = 1024 ** 3
const MIB = 1024 ** 2

function raw(overrides: Record<string, unknown> = {}) {
  return {
    sampled_at: 1_700_000_000_000,
    cpu: { usage_percent: 12.5, cores: 8, load_average: [0.5, 0.4, 0.3] },
    memory: { total_bytes: 8 * GIB, available_bytes: 2 * GIB },
    swap: { total_bytes: 4 * GIB, used_bytes: GIB / 2 },
    disk: {
      path: "/home/ann",
      total_bytes: 100 * GIB,
      available_bytes: 40 * GIB,
    },
    workspace: null,
    memory_pressure: "normal",
    ...overrides,
  }
}

function resources(overrides: Record<string, unknown> = {}): SystemResources {
  return normalizeSystemResources(raw(overrides)) as SystemResources
}

let hidden = false
function setHidden(next: boolean) {
  hidden = next
  document.dispatchEvent(new Event("visibilitychange"))
}

/** Let the pending poll settle, then move the clock. */
async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

beforeEach(() => {
  call.mockReset()
  hidden = false
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  })
  resetSystemResourcesForTests()
  vi.useFakeTimers()
})

afterEach(() => {
  resetSystemResourcesForTests()
  vi.useRealTimers()
})

describe("normalizeSystemResources", () => {
  it("reads the server's shape", () => {
    expect(
      normalizeSystemResources(
        raw({
          workspace: {
            used_bytes: GIB,
            limit: { limit_bytes: 4 * GIB, used_bytes: 3 * GIB },
          },
          memory_pressure: "warning",
        })
      )
    ).toEqual({
      sampledAt: 1_700_000_000_000,
      cpu: { usagePercent: 12.5, cores: 8, loadAverage: [0.5, 0.4, 0.3] },
      memory: { totalBytes: 8 * GIB, availableBytes: 2 * GIB },
      swap: { totalBytes: 4 * GIB, usedBytes: GIB / 2 },
      disk: {
        path: "/home/ann",
        totalBytes: 100 * GIB,
        availableBytes: 40 * GIB,
      },
      workspace: {
        usedBytes: GIB,
        limit: { limitBytes: 4 * GIB, usedBytes: 3 * GIB },
      },
      memoryPressure: "warning",
    })
  })

  it("tolerates missing and wrong fields", () => {
    expect(normalizeSystemResources(null)).toBeNull()
    expect(normalizeSystemResources("x")).toBeNull()
    expect(
      normalizeSystemResources({
        cpu: { usage_percent: null, cores: "8", load_average: [1, 2] },
        memory: { total_bytes: 0, available_bytes: 5 },
        swap: null,
        disk: { total_bytes: 10, available_bytes: 50 },
        workspace: { used_bytes: 7, limit: { limit_bytes: "max" } },
        memory_pressure: "on fire",
      })
    ).toEqual({
      sampledAt: 0,
      cpu: { usagePercent: null, cores: 1, loadAverage: null },
      // A zero total is no reading.
      memory: null,
      swap: null,
      // A part larger than its total is clamped into it.
      disk: { path: "", totalBytes: 10, availableBytes: 10 },
      workspace: { usedBytes: 7, limit: null },
      memoryPressure: "normal",
    })
  })
})

describe("memoryHeadline", () => {
  it("is the machine's memory without a limit", () => {
    expect(memoryHeadline(resources())).toEqual({
      usedRatio: 0.75,
      availableBytes: 2 * GIB,
      totalBytes: 8 * GIB,
      limited: false,
    })
  })

  it("is the cgroup limit's when that is closer to full", () => {
    const limited = resources({
      workspace: {
        used_bytes: 3 * GIB,
        limit: { limit_bytes: 4 * GIB, used_bytes: 3.5 * GIB },
      },
    })
    expect(memoryHeadline(limited)).toEqual({
      usedRatio: 0.875,
      availableBytes: GIB / 2,
      totalBytes: 4 * GIB,
      limited: true,
    })
    const roomy = resources({
      workspace: {
        used_bytes: GIB,
        limit: { limit_bytes: 4 * GIB, used_bytes: GIB },
      },
    })
    expect(memoryHeadline(roomy)?.limited).toBe(false)
  })

  it("is null with no memory reading at all", () => {
    expect(memoryHeadline(resources({ memory: null }))).toBeNull()
  })
})

describe("formatting", () => {
  it("writes bytes the way people say them", () => {
    expect(formatBytes(7.8 * GIB)).toBe("7.8 GB")
    expect(formatBytes(512 * MIB)).toBe("512 MB")
    expect(formatBytes(250 * GIB)).toBe("250 GB")
    expect(formatBytes(0)).toBe("0 MB")
  })

  it("says a shared unit once", () => {
    expect(formatBytesOf(4.6 * GIB, 7.8 * GIB)).toBe("4.6 / 7.8 GB")
    expect(formatBytesOf(76 * MIB, 4 * GIB)).toBe("76 MB / 4.0 GB")
  })

  it("rounds and clamps percentages", () => {
    expect(formatPercent(0.586)).toBe("59%")
    expect(formatPercent(1.2)).toBe("100%")
    expect(formatPercent(-1)).toBe("0%")
  })
})

describe("shouldAnnounceCritical", () => {
  it("fires once per episode, armed again by a normal reading", () => {
    expect(shouldAnnounceCritical("warning")).toBe(false)
    expect(shouldAnnounceCritical("critical")).toBe(true)
    expect(shouldAnnounceCritical("critical")).toBe(false)
    // Hovering around the line is still the same episode.
    expect(shouldAnnounceCritical("warning")).toBe(false)
    expect(shouldAnnounceCritical("critical")).toBe(false)
    expect(shouldAnnounceCritical("normal")).toBe(false)
    expect(shouldAnnounceCritical("critical")).toBe(true)
  })
})

describe("useSystemResources", () => {
  it("polls while mounted and keeps a history", async () => {
    call.mockResolvedValue(raw())
    const { result, unmount } = renderHook(() => useSystemResources())
    expect(result.current.latest).toBeNull()
    await advance(0)
    expect(call).toHaveBeenCalledWith("get_system_resources", {})
    expect(result.current.latest?.memory?.totalBytes).toBe(8 * GIB)
    expect(result.current.history).toHaveLength(1)
    expect(result.current.history[0]).toMatchObject({ cpu: 12.5, memory: 75 })

    await advance(POLL_MS)
    expect(call).toHaveBeenCalledTimes(2)
    expect(result.current.history).toHaveLength(2)

    unmount()
    await advance(POLL_MS * 3)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("shares one poller between mounted meters", async () => {
    call.mockResolvedValue(raw())
    renderHook(() => useSystemResources())
    renderHook(() => useSystemResources())
    await advance(0)
    await advance(POLL_MS)
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("drops history older than the window", async () => {
    call.mockResolvedValue(raw())
    const { result } = renderHook(() => useSystemResources())
    await advance(0)
    await advance(HISTORY_MS + POLL_MS)
    const { history } = result.current
    expect(history.length).toBeGreaterThan(10)
    expect(history[history.length - 1].at - history[0].at).toBeLessThan(
      HISTORY_MS
    )
  })

  it("stops asking a server that has no such route", async () => {
    call.mockRejectedValue({ code: "not_implemented", message: "x" })
    const { result } = renderHook(() => useSystemResources())
    await advance(0)
    expect(result.current.supported).toBe(false)
    await advance(POLL_MS * 3)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("stops asking a machine that reports no figures", async () => {
    call.mockResolvedValue(raw({ cpu: null, memory: null }))
    const { result } = renderHook(() => useSystemResources())
    await advance(0)
    expect(result.current).toMatchObject({ latest: null, supported: false })
    await advance(POLL_MS * 3)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("drops a stale reading after repeated failures, and recovers", async () => {
    call.mockResolvedValueOnce(raw())
    const { result } = renderHook(() => useSystemResources())
    await advance(0)
    expect(result.current.latest).not.toBeNull()

    call.mockRejectedValue({ code: "network_error", message: "offline" })
    for (let i = 1; i < MAX_FAILURES; i++) {
      await advance(POLL_MS)
      expect(result.current.latest).not.toBeNull()
    }
    await advance(POLL_MS)
    expect(result.current.latest).toBeNull()
    expect(result.current.supported).toBe(true)

    call.mockResolvedValue(raw())
    await advance(POLL_MS)
    expect(result.current.latest).not.toBeNull()
  })

  it("rests while the window is hidden", async () => {
    call.mockResolvedValue(raw())
    renderHook(() => useSystemResources())
    await advance(0)
    expect(call).toHaveBeenCalledTimes(1)

    act(() => setHidden(true))
    await advance(POLL_MS * 4)
    expect(call).toHaveBeenCalledTimes(1)

    act(() => setHidden(false))
    await advance(0)
    expect(call).toHaveBeenCalledTimes(2)
    await advance(POLL_MS)
    expect(call).toHaveBeenCalledTimes(3)
  })

  it("polls faster, starting at once, while someone is watching", async () => {
    call.mockResolvedValue(raw())
    const { rerender } = renderHook(
      ({ watching }: { watching: boolean }) => {
        useResourceWatch(watching)
        return useSystemResources()
      },
      { initialProps: { watching: false } }
    )
    await advance(0)
    expect(call).toHaveBeenCalledTimes(1)

    rerender({ watching: true })
    await advance(0)
    expect(call).toHaveBeenCalledTimes(2)
    await advance(WATCH_POLL_MS)
    expect(call).toHaveBeenCalledTimes(3)

    rerender({ watching: false })
    await advance(WATCH_POLL_MS)
    // The poll already scheduled at the fast pace still runs; the next one
    // is back to the slow pace.
    expect(call).toHaveBeenCalledTimes(4)
    await advance(WATCH_POLL_MS)
    expect(call).toHaveBeenCalledTimes(4)
    await advance(POLL_MS - WATCH_POLL_MS)
    expect(call).toHaveBeenCalledTimes(5)
  })
})
