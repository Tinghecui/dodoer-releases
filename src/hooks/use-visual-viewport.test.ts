import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { kbdLiftPx } from "@/lib/terminal/keybar"

import {
  useVisualViewport,
  VV_HEIGHT_VAR,
  VV_KEYBOARD_LIFT_VAR,
  VV_OFFSET_TOP_VAR,
} from "./use-visual-viewport"

/** 可控的假 visualViewport：改 height / offsetTop 后派发事件。 */
class FakeVisualViewport extends EventTarget {
  height = 844
  offsetTop = 0
  set(height: number, offsetTop = 0) {
    this.height = height
    this.offsetTop = offsetTop
    this.dispatchEvent(new Event("resize"))
    this.dispatchEvent(new Event("scroll"))
  }
}

let vv: FakeVisualViewport
let rafQueue: FrameRequestCallback[] = []
const realInnerHeight = window.innerHeight

function flushFrames() {
  const queue = rafQueue
  rafQueue = []
  act(() => {
    for (const cb of queue) cb(0)
  })
}

const cssVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name)

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
  document.documentElement.style.removeProperty(VV_KEYBOARD_LIFT_VAR)
})

describe("useVisualViewport", () => {
  it("手机布局：把可见高度和偏移写进根元素的 CSS 变量，键盘弹起后更新", () => {
    const { result } = renderHook(() => useVisualViewport(true))
    expect(cssVar(VV_HEIGHT_VAR)).toBe("844px")
    expect(cssVar(VV_OFFSET_TOP_VAR)).toBe("0px")
    expect(result.current.keyboardOpen).toBe(false)

    // 键盘 300px，iOS 把页面上推 100px
    vv.set(544, 100)
    // 合并到一帧：事件来了还没刷帧时不动
    expect(cssVar(VV_HEIGHT_VAR)).toBe("844px")
    flushFrames()
    expect(cssVar(VV_HEIGHT_VAR)).toBe("544px")
    expect(cssVar(VV_OFFSET_TOP_VAR)).toBe("100px")
    expect(result.current.keyboardOpen).toBe(true)
    expect(result.current.height).toBe(544)

    // 键盘收起恢复
    vv.set(844, 0)
    flushFrames()
    expect(cssVar(VV_HEIGHT_VAR)).toBe("844px")
    expect(result.current.keyboardOpen).toBe(false)
  })

  it("一帧里连着来的多次事件只排一次帧", () => {
    renderHook(() => useVisualViewport(true))
    vv.set(700)
    vv.set(600)
    vv.set(544)
    expect(rafQueue).toHaveLength(1)
    flushFrames()
    expect(cssVar(VV_HEIGHT_VAR)).toBe("544px")
  })

  it("键盘遮挡的像素数和终端原来的 kbdLiftPx 算法一致", () => {
    const { result } = renderHook(() => useVisualViewport(true))
    for (const [h, top] of [
      [544, 0],
      [544, 100],
      [814, 0],
      [764, 0],
      [844, 0],
    ] as const) {
      vv.set(h, top)
      flushFrames()
      expect(result.current.keyboardLift).toBe(kbdLiftPx(844, h, top))
    }
  })

  it("键盘遮住底部的像素数也写进 CSS 变量，给挂在根容器外面的抽屉用", () => {
    const a = renderHook(() => useVisualViewport(true))
    expect(cssVar(VV_KEYBOARD_LIFT_VAR)).toBe("0px")
    vv.set(544)
    flushFrames()
    expect(cssVar(VV_KEYBOARD_LIFT_VAR)).toBe("300px")
    a.unmount()
    expect(cssVar(VV_KEYBOARD_LIFT_VAR)).toBe("")
  })

  it("小于阈值的抖动（地址栏收起）不算键盘弹起", () => {
    const { result } = renderHook(() => useVisualViewport(true))
    vv.set(814)
    flushFrames()
    expect(result.current.keyboardOpen).toBe(false)
  })

  it("多个订阅方共用一份；全部退订后删掉变量", () => {
    const a = renderHook(() => useVisualViewport(true))
    const b = renderHook(() => useVisualViewport(true))
    vv.set(544)
    flushFrames()
    expect(a.result.current.keyboardOpen).toBe(true)
    expect(b.result.current.keyboardOpen).toBe(true)
    a.unmount()
    expect(cssVar(VV_HEIGHT_VAR)).toBe("544px")
    b.unmount()
    expect(cssVar(VV_HEIGHT_VAR)).toBe("")
    expect(cssVar(VV_OFFSET_TOP_VAR)).toBe("")
  })

  it("桌面布局（enabled=false）不监听、不写变量", () => {
    const { result } = renderHook(() => useVisualViewport(false))
    vv.set(544)
    flushFrames()
    expect(cssVar(VV_HEIGHT_VAR)).toBe("")
    expect(result.current.keyboardOpen).toBe(false)
    expect(result.current.height).toBeNull()
  })
})
