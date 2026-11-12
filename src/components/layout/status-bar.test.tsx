import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/layout/quick-actions-dropdown", () => ({
  QuickActionsDropdown: () => <div data-testid="quick-actions" />,
}))
vi.mock("@/components/layout/status-bar-stats", () => ({
  StatusBarStats: () => <div data-testid="stats" />,
}))
vi.mock("@/components/cowork/account-menu", () => ({
  CoworkAccountMenu: ({ side }: { side?: string }) => (
    <div data-testid="cowork-account" data-side={side} />
  ),
}))

vi.mock("@/components/cowork/resource-meter", () => ({
  ResourceMeter: () => <div data-testid="resource-meter" />,
}))

import { StatusBarLeft } from "./status-bar"

describe("StatusBarLeft", () => {
  it("ends with the Cowork account menu, opening upward", () => {
    render(<StatusBarLeft />)
    const menu = screen.getByTestId("cowork-account")
    expect(menu.parentElement?.lastElementChild).toBe(menu)
    expect(menu).toHaveAttribute("data-side", "top")
  })

  it("puts the resource meter beside it, at the far end", () => {
    render(<StatusBarLeft />)
    const meter = screen.getByTestId("resource-meter")
    expect(meter.nextElementSibling).toBe(screen.getByTestId("cowork-account"))
    expect(meter.parentElement?.className).toContain("ml-auto")
    expect(meter.parentElement?.parentElement?.lastElementChild).toBe(
      meter.parentElement
    )
  })
})
