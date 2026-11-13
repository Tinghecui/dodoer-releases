import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ remoteId: null as number | null }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => h.remoteId,
}))

import type { QueuedMessage } from "@/hooks/use-message-queue"
import {
  MAX_STORED_CHARS,
  messageQueueStorageKey,
  readStoredQueue,
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
  window.sessionStorage.clear()
})

describe("messageQueueStorageKey", () => {
  it("is per conversation and per backend", () => {
    expect(messageQueueStorageKey(7)).toBe("cowork:message-queue:v1:local:7")
    h.remoteId = 3
    expect(messageQueueStorageKey(7)).toBe("cowork:message-queue:v1:remote-3:7")
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

  it("removes the entry once the queue is empty", () => {
    writeStoredQueue(KEY, [item("a")])
    expect(window.sessionStorage.getItem(KEY)).not.toBeNull()
    writeStoredQueue(KEY, [])
    expect(window.sessionStorage.getItem(KEY)).toBeNull()
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
    window.sessionStorage.setItem(KEY, "{not json")
    expect(readStoredQueue(KEY)).toEqual([])
    window.sessionStorage.setItem(
      KEY,
      JSON.stringify([{ id: "x", draft: { blocks: "nope" } }, 5, null])
    )
    expect(readStoredQueue(KEY)).toEqual([])
    expect(readStoredQueue("cowork:message-queue:v1:local:404")).toEqual([])
  })
})
