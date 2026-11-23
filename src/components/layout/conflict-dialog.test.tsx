import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { ConflictDialog } from "./conflict-dialog"
import { gitContinueOperation, gitListConflicts } from "@/lib/api"
import { emitMergeEvent } from "@/lib/merge-events"
import type { GitConflictInfo } from "@/lib/types"

/**
 * 网页版里合并工具在另一个标签页完成合并后，工作区的「合并冲突」弹窗要能收到、
 * 自己关掉；再点「完成合并」失败时，toast 不能是「[object Object]」（#894）。
 */

const toastError = vi.fn()
vi.mock("sonner", () => ({
  toast: {
    error: (msg: unknown) => toastError(msg),
    success: vi.fn(),
    warning: vi.fn(),
  },
}))

vi.mock("@/lib/api", () => ({
  gitListConflicts: vi.fn(async () => [] as string[]),
  gitAbortOperation: vi.fn(),
  gitContinueOperation: vi.fn(),
  openMergeWindow: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
}))

// #1335：手机布局下不给「打开合并工具」（三栏合并编辑器不做手机版）
const phone = vi.hoisted(() => ({ mobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => phone.mobile }))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const conflictInfo: GitConflictInfo = {
  has_conflicts: true,
  operation: "merge",
  conflicted_files: ["README.md"],
  upstream_commit: null,
}

beforeEach(() => {
  toastError.mockReset()
  vi.mocked(gitListConflicts).mockResolvedValue([])
})

afterEach(() => {
  phone.mobile = false
  cleanup()
  vi.useRealTimers()
})

describe("ConflictDialog", () => {
  it("网页版合并工具标签页发来 merge-completed 时关掉弹窗", async () => {
    const onClose = vi.fn()
    const onResolved = vi.fn()
    render(
      <ConflictDialog
        conflictInfo={conflictInfo}
        folderId={7}
        folderPath="/tmp/demo"
        onClose={onClose}
        onResolved={onResolved}
      />
    )

    // 别的文件夹的事件不理
    await emitMergeEvent("folder://merge-completed", { folder_id: 8 })
    await emitMergeEvent("folder://merge-completed", { folder_id: 7 })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onResolved).toHaveBeenCalledTimes(1)
  })

  it("网页版合并工具标签页发来 merge-aborted 时关掉弹窗", async () => {
    const onClose = vi.fn()
    const onResolved = vi.fn()
    render(
      <ConflictDialog
        conflictInfo={conflictInfo}
        folderId={7}
        folderPath="/tmp/demo"
        onClose={onClose}
        onResolved={onResolved}
      />
    )

    await emitMergeEvent("folder://merge-aborted", { folder_id: 7 })

    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(onResolved).not.toHaveBeenCalled()
  })

  it("完成合并失败时 toast 显示错误里的文字，不是 [object Object]", async () => {
    vi.mocked(gitContinueOperation).mockRejectedValue({
      code: "external_command_failed",
      message: "合并没有完成",
      detail: "fatal: There is no merge to conclude",
    })
    render(
      <ConflictDialog
        conflictInfo={conflictInfo}
        folderId={7}
        folderPath="/tmp/demo"
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />
    )

    // 网页版收到 merge-conflict-resolved 后文件标成已解决，出现「完成合并」
    await emitMergeEvent("folder://merge-conflict-resolved", {
      folder_id: 7,
      file: "README.md",
    })
    const button = await screen.findByText("completeMerge")
    fireEvent.click(button)

    await waitFor(() => expect(toastError).toHaveBeenCalledTimes(1))
    const shown = String(toastError.mock.calls[0][0])
    expect(shown).not.toContain("[object Object]")
    expect(shown).toContain("There is no merge to conclude")
  })
})

describe("ConflictDialog 在手机布局下", () => {
  const renderDialog = () =>
    render(
      <ConflictDialog
        conflictInfo={conflictInfo}
        folderId={7}
        folderPath="/tmp/demo"
        onClose={vi.fn()}
        onResolved={vi.fn()}
      />
    )

  it("不显示打开合并工具，中止合并还在", () => {
    phone.mobile = true
    renderDialog()
    expect(screen.queryByRole("button", { name: "openMergeTool" })).toBeNull()
    expect(screen.getByRole("button", { name: "abort" })).toBeInTheDocument()
  })

  it("宽屏照常显示", () => {
    renderDialog()
    expect(
      screen.getByRole("button", { name: "openMergeTool" })
    ).toBeInTheDocument()
  })
})
