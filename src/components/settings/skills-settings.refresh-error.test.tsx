import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpListAgentSkills } from "@/lib/api"
import { SkillsSettings } from "./skills-settings"

vi.mock("@/lib/api", () => ({
  acpListAgents: async () => [
    {
      agent_type: "claude_code",
      name: "Agent",
      enabled: true,
      skills_capable: true,
      env: {},
      sort_order: 0,
    },
  ],
  loadFolderHistory: async () => [],
  acpListAgentSkills: vi.fn(),
  acpSaveAgentSkill: vi.fn(),
  acpReadAgentSkill: vi.fn(),
  acpDeleteAgentSkill: vi.fn(),
  openFolder: vi.fn(),
}))
vi.mock("@/hooks/use-agent-skills", () => ({
  invalidateAgentSkillsCache: vi.fn(),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
vi.mock("@/components/ui/resizable", () => ({
  ResizablePanelGroup: ({ children }: { children: ReactNode }) => children,
  ResizablePanel: ({ children }: { children: ReactNode }) => children,
  ResizableHandle: () => null,
}))

const mockList = vi.mocked(acpListAgentSkills)
const t = enMessages.SkillsSettings
const EMPTY = {
  supported: true,
  message: null,
  locations: [{ scope: "global" as const, path: "/skills", exists: false }],
  skills: [],
}

describe("skills list refresh failure", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockList.mockReset()
  })

  it("shows the failure with a retry instead of the empty state", async () => {
    // 进页面时先给每个智能体探测一次，再读选中那个的列表
    mockList.mockResolvedValue(EMPTY)
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SkillsSettings />
      </NextIntlClientProvider>
    )
    expect(await screen.findByText(t.emptySkills)).toBeInTheDocument()
    await waitFor(() => expect(mockList).toHaveBeenCalledTimes(2))

    mockList.mockRejectedValueOnce(new Error("injected failure"))
    await user.click(screen.getByRole("button", { name: t.actions.refresh }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("injected failure")
    expect(screen.queryByText(t.emptySkills)).not.toBeInTheDocument()
    // 点一次刷新只发一次请求
    expect(mockList).toHaveBeenCalledTimes(3)

    // 重试成功后回到正常的空状态
    await user.click(
      screen.getByRole("button", { name: enMessages.SettingsLoadError.retry })
    )
    expect(await screen.findByText(t.emptySkills)).toBeInTheDocument()
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(mockList).toHaveBeenCalledTimes(4)
  })
})
