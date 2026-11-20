import { beforeEach, describe, expect, it, vi } from "vitest"

import { listOpenedTabs, saveOpenedTabs } from "@/lib/api"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { FolderDetail } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetFolderTabsStore } from "./folder-tabs-store"
import { resetTabStore, useTabStore } from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  getActiveRemoteConnectionId: vi.fn(() => null),
}))

const LOCAL_KEY = "workspace:tab-groups:v1"
const REMOTE_KEY = "workspace:tab-groups:v1:remote-7"

const folders = [
  { id: 1, name: "demo", path: "/srv/demo" },
] as unknown as FolderDetail[]

const remoteIdMock = vi.mocked(getActiveRemoteConnectionId)
const listMock = vi.mocked(listOpenedTabs)
const saveMock = vi.mocked(saveOpenedTabs)

// 本机窗口留下的记录：一个新会话草稿，带着本机的文件夹路径。
const localBlob = {
  layout: { type: "group", id: "g-local" },
  assignments: {},
  selection: {},
  tileByGroup: {},
  drafts: [
    {
      id: "new-local-draft",
      group: "g-local",
      index: 0,
      folderId: 1,
      workingDir: "/Users/someone/qa/mrepo",
      agentType: "codex",
    },
  ],
  activeDraft: "new-local-draft",
  activeConversation: null,
}

async function hydrate() {
  useTabStore.getState().setAgentAvailability(["codex"], true)
  useTabStore.getState().hydrate()
  await vi.waitFor(() => expect(useTabStore.getState().tabsHydrated).toBe(true))
}

beforeEach(() => {
  localStorage.clear()
  remoteIdMock.mockReturnValue(null)
  listMock.mockReset()
  listMock.mockResolvedValue({ version: 1, items: [] })
  saveMock.mockReset()
  saveMock.mockReturnValue(new Promise(() => {}))
  resetFolderTabsStore()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({ folders, allFolders: folders })
})

describe("远端窗口的标签记录和本机窗口分开（#1063）", () => {
  it("store 在拿到远端 id 之前就建好了，远端窗口也不恢复本机窗口的草稿", async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localBlob))
    // 模块加载时还没连上远端（远端 id 是异步拿到的），这时读的是本机那份。
    resetTabStore()
    // 远端窗口拿到连接以后才开始恢复标签。
    remoteIdMock.mockReturnValue(7)
    await hydrate()

    const tabs = useTabStore.getState().rawTabs
    expect(tabs.map((t) => t.id)).not.toContain("new-local-draft")
    expect(tabs.some((t) => t.workingDir === "/Users/someone/qa/mrepo")).toBe(
      false
    )
  })

  it("远端窗口写进自己的记录，本机窗口那份不动", async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localBlob))
    remoteIdMock.mockReturnValue(7)
    resetTabStore()
    await hydrate()

    useTabStore.getState().openNewConversationTab(1, "/srv/demo")

    expect(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? "{}")).toEqual(
      localBlob
    )
    const remote = JSON.parse(localStorage.getItem(REMOTE_KEY) ?? "{}")
    expect(
      (remote.drafts as { workingDir?: string }[]).map((d) => d.workingDir)
    ).toContain("/srv/demo")
  })

  it("本机窗口照旧用原来的记录，老数据不用迁移", async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localBlob))
    resetTabStore()
    await hydrate()

    expect(useTabStore.getState().rawTabs.map((t) => t.id)).toContain(
      "new-local-draft"
    )
  })
})

// 输入框里没发出去的文字存在共用的 localStorage 里，按草稿标签的 id 记。
const LOCAL_DRAFT_TEXT_KEY =
  "codeg:message-input-draft:v1:draft:new-local-draft"
const REMOTE_DRAFT_TEXT_KEY =
  "codeg:message-input-draft:v1:draft:new-remote-draft"

const remoteBlob = {
  ...localBlob,
  layout: { type: "group", id: "g-remote" },
  drafts: [
    {
      id: "new-remote-draft",
      group: "g-remote",
      index: 0,
      folderId: 1,
      workingDir: "/srv/demo",
      agentType: "codex",
    },
  ],
  activeDraft: "new-remote-draft",
}

describe("标签记录分开后，清理草稿文字不删另一个窗口的（#1063）", () => {
  it("远端窗口恢复标签时不删本机窗口草稿里没发的文字", async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localBlob))
    localStorage.setItem(LOCAL_DRAFT_TEXT_KEY, "本机没发的话")
    localStorage.setItem("codeg:message-input-draft:v1:draft:new-gone", "x")
    remoteIdMock.mockReturnValue(7)
    resetTabStore()
    await hydrate()

    await vi.waitFor(() =>
      expect(
        localStorage.getItem("codeg:message-input-draft:v1:draft:new-gone")
      ).toBeNull()
    )
    expect(localStorage.getItem(LOCAL_DRAFT_TEXT_KEY)).toBe("本机没发的话")
  })

  it("本机窗口恢复标签时不删远端窗口草稿里没发的文字", async () => {
    localStorage.setItem(LOCAL_KEY, JSON.stringify(localBlob))
    localStorage.setItem(REMOTE_KEY, JSON.stringify(remoteBlob))
    localStorage.setItem(REMOTE_DRAFT_TEXT_KEY, "远端没发的话")
    localStorage.setItem("codeg:message-input-draft:v1:draft:new-gone", "x")
    resetTabStore()
    await hydrate()

    await vi.waitFor(() =>
      expect(
        localStorage.getItem("codeg:message-input-draft:v1:draft:new-gone")
      ).toBeNull()
    )
    expect(localStorage.getItem(REMOTE_DRAFT_TEXT_KEY)).toBe("远端没发的话")
  })
})
