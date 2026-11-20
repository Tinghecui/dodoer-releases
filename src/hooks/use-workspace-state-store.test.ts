import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest"
import { getWorkspaceStateStore } from "@/hooks/use-workspace-state-store"
import * as api from "@/lib/api"

// Token-set state machine for the per-root workspace stream store:
// full/paths subscription modes, upgrade/downgrade transitions against the
// backend, idempotent release, and the shutdown-grace lifecycle. Each test
// uses a unique root path — stores are module-level singletons.

vi.mock("@/lib/api", () => ({
  startWorkspaceStateStream: vi.fn(),
  stopWorkspaceStateStream: vi.fn(),
  getWorkspaceSnapshot: vi.fn(),
}))

// 测试里手动触发「连接重连上了」：收集注册进来的回调。
const reconnectCallbacks = new Set<() => void>()
const fireReconnect = () => {
  for (const callback of [...reconnectCallbacks]) callback()
}

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  onTransportReconnect: vi.fn((callback: () => void) => {
    reconnectCallbacks.add(callback)
    return () => {
      reconnectCallbacks.delete(callback)
    }
  }),
}))

const mockedApi = api as unknown as {
  startWorkspaceStateStream: Mock
  stopWorkspaceStateStream: Mock
  getWorkspaceSnapshot: Mock
}

function fullSnapshot(rootPath: string, seq = 0) {
  return {
    root_path: rootPath,
    seq,
    version: 1,
    full: true,
    tree_snapshot: [],
    git_snapshot: [],
    deltas: [],
    degraded: false,
    is_git_repo: true,
  }
}

// 某个根目录上的调用次数（别的测试留下的 store 也会调同一个 mock）。
const callsFor = (mock: Mock, rootPath: string) =>
  mock.mock.calls.filter((call) => call[0] === rootPath).length

// Drain resolved promises + due timers deterministically.
const drain = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  mockedApi.startWorkspaceStateStream.mockReset()
  mockedApi.stopWorkspaceStateStream.mockReset()
  mockedApi.getWorkspaceSnapshot.mockReset()
  mockedApi.startWorkspaceStateStream.mockImplementation((rootPath: string) =>
    Promise.resolve(fullSnapshot(rootPath))
  )
  mockedApi.stopWorkspaceStateStream.mockResolvedValue(undefined)
  mockedApi.getWorkspaceSnapshot.mockImplementation((rootPath: string) =>
    Promise.resolve(fullSnapshot(rootPath))
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe("workspace state store full/paths token machine", () => {
  it("registers a paths-only subscription without tree/git scanning", async () => {
    const store = getWorkspaceStateStore("/machine/t1")
    const token = store.acquire("paths")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t1",
      false
    )

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t1",
      false
    )
  })

  it("upgrades paths→full by adding the full ref BEFORE releasing the paths ref", async () => {
    const store = getWorkspaceStateStore("/machine/t2")
    const pathsToken = store.acquire("paths")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t2",
      false
    )

    const fullToken = store.acquire("full")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t2",
      true
    )
    // The old paths ref is released only after the full ref registered —
    // the backend refcount never touched zero (no teardown mid-upgrade).
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t2",
      false
    )
    const startOrder =
      mockedApi.startWorkspaceStateStream.mock.invocationCallOrder[1]
    const stopOrder =
      mockedApi.stopWorkspaceStateStream.mock.invocationCallOrder[0]
    expect(startOrder).toBeLessThan(stopOrder)

    store.release(fullToken)
    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("downgrades full→paths on last full release, keeping the stream alive", async () => {
    const store = getWorkspaceStateStore("/machine/t3")
    const fullToken = store.acquire("full")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      true
    )
    const pathsToken = store.acquire("paths")
    await drain()

    store.release(fullToken)
    await drain()

    // Transition: re-register as paths, release the full ref.
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      false
    )
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t3",
      true
    )

    // The stream survives: no shutdown while the paths token remains.
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)

    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(2)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      false
    )
  })

  it("treats a duplicate release as a no-op (StrictMode-safe)", async () => {
    const store = getWorkspaceStateStore("/machine/t4")
    const first = store.acquire("paths")
    const second = store.acquire("paths")
    await drain()

    store.release(first)
    store.release(first)
    store.release(first)
    await vi.advanceTimersByTimeAsync(700)

    // `second` still holds the stream — the duplicate releases must not
    // have driven the token count to zero.
    expect(mockedApi.stopWorkspaceStateStream).not.toHaveBeenCalled()

    store.release(second)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
  })

  it("re-acquiring within the shutdown grace reuses the stream and resyncs", async () => {
    const store = getWorkspaceStateStore("/machine/t5")
    const token = store.acquire("paths")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    const snapshotCallsAfterStart =
      mockedApi.getWorkspaceSnapshot.mock.calls.length

    store.release(token)
    await vi.advanceTimersByTimeAsync(300)

    const token2 = store.acquire("paths")
    await vi.advanceTimersByTimeAsync(700)

    // No stop, no second start — the grace window kept the stream.
    expect(mockedApi.stopWorkspaceStateStream).not.toHaveBeenCalled()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    // Events during the ref-less window may have been dropped — the store
    // must pull a catch-up snapshot.
    expect(mockedApi.getWorkspaceSnapshot.mock.calls.length).toBeGreaterThan(
      snapshotCallsAfterStart
    )

    store.release(token2)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("reconciles a full token acquired while the initial paths start is in flight", async () => {
    let resolveStart: ((value: unknown) => void) | null = null
    mockedApi.startWorkspaceStateStream.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStart = resolve))
    )

    const store = getWorkspaceStateStore("/machine/t6")
    const pathsToken = store.acquire("paths")
    // Start call is pending; a full subscriber joins meanwhile.
    const fullToken = store.acquire("full")

    resolveStart!(fullSnapshot("/machine/t6"))
    await drain()
    await drain()

    // The post-start reconciliation upgraded the subscription to full.
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t6",
      true
    )
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t6",
      false
    )

    store.release(fullToken)
    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
  })
})

describe("workspace state store error text", () => {
  // 网页模式下非 2xx 时 throw 的是解析好的错误体（如 `{ error: "..." }`），
  // 不能 String() 成「[object Object]」给文件树、Git 变更页签看（#543）。
  it("takes the text out of an error body when the catch-up snapshot fails", async () => {
    mockedApi.getWorkspaceSnapshot.mockRejectedValue({ error: "boom" })
    const store = getWorkspaceStateStore("/machine/err1")
    const token = store.acquire("full")
    await drain()

    const state = store.getSnapshot()
    expect(state.health).toBe("degraded")
    expect(state.error).toBe("boom")

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
  })
})

describe("workspace state store after the backend restarts", () => {
  // 本机服务（或远端服务）重启以后，新进程里没有这个根目录的流（#1114）。
  const notRunning = () =>
    Promise.reject({
      code: "not_found",
      message: "Workspace stream is not running for this root",
    })

  it("re-registers the stream when a resync finds it gone", async () => {
    const store = getWorkspaceStateStore("/machine/restart1")
    const token = store.acquire("full")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)

    // 服务重启：第一次补拉找不到流，重新注册以后就正常了。
    mockedApi.getWorkspaceSnapshot.mockImplementationOnce(notRunning)
    await store.requestResync("manual_refresh")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(2)
    const state = store.getSnapshot()
    expect(state.health).toBe("healthy")
    expect(state.error).toBeNull()

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
  })

  // 假的后端：跟真后端一样，一个根目录一条流、所有窗口共用一个引用计数；
  // kill() 模拟服务进程被杀、拉起一个空的新进程。
  function fakeBackend(rootPath: string) {
    let nextId = 0
    let stream: { id: string; refs: number } | null = null
    const snapshot = () => ({
      ...fullSnapshot(rootPath),
      stream_id: stream!.id,
    })
    // 只管这个根目录；别的测试留下的 store 照默认的走，互不干扰。
    mockedApi.startWorkspaceStateStream.mockImplementation((root: string) => {
      if (root !== rootPath) return Promise.resolve(fullSnapshot(root))
      if (!stream) {
        nextId += 1
        stream = { id: `stream-${nextId}`, refs: 0 }
      }
      stream.refs += 1
      return Promise.resolve(snapshot())
    })
    mockedApi.stopWorkspaceStateStream.mockImplementation((root: string) => {
      if (root === rootPath && stream) {
        stream.refs -= 1
        if (stream.refs <= 0) stream = null
      }
      return Promise.resolve(undefined)
    })
    mockedApi.getWorkspaceSnapshot.mockImplementation((root: string) => {
      if (root !== rootPath) return Promise.resolve(fullSnapshot(root))
      return stream ? Promise.resolve(snapshot()) : notRunning()
    })
    return {
      kill: () => {
        stream = null
      },
      // 另一个窗口在新进程里登记了一次。
      otherWindowStarts: () => {
        void api.startWorkspaceStateStream(rootPath, true)
      },
      refs: () => stream?.refs ?? 0,
    }
  }

  it("re-registers on reconnect only while held, without stopping first", async () => {
    const backend = fakeBackend("/machine/restart2")
    const held = getWorkspaceStateStore("/machine/restart2")
    const token = held.acquire("full")
    await drain()

    const idle = getWorkspaceStateStore("/machine/restart3")
    const idleToken = idle.acquire("full")
    await drain()
    idle.release(idleToken)
    await vi.advanceTimersByTimeAsync(700)

    backend.kill()
    mockedApi.startWorkspaceStateStream.mockClear()
    mockedApi.stopWorkspaceStateStream.mockClear()
    fireReconnect()
    await drain()
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/restart2",
      true
    )
    expect(
      callsFor(mockedApi.stopWorkspaceStateStream, "/machine/restart2")
    ).toBe(0)
    expect(backend.refs()).toBe(1)
    expect(held.getSnapshot().health).toBe("healthy")

    held.release(token)
    await vi.advanceTimersByTimeAsync(700)
    expect(backend.refs()).toBe(0)
  })

  it("keeps another window's registration when it re-registers first", async () => {
    // 审查员指出的情形：两个窗口看同一个项目，服务重启后另一个窗口先重连、
    // 先在新进程里登记；这个窗口重连时不能把它的登记停掉。
    const backend = fakeBackend("/machine/restart5")
    const store = getWorkspaceStateStore("/machine/restart5")
    const token = store.acquire("full")
    await drain()

    backend.kill()
    backend.otherWindowStarts()
    await drain()
    expect(backend.refs()).toBe(1)

    fireReconnect()
    await drain()
    await drain()

    // 两个窗口各一份登记；这个窗口关掉以后另一个窗口的流还在。
    expect(backend.refs()).toBe(2)
    expect(store.getSnapshot().health).toBe("healthy")
    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
    expect(backend.refs()).toBe(1)
  })

  it("only resyncs on reconnect when its registration survived", async () => {
    // 只是网络断了一下、服务没重启：流还是原来那条，不用重新登记。
    const backend = fakeBackend("/machine/restart6")
    const store = getWorkspaceStateStore("/machine/restart6")
    const token = store.acquire("full")
    await drain()

    mockedApi.startWorkspaceStateStream.mockClear()
    mockedApi.stopWorkspaceStateStream.mockClear()
    mockedApi.getWorkspaceSnapshot.mockClear()
    fireReconnect()
    await drain()
    await drain()

    const root = "/machine/restart6"
    expect(callsFor(mockedApi.getWorkspaceSnapshot, root)).toBe(1)
    expect(callsFor(mockedApi.startWorkspaceStateStream, root)).toBe(0)
    expect(callsFor(mockedApi.stopWorkspaceStateStream, root)).toBe(0)
    expect(backend.refs()).toBe(1)
    expect(store.getSnapshot().health).toBe("healthy")

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
    expect(backend.refs()).toBe(0)
  })

  it("does not loop when the stream cannot be re-registered", async () => {
    const store = getWorkspaceStateStore("/machine/restart4")
    const token = store.acquire("full")
    await drain()

    mockedApi.startWorkspaceStateStream.mockClear()
    mockedApi.getWorkspaceSnapshot.mockImplementation(notRunning)
    mockedApi.startWorkspaceStateStream.mockImplementation(notRunning)
    await store.requestResync("manual_refresh")
    await vi.advanceTimersByTimeAsync(5_000)

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().health).toBe("degraded")

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
  })
})
