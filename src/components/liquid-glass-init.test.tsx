import { act, render } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

const getAccessibilityDisplayOptions = vi.fn()
vi.mock("@/lib/tauri", () => ({
  getAccessibilityDisplayOptions: () => getAccessibilityDisplayOptions(),
}))

import { LiquidGlassInit, flipSmallGlass } from "./liquid-glass-init"

const root = document.documentElement

afterEach(() => {
  getAccessibilityDisplayOptions.mockReset()
  root.removeAttribute("data-glass-reduce-system")
  root.removeAttribute("data-glass-contrast-system")
})

describe("LiquidGlassInit", () => {
  it("mirrors the system reduce-transparency and contrast settings on <html>", async () => {
    getAccessibilityDisplayOptions.mockResolvedValue({
      reduceTransparency: true,
      increaseContrast: true,
    })
    await act(async () => {
      render(<LiquidGlassInit />)
    })
    expect(root.getAttribute("data-glass-reduce-system")).toBe("on")
    expect(root.getAttribute("data-glass-contrast-system")).toBe("on")
  })

  it("re-reads the settings when the window regains focus", async () => {
    getAccessibilityDisplayOptions.mockResolvedValue({
      reduceTransparency: true,
      increaseContrast: false,
    })
    await act(async () => {
      render(<LiquidGlassInit />)
    })
    expect(root.getAttribute("data-glass-reduce-system")).toBe("on")
    expect(root.hasAttribute("data-glass-contrast-system")).toBe(false)

    getAccessibilityDisplayOptions.mockResolvedValue({
      reduceTransparency: false,
      increaseContrast: true,
    })
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    expect(root.hasAttribute("data-glass-reduce-system")).toBe(false)
    expect(root.getAttribute("data-glass-contrast-system")).toBe("on")
  })

  it("leaves the page alone outside the desktop app", async () => {
    getAccessibilityDisplayOptions.mockResolvedValue(null)
    await act(async () => {
      render(<LiquidGlassInit />)
    })
    expect(root.hasAttribute("data-glass-reduce-system")).toBe(false)
    expect(root.hasAttribute("data-glass-contrast-system")).toBe(false)
  })
})

describe("flipSmallGlass", () => {
  const originalElementsFromPoint = document.elementsFromPoint
  const behind = document.createElement("div")
  const glass = document.createElement("button")
  glass.className = "lg lg-ia"

  const setup = (background: string) => {
    behind.style.backgroundColor = background
    document.body.append(behind, glass)
    glass.getBoundingClientRect = () =>
      ({ left: 10, top: 10, width: 32, height: 32 }) as DOMRect
    document.elementsFromPoint = () => [glass, behind, document.body]
  }

  afterEach(() => {
    behind.remove()
    glass.remove()
    glass.classList.remove("lg-flip")
    root.classList.remove("dark")
    root.removeAttribute("data-glass-reduce")
    document.elementsFromPoint = originalElementsFromPoint
  })

  it("turns small glass dark over dark content in light mode", () => {
    setup("rgb(20, 20, 22)")
    flipSmallGlass(document)
    expect(glass.classList.contains("lg-flip")).toBe(true)
  })

  it("keeps light glass over light content", () => {
    setup("rgb(250, 250, 250)")
    flipSmallGlass(document)
    expect(glass.classList.contains("lg-flip")).toBe(false)
  })

  it("never flips in dark mode or with solid glass", () => {
    setup("rgb(20, 20, 22)")
    root.classList.add("dark")
    flipSmallGlass(document)
    expect(glass.classList.contains("lg-flip")).toBe(false)
    root.classList.remove("dark")
    root.setAttribute("data-glass-reduce", "on")
    flipSmallGlass(document)
    expect(glass.classList.contains("lg-flip")).toBe(false)
  })

  it("leaves the big panes alone", () => {
    setup("rgb(20, 20, 22)")
    glass.classList.add("lg-pane")
    flipSmallGlass(document)
    expect(glass.classList.contains("lg-flip")).toBe(false)
    glass.classList.remove("lg-pane")
  })
})
