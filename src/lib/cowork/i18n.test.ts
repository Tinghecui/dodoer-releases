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

  it("names the project and the way to the existing one when a name is taken", () => {
    expect(
      coworkText("zh-CN", "projectExists", { name: "demo", next: "下一步" })
    ).toBe(
      "已经有一个叫 demo 的项目了，换个名称；要打开已有的项目，在下面的列表里选中它，再点「下一步」。"
    )
    expect(
      coworkText("zh-TW", "projectExists", { name: "demo", next: "下一步" })
    ).toBe(
      "已經有一個叫 demo 的專案了，換個名稱；要開啟現有的專案，在下面的清單裡選取它，再按「下一步」。"
    )
    // Other locales fall back to English, with the dialog's own button label.
    expect(
      coworkText("ja", "projectExists", { name: "demo", next: "次へ" })
    ).toBe(
      'There is already a project named demo. Pick another name; to open the existing one, select it in the list below and click "次へ".'
    )
  })
})
