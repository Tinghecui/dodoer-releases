import { renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it } from "vitest"

import { useIsMobile } from "./use-mobile"

const realMatchMedia = window.matchMedia

/**
 * 按给定的视口尺寸和指针类型真的去解析 media query（逗号是「或」，
 * `and` 两边都要满足），而不是写死一个布尔值。
 */
function setDevice(width: number, height: number, coarse: boolean) {
  const test = (feature: string) => {
    const m = /\((max-width|max-height|pointer):\s*([^)]+)\)/.exec(feature)
    if (!m) return false
    const [, name, value] = m
    if (name === "max-width") return width <= parseInt(value, 10)
    if (name === "max-height") return height <= parseInt(value, 10)
    return (value.trim() === "coarse") === coarse
  }
  window.matchMedia = ((query: string) => ({
    matches: query
      .split(",")
      .some((part) => part.split(/\band\b/).every((f) => test(f.trim()))),
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia
}

afterEach(() => {
  window.matchMedia = realMatchMedia
})

describe("useIsMobile", () => {
  it("竖屏手机（宽 767 以下）算手机布局", () => {
    setDevice(390, 844, true)
    expect(renderHook(() => useIsMobile()).result.current).toBe(true)
  })

  it("iPhone 横屏（粗指针、高 500 以下）也算手机布局", () => {
    setDevice(844, 390, true)
    expect(renderHook(() => useIsMobile()).result.current).toBe(true)
  })

  it("有鼠标的矮窗口不算手机布局", () => {
    setDevice(1280, 480, false)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })

  it("平板横屏（粗指针但高度够）不算手机布局", () => {
    setDevice(1180, 820, true)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })

  it("桌面宽窗口不算手机布局", () => {
    setDevice(1280, 800, false)
    expect(renderHook(() => useIsMobile()).result.current).toBe(false)
  })
})
