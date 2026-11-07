// Cowork fork: the optional WS `hello` → `server_info` handshake
// (`server-info.ts`) and how both transports carry it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { CLIENT_API_VERSION } from "@/lib/cowork/compat"
import { RemoteDesktopTransport } from "./remote-desktop-transport"
import { ServerInfoChannel } from "./server-info"
import { WebTransport } from "./web-transport"

const { invokeMock, listenMock } = vi.hoisted(() => ({
  invokeMock:
    vi.fn<
      (command: string, args?: Record<string, unknown>) => Promise<unknown>
    >(),
  listenMock:
    vi.fn<
      (
        event: string,
        handler: (event: { payload: unknown }) => void
      ) => Promise<() => void>
    >(),
}))
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }))
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => "1.2.5" }))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({ label: "main-webview", listen: listenMock }),
}))

const SERVER_INFO = {
  type: "server_info",
  api_version: 1,
  min_desktop_version: "1.2.0",
  features: ["cowork_info"],
}
const COMPAT = {
  apiVersion: 1,
  minDesktopVersion: "1.2.0",
  features: ["cowork_info"],
}

async function flush() {
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  invokeMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllTimers()
  vi.useRealTimers()
  localStorage.clear()
})

describe("ServerInfoChannel", () => {
  it("says who is asking, with an async version", async () => {
    const send = vi.fn()
    await new ServerInfoChannel("codeg-desktop", async () => "1.2.5").hello(
      send
    )
    expect(send).toHaveBeenCalledWith({
      action: "hello",
      client: "codeg-desktop",
      version: "1.2.5",
      api_version: CLIENT_API_VERSION,
    })
  })

  it("never throws, whether the version or the send fails", async () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const send = vi.fn().mockRejectedValue(new Error("closed"))
    const channel = new ServerInfoChannel("x", () => {
      throw new Error("no version")
    })
    await expect(channel.hello(send)).resolves.toBeUndefined()
    expect(send.mock.calls[0][0]).toMatchObject({ version: undefined })
    debug.mockRestore()
  })

  it("takes only server_info frames, and tells every listener", () => {
    const channel = new ServerInfoChannel("x", () => undefined)
    const early = vi.fn()
    channel.subscribe(early)
    for (const other of [
      { type: "pong" },
      { channel: "__ready__", payload: null },
      null,
      "server_info",
    ]) {
      expect(channel.handleFrame(other)).toBe(false)
    }
    expect(early).not.toHaveBeenCalled()

    expect(channel.handleFrame(SERVER_INFO)).toBe(true)
    expect(early).toHaveBeenCalledWith(COMPAT)
    expect(channel.current()).toEqual(COMPAT)

    // A late listener hears the current answer at once.
    const late = vi.fn()
    channel.subscribe(late)
    expect(late).toHaveBeenCalledWith(COMPAT)

    // After a drop the next socket has to say it again.
    channel.reset()
    expect(channel.current()).toBeNull()
    const afterDrop = vi.fn()
    channel.subscribe(afterDrop)
    expect(afterDrop).not.toHaveBeenCalled()
  })

  it("reads a partial answer the way /api/health is read", () => {
    const channel = new ServerInfoChannel("x", () => undefined)
    const listener = vi.fn()
    channel.subscribe(listener)
    channel.handleFrame({ type: "server_info" })
    expect(listener).toHaveBeenCalledWith({
      apiVersion: 0,
      minDesktopVersion: null,
      features: [],
    })
  })
})

// ── WebTransport ────────────────────────────────────────────────────────────

class MockWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static CLOSING = 2
  static CLOSED = 3
  static instances: MockWebSocket[] = []
  readyState = MockWebSocket.CONNECTING
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  sent: string[] = []
  constructor(public url: string) {
    MockWebSocket.instances.push(this)
  }
  send(data: string) {
    this.sent.push(data)
  }
  close() {
    this.readyState = MockWebSocket.CLOSED
  }
  open() {
    this.readyState = MockWebSocket.OPEN
    this.onopen?.()
  }
  receive(frame: unknown) {
    this.onmessage?.({ data: JSON.stringify(frame) })
  }
  ready() {
    this.receive({ channel: "__ready__", payload: null })
  }
  drop() {
    this.readyState = MockWebSocket.CLOSED
    this.onclose?.()
  }
  hellos() {
    return this.sent
      .map((text) => JSON.parse(text))
      .filter((frame) => frame.action === "hello")
  }
}

describe("WebTransport hello", () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    vi.stubGlobal("WebSocket", MockWebSocket)
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ status: 200, ok: true, json: async () => ({}) }))
    )
    localStorage.setItem("codeg_token", "tok")
  })

  function connect() {
    const transport = new WebTransport("http://localhost")
    transport.eventStream()
    const ws = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    ws.open()
    return { transport, ws }
  }

  it("says hello after __ready__, not before", async () => {
    const { transport, ws } = connect()
    await flush()
    expect(ws.hellos()).toEqual([])

    ws.ready()
    await flush()
    expect(ws.hellos()).toEqual([
      expect.objectContaining({
        action: "hello",
        client: "codeg-web",
        api_version: CLIENT_API_VERSION,
      }),
    ])
    transport.destroy()
  })

  it("hands server_info to its listeners and nothing else to the event stream", async () => {
    const { transport, ws } = connect()
    const stream = transport.eventStream()
    const handlers = {
      onSnapshot: vi.fn(),
      onReplay: vi.fn(),
      onEvent: vi.fn(),
      onDetached: vi.fn(),
    }
    stream.attach("conn", {}, handlers)
    const listener = vi.fn()
    transport.onServerInfo(listener)
    ws.ready()
    await flush()

    ws.receive(SERVER_INFO)
    expect(listener).toHaveBeenCalledWith(COMPAT)
    expect(handlers.onDetached).not.toHaveBeenCalled()
    expect(handlers.onEvent).not.toHaveBeenCalled()
    transport.destroy()
  })

  it("against an older server: hello goes unanswered and nothing fires", async () => {
    const { transport, ws } = connect()
    const listener = vi.fn()
    transport.onServerInfo(listener)
    ws.ready()
    await flush()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(ws.hellos()).toHaveLength(1)
    expect(listener).not.toHaveBeenCalled()
    expect(transport.getConnectionSnapshot()).toBe("connected")
    transport.destroy()
  })

  it("says hello again on every reconnect and hears the new answer", async () => {
    const { transport, ws } = connect()
    const listener = vi.fn()
    transport.onServerInfo(listener)
    ws.ready()
    await flush()
    ws.receive(SERVER_INFO)

    ws.drop()
    await vi.advanceTimersByTimeAsync(1_000)
    await flush()
    const next = MockWebSocket.instances[MockWebSocket.instances.length - 1]
    expect(next).not.toBe(ws)
    next.open()
    next.ready()
    await flush()
    expect(next.hellos()).toHaveLength(1)

    next.receive({ ...SERVER_INFO, min_desktop_version: "1.3.0" })
    expect(listener).toHaveBeenLastCalledWith({
      ...COMPAT,
      minDesktopVersion: "1.3.0",
    })
    transport.destroy()
  })
})

// ── RemoteDesktopTransport ──────────────────────────────────────────────────

describe("RemoteDesktopTransport hello", () => {
  let receive: (frame: unknown) => void

  beforeEach(() => {
    listenMock.mockImplementation(async (_event, handler) => {
      receive = (frame) => handler({ payload: frame })
      return () => {}
    })
  })

  function sent() {
    return invokeMock.mock.calls
      .filter(([command]) => command === "remote_ws_send_text")
      .map(([, args]) => JSON.parse(args!.text as string))
  }

  async function connect() {
    const transport = new RemoteDesktopTransport({
      id: 17,
      name: "Remote workspace",
      baseUrl: "http://remote.test:3210/",
      token: "test-token",
      windowInstanceId: "window-instance",
    })
    transport.eventStream()
    await flush()
    return transport
  }

  it("says hello through the proxy after __ready__, with the app's version", async () => {
    const transport = await connect()
    expect(sent()).toEqual([])
    receive({ channel: "__ready__", payload: null })
    await flush()
    expect(sent()).toEqual([
      {
        action: "hello",
        client: "codeg-desktop",
        version: "1.2.5",
        api_version: CLIENT_API_VERSION,
      },
    ])
    expect(
      invokeMock.mock.calls.find(([c]) => c === "remote_ws_send_text")![1]
    ).toMatchObject({ connectionId: 17 })
    transport.destroy()
  })

  it("hands server_info to its listeners, and forgets it on a drop", async () => {
    const transport = await connect()
    const listener = vi.fn()
    transport.onServerInfo(listener)
    receive({ channel: "__ready__", payload: null })
    await flush()
    receive(SERVER_INFO)
    expect(listener).toHaveBeenCalledWith(COMPAT)

    receive({ channel: "__disconnected__", payload: null })
    const late = vi.fn()
    transport.onServerInfo(late)
    expect(late).not.toHaveBeenCalled()

    receive({ channel: "__ready__", payload: null })
    await flush()
    expect(sent().filter((f) => f.action === "hello")).toHaveLength(2)
    transport.destroy()
  })

  it("a hello that fails to go out does not set off the attach retry", async () => {
    const transport = await connect()
    transport.eventStream().attach(
      "conn",
      {},
      {
        onSnapshot: vi.fn(),
        onReplay: vi.fn(),
        onEvent: vi.fn(),
        onDetached: vi.fn(),
      }
    )
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    invokeMock.mockImplementation(async (command, args) => {
      const text = String(args?.text ?? "")
      if (command === "remote_ws_send_text" && text.includes('"hello"')) {
        throw { code: "network_error" }
      }
    })
    receive({ channel: "__ready__", payload: null })
    await flush()
    await vi.advanceTimersByTimeAsync(500)
    // One attach (on ready); a failed attach would have been sent again.
    expect(sent().filter((f) => f.action === "attach")).toHaveLength(1)
    expect(sent().filter((f) => f.action === "hello")).toHaveLength(1)
    debug.mockRestore()
    transport.destroy()
  })
})
