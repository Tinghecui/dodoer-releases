import { afterEach, describe, expect, it, vi } from "vitest"
import type { EventStream, Transport } from "./types"
import { LocalDaemonTransport } from "./local-daemon-transport"
import { localDaemonInfo, LOCAL_DAEMON_CONNECTION_ID } from "./local-daemon"

function fakeTransport(name: string) {
  const unsubscribed: string[] = []
  const stream = { attach: vi.fn() } as unknown as EventStream
  const t = {
    calls: [] as string[],
    unsubscribed,
    call: vi.fn(async (command: string) => {
      t.calls.push(command)
      return `${name}:${command}`
    }),
    subscribe: vi.fn(async (event: string) => () => {
      unsubscribed.push(event)
    }),
    isDesktop: () => true,
    eventStream: () => stream,
    destroy: vi.fn(),
    stream,
  }
  return t
}

describe("LocalDaemonTransport", () => {
  it("sends daemon commands to the child and app commands to the app", async () => {
    const shell = fakeTransport("shell")
    const daemon = fakeTransport("daemon")
    const t = new LocalDaemonTransport(
      shell as unknown as Transport,
      daemon as unknown as Transport
    )
    await expect(t.call("list_conversations")).resolves.toBe(
      "daemon:list_conversations"
    )
    await expect(t.call("open_settings_window")).resolves.toBe(
      "shell:open_settings_window"
    )
    await expect(t.call("browser_open_tab")).resolves.toBe(
      "shell:browser_open_tab"
    )
    expect(shell.calls).toEqual(["open_settings_window", "browser_open_tab"])
    expect(daemon.calls).toEqual(["list_conversations"])
  })

  it("applies a both-sides setting in the child first, then in the app", async () => {
    const shell = fakeTransport("shell")
    const daemon = fakeTransport("daemon")
    shell.call.mockRejectedValueOnce(new Error("app side failed"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const t = new LocalDaemonTransport(
      shell as unknown as Transport,
      daemon as unknown as Transport
    )
    // The child's answer is the answer, even when the app's copy fails.
    await expect(t.call("set_log_settings", { level: "debug" })).resolves.toBe(
      "daemon:set_log_settings"
    )
    expect(daemon.call).toHaveBeenCalledTimes(1)
    expect(shell.call).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it("hears events from both and unsubscribes from both", async () => {
    const shell = fakeTransport("shell")
    const daemon = fakeTransport("daemon")
    const t = new LocalDaemonTransport(
      shell as unknown as Transport,
      daemon as unknown as Transport
    )
    const off = await t.subscribe("acp://event", () => {})
    expect(shell.subscribe).toHaveBeenCalledWith(
      "acp://event",
      expect.any(Function)
    )
    expect(daemon.subscribe).toHaveBeenCalledWith(
      "acp://event",
      expect.any(Function)
    )
    off()
    expect(shell.unsubscribed).toEqual(["acp://event"])
    expect(daemon.unsubscribed).toEqual(["acp://event"])
  })

  it("takes the event stream and lifecycle from the child", () => {
    const shell = fakeTransport("shell")
    const daemon = fakeTransport("daemon")
    const t = new LocalDaemonTransport(
      shell as unknown as Transport,
      daemon as unknown as Transport
    )
    expect(t.eventStream?.()).toBe(daemon.stream)
    expect(t.isDesktop()).toBe(true)
    t.destroy()
    expect(daemon.destroy).toHaveBeenCalled()
  })
})

describe("localDaemonInfo", () => {
  afterEach(() => {
    delete (window as unknown as Record<string, unknown>).__CODEG_LOCAL_DAEMON__
  })

  it("is null outside the app and for anything malformed", () => {
    expect(localDaemonInfo()).toBeNull()
    ;(window as unknown as Record<string, unknown>).__CODEG_LOCAL_DAEMON__ = {
      mode: "remote",
    }
    expect(localDaemonInfo()).toBeNull()
  })

  it("reads the mode and the connection id the app set", () => {
    ;(window as unknown as Record<string, unknown>).__CODEG_LOCAL_DAEMON__ = {
      mode: "child",
      connectionId: -1,
    }
    expect(localDaemonInfo()).toEqual({ mode: "child", connectionId: -1 })
    ;(window as unknown as Record<string, unknown>).__CODEG_LOCAL_DAEMON__ = {
      mode: "embedded",
    }
    expect(localDaemonInfo()).toEqual({
      mode: "embedded",
      connectionId: LOCAL_DAEMON_CONNECTION_ID,
    })
  })
})
