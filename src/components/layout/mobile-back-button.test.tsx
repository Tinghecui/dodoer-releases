import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import { navigateInPage, setInPageRouter } from "@/lib/in-page-navigation"

const media = vi.hoisted(() => ({ mobile: true, desktop: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => media.mobile }))
vi.mock("@/lib/transport", () => ({ isDesktop: () => media.desktop }))

import { MobileBackButton } from "./mobile-back-button"

const router = { push: vi.fn(), back: vi.fn() }
let unregister: () => void = () => {}
let historyLength = 1

const renderButton = () =>
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <MobileBackButton />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  media.mobile = true
  media.desktop = false
  historyLength = 1
  router.push.mockReset()
  router.back.mockReset()
  vi.spyOn(window.history, "length", "get").mockImplementation(
    () => historyLength
  )
  unregister = setInPageRouter(router)
})

afterEach(() => {
  // 清掉「在当前页打开」的记录
  navigateInPage("/workspace")
  window.history.replaceState({}, "", "/")
  unregister()
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).__CODEG_SHELL__
})

describe("MobileBackButton（#1332）", () => {
  it("有历史记录就后退", () => {
    historyLength = 3
    renderButton()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.push).not.toHaveBeenCalled()
  })

  it("没有历史记录就回到工作区", () => {
    renderButton()
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(router.push).toHaveBeenCalledWith("/workspace")
    expect(router.back).not.toHaveBeenCalled()
  })

  it("宽屏不显示", () => {
    media.mobile = false
    renderButton()
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  })

  it("iOS 壳里即使宽屏也显示", () => {
    media.mobile = false
    ;(window as unknown as Record<string, unknown>).__CODEG_SHELL__ = "ios"
    renderButton()
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
  })
  it("桌面版窗口再窄也不显示（那时这些页面是独立窗口）", () => {
    media.desktop = true
    renderButton()
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  })

  it("在当前页打开以后把浏览器拉宽，仍显示", () => {
    navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/commit?folderId=1")
    media.mobile = false
    renderButton()
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
  })
})
