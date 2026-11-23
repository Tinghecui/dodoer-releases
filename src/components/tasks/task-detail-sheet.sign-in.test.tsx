/**
 * #1403：任务因为智能体没有登录凭据失败时，详情里的失败说明旁边给一个去登录 /
 * 配置的入口；别的失败不给。
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"

const openAgentSignIn = vi.fn()

vi.mock("@/lib/cowork/sign-in", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cowork/sign-in")>()),
  openAgentSignIn: (...args: unknown[]) => openAgentSignIn(...args),
}))
vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: vi.fn().mockResolvedValue(undefined),
  workTaskDefer: vi.fn().mockResolvedValue(undefined),
  workTaskDelete: vi.fn().mockResolvedValue(undefined),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
  workTaskMergeUnqueue: vi.fn().mockResolvedValue(undefined),
  workTaskRequeue: vi.fn().mockResolvedValue(undefined),
  workTaskRetry: vi.fn().mockResolvedValue(undefined),
  workTaskReturn: vi.fn().mockResolvedValue(undefined),
  workTaskStart: vi.fn().mockResolvedValue(undefined),
  folderForgeRemote: vi.fn().mockResolvedValue(null),
  openSettingsWindow: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
  isRemoteDesktopWindow: () => false,
  openUrl: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children?: string }) => (
    <div>{children}</div>
  ),
}))
vi.mock("@/components/diff/unified-diff-preview", () => ({
  UnifiedDiffPreview: () => <div />,
}))
vi.mock("./task-message-composer", () => ({
  TaskMessageComposer: () => <div data-testid="follow-up-composer" />,
}))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

function failed(lastError: string): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Reply ok",
    config: { agent_type: "codex" },
    agent_type: "codex",
    status: "failed",
    failure_reason: "agent_error",
    last_error: lastError,
    work_branch: "task/7",
    worktree_folder_id: 9,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 0,
  } as unknown as WorkTask
}

function mount(row: WorkTask) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskDetailSheet
        open
        onOpenChange={() => {}}
        task={row}
        folderName="repo"
        onMerge={() => {}}
        onComplete={() => {}}
        onDeliverPr={() => {}}
        onCancel={() => {}}
        onEdit={() => {}}
        onSchedule={() => {}}
      />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("task drawer sign-in entry", () => {
  it("offers sign-in next to a missing-credentials failure", async () => {
    const user = userEvent.setup()
    mount(
      failed(
        "智能体没有登录凭据，去 Agents 设置里配置好再重试。原始报错：Authentication required"
      )
    )
    await user.click(screen.getByRole("button", { name: "Sign in" }))
    expect(openAgentSignIn).toHaveBeenCalledWith("codex")
  })

  it("does not offer it for other failures", () => {
    mount(failed("智能体的连接断开了，这一轮没有跑完。原始报错：boom"))
    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull()
  })
})
