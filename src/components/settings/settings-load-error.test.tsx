import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { ChannelListTab } from "./channel-list-tab"
import { ExpertsBody } from "./experts-settings"
import { McpSettings } from "./mcp-settings"
import { ModelProviderSettings } from "./model-provider-settings"
import { QuickMessagesSettings } from "./quick-messages-settings"
import { SettingsLoadError } from "./settings-load-error"
import { SkillsSettings } from "./skills-settings"

// #438: 设置页的列表没读出来时，只显示「加载失败」、原因和「重试」，
// 不显示「尚未配置……」这类空状态；点重试读出来了就显示列表。

const api = vi.hoisted(() => ({
  listModelProviders: vi.fn(),
  deleteModelProvider: vi.fn(),
  listChatChannels: vi.fn(),
  getChatChannelStatus: vi.fn(async () => []),
  deleteChatChannel: vi.fn(),
  connectChatChannel: vi.fn(),
  disconnectChatChannel: vi.fn(),
  testChatChannel: vi.fn(),
  updateChatChannel: vi.fn(),
  acpListAgents: vi.fn(),
  acpListAgentSkills: vi.fn(),
  acpReadAgentSkill: vi.fn(),
  acpSaveAgentSkill: vi.fn(),
  acpDeleteAgentSkill: vi.fn(),
  loadFolderHistory: vi.fn(async () => []),
  openFolder: vi.fn(),
  mcpScanLocal: vi.fn(),
  mcpListMarketplaces: vi.fn(async () => []),
  mcpSearchMarketplace: vi.fn(async () => []),
  mcpGetMarketplaceServerDetail: vi.fn(),
  mcpInstallFromMarketplace: vi.fn(),
  mcpUpsertLocalServer: vi.fn(),
  mcpSetServerApps: vi.fn(),
  mcpRemoveServer: vi.fn(),
  quickMessagesList: vi.fn(),
  quickMessagesCreate: vi.fn(),
  quickMessagesUpdate: vi.fn(),
  quickMessagesDelete: vi.fn(),
  quickMessagesReorder: vi.fn(),
  expertsList: vi.fn(),
  expertsListAllInstallStatuses: vi.fn(async () => []),
  expertsApplyLinks: vi.fn(),
  expertsReadContent: vi.fn(),
}))

vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
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
vi.mock("@/components/settings/skill-agent-matrix", () => ({
  SkillAgentMatrix: ({ skills }: { skills: { id: string }[] }) => (
    <ul>
      {skills.map((s) => (
        <li key={s.id}>{s.id}</li>
      ))}
    </ul>
  ),
}))

// 门户 / 反代回 500 时，web transport 抛出来的就是这种带 code 的错误
const boom = { code: "internal_error", message: "boom" }

function renderWithIntl(node: ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {node}
    </NextIntlClientProvider>
  )
}

const agent = {
  agent_type: "claude_code",
  name: "Claude Code",
  enabled: true,
  skills_capable: true,
  env: {},
  sort_order: 0,
}

async function expectErrorThenRetry(opts: {
  title: string
  empty: string
  recovered: string
  succeed: () => void
}) {
  const alert = await screen.findByRole("alert")
  expect(alert).toHaveTextContent(opts.title)
  expect(alert).toHaveTextContent("boom")
  expect(screen.queryByText(opts.empty)).not.toBeInTheDocument()
  expect(screen.queryByText(/\{"/)).not.toBeInTheDocument()

  opts.succeed()
  await userEvent.setup().click(screen.getByRole("button", { name: /Retry/ }))
  expect((await screen.findAllByText(opts.recovered)).length).toBeGreaterThan(0)
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("SettingsLoadError", () => {
  it("shows the failure, the reason and a retry button", async () => {
    const onRetry = vi.fn()
    renderWithIntl(<SettingsLoadError message="boom" onRetry={onRetry} />)
    expect(screen.getByRole("alert")).toHaveTextContent("Failed to load")
    expect(screen.getByText("boom")).toBeInTheDocument()
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe("settings lists that failed to load (#438)", () => {
  it("model providers", async () => {
    api.listModelProviders.mockRejectedValueOnce(boom)
    renderWithIntl(<ModelProviderSettings />)
    await expectErrorThenRetry({
      title: enMessages.ModelProviderSettings.loadFailed,
      empty: enMessages.ModelProviderSettings.noProviders,
      recovered: "Acme Provider",
      succeed: () =>
        api.listModelProviders.mockResolvedValueOnce([
          {
            id: 1,
            name: "Acme Provider",
            api_url: "http://localhost:1/v1",
            agent_type: "claude_code",
          },
        ]),
    })
  })

  it("chat channels", async () => {
    api.listChatChannels.mockRejectedValueOnce(boom)
    renderWithIntl(<ChannelListTab />)
    await expectErrorThenRetry({
      title: enMessages.ChatChannelSettings.loadFailed,
      empty: enMessages.ChatChannelSettings.noChannels,
      recovered: "Team Room",
      succeed: () =>
        api.listChatChannels.mockResolvedValueOnce([
          {
            id: 1,
            name: "Team Room",
            channel_type: "telegram",
            enabled: false,
            config_json: "{}",
            event_filter_json: null,
            daily_report_enabled: false,
            daily_report_time: null,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]),
    })
  })

  it("skills, when every agent's skills probe failed", async () => {
    api.acpListAgents.mockResolvedValue([agent])
    api.acpListAgentSkills.mockRejectedValueOnce(boom)
    renderWithIntl(<SkillsSettings />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.SkillsSettings.emptyNoManageableAgents,
      recovered: enMessages.SkillsSettings.managedTarget,
      succeed: () =>
        api.acpListAgentSkills.mockResolvedValue({
          supported: true,
          message: null,
          locations: [],
          skills: [],
        }),
    })
  })

  it("local MCP", async () => {
    api.mcpScanLocal.mockRejectedValueOnce(boom)
    renderWithIntl(<McpSettings />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.McpSettings.local.empty,
      recovered: "acme-mcp",
      succeed: () =>
        api.mcpScanLocal.mockResolvedValueOnce({
          servers: [
            {
              id: "acme-mcp",
              spec: { type: "stdio", command: "acme" },
              apps: ["claude_code"],
            },
          ],
          warnings: [],
        }),
    })
  })

  it("quick messages", async () => {
    api.quickMessagesList.mockRejectedValueOnce(boom)
    renderWithIntl(<QuickMessagesSettings />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.QuickMessagesSettings.emptyList,
      recovered: "Say hello",
      succeed: () =>
        api.quickMessagesList.mockResolvedValueOnce([
          {
            id: 1,
            title: "Say hello",
            content: "hello",
            sort_order: 0,
            created_at: "2026-01-01T00:00:00Z",
            updated_at: "2026-01-01T00:00:00Z",
          },
        ]),
    })
  })

  it("skill packs", async () => {
    api.acpListAgents.mockResolvedValue([agent])
    api.expertsList.mockRejectedValueOnce(boom)
    renderWithIntl(<ExpertsBody />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.ExpertsSettings.emptyExperts,
      recovered: "acme-expert",
      succeed: () =>
        api.expertsList.mockResolvedValueOnce([
          {
            metadata: {
              id: "acme-expert",
              display_name: { en: "acme-expert" },
              description: { en: "" },
              category: "workflow",
              icon: null,
              sort_order: 0,
              bundled_hash: "",
            },
            installed_centrally: true,
            user_modified: false,
            central_path: "/tmp/experts/acme-expert",
          },
        ]),
    })
  })
})
