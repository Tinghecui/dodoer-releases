import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import en from "@/i18n/messages/en.json"
import type { DbConversationSummary, TokenUsageReport } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { TokenUsagePage } from "./token-usage-page"

const h = vi.hoisted(() => ({
  report: vi.fn(),
  facets: vi.fn(),
  sync: vi.fn(),
  running: false,
  handlers: new Map<string, (payload: unknown) => void>(),
  agents: [] as { agent_type: string; name: string; enabled: boolean }[],
}))

vi.mock("@/lib/api", () => ({
  tokenUsageReport: h.report,
  tokenUsageFacets: h.facets,
  tokenUsageStatus: async () => ({
    total_conversations: 3,
    synced_conversations: 3,
    stale_conversations: 0,
    fact_rows: 1,
    last_synced_at: null,
    running: h.running,
  }),
  tokenUsageSync: h.sync,
  opencodeProviderCatalog: async () => [],
}))
vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: () => ({ agents: h.agents, fresh: true, refresh: vi.fn() }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: async (event: string, cb: (payload: unknown) => void) => {
    h.handlers.set(event, cb)
    return () => {}
  },
}))
vi.mock("./charts", async () => ({
  ...(await vi.importActual<typeof import("./charts")>("./charts")),
  ActivityHeatmap: () => null,
  RingMeter: () => null,
  TrendChart: () => null,
}))

const report: TokenUsageReport = {
  range_start: null,
  range_end: null,
  bucket: "day",
  totals: {
    input_tokens: 100,
    output_tokens: 20,
    cache_creation_tokens: 10,
    cache_read_tokens: 70,
    total_tokens: 200,
    turn_count: 1,
    conversation_count: 3,
    duration_ms: 1000,
    active_days: 1,
  },
  previous_totals: null,
  series: [],
  by_folder: [],
  by_agent: [],
  by_model: [],
  heatmap: [],
  top_conversations: [],
  streak: { longest_days: 1, current_days: 1, current_ends_on: null },
  first_activity_at: null,
  last_activity_at: null,
  truncated: false,
}

function page() {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <TokenUsagePage />
    </NextIntlClientProvider>
  )
}

describe("Token Usage agent filter", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    h.agents = [
      { agent_type: "claude_code", name: "Claude Code", enabled: true },
      { agent_type: "codex", name: "Codex CLI", enabled: true },
      {
        agent_type: "custom:claude-code-2",
        name: "Claude Code 2",
        enabled: true,
      },
      {
        agent_type: "custom:claude-code-3",
        name: "Review account",
        enabled: true,
      },
      {
        agent_type: "custom:unused-disabled",
        name: "Disabled account",
        enabled: false,
      },
    ]
    h.report.mockResolvedValue(report)
    // Registered accounts without usage, and deleted registrations with
    // history, must both remain reachable in the same filter.
    h.facets.mockResolvedValue({
      folders: [],
      agents: ["claude_code", "custom:retired-reviewer"],
      models: [],
      data_start: null,
      data_end: null,
    })
  })

  it("includes configured custom accounts and submits their exact IDs", async () => {
    const user = userEvent.setup()
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalled())
    await user.click(
      await screen.findByRole("button", {
        name: en.TokenUsage.agentFilter,
        expanded: false,
      })
    )
    const menu = within(screen.getByRole("dialog"))
    expect(menu.getByRole("button", { name: "Codex" })).toBeTruthy()
    expect(menu.getByRole("button", { name: "Claude Code 2" })).toBeTruthy()
    expect(menu.getByRole("button", { name: "Retired Reviewer" })).toBeTruthy()
    expect(menu.queryByRole("button", { name: "Disabled account" })).toBeNull()
    await user.click(menu.getByRole("button", { name: "Review account" }))
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentTypes: ["custom:claude-code-3"] })
      )
    )
  })

  it("updates custom names while open and keeps a selection after its registration disappears", async () => {
    const user = userEvent.setup()
    const view = render(page())
    await user.click(
      await screen.findByRole("button", {
        name: en.TokenUsage.agentFilter,
        expanded: false,
      })
    )
    await user.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Review account",
      })
    )
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentTypes: ["custom:claude-code-3"] })
      )
    )
    h.agents = h.agents.map((agent) =>
      agent.agent_type === "custom:claude-code-3"
        ? { ...agent, name: "Renamed account" }
        : agent
    )
    view.rerender(page())
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Renamed account",
      })
    ).toHaveAttribute("aria-pressed", "true")
    h.agents = h.agents.filter(
      (agent) => agent.agent_type !== "custom:claude-code-3"
    )
    view.rerender(page())
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Claude Code 3",
      })
    ).toHaveAttribute("aria-pressed", "true")
  })

  it("refreshes the rendered agent breakdown after a registration is renamed", async () => {
    h.report.mockResolvedValue({
      ...report,
      by_agent: [
        {
          ...report.totals,
          key: "custom:claude-code-3",
          label: "custom:claude-code-3",
        },
      ],
    })
    const user = userEvent.setup()
    const view = render(page())
    await user.click(
      await screen.findByRole("button", { name: en.TokenUsage.byAgentTitle })
    )
    expect(await screen.findByText("Review account")).toBeInTheDocument()

    h.agents = h.agents.map((agent) =>
      agent.agent_type === "custom:claude-code-3"
        ? { ...agent, name: "Renamed reviewer" }
        : agent
    )
    view.rerender(page())
    expect(screen.getByText("Renamed reviewer")).toBeInTheDocument()
    expect(screen.queryByText("Review account")).not.toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /Renamed reviewer/ }))
    await waitFor(() =>
      expect(h.report).toHaveBeenLastCalledWith(
        expect.objectContaining({ agentTypes: ["custom:claude-code-3"] })
      )
    )
  })
})

// 用量页开着时在侧栏删会话（#1194）：侧栏的会话列表变了，报表要跟着重读，
// 不然会话数、排行一直停在删之前的数，要整页刷新才对。
describe("Token Usage refetch on sidebar conversation changes", () => {
  const conv = (id: number) =>
    ({ id, folder_id: 1, title: `c${id}` }) as unknown as DbConversationSummary

  beforeEach(() => {
    vi.clearAllMocks()
    h.agents = []
    h.report.mockResolvedValue(report)
    h.facets.mockResolvedValue({
      folders: [],
      agents: [],
      models: [],
      data_start: null,
      data_end: null,
    })
    useAppWorkspaceStore.setState({
      conversations: [conv(1), conv(2), conv(3)],
    })
  })

  it("reloads the report after a conversation is deleted", async () => {
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    useAppWorkspaceStore.getState().applyConversationRemove(2)
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2))
  })

  it("coalesces several quick deletions into one reload", async () => {
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    useAppWorkspaceStore.getState().applyConversationRemove(1)
    useAppWorkspaceStore.getState().applyConversationRemove(3)
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 500))
    expect(h.report).toHaveBeenCalledTimes(2)
  })

  it("does not reload when the conversation list is unchanged", async () => {
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    useAppWorkspaceStore.setState({
      conversations: [conv(1), conv(2), conv(3)],
    })
    await new Promise((r) => setTimeout(r, 500))
    expect(h.report).toHaveBeenCalledTimes(1)
  })
})

// 用量页开着时一轮聊完、或在侧栏改名（#1211）：会话个数不变，按个数重读的
// 逻辑不动，排行一直是 0 token 和旧标题。回合结束要增量同步再重读，改名要重读。
describe("Token Usage refresh on turn end and rename", () => {
  const conv = (
    id: number,
    over: Partial<DbConversationSummary> = {}
  ): DbConversationSummary =>
    ({
      id,
      folder_id: 1,
      title: `c${id}`,
      status: "completed",
      updated_at: "2026-11-20T00:00:00Z",
      ...over,
    }) as unknown as DbConversationSummary

  // 上一组删过 1～3 号，store 的墓碑会吞掉这几个 id 的 upsert，这里换号
  beforeEach(() => {
    vi.clearAllMocks()
    h.agents = []
    h.running = false
    h.report.mockResolvedValue(report)
    h.sync.mockResolvedValue({ synced: 1, failed: 0 })
    h.facets.mockResolvedValue({
      folders: [],
      agents: [],
      models: [],
      data_start: null,
      data_end: null,
    })
    useAppWorkspaceStore.setState({
      conversations: [conv(11), conv(12, { status: "in_progress" })],
    })
  })

  const upsert = (c: DbConversationSummary) =>
    useAppWorkspaceStore.getState().applyConversationUpsert(c)

  it("syncs incrementally and reloads after a turn finishes", async () => {
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    await new Promise((r) => setTimeout(r, 50))
    // 挂载那次不算
    expect(h.sync).not.toHaveBeenCalled()
    upsert(
      conv(12, { status: "completed", updated_at: "2026-11-20T00:01:00Z" })
    )
    await waitFor(() => expect(h.sync).toHaveBeenCalledWith("incremental"), {
      timeout: 3000,
    })
    expect(h.sync).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2))
  })

  it("reloads without syncing when only a title changes", async () => {
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    upsert(conv(11, { title: "renamed" }))
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 1500))
    expect(h.sync).not.toHaveBeenCalled()
    expect(h.report).toHaveBeenCalledTimes(2)
  })

  it("does not start a second sync while one is running, but catches up after", async () => {
    let finish: (v: { synced: number; failed: number }) => void = () => {}
    h.sync.mockImplementationOnce(
      () =>
        new Promise((r) => {
          finish = r
        })
    )
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    upsert(
      conv(12, { status: "completed", updated_at: "2026-11-20T00:01:00Z" })
    )
    await waitFor(() => expect(h.sync).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    })
    upsert(conv(11, { updated_at: "2026-11-20T00:02:00Z" }))
    await new Promise((r) => setTimeout(r, 1500))
    expect(h.sync).toHaveBeenCalledTimes(1)
    finish({ synced: 1, failed: 0 })
    await waitFor(() => expect(h.sync).toHaveBeenCalledTimes(2), {
      timeout: 3000,
    })
  })

  // 改名的后端会顺带改 updated_at（#1260 审查）：不能把它当成回合结束去同步
  it("does not sync when a rename also bumps updated_at", async () => {
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    upsert(conv(11, { title: "renamed", updated_at: "2026-11-20T00:05:00Z" }))
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(2))
    await new Promise((r) => setTimeout(r, 1500))
    expect(h.sync).not.toHaveBeenCalled()
  })

  // 回合结束时别的窗口正在同步（#1260 审查）：那次同步可能在这一轮结束前就开始了，
  // 等它跑完要补一次，不能把这次请求丢掉
  it("catches up after another window's sync finishes", async () => {
    h.running = true
    render(page())
    await waitFor(() => expect(h.report).toHaveBeenCalledTimes(1))
    upsert(
      conv(12, { status: "completed", updated_at: "2026-11-20T00:01:00Z" })
    )
    await new Promise((r) => setTimeout(r, 1500))
    expect(h.sync).not.toHaveBeenCalled()
    // 别的窗口的同步结束：进度事件带结果，本页重读，状态不再是 running
    h.running = false
    h.handlers.get("token-usage-sync://progress")?.({
      result: { synced: 1, failed: 0 },
    })
    await waitFor(() => expect(h.sync).toHaveBeenCalledWith("incremental"), {
      timeout: 3000,
    })
    expect(h.sync).toHaveBeenCalledTimes(1)
  })
})
