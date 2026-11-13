import { afterEach, describe, expect, it } from "vitest"

import { isFetchNetworkError, toErrorMessage } from "./app-error"

afterEach(() => {
  document.documentElement.lang = ""
})

// #71: a save that could not reach the server showed the engine's bare
// "Failed to fetch".
describe("toErrorMessage for a request that got no response", () => {
  it("says the server cannot be reached, in each engine's wording", () => {
    for (const message of [
      "Failed to fetch", // Chrome
      "NetworkError when attempting to fetch resource.", // Firefox
      "Load failed", // Safari
    ]) {
      expect(isFetchNetworkError(new TypeError(message))).toBe(true)
      expect(toErrorMessage(new TypeError(message))).toMatch(
        /^Can't reach the server/
      )
    }
  })

  it("uses the page's language", () => {
    document.documentElement.lang = "zh-CN"
    expect(toErrorMessage(new TypeError("Failed to fetch"))).toBe(
      "连不上服务器，请检查网络。网络恢复后会自动重连。"
    )
  })

  it("leaves other errors as they are", () => {
    expect(isFetchNetworkError(new Error("Failed to fetch"))).toBe(false)
    expect(toErrorMessage(new TypeError("x is not a function"))).toBe(
      "x is not a function"
    )
    expect(toErrorMessage(new Error("Request timed out"))).toBe(
      "Request timed out"
    )
    expect(toErrorMessage({ code: "network_error", message: "HTTP 502" })).toBe(
      "HTTP 502"
    )
  })
})
