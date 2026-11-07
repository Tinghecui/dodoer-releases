import { act, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  COWORK_UPGRADE_URL,
  UPGRADE_POLL_MS,
  UPGRADE_RETRY_MS,
  getCachedCoworkUpgradeHint,
  loadCoworkUpgradeHint,
  normalizeUpgradeHint,
  openCoworkUpgrade,
  resetCoworkUpgradeForTests,
  useCoworkUpgradeHint,
} from "./upgrade"

const HINT = {
  current: "0.8.2",
  latest: "0.9.0",
  url: "https://portal.example.com/admin/upgrade",
}

const fetchMock = vi.fn()

function respond(body: unknown, status = 200) {
  fetchMock.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  })
}

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal("fetch", fetchMock)
  resetCoworkUpgradeForTests()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe("normalizeUpgradeHint", () => {
  it("accepts the portal's shape", () => {
    expect(normalizeUpgradeHint({ ...HINT, newer: true })).toEqual(HINT)
  })
  it("is null unless newer, and drops non-https urls", () => {
    expect(normalizeUpgradeHint(null)).toBeNull()
    expect(normalizeUpgradeHint({ ...HINT, newer: false })).toBeNull()
    expect(normalizeUpgradeHint({ newer: true, latest: "" })).toBeNull()
    expect(
      normalizeUpgradeHint({
        newer: true,
        latest: "0.9.0",
        url: "javascript:x",
      })
    ).toEqual({ current: "", latest: "0.9.0", url: null })
  })
})

describe("loadCoworkUpgradeHint", () => {
  it("asks the same-origin portal path with credentials and caches", async () => {
    respond({ ...HINT, newer: true })
    expect(await loadCoworkUpgradeHint()).toEqual(HINT)
    expect(fetchMock).toHaveBeenCalledWith(
      COWORK_UPGRADE_URL,
      expect.objectContaining({
        credentials: "same-origin",
        redirect: "manual",
      })
    )
    expect(getCachedCoworkUpgradeHint()).toEqual(HINT)
  })

  it("shares one in-flight request", async () => {
    respond(null)
    const [a, b] = await Promise.all([
      loadCoworkUpgradeHint(),
      loadCoworkUpgradeHint(),
    ])
    expect(a).toBeNull()
    expect(b).toBeNull()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("keeps the last hint when the request fails (no nginx, restart)", async () => {
    respond({ ...HINT, newer: true })
    await loadCoworkUpgradeHint()
    respond(null, 404)
    expect(await loadCoworkUpgradeHint()).toEqual(HINT)
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    expect(await loadCoworkUpgradeHint()).toEqual(HINT)
  })
})

describe("useCoworkUpgradeHint", () => {
  it("does nothing while disabled", () => {
    const { result } = renderHook(() => useCoworkUpgradeHint(false))
    expect(result.current).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fetches once enabled and exposes the hint", async () => {
    respond({ ...HINT, newer: true })
    const { result } = renderHook(() => useCoworkUpgradeHint(true))
    await waitFor(() => expect(result.current).toEqual(HINT))
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("polls every 30 minutes, sooner after a failure", async () => {
    vi.useFakeTimers()
    respond(null)
    renderHook(() => useCoworkUpgradeHint(true))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPGRADE_POLL_MS - 1000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    fetchMock.mockRejectedValueOnce(new Error("offline"))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    respond({ ...HINT, newer: true })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(UPGRADE_RETRY_MS)
    })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(getCachedCoworkUpgradeHint()).toEqual(HINT)
  })
})

describe("openCoworkUpgrade", () => {
  const original = window.location
  const assign = vi.fn()
  beforeEach(() => {
    assign.mockReset()
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...original, assign },
    })
  })
  afterEach(() => {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: original,
    })
  })

  it("navigates to the portal page, or nowhere without a url", () => {
    openCoworkUpgrade(HINT)
    expect(assign).toHaveBeenCalledWith(HINT.url)
    openCoworkUpgrade({ ...HINT, url: null })
    expect(assign).toHaveBeenCalledTimes(1)
  })
})
