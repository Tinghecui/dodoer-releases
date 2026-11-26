import { render } from "@testing-library/react"
import { describe, expect, it } from "vitest"

import { RowChevron } from "./activity-row"

// 工具调用行的展开箭头：有鼠标时悬停才出现；不能悬停的设备上一直半透明显示。
describe("RowChevron on devices without hover", () => {
  it("stays visible on a hover-less device while folded", () => {
    const { container } = render(<RowChevron open={false} />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveClass(
      "opacity-0",
      "group-hover/row:opacity-100",
      "[@media(hover:none)]:opacity-70"
    )
  })

  it("is fully shown once open, not dimmed by the touch fallback", () => {
    const { container } = render(<RowChevron open />)
    const svg = container.querySelector("svg")
    expect(svg).toHaveClass("opacity-100")
    expect(svg).not.toHaveClass("[@media(hover:none)]:opacity-70")
  })
})
