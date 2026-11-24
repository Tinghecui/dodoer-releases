import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.hoisted(() => vi.fn())
const env = vi.hoisted(() => ({ desktop: false, remote: false }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call }),
  isDesktop: () => env.desktop,
  isRemoteDesktopMode: () => env.remote,
}))

const notifyWebUnauthorized = vi.hoisted(() => vi.fn())
vi.mock("@/lib/transport/web-connection-store", () => ({
  notifyWebUnauthorized,
}))

import { ENVELOPE_COMMAND } from "./index"
import { notePageLeaving, sendEnvelope } from "./transport"

beforeEach(() => call.mockReset())

describe("sendEnvelope", () => {
  it("posts the envelope text and hands back Sentry's answer", async () => {
    call.mockResolvedValue({
      statusCode: 429,
      rateLimits: "60:error:organization",
      retryAfter: "60",
    })
    const body = new TextEncoder().encode('{"dsn":"x"}\n{}')
    await expect(sendEnvelope({ body })).resolves.toEqual({
      statusCode: 429,
      headers: {
        "x-sentry-rate-limits": "60:error:organization",
        "retry-after": "60",
      },
    })
    expect(call).toHaveBeenCalledWith(ENVELOPE_COMMAND, {
      envelope: '{"dsn":"x"}\n{}',
    })
  })

  it("resolves a refusal so the envelope is dropped, not retried", async () => {
    call.mockRejectedValueOnce({ code: "invalid_input", message: "too big" })
    await expect(sendEnvelope({ body: "x" })).resolves.toMatchObject({
      statusCode: 400,
    })
    call.mockRejectedValueOnce({
      code: "not_found",
      message: "telemetry is off",
    })
    await expect(sendEnvelope({ body: "x" })).resolves.toMatchObject({
      statusCode: 404,
    })
  })

  it("rejects when it did not get through, so it is kept for later", async () => {
    const offline = new TypeError("Failed to fetch")
    call.mockRejectedValueOnce(offline)
    await expect(sendEnvelope({ body: "x" })).rejects.toBe(offline)
    call.mockRejectedValueOnce({ code: "network_error", message: "HTTP 502" })
    await expect(sendEnvelope({ body: "x" })).rejects.toMatchObject({
      code: "network_error",
    })
  })
})

describe("sendEnvelope while the page is going away", () => {
  let visibility: DocumentVisibilityState = "hidden"
  const fetchMock = vi.fn()

  beforeEach(() => {
    visibility = "hidden"
    env.desktop = false
    env.remote = false
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => visibility,
    })
    localStorage.setItem("codeg_token", "tok-example")
    fetchMock.mockReset()
    notifyWebUnauthorized.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    notePageLeaving(false)
    vi.unstubAllGlobals()
    localStorage.clear()
    delete (document as { visibilityState?: unknown }).visibilityState
  })

  function okResponse(value: unknown) {
    return {
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify(value)),
      json: () => Promise.resolve(value),
    }
  }

  it("posts with keepalive and the auth headers, so a reload does not cancel it", async () => {
    fetchMock.mockResolvedValue(okResponse({ statusCode: 200 }))
    await expect(sendEnvelope({ body: "env-text" })).resolves.toMatchObject({
      statusCode: 200,
    })
    expect(call).not.toHaveBeenCalled()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`/api/${ENVELOPE_COMMAND}`)
    expect(init.method).toBe("POST")
    expect(init.keepalive).toBe(true)
    expect(init.headers["Content-Type"]).toBe("application/json")
    expect(init.headers.Authorization).toBe("Bearer tok-example")
    expect(JSON.parse(init.body)).toEqual({ envelope: "env-text" })
  })

  it("keeps the usual call while the page is visible", async () => {
    visibility = "visible"
    call.mockResolvedValue({ statusCode: 200 })
    await sendEnvelope({ body: "x" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalled()
  })

  it("keeps the usual call for a body keepalive cannot carry", async () => {
    call.mockResolvedValue({ statusCode: 200 })
    await sendEnvelope({ body: "x".repeat(70_000) })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalled()
  })

  it("keeps the usual call in the desktop app and a remote desktop window", async () => {
    call.mockResolvedValue({ statusCode: 200 })
    env.desktop = true
    await sendEnvelope({ body: "x" })
    env.desktop = false
    env.remote = true
    await sendEnvelope({ body: "x" })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(call).toHaveBeenCalledTimes(2)
  })

  it("resolves a refusal and rejects a server that could not forward it", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 404,
      json: () =>
        Promise.resolve({ code: "not_found", message: "telemetry is off" }),
    })
    await expect(sendEnvelope({ body: "x" })).resolves.toMatchObject({
      statusCode: 404,
    })
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    })
    await expect(sendEnvelope({ body: "x" })).rejects.toMatchObject({
      code: "network_error",
    })
  })

  it("posts with keepalive once pagehide came, though the page still reads visible", async () => {
    visibility = "visible"
    notePageLeaving(true)
    fetchMock.mockResolvedValue(okResponse({ statusCode: 200 }))
    await sendEnvelope({ body: "x" })
    expect(call).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls[0][1].keepalive).toBe(true)
    notePageLeaving(false)
    call.mockResolvedValue({ statusCode: 200 })
    await sendEnvelope({ body: "x" })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledTimes(1)
  })

  it("falls back to the usual call whatever the browser throws on a keepalive it will not send", async () => {
    call.mockResolvedValue({ statusCode: 200 })
    const refusals = [
      new TypeError("Failed to fetch"),
      new DOMException("keepalive quota exceeded", "NotAllowedError"),
      new DOMException("aborted", "AbortError"),
      new Error("request refused"),
    ]
    for (const refusal of refusals) {
      fetchMock.mockRejectedValueOnce(refusal)
      await expect(sendEnvelope({ body: "x" })).resolves.toMatchObject({
        statusCode: 200,
      })
    }
    expect(fetchMock).toHaveBeenCalledTimes(refusals.length)
    expect(call).toHaveBeenCalledTimes(refusals.length)
  })

  it("does not resend through the usual call once the server answered", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error("not json")),
    })
    await expect(sendEnvelope({ body: "x" })).rejects.toMatchObject({
      code: "network_error",
    })
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: () => Promise.resolve("{not json"),
    })
    await expect(sendEnvelope({ body: "x" })).rejects.toBeInstanceOf(Error)
    expect(call).not.toHaveBeenCalled()
  })

  it("raises the session-expired dialog on a 401, like every other call", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: { get: () => 'Bearer realm="codeg"' },
      json: () => Promise.resolve(null),
    })
    await expect(sendEnvelope({ body: "x" })).rejects.toThrow("Unauthorized")
    expect(notifyWebUnauthorized).toHaveBeenCalledWith("codeg")
  })
})
