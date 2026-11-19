/**
 * Cowork 加的（#423，审查打回 #499）：智能体不认会话了的那条消息要自动重发一次，
 * 可用户这时可能已经切到别的会话。`handleFocus` 只管当前标签（不是当前标签就什么
 * 都不做），后台标签的重连走 `reconnectInBackground`：不看 isActive，只在连接已经
 * 断了 / 出错时连一次，参数和自动连接一样。
 */

import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/contexts/acp-connections-context", () => {
  const actions = {
    setActiveKey: vi.fn(),
    releaseActiveKey: vi.fn(),
    touchActivity: vi.fn(),
  }
  return { useAcpActions: () => actions }
})

vi.mock("@/contexts/task-context", () => {
  const context = { addTask: vi.fn(), updateTask: vi.fn(), removeTask: vi.fn() }
  return { useTaskContext: () => context }
})

const conn = vi.hoisted(() => ({
  status: null as string | null,
  connect: null as unknown as Mock,
  disconnect: null as unknown as Mock,
}))

vi.mock("@/hooks/use-connection", async () => {
  const { vi } = await import("vitest")
  conn.connect = vi.fn().mockResolvedValue(undefined)
  conn.disconnect = vi.fn().mockResolvedValue(undefined)
  const noop = vi.fn().mockResolvedValue(undefined)
  return {
    useConnection: () => ({
      status: conn.status,
      agentType: null,
      connectError: null,
      selectorsReady: false,
      hasCachedSelectors: false,
      connect: conn.connect,
      disconnect: conn.disconnect,
      sendPrompt: noop,
      setMode: noop,
      setConfigOption: noop,
      cancel: noop,
      respondPermission: noop,
      modes: null,
      configOptions: null,
      isViewer: false,
      backgroundOutstanding: 0,
      asyncTasks: [],
      remoteControl: null,
      delegatedChildren: [],
    }),
  }
})

import { useConnectionLifecycle } from "@/hooks/use-connection-lifecycle"

function renderBackgroundTab() {
  return renderHook(() =>
    useConnectionLifecycle({
      contextKey: "tab-2",
      agentType: "claude_code",
      isActive: false,
      workingDir: "/tmp/proj",
      sessionId: "s1",
      conversationId: 7,
    })
  )
}

describe("useConnectionLifecycle reconnectInBackground", () => {
  beforeEach(() => {
    conn.status = null
    conn.connect.mockClear()
  })

  it("reconnects a background tab whose connection went away", () => {
    conn.status = "disconnected"
    const { result } = renderBackgroundTab()
    // handleFocus 只管当前标签：后台标签什么都不做。
    result.current.handleFocus()
    expect(conn.connect).not.toHaveBeenCalled()
    result.current.reconnectInBackground()
    expect(conn.connect).toHaveBeenCalledWith(
      "claude_code",
      "/tmp/proj",
      "s1",
      7
    )
  })

  it("leaves a live connection alone", () => {
    for (const status of ["connecting", "connected", "prompting"]) {
      conn.status = status
      const { result, unmount } = renderBackgroundTab()
      result.current.reconnectInBackground()
      unmount()
    }
    expect(conn.connect).not.toHaveBeenCalled()
  })
})

// #792：连上了、但连的还是上一个会话的目录时，handleFocus 和
// reconnectInBackground 都不管（状态是 connected），一直等不来就绪。
// retargetConnection 不看状态，按当前参数再请求一次（同参数的由 connect 去重）。
describe("useConnectionLifecycle retargetConnection", () => {
  beforeEach(() => {
    conn.status = null
    conn.connect.mockClear()
  })

  function renderActiveTab() {
    return renderHook(() =>
      useConnectionLifecycle({
        contextKey: "tab-3",
        agentType: "claude_code",
        isActive: true,
        workingDir: "/tmp/new-chat",
        sessionId: undefined,
        conversationId: undefined,
      })
    )
  }

  it("re-requests the connection even while it reads connected", () => {
    conn.status = "connected"
    const { result } = renderActiveTab()
    conn.connect.mockClear()
    result.current.handleFocus()
    expect(conn.connect).not.toHaveBeenCalled()
    result.current.retargetConnection()
    expect(conn.connect).toHaveBeenCalledWith(
      "claude_code",
      "/tmp/new-chat",
      undefined,
      undefined
    )
  })

  it("does nothing for a background tab", () => {
    conn.status = "connected"
    const { result } = renderBackgroundTab()
    result.current.retargetConnection()
    expect(conn.connect).not.toHaveBeenCalled()
  })
})

// #868：连的目录和智能体都对、可会话一直没初始化完（selectors_ready 没到），
// 同参数的 connect 会被去重，retargetConnection 救不回来。forceReconnect
// 先断开再按当前参数连一次。
describe("useConnectionLifecycle forceReconnect", () => {
  beforeEach(() => {
    conn.status = null
    conn.connect.mockClear()
    conn.disconnect.mockClear()
  })

  it("tears the connection down before connecting again", async () => {
    conn.status = "connected"
    const { result } = renderHook(() =>
      useConnectionLifecycle({
        contextKey: "tab-4",
        agentType: "claude_code",
        isActive: true,
        workingDir: "/tmp/new-chat",
        sessionId: undefined,
        conversationId: undefined,
      })
    )
    conn.connect.mockClear()
    await result.current.forceReconnect()
    expect(conn.disconnect).toHaveBeenCalledTimes(1)
    expect(conn.connect).toHaveBeenCalledWith(
      "claude_code",
      "/tmp/new-chat",
      undefined,
      undefined
    )
    expect(conn.disconnect.mock.invocationCallOrder[0]).toBeLessThan(
      conn.connect.mock.invocationCallOrder[0]
    )
  })

  // 审查打回：用户发完就切到别的标签时，后台标签到点也得断开重连，不然切回来
  // 同参数的连接被去重，点重试还要再等一轮超时。
  it("reconnects a background tab too", async () => {
    conn.status = "connected"
    const { result } = renderBackgroundTab()
    conn.connect.mockClear()
    await result.current.forceReconnect()
    expect(conn.disconnect).toHaveBeenCalledTimes(1)
    expect(conn.connect).toHaveBeenCalledWith(
      "claude_code",
      "/tmp/proj",
      "s1",
      7
    )
  })
})
