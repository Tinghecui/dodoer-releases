import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import { automationComputeNextRun } from "@/lib/api"
import type { AutomationDraft } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

// ── The editor's heavy children, stubbed: only the schedule row and the save
// path are under test here. ─────────────────────────────────────────────────
vi.mock("@/lib/api", () => ({
  automationComputeNextRun: vi.fn(),
}))
vi.mock("@/lib/custom-agents", () => ({
  getAgentLabel: () => "Claude Code",
}))
// 两个按钮模拟用户在智能体选择器里换智能体（#1456 的「改过没有」要用）。
vi.mock("@/components/chat/agent-selector", () => ({
  AgentSelector: ({ onSelect }: { onSelect: (a: string) => void }) => (
    <>
      <button type="button" onClick={() => onSelect("codex")}>
        pick-codex
      </button>
      <button type="button" onClick={() => onSelect("claude_code")}>
        pick-claude
      </button>
    </>
  ),
}))
vi.mock("@/components/chat/composer/rich-composer", async () => {
  const { forwardRef, useImperativeHandle } = await import("react")
  return {
    RichComposer: forwardRef(function RichComposer(
      { defaultText }: { defaultText?: string },
      ref
    ) {
      // No Tiptap editor: submit falls back to the plain text.
      useImperativeHandle(ref, () => ({
        getEditor: () => null,
        getText: () => defaultText ?? "",
      }))
      return <div data-testid="composer" />
    }),
  }
})
vi.mock("@/components/chat/composer/use-reference-search", () => ({
  useReferenceSearch: () => ({}),
}))
vi.mock("@/components/chat/composer/use-composer-mention-labels", () => ({
  useComposerMentionLabels: () => ({ groupLabels: {}, uiLabels: {} }),
}))
vi.mock("@/components/chat/composer/to-prompt-blocks", () => ({
  docToPromptBlocks: () => [],
}))
vi.mock("@/components/chat/composer/use-composer-chrome-focus", () => ({
  useComposerChromeFocus: () => ({}),
}))
vi.mock("./agent-config-section", () => ({
  AgentConfigSection: () => null,
  effectiveSelections: () => ({ mode_id: null, config_values: {} }),
  snapshotLabels: () => ({}),
  useBooleanOptionLabels: () => ({ on: "On", off: "Off" }),
}))
vi.mock("@/components/shared/branch-picker", () => ({
  BranchPicker: () => null,
}))
vi.mock("./composer-invocations", () => ({
  ComposerInvocationsPopup: () => null,
  useComposerInvocations: () => ({
    isOpen: false,
    knownInvocations: [],
    detect: () => {},
    onKeyDown: () => false,
  }),
}))
vi.mock("./cron-builder-dialog", () => ({
  CronBuilderDialog: () => null,
}))
vi.mock("./use-agent-options", () => ({
  useAgentOptions: () => ({
    snapshot: null,
    snapshotAgentType: null,
    snapshotModel: null,
    current: true,
    loading: false,
    error: null,
    reload: () => {},
    ensure: async () => null,
  }),
}))
// 每个可选文件夹一个按钮，模拟用户手动选文件夹。
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: ({
    folders,
    onChange,
  }: {
    folders: { id: number; name: string }[]
    onChange: (id: number) => void
  }) => (
    <>
      {folders.map((f) => (
        <button key={f.id} type="button" onClick={() => onChange(f.id)}>
          {`pick-folder-${f.name}`}
        </button>
      ))}
    </>
  ),
}))

import { AutomationEditor } from "./automation-editor"

const mockNextRun = vi.mocked(automationComputeNextRun)

// What a server-mode call rejects with: the parsed error body the web
// transport throws as-is (`AppCommandError::db` on the backend), not an Error.
const INVALID_CRON = {
  code: "database_error",
  message: "Database operation failed",
  detail: "validation error: invalid cron 'every day': Invalid expression",
}

const draft: AutomationDraft = {
  name: "Nightly review",
  enabled: true,
  trigger_kind: "schedule",
  cron: "every day",
  timezone: "UTC",
  agent_type: "claude_code",
  root_folder_id: 1,
  isolation: "worktree_per_run",
  branch: null,
  is_remote_branch: false,
  config: {
    action: "launch_session",
    prompt_blocks: [{ type: "text", text: "Review the open PRs" }],
    display_text: "Review the open PRs",
    mode_id: null,
    config_values: {},
  },
}

function renderEditor(
  onSubmit: (draft: AutomationDraft) => Promise<void>,
  locale: "en" | "zh-CN" = "en"
) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? enMessages : zhCNMessages}
    >
      <AutomationEditor
        automation={draft}
        onSubmit={onSubmit}
        onCancel={() => {}}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mockNextRun.mockReset()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    folders: [
      { id: 1, name: "repo", path: "/repo", parent_id: null, kind: "regular" },
    ] as never,
  })
})

describe("AutomationEditor — a schedule the server rejects", () => {
  it("shows the server's reason when saving fails, not [object Object]", async () => {
    mockNextRun.mockRejectedValue(INVALID_CRON)
    const onSubmit = vi.fn().mockRejectedValue(INVALID_CRON)

    renderEditor(onSubmit)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(INVALID_CRON.detail)
    expect(alert).not.toHaveTextContent("[object Object]")
    expect(onSubmit).toHaveBeenCalledTimes(1)
  })

  it("keeps an Error's own message", async () => {
    mockNextRun.mockResolvedValue(null)
    const onSubmit = vi.fn().mockRejectedValue(new Error("Request timed out"))

    renderEditor(onSubmit)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Request timed out"
    )
  })

  it("says why there is no next run beside the dash, and clears it once the expression is valid", async () => {
    mockNextRun.mockImplementation(async (cron: string) => {
      if (cron === "every day") throw INVALID_CRON
      return "2026-11-13T09:00:00Z"
    })

    renderEditor(vi.fn())

    const reason = await screen.findByRole("status")
    expect(reason).toHaveTextContent(INVALID_CRON.detail)
    expect(screen.getByText(/Next run:/)).toHaveTextContent("—")
    expect(mockNextRun).toHaveBeenCalledWith("every day", "UTC")

    fireEvent.change(screen.getByLabelText("Schedule (cron)"), {
      target: { value: "0 9 * * *" },
    })

    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    )
    expect(screen.getByText(/Next run:/)).not.toHaveTextContent("—")
  })

  it("drops the reason when the schedule is cleared", async () => {
    mockNextRun.mockRejectedValue(INVALID_CRON)

    renderEditor(vi.fn())
    await screen.findByRole("status")

    fireEvent.change(screen.getByLabelText("Schedule (cron)"), {
      target: { value: "" },
    })

    await waitFor(() =>
      expect(screen.queryByRole("status")).not.toBeInTheDocument()
    )
  })
})

// What the backend sends for a bad cron since AI QA #162: a 400
// `invalid_input` whose i18n key picks one of three localized sentences.
const FIELD_COUNT = {
  code: "invalid_input",
  message:
    "validation error: cron must have 5 fields (min hour dom mon dow), got 2",
  i18n_key: "cronErrorFieldCount",
  i18n_params: { n: "2" },
}
const NEVER_FIRES = {
  code: "invalid_input",
  message:
    "validation error: cron '0 0 31 2 *' never fires: no date matches it",
  i18n_key: "cronErrorNeverFires",
}

describe("AutomationEditor — localized cron errors", () => {
  it("explains a malformed cron in Chinese, with an example, not the English detail", async () => {
    mockNextRun.mockRejectedValue(FIELD_COUNT)

    renderEditor(vi.fn(), "zh-CN")

    const reason = await screen.findByRole("status")
    expect(reason).toHaveTextContent(
      "cron 需要 5 段（分 时 日 月 周），现在是 2 段。示例：0 9 * * 1-5"
    )
    expect(reason).not.toHaveTextContent("validation error")
  })

  it("says a schedule that never fires will never run, before saving", async () => {
    mockNextRun.mockResolvedValue(null)

    renderEditor(vi.fn(), "zh-CN")

    expect(await screen.findByRole("status")).toHaveTextContent(
      zhCNMessages.Automations.cronErrorNeverFires
    )
  })

  it("shows the refused save in the user's language", async () => {
    mockNextRun.mockResolvedValue(null)
    const onSubmit = vi.fn().mockRejectedValue(NEVER_FIRES)

    renderEditor(onSubmit)
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent(enMessages.Automations.cronErrorNeverFires)
    expect(alert).not.toHaveTextContent("validation error")
  })
})

describe("AutomationEditor — 报告改没改过（#1456）", () => {
  function renderWithDirty(onDirtyChange: (dirty: boolean) => void) {
    mockNextRun.mockResolvedValue("2026-06-02T09:00:00Z")
    return render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutomationEditor
          automation={draft}
          onSubmit={vi.fn()}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
        />
      </NextIntlClientProvider>
    )
  }

  it("刚打开不算改过；改名算改过，改回原样又不算", () => {
    const onDirtyChange = vi.fn()
    renderWithDirty(onDirtyChange)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    const name = screen.getByLabelText(enMessages.Automations.name)
    fireEvent.change(name, { target: { value: "Nightly review 改名" } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.change(name, { target: { value: "Nightly review" } })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it("换了智能体算改过，换回原来的智能体又不算", () => {
    const onDirtyChange = vi.fn()
    renderWithDirty(onDirtyChange)
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole("button", { name: "pick-codex" }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole("button", { name: "pick-claude" }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it("新建时没给文件夹：手动选了别的文件夹算改过，选回来不算", () => {
    useAppWorkspaceStore.setState({
      folders: [
        {
          id: 1,
          name: "repo",
          path: "/repo",
          parent_id: null,
          kind: "regular",
        },
        { id: 2, name: "web", path: "/web", parent_id: null, kind: "regular" },
      ] as never,
    })
    const onDirtyChange = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutomationEditor
          automation={null}
          onSubmit={vi.fn()}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
        />
      </NextIntlClientProvider>
    )
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole("button", { name: "pick-folder-web" }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)

    fireEvent.click(screen.getByRole("button", { name: "pick-folder-repo" }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)
  })

  it("打开时文件夹还没加载、之后自动补上的默认文件夹不算改过", () => {
    useAppWorkspaceStore.setState({ folders: [] as never })
    const onDirtyChange = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AutomationEditor
          automation={null}
          onSubmit={vi.fn()}
          onCancel={() => {}}
          onDirtyChange={onDirtyChange}
        />
      </NextIntlClientProvider>
    )
    act(() => {
      useAppWorkspaceStore.setState({
        folders: [
          {
            id: 1,
            name: "repo",
            path: "/repo",
            parent_id: null,
            kind: "regular",
          },
          {
            id: 2,
            name: "web",
            path: "/web",
            parent_id: null,
            kind: "regular",
          },
        ] as never,
      })
    })
    expect(onDirtyChange).toHaveBeenLastCalledWith(false)

    fireEvent.click(screen.getByRole("button", { name: "pick-folder-web" }))
    expect(onDirtyChange).toHaveBeenLastCalledWith(true)
  })
})
