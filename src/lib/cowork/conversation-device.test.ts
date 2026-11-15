import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  call: vi.fn(),
  desktop: true,
  remote: true,
  serverInfo: null as ((info: { features: string[] }) => void) | null,
}))
vi.mock("@/lib/transport", () => ({
  getShellTransport: () => ({ call: vi.fn() }),
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
  CONVERSATION_DEVICE_FEATURE,
  CONVERSATION_DEVICE_PICK_FEATURE,
  CONVERSATION_DEVICE_POLL_MS,
  deviceTrouble,
  offersPick,
  useConversationDevice,
  useConversationDeviceState,
} from "./conversation-device"
import type { HostDevice } from "./host-devices"

const DESKTOP: HostDevice = {
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
  browser: false,
  chrome: false,
}

beforeEach(() => {
  vi.useFakeTimers()
  env.call.mockReset().mockResolvedValue({ device: DESKTOP })
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

describe("deviceTrouble", () => {
  it("is nothing while the device is online and lends something", () => {
    expect(deviceTrouble(DESKTOP)).toBeNull()
    expect(deviceTrouble({ ...DESKTOP, shell: false, browser: true })).toBe(
      null
    )
  })

  it("says offline first, then that nothing is lent", () => {
    expect(deviceTrouble({ ...DESKTOP, online: false, shell: false })).toBe(
      "offline"
    )
    expect(deviceTrouble({ ...DESKTOP, shell: false })).toBe("lendsNothing")
  })
})

describe("useConversationDevice", () => {
  it("asks once the server says it answers, for that conversation", async () => {
    const { result } = renderHook(() => useConversationDevice(7))
    await settle()
    expect(env.call).not.toHaveBeenCalled()
    expect(result.current).toBeNull()

    act(() => env.serverInfo?.({ features: [CONVERSATION_DEVICE_FEATURE] }))
    await settle()
    expect(env.call).toHaveBeenCalledWith("get_conversation_device", {
      conversationId: 7,
    })
    expect(result.current?.name).toBe("desktop")
  })

  it("asks a server from before this nothing", async () => {
    const { result } = renderHook(() => useConversationDevice(7))
    act(() => env.serverInfo?.({ features: ["host_devices"] }))
    await settle()
    expect(env.call).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it("is nothing in a local window", async () => {
    env.remote = false
    const { result } = renderHook(() => useConversationDevice(7))
    await settle()
    expect(env.serverInfo).toBeNull()
    expect(env.call).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })

  it("never shows one conversation's device for another", async () => {
    const { result, rerender } = renderHook(
      ({ id }: { id: number | null }) => useConversationDevice(id),
      { initialProps: { id: 7 as number | null } }
    )
    act(() => env.serverInfo?.({ features: [CONVERSATION_DEVICE_FEATURE] }))
    await settle()
    expect(result.current?.name).toBe("desktop")

    env.call.mockResolvedValue({ device: null })
    rerender({ id: 8 })
    // Not the answer for 7 while 8's is on its way.
    expect(result.current).toBeNull()
    await settle()
    expect(env.call).toHaveBeenLastCalledWith("get_conversation_device", {
      conversationId: 8,
    })
    expect(result.current).toBeNull()

    rerender({ id: null })
    await settle()
    expect(env.call).toHaveBeenCalledTimes(2)
  })

  it("follows a switch on the next tick", async () => {
    const { result } = renderHook(() => useConversationDevice(7))
    act(() => env.serverInfo?.({ features: [CONVERSATION_DEVICE_FEATURE] }))
    await settle()
    expect(result.current?.name).toBe("desktop")

    env.call.mockResolvedValue({
      device: { ...DESKTOP, id: "book-0123456789", name: "laptop" },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONVERSATION_DEVICE_POLL_MS)
    })
    expect(result.current?.name).toBe("laptop")
  })

  it("keeps the last answer when a read fails", async () => {
    const { result } = renderHook(() => useConversationDevice(7))
    act(() => env.serverInfo?.({ features: [CONVERSATION_DEVICE_FEATURE] }))
    await settle()
    env.call.mockRejectedValue(new Error("offline"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(CONVERSATION_DEVICE_POLL_MS)
    })
    expect(result.current?.name).toBe("desktop")
  })
})

describe("offersPick", () => {
  it("offers the button with a device, a waiting agent, or two to pick from", () => {
    expect(offersPick({ device: null })).toBe(false)
    expect(offersPick({ device: null, deviceCount: 1 })).toBe(false)
    expect(offersPick({ device: null, deviceCount: 2 })).toBe(true)
    expect(offersPick({ device: null, needsPick: true })).toBe(true)
    expect(offersPick({ device: DESKTOP, deviceCount: 1 })).toBe(true)
  })
})

describe("useConversationDeviceState", () => {
  it("picks only where the server takes it, and shows its answer at once", async () => {
    env.call.mockResolvedValue({
      device: null,
      needsPick: true,
      deviceCount: 2,
    })
    const { result } = renderHook(() => useConversationDeviceState(7))
    act(() => env.serverInfo?.({ features: [CONVERSATION_DEVICE_FEATURE] }))
    await settle()
    expect(result.current?.canPick).toBe(false)
    expect(result.current?.answer.needsPick).toBe(true)

    act(() =>
      env.serverInfo?.({
        features: [
          CONVERSATION_DEVICE_FEATURE,
          CONVERSATION_DEVICE_PICK_FEATURE,
        ],
      })
    )
    await settle()
    expect(result.current?.canPick).toBe(true)

    env.call.mockResolvedValue({
      device: DESKTOP,
      needsPick: false,
      deviceCount: 2,
    })
    await act(async () => {
      await result.current?.pick("imac-0123456789")
    })
    expect(env.call).toHaveBeenLastCalledWith("set_conversation_device", {
      conversationId: 7,
      deviceId: "imac-0123456789",
    })
    expect(result.current?.answer.device?.name).toBe("desktop")
    expect(result.current?.answer.needsPick).toBe(false)
  })

  it("passes on what went wrong with a pick", async () => {
    const { result } = renderHook(() => useConversationDeviceState(7))
    act(() =>
      env.serverInfo?.({
        features: [
          CONVERSATION_DEVICE_FEATURE,
          CONVERSATION_DEVICE_PICK_FEATURE,
        ],
      })
    )
    await settle()
    env.call.mockRejectedValue(new Error("No such device"))
    await expect(result.current!.pick("gone-0123456789")).rejects.toThrow(
      "No such device"
    )
    expect(result.current?.answer.device?.name).toBe("desktop")
  })
})
