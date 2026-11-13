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

  // #74: a sign-in link (for a server without the portal in front) wins over
  // the portal redirect; a rejected token keeps the form instead.
  it("signs in with the token of a sign-in link, without the SSO probe", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    })
    vi.stubGlobal("fetch", fetchMock)
    window.history.replaceState(null, "", "/login?token=good")
    try {
      renderLogin()
      expect(window.location.search).toBe("?token")
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith("/workspace")
      )
      expect(localStorage.getItem("codeg_token")).toBe("good")
      expect(sso.probeCoworkSso).not.toHaveBeenCalled()
      expect(sso.sendToPortalLogin).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, "", "/")
    }
  })

  it("keeps the form, not the portal, when the link's token is rejected", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        headers: new Headers({ "WWW-Authenticate": 'Bearer realm="codeg"' }),
      })
    )
    window.history.replaceState(null, "", "/login?token=bad")
    try {
      renderLogin()
      expect(
        await screen.findByText("Invalid token. Please check and try again.")
      ).toBeInTheDocument()
      expect(sso.sendToPortalLogin).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, "", "/")
    }
  })
})
