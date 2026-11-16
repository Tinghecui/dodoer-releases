import { afterEach, describe, expect, it } from "vitest"

import {
  REMOTE_TOKEN_REJECTED_REASON,
  isFetchNetworkError,
  isRemoteTokenRejected,
  toErrorMessage,
} from "./app-error"

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

// #366: 窗口口令被拒（代理打了标记）和命令自己登录失败要分得开。
describe("isRemoteTokenRejected", () => {
  it("is true only for authentication_failed carrying the proxy's marker", () => {
    expect(REMOTE_TOKEN_REJECTED_REASON).toBe("remote_token_rejected")
    expect(
      isRemoteTokenRejected({
        code: "authentication_failed",
        message: "Remote Workspace token is invalid",
        i18n_params: { reason: REMOTE_TOKEN_REJECTED_REASON },
      })
    ).toBe(true)
    // 包在 Error 的 message 里的 JSON 也认得出
    expect(
      isRemoteTokenRejected(
        new Error(
          JSON.stringify({
            code: "authentication_failed",
            message: "Remote Workspace token is invalid",
            i18n_params: { reason: REMOTE_TOKEN_REJECTED_REASON },
          })
        )
      )
    ).toBe(true)
  })

  it("is false for a command's own login failure and anything else", () => {
    expect(
      isRemoteTokenRejected({
        code: "authentication_failed",
        message: "git push: authentication failed",
      })
    ).toBe(false)
    expect(
      isRemoteTokenRejected({
        code: "network_error",
        message: "Request timed out",
        i18n_params: { reason: REMOTE_TOKEN_REJECTED_REASON },
      })
    ).toBe(false)
    expect(
      isRemoteTokenRejected({
        code: "authentication_failed",
        message: "x",
        i18n_params: { reason: "other" },
      })
    ).toBe(false)
    expect(isRemoteTokenRejected(new Error("Unauthorized"))).toBe(false)
    expect(isRemoteTokenRejected(null)).toBe(false)
  })
})
