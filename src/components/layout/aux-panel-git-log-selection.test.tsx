import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useEffect, type ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { GitLogTab } from "./aux-panel-git-log-tab"
import enMessages from "@/i18n/messages/en.json"
import type { GitBranchList, GitLogEntry } from "@/lib/types"

type PendingBranchList = {
  path: string
  resolve: (list: GitBranchList) => void
  reject: (error: Error) => void
}

type TestFolder = { id: number; path: string }

const state = vi.hoisted(() => ({
  folder: { id: 1, path: "/worktrees/a" } as TestFolder,
  // What useDeferredValue hands back while set (see the "react" mock below);
  // null passes the live active folder straight through.
  heldDeferredFolder: null as TestFolder | null,
  gitLog: vi.fn(async () => ({ entries: [] as GitLogEntry[] })),
  gitNewBranch: vi.fn(async () => {}),
  deferBranches: false,
  pendingBranches: [] as PendingBranchList[],
  // 终端里另外建的本地分支（不经过应用，不发 git 事件）
  extraLocal: [] as string[],
  listBranchCalls: 0,
  listeners: new Map<string, (payload: { folder_id: number }) => void>(),
  // What the active folder's HEAD poll last wrote (store `gitHeads`).
  gitHeads: new Map<number, unknown>(),
}))

// The tab reads the folder through useDeferredValue, which lags a switch until
// React commits its background render. A test can hold that lag open to land a
// response inside it.
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>()
  return {
    ...actual,
    useDeferredValue: <T,>(value: T): T =>
      (state.heldDeferredFolder ?? value) as T,
  }
})

// virtua renders no rows under jsdom (no layout): render every commit.
vi.mock("virtua", () => ({
  // 分支选择器的列表直接传子元素，没有 data
  Virtualizer: ({
    data,
    children,
  }: {
    data?: unknown[]
    children: ReactNode | ((item: unknown, index: number) => ReactNode)
  }) =>
    typeof children === "function" ? (
      <>{(data ?? []).map((item, index) => children(item, index))}</>
    ) : (
      <>{children}</>
    ),
}))

// The commit list mounts virtua only once the OverlayScrollbars viewport exists,
// which jsdom never initializes; hand over a plain element instead.
vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({
    children,
    onViewportRef,
  }: {
    children?: ReactNode
    onViewportRef?: (el: HTMLElement | null) => void
  }) => {
    useEffect(() => {
      onViewportRef?.(document.createElement("div"))
    }, [onViewportRef])
    return <>{children}</>
  },
}))

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  gitLog: state.gitLog,
  gitNewBranch: state.gitNewBranch,
  getGitBranch: async (path: string) =>
    path === "/worktrees/a" ? "mainA" : "mainB",
  gitListAllBranches: (path: string) =>
    (state.listBranchCalls++, state.deferBranches)
      ? new Promise<GitBranchList>((resolve, reject) => {
          state.pendingBranches.push({ path, resolve, reject })
        })
      : Promise.resolve({
          local: [
            path === "/worktrees/a" ? "mainA" : "mainB",
            ...state.extraLocal,
          ],
          remote: [],
          worktree_branches: [],
          main_worktree_branch: null,
        }),
  gitCurrentUser: async () => null,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: state.folder }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({
    openCommitDiff: vi.fn(),
    openFilePreview: vi.fn(),
  }),
}))

vi.mock("@/hooks/use-workspace-state-store", () => ({
  useWorkspaceStateStore: () => ({ isGitRepo: true }),
}))

vi.mock("@/hooks/use-git-quick-actions", () => ({
  useGitQuickActions: () => ({
    running: false,
    pull: vi.fn(),
    fetchAll: vi.fn(),
    openPushWindow: vi.fn(),
    dialogs: null,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (
    selector: (state: { gitHeads: Map<number, unknown> }) => unknown
  ) => selector({ gitHeads: state.gitHeads }),
}))

vi.mock("@/lib/platform", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/platform")>()),
  subscribe: async (
    eventName: string,
    listener: (payload: { folder_id: number }) => void
  ) => {
    state.listeners.set(eventName, listener)
    return () => {
      if (state.listeners.get(eventName) === listener) {
        state.listeners.delete(eventName)
      }
    }
  },
}))

// 分支选择器的列表读缩放比例，测试里没有 AppearanceProvider
vi.mock("@/hooks/use-appearance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/hooks/use-appearance")>()),
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

vi.mock("@/components/layout/remote-manage-dialog", () => ({
  RemoteManageDialog: () => null,
}))

function tabTree() {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GitLogTab />
    </NextIntlClientProvider>
  )
}

function renderTab() {
  return render(tabTree())
}

const COMMIT: GitLogEntry = {
  hash: "c3c3c3c",
  full_hash: "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3",
  author: "Alice",
  date: "2026-09-01T00:00:00Z",
  message: "Add the parser",
  files: [],
  pushed: true,
}

describe("Commits tab branch query", () => {
  beforeEach(() => {
    window.localStorage.clear()
    state.folder = { id: 1, path: "/worktrees/a" }
    state.heldDeferredFolder = null
    state.gitLog.mockReset()
    state.gitLog.mockResolvedValue({ entries: [] })
    state.gitNewBranch.mockClear()
    state.deferBranches = false
    state.pendingBranches = []
    state.extraLocal = []
    state.listBranchCalls = 0
    state.listeners.clear()
    state.gitHeads = new Map()
  })
  afterEach(() => cleanup())

  it("refetches the HEAD view when the poll sees a new commit on the same branch", async () => {
    // 终端里 git commit：分支名不变，只有 HEAD 指向的提交变了（#1175）
    state.gitHeads = new Map([
      [
        1,
        {
          is_repo: true,
          branch: "mainA",
          detached: false,
          short_sha: null,
          head_sha: "a1",
        },
      ],
    ])
    const view = renderTab()
    await waitFor(() => expect(state.gitLog).toHaveBeenCalled())
    await screen.findByText("mainA")
    const before = state.gitLog.mock.calls.length

    state.gitHeads = new Map([
      [
        1,
        {
          is_repo: true,
          branch: "mainA",
          detached: false,
          short_sha: null,
          head_sha: "b2",
        },
      ],
    ])
    view.rerender(tabTree())
    await waitFor(() =>
      expect(state.gitLog.mock.calls.length).toBeGreaterThan(before)
    )
    expect(state.gitLog).toHaveBeenLastCalledWith(
      "/worktrees/a",
      100,
      "HEAD",
      undefined,
      0,
      undefined,
      false,
      false
    )
  })

  it("does not refetch a pinned branch view when only the HEAD commit moves", async () => {
    window.localStorage.setItem(
      "codeg:gitlog:selection:/worktrees/a",
      JSON.stringify({ branch: "mainA", author: null })
    )
    state.gitHeads = new Map([
      [
        1,
        {
          is_repo: true,
          branch: "mainA",
          detached: false,
          short_sha: null,
          head_sha: "a1",
        },
      ],
    ])
    const view = renderTab()
    await waitFor(() => expect(state.gitLog).toHaveBeenCalled())
    await screen.findByText("mainA")
    await act(async () => {})
    const before = state.gitLog.mock.calls.length

    state.gitHeads = new Map([
      [
        1,
        {
          is_repo: true,
          branch: "mainA",
          detached: false,
          short_sha: null,
          head_sha: "b2",
        },
      ],
    ])
    view.rerender(tabTree())
    await act(async () => {})
    expect(state.gitLog.mock.calls.length).toBe(before)
  })

  it("re-reads branches when the branch selector opens (#1281)", async () => {
    // 终端里 git branch qa-x：HEAD 没动，不会有 git 事件，也不会触发轮询刷新
    renderTab()
    const trigger = await screen.findByTitle(
      "Follows the current branch (mainA)"
    )
    await act(async () => {})
    const before = state.listBranchCalls
    state.extraLocal = ["qa-x"]

    fireEvent.click(trigger)
    expect(await screen.findByText("qa-x")).toBeInTheDocument()
    expect(state.listBranchCalls).toBe(before + 1)
  })

  it("re-reads branches on Refresh commit history (#1281)", async () => {
    renderTab()
    await screen.findByTitle("Follows the current branch (mainA)")
    await act(async () => {})
    const before = state.listBranchCalls
    state.extraLocal = ["qa-x"]

    const menu = screen.getByRole("button", { name: "More Git actions" })
    fireEvent.keyDown(menu, { key: "Enter" })
    fireEvent.click(await screen.findByText("Refresh commit history"))
    await waitFor(() => expect(state.listBranchCalls).toBe(before + 1))
  })

  it("queries only the current worktree HEAD on first open", async () => {
    renderTab()
    await waitFor(() => expect(state.gitLog).toHaveBeenCalled())
    expect(state.gitLog.mock.calls[0]).toEqual([
      "/worktrees/a",
      100,
      "HEAD",
      undefined,
      0,
      undefined,
      false,
      false,
    ])
  })

  it("ignores an older branch refresh that omits the saved branch", async () => {
    const key = "codeg:gitlog:selection:/worktrees/a"
    window.localStorage.setItem(
      key,
      JSON.stringify({ branch: "feature/new", author: null })
    )
    state.deferBranches = true
    renderTab()
    await waitFor(() => expect(state.pendingBranches).toHaveLength(1))
    await waitFor(() =>
      expect(state.listeners.has("folder://git-branch-changed")).toBe(true)
    )

    act(() => {
      state.listeners.get("folder://git-branch-changed")?.({ folder_id: 1 })
    })
    await waitFor(() => expect(state.pendingBranches).toHaveLength(2))
    await act(async () => {
      state.pendingBranches[1].resolve({
        local: ["mainA", "feature/new"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })
    await act(async () => {
      state.pendingBranches[0].resolve({
        local: ["mainA"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })

    expect(JSON.parse(window.localStorage.getItem(key) ?? "{}").branch).toBe(
      "feature/new"
    )
  })

  it("discards an older branch response when the latest refresh fails", async () => {
    const key = "codeg:gitlog:selection:/worktrees/a"
    window.localStorage.setItem(
      key,
      JSON.stringify({ branch: "feature/new", author: null })
    )
    state.deferBranches = true
    renderTab()
    await waitFor(() => expect(state.pendingBranches).toHaveLength(1))
    await waitFor(() =>
      expect(state.listeners.has("folder://git-branch-changed")).toBe(true)
    )
    act(() => {
      state.listeners.get("folder://git-branch-changed")?.({ folder_id: 1 })
    })
    await waitFor(() => expect(state.pendingBranches).toHaveLength(2))

    await act(async () => {
      state.pendingBranches[1].reject(new Error("branch lookup failed"))
    })
    await act(async () => {
      state.pendingBranches[0].resolve({
        local: ["mainA"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })
    expect(JSON.parse(window.localStorage.getItem(key) ?? "{}").branch).toBe(
      "feature/new"
    )
  })

  it("clears old branch metadata while a new worktree loads", async () => {
    const view = renderTab()
    await screen.findByText("mainA")
    state.deferBranches = true
    await waitFor(() =>
      expect(state.listeners.has("folder://git-branch-changed")).toBe(true)
    )
    act(() => {
      state.listeners.get("folder://git-branch-changed")?.({ folder_id: 1 })
    })
    await waitFor(() => expect(state.pendingBranches).toHaveLength(1))

    state.folder = { id: 2, path: "/worktrees/b" }
    view.rerender(tabTree())
    await waitFor(() => expect(state.pendingBranches).toHaveLength(2))
    expect(screen.queryByText("mainA")).toBeNull()

    await act(async () => {
      state.pendingBranches[1].resolve({
        local: ["mainB"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })
    await screen.findByText("mainB")
    await act(async () => {
      state.pendingBranches[0].resolve({
        local: ["mainA"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })
    expect(screen.queryByText("mainA")).toBeNull()
    expect(screen.getByText("mainB")).toBeInTheDocument()
  })

  it("keeps a deliberate All branches selection after remount", async () => {
    const first = renderTab()
    await screen.findByRole("button", { name: "Clear branch filter" })
    fireEvent.click(screen.getByRole("button", { name: "Clear branch filter" }))
    await waitFor(() =>
      expect(state.gitLog).toHaveBeenCalledWith(
        "/worktrees/a",
        100,
        undefined,
        undefined,
        0,
        undefined,
        true,
        false
      )
    )

    first.unmount()
    state.gitLog.mockClear()
    renderTab()
    await waitFor(() =>
      expect(state.gitLog).toHaveBeenCalledWith(
        "/worktrees/a",
        100,
        undefined,
        undefined,
        0,
        undefined,
        true,
        false
      )
    )
  })

  it("keeps the branches that land while a switch away is still pending", async () => {
    state.deferBranches = true
    const view = renderTab()
    await waitFor(() => expect(state.pendingBranches).toHaveLength(1))

    // Switch to B with the deferred folder still on A, and let A's refresh
    // land inside that lag.
    const folderA = state.folder
    state.heldDeferredFolder = folderA
    state.folder = { id: 2, path: "/worktrees/b" }
    view.rerender(tabTree())
    await act(async () => {
      state.pendingBranches[0].resolve({
        local: ["mainA"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })

    // Back on A before B ever rendered: the deferred folder never moved, so
    // nothing asks for A's branches again and that response is all A gets.
    state.folder = folderA
    state.heldDeferredFolder = null
    view.rerender(tabTree())
    expect(await screen.findByText("mainA")).toBeInTheDocument()
    expect(state.pendingBranches).toHaveLength(1)
  })

  it("reloads the HEAD view after switching to a branch made from a commit", async () => {
    state.gitLog.mockResolvedValue({ entries: [COMMIT] })
    renderTab()
    const row = await screen.findByText(COMMIT.message)
    await screen.findByText("mainA")
    const logCalls = state.gitLog.mock.calls.length

    await createBranchFrom(row, "fix")

    // `checkout -b` moved HEAD onto the commit, so the HEAD view reloads
    // instead of listing the previous branch's history under the new name.
    await waitFor(() =>
      expect(state.gitLog).toHaveBeenCalledTimes(logCalls + 1)
    )
    expect(state.gitNewBranch).toHaveBeenCalledWith(
      "/worktrees/a",
      "fix",
      COMMIT.full_hash
    )
    expect(state.gitLog).toHaveBeenLastCalledWith(
      "/worktrees/a",
      100,
      "HEAD",
      undefined,
      0,
      undefined,
      false,
      false
    )
  })

  it("lets a filter picked during the post-create branch refresh win", async () => {
    state.gitLog.mockResolvedValue({ entries: [COMMIT] })
    renderTab()
    const row = await screen.findByText(COMMIT.message)
    await screen.findByText("mainA")
    state.deferBranches = true

    await createBranchFrom(row, "fix")
    await waitFor(() => expect(state.pendingBranches).toHaveLength(1))
    fireEvent.click(screen.getByRole("button", { name: "Clear branch filter" }))
    await act(async () => {
      state.pendingBranches[0].resolve({
        local: ["mainA", "fix"],
        remote: [],
        worktree_branches: [],
        main_worktree_branch: null,
      })
    })

    // The HEAD reload must not land after the All branches query it would
    // then overwrite.
    expect(state.gitLog).toHaveBeenLastCalledWith(
      "/worktrees/a",
      100,
      undefined,
      undefined,
      0,
      undefined,
      true,
      false
    )
  })
})

async function createBranchFrom(row: HTMLElement, name: string) {
  fireEvent.contextMenu(row)
  fireEvent.click(await screen.findByText("New branch..."))
  fireEvent.change(await screen.findByPlaceholderText("Branch name"), {
    target: { value: name },
  })
  fireEvent.click(screen.getByRole("button", { name: "Create and Switch" }))
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
}
