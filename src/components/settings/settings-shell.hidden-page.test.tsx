import { useEffect } from "react"
import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider, type Locale } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"
import { coworkText } from "@/lib/cowork/i18n"
import { settingsTargetFor } from "@/lib/settings-scope"
import type { TransportEnvironment } from "@/lib/transport/detect"

const nav = vi.hoisted(() => ({ pathname: "/settings/web-service" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))

import {
  SettingsShell,
  isSettingsPageHidden,
  settingsNavItemsFor,
} from "./settings-shell"

const mounted = vi.fn()
const tauriWindow = window as unknown as Record<string, unknown>

// Stands in for a settings page: what matters is whether it mounts at all
// (the Web service page loads the server's status and auto-saves on mount).
function Page() {
  useEffect(() => {
    mounted()
  }, [])
  return <div data-testid="page" />
}

function renderShell(pathname: string, locale: Locale = "en") {
  nav.pathname = pathname
  return render(
    <NextIntlClientProvider locale={locale} messages={en}>
      <SettingsShell>
        <Page />
      </SettingsShell>
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  mounted.mockClear()
  delete tauriWindow.__TAURI_INTERNALS__
})

describe("isSettingsPageHidden", () => {
  it("is the nav filter, asked about an address", () => {
    const everyPage = settingsNavItemsFor("tauri")
    const runtimes: [TransportEnvironment, { mode: "client" } | null][] = [
      ["web", null],
      ["tauri", null],
      ["tauri", { mode: "client" }],
    ]
    for (const [env, daemon] of runtimes) {
      const target = settingsTargetFor(env, daemon, null)
      const shown = settingsNavItemsFor(env, target).map((item) => item.href)
      for (const item of everyPage) {
        expect(isSettingsPageHidden(item.href, env, target)).toBe(
          !shown.includes(item.href)
        )
      }
    }
  })

  it("hides the Web service page in a browser, however it is addressed", () => {
    for (const path of [
      "/settings/web-service",
      "/settings/web-service/",
      "/settings/web-service.html",
      "/settings/web-service/index.html",
    ]) {
      expect(isSettingsPageHidden(path, "web")).toBe(true)
      expect(isSettingsPageHidden(path, "tauri")).toBe(false)
    }
    expect(isSettingsPageHidden("/settings/system", "web")).toBe(false)
  })

  it("leaves a route the nav never lists alone", () => {
    expect(isSettingsPageHidden("/settings/experts", "web")).toBe(false)
    expect(isSettingsPageHidden("/settings", "web")).toBe(false)
  })
})

describe("SettingsShell — a page the nav hides, opened by its address", () => {
  it("shows a notice instead of mounting the Web service page in a browser", () => {
    renderShell("/settings/web-service")

    expect(screen.queryByTestId("page")).not.toBeInTheDocument()
    expect(mounted).not.toHaveBeenCalled()
    const notice = screen.getByRole("status")
    expect(notice).toHaveTextContent(
      coworkText("en", "settingsPageUnavailable")
    )
    expect(notice).toHaveTextContent(coworkText("en", "settingsPageManaged"))
  })

  it("says so in the reader's language", () => {
    renderShell("/settings/web-service", "zh-CN")

    expect(screen.getByRole("status")).toHaveTextContent(
      "这个设置页在这里不可用。这台服务器由管理员管理。"
    )
  })

  it("mounts every page the nav does list", () => {
    renderShell("/settings/system")

    expect(screen.getByTestId("page")).toBeInTheDocument()
    expect(mounted).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })

  it("mounts the Web service page in the desktop app", () => {
    tauriWindow.__TAURI_INTERNALS__ = {}
    renderShell("/settings/web-service")

    expect(screen.getByTestId("page")).toBeInTheDocument()
    expect(screen.queryByRole("status")).not.toBeInTheDocument()
  })
})
