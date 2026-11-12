import {
  act,
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { QueuedMessage } from "@/hooks/use-message-queue"

import { MessageQueueDisplay } from "./message-queue-display"

const TQ = enMessages.Folder.chat.messageQueue

function item(id: string, text: string): QueuedMessage {
  return {
    id,
    draft: { blocks: [{ type: "text", text }], displayText: text },
    modeId: null,
  }
}

/** A queued draft that carries an attachment — only the native wire takes it. */
function itemWithAttachment(id: string, text: string): QueuedMessage {
  return {
    id,
    draft: {
      blocks: [
        { type: "text", text },
        {
          type: "resource",
          uri: "clipboard://shot.png-1",
          mime_type: "image/png",
          text: null,
          blob: "QUJD",
        },
      ],
      displayText: text,
    },
    modeId: null,
  }
}

function renderDisplay(
  props: Partial<React.ComponentProps<typeof MessageQueueDisplay>> = {}
) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MessageQueueDisplay
        queue={[item("q1", "use pnpm"), item("q2", "run the tests")]}
        onReorder={vi.fn()}
        onEdit={vi.fn()}
        onDelete={vi.fn()}
        editingItemId={null}
        {...props}
      />
    </NextIntlClientProvider>
  )
}

afterEach(cleanup)

describe("MessageQueueDisplay click-to-insert", () => {
  it("keeps a visible disabled Steer button without a steering handler", () => {
    renderDisplay()
    const buttons = screen.getAllByRole("button", { name: "Steer" })
    expect(buttons).toHaveLength(2)
    buttons.forEach((button) => expect(button).toBeDisabled())
  })

  it("shows the rule above numbered rows and renumbers the remaining queue", () => {
    const onSteerItem = vi.fn()
    const { container, rerender } = renderDisplay({ onSteerItem })
    expect(container.querySelector("[data-queue-hint]")).toHaveTextContent(
      TQ.hint
    )
    expect(
      Array.from(container.querySelectorAll("[data-queue-item]")).map((row) =>
        row.getAttribute("data-queue-item")
      )
    ).toEqual(["1", "2"])
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageQueueDisplay
          queue={[item("q2", "run the tests")]}
          onReorder={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          editingItemId={null}
          onSteerItem={onSteerItem}
        />
      </NextIntlClientProvider>
    )
    expect(container.querySelector('[data-queue-item="1"]')).toHaveTextContent(
      "run the tests"
    )
    expect(container.querySelector('[data-queue-item="2"]')).toBeNull()
  })

  it("renders the Chinese action text without hovering", () => {
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <MessageQueueDisplay
          queue={[item("q1", "use pnpm")]}
          onReorder={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          editingItemId={null}
          onSteerItem={vi.fn()}
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("button", { name: "引导" })).toBeVisible()
  })

  it("hides the hint with an empty queue", () => {
    const { container } = renderDisplay({ queue: [] })
    expect(container.querySelector("[data-queue-hint]")).toBeNull()
  })

  it("inserts the row the button belongs to, with the native promise", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({ onSteerItem, steerChannel: "native" })

    const buttons = screen.getAllByTitle(TQ.steerItemNow)
    expect(buttons).toHaveLength(2)

    await userEvent.click(buttons[1])
    expect(onSteerItem).toHaveBeenCalledWith("q2")
  })

  it("keys the copy to the pull channel (waiting note, not an insert)", async () => {
    const onSteerItem = vi.fn(async () => {})
    renderDisplay({ onSteerItem, steerChannel: "pull" })

    // The insert label must not appear on a pull session — it would promise
    // an instant injection the channel can't deliver.
    expect(screen.queryByTitle(TQ.steerItemNow)).toBeNull()
    await userEvent.click(screen.getAllByTitle(TQ.steerItemAsNote)[0])
    expect(onSteerItem).toHaveBeenCalledWith("q1")
  })

  it("disables every row while an insert is in flight (single-flight)", async () => {
    let release: () => void = () => {}
    const onSteerItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    renderDisplay({ onSteerItem, steerChannel: "native" })

    const buttons = screen.getAllByTitle(TQ.steerItemNow) as HTMLButtonElement[]
    await userEvent.click(buttons[0])
    await waitFor(() => expect(onSteerItem).toHaveBeenCalledTimes(1))

    expect(buttons[1].disabled).toBe(true)
    // A second click while in flight must not race the same channel.
    await userEvent.click(buttons[1])
    expect(onSteerItem).toHaveBeenCalledTimes(1)

    release()
    await waitFor(() => expect(buttons[1].disabled).toBe(false))
  })

  it("admits only one insertion before React commits the disabled buttons", async () => {
    let release!: () => void
    const onSteerItem = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve
        })
    )
    renderDisplay({ onSteerItem, steerChannel: "native" })
    const buttons = screen.getAllByTitle(TQ.steerItemNow)
    act(() => {
      fireEvent.click(buttons[0])
      fireEvent.click(buttons[1])
    })
    expect(onSteerItem).toHaveBeenCalledTimes(1)
    await act(async () => {
      release()
    })
  })

  it("disables the note button on a pull row the channel cannot carry", () => {
    // The pull tool delivers text only, so the backend rejects a draft with
    // attachments there — the click could never insert anything. The row is
    // still sent whole (attachment included) by the queue's own flush.
    renderDisplay({
      queue: [item("q1", "use pnpm"), itemWithAttachment("q2", "look at this")],
      onSteerItem: vi.fn(async () => {}),
      steerChannel: "pull",
    })
    const buttons = screen.getAllByRole("button", { name: "Steer" })
    expect(buttons[0]).toBeEnabled()
    expect(buttons[1]).toBeDisabled()
  })

  it("keeps the attachment row insertable on the native wire", () => {
    renderDisplay({
      queue: [item("q1", "use pnpm"), itemWithAttachment("q2", "look at this")],
      onSteerItem: vi.fn(async () => {}),
      steerChannel: "native",
    })
    expect(screen.getAllByTitle(TQ.steerItemNow)).toHaveLength(2)
  })

  it("disables the insert on the row being edited (the composer owns its text)", () => {
    // While a row is under edit its real content lives in the composer;
    // inserting would send the stale pre-edit draft and drop the row the save
    // was headed for.
    renderDisplay({
      onSteerItem: vi.fn(async () => {}),
      steerChannel: "native",
      editingItemId: "q1",
    })
    const buttons = screen.getAllByRole("button", { name: "Steer" })
    expect(buttons[0]).toBeDisabled()
    expect(buttons[1]).toBeEnabled()
  })
})

// Cowork fork: a failed head holds everything behind it, so the generic
// "sent after this turn ends" would be untrue.
describe("MessageQueueDisplay with a failed head", () => {
  const failed = (id: string, text: string): QueuedMessage => ({
    ...item(id, text),
    failed: true,
  })

  it("says the first message failed and the rest wait for it", () => {
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm"), item("q2", "run the tests")],
      onRetry: vi.fn(),
    })
    const hints = container.querySelectorAll("[data-queue-hint]")
    expect(hints).toHaveLength(1)
    expect(hints[0]).toHaveTextContent(TQ.failedHeadHint)
    expect(hints[0]).not.toHaveTextContent(TQ.hint)
    expect(hints[0]).toHaveAttribute("data-queue-blocked")
    // Nothing more to offer without a notice from the host.
    expect(container.querySelector("[data-queue-blocked-reason]")).toBeNull()
    expect(container.querySelector("[data-queue-blocked-action]")).toBeNull()
  })

  it("does not speak of messages below when the failed one is alone", () => {
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm")],
      onRetry: vi.fn(),
    })
    const hint = container.querySelector("[data-queue-hint]")
    expect(hint).toHaveTextContent(TQ.failedSingleHint)
    expect(hint).not.toHaveTextContent(TQ.failedHeadHint)
  })

  it("keeps the generic hint while only a later item is failed", () => {
    // Dragged behind another row: the head still sends, so nothing is held.
    const { container } = renderDisplay({
      queue: [item("q1", "use pnpm"), failed("q2", "run the tests")],
      onRetry: vi.fn(),
      failedHeadNotice: { reason: "should not show" },
    })
    const hint = container.querySelector("[data-queue-hint]")
    expect(hint).toHaveTextContent(TQ.hint)
    expect(hint).not.toHaveAttribute("data-queue-blocked")
    expect(hint).not.toHaveTextContent("should not show")
  })

  it("goes back to the generic hint once the head is retried", () => {
    const { container, rerender } = renderDisplay({
      queue: [failed("q1", "use pnpm"), item("q2", "run the tests")],
    })
    expect(container.querySelector("[data-queue-hint]")).toHaveTextContent(
      TQ.failedHeadHint
    )
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageQueueDisplay
          queue={[item("q1", "use pnpm"), item("q2", "run the tests")]}
          onReorder={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          editingItemId={null}
        />
      </NextIntlClientProvider>
    )
    expect(container.querySelector("[data-queue-hint]")).toHaveTextContent(
      TQ.hint
    )
  })

  it("shows the host's reason and its fix link, and the link works", async () => {
    const onClick = vi.fn()
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm")],
      onRetry: vi.fn(),
      failedHeadNotice: {
        reason: "Claude Code is not installed or enabled yet.",
        action: { label: "Open Agents settings", onClick },
      },
    })
    expect(
      container.querySelector("[data-queue-blocked-reason]")
    ).toHaveTextContent("Claude Code is not installed or enabled yet.")
    expect(container.querySelector("[data-queue-hint]")).toHaveTextContent(
      TQ.failedSingleHint
    )
    await userEvent.click(
      screen.getByRole("button", { name: "Open Agents settings" })
    )
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("offers a link alone, for a failure that needs no second explanation", async () => {
    // A turn refused for credentials: the transcript already says so.
    const onClick = vi.fn()
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm"), item("q2", "run the tests")],
      onRetry: vi.fn(),
      failedHeadNotice: { action: { label: "Sign in", onClick } },
    })
    expect(container.querySelector("[data-queue-blocked-reason]")).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }))
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("still offers retry and remove on the failed row", async () => {
    const onRetry = vi.fn()
    const onDelete = vi.fn()
    renderDisplay({
      queue: [failed("q1", "use pnpm"), item("q2", "run the tests")],
      onRetry,
      onDelete,
    })
    await userEvent.click(screen.getByRole("button", { name: TQ.retry }))
    expect(onRetry).toHaveBeenCalledWith("q1")
    await userEvent.click(screen.getAllByTitle(TQ.deleteItem)[0])
    expect(onDelete).toHaveBeenCalledWith("q1")
  })

  it("renders the Chinese hint", () => {
    const { container } = render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <MessageQueueDisplay
          queue={[failed("q1", "use pnpm"), item("q2", "run the tests")]}
          onReorder={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          editingItemId={null}
        />
      </NextIntlClientProvider>
    )
    expect(container.querySelector("[data-queue-hint]")).toHaveTextContent(
      "第 1 条消息发送失败，后面的消息在等它。重试或删除它，才会继续发送。"
    )
  })
})
