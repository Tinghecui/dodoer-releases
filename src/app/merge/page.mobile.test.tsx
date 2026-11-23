import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// #1335：合并编辑器（三栏）不做手机版。手机布局下直接打开合并页的地址，
// 显示「请在电脑上使用」和返回按钮，不挂载合并编辑器、不报错

const state = vi.hoisted(() => ({
  mobile: true,
  back: vi.fn(),
  push: vi.fn(),
  getFolder: vi.fn(async () => ({ id: 1, name: "repo", path: "/repo" })),
}))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("folderId=1"),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/lib/api", () => ({ getFolder: state.getFolder }))
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
vi.mock("@/components/merge/merge-workspace", () => ({
  MergeWorkspace: () => <div data-testid="merge-workspace" />,
}))

import MergePage from "./page"
import enMessages from "@/i18n/messages/en.json"
import { setInPageRouter } from "@/lib/in-page-navigation"

let unregister: () => void = () => {}

beforeEach(() => {
  state.mobile = true
  state.back.mockReset()
  state.push.mockReset()
  state.getFolder.mockClear()
  vi.spyOn(window.history, "length", "get").mockReturnValue(2)
  unregister = setInPageRouter({ push: state.push, back: state.back })
})
afterEach(() => {
  unregister()
  vi.restoreAllMocks()
})

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MergePage />
    </NextIntlClientProvider>
  )

describe("合并页在手机布局下", () => {
  it("显示请在电脑上使用，不挂载合并编辑器、不读仓库", async () => {
    renderPage()
    expect(await screen.findByRole("status")).toHaveTextContent(
      enMessages.DesktopOnly.message
    )
    expect(screen.queryByTestId("merge-workspace")).toBeNull()
    expect(state.getFolder).not.toHaveBeenCalled()
  })

  it("提示里的返回按钮回到上一页", async () => {
    renderPage()
    const notice = await screen.findByRole("status")
    fireEvent.click(
      within(notice).getByRole("button", { name: enMessages.DesktopOnly.back })
    )
    expect(state.back).toHaveBeenCalledTimes(1)
  })

  it("宽屏照常打开合并编辑器", async () => {
    state.mobile = false
    renderPage()
    expect(await screen.findByTestId("merge-workspace")).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })
})
