import { createTranslator } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import ar from "@/i18n/messages/ar.json"
import de from "@/i18n/messages/de.json"
import en from "@/i18n/messages/en.json"
import es from "@/i18n/messages/es.json"
import fr from "@/i18n/messages/fr.json"
import ja from "@/i18n/messages/ja.json"
import ko from "@/i18n/messages/ko.json"
import pt from "@/i18n/messages/pt.json"
import zhCN from "@/i18n/messages/zh-CN.json"
import zhTW from "@/i18n/messages/zh-TW.json"
import { CoworkTeamError } from "./team"
import { noteTeamError, teamErrorText, type TeamErrorKey } from "./team-errors"

const ALL = { ar, de, en, es, fr, ja, ko, pt, "zh-CN": zhCN, "zh-TW": zhTW }

function zhT(key: TeamErrorKey): string {
  const t = createTranslator({
    locale: "zh-CN",
    messages: zhCN,
    namespace: "CoworkTeam",
  })
  return t(key)
}

describe("teamErrorText", () => {
  it("writes one plain sentence per error code", () => {
    expect(teamErrorText("not_found", zhT)).toBe(
      "找不到了，可能已经取消分享或被删除"
    )
    expect(teamErrorText("forbidden", zhT)).toBe("你没有权限做这件事")
    expect(teamErrorText("sharing_disabled", zhT)).toBe("管理员关闭了会话分享")
    expect(teamErrorText("rate_limited", zhT)).toBe("操作太频繁，过一会儿再试")
  })

  it("everything else is the generic sentence", () => {
    for (const code of ["invalid", "unknown", "", "not_implemented"]) {
      expect(teamErrorText(code, zhT)).toBe("出了点问题，稍后再试")
    }
  })

  it("noteTeamError logs the raw message once and returns the code", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const code = noteTeamError(
      "team",
      new CoworkTeamError("invalid", "group 要是整数")
    )
    expect(code).toBe("invalid")
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain("group 要是整数")
    warn.mockRestore()
  })
})

describe("CoworkTeam copy", () => {
  const NEW_KEYS = [
    "errorNotFound",
    "errorForbidden",
    "errorSharingDisabled",
    "errorRateLimited",
    "errorGeneric",
    "commentDeleteFailed",
    "dialogClose",
  ]

  it("every locale has the new keys", () => {
    for (const [locale, messages] of Object.entries(ALL)) {
      const ns = (messages as { CoworkTeam: Record<string, unknown> })
        .CoworkTeam
      for (const key of NEW_KEYS) {
        expect(typeof ns[key], `${locale}.${key}`).toBe("string")
        expect((ns[key] as string).length, `${locale}.${key}`).toBeGreaterThan(
          0
        )
      }
    }
  })

  it("does not call a colleague 他 in Chinese", () => {
    for (const messages of [zhCN, zhTW]) {
      for (const [key, value] of Object.entries(messages.CoworkTeam)) {
        expect(typeof value === "string" && /他/.test(value), key).toBe(false)
      }
    }
    expect(zhCN.CoworkTeam.sharedViewWaiting).toBe(
      "{owner}的智能体在等 TA 回答"
    )
    expect(zhCN.CoworkTeam.commentPlaceholder).toBe(
      "留言给{owner}，不会发给{owner}的智能体"
    )
    expect(zhTW.CoworkTeam.sharedViewWaiting).toBe(
      "{owner}的智慧體在等 TA 回答"
    )
    expect(zhTW.CoworkTeam.commentPlaceholder).toBe(
      "留言給{owner}，不會傳給{owner}的智慧體"
    )
  })

  it("delete failures say 没删掉 and sends still say 没发出去", () => {
    expect(zhCN.CoworkTeam.commentDeleteFailed).toBe("没删掉：{message}")
    expect(zhCN.CoworkTeam.commentAddFailed).toBe("没发出去：{message}")
  })
})
