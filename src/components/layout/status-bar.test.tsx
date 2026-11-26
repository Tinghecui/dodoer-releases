import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const viewport = vi.hoisted(() => ({ mobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => viewport.mobile }))
vi.mock("@/components/layout/status-bar-stats", () => ({
  StatusBarStats: () => <span data-testid="stats" />,
}))
vi.mock("@/components/layout/status-bar-tasks", () => ({
  StatusBarTasks: () => <span data-testid="tasks" />,
}))
vi.mock("@/components/layout/status-bar-alerts", () => ({
  StatusBarAlerts: () => <span data-testid="alerts" />,
}))
vi.mock("@/components/layout/status-bar-mcp", () => ({
  StatusBarMcp: () => <span data-testid="mcp" />,
}))
vi.mock("@/components/layout/status-bar-computer", () => ({
  StatusBarComputer: () => <span data-testid="computer" />,
}))
vi.mock("@/components/layout/status-bar-chrome", () => ({
  StatusBarChrome: () => <span data-testid="chrome" />,
}))
vi.mock("@/components/layout/status-bar-update", () => ({
  StatusBarUpdate: () => <span data-testid="update" />,
}))
vi.mock("@/components/layout/command-dropdown", () => ({
  CommandDropdown: () => <span data-testid="command" />,
}))
vi.mock("@/components/layout/quick-actions-dropdown", () => ({
  QuickActionsDropdown: () => <span data-testid="quick-actions" />,
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
vi.mock("@/components/cowork/status-bar-devices", () => ({
  StatusBarDevices: () => <span data-testid="devices" />,
}))

import { StatusBar, StatusBarLeft, StatusBarRight } from "./status-bar"

/** 手机布局的「更多」按钮要用翻译；其余用例照旧直接渲染。 */
function renderIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

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
  it("carries the web-service item in the wide layout", () => {
    render(<StatusBarRight />)
    expect(screen.getByTestId("web-service")).toBeInTheDocument()
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
    expect(item.nextElementSibling).toBe(screen.getByTestId("devices"))
  })

  /** The person's devices: with the other two that say what a computer
   *  hands over. */
  it("puts the devices after them, wide and narrow", () => {
    render(<StatusBarRight />)
    expect(screen.queryByTestId("devices")).toBeNull()
    cleanup()
    render(<StatusBarLeft />)
    const item = screen.getByTestId("devices")
    expect(item.previousElementSibling).toBe(screen.getByTestId("chrome"))
    expect(item.nextElementSibling).toBe(screen.getByTestId("resource-meter"))
  })
})

/** 手机布局（#1334 完成标准 5）：一行里只直接放会变红、变黄的提醒类的项和账户，
 *  其余收进「更多」，390px 宽也不溢出、不截断。 */
describe("StatusBar on a phone", () => {
  const DIRECT = ["host-ssh", "chrome", "mcp", "alerts", "resource-meter"]
  const IN_MORE = [
    "quick-actions",
    "stats",
    "update",
    "command",
    "web-service",
    "devices",
  ]

  beforeEach(() => {
    viewport.mobile = true
  })

  it("shows only the alert items and the account directly", () => {
    renderIntl(<StatusBar />)
    const direct = screen.getByTestId("status-bar-direct")
    const ids = Array.from(direct.children).map((el) =>
      el.getAttribute("data-testid")
    )
    expect(ids).toEqual([...DIRECT, "cowork-account"])
    for (const id of IN_MORE) {
      expect(screen.queryByTestId(id)).toBeNull()
    }
  })

  it("puts every other item in the More menu", () => {
    renderIntl(<StatusBar />)
    fireEvent.click(screen.getByRole("button", { name: "More" }))
    const menu = screen.getByTestId("status-bar-more")
    const ids = Array.from(menu.querySelectorAll("[data-testid]")).map((el) =>
      el.getAttribute("data-testid")
    )
    expect(ids).toEqual(IN_MORE)
    // 收进菜单的项不会再在直接显示的那一排里出现第二份。
    for (const id of DIRECT) {
      expect(menu.querySelector(`[data-testid="${id}"]`)).toBeNull()
    }
  })

  it("keeps the bar to one row that cannot overflow at 390px", () => {
    renderIntl(<StatusBar />)
    const bar = screen.getByTestId("status-bar-mobile")
    expect(bar.className).toContain("overflow-hidden")
    expect(bar.className).toContain("min-w-0")
    const direct = screen.getByTestId("status-bar-direct")
    // 直接显示的一排不缩、不截断，剩下的宽度归「更多」按钮那一侧。
    expect(direct.className).toContain("shrink-0")
    expect(direct.className).not.toContain("truncate")
  })
})
