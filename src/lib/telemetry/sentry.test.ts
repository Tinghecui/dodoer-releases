import { afterEach, describe, expect, it, vi } from "vitest"
import type { ErrorEvent as SentryErrorEvent } from "@sentry/browser"

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  logger: { info: vi.fn(), warn: vi.fn() },
  captureFeedback: vi.fn(),
  captureMessage: vi.fn(),
  scope: {
    setFingerprint: vi.fn(),
    setContext: vi.fn(),
    addEventProcessor: vi.fn(),
  },
  spans: [] as Array<{
    name: string
    attributes: Record<string, unknown>
    status?: { code: number; message?: string }
    ended: boolean
  }>,
}))
vi.mock("@sentry/browser", () => {
  const integration = () => ({ name: "stub" })
  return {
    breadcrumbsIntegration: integration,
    browserApiErrorsIntegration: integration,
    browserSessionIntegration: integration,
    browserTracingIntegration: integration,
    dedupeIntegration: integration,
    eventFiltersIntegration: integration,
    functionToStringIntegration: integration,
    globalHandlersIntegration: integration,
    httpContextIntegration: integration,
    linkedErrorsIntegration: integration,
    captureException: vi.fn(),
    captureFeedback: sdk.captureFeedback,
    captureMessage: sdk.captureMessage,
    createTransport: vi.fn(),
    makeBrowserOfflineTransport: vi.fn(() => () => ({})),
    init: sdk.init,
    logger: sdk.logger,
    setTags: vi.fn(),
    setUser: vi.fn(),
    withScope: (fn: (scope: typeof sdk.scope) => void) => fn(sdk.scope),
    startNewTrace: (fn: () => unknown) => fn(),
    startInactiveSpan: (options: {
      name: string
      attributes: Record<string, unknown>
    }) => {
      const span = {
        name: options.name,
        attributes: { ...options.attributes },
        status: undefined as { code: number; message?: string } | undefined,
        ended: false,
        setAttribute(key: string, value: unknown) {
          span.attributes[key] = value
        },
        setStatus(status: { code: number; message?: string }) {
          span.status = status
        },
        end() {
          span.ended = true
        },
      }
      sdk.spans.push(span)
      return span
    },
    getTraceData: () => ({
      "sentry-trace": "0123-4567-1",
      baggage: "sentry-environment=production",
      traceparent: "00-0123-4567-01",
    }),
  }
})

import {
  MAX_ERRORS,
  admitError,
  beginApiCall,
  describeElement,
  isFailure,
  noteWs,
  resetForTests,
  scrubBreadcrumb,
  scrubEvent,
  sendFeedback,
  start,
  turnStarted,
} from "./sentry"

const CONFIG = {
  dsn: "https://key@o1.ingest.us.sentry.io/2",
  environment: "production",
  release: "cowork-codeg-v0.6.0",
  tracesSampleRate: 0.5,
  commandSampleRates: { get_git_head: 0.01 },
  user: "james",
}

afterEach(() => {
  resetForTests()
  sdk.spans.length = 0
  vi.clearAllMocks()
})

describe("start", () => {
  it("tunnels through the server and collects no content", () => {
    start(CONFIG, "web")
    const options = sdk.init.mock.calls[0][0]
    expect(options.tunnel).toBe("/api/telemetry_envelope")
    expect(options.defaultIntegrations).toBe(false)
    expect(options.dataCollection).toMatchObject({
      userInfo: false,
      cookies: false,
      httpBodies: [],
      urlQueryParams: false,
    })
    expect(options.tracesSampler({ name: "pageload", attributes: {} })).toBe(
      0.5
    )
    expect(
      options.tracesSampler({
        name: "x",
        attributes: { "codeg.sample_rate": 0.01 },
      })
    ).toBe(0.01)
  })
})

describe("beginApiCall", () => {
  it("samples polled commands down and carries the trace to the server", () => {
    start(CONFIG, "web")
    const call = beginApiCall("get_git_head", "web")
    expect(sdk.spans[0].attributes["codeg.sample_rate"]).toBe(0.01)
    expect(call.headers).toEqual({
      "sentry-trace": "0123-4567-1",
      baggage: "sentry-environment=production",
    })
    beginApiCall("list_folders", "web")
    expect(sdk.spans[1].attributes["codeg.sample_rate"]).toBe(0.5)
  })

  it("sends no headers through the desktop proxy", () => {
    start(CONFIG, "remote-desktop")
    expect(beginApiCall("list_folders", "remote-desktop").headers).toEqual({})
  })

  it("logs failures, not a 4xx", () => {
    start(CONFIG, "web")
    beginApiCall("a", "web").end("ok")
    beginApiCall("b", "web").end(409)
    expect(sdk.logger.warn).not.toHaveBeenCalled()
    beginApiCall("c", "web").end(500)
    beginApiCall("d", "web").end("timeout")
    beginApiCall("e", "web").end(501)
    expect(sdk.logger.warn).toHaveBeenCalledTimes(3)
    expect(sdk.logger.warn).toHaveBeenLastCalledWith(
      "API command not implemented",
      { command: "e", surface: "web" }
    )
    expect(sdk.spans.map((s) => [s.status?.code, s.ended])).toEqual([
      [1, true],
      [1, true],
      [2, true],
      [2, true],
      [2, true],
    ])
  })

  it("ends a span once", () => {
    start(CONFIG, "web")
    const call = beginApiCall("c", "web")
    call.end(500)
    call.end(500)
    expect(sdk.logger.warn).toHaveBeenCalledTimes(1)
  })

  it("counts what is the network's or the server's fault", () => {
    expect(isFailure("ok")).toBe(false)
    expect(isFailure(404)).toBe(false)
    expect(isFailure(502)).toBe(true)
    expect(isFailure("network")).toBe(true)
    expect(isFailure("error")).toBe(true)
  })
})

describe("noteWs", () => {
  it("times a reconnect as one span", () => {
    start(CONFIG, "web")
    noteWs({ type: "connecting" })
    noteWs({ type: "ready", attempts: 0 })
    noteWs({ type: "closed", code: 1006, wasClean: false })
    noteWs({ type: "reconnecting", reason: "closed" })
    noteWs({ type: "reconnecting", reason: "closed" })
    noteWs({ type: "ready", attempts: 3 })
    expect(sdk.spans).toHaveLength(1)
    expect(sdk.spans[0]).toMatchObject({
      name: "event socket reconnect",
      ended: true,
      status: { code: 1 },
    })
    expect(sdk.spans[0].attributes["codeg.attempts"]).toBe(3)
    expect(sdk.logger.warn).toHaveBeenCalledWith(
      "Event socket closed",
      expect.objectContaining({ code: 1006, clean: false })
    )
    expect(sdk.logger.info).toHaveBeenCalledWith(
      "Event socket back",
      expect.objectContaining({ attempts: 3 })
    )
  })

  it("ends the reconnect when the session expired", () => {
    start(CONFIG, "web")
    noteWs({ type: "reconnecting", reason: "network_lost" })
    noteWs({ type: "unauthorized" })
    expect(sdk.spans[0]).toMatchObject({
      ended: true,
      status: { code: 2, message: "unauthenticated" },
    })
  })
})

describe("turnStarted", () => {
  it("times a turn from the send to its end", () => {
    start(CONFIG, "web")
    const turn = turnStarted("claude_code")
    turn.noteEvent("user_message")
    turn.noteEvent("status_changed")
    turn.noteEvent("content_delta")
    turn.noteEvent("turn_complete")
    turn.end("complete", { connStatus: "connected" })
    turn.end("error")
    expect(sdk.spans).toHaveLength(1)
    const [span] = sdk.spans
    expect(span).toMatchObject({
      name: "chat turn",
      ended: true,
      status: { code: 1 },
    })
    expect(span.attributes).toMatchObject({
      "codeg.sample_rate": 0.5,
      "codeg.agent": "claude_code",
      "codeg.outcome": "complete",
      "codeg.events": 4,
      "codeg.ws_drops": 0,
      "codeg.conn_status": "connected",
      "codeg.row_status": "none",
    })
    expect(span.attributes["codeg.first_event_ms"]).toBeGreaterThanOrEqual(0)
    expect(span.attributes["codeg.first_reply_ms"]).toBeGreaterThanOrEqual(0)
    expect(sdk.logger.warn).not.toHaveBeenCalled()
    expect(sdk.captureMessage).not.toHaveBeenCalled()
  })

  it("reports a turn the fallback settled as one warning", () => {
    start(CONFIG, "web")
    noteWs({ type: "ready", attempts: 0 })
    const turn = turnStarted("codex")
    turn.noteEvent("user_message")
    noteWs({ type: "closed", code: 1006, wasClean: false })
    noteWs({ type: "reconnecting", reason: "closed" })
    turn.end("stranded", { connStatus: "connected", rowStatus: "completed" })
    expect(sdk.scope.setFingerprint).toHaveBeenCalledWith(["stranded-turn"])
    expect(sdk.scope.setContext).toHaveBeenCalledWith(
      "turn",
      expect.objectContaining({
        outcome: "stranded",
        agent: "codex",
        events: 1,
        first_event_ms: -1,
        first_reply_ms: -1,
        ws_drops: 1,
        ws_state: "reconnecting",
        conn_status: "connected",
        row_status: "completed",
        event_types: "user_message",
      })
    )
    expect(sdk.captureMessage).toHaveBeenCalledWith(
      "Turn finished without reaching this tab",
      "warning"
    )
    const turnSpan = sdk.spans.find((s) => s.name === "chat turn")
    expect(turnSpan?.status).toEqual({ code: 2, message: "stranded" })
  })

  it("logs a failed turn, not one that waits in the queue", () => {
    start(CONFIG, "web")
    turnStarted("codex").end("busy")
    turnStarted("codex").end("replaced")
    turnStarted("codex").end("closed")
    expect(sdk.logger.warn).not.toHaveBeenCalled()
    turnStarted("codex").end("error")
    turnStarted("codex").end("send_failed")
    expect(sdk.logger.warn).toHaveBeenCalledTimes(2)
    expect(sdk.logger.warn).toHaveBeenLastCalledWith(
      "Turn failed",
      expect.objectContaining({ outcome: "send_failed" })
    )
  })
})

describe("sendFeedback", () => {
  it("sends the scrubbed text with the open conversation", () => {
    start(CONFIG, "web")
    noteWs({ type: "ready", attempts: 0 })
    sendFeedback("  stuck at /home/bob/secret-proj  ", {
      conversationId: 42,
      agent: "claude_code",
    })
    const [params, , scope] = sdk.captureFeedback.mock.calls[0]
    expect(params).toMatchObject({
      message: "stuck at ~/<redacted>",
      source: "account-menu",
      url: "/",
      tags: {
        conversation_id: 42,
        agent: "claude_code",
        ws_state: "ready",
        ws_closes: 0,
      },
    })
    expect(scope).toBe(sdk.scope)
    // Feedback skips `beforeSend`, so the scope scrubs it instead.
    const [processor] = sdk.scope.addEventProcessor.mock.calls[0]
    expect(
      processor({
        type: "feedback",
        request: { url: "https://h.example/w?folder=/home/bob" },
      })
    ).toEqual({ type: "feedback", request: { url: "/w" } })
  })

  it("keeps a long report whole up to its own limit", () => {
    start(CONFIG, "web")
    sendFeedback("a".repeat(1200), { conversationId: null, agent: null })
    const [params] = sdk.captureFeedback.mock.calls[0]
    expect(params.message).toHaveLength(1200)
    expect(params.tags).toMatchObject({
      conversation_id: "none",
      agent: "none",
    })
  })
})

function errorEvent(value: string): SentryErrorEvent {
  return {
    type: undefined,
    exception: { values: [{ type: "Error", value }] },
  } as SentryErrorEvent
}

describe("budgets", () => {
  it("sends the same error once a minute", () => {
    expect(admitError(errorEvent("a"))).toBe(true)
    expect(admitError(errorEvent("a"))).toBe(false)
    expect(admitError(errorEvent("b"))).toBe(true)
  })

  it(`sends at most ${MAX_ERRORS} errors a page`, () => {
    let sent = 0
    for (let i = 0; i < MAX_ERRORS + 10; i++) {
      if (admitError(errorEvent(`e${i}`))) sent++
    }
    expect(sent).toBe(MAX_ERRORS)
  })
})

describe("scrubbing", () => {
  it("scrubs an event's messages, user and request", () => {
    const event = {
      ...errorEvent("open /home/bob/proj/a.ts failed"),
      message: "mail bob@example.com",
      user: { id: "james", ip_address: "10.0.0.1", email: "j@x.io" },
      request: {
        url: "https://h.example/workspace?folder=/home/bob/proj",
        query_string: "folder=/home/bob/proj",
        cookies: { a: "b" },
      },
      extra: { cwd: "/srv/x", count: 2 },
    } as SentryErrorEvent
    const out = scrubEvent(event)
    expect(out.exception?.values?.[0].value).toBe("open ~/<redacted> failed")
    expect(out.message).toBe("mail <email>")
    expect(out.user).toEqual({ id: "james" })
    expect(out.request).toEqual({ url: "/workspace" })
    expect(out.extra).toEqual({ count: 2 })
  })

  it("names a clicked element by tag and test id only", () => {
    const button = document.createElement("button")
    button.title = "Secret conversation"
    button.setAttribute("data-testid", "send")
    expect(describeElement(button)).toBe('button[data-testid="send"]')
    expect(describeElement(document.createElement("div"))).toBe("div")
    const crumb = scrubBreadcrumb(
      { category: "ui.click", message: 'button[title="Secret conversation"]' },
      { event: { target: button } }
    )
    expect(crumb?.message).toBe('button[data-testid="send"]')
  })

  it("keeps only the path of a navigation", () => {
    const crumb = scrubBreadcrumb({
      category: "navigation",
      data: { from: "/workspace?folder=/home/a", to: "/settings?tab=x" },
    })
    expect(crumb?.data).toEqual({ from: "/workspace", to: "/settings" })
  })
})
