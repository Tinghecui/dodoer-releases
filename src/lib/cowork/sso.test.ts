import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  clearStoredToken,
  COWORK_SSO_TOKEN,
  lastPortalBounce,
  PORTAL_BOUNCE_WINDOW_MS,
  probeCoworkSso,
  sendToPortalLogin,
  ssoFallback,
  tryCoworkSso,
} from "./sso"

function jsonResponse(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

describe("tryCoworkSso", () => {
  const fetchMock = vi.fn()

  beforeEach(() => {
    localStorage.clear()
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("stores the placeholder when the proxy authenticates the probe", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(200, { status: "ok", version: "0.35.2" })
    )
    await expect(tryCoworkSso()).resolves.toBe(true)
    expect(localStorage.getItem("codeg_token")).toBe(COWORK_SSO_TOKEN)

    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe("/api/health")
    expect(init.method).toBe("POST")
    expect(init.redirect).toBe("manual")
    // The probe must not carry any credential of its own.
    expect(init.headers).not.toHaveProperty("Authorization")
  })

  it("fails on 401 (no proxy in front)", async () => {
    fetchMock.mockResolvedValue(
      new Response("Invalid or missing token", {
        status: 401,
      })
    )
    await expect(tryCoworkSso()).resolves.toBe(false)
    expect(localStorage.getItem("codeg_token")).toBeNull()
  })

  it("fails on a 200 that is not the health payload", async () => {
    fetchMock.mockResolvedValue(
      new Response("<html>portal login</html>", { status: 200 })
    )
    await expect(tryCoworkSso()).resolves.toBe(false)
    expect(localStorage.getItem("codeg_token")).toBeNull()
  })

  it("fails on network errors", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"))
    await expect(tryCoworkSso()).resolves.toBe(false)
  })

  it("classifies the probe outcome", async () => {
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 401 }))
    await expect(probeCoworkSso()).resolves.toBe("denied")
    fetchMock.mockResolvedValueOnce(new Response("no", { status: 403 }))
    await expect(probeCoworkSso()).resolves.toBe("denied")
    // redirect:"manual" yields an opaque redirect (status 0) in browsers.
    fetchMock.mockResolvedValueOnce({
      type: "opaqueredirect",
      status: 0,
      ok: false,
    } as Response)
    await expect(probeCoworkSso()).resolves.toBe("denied")
    fetchMock.mockResolvedValueOnce(new Response("down", { status: 502 }))
    await expect(probeCoworkSso()).resolves.toBe("unavailable")
    fetchMock.mockRejectedValueOnce(new TypeError("Failed to fetch"))
    await expect(probeCoworkSso()).resolves.toBe("unavailable")
    fetchMock.mockResolvedValueOnce(jsonResponse(200, { status: "ok" }))
    await expect(probeCoworkSso()).resolves.toBe("ok")
  })

  it("clearStoredToken removes the token", () => {
    localStorage.setItem("codeg_token", COWORK_SSO_TOKEN)
    clearStoredToken()
    expect(localStorage.getItem("codeg_token")).toBeNull()
  })
})

describe("ssoFallback", () => {
  const base = {
    coworkBuild: true,
    manualToken: false,
    lastBounce: null,
    now: 1_000_000,
  }

  it("sends a denied Cowork user to the portal instead of the token form", () => {
    expect(ssoFallback("denied", base)).toBe("portal")
  })

  it("shows the form otherwise", () => {
    expect(ssoFallback("unavailable", base)).toBe("form")
    expect(ssoFallback("denied", { ...base, coworkBuild: false })).toBe("form")
    expect(ssoFallback("denied", { ...base, manualToken: true })).toBe("form")
  })

  it("does not loop when the portal sent the user straight back", () => {
    const recent = { ...base, lastBounce: base.now - 1000 }
    expect(ssoFallback("denied", recent)).toBe("form")
    const old = { ...base, lastBounce: base.now - PORTAL_BOUNCE_WINDOW_MS - 1 }
    expect(ssoFallback("denied", old)).toBe("portal")
  })

  it("records the bounce before navigating", () => {
    sessionStorage.clear()
    const assign = vi.fn()
    const original = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    })
    try {
      expect(lastPortalBounce()).toBeNull()
      sendToPortalLogin("/_cowork/account")
      expect(assign).toHaveBeenCalledWith("/_cowork/account")
      expect(lastPortalBounce()).toEqual(expect.any(Number))
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: original,
      })
    }
  })
})
