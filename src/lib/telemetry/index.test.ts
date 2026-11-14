import { afterEach, describe, expect, it, vi } from "vitest"

const backend = vi.hoisted(() => ({
  loaded: false,
  start: vi.fn(),
  reportError: vi.fn(),
  beginApiCall: vi.fn(() => ({ headers: { "sentry-trace": "t" }, end() {} })),
  noteWs: vi.fn(),
  turnStarted: vi.fn(() => ({ noteEvent: vi.fn(), end: vi.fn() })),
  sendFeedback: vi.fn(),
}))
vi.mock("./sentry", () => {
  backend.loaded = true
  return backend
})

import {
  ENVELOPE_COMMAND,
  beginApiCall,
  earlyErrorsForTests,
  isTelemetryOn,
  noteWs,
  normalizeClientTelemetry,
  reportError,
  resetTelemetryForTests,
  sendFeedback,
  startTelemetry,
  subscribeTelemetry,
  turnStarted,
  type ClientTelemetry,
} from "./index"

const CONFIG: ClientTelemetry = {
  dsn: "https://key@o1.ingest.us.sentry.io/2",
  environment: "production",
  release: "cowork-codeg-v0.6.0",
  tracesSampleRate: 1,
  commandSampleRates: { get_git_head: 0.01 },
  user: "james",
}

afterEach(() => {
  resetTelemetryForTests()
  vi.clearAllMocks()
})

describe("while telemetry is off", () => {
  it("does nothing and never loads the SDK", () => {
    const call = beginApiCall("list_folders", "web")
    expect(call.headers).toEqual({})
    call.end("ok")
    noteWs({ type: "connecting" })
    const turn = turnStarted("claude_code")
    turn.noteEvent("content_delta")
    turn.end("complete")
    expect(
      sendFeedback("it broke", { conversationId: 1, agent: "claude_code" })
    ).toBe(false)
    expect(isTelemetryOn()).toBe(false)
    expect(backend.loaded).toBe(false)
    expect(backend.beginApiCall).not.toHaveBeenCalled()
    expect(backend.turnStarted).not.toHaveBeenCalled()
  })

  it("keeps at most 20 errors for later", () => {
    for (let i = 0; i < 25; i++) reportError(new Error(`e${i}`))
    expect(earlyErrorsForTests()).toBe(20)
  })
})

describe("startTelemetry", () => {
  it("loads the SDK once and sends the errors kept so far", async () => {
    const first = new Error("before start")
    reportError(first, { where: "boot" })
    await Promise.all([
      startTelemetry(CONFIG, "web"),
      startTelemetry(CONFIG, "web"),
    ])
    expect(backend.start).toHaveBeenCalledTimes(1)
    expect(backend.start).toHaveBeenCalledWith(CONFIG, "web")
    expect(backend.reportError).toHaveBeenCalledWith(first, { where: "boot" })
    expect(earlyErrorsForTests()).toBe(0)
    expect(isTelemetryOn()).toBe(true)

    expect(beginApiCall("list_folders", "web").headers).toEqual({
      "sentry-trace": "t",
    })
    // Its own envelopes are never timed: that would report about reporting.
    expect(beginApiCall(ENVELOPE_COMMAND, "web").headers).toEqual({})
    expect(backend.beginApiCall).toHaveBeenCalledTimes(1)
  })

  it("tells subscribers once it has started", async () => {
    const listener = vi.fn()
    const unsubscribe = subscribeTelemetry(listener)
    await startTelemetry(CONFIG, "web")
    expect(listener).toHaveBeenCalledTimes(1)
    unsubscribe()
  })

  it("hands turns and feedback to the SDK once started", async () => {
    await startTelemetry(CONFIG, "web")
    turnStarted("codex").end("stranded")
    expect(backend.turnStarted).toHaveBeenCalledWith("codex")
    const context = { conversationId: 7, agent: "codex" }
    expect(sendFeedback("   ", context)).toBe(false)
    expect(sendFeedback("stuck", context)).toBe(true)
    expect(backend.sendFeedback).toHaveBeenCalledTimes(1)
    expect(backend.sendFeedback).toHaveBeenCalledWith("stuck", context)
  })

  it("never rejects when the SDK fails to start", async () => {
    backend.start.mockImplementationOnce(() => {
      throw new Error("boom")
    })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    await expect(startTelemetry(CONFIG, "web")).resolves.toBeUndefined()
    expect(isTelemetryOn()).toBe(false)
    warn.mockRestore()
  })
})

describe("normalizeClientTelemetry", () => {
  it("reads the server's config", () => {
    expect(normalizeClientTelemetry({ ...CONFIG })).toEqual(CONFIG)
  })

  it("is off without a DSN", () => {
    expect(normalizeClientTelemetry(undefined)).toBeNull()
    expect(normalizeClientTelemetry({ dsn: "" })).toBeNull()
  })

  it("fills in defaults and drops bad rates", () => {
    expect(
      normalizeClientTelemetry({
        dsn: "d",
        tracesSampleRate: 7,
        commandSampleRates: { health: "x", get_git_head: 0.5 },
      })
    ).toEqual({
      dsn: "d",
      environment: "production",
      release: "unknown",
      tracesSampleRate: 1,
      commandSampleRates: { health: 1, get_git_head: 0.5 },
      user: "",
    })
  })
})
