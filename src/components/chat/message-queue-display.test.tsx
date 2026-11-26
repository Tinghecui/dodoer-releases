import {
  act,
  fireEvent,
  render,
  screen,
  cleanup,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { QueuedMessage } from "@/hooks/use-message-queue"

import { MessageQueueDisplay } from "./message-queue-display"

// Catch the `onReorder` the display hands `Reorder.Group`, so a test can
// emit a drag result without driving pointer events.
const reorderGroup = vi.hoisted(() => {
  const state = {
    onReorder: null as null | ((items: QueuedMessage[]) => void),
    capture(fn: unknown) {
      state.onReorder = fn as (items: QueuedMessage[]) => void
    },
  }
  return state
})
vi.mock("motion/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("motion/react")>()
  const Group = (props: Parameters<typeof actual.Reorder.Group>[0]) => {
    reorderGroup.capture(props.onReorder)
    return <actual.Reorder.Group {...props} />
  }
  return { ...actual, Reorder: { ...actual.Reorder, Group } }
})

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

  it("offers no insert for the row being edited (it is not shown)", () => {
    // While a row is under edit its real content lives in the composer, so
    // the row is hidden and with it the button that would send the stale
    // pre-edit draft.
    renderDisplay({
      onSteerItem: vi.fn(async () => {}),
      steerChannel: "native",
      editingItemId: "q1",
    })
    const buttons = screen.getAllByRole("button", { name: "Steer" })
    expect(buttons).toHaveLength(1)
    expect(buttons[0]).toBeEnabled()
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

// Cowork fork: several failed rows (a reload marks the whole queue failed)
// can be released with one click.
describe("MessageQueueDisplay Retry all", () => {
  const failed = (id: string, text: string): QueuedMessage => ({
    ...item(id, text),
    failed: true,
  })
  const retryAllButton = (container: HTMLElement) =>
    container.querySelector("[data-queue-retry-all]")

  it("offers Retry all only when two or more rows failed", () => {
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm"), failed("q2", "run the tests")],
      onRetry: vi.fn(),
      onRetryAll: vi.fn(),
    })
    const button = retryAllButton(container)
    expect(button).not.toBeNull()
    expect(button).toHaveTextContent("Retry all (2)")
    expect(button).toHaveAttribute("title", TQ.retryAllHint)
    // It sits in the hint line.
    expect(
      container.querySelector("[data-queue-hint] [data-queue-retry-all]")
    ).toBe(button)
  })

  it("has no Retry all with one failed row and one waiting", () => {
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm"), item("q2", "run the tests")],
      onRetry: vi.fn(),
      onRetryAll: vi.fn(),
    })
    expect(retryAllButton(container)).toBeNull()
  })

  it("has no Retry all with nothing failed", () => {
    const { container } = renderDisplay({ onRetryAll: vi.fn() })
    expect(retryAllButton(container)).toBeNull()
  })

  it("does not count the row under edit", () => {
    const { container } = renderDisplay({
      queue: [
        failed("q1", "use pnpm"),
        failed("q2", "run the tests"),
        item("q3", "ship it"),
      ],
      onRetryAll: vi.fn(),
      editingItemId: "q1",
    })
    expect(retryAllButton(container)).toBeNull()
  })

  it("has no Retry all without a handler", () => {
    const { container } = renderDisplay({
      queue: [failed("q1", "use pnpm"), failed("q2", "run the tests")],
      onRetry: vi.fn(),
    })
    expect(retryAllButton(container)).toBeNull()
  })

  it("counts interleaved failed rows and calls the handler once per click", async () => {
    const onRetryAll = vi.fn()
    const { container } = renderDisplay({
      queue: [
        failed("q1", "a"),
        item("q2", "b"),
        failed("q3", "c"),
        item("q4", "d"),
        failed("q5", "e"),
      ],
      onRetry: vi.fn(),
      onRetryAll,
    })
    const button = retryAllButton(container) as HTMLElement
    expect(button).toHaveTextContent("Retry all (3)")
    await userEvent.click(button)
    expect(onRetryAll).toHaveBeenCalledTimes(1)
  })

  it("renders the Chinese label", () => {
    const { container } = render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <MessageQueueDisplay
          queue={[failed("q1", "use pnpm"), failed("q2", "run the tests")]}
          onReorder={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          onRetryAll={vi.fn()}
          editingItemId={null}
        />
      </NextIntlClientProvider>
    )
    expect(retryAllButton(container)).toHaveTextContent("全部重试（2）")
  })
})

// Cowork fork: the row under edit lives in the composer; showing it in the
// queue too would show the message twice.
describe("MessageQueueDisplay while a row is edited", () => {
  const three = [item("q1", "one"), item("q2", "two"), item("q3", "three")]
  const rowNumbers = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("[data-queue-item]")).map((row) =>
      row.getAttribute("data-queue-item")
    )

  it("hides the edited row and keeps the others' real numbers", () => {
    const { container } = renderDisplay({
      queue: [item("q1", "use pnpm"), item("q2", "run the tests")],
      editingItemId: "q1",
    })
    expect(rowNumbers(container)).toEqual(["2"])
    expect(container).not.toHaveTextContent("use pnpm")
    expect(container.querySelector('[data-queue-item="2"]')).toHaveTextContent(
      "#2"
    )
  })

  it("renders nothing when the edited row is the only one", () => {
    const { container } = renderDisplay({
      queue: [item("q1", "use pnpm")],
      editingItemId: "q1",
    })
    expect(container).toBeEmptyDOMElement()
  })

  it("puts the hidden row back at its index when another row is dragged", () => {
    const onReorder = vi.fn()
    renderDisplay({ queue: three, editingItemId: "q2", onReorder })
    act(() => reorderGroup.onReorder?.([three[2], three[0]]))
    expect(onReorder).toHaveBeenCalledTimes(1)
    expect(
      onReorder.mock.calls[0][0].map((row: QueuedMessage) => row.id)
    ).toEqual(["q3", "q2", "q1"])
  })

  it("brings the row back in place, with its new text, once the edit ends", () => {
    const { container, rerender } = renderDisplay({
      queue: three,
      editingItemId: "q2",
    })
    expect(rowNumbers(container)).toEqual(["1", "3"])
    rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <MessageQueueDisplay
          queue={[three[0], item("q2", "two, edited"), three[2]]}
          onReorder={vi.fn()}
          onEdit={vi.fn()}
          onDelete={vi.fn()}
          editingItemId={null}
        />
      </NextIntlClientProvider>
    )
    expect(rowNumbers(container)).toEqual(["1", "2", "3"])
    expect(container.querySelector('[data-queue-item="2"]')).toHaveTextContent(
      "two, edited"
    )
  })
})

// 触屏：重试、引导、编辑、删除四个按钮在粗指针设备上至少 32×32 可点。
// 重试、引导带文字、本身比 32px 宽，用看不见的 ::after 补足高度；
// 编辑、删除两个图标按钮挨在一起，居中的 ::after 会互相盖住（点编辑的右半边
// 会落到后画的删除上），所以触屏上让按钮本身变成 32×32，不用 ::after。
describe("MessageQueueDisplay touch targets", () => {
  function rowButtons() {
    const { container } = renderDisplay({
      queue: [{ ...item("q1", "use pnpm"), failed: true }],
      onRetry: vi.fn(),
      onSteerItem: vi.fn(),
    })
    const row = container.querySelector<HTMLElement>('[data-queue-item="1"]')
    if (!row) throw new Error("expected the queued row")
    const scoped = within(row)
    return {
      retry: scoped.getByRole("button", { name: "Retry" }),
      steer: scoped.getByRole("button", { name: "Steer" }),
      edit: scoped.getByTitle("Edit"),
      remove: scoped.getByTitle("Remove"),
    }
  }

  it("gives the text buttons a 32px coarse-pointer hit area", () => {
    const { retry, steer } = rowButtons()
    for (const button of [retry, steer]) {
      expect(button).toHaveClass(
        "relative",
        "pointer-coarse:after:absolute",
        "pointer-coarse:after:top-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-room-top,20px)*-1))]",
        "pointer-coarse:after:bottom-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-room-bottom,20px)*-1))]",
        // 前后挨着文字、按钮的那一侧最多伸进半个间距
        "pointer-coarse:[&:not(:first-child)]:after:start-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-gap,0px)/-2))]",
        "pointer-coarse:[&:not(:last-child)]:after:end-[max(min(0px,calc(50%-16px)),calc(var(--touch-hit-gap,0px)/-2))]"
      )
      // 这一行把 4px 的间距告诉它
      expect(button.parentElement).toHaveClass(
        "gap-1",
        "[&>*]:[--touch-gap:4px]"
      )
      // 图标尺寸不变
      expect(button.querySelector("svg")).toHaveClass("h-2.5", "w-2.5")
    }
  })

  it("makes edit and remove themselves 32px so their hit areas never overlap", () => {
    const { edit, remove } = rowButtons()
    for (const button of [edit, remove]) {
      expect(button).toHaveClass(
        "pointer-coarse:min-h-8",
        "pointer-coarse:min-w-8",
        "pointer-coarse:inline-flex",
        "pointer-coarse:items-center",
        "pointer-coarse:justify-center"
      )
      // 不再有伸到隔壁按钮上的 ::after
      expect(button.className).not.toContain("pointer-coarse:after:")
      // 图标尺寸不变
      expect(button.querySelector("svg")).toHaveClass("h-2.5", "w-2.5")
    }
  })
})
