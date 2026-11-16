/**
 * 任务列表第一次加载失败时，页面要说「加载失败」并给「重试」，
 * 不能当成「还没有任务」（#339）。
 */
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

const view = {
  tasks: [] as WorkTask[],
  loading: false,
  error: null as string | null,
  refetch: vi.fn(async () => {}),
  viewMode: "board" as "board" | "list",
}
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => view,
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    folders: [
      { id: 1, name: "codeg", alias: null, parent_id: null, kind: "regular" },
    ],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn(),
  workTaskCreate: vi.fn(),
  workTaskMergeUnqueue: vi.fn(),
  workTaskReorder: vi.fn(),
  workTaskStart: vi.fn(),
  workTaskUpdate: vi.fn(),
}))
// Every dialog and drawer the page hosts: closed throughout, and each pulls a
// module graph this test has nothing to say about.
vi.mock("./task-detail-sheet", () => ({ TaskDetailSheet: () => null }))
vi.mock("./task-editor-dialog", () => ({ TaskEditorDialog: () => null }))
vi.mock("./task-merge-dialog", () => ({ TaskMergeDialog: () => null }))
vi.mock("./task-complete-dialog", () => ({ TaskCompleteDialog: () => null }))
vi.mock("./task-deliver-pr-dialog", () => ({
  TaskDeliverPrDialog: () => null,
}))
vi.mock("./task-cancel-dialog", () => ({ TaskCancelDialog: () => null }))
vi.mock("./task-restart-dialog", () => ({ TaskRestartDialog: () => null }))
vi.mock("./task-schedule-dialog", () => ({ TaskScheduleDialog: () => null }))
vi.mock("./task-settings-dialog", () => ({ TaskSettingsDialog: () => null }))
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: () => <div data-testid="folder-select" />,
}))

import { TasksPage } from "./tasks-page"

function mount() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TasksPage />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  localStorage.clear()
  view.tasks = []
  view.loading = false
  view.error = null
  view.refetch.mockClear()
})

describe("TasksPage load failure (#339)", () => {
  it("says the list failed to load and offers a retry, not the empty state", async () => {
    view.error = "HTTP 500"
    mount()
    expect(screen.getByText(enMessages.Tasks.loadFailed)).toBeInTheDocument()
    expect(screen.getByText("HTTP 500")).toBeInTheDocument()
    expect(screen.queryByText(enMessages.Tasks.empty)).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: enMessages.Tasks.new })
    ).not.toBeInTheDocument()

    await userEvent.click(
      screen.getByRole("button", { name: enMessages.Tasks.retry })
    )
    expect(view.refetch).toHaveBeenCalledTimes(1)
  })

  it("still shows the empty state when the list loaded and is empty", () => {
    mount()
    expect(screen.getByText(enMessages.Tasks.empty)).toBeInTheDocument()
    expect(
      screen.queryByText(enMessages.Tasks.loadFailed)
    ).not.toBeInTheDocument()
  })
})
