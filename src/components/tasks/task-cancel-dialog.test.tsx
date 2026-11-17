/**
 * Stopping a task records WHY, and the reason is optional — the confirm must
 * never wait on the textarea, and a box holding only whitespace must not write
 * an empty note onto the timeline. The second decision is the worktree's fate,
 * which destroys the work branch too: it must start off and stay off unless the
 * user says otherwise.
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTask } from "@/lib/types"

const cancelMock = vi.fn().mockResolvedValue(undefined)
const dirtyMock = vi.fn().mockResolvedValue(0)

vi.mock("@/lib/api", () => ({
  workTaskCancel: (...args: unknown[]) => cancelMock(...args),
  workTaskWorktreeDirty: (...args: unknown[]) => dirtyMock(...args),
}))

import { TaskCancelDialog } from "./task-cancel-dialog"

const WORKTREE_BOX = /Also delete its worktree/
const DISCARD_BOX = /Also discard these changes/

function task(overrides?: Partial<WorkTask>): WorkTask {
  return {
    id: 7,
    folder_id: 1,
    title: "Fix login",
    config: null,
    status: "running",
    worktree_folder_id: 9,
    ...overrides,
  } as WorkTask
}

function renderDialog(overrides?: Partial<WorkTask>) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TaskCancelDialog open onOpenChange={() => {}} task={task(overrides)} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  cancelMock.mockClear()
  dirtyMock.mockReset()
  dirtyMock.mockResolvedValue(0)
})

describe("TaskCancelDialog", () => {
  it("sends the trimmed reason", async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText(/Reason/), "  wrong approach  ")
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, "wrong approach", false, false)
    )
  })

  it("cancels with a null reason when nothing was typed", async () => {
    renderDialog()
    // No reason is still a legitimate stop — the confirm is never blocked.
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, null, false, false)
    )
  })

  it("treats a whitespace-only reason as none", async () => {
    renderDialog()
    await userEvent.type(screen.getByLabelText(/Reason/), "   ")
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, null, false, false)
    )
  })

  it("keeps the worktree unless the box is ticked", async () => {
    // Unchecked by default on purpose: a canceled task can be requeued, and the
    // cleanup deletes the work branch along with the directory. This is NOT
    // seeded from the folder's delete-worktree default, which is about landing
    // finished work.
    renderDialog()
    expect(screen.getByLabelText(WORKTREE_BOX)).not.toBeChecked()
    await userEvent.click(screen.getByLabelText(WORKTREE_BOX))
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, null, true, false)
    )
  })

  it("warns about uncommitted files and lets the user discard them", async () => {
    // 任务的正常产出往往就是没提交的文件：不说清楚，勾了删除也只会得到
    // 「清理失败」。勾上删除时先查个数，有就提示并给「同时丢弃」。
    dirtyMock.mockResolvedValue(2)
    renderDialog()
    expect(screen.queryByLabelText(DISCARD_BOX)).toBeNull()
    await userEvent.click(screen.getByLabelText(WORKTREE_BOX))
    await waitFor(() => expect(dirtyMock).toHaveBeenCalledWith(7))
    expect(await screen.findByText(/2 uncommitted files/)).toBeInTheDocument()
    const discard = screen.getByLabelText(DISCARD_BOX)
    expect(discard).not.toBeChecked()
    await userEvent.click(discard)
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, null, true, true)
    )
  })

  it("does not discard unless that box is ticked too", async () => {
    dirtyMock.mockResolvedValue(1)
    renderDialog()
    await userEvent.click(screen.getByLabelText(WORKTREE_BOX))
    expect(await screen.findByLabelText(DISCARD_BOX)).not.toBeChecked()
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, null, true, false)
    )
  })

  it("offers no discard box for a clean worktree", async () => {
    renderDialog()
    await userEvent.click(screen.getByLabelText(WORKTREE_BOX))
    await waitFor(() => expect(dirtyMock).toHaveBeenCalledWith(7))
    expect(screen.queryByLabelText(DISCARD_BOX)).toBeNull()
  })

  it("offers nothing to remove when the worktree is already gone", async () => {
    // Never minted…
    const { unmount } = renderDialog({ worktree_folder_id: null })
    expect(screen.queryByLabelText(WORKTREE_BOX)).toBeNull()
    unmount()
    // …or recorded but no longer on disk: the card reports that one as removed,
    // and a checkbox promising to delete it again would only contradict it.
    renderDialog({ worktree_missing: true })
    expect(screen.queryByLabelText(WORKTREE_BOX)).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Cancel task" }))
    await waitFor(() =>
      expect(cancelMock).toHaveBeenCalledWith(7, null, false, false)
    )
  })
})
