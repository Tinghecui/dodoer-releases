import { render, waitFor } from "@testing-library/react"
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
  // navigation, on most pages after the shell (a layout, still mounted) has
  // rendered for it — so the title is rewritten with no render to follow.
  it("is put back when the title is rewritten after a navigation", async () => {
    const { rerender, unmount } = render(shell())
    expect(document.title).toBe("Settings - dodoer")

    nav.pathname = "/settings/system"
    rerender(shell())
    document.title = "dodoer"
    await waitFor(() => expect(document.title).toBe("Settings - dodoer"))

    // A replaced <title> element, not only its text.
    document.querySelector("title")?.remove()
    const next = document.createElement("title")
    next.textContent = "dodoer"
    document.head.append(next)
    await waitFor(() => expect(document.title).toBe("Settings - dodoer"))

    // Gone with the shell: the next page owns the title.
    unmount()
    document.title = "dodoer"
    await Promise.resolve()
    expect(document.title).toBe("dodoer")
  })
})
