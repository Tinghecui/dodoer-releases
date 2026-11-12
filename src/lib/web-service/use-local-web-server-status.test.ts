import { afterEach, describe, expect, it, vi } from "vitest"

import { hasLocalWebService } from "./use-local-web-server-status"

const env = vi.hoisted(() => ({ desktop: true, remote: false }))

vi.mock("@/lib/api", () => ({
  getWebServerStatus: vi.fn(),
  WEB_SERVICE_STATUS_CHANGED_EVENT: "web-service://status-changed",
}))
vi.mock("@/lib/platform", () => ({ subscribe: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  isDesktop: () => env.desktop,
  isRemoteDesktopMode: () => env.remote,
}))

type DaemonWindow = { __CODEG_LOCAL_DAEMON__?: unknown }

function setDaemonMode(mode: string | null) {
  const w = window as unknown as DaemonWindow
  if (mode == null) delete w.__CODEG_LOCAL_DAEMON__
  else w.__CODEG_LOCAL_DAEMON__ = { mode, connectionId: -1 }
}

describe("hasLocalWebService", () => {
  afterEach(() => {
    env.desktop = true
    env.remote = false
    setDaemonMode(null)
  })

  it("is the in-process daemon's: an app that says nothing about its daemon, or says embedded", () => {
    expect(hasLocalWebService()).toBe(true)
    setDaemonMode("embedded")
    expect(hasLocalWebService()).toBe(true)
  })

  it("is not offered while the daemon is a child process, or there is none", () => {
    setDaemonMode("child")
    expect(hasLocalWebService()).toBe(false)
    setDaemonMode("client")
    expect(hasLocalWebService()).toBe(false)
  })

  it("is not offered in a browser or a remote window", () => {
    env.desktop = false
    expect(hasLocalWebService()).toBe(false)
    env.desktop = true
    env.remote = true
    expect(hasLocalWebService()).toBe(false)
  })
})
