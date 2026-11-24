import { act, renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { BackendStatus, ComputerStatus, DriverInfo } from "./types"

/** 测试里收到的事件订阅：事件名 → 回调。 */
const handlers = new Map<string, (payload: unknown) => void>()

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn((event: string, cb: (payload: unknown) => void) => {
    handlers.set(event, cb)
    return Promise.resolve(() => {
      if (handlers.get(event) === cb) handlers.delete(event)
    })
  }),
}))

const computerStatus = vi.fn<() => Promise<ComputerStatus>>()

vi.mock("./computer-api", () => ({
  computerStatus: () => computerStatus(),
  computerOpenPermissionSettings: vi.fn(),
  computerRequestPermission: vi.fn(),
  computerRevealHelper: vi.fn(),
  computerAvailable: () => true,
  askComputerServed: vi.fn(),
  subscribeComputerServed: () => () => {},
}))

import { resetComputerStoreForTest, setComputerBackend } from "./computer-store"
import { useComputerStatus } from "./use-computer-status"

function backend(state: BackendStatus["state"]): BackendStatus {
  return { state, driverVersion: "0.36.0" }
}

function statusOf(
  state: BackendStatus["state"],
  withPermissions: boolean
): ComputerStatus {
  return {
    enabled: true,
    platform: "macos",
    verifiedPlatform: false,
    backend: backend(state),
    permissions: withPermissions
      ? { required: true, accessibility: false, screenRecording: false }
      : undefined,
    shared: [],
  } as ComputerStatus
}

function driverInfo(over: Partial<DriverInfo>): DriverInfo {
  return { version: "0.36.0", supported: true, installed: [], ...over }
}

beforeEach(() => {
  handlers.clear()
  computerStatus.mockReset()
  resetComputerStoreForTest()
})

describe("useComputerStatus", () => {
  it("驱动装好以后自己再查一次权限", async () => {
    computerStatus.mockResolvedValueOnce(statusOf("failed", false))
    const { result } = renderHook(() => useComputerStatus(true))
    await waitFor(() => expect(computerStatus).toHaveBeenCalledTimes(1))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    expect(result.current.status?.permissions).toBeUndefined()

    computerStatus.mockResolvedValue(statusOf("ready", true))
    await waitFor(() => expect(handlers.has("computer://driver")).toBe(true))
    // 安装进行中的进度不触发重取
    act(() => {
      handlers.get("computer://driver")?.(
        driverInfo({ task: { kind: "installing" } })
      )
    })
    expect(computerStatus).toHaveBeenCalledTimes(1)
    // 安装结束
    act(() => {
      handlers.get("computer://driver")?.(driverInfo({ installed: ["0.36.0"] }))
    })
    await waitFor(() => expect(computerStatus).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(result.current.status?.permissions?.accessibility).toBe(false)
    )
  })

  it("后端变成 ready 时再查一次权限", async () => {
    computerStatus.mockResolvedValueOnce(statusOf("starting", false))
    const { result } = renderHook(() => useComputerStatus(true))
    await waitFor(() => expect(result.current.status).not.toBeNull())
    expect(computerStatus).toHaveBeenCalledTimes(1)

    computerStatus.mockResolvedValue(statusOf("ready", true))
    act(() => setComputerBackend(backend("ready")))
    await waitFor(() => expect(computerStatus).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(result.current.status?.permissions).toBeDefined()
    )
    // 重取带回来的还是 ready，不会再查一轮
    await new Promise((r) => setTimeout(r, 20))
    expect(computerStatus).toHaveBeenCalledTimes(2)
  })

  it("第一次查本身带回 ready 时不重复查", async () => {
    computerStatus.mockResolvedValue(statusOf("ready", true))
    const { result } = renderHook(() => useComputerStatus(true))
    await waitFor(() =>
      expect(result.current.status?.permissions).toBeDefined()
    )
    await new Promise((r) => setTimeout(r, 20))
    expect(computerStatus).toHaveBeenCalledTimes(1)
  })

  it("没开时不因驱动事件去查", async () => {
    renderHook(() => useComputerStatus(false))
    await new Promise((r) => setTimeout(r, 10))
    handlers.get("computer://driver")?.(driverInfo({ installed: ["0.36.0"] }))
    act(() => setComputerBackend(backend("ready")))
    await new Promise((r) => setTimeout(r, 10))
    expect(computerStatus).not.toHaveBeenCalled()
  })
})
