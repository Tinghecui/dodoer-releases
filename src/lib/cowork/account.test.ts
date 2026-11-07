import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const desktop = vi.hoisted(() => ({
  desktop: false,
  remote: false,
  openUrl: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => desktop.desktop,
  isRemoteDesktopWindow: () => desktop.remote,
  openUrl: desktop.openUrl,
}))
vi.mock("@/lib/transport", () => ({
  getServerBaseUrl: () => "https://james.example.com",
}))

import {
  COWORK_ACCOUNT_URL,
  COWORK_DESKTOP_LINK_URL,
  COWORK_LOGOUT_URL,
  coworkCanOpenInDesktop,
  coworkCanSignOut,
  coworkSignOut,
  openCoworkAccount,
  openCoworkInDesktop,
} from "@/lib/cowork/account"

describe("cowork account navigation", () => {
  const assign = vi.fn()
  const original = window.location

  beforeEach(() => {
    assign.mockReset()
    desktop.desktop = false
    desktop.remote = false
    desktop.openUrl.mockReset()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    })
  })

  it("uses the same-origin portal paths", () => {
    expect(COWORK_ACCOUNT_URL).toBe("/_cowork/account")
    expect(COWORK_LOGOUT_URL).toBe("/_cowork/logout")
  })

  it("opens the account page", () => {
    openCoworkAccount()
    expect(assign).toHaveBeenCalledWith("/_cowork/account")
  })

  it("opens the account page in the browser from a remote desktop window", () => {
    desktop.remote = true
    openCoworkAccount()
    expect(assign).not.toHaveBeenCalled()
    expect(desktop.openUrl).toHaveBeenCalledWith(
      "https://james.example.com/_cowork/account"
    )
    expect(coworkCanSignOut()).toBe(false)
  })

  it("clears the token before signing out", () => {
    expect(coworkCanSignOut()).toBe(true)
    localStorage.setItem("codeg_token", "cowork-sso")
    coworkSignOut()
    expect(localStorage.getItem("codeg_token")).toBeNull()
    expect(assign).toHaveBeenCalledWith("/_cowork/logout")
  })
  it("offers the desktop app only in the browser", () => {
    expect(coworkCanOpenInDesktop()).toBe(true)
    desktop.desktop = true
    desktop.remote = true
    expect(coworkCanOpenInDesktop()).toBe(false)
  })

  it("asks the portal for a one-time desktop link and follows it", async () => {
    const link =
      "codeg://cowork/connect?url=https%3A%2F%2Fjames.example.com&code=abc"
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ link }), { status: 200 })
      )
    vi.stubGlobal("fetch", fetch)
    await openCoworkInDesktop()
    expect(fetch).toHaveBeenCalledWith(
      COWORK_DESKTOP_LINK_URL,
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    )
    expect(COWORK_DESKTOP_LINK_URL).toBe("/_cowork/desktop-link")
    expect(assign).toHaveBeenCalledWith(link)
  })

  it("rejects with the portal's message, and never follows a foreign link", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            error: { code: "invalid", message: "你的工作环境是 Paseo" },
          }),
          { status: 400 }
        )
      )
    )
    await expect(openCoworkInDesktop()).rejects.toThrow("你的工作环境是 Paseo")

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("<html>", { status: 404 }))
    )
    await expect(openCoworkInDesktop()).rejects.toThrow("HTTP 404")

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ link: "https://evil.example/" }), {
          status: 200,
        })
      )
    )
    await expect(openCoworkInDesktop()).rejects.toThrow()
    expect(assign).not.toHaveBeenCalled()
  })
})
