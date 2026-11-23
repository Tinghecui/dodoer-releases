import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import { roomAbovePx, useRoomAbove } from "./upward-menu"

describe("roomAbovePx", () => {
  it("is the space between the visible top and the anchor, minus the gap and a margin", () => {
    // 可见区域从 100 开始（键盘把页面往上推了），输入框顶边在 400，间距 6，留 8。
    expect(roomAbovePx(400, 100, 6)).toBe(286)
  })

  it("shrinks as the composer grows taller", () => {
    expect(roomAbovePx(150, 100, 6)).toBe(36)
  })

  it("never goes below zero", () => {
    expect(roomAbovePx(90, 100, 6)).toBe(0)
  })
})

/** 一个可以改 offsetTop、手动发 resize 的假 visualViewport。 */
function stubVisualViewport(offsetTop: number) {
  const target = new EventTarget()
  const vv = Object.assign(target, { offsetTop, height: 500, width: 390 })
  vi.stubGlobal("visualViewport", vv)
  return vv
}

describe("useRoomAbove", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("measures the room while active and follows the keyboard", () => {
    const vv = stubVisualViewport(0)
    const anchor = document.createElement("div")
    let top = 600
    anchor.getBoundingClientRect = () => ({ top }) as DOMRect
    const ref = { current: anchor }

    const { result, rerender } = renderHook(
      ({ active }) => useRoomAbove(ref, active, 6),
      { initialProps: { active: false } }
    )
    expect(result.current).toBeNull()

    rerender({ active: true })
    expect(result.current).toBe(586)

    // 键盘弹起：页面被推上去 200，输入框跟着可见区域走。
    top = 450
    vv.offsetTop = 200
    act(() => {
      vv.dispatchEvent(new Event("resize"))
    })
    expect(result.current).toBe(236)

    rerender({ active: false })
    expect(result.current).toBeNull()
  })

  it("re-measures on the next frame, after the root has shrunk to the new visible height", () => {
    const vv = stubVisualViewport(0)
    // 手动推进的 requestAnimationFrame：工作区根容器的 --app-vvh 是在下一帧才写进去的。
    let frames: FrameRequestCallback[] = []
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
      frames.push(cb)
      return frames.length
    })
    vi.stubGlobal("cancelAnimationFrame", () => {})
    const flushFrame = () => {
      const pending = frames
      frames = []
      for (const cb of pending) cb(0)
    }
    const anchor = document.createElement("div")
    let top = 600
    anchor.getBoundingClientRect = () => ({ top }) as DOMRect
    const ref = { current: anchor }

    const { result } = renderHook(() => useRoomAbove(ref, true, 6))
    expect(result.current).toBe(586)

    // 视口变矮：resize 时布局还是旧的，下一帧根容器变矮、输入框才往上移。
    vv.height = 300
    act(() => {
      vv.dispatchEvent(new Event("resize"))
    })
    top = 400
    act(() => {
      flushFrame()
    })
    expect(result.current).toBe(386)
  })
})
