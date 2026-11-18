import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { BranchDropdown } from "./branch-dropdown"
import { gitListAllBranches } from "@/lib/api"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"

/**
 * "Adjust new worktree…" refuses a branch name that is already a local
 * branch while the dialog is open. Before, it only checked the format, so
 * `main` was planned and the first send failed with "Branch already exists".
 */

vi.mock("@/lib/api", () => ({
  // Consumed by the dropdown itself.
  gitInit: vi.fn(),
  gitNewBranch: vi.fn(),
  gitWorktreeAdd: vi.fn(),
  gitListAllBranches: vi.fn(async () => ({
    local: ["main", "feature/x"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  })),
  gitMerge: vi.fn(),
  gitRebase: vi.fn(),
  gitDeleteBranch: vi.fn(),
  gitDeleteRemoteBranch: vi.fn(),
  gitRemoveWorktree: vi.fn(),
  // Consumed by the workspace store this test drives for real.
  getFolder: vi.fn(),
  getGitHead: vi.fn(),
  listAllConversations: vi.fn(async () => []),
  listAllFolderDetails: vi.fn(async () => []),
  listFolderGroups: vi.fn(async () => []),
  listOpenFolderDetails: vi.fn(async () => []),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  openWorktreeFolder: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  applySidebarLayout: vi.fn(),
  createFolderGroup: vi.fn(),
  updateFolderGroup: vi.fn(),
  deleteFolderGroup: vi.fn(),
  setFolderGroup: vi.fn(),
}))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
  emitEvent: vi.fn(),
}))

const setDraftWorktree = vi.fn()
const draftTabs = [
  {
    id: "draft-1",
    pendingWorktree: {
      kind: "branch_off",
      branch: "cv/tidy-fox",
      base: "main",
      auto_name: true,
    },
  },
]

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: vi.fn(),
    setDraftWorktree,
  }),
  useTabStore: (selector: (s: { tabs: typeof draftTabs }) => unknown) =>
    selector({ tabs: draftTabs }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))

vi.mock("@/contexts/git-credential-context", () => ({
  useGitCredential: () => ({ withCredentialRetry: vi.fn() }),
}))

vi.mock("@/hooks/use-switch-to-branch", () => ({
  useSwitchToBranch: () => vi.fn(),
}))

vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    runGitTask: vi.fn(),
    pull: vi.fn(),
    fetchAll: vi.fn(),
    updateBranch: vi.fn(),
    reportConflict: vi.fn(),
    openCommitWindow: vi.fn(),
    openPushWindow: vi.fn(),
    openStashDialog: vi.fn(),
    openUnstashWindow: vi.fn(),
    dialogs: null,
  }),
}))

function folder(over: Partial<FolderDetail> & { id: number }): FolderDetail {
  return {
    name: `folder-${over.id}`,
    path: `/repo/folder-${over.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00Z",
    sort_order: over.id,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...over,
  }
}

beforeEach(() => {
  resetAppWorkspaceStore()
  setDraftWorktree.mockReset()
  useAppWorkspaceStore.getState().applyGitHead(7, {
    is_repo: true,
    branch: "main",
    detached: false,
    short_sha: "abc1234",
  })
})

afterEach(() => cleanup())

async function openAdjustDialog() {
  render(
    <BranchDropdown
      folder={folder({ id: 7 })}
      isChatMode={false}
      draftTabId="draft-1"
    />
  )
  fireEvent.click(screen.getByRole("button", { name: "worktreeAutoLabel" }))
  fireEvent.click(await screen.findByText("editWorktree"))
  return screen.findByLabelText("dialogs.branchNameLabel")
}

function restoreBranchList() {
  vi.mocked(gitListAllBranches).mockReset()
  vi.mocked(gitListAllBranches).mockImplementation(async () => ({
    local: ["main", "feature/x"],
    remote: [],
    worktree_branches: [],
    main_worktree_branch: null,
  }))
}

describe("BranchDropdown — adjust new worktree", () => {
  it("refuses a name that is already a local branch", async () => {
    const input = await openAdjustDialog()
    fireEvent.change(input, { target: { value: "main" } })
    fireEvent.click(screen.getByText("confirm"))

    expect(
      await screen.findByText("dialogs.branchNameExists")
    ).toBeInTheDocument()
    expect(screen.getByLabelText("dialogs.branchNameLabel")).toBeInTheDocument()
    expect(setDraftWorktree).not.toHaveBeenCalled()
  })

  it("refuses to confirm a name when the branch list cannot be read", async () => {
    // 列表读失败时不能当成「没有分支」放行：main 照样会在发送时失败。
    vi.mocked(gitListAllBranches).mockRejectedValue(new Error("git failed"))
    try {
      const input = await openAdjustDialog()
      fireEvent.change(input, { target: { value: "main" } })
      fireEvent.click(screen.getByText("confirm"))

      expect(
        await screen.findByText("dialogs.branchListUnavailable")
      ).toBeInTheDocument()
      expect(
        screen.getByLabelText("dialogs.branchNameLabel")
      ).toBeInTheDocument()
      expect(setDraftWorktree).not.toHaveBeenCalled()
    } finally {
      restoreBranchList()
    }
  })

  it("re-reads the branch list on confirm instead of trusting a stale one", async () => {
    // 菜单打开时读到的列表里还没有 main；之后别处建了 main，确认时要重新读。
    let local = ["feature/x"]
    vi.mocked(gitListAllBranches).mockImplementation(async () => ({
      local,
      remote: [],
      worktree_branches: [],
      main_worktree_branch: null,
    }))
    try {
      const input = await openAdjustDialog()
      await vi.waitFor(() => expect(gitListAllBranches).toHaveBeenCalled())
      await act(async () => {})
      local = ["main", "feature/x"]
      fireEvent.change(input, { target: { value: "main" } })
      fireEvent.click(screen.getByText("confirm"))

      expect(
        await screen.findByText("dialogs.branchNameExists")
      ).toBeInTheDocument()
      expect(setDraftWorktree).not.toHaveBeenCalled()
    } finally {
      restoreBranchList()
    }
  })

  it("drops a confirm the user cancelled or edited while it was checking", async () => {
    // 确认后列表还在读，用户改了名字或取消：读完以后不能拿旧名字记计划。
    const list = {
      local: ["main"],
      remote: [],
      worktree_branches: [],
      main_worktree_branch: null,
    }
    const pending: Array<() => void> = []
    let hang = false
    vi.mocked(gitListAllBranches).mockImplementation(async () =>
      !hang
        ? list
        : new Promise((resolve) => {
            pending.push(() => resolve(list))
          })
    )
    try {
      const input = await openAdjustDialog()
      await act(async () => {})
      hang = true
      fireEvent.change(input, { target: { value: "cv/old-name" } })
      fireEvent.click(screen.getByText("confirm"))
      fireEvent.change(input, { target: { value: "cv/new-name" } })
      await act(async () => {
        pending.splice(0).forEach((done) => done())
      })
      expect(setDraftWorktree).not.toHaveBeenCalled()
      expect(
        screen.getByLabelText("dialogs.branchNameLabel")
      ).toBeInTheDocument()

      fireEvent.click(screen.getByText("confirm"))
      fireEvent.click(screen.getByText("cancel"))
      await act(async () => {
        pending.splice(0).forEach((done) => done())
      })
      expect(setDraftWorktree).not.toHaveBeenCalled()
    } finally {
      restoreBranchList()
    }
  })

  it("still plans a new name", async () => {
    const input = await openAdjustDialog()
    fireEvent.change(input, { target: { value: "cv/new-one" } })
    fireEvent.click(screen.getByText("confirm"))

    await vi.waitFor(() =>
      expect(setDraftWorktree).toHaveBeenCalledWith("draft-1", {
        kind: "branch_off",
        branch: "cv/new-one",
        base: "main",
      })
    )
  })
})
