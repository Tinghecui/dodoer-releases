import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// #1332：手机布局下提交页是在当前页里打开的：标题栏左边有返回，提交完回到上一页

const mocks = vi.hoisted(() => ({ push: vi.fn(), back: vi.fn() }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("folderId=1"),
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
  isDesktop: () => false,
  getActiveRemoteConnectionId: () => null,
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => true }))
vi.mock("@/lib/api", () => ({
  getFolder: async () => ({ id: 1, name: "repo", path: "/repo" }),
}))
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
vi.mock("@/contexts/git-credential-context", () => ({
  GitCredentialProvider: ({ children }: { children: React.ReactNode }) =>
    children,
}))
vi.mock("@/components/layout/commit-dialog", () => ({
  CommitWorkspace: ({ onCommitted }: { onCommitted: () => void }) => (
    <button onClick={onCommitted}>commit</button>
  ),
}))

import CommitPage from "./page"
import enMessages from "@/i18n/messages/en.json"
import { setInPageRouter } from "@/lib/in-page-navigation"

let unregister: () => void = () => {}

beforeEach(() => {
  mocks.push.mockReset()
  mocks.back.mockReset()
  vi.spyOn(window.history, "length", "get").mockReturnValue(2)
  // 关页面时用的是不走 hook 的手机判断
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches: true,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  )
  unregister = setInPageRouter({ push: mocks.push, back: mocks.back })
})
afterEach(() => {
  unregister()
  vi.restoreAllMocks()
})

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CommitPage />
    </NextIntlClientProvider>
  )

describe("提交页在手机布局下", () => {
  it("标题栏左边有返回按钮，点了后退", async () => {
    renderPage()
    const bar = await screen.findByTestId("title-bar")
    const back = bar.querySelector("button")
    expect(back?.getAttribute("aria-label")).toBe("Back")
    fireEvent.click(back!)
    expect(mocks.back).toHaveBeenCalledTimes(1)
  })

  it("提交完回到上一页，不关窗口", async () => {
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    renderPage()
    fireEvent.click(await screen.findByRole("button", { name: "commit" }))
    await vi.waitFor(() => expect(mocks.back).toHaveBeenCalledTimes(1))
    expect(close).not.toHaveBeenCalled()
  })
})
