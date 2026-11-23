import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import { setInPageRouter } from "@/lib/in-page-navigation"

// #1332：手机布局下设置页在当前页打开，标题栏左边有返回按钮

const state = vi.hoisted(() => ({ mobile: true }))

vi.mock("next/navigation", () => ({
  usePathname: () => "/settings/general",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: ({ left }: { left?: React.ReactNode }) => (
    <div data-testid="title-bar">{left}</div>
  ),
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))

import { SettingsShell } from "./settings-shell"

const router = { push: vi.fn(), back: vi.fn() }
let unregister: () => void = () => {}
let historyLength = 1

const shell = () => (
  <NextIntlClientProvider locale="en" messages={en}>
    <SettingsShell>
      <div />
    </SettingsShell>
  </NextIntlClientProvider>
)

beforeEach(() => {
  state.mobile = true
  historyLength = 1
  router.push.mockReset()
  router.back.mockReset()
  vi.spyOn(window.history, "length", "get").mockImplementation(
    () => historyLength
  )
  unregister = setInPageRouter(router)
})
afterEach(() => {
  unregister()
  vi.restoreAllMocks()
})

const backButton = () =>
  screen.queryByRole("button", { name: en.Folder.windowControls.back })

describe("设置页的返回按钮", () => {
  it("手机布局下有，有历史记录就后退", () => {
    historyLength = 4
    render(shell())
    fireEvent.click(backButton()!)
    expect(router.back).toHaveBeenCalledTimes(1)
  })

  it("没有历史记录就回到工作区", () => {
    render(shell())
    fireEvent.click(backButton()!)
    expect(router.push).toHaveBeenCalledWith("/workspace")
  })

  it("宽屏没有", () => {
    state.mobile = false
    render(shell())
    expect(backButton()).toBeNull()
  })
})
