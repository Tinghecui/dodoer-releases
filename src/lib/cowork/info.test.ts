import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.hoisted(() => vi.fn())
const platform = vi.hoisted(() => ({ desktop: false, remote: false }))
vi.mock("@/lib/transport", () => ({ getTransport: () => ({ call }) }))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => platform.desktop,
  isRemoteDesktopWindow: () => platform.desktop && platform.remote,
}))
const conn = vi.hoisted(() => ({
  state: "connected",
  listeners: new Set<() => void>(),
}))
vi.mock("@/lib/transport/web-connection-store", () => ({
  getWebConnectionSnapshot: () => conn.state,
  subscribeWebConnection: (cb: () => void) => {
    conn.listeners.add(cb)
    return () => conn.listeners.delete(cb)
  },
}))

import {
  INFO_RETRY_MIN_MS,
  coworkCreateProject,
  getCachedCoworkInfo,
  loadCoworkInfo,
  normalizeCoworkInfo,
  resetCoworkInfoForTests,
  useCoworkInfo,
  validateProjectName,
} from "./info"

const INFO = {
  product: "Cowork",
  projectsRoot: "/home/cw-a/work",
  portal: true,
  updateDisabled: true,
}

beforeEach(() => {
  call.mockReset()
  platform.desktop = false
  platform.remote = false
  resetCoworkInfoForTests()
})

describe("normalizeCoworkInfo", () => {
  it("accepts the contract shape", () => {
    expect(normalizeCoworkInfo(INFO)).toEqual(INFO)
  })
  it("tolerates missing / wrong fields", () => {
    expect(normalizeCoworkInfo({ projectsRoot: " ", portal: "yes" })).toEqual({
      product: "Cowork",
      projectsRoot: null,
      portal: false,
      updateDisabled: false,
    })
    expect(normalizeCoworkInfo(null)).toBeNull()
    expect(normalizeCoworkInfo("x")).toBeNull()
  })
})

describe("loadCoworkInfo", () => {
  it("calls cowork_info once and caches it", async () => {
    call.mockResolvedValue(INFO)
    await expect(loadCoworkInfo()).resolves.toEqual(INFO)
    await expect(loadCoworkInfo()).resolves.toEqual(INFO)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith("cowork_info", {})
    expect(getCachedCoworkInfo()).toEqual(INFO)
  })

  it("resolves null on an upstream server and retries later", async () => {
    call.mockRejectedValueOnce({ code: "network_error", message: "HTTP 404" })
    await expect(loadCoworkInfo()).resolves.toBeNull()
    expect(getCachedCoworkInfo()).toBeNull()
    call.mockResolvedValueOnce(INFO)
    await expect(loadCoworkInfo()).resolves.toEqual(INFO)
  })

  it("stops asking an upstream server (not_implemented)", async () => {
    call.mockRejectedValueOnce({ code: "not_implemented", message: "x" })
    await expect(loadCoworkInfo()).resolves.toBeNull()
    await expect(loadCoworkInfo()).resolves.toBeNull()
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("never asks the local desktop runtime", async () => {
    platform.desktop = true
    await expect(loadCoworkInfo()).resolves.toBeNull()
    expect(call).not.toHaveBeenCalled()
  })

  it("asks the server behind a remote desktop window", async () => {
    platform.desktop = true
    platform.remote = true
    call.mockResolvedValue(INFO)
    await expect(loadCoworkInfo()).resolves.toEqual(INFO)
    expect(call).toHaveBeenCalledWith("cowork_info", {})
  })
})

describe("useCoworkInfo", () => {
  it("loads and re-renders with the info", async () => {
    call.mockResolvedValue(INFO)
    const { result } = renderHook(() => useCoworkInfo())
    expect(result.current).toBeNull()
    await waitFor(() => expect(result.current).toEqual(INFO))
  })

  it("retries with backoff until the server answers", async () => {
    vi.useFakeTimers()
    try {
      call
        .mockRejectedValueOnce({ code: "network_error", message: "HTTP 502" })
        .mockRejectedValueOnce(new Error("Request timed out"))
        .mockResolvedValue(INFO)
      const { result } = renderHook(() => useCoworkInfo())
      await act(async () => {})
      expect(call).toHaveBeenCalledTimes(1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INFO_RETRY_MIN_MS)
      })
      expect(call).toHaveBeenCalledTimes(2)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INFO_RETRY_MIN_MS * 2)
      })
      expect(call).toHaveBeenCalledTimes(3)
      expect(result.current).toEqual(INFO)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(INFO_RETRY_MIN_MS * 10)
      })
      expect(call).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it("retries when the web connection comes back", async () => {
    call
      .mockRejectedValueOnce({ code: "network_error", message: "HTTP 502" })
      .mockResolvedValue(INFO)
    const { result } = renderHook(() => useCoworkInfo())
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1))
    await act(async () => {})
    conn.state = "connected"
    await act(async () => {
      conn.listeners.forEach((l) => l())
    })
    await waitFor(() => expect(result.current).toEqual(INFO))
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("starts from the cache", async () => {
    resetCoworkInfoForTests(normalizeCoworkInfo(INFO))
    const { result } = renderHook(() => useCoworkInfo())
    expect(result.current).toEqual(INFO)
    await act(async () => {})
    expect(call).not.toHaveBeenCalled()
  })
})

describe("projects", () => {
  it("validates names like the server", () => {
    expect(validateProjectName("")).toBe("empty")
    expect(validateProjectName("   ")).toBe("empty")
    expect(validateProjectName("..")).toBe("invalid")
    expect(validateProjectName(".")).toBe("invalid")
    expect(validateProjectName(".git")).toBe("invalid")
    expect(validateProjectName("a/b")).toBe("invalid")
    expect(validateProjectName("a\\b")).toBe("invalid")
    expect(validateProjectName("demo")).toBeNull()
    expect(validateProjectName("我的项目 2")).toBeNull()
  })

  it("creates via cowork_create_project with a trimmed name", async () => {
    call.mockResolvedValue({ id: 3, path: "/home/cw-a/work/demo" })
    await coworkCreateProject("  demo ")
    expect(call).toHaveBeenCalledWith("cowork_create_project", {
      name: "demo",
    })
  })
})
