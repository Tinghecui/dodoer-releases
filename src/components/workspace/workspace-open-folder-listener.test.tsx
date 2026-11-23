import { render, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  openNewConversationTab: vi.fn(),
  openConversations: vi.fn(),
  upsertFolder: vi.fn(),
  setBranch: vi.fn(),
  refreshConversations: vi.fn(async () => {}),
  subscribe: vi.fn(async () => () => {}),
  hydrated: { tabs: true, folders: true, restoring: false },
}))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: mocks.openNewConversationTab,
  }),
  useTabStore: Object.assign(
    (sel: (s: { tabsHydrated: boolean; tabsRestoring: boolean }) => unknown) =>
      sel({
        tabsHydrated: mocks.hydrated.tabs,
        tabsRestoring: mocks.hydrated.restoring,
      }),
    { getState: () => ({ tabsRestoring: mocks.hydrated.restoring }) }
  ),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: mocks.openConversations }),
}))
vi.mock("@/lib/platform", () => ({ subscribe: mocks.subscribe }))
vi.mock("@/lib/api", () => ({
  FOLDER_OPEN_IN_WORKSPACE_EVENT: "folder://open-in-workspace",
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: Object.assign(
    (sel: (s: { foldersHydrated: boolean }) => unknown) =>
      sel({ foldersHydrated: mocks.hydrated.folders }),
    {
      getState: () => ({
        upsertFolder: mocks.upsertFolder,
        setBranch: mocks.setBranch,
        refreshConversations: mocks.refreshConversations,
      }),
    }
  ),
}))

import {
  setPendingWorkspaceFolder,
  takePendingWorkspaceFolder,
} from "@/lib/in-page-navigation"
import type { FolderDetail } from "@/lib/types"
import { WorkspaceOpenFolderListener } from "./workspace-open-folder-listener"

beforeEach(() => {
  vi.clearAllMocks()
  mocks.hydrated.tabs = true
  mocks.hydrated.folders = true
  mocks.hydrated.restoring = false
  takePendingWorkspaceFolder()
})

describe("WorkspaceOpenFolderListener（#1332）", () => {
  it("挂上时接着打开在当前页新建好的项目", async () => {
    const detail = {
      id: 7,
      path: "/tmp/demo-app",
      git_branch: "main",
    } as unknown as FolderDetail
    setPendingWorkspaceFolder(detail)
    render(<WorkspaceOpenFolderListener />)
    await waitFor(() => expect(mocks.upsertFolder).toHaveBeenCalledWith(detail))
    expect(mocks.setBranch).toHaveBeenCalledWith(7, "main")
    expect(mocks.openConversations).toHaveBeenCalledTimes(1)
    expect(mocks.openNewConversationTab).toHaveBeenCalledWith(
      7,
      "/tmp/demo-app"
    )
    // 取一次就清空，不会重复打开
    expect(takePendingWorkspaceFolder()).toBeNull()
  })

  it("没有待打开的就什么都不做，只订阅广播", () => {
    render(<WorkspaceOpenFolderListener />)
    expect(mocks.openNewConversationTab).not.toHaveBeenCalled()
    expect(mocks.subscribe).toHaveBeenCalledWith(
      "folder://open-in-workspace",
      expect.any(Function)
    )
  })

  it("标签和项目恢复完之前不取走、不打开，恢复完再打开（刷新过新建项目页）", async () => {
    const detail = {
      id: 9,
      path: "/tmp/fresh-app",
      git_branch: null,
    } as unknown as FolderDetail
    setPendingWorkspaceFolder(detail)
    mocks.hydrated.tabs = false
    mocks.hydrated.folders = false
    const { rerender } = render(<WorkspaceOpenFolderListener />)
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.openNewConversationTab).not.toHaveBeenCalled()
    expect(mocks.upsertFolder).not.toHaveBeenCalled()

    // 只有标签恢复完、项目列表还没到：仍然不动
    mocks.hydrated.tabs = true
    rerender(<WorkspaceOpenFolderListener />)
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.openNewConversationTab).not.toHaveBeenCalled()

    mocks.hydrated.folders = true
    rerender(<WorkspaceOpenFolderListener />)
    await waitFor(() =>
      expect(mocks.openNewConversationTab).toHaveBeenCalledWith(
        9,
        "/tmp/fresh-app"
      )
    )
    expect(mocks.openNewConversationTab).toHaveBeenCalledTimes(1)
    expect(takePendingWorkspaceFolder()).toBeNull()
  })

  it("不刷新回到工作区：工作区重新读标签时也要等读完再打开", async () => {
    const detail = {
      id: 11,
      path: "/tmp/again-app",
      git_branch: null,
    } as unknown as FolderDetail
    setPendingWorkspaceFolder(detail)
    // 之前恢复过（tabsHydrated 一直是 true），重新挂上又在读
    mocks.hydrated.restoring = true
    const { rerender } = render(<WorkspaceOpenFolderListener />)
    await new Promise((r) => setTimeout(r, 20))
    expect(mocks.openNewConversationTab).not.toHaveBeenCalled()

    mocks.hydrated.restoring = false
    rerender(<WorkspaceOpenFolderListener />)
    await waitFor(() =>
      expect(mocks.openNewConversationTab).toHaveBeenCalledWith(
        11,
        "/tmp/again-app"
      )
    )
  })
})
