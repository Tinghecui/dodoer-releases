import { act, fireEvent, render, screen } from "@testing-library/react"
import { createRef } from "react"
import type { OverlayScrollbarsComponentRef } from "overlayscrollbars-react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "./context-menu"
import { ScrollArea } from "./scroll-area"

// Runs the real component and library. The init is `defer`red into an idle
// callback that then waits for an animation frame; both are queued here and
// flushed by the test.
const deferred = new Map<number, () => void>()
let nextHandle = 0

function flushDeferred() {
  for (let round = 0; round < 2; round++) {
    act(() => {
      for (const [handle, callback] of [...deferred]) {
        deferred.delete(handle)
        callback()
      }
    })
  }
}

beforeEach(() => {
  const queue = (callback: () => void) => {
    deferred.set(++nextHandle, callback)
    return nextHandle
  }
  const cancel = (handle: number) => deferred.delete(handle)
  vi.stubGlobal("requestIdleCallback", queue)
  vi.stubGlobal("cancelIdleCallback", cancel)
  vi.stubGlobal("requestAnimationFrame", queue)
  vi.stubGlobal("cancelAnimationFrame", cancel)
  // OverlayScrollbars only measures an element that has a size, and jsdom
  // lays nothing out.
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(200)
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(200)
})

afterEach(() => {
  deferred.clear()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Whether a full update of the area arms OverlayScrollbars' scroll block: the
// capture listener its flow-direction check adds to stop the next scroll event
// (the only capture `scroll` listener the library adds).
function updateArmsScrollBlock(x: "scroll" | "hidden") {
  const ref = createRef<OverlayScrollbarsComponentRef>()
  render(
    <ScrollArea ref={ref} x={x}>
      <div />
    </ScrollArea>
  )
  flushDeferred()
  const instance = ref.current?.osInstance()
  if (!instance) throw new Error("OverlayScrollbars did not initialize")
  const listen = vi.spyOn(EventTarget.prototype, "addEventListener")
  instance.update(true)
  return listen.mock.calls.some(
    ([type, , options]) =>
      type === "scroll" && typeof options === "object" && !!options.capture
  )
}

describe("ScrollArea", () => {
  // The block stopped the scroll that opened the settings popover's model list
  // on its current row, so virtua drew that row alone in an empty list.
  it("never arms the scroll block in an area that cannot scroll sideways", () => {
    expect(updateArmsScrollBlock("hidden")).toBe(false)
  })

  it("still runs the check where `direction: rtl` can flip the axis", () => {
    expect(updateArmsScrollBlock("scroll")).toBe(true)
  })

  // 文件页签、Git 日志页签都把 ScrollArea 当成 ContextMenuTrigger asChild 的
  // 子元素：Slot 塞进来的事件处理要落到真实的 DOM 元素上，不然整块区域右键
  // 什么都不弹（#1279）。
  it("passes extra DOM props and handlers through to the host element", () => {
    const onContextMenu = vi.fn()
    render(
      <ScrollArea data-testid="area" onContextMenu={onContextMenu}>
        <div />
      </ScrollArea>
    )
    fireEvent.contextMenu(screen.getByTestId("area"))
    expect(onContextMenu).toHaveBeenCalledTimes(1)
  })

  it("opens a context menu whose trigger is the area itself", () => {
    render(
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <ScrollArea>
            <p>blank space</p>
          </ScrollArea>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem>New</ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
    fireEvent.contextMenu(screen.getByText("blank space"))
    expect(screen.getByText("New")).toBeTruthy()
  })
})
