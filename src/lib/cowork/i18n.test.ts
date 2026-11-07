import { describe, expect, it } from "vitest"

import { coworkText } from "./i18n"

describe("coworkText", () => {
  it("translates en / zh-CN / zh-TW and falls back to English", () => {
    expect(coworkText("en", "signOut")).toBe("Sign out / switch account")
    expect(coworkText("zh-CN", "signOut")).toBe("退出 / 切换账户")
    expect(coworkText("zh-TW", "myAccount")).toBe("我的帳戶")
    expect(coworkText("ja", "myAccount")).toBe("My account")
  })

  it("interpolates values", () => {
    expect(coworkText("en", "newProjectHint", { root: "/w" })).toBe(
      "Creates a folder under /w"
    )
  })
})
