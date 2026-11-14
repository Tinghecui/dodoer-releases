import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.hoisted(() => vi.fn())
vi.mock("@/lib/transport", () => ({ getTransport: () => ({ call }) }))

import { ENVELOPE_COMMAND } from "./index"
import { sendEnvelope } from "./transport"

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
