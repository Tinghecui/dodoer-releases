import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// #870：请求体已经全部发出去以后再取消，服务端照样会写盘，abort 撤不回；
// 这时不能再 abort XHR，要按服务端的响应结束。
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
  getShellTransport: () => ({ call: vi.fn() }),
  getTransport: () => ({ call: vi.fn() }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import { uploadWorkspaceFile } from "./api"

class FakeXhr {
  static last: FakeXhr | null = null
  status = 0
  responseText = ""
  upload: {
    onprogress: ((e: ProgressEvent) => void) | null
    onload: (() => void) | null
  } = { onprogress: null, onload: null }
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  private listeners: Record<string, Array<() => void>> = {}
  abort = vi.fn(() => {
    this.onabort?.()
    this.fire("loadend")
  })
  constructor() {
    FakeXhr.last = this
  }
  open() {}
  setRequestHeader() {}
  getResponseHeader() {
    return null
  }
  send() {}
  addEventListener(name: string, fn: () => void) {
    ;(this.listeners[name] ??= []).push(fn)
  }
  fire(name: string) {
    for (const fn of this.listeners[name] ?? []) fn()
  }
  respond(status: number, body: unknown) {
    this.status = status
    this.responseText = JSON.stringify(body)
    this.onload?.()
    this.fire("loadend")
  }
}

function start(signal: AbortSignal) {
  return uploadWorkspaceFile({
    rootPath: "/tmp/demo-root",
    targetPath: "demo",
    file: new File(["abcdef"], "six.txt"),
    signal,
  })
}

describe("uploadWorkspaceFile 取消", () => {
  const original = globalThis.XMLHttpRequest
  beforeEach(() => {
    FakeXhr.last = null
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest
  })
  afterEach(() => {
    globalThis.XMLHttpRequest = original
  })

  it("请求体发完以后取消不再 abort，按服务端响应完成", async () => {
    const controller = new AbortController()
    const p = start(controller.signal)
    const xhr = FakeXhr.last!
    xhr.upload.onload?.()
    controller.abort()
    expect(xhr.abort).not.toHaveBeenCalled()
    xhr.respond(200, { path: "demo/six.txt" })
    await expect(p).resolves.toEqual({ path: "demo/six.txt" })
  })

  it("请求体还没发完时取消照样 abort", async () => {
    const controller = new AbortController()
    const p = start(controller.signal)
    const xhr = FakeXhr.last!
    controller.abort()
    expect(xhr.abort).toHaveBeenCalledTimes(1)
    await expect(p).rejects.toMatchObject({ name: "AbortError" })
  })
})
