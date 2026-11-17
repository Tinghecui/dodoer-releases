import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { ChannelListTab } from "./channel-list-tab"
import { CustomSkillsBody } from "./custom-skills-settings"
import { ExpertsBody } from "./experts-settings"
import { GenerativeUiBody } from "./generative-ui-settings"
import { McpSettings } from "./mcp-settings"
import { ModelProviderSettings } from "./model-provider-settings"
import { OfficeToolsBody } from "./office-tools-settings"
import { QuickMessagesSettings } from "./quick-messages-settings"
import { ScienceBody } from "./science-settings"
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
  customList: vi.fn(),
  customListAllInstallStatuses: vi.fn(async () => []),
  customApplyLinks: vi.fn(),
  customReadSkill: vi.fn(),
  scienceList: vi.fn(),
  scienceListAllInstallStatuses: vi.fn(async () => []),
  scienceApplyLinks: vi.fn(),
  scienceReadContent: vi.fn(),
  generativeUiSkillInfo: vi.fn(),
  generativeUiListAllInstallStatuses: vi.fn(async () => []),
  generativeUiApplyLinks: vi.fn(),
  generativeUiReadContent: vi.fn(),
  officecliDetect: vi.fn(async () => ({
    installed: true,
    version: "1.0.0",
    path: "/usr/local/bin/officecli",
    runtimeError: null,
  })),
  officecliListSkills: vi.fn(),
  officecliSkillListAllInstallStatuses: vi.fn(async () => []),
  officecliSkillApplyLinks: vi.fn(),
  officecliSkillReadContent: vi.fn(),
}))

vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  isLocalDesktop: () => false,
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
  // 照真表格：工具栏总在，没有技能时写「暂无内容。」
  SkillAgentMatrix: ({
    skills,
    toolbarActions,
  }: {
    skills: { id: string }[]
    toolbarActions?: ReactNode
  }) => (
    <div>
      {toolbarActions}
      {skills.length === 0 ? (
        <p>{enMessages.SkillMatrix.empty}</p>
      ) : (
        <ul>
          {skills.map((s) => (
            <li key={s.id}>{s.id}</li>
          ))}
        </ul>
      )}
    </div>
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

  it("custom skills", async () => {
    api.acpListAgents.mockResolvedValue([agent])
    api.customList.mockRejectedValueOnce(boom)
    renderWithIntl(<CustomSkillsBody />)
    await screen.findByRole("alert")
    // 工具栏（新建、导入）也一起替掉
    expect(
      screen.queryByRole("button", {
        name: enMessages.CustomSkillsSettings.actions.new,
      })
    ).not.toBeInTheDocument()
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.SkillMatrix.empty,
      recovered: "acme-skill",
      succeed: () =>
        api.customList.mockResolvedValueOnce([
          {
            id: "acme-skill",
            name: "acme-skill",
            description: null,
            central_path: "/tmp/skills/acme-skill",
          },
        ]),
    })
  })

  it("custom skills, when the agent list failed", async () => {
    api.customList.mockResolvedValue([])
    api.acpListAgents.mockRejectedValueOnce(boom)
    renderWithIntl(<CustomSkillsBody />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.SkillMatrix.empty,
      recovered: enMessages.SkillMatrix.empty,
      succeed: () => api.acpListAgents.mockResolvedValueOnce([agent]),
    })
  })

  it("science skills", async () => {
    api.acpListAgents.mockResolvedValue([agent])
    api.scienceList.mockRejectedValueOnce(boom)
    renderWithIntl(<ScienceBody />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.ScienceSettings.emptySkills,
      recovered: "acme-science",
      succeed: () =>
        api.scienceList.mockResolvedValueOnce([
          {
            metadata: {
              id: "acme-science",
              display_name: { en: "acme-science" },
              description: { en: "" },
              category: "analysis",
              icon: null,
              sort_order: 0,
              bundled_hash: "",
              needs_key: false,
              needs_env: false,
              featured: false,
              accent: null,
            },
            installed_centrally: true,
            user_modified: false,
            central_path: "/tmp/science/acme-science",
          },
        ]),
    })
  })

  it("generative UI", async () => {
    api.acpListAgents.mockResolvedValue([agent])
    api.generativeUiSkillInfo.mockRejectedValueOnce(boom)
    renderWithIntl(<GenerativeUiBody />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.GenerativeUiSettings.usage,
      recovered: "ui-render",
      succeed: () =>
        api.generativeUiSkillInfo.mockResolvedValueOnce({
          id: "ui-render",
          conflict: false,
        }),
    })
  })

  it("office skills", async () => {
    api.acpListAgents.mockResolvedValue([agent])
    api.officecliListSkills.mockRejectedValueOnce(boom)
    renderWithIntl(<OfficeToolsBody />)
    await expectErrorThenRetry({
      title: enMessages.SettingsLoadError.title,
      empty: enMessages.OfficeToolsSettings.emptySkills,
      recovered: "acme-office",
      succeed: () =>
        api.officecliListSkills.mockResolvedValueOnce([
          {
            id: "acme-office",
            category: "documents",
            icon: "FileText",
            sortOrder: 0,
            displayName: { en: "acme-office" },
            description: { en: "" },
            installedCentrally: true,
          },
        ]),
    })
  })

  it("skills, when some agents' probes failed and others worked", async () => {
    const other = { ...agent, agent_type: "codex", name: "Codex" }
    api.acpListAgents.mockResolvedValue([agent, other])
    api.acpListAgentSkills.mockImplementation(
      async ({ agentType }: { agentType: string }) => {
        if (agentType === "codex") throw boom
        return { supported: true, message: null, locations: [], skills: [] }
      }
    )
    renderWithIntl(<SkillsSettings />)
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("1 agent couldn't be read")
    expect(alert).toHaveTextContent("boom")
    // 成功的那个照常能管，不是整页加载失败
    expect(
      screen.getByText(enMessages.SkillsSettings.managedTarget)
    ).toBeInTheDocument()
    expect(alert).not.toHaveTextContent(enMessages.SettingsLoadError.title)

    api.acpListAgentSkills.mockResolvedValue({
      supported: true,
      message: null,
      locations: [],
      skills: [],
    })
    await userEvent.setup().click(screen.getByRole("button", { name: /Retry/ }))
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    )
    expect(
      screen.getByText(enMessages.SkillsSettings.managedTarget)
    ).toBeInTheDocument()
  })

  it("skills, when one probe failed and the other said unsupported", async () => {
    const other = { ...agent, agent_type: "codex", name: "Codex" }
    api.acpListAgents.mockResolvedValue([agent, other])
    api.acpListAgentSkills.mockImplementation(
      async ({ agentType }: { agentType: string }) => {
        if (agentType === "codex") throw boom
        return { supported: false, message: null, locations: [], skills: [] }
      }
    )
    renderWithIntl(<SkillsSettings />)
    // 有一个探测成功了（只是不支持），算部分失败，不是整页加载失败
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("1 agent couldn't be read")
    expect(alert).toHaveTextContent("boom")
    expect(
      screen.queryByText(enMessages.SettingsLoadError.title)
    ).not.toBeInTheDocument()
    expect(
      screen.getByText(enMessages.SkillsSettings.emptyNoManageableAgents)
    ).toBeInTheDocument()
  })
})

// 接口成功、确实一条都没有时，照旧显示各自的空状态，不显示加载失败（#526）
describe("skill pack tabs that are really empty", () => {
  beforeEach(() => {
    api.acpListAgents.mockResolvedValue([agent])
  })

  it("custom skills keep the toolbar and the empty matrix", async () => {
    api.customList.mockResolvedValueOnce([])
    renderWithIntl(<CustomSkillsBody />)
    expect(
      await screen.findByRole("button", {
        name: enMessages.CustomSkillsSettings.actions.new,
      })
    ).toBeInTheDocument()
    expect(screen.getByText(enMessages.SkillMatrix.empty)).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("science skills", async () => {
    api.scienceList.mockResolvedValueOnce([])
    renderWithIntl(<ScienceBody />)
    expect(
      await screen.findByText(enMessages.ScienceSettings.emptySkills)
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("generative UI", async () => {
    api.generativeUiSkillInfo.mockResolvedValueOnce({
      id: "ui-render",
      conflict: false,
    })
    renderWithIntl(<GenerativeUiBody />)
    expect(await screen.findByText("ui-render")).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("office skills", async () => {
    api.officecliListSkills.mockResolvedValueOnce([])
    renderWithIntl(<OfficeToolsBody />)
    expect(
      await screen.findByText(enMessages.OfficeToolsSettings.emptySkills)
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })

  it("skills, with every probe working", async () => {
    api.acpListAgentSkills.mockResolvedValue({
      supported: true,
      message: null,
      locations: [],
      skills: [],
    })
    renderWithIntl(<SkillsSettings />)
    expect(
      await screen.findByText(enMessages.SkillsSettings.managedTarget)
    ).toBeInTheDocument()
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  })
})
