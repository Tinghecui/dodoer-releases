import type { ReactElement } from "react"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { ConversationActivityBadge } from "./conversation-activity-badge"
import { InterruptedTurnBar, isInterruptedTurn } from "./interrupted-turn-bar"
import enMessages from "@/i18n/messages/en.json"

afterEach(cleanup)

function renderWithIntl(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

const AT = "2026-11-16T08:00:00Z"
const interruptedText = enMessages.Folder.sidebar.statusInterruptedBadge
const cancelledText = enMessages.Folder.sidebar.statusCancelledBadge

// 被打断 = 已取消且 interrupted_at 有值（#369）。
describe("isInterruptedTurn", () => {
  it("is true only for a cancelled row carrying interrupted_at", () => {
    expect(isInterruptedTurn({ status: "cancelled", interrupted_at: AT })).toBe(
      true
    )
  })

  it("is false for a cancelled row without it, null or absent", () => {
    expect(
      isInterruptedTurn({ status: "cancelled", interrupted_at: null })
    ).toBe(false)
    expect(isInterruptedTurn({ status: "cancelled" })).toBe(false)
  })

  it("is false for any other status, even with interrupted_at", () => {
    expect(
      isInterruptedTurn({ status: "in_progress", interrupted_at: AT })
    ).toBe(false)
  })
})

describe("InterruptedTurnBar", () => {
  it("renders nothing when the turn was not interrupted", () => {
    const onContinue = vi.fn()
    renderWithIntl(
      <InterruptedTurnBar interrupted={false} onContinue={onContinue} />
    )
    expect(screen.queryByTestId("interrupted-turn")).toBeNull()
  })

  it("shows the notice and sends only when Continue is clicked", () => {
    const onContinue = vi.fn()
    renderWithIntl(<InterruptedTurnBar interrupted onContinue={onContinue} />)
    const bar = screen.getByTestId("interrupted-turn")
    expect(bar.getAttribute("role")).toBe("status")
    expect(bar.textContent).toContain("The last turn was interrupted")
    expect(onContinue).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("interrupted-turn-continue"))
    expect(onContinue).toHaveBeenCalledTimes(1)
  })
})

describe("ConversationActivityBadge interrupted", () => {
  it("draws the pause mark instead of the red cross", () => {
    const { container } = renderWithIntl(
      <ConversationActivityBadge running={false} cancelled interrupted />
    )
    const mark = container.querySelector("[data-turn-interrupted]")
    expect(mark).not.toBeNull()
    expect(mark?.getAttribute("title")).toBe(interruptedText)
    expect(container.textContent).toContain(interruptedText)
    expect(container.textContent).not.toContain(cancelledText)
    expect(container.querySelector("[data-turn-unfinished]")).toBeNull()
  })

  it("carries the unread dot like the cross does", () => {
    const { container } = renderWithIntl(
      <ConversationActivityBadge running={false} cancelled interrupted unread />
    )
    const mark = container.querySelector("[data-turn-interrupted]")
    expect(mark?.hasAttribute("data-unread")).toBe(true)
  })

  it("keeps the red cross for a turn the user stopped", () => {
    const { container } = renderWithIntl(
      <ConversationActivityBadge running={false} cancelled />
    )
    expect(container.querySelector("[data-turn-interrupted]")).toBeNull()
    expect(container.textContent).toContain(cancelledText)
    expect(container.textContent).not.toContain(interruptedText)
  })

  it("still lets running outrank it", () => {
    const { container } = renderWithIntl(
      <ConversationActivityBadge running cancelled interrupted />
    )
    expect(container.querySelector("[data-turn-interrupted]")).toBeNull()
  })
})
