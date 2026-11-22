import { describe, expect, it } from "vitest"

import { agentInstallBrokenTextKey } from "./agent-install"
import { coworkText } from "./i18n"
import type { CoworkInfo } from "./info"

const PORTAL: CoworkInfo = {
  product: "Cowork",
  projectsRoot: null,
  portal: true,
  updateDisabled: false,
}

const text = (locale: string, info: CoworkInfo | null) =>
  coworkText(locale, agentInstallBrokenTextKey(info), { agent: "Codex" })

describe("agentInstallBrokenTextKey", () => {
  it("behind the portal, sends the employee to an administrator (#1111)", () => {
    expect(text("zh-CN", PORTAL)).toBe(
      "Codex 没装完整（缺少本机平台的程序包），请管理员在门户 Agent 页重装。"
    )
    expect(text("en", PORTAL)).toContain(
      "Ask an administrator to reinstall it on the portal's Agents page"
    )
  })

  it("elsewhere, points at the agent's own settings", () => {
    expect(text("zh-CN", null)).toBe(
      "Codex 没装完整（缺少本机平台的程序包），请到智能体设置里重装。"
    )
    expect(text("zh-CN", { ...PORTAL, portal: false })).toContain("智能体设置")
  })
})
