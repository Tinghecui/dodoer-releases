import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Automation } from "@/lib/types"

// #1335：自动化页在手机布局下不用左右分栏，先看自动化列表，点一项进详情，
// 详情里返回回到列表；标题栏的返回这时也先回到列表。宽屏照旧左右分栏。

const state = vi.hoisted(() => ({ mobile: true }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isDesktop: () => false,
}))

const refetch = vi.fn().mockResolvedValue(undefined)
let automations: Automation[] = []

vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({
    automations,
    unseenFailures: 0,
    error: null,
    loaded: true,
    refetch,
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: vi.fn() }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/lib/api", () => ({
  automationMarkSeen: vi.fn().mockResolvedValue(undefined),
  automationCreate: vi.fn(),
  automationUpdate: vi.fn(),
  automationDelete: vi.fn(),
  automationRunNow: vi.fn(),
  automationSetEnabled: vi.fn(),
  automationCancelRun: vi.fn(),
  automationRuns: vi.fn().mockResolvedValue([]),
}))
vi.mock("./automation-editor", () => ({
  AutomationEditor: ({ automation }: { automation: { name?: string } }) => (
    <div data-testid="editor-name">{automation?.name ?? "<blank>"}</div>
  ),
}))

import enMessages from "@/i18n/messages/en.json"
import { MobileBackButton } from "@/components/layout/mobile-back-button"
import { requestAutomationsFocus } from "@/lib/workbench-focus"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { AutomationsPage } from "./automations-page"

const BASE: Automation = {
  id: 7,
  name: "Nightly sweep",
  enabled: true,
  trigger_kind: "manual",
  cron: null,
  timezone: "UTC",
  next_run_at: null,
  agent_type: "claude_code",
  root_folder_id: 1,
  isolation: "worktree_per_run",
  branch: null,
  is_remote_branch: false,
  config: {
    prompt_blocks: [{ type: "text", text: "do the thing" }],
    display_text: "do the thing",
    config_values: {},
  },
  last_run_at: null,
  last_run_status: null,
  last_run_conversation_id: null,
  unseen_failures: 0,
  created_at: "2026-06-01T00:00:00Z",
  updated_at: "2026-06-01T00:00:00Z",
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div data-testid="title-bar">
        <MobileBackButton />
      </div>
      <AutomationsPage />
    </NextIntlClientProvider>
  )
}

function pane(kind: "list" | "detail"): HTMLElement {
  const el = document.querySelector(`[data-list-detail-pane="${kind}"]`)
  if (!el) throw new Error(`no ${kind} pane`)
  return el as HTMLElement
}

function openItem(name: string) {
  fireEvent.click(within(pane("list")).getByText(name))
}

beforeEach(() => {
  state.mobile = true
  automations = [BASE, { ...BASE, id: 8, name: "Weekly report" }]
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [{ id: 1, name: "repo", kind: "regular" }] as never,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("AutomationsPage 手机布局：列表加详情", () => {
  it("先只显示列表，点一项进详情，详情里的返回回到列表", async () => {
    renderPage()
    await act(async () => {})

    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")

    openItem("Weekly report")
    expect(pane("list")).toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(
      within(pane("detail")).getAllByText("Weekly report").length
    ).toBeGreaterThan(0)

    fireEvent.click(
      within(pane("detail")).getByRole("button", {
        name: enMessages.Folder.windowControls.back,
      })
    )
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")
  })

  it("在详情里按标题栏的返回，先回到列表", async () => {
    renderPage()
    await act(async () => {})
    openItem("Nightly sweep")
    expect(pane("detail")).not.toHaveClass("hidden")

    fireEvent.click(
      within(screen.getByTestId("title-bar")).getByRole("button", {
        name: enMessages.Folder.windowControls.back,
      })
    )
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")
  })

  it("点「新建」直接进详情里的模板列表", async () => {
    renderPage()
    await act(async () => {})
    fireEvent.click(screen.getByText(enMessages.Automations.new))
    expect(pane("list")).toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(
      within(pane("detail")).getByText(enMessages.Automations.startFromTemplate)
    ).toBeInTheDocument()
  })

  it("从侧面板带着某个自动化打开时，直接看它的详情", async () => {
    requestAutomationsFocus({ folderId: null, automationId: 8 })
    renderPage()
    await act(async () => {})
    expect(pane("list")).toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
  })

  it("宽屏照旧左右分栏，两栏都在，详情里没有返回按钮", async () => {
    state.mobile = false
    renderPage()
    await act(async () => {})
    openItem("Weekly report")
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(
      within(pane("detail")).queryByRole("button", {
        name: enMessages.Folder.windowControls.back,
      })
    ).not.toBeInTheDocument()
  })
})
