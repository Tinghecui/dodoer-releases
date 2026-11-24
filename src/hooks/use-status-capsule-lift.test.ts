import { afterEach, describe, expect, it } from "vitest"

import { act, renderHook } from "@testing-library/react"

import {
  statusCapsuleLift,
  useStatusCapsuleLift,
} from "./use-status-capsule-lift"

function rect(left: number, top: number, width: number, height: number) {
  return {
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect
}

function addCapsule(r: DOMRect) {
  const el = document.createElement("div")
  el.setAttribute("data-status-capsule", "left")
  el.getBoundingClientRect = () => r
  document.body.appendChild(el)
  return el
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("statusCapsuleLift", () => {
  it("lifts by the capsule's height plus a gap when it overlaps the content in the bottom band", () => {
    addCapsule(rect(12, 854, 200, 32))
    expect(statusCapsuleLift(rect(100, 800, 700, 80), 900)).toBe(40)
  })

  it("does not lift when the capsule sits beside the content", () => {
    addCapsule(rect(12, 854, 80, 32))
    expect(statusCapsuleLift(rect(100, 800, 700, 80), 900)).toBe(0)
  })

  it("does not lift when the capsule is well above the bottom band", () => {
    addCapsule(rect(12, 400, 200, 32))
    expect(statusCapsuleLift(rect(100, 800, 700, 80), 900)).toBe(0)
  })

  it("does not lift when the capsule sits entirely below the container (e.g. a bottom terminal pushes the content up)", () => {
    // 容器下沿在 600，底部终端在下面；胶囊在窗口最底部 854～886
    addCapsule(rect(12, 854, 200, 32))
    expect(statusCapsuleLift(rect(100, 500, 700, 80), 600)).toBe(0)
    // 胶囊顶刚好贴着容器下沿，也不算压住
    expect(statusCapsuleLift(rect(100, 774, 700, 80), 854)).toBe(0)
  })

  it("does not lift without a capsule or without measurable content", () => {
    expect(statusCapsuleLift(rect(100, 800, 700, 80), 900)).toBe(0)
    addCapsule(rect(12, 854, 200, 32))
    expect(statusCapsuleLift(rect(0, 0, 0, 0), 900)).toBe(0)
    expect(statusCapsuleLift(undefined, 900)).toBe(0)
  })
})

describe("useStatusCapsuleLift", () => {
  const originalRO = globalThis.ResizeObserver
  let observed: Element[] = []
  let fire: (() => void) | null = null

  afterEach(() => {
    globalThis.ResizeObserver = originalRO
    observed = []
    fire = null
  })

  it("recomputes when an ancestor resizes even though the container keeps its size (a bottom terminal opens)", async () => {
    globalThis.ResizeObserver = class {
      constructor(cb: ResizeObserverCallback) {
        fire = () => cb([], this as unknown as ResizeObserver)
      }
      observe(el: Element) {
        observed.push(el)
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver

    // 外层是会被底部终端压矮的那一栏，容器本身高度不变、只是位置往上挪
    const column = document.createElement("div")
    const footer = document.createElement("div")
    const content = document.createElement("div")
    footer.appendChild(content)
    column.appendChild(footer)
    document.body.appendChild(column)
    let contentRect = rect(100, 800, 700, 80)
    let footerRect = rect(0, 800, 1000, 100)
    content.getBoundingClientRect = () => contentRect
    footer.getBoundingClientRect = () => footerRect
    addCapsule(rect(12, 854, 200, 32))

    const ref = { current: footer }
    const { result } = renderHook(() => useStatusCapsuleLift(ref))
    expect(result.current).toBe(40)
    // 观察的不只是容器本身，还有它所在的那一栏
    expect(observed).toContain(column)

    // 打开底部终端：容器尺寸不变，整体挪到上面
    contentRect = rect(100, 500, 700, 80)
    footerRect = rect(0, 500, 1000, 100)
    await act(async () => {
      fire?.()
      await new Promise((r) => requestAnimationFrame(() => r(null)))
    })
    expect(result.current).toBe(0)
  })
})
