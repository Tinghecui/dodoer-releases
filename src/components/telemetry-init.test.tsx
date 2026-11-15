import { cleanup, render } from "@testing-library/react"
import { act } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const loadLocal = vi.hoisted(() => vi.fn())
const start = vi.hoisted(() => vi.fn())
const cached = vi.hoisted(() => ({ info: null as unknown }))
vi.mock("@/lib/cowork/info", () => ({
  loadLocalDaemonTelemetry: () => loadLocal(),
  useCachedCoworkInfo: () => cached.info,
}))
vi.mock("@/lib/platform", () => ({ isRemoteDesktopWindow: () => false }))
vi.mock("@/lib/telemetry", () => ({
  installEarlyCapture: () => () => {},
  startTelemetry: (...args: unknown[]) => start(...args),
}))

import {
  LOCAL_TELEMETRY_RETRY_MS,
  LOCAL_TELEMETRY_TRIES,
  TelemetryInit,
} from "./telemetry-init"

const LOCAL = {
  dsn: "https://key@o1.ingest.us.sentry.io/3",
  environment: "desktop-local",
  release: "cowork-codeg-v0.7.0",
  tracesSampleRate: 1,
  commandSampleRates: {},
  user: "0a1b2c3d4e5f",
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  loadLocal.mockReset()
  start.mockReset()
  cached.info = null
})
afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe("TelemetryInit", () => {
  it("starts a local window with its own daemon's telemetry", async () => {
    loadLocal.mockResolvedValue(LOCAL)
    render(<TelemetryInit />)
    await flush()
    expect(start).toHaveBeenCalledWith(LOCAL, "desktop-local")
  })

  it("stays off when the daemon does not report", async () => {
    loadLocal.mockResolvedValue(null)
    render(<TelemetryInit />)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(LOCAL_TELEMETRY_RETRY_MS * 3)
    })
    expect(start).not.toHaveBeenCalled()
    expect(loadLocal).toHaveBeenCalledTimes(1)
  })

  it("asks again while the daemon cannot answer, a few times", async () => {
    loadLocal.mockRejectedValue(new Error("restarting"))
    render(<TelemetryInit />)
    await flush()
    for (let i = 1; i < LOCAL_TELEMETRY_TRIES + 2; i++) {
      await act(async () => {
        vi.advanceTimersByTime(LOCAL_TELEMETRY_RETRY_MS)
      })
      await flush()
    }
    expect(loadLocal).toHaveBeenCalledTimes(LOCAL_TELEMETRY_TRIES)
    expect(start).not.toHaveBeenCalled()
  })

  it("starts a server's window from its cowork_info", async () => {
    loadLocal.mockResolvedValue(null)
    cached.info = { telemetry: LOCAL }
    render(<TelemetryInit />)
    await flush()
    expect(start).toHaveBeenCalledWith(LOCAL, "web")
  })
})
