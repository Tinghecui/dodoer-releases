import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { Automation } from "@/lib/types"
import type { AutomationEditorDraft } from "@/lib/automation-draft"

// #1564：自动化改到一半刷新或离开页面，草稿存在浏览器里；回来点这一项直接
// 回到编辑器，改过的值还在。保存、取消、确认放弃后草稿清掉。

vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
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
const updateMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/api", () => ({
  automationMarkSeen: vi.fn().mockResolvedValue(undefined),
  automationCreate: vi.fn(),
  automationUpdate: updateMock,
  automationDelete: vi.fn(),
  automationRunNow: vi.fn(),
  automationSetEnabled: vi.fn(),
  automationCancelRun: vi.fn(),
  automationRuns: vi.fn().mockResolvedValue([]),
}))
vi.mock("./automation-editor", async () => {
  const { useState } = await import("react")
  const FULL_DRAFT: AutomationEditorDraft = {
    name: "",
    action: "launch_session",
    agentType: "claude_code",
    userChoseAgent: false,
    prompt: "do the thing",
    folderId: 1,
    isolation: "worktree_per_run",
    trigger: "manual",
    cron: "0 9 * * 1-5",
    modeId: null,
    configValues: {},
    branch: "",
    isRemoteBranch: false,
  }
  // 假编辑器：只有名称一个输入框；改过就通过 onDirtyChange / onDraftChange
  // 报给页面，传了 initialDraft 就用它的值，和真编辑器一样。
  function FakeEditor({
    automation,
    initialDraft,
    onDirtyChange,
    onDraftChange,
    onSubmit,
    onCancel,
  }: {
    automation: { name?: string } | null
    initialDraft?: AutomationEditorDraft | null
    onDirtyChange?: (dirty: boolean) => void
    onDraftChange?: (draft: AutomationEditorDraft | null) => void
    onSubmit: (draft: unknown) => Promise<void>
    onCancel: () => void
  }) {
    const initial = automation?.name ?? ""
    const [name, setName] = useState(initialDraft?.name ?? initial)
    return (
      <div>
        <input
          aria-label="editor-name-input"
          value={name}
          onChange={(e) => {
            const v = e.target.value
            setName(v)
            onDirtyChange?.(v !== initial)
            onDraftChange?.(v !== initial ? { ...FULL_DRAFT, name: v } : null)
          }}
        />
        <button type="button" onClick={() => void onSubmit({ name })}>
          fake-save
        </button>
        <button type="button" onClick={onCancel}>
          fake-cancel
        </button>
      </div>
    )
  }
  return { AutomationEditor: FakeEditor }
})

import enMessages from "@/i18n/messages/en.json"
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

function editAndRename(item: string, newName: string) {
  openItem(item)
  fireEvent.click(
    within(pane("detail")).getByRole("button", {
      name: enMessages.Automations.edit,
    })
  )
  fireEvent.change(screen.getByLabelText("editor-name-input"), {
    target: { value: newName },
  })
}

beforeEach(() => {
  localStorage.clear()
  automations = [BASE, { ...BASE, id: 8, name: "Weekly report" }]
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [{ id: 1, name: "repo", kind: "regular" }] as never,
  })
})

afterEach(() => {
  vi.clearAllMocks()
})

describe("AutomationsPage：编辑到一半刷新，草稿还在（#1564）", () => {
  it("改名不保存、页面重新打开后点同一项，回到编辑器，名称是改过的", async () => {
    const first = renderPage()
    await act(async () => {})
    editAndRename("Weekly report", "Weekly report 改名未保存")
    first.unmount()

    renderPage()
    await act(async () => {})
    // 列表上这一项标着「编辑中」，没点之前就看得出来有草稿。
    const rows = within(pane("list")).getAllByRole("listitem")
    expect(
      within(rows[1]).getByText(enMessages.Automations.editingBadge)
    ).toBeInTheDocument()
    expect(
      within(rows[0]).queryByText(enMessages.Automations.editingBadge)
    ).not.toBeInTheDocument()

    openItem("Weekly report")
    expect(screen.getByLabelText("editor-name-input")).toHaveValue(
      "Weekly report 改名未保存"
    )
  })

  it("详情里点「编辑」也接着草稿改", async () => {
    const first = renderPage()
    await act(async () => {})
    editAndRename("Nightly sweep", "改名未保存")
    first.unmount()

    renderPage()
    await act(async () => {})
    // 第一项的详情自动显示着，直接点它的「编辑」。
    fireEvent.click(
      within(pane("detail")).getByRole("button", {
        name: enMessages.Automations.edit,
      })
    )
    expect(screen.getByLabelText("editor-name-input")).toHaveValue("改名未保存")
  })

  it("点了取消，再打开页面点这一项是详情页", async () => {
    const first = renderPage()
    await act(async () => {})
    editAndRename("Weekly report", "改名未保存")
    fireEvent.click(screen.getByRole("button", { name: "fake-cancel" }))
    first.unmount()

    renderPage()
    await act(async () => {})
    openItem("Weekly report")
    expect(screen.queryByLabelText("editor-name-input")).not.toBeInTheDocument()
  })

  it("保存以后，再打开页面点这一项是详情页", async () => {
    updateMock.mockResolvedValue({ ...BASE, id: 8 })
    const first = renderPage()
    await act(async () => {})
    editAndRename("Weekly report", "改名已保存")
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "fake-save" }))
    })
    first.unmount()

    renderPage()
    await act(async () => {})
    openItem("Weekly report")
    expect(screen.queryByLabelText("editor-name-input")).not.toBeInTheDocument()
  })

  it("确认放弃修改后草稿清掉", async () => {
    const first = renderPage()
    await act(async () => {})
    editAndRename("Nightly sweep", "改名未保存")
    openItem("Weekly report")
    fireEvent.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: enMessages.Automations.discardDraftConfirm,
      })
    )
    first.unmount()

    renderPage()
    await act(async () => {})
    openItem("Nightly sweep")
    expect(screen.queryByLabelText("editor-name-input")).not.toBeInTheDocument()
  })

  it("这一项后来开关过（updated_at 变了），草稿照样留着", async () => {
    const first = renderPage()
    await act(async () => {})
    editAndRename("Weekly report", "改名未保存")
    first.unmount()

    automations = [
      BASE,
      {
        ...BASE,
        id: 8,
        name: "Weekly report",
        enabled: false,
        updated_at: "2026-07-01T00:00:00Z",
      },
    ]
    renderPage()
    await act(async () => {})
    openItem("Weekly report")
    expect(screen.getByLabelText("editor-name-input")).toHaveValue("改名未保存")
  })

  it("这一项已经删掉了，草稿也删掉", async () => {
    const first = renderPage()
    await act(async () => {})
    editAndRename("Weekly report", "改名未保存")
    first.unmount()
    expect(localStorage.length).toBe(1)

    automations = [BASE]
    renderPage()
    await act(async () => {})
    expect(localStorage.length).toBe(0)
  })

  it("一个自动化都没有时新建到一半，再打开页面直接回到那个编辑器", async () => {
    automations = []
    const first = renderPage()
    await act(async () => {})
    fireEvent.click(screen.getByText("Blank automation"))
    fireEvent.change(screen.getByLabelText("editor-name-input"), {
      target: { value: "新建未保存" },
    })
    first.unmount()

    renderPage()
    await act(async () => {})
    // 没有列表、没有「新建」按钮，也不能只显示模板引导让草稿找不回来。
    expect(screen.getByLabelText("editor-name-input")).toHaveValue("新建未保存")
  })

  it("正在编辑的这一项被删掉：编辑器关掉，草稿清掉，不会再被写回去", async () => {
    const view = renderPage()
    await act(async () => {})
    editAndRename("Weekly report", "改名未保存")
    expect(localStorage.length).toBe(1)

    // 从列表 ⋯ 菜单删掉（或在别处删掉）后，列表重新加载回来没有这一项了。
    automations = [BASE]
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutomationsPage />
      </NextIntlClientProvider>
    )
    await act(async () => {})
    expect(screen.queryByLabelText("editor-name-input")).not.toBeInTheDocument()
    expect(localStorage.length).toBe(0)
  })
})
