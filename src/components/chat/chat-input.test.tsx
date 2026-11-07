import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ComponentProps } from "react"

// The composer body itself is irrelevant here — these tests are about which
// events the wrapper lets escape to the conversation panel around it, and which
// derived props the wrapper hands down.
const lastProps = vi.hoisted(() => ({
  current: null as Record<string, unknown> | null,
}))
vi.mock("@/components/chat/message-input", () => ({
  MessageInput: (props: Record<string, unknown>) => {
    lastProps.current = props
    return (
      <button type="button" data-testid="agent-icon">
        agent
      </button>
    )
  },
}))

vi.mock("@/components/chat/message-queue-display", () => ({
  MessageQueueDisplay: () => null,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

import { ChatInput } from "./chat-input"

/**
 * jsdom's `fireEvent.pointerDown` drops `pointerType` (it builds a plain
 * MouseEvent), so the property is pinned by hand — the guard under test reads
 * exactly that field.
 */
function pointerDown(element: Element, pointerType: string) {
  const event = new MouseEvent("pointerdown", {
    bubbles: true,
    cancelable: true,
  })
  Object.defineProperty(event, "pointerType", { value: pointerType })
  fireEvent(element, event)
}

function renderComposer(onPointerDown: () => void, onContextMenu: () => void) {
  // Stands in for the conversation panel's context-menu trigger, which wraps
  // the transcript AND the composer (conversations/conversation-detail-panel).
  return render(
    <div onPointerDown={onPointerDown} onContextMenu={onContextMenu}>
      <ChatInput
        status="connected"
        promptCapabilities={{
          image: false,
          audio: false,
          embedded_context: false,
        }}
        onSend={() => {}}
        onCancel={() => {}}
      />
    </div>
  )
}

describe("ChatInput event containment", () => {
  it("keeps a touch press from arming the conversation panel's long-press menu", () => {
    const onPointerDown = vi.fn()
    const onContextMenu = vi.fn()
    renderComposer(onPointerDown, onContextMenu)

    // A tap on a composer control (e.g. the agent icon) that lingers would
    // otherwise open the conversation context menu on touch devices.
    pointerDown(screen.getByTestId("agent-icon"), "touch")
    expect(onPointerDown).not.toHaveBeenCalled()
  })

  it("lets a mouse press through (the panel's selection bookkeeping needs it)", () => {
    const onPointerDown = vi.fn()
    const onContextMenu = vi.fn()
    renderComposer(onPointerDown, onContextMenu)

    pointerDown(screen.getByTestId("agent-icon"), "mouse")
    expect(onPointerDown).toHaveBeenCalled()
  })

  it("keeps a right-click inside the composer out of the conversation menu", () => {
    const onPointerDown = vi.fn()
    const onContextMenu = vi.fn()
    renderComposer(onPointerDown, onContextMenu)

    fireEvent.contextMenu(screen.getByTestId("agent-icon"))
    expect(onContextMenu).not.toHaveBeenCalled()
  })
})

// The `/` panel's loading state has to span the WHOLE wait for the agent's
// command list. The backend emits `connected` early — before session
// resume/load/new — and only forwards the buffered commands once
// `selectors_ready` has fired, so `connecting` alone would blank the panel again
// for the entire session-init leg.
describe("ChatInput slash-command loading window", () => {
  afterEach(() => {
    cleanup()
    lastProps.current = null
  })

  function renderStatus(props: Partial<ComponentProps<typeof ChatInput>>) {
    render(
      <ChatInput
        status="connected"
        promptCapabilities={{
          image: false,
          audio: false,
          embedded_context: false,
        }}
        onSend={() => {}}
        onCancel={() => {}}
        {...props}
      />
    )
    return lastProps.current
  }

  it("loads while the connection is being established", () => {
    expect(renderStatus({ status: "connecting" })?.commandsLoading).toBe(true)
  })

  it("keeps loading through session init (connected, selectors not ready)", () => {
    expect(
      renderStatus({ status: "connected", selectorsLoading: true })
        ?.commandsLoading
    ).toBe(true)
  })

  it("stops once the session is initialized", () => {
    expect(
      renderStatus({ status: "connected", selectorsLoading: false })
        ?.commandsLoading
    ).toBe(false)
    // Bounded even for an agent that never advertises a single command:
    // `selectors_ready` fires on every establishment path, so this can't hang.
    expect(
      renderStatus({
        status: "connected",
        selectorsLoading: false,
        availableCommands: [],
      })?.commandsLoading
    ).toBe(false)
  })

  it("does not load on a dead connection", () => {
    expect(renderStatus({ status: "disconnected" })?.commandsLoading).toBe(
      false
    )
    expect(renderStatus({ status: "error" })?.commandsLoading).toBe(false)
  })

  // The user-visible half of issue #797: a torn-down connection is what greys
  // the composer out, so a turn-scoped failure must never take the connection
  // with it. `prompting` stays enabled on purpose (the draft enqueues), and
  // `error` / `disconnected` are exactly the states the backend used to enter
  // for a rejected `session/prompt` — the user could not send again until a
  // full agent respawn had finished.
  it("greys the composer out only when the connection itself is gone", () => {
    expect(renderStatus({ status: "connected" })?.disabled).toBe(false)
    expect(renderStatus({ status: "prompting" })?.disabled).toBe(false)
    expect(renderStatus({ status: "error" })?.disabled).toBe(true)
    expect(renderStatus({ status: "disconnected" })?.disabled).toBe(true)
  })
})

describe("ChatInput automatic collapse", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  /** The pointer leaves and stays away past the grace period. */
  function leave(container: Element) {
    fireEvent.mouseLeave(container)
    act(() => {
      vi.advanceTimersByTime(300)
    })
  }

  function setup(overrides: Partial<ComponentProps<typeof ChatInput>> = {}) {
    let props: ComponentProps<typeof ChatInput> = {
      status: "connected",
      hasMessages: true,
      promptCapabilities: {
        image: false,
        audio: false,
        embedded_context: false,
      },
      onSend: vi.fn(),
      onCancel: vi.fn(),
      ...overrides,
    }
    const view = render(<ChatInput {...props} />)
    const container = view.container.querySelector("[data-composer-state]")!
    return {
      container,
      update(next: Partial<ComponentProps<typeof ChatInput>>) {
        props = { ...props, ...next }
        view.rerender(<ChatInput {...props} />)
      },
    }
  }

  it("opens idle history collapsed, retaining the mounted editor without its layout space", () => {
    const { container } = setup()
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
    expect(screen.getByTestId("agent-icon")).not.toBeVisible()
    expect(lastProps.current?.suppressAutoFocus).toBe(true)
    fireEvent.mouseEnter(container)
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    expect(screen.getByTestId("agent-icon")).toBeVisible()
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
  })

  it("collapses into an input-shaped bar rather than a bare icon", () => {
    const { container } = setup()
    const bar = container.querySelector("[data-composer-collapsed-bar]")!
    expect(bar).toBeVisible()
    expect(bar).toHaveTextContent("sendMessage")
    // Same width as the open composer: nothing narrows the collapsed box.
    expect(container.className).not.toMatch(/max-w-/)
    fireEvent.mouseEnter(container)
    expect(bar).not.toBeVisible()
  })

  it("folds into the open card's look, not a white capsule", () => {
    const { container } = setup()
    const bar = container.querySelector("[data-composer-collapsed-bar]")!
    // The same grey pane card, frame and corners as the open composer.
    for (const cls of [
      "lg-pane",
      "lg-card",
      "lg-raised-firm",
      "rounded-[18px]",
    ])
      expect(bar.classList).toContain(cls)
    expect(bar.classList).not.toContain("rounded-full")
    // Folded at rest nothing clips the bar, so its shadow fades out uncut.
    const outline = container.querySelector<HTMLElement>(
      "[data-composer-outline]"
    )!
    expect(outline.style.clipPath).toBe("")
  })

  it("folds to the bar's real height, so a zoomed bar is not cut at the top", () => {
    // At 120% zoom `h-12` (3rem) is 57.6px, not 48.
    const height = vi
      .spyOn(HTMLElement.prototype, "offsetHeight", "get")
      .mockImplementation(function (this: HTMLElement) {
        return this.hasAttribute("data-composer-collapsed-bar") ? 58 : 0
      })
    const { container } = setup()
    const outline = container.querySelector<HTMLElement>(
      "[data-composer-outline]"
    )!
    expect(outline.style.height).toBe("58px")
    expect(outline.style.minHeight).toBe("58px")
    height.mockRestore()
  })

  it("never forces visibility, so a hidden inactive tab hides its composer", () => {
    const { container } = setup()
    const bar = container.querySelector<HTMLElement>(
      "[data-composer-collapsed-bar]"
    )!
    expect(bar.style.visibility).toBe("")
    fireEvent.mouseEnter(container)
    const body = bar.nextElementSibling as HTMLElement
    expect(body.style.visibility).toBe("")
  })

  it("keeps new sessions and running turns expanded", () => {
    const { container, update } = setup({ hasMessages: false })
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    update({ hasMessages: true, status: "prompting" })
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    update({ status: "connected" })
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
  })

  it("collapses at turn end despite the focus left behind after sending", () => {
    const { container, update } = setup({ status: "prompting" })
    act(() => screen.getByTestId("agent-icon").focus())
    fireEvent.mouseEnter(container)
    update({ status: "connected" })
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
    expect(screen.getByTestId("agent-icon")).not.toHaveFocus()
  })

  it("keeps an unsent draft open at turn end and after an outside click", () => {
    const { container, update } = setup({ status: "prompting" })
    const setDraft = (value: boolean) =>
      act(() => {
        ;(lastProps.current?.onDraftChange as (value: boolean) => void)(value)
      })
    setDraft(true)
    pointerDown(document.body, "mouse")
    update({ status: "connected" })
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    pointerDown(document.body, "mouse")
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    setDraft(false)
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
  })

  it("stays expanded while focused or hovered and collapses only after both leave", () => {
    const { container } = setup()
    fireEvent.mouseEnter(container)
    const editor = screen.getByTestId("agent-icon")
    act(() => editor.focus())
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    fireEvent.mouseEnter(container)
    act(() => editor.blur())
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
  })

  it("allows keyboard activation and expands for queue edits and injected content", () => {
    const { container, update } = setup()
    fireEvent.focus(screen.getByRole("button", { name: "sendMessage" }))
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    pointerDown(document.body, "mouse")
    update({ isEditingQueueItem: true })
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    update({ isEditingQueueItem: false, injectContent: { text: "quote" } })
    expect(container).toHaveAttribute("data-composer-state", "expanded")
  })

  it("expands on a touch press without needing hover", () => {
    const { container } = setup()
    pointerDown(screen.getByRole("button", { name: "sendMessage" }), "touch")
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    pointerDown(document.body, "touch")
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
  })

  it("waits a moment before folding, and a return in time keeps it open", () => {
    const { container } = setup()
    fireEvent.mouseEnter(container)
    fireEvent.mouseLeave(container)
    act(() => {
      vi.advanceTimersByTime(150)
    })
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    fireEvent.mouseEnter(container)
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(container).toHaveAttribute("data-composer-state", "expanded")
    leave(container)
    expect(container).toHaveAttribute("data-composer-state", "collapsed")
  })

  it("morphs one outline: pinned and clipped while moving, free once open", () => {
    const { container } = setup()
    const outline = container.querySelector<HTMLElement>(
      "[data-composer-outline]"
    )!
    const body = container.querySelector<HTMLElement>("[data-composer-body]")!
    // Folded: the outline is the bar's height; the body is hidden, so at
    // rest nothing is clipped.
    expect(outline.style.height).toBe("48px")
    expect(outline.style.clipPath).toBe("")
    expect(body.className).toContain("absolute")
    fireEvent.mouseEnter(container)
    // Opening: still clipped while the height eases.
    expect(outline.style.clipPath).not.toBe("")
    act(() => {
      vi.advanceTimersByTime(400)
    })
    // Settled: nothing pinned or clipped, the body back in the flow.
    expect(outline.style.height).toBe("")
    expect(outline.style.clipPath).toBe("")
    expect(body.className).toContain("relative")
    // Folding again pins and clips at once, and lets go once it is down.
    leave(container)
    expect(outline.style.height).toBe("48px")
    expect(outline.style.clipPath).not.toBe("")
    act(() => {
      vi.advanceTimersByTime(400)
    })
    expect(outline.style.clipPath).toBe("")
  })
})
