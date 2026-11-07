import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { MessageThreadContent } from "@/components/ai-elements/message-thread"
import { useStickToBottomContext } from "use-stick-to-bottom"
import { ConversationMessageThread } from "./conversation-message-thread"

// Keep the real stick-to-bottom engine: asserting animation props alone misses
// spring writes queued by content resizes during hydration.
let height: number
let writes: { top: number; bottom: number }[]
let observers: Set<TestResizeObserver>
class TestResizeObserver {
  targets = new Set<Element>()
  constructor(readonly callback: ResizeObserverCallback) {
    observers.add(this)
  }
  observe(target: Element) {
    this.targets.add(target)
  }
  unobserve(target: Element) {
    this.targets.delete(target)
  }
  disconnect() {
    this.targets.clear()
    observers.delete(this)
  }
}

function deliverResize() {
  act(() => {
    for (const observer of observers) {
      observer.callback(
        [...observer.targets].map(
          (target) =>
            ({
              target,
              contentRect: {
                height: target.hasAttribute("data-content") ? height : 400,
              },
            }) as ResizeObserverEntry
        ),
        observer as unknown as ResizeObserver
      )
    }
  })
}

async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

function ScrollOnSend() {
  const { scrollToBottom } = useStickToBottomContext()
  return <button onClick={() => scrollToBottom()}>send</button>
}

function thread(id = "a", active = true, loading = false) {
  return (
    <ConversationMessageThread key={`${id}:${active}`} loading={loading}>
      <MessageThreadContent data-content="true">messages</MessageThreadContent>
      <ScrollOnSend />
    </ConversationMessageThread>
  )
}

function expectBottomWrites() {
  expect(writes.length).toBeGreaterThan(0)
  for (const { top, bottom } of writes) {
    expect(Math.abs(top - bottom)).toBeLessThanOrEqual(2)
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
      "Date",
      "performance",
    ],
  })
  height = 2400
  writes = []
  observers = new Set()
  vi.stubGlobal("ResizeObserver", TestResizeObserver)
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(
    () => height
  )
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(400)
  const positions = new WeakMap<HTMLElement, number>()
  vi.spyOn(HTMLElement.prototype, "scrollTop", "get").mockImplementation(
    function (this: HTMLElement) {
      return positions.get(this) ?? 0
    }
  )
  vi.spyOn(HTMLElement.prototype, "scrollTop", "set").mockImplementation(
    function (this: HTMLElement, top: number) {
      positions.set(this, Math.max(0, Math.min(top, height - 400)))
      writes.push({ top, bottom: Math.max(0, height - 400) })
    }
  )
})

afterEach(() => {
  cleanup()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("conversation entry scrolling", () => {
  it("pins cached history before paint and through initial measurements", async () => {
    const view = render(thread())
    expect(
      view.container.querySelector("[data-content]")?.parentElement?.scrollTop
    ).toBe(2000)
    deliverResize()
    await advance(100)
    height = 3100
    deliverResize()
    await advance(100)
    height = 2200
    deliverResize()
    await advance(1300)
    expectBottomWrites()
  })

  it("keeps explicit send scrolling instant during entry too", async () => {
    const view = render(thread())
    deliverResize()
    await advance(100)
    height += 800
    act(() => view.getByRole("button", { name: "send" }).click())
    await advance(1400)
    expectBottomWrites()
    expect(writes[writes.length - 1].top).toBeGreaterThanOrEqual(height - 402)
  })

  it("pins history even when loading takes longer than the entry interval", async () => {
    height = 400
    const view = render(thread("a", true, true))
    deliverResize()
    await advance(2000)
    height = 4000
    view.rerender(thread("a", true, false))
    deliverResize()
    await advance(1500)
    expectBottomWrites()
    expect(writes[writes.length - 1]?.top).toBeGreaterThanOrEqual(3598)
  })

  it("restarts entry for another conversation and for a cached tab reactivation", async () => {
    const view = render(thread())
    deliverResize()
    await advance(1600)
    for (const [id, active] of [
      ["b", true],
      ["b", false],
      ["b", true],
    ] as const) {
      writes = []
      height += 500
      view.rerender(thread(id, active))
      deliverResize()
      await advance(1500)
      expectBottomWrites()
    }
  })

  it("enters a streaming reply instantly, then restores animated following", async () => {
    render(thread())
    deliverResize()
    for (let elapsed = 0; elapsed < 1500; elapsed += 100) {
      height += 120
      deliverResize()
      await advance(100)
    }
    expectBottomWrites()

    writes = []
    height += 600
    deliverResize()
    await advance(1500)
    expect(writes.some(({ top, bottom }) => bottom - top > 2)).toBe(true)
    expect(
      Math.abs(writes[writes.length - 1].top - (height - 400))
    ).toBeLessThanOrEqual(2)
  })

  it("stays transparent while rows measure, then fades in at the bottom", async () => {
    const view = render(thread())
    const revealed = () =>
      view.container.querySelector("[data-thread-revealed]") !== null
    expect(revealed()).toBe(false)
    await advance(60)
    deliverResize()
    await advance(60)
    expect(revealed()).toBe(false)
    await advance(40)
    expect(revealed()).toBe(true)
  })

  it("reveals by the cap even while rows keep resizing", async () => {
    const view = render(thread())
    for (let i = 0; i < 8; i++) {
      deliverResize()
      await advance(60)
    }
    expect(view.container.querySelector("[data-thread-revealed]")).not.toBe(
      null
    )
  })

  it("disconnects entry observers on unmount", () => {
    const view = render(thread())
    view.unmount()
    expect(observers.size).toBe(0)
  })
})
