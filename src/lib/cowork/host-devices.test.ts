import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  call: vi.fn(),
  shellCall: vi.fn(),
  desktop: true,
  remote: true,
  serverInfo: null as ((info: { features: string[] }) => void) | null,
}))
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: env.shellCall }),
  getTransport: () => ({
    call: env.call,
    onServerInfo: (callback: (info: { features: string[] }) => void) => {
      env.serverInfo = callback
      return () => {
        env.serverInfo = null
      }
    },
  }),
  isDesktop: () => env.desktop,
  isRemoteDesktopMode: () => env.remote,
}))

import {
  HOST_DEVICES_POLL_MS,
  HOST_DEVICES_POLL_OPEN_MS,
  forgetHostDevice,
  hostDevicesApply,
  isDeviceName,
  lastSeenText,
  normalizeDeviceName,
  renameHostDevice,
  useHostDevices,
  type HostDeviceList,
} from "./host-devices"

const LIST: HostDeviceList = {
  devices: [
    {
      id: "imac-0123456789",
      name: "desktop",
      named: true,
      computerName: "Study iMac",
      model: "iMac",
      kind: "desktop",
      platform: "macos",
      appVersion: "1.7.0",
      firstSeen: 1,
      lastSeen: 2,
      online: true,
      shell: true,
      browser: true,
      chrome: false,
    },
  ],
  unnamedHosts: 0,
}

beforeEach(() => {
  vi.useFakeTimers()
  env.call.mockReset().mockResolvedValue(LIST)
  env.shellCall.mockReset().mockResolvedValue(null)
  env.desktop = true
  env.remote = true
  env.serverInfo = null
})

afterEach(() => {
  vi.useRealTimers()
})

async function settle() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0)
  })
}

describe("hostDevicesApply", () => {
  it("is for a browser and a remote window, not a local one", () => {
    expect(hostDevicesApply()).toBe(true)
    env.remote = false
    expect(hostDevicesApply()).toBe(false)
    env.desktop = false
    expect(hostDevicesApply()).toBe(true)
  })
})

describe("device names", () => {
  it("are what the server takes: plain, lowercase, at most 32", () => {
    for (const good of ["desktop", "laptop-2", "a", "0", "a".repeat(32)]) {
      expect(isDeviceName(good)).toBe(true)
    }
    for (const bad of [
      "",
      "-a",
      "a-",
      "Desktop",
      "two words",
      "a_b",
      "书房",
      "a".repeat(33),
    ]) {
      expect(isDeviceName(bad)).toBe(false)
    }
    expect(normalizeDeviceName("  Laptop ")).toBe("laptop")
  })
})

describe("lastSeenText", () => {
  const now = Date.UTC(2026, 10, 15, 12, 0, 0)
  it("says how long ago, in the window's language", () => {
    expect(lastSeenText(now - 5_000, "en", now)).toBe("now")
    expect(lastSeenText(now - 5 * 60_000, "en", now)).toBe("5 minutes ago")
    expect(lastSeenText(now - 3 * 3_600_000, "en", now)).toBe("3 hours ago")
    expect(lastSeenText(now - 86_400_000, "en", now)).toBe("yesterday")
    expect(lastSeenText(now - 5 * 60_000, "zh-CN", now)).toBe("5分钟前")
  })

  it("gives a date past a week", () => {
    const then = now - 30 * 86_400_000
    expect(lastSeenText(then, "en", now)).toBe(
      new Date(then).toLocaleDateString("en")
    )
  })
})

describe("calls", () => {
  it("rename and forget a device on the window's server", async () => {
    await renameHostDevice("imac-0123456789", "desktop")
    expect(env.call).toHaveBeenCalledWith("rename_host_device", {
      id: "imac-0123456789",
      name: "desktop",
    })
    await forgetHostDevice("imac-0123456789")
    expect(env.call).toHaveBeenCalledWith("forget_host_device", {
      id: "imac-0123456789",
    })
  })
})

describe("useHostDevices", () => {
  it("asks once the server says it keeps a book, then on a timer", async () => {
    const { result, rerender } = renderHook(
      ({ watching }: { watching: boolean }) => useHostDevices(watching),
      { initialProps: { watching: false } }
    )
    await settle()
    expect(env.call).not.toHaveBeenCalled()
    expect(result.current.list).toBeNull()

    // A server from before the book: nothing asked.
    act(() => env.serverInfo?.({ features: ["host_choice"] }))
    await settle()
    expect(env.call).not.toHaveBeenCalled()

    act(() => env.serverInfo?.({ features: ["host_devices"] }))
    await settle()
    expect(env.call).toHaveBeenCalledTimes(1)
    expect(env.call).toHaveBeenCalledWith("list_host_devices", {})
    expect(result.current.list).toEqual(LIST)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_DEVICES_POLL_MS)
    })
    expect(env.call).toHaveBeenCalledTimes(2)

    // Looked at: asked at once, and more often.
    rerender({ watching: true })
    await settle()
    expect(env.call).toHaveBeenCalledTimes(3)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_DEVICES_POLL_OPEN_MS)
    })
    expect(env.call).toHaveBeenCalledTimes(4)
  })

  it("keeps the last answer when a read fails", async () => {
    const { result } = renderHook(() => useHostDevices(false))
    act(() => env.serverInfo?.({ features: ["host_devices"] }))
    await settle()
    expect(result.current.list).toEqual(LIST)
    env.call.mockRejectedValue(new Error("offline"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_DEVICES_POLL_MS)
    })
    expect(result.current.list).toEqual(LIST)
  })

  it("lets the answer to a change win over a read asked before it", async () => {
    let answer!: (list: HostDeviceList) => void
    const { result } = renderHook(() => useHostDevices(false))
    act(() => env.serverInfo?.({ features: ["host_devices"] }))
    await settle()
    env.call.mockImplementation(
      () => new Promise<HostDeviceList>((resolve) => (answer = resolve))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_DEVICES_POLL_MS)
    })
    const renamed: HostDeviceList = {
      ...LIST,
      devices: [{ ...LIST.devices[0], name: "study" }],
    }
    act(() => result.current.adopt(renamed))
    await act(async () => {
      answer(LIST)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.list).toEqual(renamed)
  })

  it("asks the app which computer this is, in the desktop app only", async () => {
    env.shellCall.mockResolvedValue({ id: "imac-0123456789", name: "iMac" })
    const { result } = renderHook(() => useHostDevices(false))
    await settle()
    expect(env.shellCall).toHaveBeenCalledWith("host_device")
    expect(result.current.thisDeviceId).toBe("imac-0123456789")
  })

  it("asks nothing in a local window", async () => {
    env.remote = false
    const { result } = renderHook(() => useHostDevices(false))
    await settle()
    expect(env.serverInfo).toBeNull()
    expect(env.shellCall).not.toHaveBeenCalled()
    expect(result.current.list).toBeNull()
  })
})
