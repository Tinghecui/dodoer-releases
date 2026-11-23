import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// #1335：画布只认右键、中键拖动，手机上不做。手机布局下进到画布这个整页路由，
// 显示「请在电脑上使用」，返回回到会话

const state = vi.hoisted(() => ({
  mobile: true,
  routeId: "canvas" as string,
  openConversations: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({ isDesktop: () => false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: state.routeId,
    setRoute: vi.fn(),
    openConversations: state.openConversations,
  }),
}))
vi.mock("@/components/canvas/canvas-page", () => ({
  CanvasPage: () => <div data-testid="canvas-page" />,
  CanvasPageTitle: () => null,
}))
vi.mock("@/components/automations/automations-page", () => ({
  AutomationsPage: () => <div data-testid="automations-page" />,
  AutomationsPageTitle: () => null,
}))
vi.mock("@/components/apps/apps-page", () => ({
  AppsChromeActions: () => null,
  AppsPageTitle: () => null,
}))
vi.mock("@/components/forge/forge-chrome-actions", () => ({
  ForgeChromeActions: () => null,
}))
vi.mock("@/components/forge/forge-page", () => ({
  ForgePage: () => null,
  ForgePageTitle: () => null,
}))
vi.mock("@/components/tasks/tasks-chrome-actions", () => ({
  TasksChromeActions: () => null,
}))
vi.mock("@/components/tasks/tasks-page", () => ({
  TasksPage: () => null,
  TasksPageTitle: () => null,
}))
vi.mock("@/components/token-usage/token-usage-page", () => ({
  TokenUsagePage: () => null,
  TokenUsagePageTitle: () => null,
}))

import { WorkbenchRoutePage } from "./workbench-content"
import enMessages from "@/i18n/messages/en.json"

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkbenchRoutePage />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  state.mobile = true
  state.routeId = "canvas"
  state.openConversations.mockReset()
})

describe("画布路由在手机布局下", () => {
  it("显示请在电脑上使用，不挂载画布", () => {
    renderPage()
    expect(screen.getByRole("status")).toHaveTextContent(
      enMessages.DesktopOnly.message
    )
    expect(screen.queryByTestId("canvas-page")).toBeNull()
  })

  it("返回回到会话", () => {
    renderPage()
    fireEvent.click(
      screen.getByRole("button", { name: enMessages.DesktopOnly.back })
    )
    expect(state.openConversations).toHaveBeenCalledTimes(1)
  })

  it("宽屏照常挂载画布", () => {
    state.mobile = false
    renderPage()
    expect(screen.getByTestId("canvas-page")).toBeInTheDocument()
  })

  it("别的整页路由手机上照常", () => {
    state.routeId = "automations"
    renderPage()
    expect(screen.getByTestId("automations-page")).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })
})
