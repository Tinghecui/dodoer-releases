import { useEffect } from "react"
import { fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import { setInPageRouter } from "@/lib/in-page-navigation"
import { settingsTargetFor } from "@/lib/settings-scope"

// #1335：手机布局下设置导航不列只在电脑上有用的几页，直接打开它们的地址时
// 显示「请在电脑上使用」和返回按钮

const state = vi.hoisted(() => ({
  mobile: true,
  pathname: "/settings/general",
}))

vi.mock("next/navigation", () => ({
  usePathname: () => state.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: ({ left }: { left?: React.ReactNode }) => (
    <div data-testid="title-bar">{left}</div>
  ),
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))

import {
  SettingsShell,
  isSettingsPageHidden,
  settingsNavItemsFor,
} from "./settings-shell"

const DESKTOP_ONLY = [
  "/settings/shortcuts",
  "/settings/computer-use",
  "/settings/web-service",
  "/settings/browser",
]

const mounted = vi.fn()
function Page() {
  useEffect(() => {
    mounted()
  }, [])
  return <div data-testid="page" />
}

const router = { push: vi.fn(), back: vi.fn() }
let unregister: () => void = () => {}
const tauriWindow = window as unknown as Record<string, unknown>

function renderShell(pathname: string) {
  state.pathname = pathname
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SettingsShell>
        <Page />
      </SettingsShell>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  state.mobile = true
  mounted.mockClear()
  router.push.mockReset()
  router.back.mockReset()
  vi.spyOn(window.history, "length", "get").mockReturnValue(3)
  unregister = setInPageRouter(router)
})
afterEach(() => {
  unregister()
  vi.restoreAllMocks()
  delete tauriWindow.__TAURI_INTERNALS__
})

describe("settingsNavItemsFor 的手机条件", () => {
  it("手机下不列快捷键、本机电脑操控、网页服务、浏览器，其余照旧", () => {
    for (const env of ["web", "tauri"] as const) {
      const target = settingsTargetFor(env, null, null)
      const wide = settingsNavItemsFor(env, target).map((i) => i.href)
      const phone = settingsNavItemsFor(env, target, true).map((i) => i.href)
      for (const href of DESKTOP_ONLY) expect(phone).not.toContain(href)
      expect(phone).toEqual(wide.filter((h) => !DESKTOP_ONLY.includes(h)))
      expect(phone).toContain("/settings/general")
      expect(phone).toContain("/settings/system")
    }
  })

  it("宽屏的桌面版还是列这几页", () => {
    const hrefs = settingsNavItemsFor("tauri").map((i) => i.href)
    for (const href of DESKTOP_ONLY) expect(hrefs).toContain(href)
  })

  it("isSettingsPageHidden 跟着手机条件走", () => {
    const target = settingsTargetFor("tauri", null, null)
    for (const href of DESKTOP_ONLY) {
      expect(isSettingsPageHidden(href, "tauri", target, true)).toBe(true)
      expect(isSettingsPageHidden(href, "tauri", target)).toBe(false)
    }
    expect(
      isSettingsPageHidden("/settings/general", "tauri", target, true)
    ).toBe(false)
  })
})

describe("SettingsShell 在手机布局下", () => {
  it("导航抽屉里没有这几项", () => {
    renderShell("/settings/general")
    // 打开导航抽屉：标题栏左边第二个按钮
    const buttons = screen.getByTestId("title-bar").querySelectorAll("button")
    fireEvent.click(buttons[buttons.length - 1])
    expect(
      screen.getByRole("button", { name: en.SettingsShell.nav.general })
    ).toBeInTheDocument()
    for (const key of [
      "shortcuts",
      "computer_use",
      "web_service",
      "browser",
    ] as const) {
      expect(
        screen.queryByRole("button", { name: en.SettingsShell.nav[key] })
      ).toBeNull()
    }
  })

  it("直接打开快捷键页：不挂载页面，显示请在电脑上使用和返回", () => {
    renderShell("/settings/shortcuts")
    expect(mounted).not.toHaveBeenCalled()
    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent(en.DesktopOnly.message)
    fireEvent.click(
      within(notice).getByRole("button", { name: en.DesktopOnly.back })
    )
    expect(router.back).toHaveBeenCalledTimes(1)
  })

  it("宽屏打开快捷键页照常挂载", () => {
    state.mobile = false
    renderShell("/settings/shortcuts")
    expect(screen.getByTestId("page")).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })

  it("桌面版窗口拉窄了也照常挂载，不算手机", () => {
    tauriWindow.__TAURI_INTERNALS__ = {}
    renderShell("/settings/computer-use")
    expect(screen.getByTestId("page")).toBeInTheDocument()
    expect(screen.queryByRole("status")).toBeNull()
  })
})
