import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// #1335：导入会话（扫本机会话文件）手机上不做。手机布局下直接打开地址，
// 显示「请在电脑上使用」，不挂载导入窗口

const state = vi.hoisted(() => ({ mobile: true }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(""),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/contexts/remote-connection-context", () => ({
  RemoteConnectionGate: ({ children }: { children: React.ReactNode }) =>
    children,
}))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: ({ left }: { left?: React.ReactNode }) => (
    <div data-testid="title-bar">{left}</div>
  ),
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))
vi.mock("@/components/import-sessions/import-sessions-window", () => ({
  ImportSessionsWindow: () => <div data-testid="import-window" />,
}))

import ImportSessionsPage from "./page"
import enMessages from "@/i18n/messages/en.json"

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ImportSessionsPage />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  state.mobile = true
})

describe("导入会话页在手机布局下", () => {
  it("显示请在电脑上使用，不挂载导入窗口", async () => {
    renderPage()
    expect(await screen.findByRole("status")).toHaveTextContent(
      enMessages.DesktopOnly.message
    )
    expect(screen.queryByTestId("import-window")).toBeNull()
  })

  it("宽屏照常", async () => {
    state.mobile = false
    renderPage()
    expect(await screen.findByTestId("import-window")).toBeInTheDocument()
  })
})
