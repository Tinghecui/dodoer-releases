import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import zhMessages from "@/i18n/messages/zh-CN.json"
import { resetCoworkInfoForTests } from "@/lib/cowork/info"
import type { AgentType } from "@/lib/types"
import { TurnErrorAgentProvider, TurnErrorPart } from "./turn-error-part"

const h = vi.hoisted(() => ({
  openUrl: vi.fn(async () => {}),
  openSettingsWindow: vi.fn(async () => {}),
}))
vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  isRemoteDesktopWindow: () => false,
  openUrl: h.openUrl,
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  openSettingsWindow: h.openSettingsWindow,
}))

const RAW = "Not logged in · Please run /login"

function renderLine(message: string, agentType: AgentType | null) {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
      <TurnErrorAgentProvider value={agentType}>
        <TurnErrorPart message={message} />
      </TurnErrorAgentProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  h.openUrl.mockClear()
  h.openSettingsWindow.mockClear()
  resetCoworkInfoForTests()
})

afterEach(() => {
  cleanup()
  resetCoworkInfoForTests()
})

// AI QA #159: reopened, a failed turn reads the agent's own record of it —
// for a signed-out Claude Code the CLI's English, where the live turn had
// said it in the user's language.
describe("TurnErrorPart sign-in failures", () => {
  it("says a signed-out agent's record the way the live turn did, with a sign-in link", () => {
    renderLine(RAW, "claude_code")
    const line = screen.getByTestId("turn-error")
    expect(line.textContent).toContain(
      "本轮失败：Claude Code 需要你重新登录后才能执行本轮回复。请在设置中登录，然后重新发送这条消息。"
    )
    expect(line.textContent).not.toContain("Not logged in")
    // The agent's words are still there, on hover.
    expect(line.querySelector("p")?.getAttribute("title")).toBe(RAW)
    fireEvent.click(screen.getByText("去登录"))
    expect(h.openSettingsWindow).toHaveBeenCalledWith("agents", {
      agentType: "claude_code",
    })
  })

  it("behind the portal, points at its AI accounts (#158)", () => {
    resetCoworkInfoForTests({
      product: "Cowork",
      projectsRoot: null,
      portal: true,
      updateDisabled: false,
    })
    renderLine(RAW, "claude_code")
    expect(screen.getByTestId("turn-error").textContent).toContain(
      "请到门户「我的账户 → AI 账户」配置，然后重新发送这条消息。"
    )
    fireEvent.click(screen.getByText("去门户配置 AI 账户"))
    expect(h.openUrl).toHaveBeenCalledWith("/_cowork/account#ai-accounts")
    expect(h.openSettingsWindow).not.toHaveBeenCalled()
  })

  it("shows any other failure as it is, without a link", () => {
    renderLine("API Error: 503 overloaded", "claude_code")
    expect(screen.getByTestId("turn-error").textContent).toBe(
      "本轮失败：API Error: 503 overloaded"
    )
    expect(screen.queryByRole("button")).toBeNull()
  })

  it("leaves the record alone where the agent is unknown", () => {
    renderLine(RAW, null)
    expect(screen.getByTestId("turn-error").textContent).toBe(
      `本轮失败：${RAW}`
    )
    expect(screen.queryByRole("button")).toBeNull()
  })
})
