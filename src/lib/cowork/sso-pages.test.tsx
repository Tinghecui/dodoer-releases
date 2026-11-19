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
import { takeLinkTokenIgnored } from "@/lib/cowork/token-link"

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  sessionStorage.clear()
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
  // #873: already signed in through the portal, a sign-in link must not
  // quietly replace the stored credential (behind the portal any token
  // "passes", the proxy swaps in the real one).
  it("ignores a sign-in link's token while the portal session is valid, and says so", async () => {
    sso.probeCoworkSso.mockImplementation(async () => {
      localStorage.setItem("codeg_token", "cowork-sso")
      return "ok"
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    })
    vi.stubGlobal("fetch", fetchMock)
    localStorage.setItem("codeg_token", "cowork-sso")
    window.history.replaceState(null, "", "/login?token=fake-qa-123")
    try {
      renderLogin()
      expect(window.location.href).not.toContain("fake-qa-123")
      await waitFor(() =>
        expect(router.replace).toHaveBeenCalledWith("/workspace")
      )
      expect(localStorage.getItem("codeg_token")).toBe("cowork-sso")
      // The link's token was never sent anywhere.
      expect(fetchMock).not.toHaveBeenCalled()
      // The login page has no toaster and leaves at once: the note is handed
      // to the workspace (LinkTokenNotice raises it there).
      expect(takeLinkTokenIgnored()).toBe(true)
      expect(sso.sendToPortalLogin).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, "", "/")
    }
  })

  // #873 返工：门户探测临时失败（网络错误、5xx）时说不清有没有门户会话，
  // 紧接着的校验又可能被网关替换成真令牌而“通过”：不能用链接里的令牌。
  it("does not use a sign-in link's token when the portal probe is unavailable", async () => {
    sso.probeCoworkSso.mockResolvedValue("unavailable")
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
    })
    vi.stubGlobal("fetch", fetchMock)
    localStorage.setItem("codeg_token", "cowork-sso")
    window.history.replaceState(null, "", "/login?token=fake-qa-123")
    try {
      renderLogin()
      await waitFor(() =>
        expect(screen.getByRole("button")).toHaveTextContent("Connect")
      )
      expect(localStorage.getItem("codeg_token")).toBe("cowork-sso")
      expect(fetchMock).not.toHaveBeenCalled()
      expect(router.replace).not.toHaveBeenCalled()
      // 令牌留在表单里，说明连不上服务器。
      expect(
        screen.getByText("Unable to connect to the server")
      ).toBeInTheDocument()
      expect(sso.sendToPortalLogin).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, "", "/")
    }
  })

  it("signs in with the token of a sign-in link when there is no portal session", async () => {
    sso.probeCoworkSso.mockResolvedValue("denied")
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
      expect(fetchMock.mock.calls[0][1].headers).toMatchObject({
        Authorization: "Bearer good",
      })
      expect(takeLinkTokenIgnored()).toBe(false)
      expect(sso.sendToPortalLogin).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      window.history.replaceState(null, "", "/")
    }
  })

  it("keeps the form, not the portal, when the link's token is rejected", async () => {
    sso.probeCoworkSso.mockResolvedValue("denied")
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
