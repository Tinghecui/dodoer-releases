import { cleanup, render, screen } from "@testing-library/react"
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
vi.mock("@/components/layout/status-bar-chrome", () => ({
  StatusBarChrome: () => <span data-testid="chrome" />,
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
vi.mock("@/components/cowork/status-bar-host-ssh", () => ({
  StatusBarHostSsh: () => <span data-testid="host-ssh" />,
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

  /** Cowork: a lent computer is a thing exposed, like the web service — its
   *  mark sits right after it in the narrow bar. (The item itself renders
   *  nothing outside a remote desktop window.) */
  it("carries the lent-computer item in the narrow layout", () => {
    viewport.mobile = true
    render(<StatusBar />)
    expect(screen.getByTestId("web-service").nextElementSibling).toBe(
      screen.getByTestId("host-ssh")
    )
  })

  /** Wide, the right half is behind the top-right status button: a lent
   *  computer must not be hidden there. It leads the sidebar foot's far
   *  end, beside the server's name, always on screen. */
  it("puts the lent-computer item in the sidebar foot when wide", () => {
    render(<StatusBarRight />)
    expect(screen.queryByTestId("host-ssh")).toBeNull()
    cleanup()
    render(<StatusBarLeft />)
    const item = screen.getByTestId("host-ssh")
    expect(item.parentElement?.firstElementChild).toBe(item)
  })

  /** The Chrome glyph's colour is the connection's state: behind the
   *  top-right status button it would say nothing. It follows the
   *  lent-computer item, before the resource meter. */
  it("puts the Chrome item in the sidebar foot when wide", () => {
    render(<StatusBarRight />)
    expect(screen.queryByTestId("chrome")).toBeNull()
    cleanup()
    render(<StatusBarLeft />)
    const item = screen.getByTestId("chrome")
    expect(item.previousElementSibling).toBe(screen.getByTestId("host-ssh"))
    expect(item.nextElementSibling).toBe(screen.getByTestId("resource-meter"))
  })

  it("carries the Chrome item in the narrow layout", () => {
    viewport.mobile = true
    render(<StatusBar />)
    expect(screen.getByTestId("host-ssh").nextElementSibling).toBe(
      screen.getByTestId("chrome")
    )
  })
})
