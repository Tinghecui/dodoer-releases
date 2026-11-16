import { describe, expect, it } from "vitest"
import { needsWeixinLogin } from "./channel-list-tab"

// #366: 微信扫码框只在没设 token 或登录失效时弹，别的错误照别的通道 toast。
describe("needsWeixinLogin", () => {
  it("asks to scan when the channel has no token or its login expired", () => {
    expect(
      needsWeixinLogin({
        code: "authentication_failed",
        message: "weixin: session expired",
      })
    ).toBe(true)
    expect(
      needsWeixinLogin({
        code: "configuration_missing",
        message: "Token not set",
      })
    ).toBe(true)
  })

  it("does not ask when the remote server refused the window's token", () => {
    expect(
      needsWeixinLogin({
        code: "authentication_failed",
        message: "Remote Workspace token is invalid",
        i18n_params: { reason: "remote_token_rejected" },
      })
    ).toBe(false)
  })

  it("does not ask for other failures", () => {
    expect(
      needsWeixinLogin({ code: "network_error", message: "connection reset" })
    ).toBe(false)
    expect(needsWeixinLogin(new Error("Unauthorized"))).toBe(false)
    expect(needsWeixinLogin(new Error("Request timed out"))).toBe(false)
  })
})
