import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ServerCompat } from "@/lib/cowork/compat"

const remote = vi.fn<() => boolean>()
const shellCall = vi.fn<(command: string, args: unknown) => Promise<void>>()
let serverInfo: ((info: ServerCompat) => void) | null = null

vi.mock("@/lib/transport", () => ({
  isRemoteDesktopMode: () => remote(),
  getShellTransport: () => ({ call: shellCall }),
  getTransport: () => ({
    onServerInfo: (callback: (info: ServerCompat) => void) => {
      serverInfo = callback
      return () => {
        serverInfo = null
      }
    },
  }),
}))

import {
  HOST_BRIDGE_FEATURE,
  lendBrowserSwitch,
  useCanShareWithAgents,
} from "./remote-browser"

function info(features: string[]): ServerCompat {
  return { apiVersion: 1, minDesktopVersion: null, features }
}

beforeEach(() => {
  remote.mockReset()
  shellCall.mockReset()
  shellCall.mockResolvedValue(undefined)
  serverInfo = null
})

describe("useCanShareWithAgents", () => {
  it("always lets a local window share", () => {
    remote.mockReturnValue(false)
    const { result } = renderHook(() => useCanShareWithAgents())
    expect(result.current).toBe(true)
    expect(serverInfo).toBeNull()
  })

  it("lets a remote window share once its server takes hosts", () => {
    remote.mockReturnValue(true)
    const { result } = renderHook(() => useCanShareWithAgents())
    expect(result.current).toBe(false)
    act(() => serverInfo?.(info(["cowork_info", HOST_BRIDGE_FEATURE])))
    expect(result.current).toBe(true)
    // A server downgraded on reconnect takes it back.
    act(() => serverInfo?.(info(["cowork_info"])))
    expect(result.current).toBe(false)
  })
})

describe("lendBrowserSwitch", () => {
  it("does nothing in a local window", async () => {
    remote.mockReturnValue(false)
    await lendBrowserSwitch("browser")
    expect(shellCall).not.toHaveBeenCalled()
  })

  it("turns the switch on for this computer in a remote window", async () => {
    remote.mockReturnValue(true)
    await lendBrowserSwitch("browser")
    expect(shellCall.mock.calls).toEqual([
      ["set_codeg_mcp_tool_group", { key: "browser", enabled: true }],
    ])
  })

  it("turns the group on before browser_eval, which is nothing without it", async () => {
    remote.mockReturnValue(true)
    await lendBrowserSwitch("browser_eval")
    expect(shellCall.mock.calls).toEqual([
      ["set_codeg_mcp_tool_group", { key: "browser", enabled: true }],
      ["set_codeg_mcp_tool_group", { key: "browser_eval", enabled: true }],
    ])
  })

  it("leaves every other group to the server", async () => {
    remote.mockReturnValue(true)
    await lendBrowserSwitch("computer")
    await lendBrowserSwitch("delegation")
    expect(shellCall).not.toHaveBeenCalled()
  })
})
