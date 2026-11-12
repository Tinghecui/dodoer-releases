import { render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const viewport = vi.hoisted(() => ({ mobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }))
vi.mock("@/components/layout/status-bar-stats", () => ({
  StatusBarStats: () => null,
}))
vi.mock("@/components/layout/status-bar-tasks", () => ({
  StatusBarTasks: () => null,
}))
vi.mock("@/components/layout/status-bar-alerts", () => ({
  StatusBarAlerts: () => null,
}))
vi.mock("@/components/layout/status-bar-mcp", () => ({
  StatusBarMcp: () => null,
}))
vi.mock("@/components/layout/status-bar-computer", () => ({
  StatusBarComputer: () => null,
}))
vi.mock("@/components/layout/status-bar-update", () => ({
  StatusBarUpdate: () => null,
}))
vi.mock("@/components/layout/command-dropdown", () => ({
  CommandDropdown: () => null,
}))
vi.mock("@/components/layout/quick-actions-dropdown", () => ({
  QuickActionsDropdown: () => null,
}))
vi.mock("@/components/layout/status-bar-web-service", () => ({
  StatusBarWebService: () => <span data-testid="web-service" />,
}))
vi.mock("@/components/cowork/account-menu", () => ({
  CoworkAccountMenu: ({ side }: { side?: string }) => (
    <div data-testid="cowork-account" data-side={side} />
  ),
}))

vi.mock("@/components/cowork/resource-meter", () => ({
  ResourceMeter: () => <div data-testid="resource-meter" />,
}))

import { StatusBar, StatusBarLeft, StatusBarRight } from "./status-bar"

beforeEach(() => {
  viewport.mobile = false
})

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

describe("StatusBar", () => {
  /** "Narrow" is a viewport width, and a desktop window can be shrunk below
   *  it: the web-service signal must not vanish with it. (The item itself
   *  renders nothing outside the local desktop.) Wide, the bar itself draws
   *  nothing (Liquid Glass) and its right half sits at the foot of the aux
   *  panel — the item is carried there. */
  it.each([
    ["wide", false],
    ["narrow", true],
  ])("carries the web-service item in the %s layout", (_label, mobile) => {
    viewport.mobile = mobile
    render(mobile ? <StatusBar /> : <StatusBarRight />)
    expect(screen.getByTestId("web-service")).toBeInTheDocument()
  })
})
