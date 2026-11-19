import { beforeEach, describe, expect, it, vi } from "vitest"

import { listOpenedTabs, saveOpenedTabs } from "@/lib/api"
import {
  buildNewConversationDraftStorageKey,
  loadMessageInputDraft,
  saveMessageInputDraft,
} from "@/lib/message-input-draft"
import type { FolderDetail, OpenedTab } from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetFolderTabsStore, useFolderTabsStore } from "./folder-tabs-store"
import {
  resetTabStore,
  restorePersistedFolderScope,
  runRecoveryOnce,
  useTabStore,
} from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const BLOB_KEY = "workspace:tab-groups:v1"

const folders = [
  { id: 1, name: "demo", path: "/demo" },
  { id: 2, name: "other", path: "/other" },
] as unknown as FolderDetail[]

function tabItem(conversationId: number, isActive = false): OpenedTab {
  return {
    folder_id: 1,
    conversation_id: conversationId,
    agent_type: "codex",
    position: 0,
    is_active: isActive,
    is_pinned: true,
  } as OpenedTab
}

const listMock = vi.mocked(listOpenedTabs)
const saveMock = vi.mocked(saveOpenedTabs)

// 模拟一次刷新：store 重新从 blob 起步，再读一次服务器的标签。
async function reload() {
  resetTabStore()
  useTabStore.getState().setAgentAvailability(["codex"], true)
  useTabStore.getState().hydrate()
  await vi.waitFor(() => expect(useTabStore.getState().tabsHydrated).toBe(true))
}

function blob() {
  return JSON.parse(localStorage.getItem(BLOB_KEY) ?? "{}")
}

beforeEach(() => {
  localStorage.clear()
  listMock.mockReset()
  saveMock.mockReset()
  saveMock.mockReturnValue(new Promise(() => {}))
  resetFolderTabsStore()
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({ folders, allFolders: folders })
})

describe("读取标签失败时本机新开的会话（#785）", () => {
  it("记进本机记录、不冲掉原来的分组，再刷新补回并聚焦，故障恢复后也在", async () => {
    // 之前正常时存下的记录：服务器上的会话 1、2 各有分组。
    const goodBlob = {
      layout: { type: "group", id: "g-home" },
      assignments: { "conv-1-codex-1": "g-home", "conv-1-codex-2": "g-home" },
      selection: { "g-home": "conv-1-codex-1" },
      tileByGroup: {},
      drafts: [],
      activeDraft: null,
      activeConversation: "conv-1-codex-1",
    }
    localStorage.setItem(BLOB_KEY, JSON.stringify(goodBlob))

    // 刷新后读取失败。
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    // 什么都没动，磁盘上的记录原样不动。
    expect(blob()).toEqual(goodBlob)

    // 新建会话、发出第一条。
    useTabStore.getState().openNewConversationTab(1, "/demo")
    const draftId = useTabStore.getState().activeTabId ?? ""
    expect(draftId).toMatch(/^new-/)
    useTabStore
      .getState()
      .bindConversationTab(draftId, 9, "codex", "Running", -1)

    const written = blob()
    expect(written.unsyncedConversations).toEqual([
      expect.objectContaining({ folderId: 1, conversationId: 9 }),
    ])
    expect(written.activeConversation).toBe("conv-1-codex-9")
    // 原来的布局和分组还在。
    expect(written.layout).toEqual(goodBlob.layout)
    expect(written.assignments).toMatchObject(goodBlob.assignments)

    // 故障还开着，再刷新：新会话补回来，是活动标签。
    await reload()
    expect(useTabStore.getState().rawTabs.map((t) => t.id)).toContain(
      "conv-1-codex-9"
    )
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-9")

    // 故障解除再刷新：服务器原有的标签都在，新会话也在，焦点在新会话上。
    listMock.mockReset()
    listMock.mockResolvedValue({
      items: [tabItem(1, true), tabItem(2)],
      version: 3,
    })
    await reload()
    const ids = useTabStore.getState().rawTabs.map((t) => t.id)
    expect(ids).toEqual(
      expect.arrayContaining([
        "conv-1-codex-1",
        "conv-1-codex-2",
        "conv-1-codex-9",
      ])
    )
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-9")
  })

  it("读取失败期间关掉的新会话不会再补回来", async () => {
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    useTabStore.getState().openNewConversationTab(1, "/demo")
    const draftId = useTabStore.getState().activeTabId ?? ""
    useTabStore
      .getState()
      .bindConversationTab(draftId, 9, "codex", "Running", -1)
    expect(blob().unsyncedConversations).toHaveLength(1)

    // 绑定后的标签在本次会话里还用草稿的 id。
    useTabStore.getState().closeTab(draftId)
    expect(blob().unsyncedConversations).toBeUndefined()
  })

  it("跟随文件夹时，读取失败期间停在的项目也记下来", async () => {
    localStorage.setItem(
      BLOB_KEY,
      JSON.stringify({
        layout: { type: "group", id: "g-home" },
        assignments: {},
        activeScope: 2,
      })
    )
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(1)
    useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(blob().activeScope).toBe(1)

    // 故障还开着，再刷新：启动时回到这个项目。
    await reload()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope(2)
    restorePersistedFolderScope()
    expect(useFolderTabsStore.getState().scope).toBe(1)
  })

  it("读取失败、启动时切回项目，不清掉本机原来记的焦点，恢复后焦点还在原来的会话", async () => {
    const goodBlob = {
      layout: { type: "group", id: "g-home" },
      assignments: { "conv-1-codex-1": "g-home", "conv-1-codex-2": "g-home" },
      selection: { "g-home": "conv-1-codex-1" },
      activeConversation: "conv-1-codex-1",
      activeScope: 1,
    }
    localStorage.setItem(BLOB_KEY, JSON.stringify(goodBlob))
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    // TabProvider 启动时：读出跟随开关、回到上次的项目（用户什么都没动）。
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope("global")
    restorePersistedFolderScope()
    expect(useFolderTabsStore.getState().scope).toBe(1)
    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(blob().activeConversation).toBe("conv-1-codex-1")

    // 故障解除：服务器记的焦点是会话 2，本机原来的焦点会话 1 优先。
    listMock.mockReset()
    listMock.mockResolvedValue({
      items: [tabItem(1), tabItem(2, true)],
      version: 3,
    })
    await reload()
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-1")
  })

  it("读取失败、上次停在全局时，回到本机上次聚焦的会话所在的项目", async () => {
    localStorage.setItem(
      BLOB_KEY,
      JSON.stringify({
        layout: { type: "group", id: "g-home" },
        assignments: { "conv-2-codex-5": "g-home" },
        activeConversation: "conv-2-codex-5",
        activeScope: "global",
      })
    )
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    useFolderTabsStore.getState().setEnabled(true)
    useFolderTabsStore.getState().activateScope("global")
    restorePersistedFolderScope()
    useTabStore.getState().syncActiveFolderId()
    expect(useFolderTabsStore.getState().scope).toBe(2)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(2)
  })

  it("读取失败、老记录没有项目范围、没开跟随时，补出的新会话也在上次的项目里", async () => {
    localStorage.setItem(
      BLOB_KEY,
      JSON.stringify({
        layout: { type: "group", id: "g-home" },
        assignments: { "conv-2-codex-5": "g-home" },
        activeConversation: "conv-2-codex-5",
      })
    )
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    expect(useTabStore.getState().rawTabs).toHaveLength(0)
    useTabStore.getState().recoverActiveContext()
    const active = useTabStore
      .getState()
      .rawTabs.find((t) => t.id === useTabStore.getState().activeTabId)
    expect(active?.folderId).toBe(2)
  })

  it("读取失败、没开跟随时，启动补出的草稿不顶掉本机原来记的焦点，恢复后焦点还在原来的会话", async () => {
    const goodBlob = {
      layout: { type: "group", id: "g-home" },
      assignments: { "conv-1-codex-1": "g-home", "conv-1-codex-2": "g-home" },
      selection: { "g-home": "conv-1-codex-1" },
      tileByGroup: {},
      drafts: [],
      activeDraft: null,
      activeConversation: "conv-1-codex-1",
    }
    localStorage.setItem(BLOB_KEY, JSON.stringify(goodBlob))
    listMock.mockRejectedValue(new Error("500"))
    // 连着刷新两次，每次 TabProvider 启动时都因为没有标签补一个草稿（用户什么都没动）。
    for (let i = 0; i < 2; i++) {
      await reload()
      runRecoveryOnce()
      const active = useTabStore
        .getState()
        .rawTabs.find((t) => t.id === useTabStore.getState().activeTabId)
      expect(active?.folderId).toBe(1)
      expect(blob().activeConversation).toBe("conv-1-codex-1")
      expect(blob().activeDraft ?? null).toBeNull()
    }

    // 故障解除：焦点回到原来的会话 1，不是补出来的草稿。
    listMock.mockReset()
    listMock.mockResolvedValue({
      items: [tabItem(1, true), tabItem(2)],
      version: 3,
    })
    await reload()
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-1")
  })

  it("读取失败、启动补出的草稿被用户用来发了消息，就照常记成焦点", async () => {
    localStorage.setItem(
      BLOB_KEY,
      JSON.stringify({
        layout: { type: "group", id: "g-home" },
        assignments: { "conv-1-codex-1": "g-home" },
        activeConversation: "conv-1-codex-1",
      })
    )
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    runRecoveryOnce()
    const draftId = useTabStore.getState().activeTabId ?? ""
    useTabStore
      .getState()
      .bindConversationTab(draftId, 9, "codex", "Running", -1)
    expect(blob().activeConversation).toBe("conv-1-codex-9")
  })

  it("读取失败、没开跟随时，在启动补出的草稿里打了字没发就刷新，字还在、原来的焦点照旧", async () => {
    localStorage.setItem(
      BLOB_KEY,
      JSON.stringify({
        layout: { type: "group", id: "g-home" },
        assignments: { "conv-1-codex-1": "g-home" },
        selection: { "g-home": "conv-1-codex-1" },
        activeConversation: "conv-1-codex-1",
      })
    )
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    runRecoveryOnce()
    const fillerId = useTabStore.getState().activeTabId ?? ""
    expect(fillerId).not.toBe("")
    // 用户在输入框里打字（输入框按草稿标签 id 存字），没发就刷新。
    const draftKey = buildNewConversationDraftStorageKey(fillerId)
    saveMessageInputDraft(draftKey, "还没发的字")
    window.dispatchEvent(new Event("pagehide"))

    await reload()
    runRecoveryOnce()
    // 还是同一个草稿，输入框按它的 id 读回刚才的字。
    expect(useTabStore.getState().activeTabId).toBe(fillerId)
    expect(loadMessageInputDraft(draftKey)).toBe("还没发的字")
    expect(blob().activeConversation).toBe("conv-1-codex-1")
    expect(blob().activeDraft ?? null).toBeNull()

    // 故障解除：焦点回到原来的会话，打了字的草稿也还在。
    listMock.mockReset()
    listMock.mockResolvedValue({ items: [tabItem(1, true)], version: 3 })
    await reload()
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-1")
    expect(useTabStore.getState().rawTabs.some((t) => t.id === fillerId)).toBe(
      true
    )
    expect(loadMessageInputDraft(draftKey)).toBe("还没发的字")
  })

  it("读取失败期间启动补出、什么都没打的空草稿，故障恢复后不留下来", async () => {
    localStorage.setItem(
      BLOB_KEY,
      JSON.stringify({
        layout: { type: "group", id: "g-home" },
        assignments: { "conv-1-codex-1": "g-home" },
        activeConversation: "conv-1-codex-1",
      })
    )
    listMock.mockRejectedValue(new Error("500"))
    await reload()
    runRecoveryOnce()
    listMock.mockReset()
    listMock.mockResolvedValue({ items: [tabItem(1, true)], version: 3 })
    await reload()
    expect(useTabStore.getState().activeTabId).toBe("conv-1-codex-1")
    expect(
      useTabStore.getState().rawTabs.filter((t) => t.conversationId == null)
    ).toHaveLength(0)
  })
})
