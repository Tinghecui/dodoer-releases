import { act, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { VV_HEIGHT_VAR, VV_OFFSET_TOP_VAR } from "@/hooks/use-visual-viewport"

import { WorkspaceViewportRoot } from "./workspace-viewport-root"

class FakeVisualViewport extends EventTarget {
  height = 844
  offsetTop = 0
}

let vv: FakeVisualViewport
let rafQueue: FrameRequestCallback[] = []

function setViewport(height: number, offsetTop = 0) {
  vv.height = height
  vv.offsetTop = offsetTop
  vv.dispatchEvent(new Event("resize"))
  const queue = rafQueue
  rafQueue = []
  act(() => {
    for (const cb of queue) cb(0)
  })
}

const realInnerHeight = window.innerHeight

beforeEach(() => {
  vv = new FakeVisualViewport()
  Object.defineProperty(window, "visualViewport", {
    configurable: true,
    value: vv,
  })
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: 844,
  })
  rafQueue = []
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    rafQueue.push(cb)
    return rafQueue.length
  })
  vi.stubGlobal("cancelAnimationFrame", () => {})
})

afterEach(() => {
  vi.unstubAllGlobals()
  Object.defineProperty(window, "innerHeight", {
    configurable: true,
    value: realInnerHeight,
  })
  document.documentElement.style.removeProperty(VV_HEIGHT_VAR)
  document.documentElement.style.removeProperty(VV_OFFSET_TOP_VAR)
})

function renderRoot(isMobile: boolean) {
  return render(
    <WorkspaceViewportRoot
      isMobile={isMobile}
      mobileFooter={<div data-testid="status-bar" />}
    >
      <div data-testid="content" />
    </WorkspaceViewportRoot>
  )
}

const rootOf = () => screen.getByTestId("content").parentElement!

describe("WorkspaceViewportRoot", () => {
  it("高度用可见区域变量，没有时退回 100dvh；不再 fixed inset-0", () => {
    renderRoot(false)
    const cls = rootOf().className
    expect(cls).toContain("h-[var(--app-vvh,100dvh)]")
    expect(cls).toContain("top-[var(--app-vv-top,0px)]")
    expect(cls).not.toContain("inset-0")
  })

  it("手机布局键盘收起：保留底部安全区留白，显示底部状态栏", () => {
    renderRoot(true)
    expect(rootOf().className).toContain("pb-[env(safe-area-inset-bottom)]")
    expect(screen.queryByTestId("status-bar")).not.toBeNull()
  })

  it("手机布局键盘弹起：去掉底部安全区留白，隐藏底部状态栏；收起后恢复", () => {
    renderRoot(true)
    setViewport(544, 100)
    expect(rootOf().className).not.toContain("pb-[env(safe-area-inset-bottom)]")
    expect(screen.queryByTestId("status-bar")).toBeNull()
    expect(document.documentElement.style.getPropertyValue(VV_HEIGHT_VAR)).toBe(
      "544px"
    )

    setViewport(844, 0)
    expect(rootOf().className).toContain("pb-[env(safe-area-inset-bottom)]")
    expect(screen.queryByTestId("status-bar")).not.toBeNull()
  })

  it("桌面布局：不渲染手机状态栏，可见区域变了也不动", () => {
    renderRoot(false)
    setViewport(544, 0)
    expect(screen.queryByTestId("status-bar")).toBeNull()
    expect(rootOf().className).toContain("pb-[env(safe-area-inset-bottom)]")
    expect(document.documentElement.style.getPropertyValue(VV_HEIGHT_VAR)).toBe(
      ""
    )
  })
})
