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
  hostChoiceApplies,
  hostChoiceView,
  useHostDevices,
  type HostDevices,
} from "./host-choice"

const STATE: HostDevices = {
  devices: [
    {
      key: "mini-0123456789",
      id: "mini-0123456789",
      name: "Mac mini",
      browser: true,
      chrome: false,
      shell: false,
    },
  ],
  choices: { browser: null, shell: null },
  browserNow: "mini-0123456789",
  shellNow: null,
}

beforeEach(() => {
  vi.useFakeTimers()
  env.call.mockReset().mockResolvedValue(STATE)
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

describe("hostChoiceApplies", () => {
  it("is for a browser and a remote window, not a local one", () => {
    expect(hostChoiceApplies()).toBe(true)
    env.remote = false
    expect(hostChoiceApplies()).toBe(false)
    env.desktop = false
    expect(hostChoiceApplies()).toBe(true)
  })
})

describe("hostChoiceView", () => {
  it("says where calls go, and when a fixed computer is away", () => {
    expect(hostChoiceView(STATE, "browser")).toEqual({
      pinned: null,
      now: STATE.devices[0],
      away: false,
    })
    // Nothing lends a shell, and nothing is fixed: nobody is away.
    expect(hostChoiceView(STATE, "shell")).toEqual({
      pinned: null,
      now: null,
      away: false,
    })
    const fixed = { id: "book-0123456789", name: "MacBook" }
    expect(
      hostChoiceView(
        {
          ...STATE,
          choices: { browser: fixed, shell: null },
          browserNow: null,
        },
        "browser"
      )
    ).toEqual({ pinned: fixed, now: null, away: true })
  })
})

describe("useHostDevices", () => {
  it("asks once the server says it can answer, then on a timer", async () => {
    const { result, rerender } = renderHook(
      ({ watching }: { watching: boolean }) => useHostDevices(watching),
      { initialProps: { watching: false } }
    )
    await settle()
    expect(env.call).not.toHaveBeenCalled()
    expect(result.current.state).toBeNull()

    act(() => env.serverInfo?.({ features: ["host_choice"] }))
    await settle()
    expect(env.call).toHaveBeenCalledTimes(1)
    expect(env.call).toHaveBeenCalledWith("get_host_devices", {})
    expect(result.current.state).toEqual(STATE)

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
    act(() => env.serverInfo?.({ features: ["host_choice"] }))
    await settle()
    expect(result.current.state).toEqual(STATE)
    env.call.mockRejectedValue(new Error("offline"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_DEVICES_POLL_MS)
    })
    expect(result.current.state).toEqual(STATE)
  })

  it("lets an answer to a choice win over a read asked before it", async () => {
    let answer!: (state: HostDevices) => void
    const { result } = renderHook(() => useHostDevices(false))
    act(() => env.serverInfo?.({ features: ["host_choice"] }))
    await settle()
    env.call.mockImplementation(
      () => new Promise<HostDevices>((resolve) => (answer = resolve))
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOST_DEVICES_POLL_MS)
    })
    const chosen = {
      ...STATE,
      choices: {
        browser: { id: "mini-0123456789", name: "Mac mini" },
        shell: null,
      },
    }
    act(() => result.current.adopt(chosen))
    await act(async () => {
      answer(STATE)
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(result.current.state).toEqual(chosen)
  })

  it("asks the app which computer this is, in the desktop app only", async () => {
    env.shellCall.mockResolvedValue({ id: "mini-0123456789", name: "Mac mini" })
    const { result } = renderHook(() => useHostDevices(false))
    await settle()
    expect(env.shellCall).toHaveBeenCalledWith("host_device")
    expect(result.current.thisDeviceId).toBe("mini-0123456789")
  })
})
