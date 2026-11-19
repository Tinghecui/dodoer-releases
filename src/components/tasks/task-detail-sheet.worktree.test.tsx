/**
 * The drawer's standalone worktree removal.
 *
 * A settled task can keep the checkout it ran in — every way of stopping offers
 * to take it along, and every one of them lets the user say no (the two
 * acceptances, and the cancel dialog). These pin the one affordance that
 * reclaims it afterwards: who gets it, where it sits, and that nothing is
 * removed without a confirm (git takes the directory `--force` and the branch
 * `-D`, so the click is not undoable).
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

import { TaskDetailSheet } from "./task-detail-sheet"

const workTaskCleanup = vi.fn().mockResolvedValue(undefined)
const workTaskDelete = vi.fn().mockResolvedValue(undefined)
const workTaskWorktreeDirty = vi.fn().mockResolvedValue(0)
const toastError = vi.fn()

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: (...args: unknown[]) => toastError(...args),
    success: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  }),
}))

vi.mock("@/lib/api", () => ({
  workTaskArchive: vi.fn().mockResolvedValue(undefined),
  workTaskCancel: vi.fn().mockResolvedValue(undefined),
  getFolderConversation: vi.fn().mockRejectedValue(new Error("no transcript")),
  workTaskChangedFiles: vi.fn().mockResolvedValue([]),
  workTaskCleanup: (...args: unknown[]) => workTaskCleanup(...args),
  workTaskDelete: (...args: unknown[]) => workTaskDelete(...args),
  workTaskWorktreeDirty: (...args: unknown[]) => workTaskWorktreeDirty(...args),
  workTaskDiff: vi.fn().mockResolvedValue(""),
  workTaskEvents: vi.fn().mockResolvedValue([]),
  workTaskMergeUnqueue: vi.fn().mockResolvedValue(undefined),
  workTaskRequeue: vi.fn().mockResolvedValue(undefined),
  workTaskRetry: vi.fn().mockResolvedValue(undefined),
  workTaskReturn: vi.fn().mockResolvedValue(undefined),
  workTaskStart: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/stores/app-workspace-store", () => {
  const state = {
    allFolders: [{ id: 1, path: "/repo", default_agent_type: null }],
  }
  const useStore = (selector: (s: typeof state) => unknown) => selector(state)
  return { useAppWorkspaceStore: useStore }
})
// Heavy leaves with nothing to say about the footer.
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
// The nested session viewer the sheet now hosts. Never opened here, but its
// module graph reaches the tab store, which reads the app-workspace store at
// module scope — and that store is stubbed above down to a bare hook.
vi.mock("./task-transcript-dialog", () => ({
  TaskTranscriptDialog: () => null,
}))

function task(overrides: Partial<WorkTask> = {}): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix the retry path",
    config: null,
    status: "done",
    work_branch: "task/7",
    worktree_folder_id: 9,
    conversation_id: null,
    archived_at: null,
    scheduled_at: null,
    cleanup_state: null,
    preflight: null,
    files_changed: 0,
    ...overrides,
  } as WorkTask
}

function mount(row: WorkTask) {
  return render(
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

const removeButton = () =>
  screen.queryByRole("button", { name: "Delete worktree" })

beforeEach(() => {
  vi.clearAllMocks()
  workTaskWorktreeDirty.mockResolvedValue(0)
})

describe("task drawer worktree removal", () => {
  it("removes the worktree once the confirm is answered", async () => {
    const user = userEvent.setup()
    mount(task())

    await user.click(removeButton()!)
    // Nothing has happened yet: the button only asks.
    expect(workTaskCleanup).not.toHaveBeenCalled()

    const confirm = await screen.findByRole("alertdialog")
    await user.click(
      within(confirm).getByRole("button", { name: "Delete worktree" })
    )
    await waitFor(() => expect(workTaskCleanup).toHaveBeenCalledWith(7))
  })

  it("keeps the worktree when the confirm is dismissed", async () => {
    const user = userEvent.setup()
    mount(task())

    await user.click(removeButton()!)
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByRole("button", { name: "Cancel" }))
    expect(workTaskCleanup).not.toHaveBeenCalled()
  })

  it("sits to the left of the delete button", async () => {
    mount(task())
    const remove = await screen.findByRole("button", {
      name: "Delete worktree",
    })
    const del = screen.getByRole("button", { name: "Delete" })
    // Reading order, not styling: the two ways to be rid of this worktree sit
    // together, and the one that keeps the task comes first.
    expect(
      remove.compareDocumentPosition(del) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  it("offers the same removal to a canceled task", async () => {
    const user = userEvent.setup()
    // Abandoning leaves a checkout behind exactly like finishing does, and the
    // cancel dialog's checkbox is skippable — without this the only way to
    // reclaim that disk was deleting the task, taking the record of why it was
    // stopped with it.
    mount(task({ status: "canceled" }))

    await user.click(removeButton()!)
    const confirm = await screen.findByRole("alertdialog")
    await user.click(
      within(confirm).getByRole("button", { name: "Delete worktree" })
    )
    await waitFor(() => expect(workTaskCleanup).toHaveBeenCalledWith(7))
  })

  it("is offered only to a settled task that still has a worktree", async () => {
    const { rerender } = mount(task())
    await waitFor(() => expect(removeButton()).toBeInTheDocument())

    /** Re-render with another row and let the drawer's reload settle. */
    const remount = async (row: WorkTask) => {
      rerender(
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
      await waitFor(() => expect(removeButton()).not.toBeInTheDocument())
    }

    // Detached already — nothing left to remove.
    await remount(task({ worktree_folder_id: null }))
    // Recorded, but gone from disk behind the app: the board already reports
    // that one as removed.
    await remount(task({ worktree_missing: true }))
    // Still up for review — the acceptance is about to read this worktree.
    await remount(task({ status: "review" }))
    // A failed cleanup has its own retry entry: same call, and it names the
    // failure, so the glyph stays out of its way.
    await remount(task({ cleanup_state: "failed" }))
    expect(
      screen.getByRole("button", { name: "Retry cleanup" })
    ).toBeInTheDocument()
  })
})

describe("task drawer uncommitted files", () => {
  it("warns in the delete confirm and passes the discard choice", async () => {
    const user = userEvent.setup()
    workTaskWorktreeDirty.mockResolvedValue(3)
    mount(task({ status: "canceled" }))

    await user.click(screen.getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByLabelText(/Also delete its worktree/))
    expect(
      await within(confirm).findByText(/3 uncommitted files/)
    ).toBeInTheDocument()
    await user.click(
      within(confirm).getByLabelText(/Also discard these changes/)
    )
    await user.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(workTaskDelete).toHaveBeenCalledWith(7, true, true)
    )
  })

  it("offers discard-and-delete beside the failed cleanup's retry", async () => {
    const user = userEvent.setup()
    workTaskWorktreeDirty.mockResolvedValue(1)
    mount(task({ status: "canceled", cleanup_state: "failed" }))

    await user.click(
      await screen.findByRole("button", { name: "Discard changes and delete" })
    )
    expect(workTaskCleanup).not.toHaveBeenCalled()
    const confirm = await screen.findByRole("alertdialog")
    await user.click(
      within(confirm).getByRole("button", {
        name: "Discard changes and delete",
      })
    )
    await waitFor(() => expect(workTaskCleanup).toHaveBeenCalledWith(7, true))
  })
})

describe("task drawer delete blocked by uncommitted files", () => {
  it("keeps the delete confirm open and offers discard-and-delete-task", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    // 打开删除框时还没查到未提交文件（或用户没勾丢弃），删除被后端拦下。
    workTaskWorktreeDirty.mockResolvedValue(0)
    workTaskDelete.mockRejectedValueOnce(
      new Error(
        "the worktree was kept: it still holds uncommitted files. Check it."
      )
    )
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskDetailSheet
          open
          onOpenChange={onOpenChange}
          task={task({ status: "canceled" })}
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

    await user.click(screen.getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByLabelText(/Also delete its worktree/))
    workTaskWorktreeDirty.mockResolvedValue(2)
    await user.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(workTaskDelete).toHaveBeenCalledWith(7, true, false)
    )

    // 框不关，就地给出「丢弃改动并删除任务」。
    const still = await screen.findByRole("alertdialog")
    const discard = await within(still).findByRole("button", {
      name: "Discard changes and delete task",
    })
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    await user.click(discard)
    await waitFor(() =>
      expect(workTaskDelete).toHaveBeenLastCalledWith(7, true, true)
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("reports any other delete error as it is, even with uncommitted files", async () => {
    const user = userEvent.setup()
    const onOpenChange = vi.fn()
    workTaskWorktreeDirty.mockResolvedValue(0)
    // 后端因为别的原因拒绝删除（比如任务正在合并）：worktree 里正好也有没提交
    // 的文件，也不能说成「被未提交文件拦下」。
    workTaskDelete.mockRejectedValueOnce(
      new Error("task is merging — wait for it to finish")
    )
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TaskDetailSheet
          open
          onOpenChange={onOpenChange}
          task={task({ status: "canceled" })}
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

    await user.click(screen.getByRole("button", { name: "Delete" }))
    const confirm = await screen.findByRole("alertdialog")
    await user.click(within(confirm).getByLabelText(/Also delete its worktree/))
    workTaskWorktreeDirty.mockResolvedValue(2)
    await user.click(within(confirm).getByRole("button", { name: "Delete" }))
    await waitFor(() =>
      expect(workTaskDelete).toHaveBeenCalledWith(7, true, false)
    )
    await waitFor(() =>
      expect(toastError).toHaveBeenCalledWith(
        "task is merging — wait for it to finish"
      )
    )
    expect(
      screen.queryByRole("button", { name: "Discard changes and delete task" })
    ).toBeNull()
  })

  it("finishes a half-done delete from the footer: worktree and task", async () => {
    const user = userEvent.setup()
    workTaskWorktreeDirty.mockResolvedValue(1)
    mount(task({ status: "canceled", cleanup_state: "failed_delete" }))

    await user.click(
      await screen.findByRole("button", {
        name: "Discard changes and delete task",
      })
    )
    const confirm = await screen.findByRole("alertdialog")
    await user.click(
      within(confirm).getByRole("button", {
        name: "Discard changes and delete task",
      })
    )
    await waitFor(() =>
      expect(workTaskDelete).toHaveBeenCalledWith(7, true, true)
    )
    expect(workTaskCleanup).not.toHaveBeenCalled()
  })
})
