import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const router = vi.hoisted(() => ({ replace: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => router }))
vi.mock("@/lib/platform", () => ({ isDesktop: () => false }))
const sso = vi.hoisted(() => ({
  tryCoworkSso: vi.fn(),
  probeCoworkSso: vi.fn(),
  ssoFallback: vi.fn(),
  lastPortalBounce: vi.fn(() => null),
  sendToPortalLogin: vi.fn(),
}))
vi.mock("@/lib/cowork/sso", () => sso)
// These pages run the portal flow only in a Cowork build; the suite itself is
// built with the source name (vitest.config.ts), so switch the flag on here.
vi.mock("@/lib/cowork/brand", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cowork/brand")>()),
  COWORK_BUILD: true,
}))

import RootPage from "@/app/page"
import LoginPage from "@/app/login/page"

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe("root page", () => {
  it("enters the workspace through portal SSO when no token is stored", async () => {
    sso.tryCoworkSso.mockResolvedValue(true)
    render(<RootPage />)
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
  })

  it("falls back to the token login without a proxy", async () => {
    sso.tryCoworkSso.mockResolvedValue(false)
    render(<RootPage />)
    await waitFor(() => expect(router.replace).toHaveBeenCalledWith("/login"))
  })
})

describe("login page", () => {
  function renderLogin() {
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LoginPage />
      </NextIntlClientProvider>
    )
  }

  it("skips the form when SSO succeeds", async () => {
    sso.probeCoworkSso.mockResolvedValue("ok")
    const { container } = renderLogin()
    expect(container).toBeEmptyDOMElement()
    await waitFor(() =>
      expect(router.replace).toHaveBeenCalledWith("/workspace")
    )
  })

  it("shows the token form when SSO fails", async () => {
    sso.probeCoworkSso.mockResolvedValue("denied")
    sso.ssoFallback.mockReturnValue("form")
    renderLogin()
    expect(await screen.findByRole("button")).toBeInTheDocument()
    expect(router.replace).not.toHaveBeenCalled()
    expect(sso.sendToPortalLogin).not.toHaveBeenCalled()
  })

  it("sends an expired portal session back to the portal, not the form", async () => {
    sso.probeCoworkSso.mockResolvedValue("denied")
    sso.ssoFallback.mockReturnValue("portal")
    const { container } = renderLogin()
    await waitFor(() =>
      expect(sso.sendToPortalLogin).toHaveBeenCalledWith("/_cowork/account")
    )
    expect(sso.ssoFallback).toHaveBeenCalledWith(
      "denied",
      expect.objectContaining({ manualToken: false })
    )
    expect(container).toBeEmptyDOMElement()
  })
})
