import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { Button } from "./button"
import { TOUCH_GAP_0_5 } from "@/lib/touch-target"

// 触屏：最小的两档按钮（xs、icon-xs，都是 24px 高）在粗指针设备上，用一块
// 看不见的 ::after 把点按区域撑到 40×40；按钮自己的尺寸和图标不变。
describe("Button coarse-pointer hit area", () => {
  it.each(["xs", "icon-xs"] as const)(
    "widens the %s hit area to 40px without resizing it",
    (size) => {
      render(
        <Button size={size} aria-label="go">
          x
        </Button>
      )
      const button = screen.getByRole("button", { name: "go" })
      expect(button).toHaveClass(
        "relative",
        size === "xs" ? "h-6" : "size-6",
        "pointer-coarse:after:absolute",
        "pointer-coarse:after:top-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-room-top,20px)*-1))]",
        "pointer-coarse:after:bottom-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-room-bottom,20px)*-1))]",
        "pointer-coarse:after:start-[min(0px,calc(50%-20px))]",
        "pointer-coarse:after:end-[min(0px,calc(50%-20px))]"
      )
    }
  )

  // 两个小按钮挨着（Mermaid 工具栏的放大和重置只隔 2px）：挨着的那一侧各自
  // 最多伸进半个间距（那一行用 TOUCH_GAP_* 告诉的 --touch-gap），中间平分、
  // 互不重叠。具体的矩形在 touch-target.test.ts 里用编出来的 CSS 算。
  it("keeps neighbouring buttons' hit areas off each other", () => {
    render(
      <div className={`flex ${TOUCH_GAP_0_5}`}>
        <Button size="icon-xs" aria-label="zoom">
          +
        </Button>
        <Button size="icon-xs" aria-label="reset">
          r
        </Button>
      </div>
    )
    for (const name of ["zoom", "reset"]) {
      expect(screen.getByRole("button", { name })).toHaveClass(
        "pointer-coarse:[--touch-hit-gap:var(--touch-gap,0px)]",
        "pointer-coarse:[&:not(:first-child)]:after:start-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-gap,0px)/-2))]",
        "pointer-coarse:[&:not(:last-child)]:after:end-[max(min(0px,calc(50%-20px)),calc(var(--touch-hit-gap,0px)/-2))]"
      )
    }
    // 横向不靠 translate 居中：translate 不随文字方向翻转，阿拉伯语下会偏
    const reset = screen.getByRole("button", { name: "reset" })
    expect(reset.className).not.toContain("translate-x")
  })

  it("leaves the larger sizes alone", () => {
    render(
      <Button size="icon" aria-label="go">
        x
      </Button>
    )
    const button = screen.getByRole("button", { name: "go" })
    expect(button.className).not.toContain("pointer-coarse:after")
    expect(button).not.toHaveClass("relative")
  })

  it("lets a caller's own positioning replace the relative anchor", () => {
    render(
      <Button size="icon-xs" className="absolute right-1" aria-label="go">
        x
      </Button>
    )
    const button = screen.getByRole("button", { name: "go" })
    expect(button).toHaveClass("absolute", "pointer-coarse:after:absolute")
    expect(button).not.toHaveClass("relative")
  })
})
