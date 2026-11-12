import { describe, it, expect } from "vitest"
import { act, renderHook } from "@testing-library/react"
import { useMessageQueue } from "./use-message-queue"
import type { PromptDraft } from "@/lib/types"

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
