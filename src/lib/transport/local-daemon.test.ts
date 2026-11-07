import { afterEach, describe, expect, it } from "vitest"
import {
  LOCAL_DAEMON_CONNECTION_ID,
  isClientOnlyApp,
  isLocalChildDaemon,
  localDaemonInfo,
} from "./local-daemon"

const w = window as unknown as { __CODEG_LOCAL_DAEMON__?: unknown }

afterEach(() => {
  delete w.__CODEG_LOCAL_DAEMON__
})

describe("localDaemonInfo", () => {
  it("is absent outside the app and for an app from before the split", () => {
    expect(localDaemonInfo()).toBeNull()
    expect(isLocalChildDaemon()).toBe(false)
    expect(isClientOnlyApp()).toBe(false)
  })

  it("reads the three modes the app can be in", () => {
    w.__CODEG_LOCAL_DAEMON__ = { mode: "child", connectionId: -1 }
    expect(localDaemonInfo()).toEqual({ mode: "child", connectionId: -1 })
    expect(isLocalChildDaemon()).toBe(true)
    expect(isClientOnlyApp()).toBe(false)

    w.__CODEG_LOCAL_DAEMON__ = { mode: "embedded", connectionId: -1 }
    expect(localDaemonInfo()?.mode).toBe("embedded")
    expect(isLocalChildDaemon()).toBe(false)
    expect(isClientOnlyApp()).toBe(false)

    w.__CODEG_LOCAL_DAEMON__ = { mode: "client", connectionId: -1 }
    expect(localDaemonInfo()?.mode).toBe("client")
    expect(isLocalChildDaemon()).toBe(false)
    expect(isClientOnlyApp()).toBe(true)
  })

  it("ignores a mode it does not know and fills in the connection id", () => {
    w.__CODEG_LOCAL_DAEMON__ = { mode: "remote" }
    expect(localDaemonInfo()).toBeNull()
    w.__CODEG_LOCAL_DAEMON__ = { mode: "child" }
    expect(localDaemonInfo()?.connectionId).toBe(LOCAL_DAEMON_CONNECTION_ID)
    w.__CODEG_LOCAL_DAEMON__ = "child"
    expect(localDaemonInfo()).toBeNull()
  })
})
