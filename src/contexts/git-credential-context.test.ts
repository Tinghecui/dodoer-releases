import { describe, expect, it } from "vitest"
import { isAuthError } from "./git-credential-context"

// #366: git 账号框只该在 git 自己登录失败时弹；远程窗口口令被拒（代理打了
// 标记）时弹出来也帮不上忙。
describe("isAuthError", () => {
  it("asks for git credentials when git itself failed to log in", () => {
    expect(
      isAuthError({
        code: "authentication_failed",
        message: "git push: authentication failed",
      })
    ).toBe(true)
    expect(
      isAuthError(new Error("fatal: could not read Username for 'https://x'"))
    ).toBe(true)
  })

  it("does not ask when the remote server refused the window's token", () => {
    expect(
      isAuthError({
        code: "authentication_failed",
        message: "Remote Workspace token is invalid",
        i18n_params: { reason: "remote_token_rejected" },
      })
    ).toBe(false)
  })
})
