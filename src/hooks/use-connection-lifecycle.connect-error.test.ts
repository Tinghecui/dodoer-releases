/**
 * The composer's inline banner reads `autoConnectError`, which the hook used to
 * learn only from the promise its own auto-connect got back. A connect request
 * that lands while another is still in flight for the same key is PARKED: its
 * promise resolves at once, and the provider runs it later from the in-flight
 * call's cleanup, swallowing the rejection there. So when a draft switches
 * agents mid-connect and the agent picked last fails, the hook saw a success.
 * The provider still publishes that failure for the key (it is what the toast
 * and the status chip show); the banner has to read it too.
 */

import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ConnectErrorInfo } from "@/contexts/acp-connections-context"

vi.mock("next-intl", () => ({
  // 带参数的把参数接在后面，测试能看到提示里的错误文字。
  useTranslations: () => (key: string, params?: Record<string, unknown>) =>
    params ? `${key}:${JSON.stringify(params)}` : key,
}))

const notifyMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/notify", () => ({ notify: notifyMock }))

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
  connectError: null as ConnectErrorInfo | null,
  // 设了就让 auto-connect 拿到这个 rejection（#872）。
  connectRejection: undefined as unknown,
  // 设了就让 sendPrompt 拿到这个 rejection。
  sendRejection: undefined as unknown,
}))

vi.mock("@/hooks/use-connection", () => {
  // A parked request: the call resolves without saying how the request did.
  const connect = vi.fn(async () => {
    if (conn.connectRejection !== undefined) throw conn.connectRejection
  })
  const noop = vi.fn().mockResolvedValue(undefined)
  const sendPrompt = vi.fn(async () => {
    if (conn.sendRejection !== undefined) throw conn.sendRejection
  })
  return {
    useConnection: () => ({
      status: conn.status,
      agentType: null,
      connectError: conn.connectError,
      selectorsReady: false,
      hasCachedSelectors: false,
      connect,
      disconnect: noop,
      sendPrompt,
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

function renderDraft() {
  return renderHook(() =>
    useConnectionLifecycle({
      contextKey: "draft-tab",
      agentType: "codex",
      isActive: true,
      workingDir: "/tmp/proj",
    })
  )
}

describe("useConnectionLifecycle autoConnectError", () => {
  beforeEach(() => {
    conn.status = null
    conn.connectError = null
    conn.connectRejection = undefined
    conn.sendRejection = undefined
    notifyMock.mockClear()
  })

  // #952: 自动连接因为别的原因失败后，用户点失败提示里的「重试」（直接走
  // provider，不经过这个 hook），这次重试被限流、等着自己重连时，横幅不能
  // 还报上一次的失败（不然聊天页把排队的消息标成失败，连上了也不发）。
  it("drops the old auto-connect failure once a toast retry is rate-limited", async () => {
    conn.connectRejection = {
      code: "bad_gateway",
      message: "网关暂时不可用",
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { result, rerender } = renderDraft()
    conn.status = "error"
    rerender()
    await vi.waitFor(() => {
      expect(result.current.autoConnectError).toBe("网关暂时不可用")
    })
    // 提示里的重试：provider 开始新的一次连接（发布的失败被清掉）……
    conn.status = "connecting"
    rerender()
    // ……被限流，provider 把状态改成 disconnected，过几秒自己重连。
    conn.status = "disconnected"
    rerender()
    expect(result.current.autoConnectError).toBeNull()
  })

  // #872: 网页模式下 transport 抛的是 `{ code, message }` 普通对象，横幅要
  // 显示里面的文字，不能是「[object Object]」。
  it("shows the text of a plain error object the auto-connect got", async () => {
    conn.connectRejection = {
      code: "bad_gateway",
      message: "网关暂时不可用",
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderDraft()
    await vi.waitFor(() => {
      expect(result.current.autoConnectError).toBe("网关暂时不可用")
    })
  })

  // #872 返工：被限流不算连接失败。provider 过几秒自己重连，这期间横幅不报错，
  // 聊天页也就不会把排队的消息标成失败（重连上了排队的消息会自己发出去）。
  it("reports no failure while a rate-limited connect waits to retry", async () => {
    conn.connectRejection = {
      code: "rate_limited",
      message: "请求太频繁，稍后自动重试。",
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { useConnection } = await import("@/hooks/use-connection")
    const connect = vi.mocked(useConnection("draft-tab").connect)
    connect.mockClear()
    const { result } = renderDraft()
    await vi.waitFor(() => {
      expect(connect).toHaveBeenCalled()
    })
    // 让 auto-connect 的 rejection 落地。
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(result.current.autoConnectError).toBeNull()
  })

  // #872: 限流后 provider 自己重连；那次重连因为别的原因失败时，provider 会
  // 发布新的失败，横幅要显示它。
  it("shows the auto-retry's later failure after a rate limit", async () => {
    conn.connectRejection = {
      code: "rate_limited",
      message: "请求太频繁，稍后自动重试。",
    }
    vi.spyOn(console, "error").mockImplementation(() => {})
    const { result, rerender } = renderDraft()
    await new Promise((resolve) => setTimeout(resolve, 0))
    conn.connectError = {
      agentType: "codex",
      title: "connectFailedTitle",
      detail: "spawn failed: exit code 1",
      opensAgentSettings: false,
    }
    rerender()
    expect(result.current.autoConnectError).toBe("spawn failed: exit code 1")
  })

  it("reports the published failure of a request that was parked", async () => {
    conn.connectError = {
      agentType: "codex",
      title: "connectFailedTitle",
      detail: "spawn failed: exit code 1",
      opensAgentSettings: false,
    }
    const { result } = renderDraft()
    // Let the auto-connect promise resolve, as a parked request's does.
    await vi.waitFor(() => {
      expect(result.current.autoConnectError).toBe("spawn failed: exit code 1")
    })
  })

  it("falls back to the title when the failure has nothing more to say", () => {
    conn.connectError = {
      agentType: "codex",
      title: "Codex's ACP adapter is not installed",
      detail: null,
      opensAgentSettings: true,
    }
    const { result } = renderDraft()
    expect(result.current.autoConnectError).toBe(
      "Codex's ACP adapter is not installed"
    )
  })

  it("ignores a failure published for another agent", () => {
    conn.connectError = {
      agentType: "claude_code",
      title: "connectFailedTitle",
      detail: "old agent failed",
      opensAgentSettings: false,
    }
    const { result } = renderDraft()
    expect(result.current.autoConnectError).toBeNull()
  })

  // #952: 网页模式下发送失败时 transport 抛的可能是没有 code 的
  // `{ error: "..." }`，提示里要是里面的文字，不能是「[object Object]」。
  it("shows the text of a plain error body when a send fails", async () => {
    conn.status = "connected"
    conn.sendRejection = { error: "上游暂时不可用" }
    vi.spyOn(console, "error").mockImplementation(() => {})
    const onSendFailed = vi.fn()
    const { result } = renderDraft()
    result.current.handleSend(
      { blocks: [{ type: "text", text: "你好" }], displayText: "你好" },
      null,
      { onSendFailed }
    )
    await vi.waitFor(() => {
      expect(onSendFailed).toHaveBeenCalled()
    })
    const sendToast = notifyMock.mock.calls
      .map(([arg]) => arg as { key?: string; title?: string })
      .find((arg) => arg.key?.startsWith("send-failed:"))
    expect(sendToast?.title).toContain("上游暂时不可用")
    expect(sendToast?.title).not.toContain("[object Object]")
  })

  it("stays quiet once the session is up", () => {
    conn.status = "connected"
    conn.connectError = {
      agentType: "codex",
      title: "connectFailedTitle",
      detail: "stale",
      opensAgentSettings: false,
    }
    const { result } = renderDraft()
    expect(result.current.autoConnectError).toBeNull()
  })
})
