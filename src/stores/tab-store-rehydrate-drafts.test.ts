import { beforeEach, describe, expect, it, vi } from "vitest"

import { listOpenedTabs } from "@/lib/api"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetFolderTabsStore } from "./folder-tabs-store"
import { resetTabStore, useTabStore } from "./tab-store"
import type { FolderDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(() => new Promise(() => {})),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const listMock = vi.mocked(listOpenedTabs)
const folder = { id: 1, name: "demo", path: "/demo" } as unknown as FolderDetail

const snapshot = {
  version: 1,
  items: [
    {
      folder_id: 1,
      conversation_id: 7,
      agent_type: "claude_code" as const,
      is_active: true,
      is_pinned: true,
    },
  ],
}

beforeEach(() => {
  localStorage.clear()
  listMock.mockReset()
  resetTabStore()
  resetAppWorkspaceStore()
  resetFolderTabsStore()
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
})

async function hydrateOnce() {
  useTabStore.getState().hydrate()
  await vi.waitFor(() =>
    expect(useTabStore.getState().tabsRestoring).toBe(false)
  )
}

// #1354（跟进 #1343 第 5 件）：手机上在当前页打开设置等页面再回来，工作区重新
// 挂上、又读一遍标签。还没存上服务器的新会话草稿不能被读到的列表盖掉，焦点也不变。
describe("工作区重新挂上再读标签", () => {
  it("内存里的新会话草稿留着，焦点还在它上面", async () => {
    listMock.mockResolvedValue(snapshot as never)
    await hydrateOnce()
    expect(useTabStore.getState().rawTabs.map((t) => t.conversationId)).toEqual(
      [7]
    )

    const draft = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(useTabStore.getState().activeTabId).toBe(draft.tabId)

    await hydrateOnce()
    const ids = useTabStore.getState().rawTabs.map((t) => t.id)
    expect(ids).toContain(draft.tabId)
    expect(useTabStore.getState().activeTabId).toBe(draft.tabId)
  })
})
