"use client"

import { useEffect } from "react"
import { getAccessibilityDisplayOptions } from "@/lib/tauri"

/**
 * Liquid Glass page-wide hooks, mounted once at the root:
 *
 * 1. System accessibility on desktop. WKWebView (macOS) and WebKitGTK (Linux)
 *    do not answer `prefers-reduced-transparency`, and WKWebView may not
 *    answer `prefers-contrast` either, so the desktop app asks the OS (Tauri
 *    command) on start and whenever the window regains focus — where a
 *    changed System Settings value shows up — and mirrors the answer as
 *    `data-glass-reduce-system` / `data-glass-contrast-system` on <html>.
 *    The browser keeps reading the media queries; this is a no-op there.
 * 2. Dark glass over dark content (6.3): see `flipSmallGlass`, re-run on
 *    scroll, resize and every 500ms.
 * 3. The hover light: interactive glass (`.lg-ia`) lights up from where the
 *    pointer is. One delegated listener sets `--mx` / `--my` on the glass
 *    under the pointer, so no component has to wire it.
 */
export function LiquidGlassInit() {
  useEffect(() => {
    let disposed = false
    const root = document.documentElement
    const sync = async () => {
      try {
        const options = await getAccessibilityDisplayOptions()
        if (disposed || !options) return
        toggle(root, "data-glass-reduce-system", options.reduceTransparency)
        toggle(root, "data-glass-contrast-system", options.increaseContrast)
      } catch {
        // An older desktop build without the command: keep the CSS defaults.
      }
    }
    void sync()
    window.addEventListener("focus", sync)
    return () => {
      disposed = true
      window.removeEventListener("focus", sync)
    }
  }, [])

  useEffect(() => {
    let frame = 0
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(run)
    }
    const run = () => {
      frame = 0
      flipSmallGlass(document)
    }
    const timer = window.setInterval(schedule, 500)
    document.addEventListener("scroll", schedule, {
      capture: true,
      passive: true,
    })
    window.addEventListener("resize", schedule)
    schedule()
    return () => {
      cancelAnimationFrame(frame)
      window.clearInterval(timer)
      document.removeEventListener("scroll", schedule, { capture: true })
      window.removeEventListener("resize", schedule)
    }
  }, [])

  useEffect(() => {
    const onMove = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const glass = target.closest<HTMLElement>(".lg-ia")
      if (!glass) return
      const rect = glass.getBoundingClientRect()
      if (!rect.width || !rect.height) return
      glass.style.setProperty(
        "--mx",
        `${(((event.clientX - rect.left) / rect.width) * 100).toFixed(1)}%`
      )
      glass.style.setProperty(
        "--my",
        `${(((event.clientY - rect.top) / rect.height) * 100).toFixed(1)}%`
      )
    }
    document.addEventListener("pointermove", onMove, { passive: true })
    return () => document.removeEventListener("pointermove", onMove)
  }, [])

  return null
}

/** Small glass only; the big panes change colour with the theme, never flip. */
const SMALL_GLASS = ".lg:not(.lg-pane):not(.lg-edge):not(.lg-bar)"
/** Relative luminance under which the content behind counts as dark. */
const DARK_BEHIND = 0.3

/**
 * 6.3: in light mode, small glass over dark content (a terminal, a dark code
 * block) turns into dark glass. For each visible small glass, look at the
 * first opaque non-glass element under its centre and toggle `lg-flip` by
 * that element's luminance. Solid, high contrast and dark mode never flip.
 */
export function flipSmallGlass(doc: Document) {
  const root = doc.documentElement
  const view = doc.defaultView
  const allowed =
    !root.classList.contains("dark") &&
    !root.matches(
      "[data-glass-reduce=on],[data-glass-reduce-system=on],[data-glass-contrast-system=on]"
    ) &&
    !view?.matchMedia?.("(prefers-reduced-transparency: reduce)").matches &&
    !view?.matchMedia?.("(prefers-contrast: more)").matches
  for (const glass of doc.querySelectorAll<HTMLElement>(SMALL_GLASS)) {
    const rect = glass.getBoundingClientRect()
    const dark =
      allowed &&
      rect.width > 0 &&
      rect.height > 0 &&
      isDarkBehind(doc, rect.left + rect.width / 2, rect.top + rect.height / 2)
    glass.classList.toggle("lg-flip", dark)
  }
}

function isDarkBehind(doc: Document, x: number, y: number): boolean {
  for (const el of doc.elementsFromPoint(x, y)) {
    if (el.closest(".lg")) continue
    const rgba = parseRgba(getComputedStyle(el).backgroundColor)
    if (!rgba || rgba[3] < 0.5) continue
    return luminance(rgba) < DARK_BEHIND
  }
  return false
}

let colorCanvas: CanvasRenderingContext2D | null | undefined

/** rgb()/rgba() directly; oklch()/oklab() and the rest through a 1×1 canvas. */
function parseRgba(value: string): [number, number, number, number] | null {
  if (value.startsWith("rgb")) {
    const parts = value.match(/[\d.]+/g)
    if (!parts || parts.length < 3) return null
    const [r, g, b, a = "1"] = parts
    return [Number(r), Number(g), Number(b), Number(a)]
  }
  if (colorCanvas === undefined) {
    const canvas = document.createElement("canvas")
    canvas.width = canvas.height = 1
    try {
      colorCanvas = canvas.getContext("2d", { willReadFrequently: true })
    } catch {
      colorCanvas = null
    }
  }
  if (!colorCanvas) return null
  colorCanvas.clearRect(0, 0, 1, 1)
  // A value the canvas cannot parse keeps the previous fillStyle; start from
  // transparent so it reads as "no background" rather than black.
  colorCanvas.fillStyle = "transparent"
  colorCanvas.fillStyle = value
  colorCanvas.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = colorCanvas.getImageData(0, 0, 1, 1).data
  return [r, g, b, a / 255]
}

function luminance([r, g, b]: [number, number, number, number]): number {
  const lin = (c: number) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
}

function toggle(root: HTMLElement, name: string, on: boolean) {
  if (on) root.setAttribute(name, "on")
  else root.removeAttribute(name)
}
