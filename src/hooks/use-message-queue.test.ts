import { beforeEach, describe, it, expect } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useMessageQueue } from "./use-message-queue"
import type { PromptDraft } from "@/lib/types"
import { CLAIM_SETTLE_MS } from "@/lib/cowork/message-queue-storage"

/** Wait out the claim confirmation (`acquireStoredQueue`). */
const settle = () =>
  act(() => new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS * 2)))

function draft(text: string): PromptDraft {
  return { blocks: [{ type: "text", text }], displayText: text }
}

function texts(q: { draft: PromptDraft }[]): string[] {
  return q.map((item) => item.draft.displayText)
}

describe("useMessageQueue bounce FIFO ordering", () => {
  it("prioritizes a clicked item using its latest draft and mode without dropping new items", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), null)
      result.current.enqueue(draft("B"), "plan", { adoptSendTimeMode: true })
    })
    const target = result.current.queue[1]
    act(() => {
      result.current.updateItem(target.id, draft("edited B"))
      result.current.enqueue(draft("C"), "agent")
      result.current.moveToFront(target.id)
    })
    expect(texts(result.current.queue)).toEqual(["edited B", "A", "C"])
    expect(result.current.queue[0]).toMatchObject({
      id: target.id,
      modeId: "plan",
      adoptSendTimeMode: true,
    })
    let sent: ReturnType<typeof result.current.dequeue>
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent).toEqual({
      ...target,
      draft: draft("edited B"),
    })
  })

  it("does not resurrect a removed item when an insertion reply arrives late", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), null)
      result.current.enqueue(draft("B"), null)
    })
    const target = result.current.queue[1]
    act(() => {
      result.current.remove(target.id)
      result.current.moveToFront(target.id)
    })
    expect(texts(result.current.queue)).toEqual(["A"])
  })

  it("requeueFront keeps a bounced head ahead of items behind it", () => {
    const { result } = renderHook(() => useMessageQueue())

    // Queue [A, B].
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])

    // The auto-flush dequeues the head (A) and sends it.
    let dequeued: ReturnType<typeof result.current.dequeue>
    act(() => {
      dequeued = result.current.dequeue()
    })
    expect(dequeued?.draft.displayText).toBe("A")
    expect(texts(result.current.queue)).toEqual(["B"])

    // A bounces (TurnBusyError) → re-queued at the FRONT, NOT the tail, so it
    // retries before B. (Re-enqueuing at the tail here would yield [B, A] and
    // send B before A — the FIFO regression this guards against.)
    act(() => result.current.requeueFront(draft("A"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])

    // The next flush therefore dequeues A again, not B.
    act(() => {
      dequeued = result.current.dequeue()
    })
    expect(dequeued?.draft.displayText).toBe("A")
  })

  it("enqueue still appends to the tail (front vs tail are distinct)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("tail"), null))
    act(() => result.current.requeueFront(draft("front"), null))
    expect(texts(result.current.queue)).toEqual(["front", "A", "tail"])
  })

  it("getQueueLength reflects mutations SYNCHRONOUSLY (same tick, before re-render)", () => {
    const { result } = renderHook(() => useMessageQueue())
    // Multiple mutations within a single act() — getQueueLength must observe
    // each one immediately, without waiting for a React commit. This is what
    // the direct-send routing relies on: a draft re-queued by a same-tick
    // bounce must be visible before the next send decides whether to tail-route.
    act(() => {
      expect(result.current.getQueueLength()).toBe(0)
      result.current.enqueue(draft("A"), null)
      expect(result.current.getQueueLength()).toBe(1)
      result.current.requeueFront(draft("B"), null)
      expect(result.current.getQueueLength()).toBe(2)
      result.current.dequeue()
      expect(result.current.getQueueLength()).toBe(1)
    })
    // After commit the rendered queue matches the authoritative ref.
    expect(texts(result.current.queue)).toEqual(["A"])
    expect(result.current.getQueueLength()).toBe(1)
  })

  it("applies a valid reorder (a permutation of the live queue)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A"])
  })

  it("ignores a STALE reorder whose id set no longer matches (no resurrect/drop)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const stale = [...result.current.queue].reverse() // snapshot of [A, B] → [B, A]
    // The queue changes (A dequeued) AFTER the drag snapshot was taken.
    act(() => result.current.dequeue())
    expect(texts(result.current.queue)).toEqual(["B"])
    // Applying the stale [B, A] order would resurrect A — it must be ignored.
    act(() => result.current.reorder(stale))
    expect(texts(result.current.queue)).toEqual(["B"])
  })

  it("ignores a reorder containing a duplicate id (would drop another item)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a] = result.current.queue
    // [A, A] matches length + membership but is NOT a permutation — applying it
    // would duplicate A and drop B. Must be ignored.
    act(() => result.current.reorder([a, a]))
    expect(texts(result.current.queue)).toEqual(["A", "B"])
  })

  it("reorders the AUTHORITATIVE items, not the caller's stale objects", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    act(() => result.current.enqueue(draft("B"), null))
    const [a, b] = result.current.queue
    // A is edited AFTER the drag snapshot [a, b] was captured.
    act(() => result.current.updateItem(a.id, draft("A-edited")))
    // The stale reorder carries the OLD `a` object (draft "A"); the commit must
    // use the authoritative edited A (by id), only applying the requested order.
    act(() => result.current.reorder([b, a]))
    expect(texts(result.current.queue)).toEqual(["B", "A-edited"])
  })

  // jenny fork: a send that failed after it went out.
  it("holds a failed head until it is retried, keeping the order", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("B"), null))
    act(() => result.current.requeueFailed(draft("A"), null))
    expect(texts(result.current.queue)).toEqual(["A", "B"])
    expect(result.current.queue[0].failed).toBe(true)
    let next: ReturnType<typeof result.current.dequeue>
    act(() => {
      next = result.current.dequeue()
    })
    expect(next!).toBeUndefined()
    expect(texts(result.current.queue)).toEqual(["A", "B"])
    act(() => result.current.retry(result.current.queue[0].id))
    expect(result.current.queue[0].failed).toBe(false)
    act(() => {
      next = result.current.dequeue()
    })
    expect(next!.draft.displayText).toBe("A")
    expect(texts(result.current.queue)).toEqual(["B"])
  })
})

// Cowork fork: a message that never went out and, as things are, never will
// (no usable agent, its worktree could not be created).
describe("useMessageQueue failHead", () => {
  it("flags the head failed where it stands, keeping its id and the order", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), "plan", { adoptSendTimeMode: true })
      result.current.enqueue(draft("B"), null)
    })
    const [a, b] = result.current.queue
    act(() => result.current.failHead())
    expect(texts(result.current.queue)).toEqual(["A", "B"])
    expect(result.current.queue[0]).toEqual({ ...a, failed: true })
    // The item behind it is untouched — it just waits, like behind any failed
    // head.
    expect(result.current.queue[1]).toBe(b)
    let next: ReturnType<typeof result.current.dequeue>
    act(() => {
      next = result.current.dequeue()
    })
    expect(next!).toBeUndefined()
    expect(result.current.getQueueLength()).toBe(2)
  })

  it("is sendable again after retry, with what the item had before", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), "plan"))
    const id = result.current.queue[0].id
    act(() => result.current.failHead())
    act(() => result.current.retry(id))
    let next: ReturnType<typeof result.current.dequeue>
    act(() => {
      next = result.current.dequeue()
    })
    expect(next!).toMatchObject({ id, modeId: "plan", failed: false })
    expect(next!.draft.displayText).toBe("A")
    expect(result.current.queue).toEqual([])
  })

  it("does nothing on an empty queue or an already failed head", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.failHead())
    expect(result.current.queue).toEqual([])

    act(() => result.current.requeueFailed(draft("A"), null, "auth"))
    const before = result.current.queue
    act(() => result.current.failHead())
    // Same array: no state change, and the recorded kind is not wiped.
    expect(result.current.queue).toBe(before)
    expect(result.current.queue[0].failure).toBe("auth")
  })

  it("only ever touches the head", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), null)
      result.current.enqueue(draft("B"), null)
    })
    act(() => result.current.failHead())
    act(() => result.current.failHead())
    expect(result.current.queue.map((item) => item.failed === true)).toEqual([
      true,
      false,
    ])
  })
})

describe("useMessageQueue failure kind", () => {
  it("records why a send failed and forgets it on retry", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.requeueFailed(draft("A"), null, "auth"))
    expect(result.current.queue[0]).toMatchObject({
      failed: true,
      failure: "auth",
    })
    act(() => result.current.retry(result.current.queue[0].id))
    expect(result.current.queue[0].failed).toBe(false)
    expect(result.current.queue[0].failure).toBeUndefined()
  })

  it("leaves the kind off when none is given", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.requeueFailed(draft("A"), null))
    expect("failure" in result.current.queue[0]).toBe(false)
    act(() => result.current.enqueue(draft("B"), null))
    act(() => result.current.remove(result.current.queue[0].id))
    act(() => result.current.failHead("auth"))
    expect(result.current.queue[0]).toMatchObject({
      failed: true,
      failure: "auth",
    })
  })
})

// Cowork fork (AI QA #159): a reload used to drop the whole queue, and an
// app restart still did (dodoer #416). What is stored comes back once the
// claim on it is confirmed (`CLAIM_SETTLE_MS` later).
describe("useMessageQueue across a reload", () => {
  const KEY = "cowork:message-queue:v1:local:42"

  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  async function storedABC() {
    const first = renderHook(() => useMessageQueue(KEY))
    await settle()
    act(() => {
      first.result.current.requeueFailed(draft("A"), null, "auth")
      first.result.current.enqueue(draft("B"), null)
      first.result.current.enqueue(draft("C"), "plan")
    })
    first.unmount()
  }

  it("reads the queue back after a remount, all failed, and sends nothing on its own", async () => {
    await storedABC()
    const { result, unmount } = renderHook(() => useMessageQueue(KEY))
    // Nothing before the claim is confirmed.
    expect(result.current.queue).toEqual([])
    await settle()
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue.every((item) => item.failed)).toBe(true)
    expect(result.current.queue.map((item) => item.failure)).toEqual([
      "auth",
      "restored",
      "restored",
    ])
    expect(result.current.queue[2].modeId).toBe("plan")
    // Nothing leaves until the user retries it.
    let sent: ReturnType<typeof result.current.dequeue>
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent!).toBeUndefined()
    act(() => result.current.retry(result.current.queue[0].id))
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent!.draft.displayText).toBe("A")
    // The next one still waits for its own retry.
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent!).toBeUndefined()
    unmount()
  })

  it("reads the queue back after an app restart (sessionStorage empty)", async () => {
    await storedABC()
    window.sessionStorage.clear()
    const { result, unmount } = renderHook(() => useMessageQueue(KEY))
    await settle()
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue[1].failure).toBe("restored")
    unmount()
  })

  it("puts what comes back in front of what was queued meanwhile", async () => {
    await storedABC()
    const { result, unmount } = renderHook(() => useMessageQueue(KEY))
    act(() => result.current.enqueue(draft("D"), null))
    await settle()
    expect(texts(result.current.queue)).toEqual(["A", "B", "C", "D"])
    expect(window.localStorage.getItem(KEY)).toContain('"displayText":"D"')
    unmount()
  })

  it("forgets the stored queue once it is empty", async () => {
    const { result, unmount } = renderHook(() => useMessageQueue(KEY))
    await settle()
    act(() => result.current.enqueue(draft("A"), null))
    expect(window.localStorage.getItem(KEY)).not.toBeNull()
    act(() => {
      result.current.dequeue()
    })
    expect(window.localStorage.getItem(KEY)).toBeNull()
    unmount()
  })

  it("stores nothing without a key (a draft not saved yet)", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => result.current.enqueue(draft("A"), null))
    expect(window.localStorage.length).toBe(0)
  })

  it("starts storing once the key arrives", async () => {
    const { result, rerender, unmount } = renderHook(
      ({ storageKey }: { storageKey: string | null }) =>
        useMessageQueue(storageKey),
      { initialProps: { storageKey: null as string | null } }
    )
    act(() => result.current.enqueue(draft("A"), null))
    rerender({ storageKey: KEY })
    await settle()
    expect(window.localStorage.getItem(KEY)).toContain('"displayText":"A"')
    expect(texts(result.current.queue)).toEqual(["A"])
    unmount()
  })

  it("a second window neither shows nor overwrites the first one's queue", async () => {
    await storedABC()
    // Another window holds the claim (it is still open).
    window.localStorage.setItem(
      `${KEY}:claim`,
      JSON.stringify({ owner: "page:other-window", at: Date.now() })
    )
    const second = renderHook(() => useMessageQueue(KEY))
    await settle()
    expect(second.result.current.queue).toEqual([])
    act(() => second.result.current.enqueue(draft("D"), null))
    expect(window.localStorage.getItem(KEY)).toContain('"displayText":"A"')
    expect(window.localStorage.getItem(KEY)).not.toContain('"displayText":"D"')
    second.unmount()
  })

  it("losing the claim drops the copies read back and stops the mirror", async () => {
    await storedABC()
    const { result, unmount } = renderHook(() => useMessageQueue(KEY))
    await settle()
    act(() => result.current.retry(result.current.queue[0].id))
    // Another window took the claim over (this one stopped refreshing it).
    window.localStorage.setItem(
      `${KEY}:claim`,
      JSON.stringify({ owner: "page:other-window", at: Date.now() })
    )
    act(() => result.current.enqueue(draft("D"), null))
    // A, retried here, stays; B and C, untouched, are the other window's —
    // whatever their failure kind (A came back as "auth").
    expect(texts(result.current.queue)).toEqual(["A", "D"])
    expect(window.localStorage.getItem(KEY)).not.toContain('"displayText":"D"')
    unmount()
  })
})

// Cowork fork: "Retry all" after a reload left several rows failed.
describe("useMessageQueue retryAll", () => {
  it("clears every failed item in one go, keeping order and ids", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("B"), null)
      result.current.enqueue(draft("C"), null)
    })
    act(() => result.current.failHead())
    act(() => result.current.requeueFailed(draft("A"), null, "auth"))
    const before = result.current.queue
    expect(before.map((item) => item.failed === true)).toEqual([
      true,
      true,
      false,
    ])
    let cleared = -1
    act(() => {
      cleared = result.current.retryAll()
    })
    expect(cleared).toBe(2)
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue.map((item) => item.id)).toEqual(
      before.map((item) => item.id)
    )
    expect(result.current.queue.every((item) => !item.failed)).toBe(true)
    expect(result.current.queue.every((item) => !item.failure)).toBe(true)
    // The row that was not failed is the same object.
    expect(result.current.queue[2]).toBe(before[2])
  })

  it("leaves the item under edit failed", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.requeueFailed(draft("B"), null)
      result.current.requeueFailed(draft("A"), null, "auth")
    })
    const [a, b] = result.current.queue
    act(() => result.current.startEditing(a.id))
    let cleared = -1
    act(() => {
      cleared = result.current.retryAll()
    })
    expect(cleared).toBe(1)
    expect(result.current.queue[0]).toBe(a)
    expect(result.current.queue[0]).toMatchObject({
      failed: true,
      failure: "auth",
    })
    expect(result.current.queue[1]).toMatchObject({ id: b.id, failed: false })
  })

  it("does nothing the second time in the same tick", () => {
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.requeueFailed(draft("B"), null)
      result.current.requeueFailed(draft("A"), null)
    })
    let first = -1
    let second = -1
    let afterFirst: typeof result.current.queue = []
    act(() => {
      first = result.current.retryAll()
      second = result.current.retryAll()
    })
    afterFirst = result.current.queue
    expect(first).toBe(2)
    expect(second).toBe(0)
    act(() => {
      second = result.current.retryAll()
    })
    expect(second).toBe(0)
    expect(result.current.queue).toBe(afterFirst)
  })

  it("keeps failed rows in send order across a reload, a retry and a second failure", async () => {
    window.localStorage.clear()
    const KEY = "cowork:message-queue:v1:local:retry-all"
    const first = renderHook(() => useMessageQueue(KEY))
    await settle()
    act(() => {
      first.result.current.enqueue(draft("A"), null)
      first.result.current.enqueue(draft("B"), null)
      first.result.current.enqueue(draft("C"), null)
    })
    first.unmount()

    const { result, unmount } = renderHook(() => useMessageQueue(KEY))
    await settle()
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue.every((item) => item.failed)).toBe(true)
    act(() => {
      result.current.retryAll()
    })
    let sent: ReturnType<typeof result.current.dequeue>
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent!.draft.displayText).toBe("A")
    // A fails again: back at the head, failed, holding B and C.
    act(() => result.current.requeueFailed(sent!.draft, sent!.modeId))
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue.map((item) => item.failed === true)).toEqual([
      true,
      false,
      false,
    ])
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent!).toBeUndefined()

    act(() => {
      result.current.retryAll()
    })
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      act(() => {
        sent = result.current.dequeue()
      })
      order.push(sent!.draft.displayText)
    }
    expect(order).toEqual(["A", "B", "C"])
    expect(result.current.queue).toEqual([])
    unmount()
  })

  it("puts a send that failed back ahead of a head flagged while it was out", () => {
    // requeueFailed still inserts at index 0: the one that went out is always
    // older than anything still queued.
    const { result } = renderHook(() => useMessageQueue())
    act(() => {
      result.current.enqueue(draft("A"), null)
      result.current.enqueue(draft("B"), null)
      result.current.enqueue(draft("C"), null)
    })
    let sent: ReturnType<typeof result.current.dequeue>
    act(() => {
      sent = result.current.dequeue()
    })
    expect(sent!.draft.displayText).toBe("A")
    act(() => result.current.failHead())
    act(() => result.current.requeueFailed(sent!.draft, sent!.modeId))
    expect(texts(result.current.queue)).toEqual(["A", "B", "C"])
    expect(result.current.queue.map((item) => item.failed === true)).toEqual([
      true,
      true,
      false,
    ])
  })
})
