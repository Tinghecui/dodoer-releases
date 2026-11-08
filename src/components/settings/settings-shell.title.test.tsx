import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import en from "@/i18n/messages/en.json"

const nav = vi.hoisted(() => ({ pathname: "/settings/general" }))

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
}))
vi.mock("@/components/layout/app-title-bar", () => ({
  AppTitleBar: () => null,
}))
vi.mock("@/components/ui/app-toaster", () => ({ AppToaster: () => null }))

import { SettingsShell } from "./settings-shell"

const shell = () => (
  <NextIntlClientProvider locale="en" messages={en}>
    <SettingsShell>
      <div />
    </SettingsShell>
  </NextIntlClientProvider>
)

describe("SettingsShell document title", () => {
  // Next puts the root layout's metadata title back on a client-side
  // navigation; the shell is a layout and stays mounted across it.
  it("is put back after moving to another settings page", () => {
    const { rerender } = render(shell())
    expect(document.title).toBe("Settings - dodoer")

    document.title = "dodoer"
    nav.pathname = "/settings/system"
    rerender(shell())
    expect(document.title).toBe("Settings - dodoer")
  })
})
