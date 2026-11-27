import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  remoteId: null as number | null,
  desktop: false,
  label: "main",
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.remoteId,
  isDesktop: () => h.desktop,
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => h.label,
}))

import type { QueuedMessage } from "@/hooks/use-message-queue"
import {
  CLAIM_SETTLE_MS,
  CLAIM_STALE_MS,
  acquireStoredQueue,
  MAX_STORED_CHARS,
  canClaimStoredQueue,
  claimStoredQueue,
  draftMessageQueueStorageKey,
  hasStoredQueue,
  messageQueueStorageKey,
  readStoredQueue,
  releaseStoredQueue,
  storedQueuesVersion,
  subscribeStoredQueues,
  writeStoredQueue,
} from "./message-queue-storage"

function item(text: string, extra: Partial<QueuedMessage> = {}): QueuedMessage {
  return {
    id: `id-${text}`,
    draft: { blocks: [{ type: "text", text }], displayText: text },
    modeId: null,
    ...extra,
  }
}

beforeEach(() => {
  h.remoteId = null
  h.desktop = false
  h.label = "main"
  window.sessionStorage.clear()
  window.localStorage.clear()
})

describe("messageQueueStorageKey", () => {
  it("is per conversation and per backend", () => {
    expect(messageQueueStorageKey(7)).toBe("cowork:message-queue:v1:local:7")
    h.remoteId = 3
    expect(messageQueueStorageKey(7)).toBe("cowork:message-queue:v1:remote-3:7")
  })
})

// #650：还没建会话的草稿按标签存，刷新回来草稿标签还在，排队的消息也在。
describe("draftMessageQueueStorageKey", () => {
  it("is per draft tab and per backend, apart from conversation keys", () => {
    expect(draftMessageQueueStorageKey("tab-a")).toBe(
      "cowork:message-queue:v1:local:draft-tab-a"
    )
    h.remoteId = 3
    expect(draftMessageQueueStorageKey("tab-a")).toBe(
      "cowork:message-queue:v1:remote-3:draft-tab-a"
    )
  })
})

describe("read / write", () => {
  const KEY = "cowork:message-queue:v1:local:1"

  it("reads every item back failed, keeping a credentials failure as such", () => {
    writeStoredQueue(KEY, [
      item("a", { failed: true, failure: "auth" }),
      item("b", { modeId: "plan" }),
      item("c", { adoptSendTimeMode: true }),
    ])
    expect(readStoredQueue(KEY)).toEqual([
      { ...item("a"), failed: true, failure: "auth" },
      { ...item("b", { modeId: "plan" }), failed: true, failure: "restored" },
      {
        ...item("c", { adoptSendTimeMode: true }),
        failed: true,
        failure: "restored",
      },
    ])
  })

  it("keeps a turn that failed after it was sent as such (#424)", () => {
    writeStoredQueue(KEY, [
      item("a", { failed: true, failure: "turn_failed" }),
      item("b"),
    ])
    expect(readStoredQueue(KEY)).toEqual([
      { ...item("a"), failed: true, failure: "turn_failed" },
      { ...item("b"), failed: true, failure: "restored" },
    ])
  })

  // #1640：连接失败标成失败的那条，切走再切回来（面板重新挂载、从存储读回）
  // 不能变成「页面刷新时还没发出去」。
  it("keeps a message whose send failed as such", () => {
    writeStoredQueue(KEY, [
      item("a", { failed: true, failure: "send_failed" }),
      item("b"),
    ])
    expect(readStoredQueue(KEY)).toEqual([
      { ...item("a"), failed: true, failure: "send_failed" },
      { ...item("b"), failed: true, failure: "restored" },
    ])
  })

  it("still reads an untyped failure from older data as restored", () => {
    writeStoredQueue(KEY, [item("a", { failed: true })])
    expect(readStoredQueue(KEY)).toEqual([
      { ...item("a"), failed: true, failure: "restored" },
    ])
  })

  it("removes the entry once the queue is empty", () => {
    writeStoredQueue(KEY, [item("a")])
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
    writeStoredQueue(KEY, [])
    expect(window.localStorage.getItem(KEY)).toBeNull()
  })

  it("keeps the first items that fit, in order", () => {
    // The text is stored three times (id, block, display text): 3/7 of the
    // cap per item, so two fit.
    const big = "x".repeat(Math.floor(MAX_STORED_CHARS / 7))
    writeStoredQueue(KEY, [
      item("a"),
      item(`1${big}`),
      item(`2${big}`),
      item(`3${big}`),
      item("e"),
    ])
    expect(readStoredQueue(KEY).map((i) => i.id.slice(0, 4))).toEqual([
      "id-a",
      "id-1",
      "id-2",
    ])
  })

  it("reads anything unreadable as an empty queue", () => {
    window.localStorage.setItem(KEY, "{not json")
    expect(readStoredQueue(KEY)).toEqual([])
    window.localStorage.setItem(
      KEY,
      JSON.stringify([{ id: "x", draft: { blocks: "nope" } }, 5, null])
    )
    expect(readStoredQueue(KEY)).toEqual([])
    expect(readStoredQueue("cowork:message-queue:v1:local:404")).toEqual([])
  })
})

// dodoer #276/#416: the copy used to live in sessionStorage, which a new app session
// (quit, crash, "Restart to update") starts empty.
describe("across an app restart", () => {
  const KEY = "cowork:message-queue:v1:local:1"

  it("reads the queue back after sessionStorage starts empty, still failed", () => {
    writeStoredQueue(KEY, [item("a")])
    const before = readStoredQueue(KEY).length
    window.sessionStorage.clear()
    expect([before, readStoredQueue(KEY).length]).toEqual([1, 1])
    expect(readStoredQueue(KEY)[0]).toMatchObject({
      failed: true,
      failure: "restored",
    })
  })

  it("the same desktop window takes its claim back at once", () => {
    h.desktop = true
    expect(claimStoredQueue(KEY)).toBe(true)
    // A restart: new session, same window label, the old claim still fresh.
    window.sessionStorage.clear()
    expect(canClaimStoredQueue(KEY)).toBe(true)
    expect(claimStoredQueue(KEY)).toBe(true)
  })
})

describe("one window per stored queue", () => {
  const KEY = "cowork:message-queue:v1:local:1"
  const claimBy = (owner: string, at: number) =>
    window.localStorage.setItem(`${KEY}:claim`, JSON.stringify({ owner, at }))

  it("a second window does not get a queue another window holds", () => {
    claimBy("tab:first", Date.now())
    expect(canClaimStoredQueue(KEY)).toBe(false)
    expect(claimStoredQueue(KEY)).toBe(false)
    h.desktop = true
    h.label = "remote-workspace-3"
    claimBy("window:main", Date.now())
    expect(claimStoredQueue(KEY)).toBe(false)
  })

  it("takes a claim its window stopped refreshing", () => {
    const now = Date.now()
    claimBy("tab:crashed", now - CLAIM_STALE_MS)
    expect(claimStoredQueue(KEY, now)).toBe(true)
    expect(
      JSON.parse(window.localStorage.getItem(`${KEY}:claim`)!).owner
    ).toMatch(/^page:/)
  })

  it("lets its own claim go on release and when the page hides", () => {
    expect(claimStoredQueue(KEY)).toBe(true)
    releaseStoredQueue(KEY)
    expect(window.localStorage.getItem(`${KEY}:claim`)).toBeNull()

    expect(claimStoredQueue(KEY)).toBe(true)
    window.dispatchEvent(new Event("pagehide"))
    expect(window.localStorage.getItem(`${KEY}:claim`)).toBeNull()
  })

  it("never releases another window's claim", () => {
    claimBy("tab:first", Date.now())
    releaseStoredQueue(KEY)
    expect(window.localStorage.getItem(`${KEY}:claim`)).not.toBeNull()
  })
})

describe("acquireStoredQueue", () => {
  const KEY = "cowork:message-queue:v1:local:1"

  // Another page of the same origin: its own copy of the module (its own
  // page id), the same storage. A duplicated tab is one: it starts with a
  // copy of this page's sessionStorage.
  async function otherPage() {
    vi.resetModules()
    return import("./message-queue-storage")
  }

  it("confirms an uncontested claim", async () => {
    await expect(acquireStoredQueue(KEY)).resolves.toBe(true)
  })

  it("two pages claiming at once: exactly one gets it", async () => {
    const other = await otherPage()
    const results = await Promise.all([
      acquireStoredQueue(KEY),
      other.acquireStoredQueue(KEY),
    ])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("a claim another page writes before it settles is not confirmed", async () => {
    vi.useFakeTimers()
    try {
      const mine = acquireStoredQueue(KEY)
      window.localStorage.setItem(
        `${KEY}:claim`,
        JSON.stringify({ owner: "page:other", at: Date.now() })
      )
      await vi.advanceTimersByTimeAsync(CLAIM_SETTLE_MS)
      await expect(mine).resolves.toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("a duplicated tab (same sessionStorage) is another owner", async () => {
    await expect(acquireStoredQueue(KEY)).resolves.toBe(true)
    const duplicate = await otherPage()
    expect(duplicate.canClaimStoredQueue(KEY)).toBe(false)
    await expect(duplicate.acquireStoredQueue(KEY)).resolves.toBe(false)
  })
})

// #650 第 11 次返工（收件箱 #716 的 P2）：只有失败排队消息的会话要排在侧栏
// 前面，侧栏得知道哪些会话存着排队消息，存的东西变了要重排。
describe("hasStoredQueue", () => {
  beforeEach(() => localStorage.clear())

  it("tells which conversations keep queued messages", () => {
    expect(hasStoredQueue(31)).toBe(false)
    writeStoredQueue(messageQueueStorageKey(31), [item("A")])
    expect(hasStoredQueue(31)).toBe(true)
    expect(hasStoredQueue(32)).toBe(false)
    writeStoredQueue(messageQueueStorageKey(31), [])
    expect(hasStoredQueue(31)).toBe(false)
  })

  it("tells the subscribers each time a stored queue changes", () => {
    const seen = vi.fn()
    const stop = subscribeStoredQueues(seen)
    const before = storedQueuesVersion()
    writeStoredQueue(messageQueueStorageKey(31), [item("A")])
    expect(seen).toHaveBeenCalledTimes(1)
    expect(storedQueuesVersion()).not.toBe(before)
    stop()
    writeStoredQueue(messageQueueStorageKey(31), [])
    expect(seen).toHaveBeenCalledTimes(1)
  })
})
