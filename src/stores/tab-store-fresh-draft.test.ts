import { beforeEach, describe, expect, it, vi } from "vitest"

import { resetClosedTabStackForTests } from "@/lib/closed-tab-stack"
import {
  draftMessageQueueStorageKey,
  readStoredQueue,
} from "@/lib/cowork/message-queue-storage"
import {
  buildNewConversationDraftStorageKey,
  setLiveComposerContent,
} from "@/lib/message-input-draft"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetFolderTabsStore } from "./folder-tabs-store"
import { resetTabStore, useTabStore } from "./tab-store"
import { openContinueDraft } from "@/components/cowork/shared-session-view"
import {
  consumeContinuePrompt,
  resetContinuePromptsForTests,
} from "@/lib/cowork/continue-handoff"
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

const folder = { id: 1, name: "demo", path: "/demo" } as unknown as FolderDetail

const storeQueue = (draftTabId: string) =>
  localStorage.setItem(
    draftMessageQueueStorageKey(draftTabId),
    JSON.stringify([
      {
        id: "q1",
        draft: {
          blocks: [{ type: "text", text: "unsent" }],
          displayText: "unsent",
        },
        modeId: null,
        failure: "send",
      },
    ])
  )

const queued = (tabId: string) =>
  readStoredQueue(draftMessageQueueStorageKey(tabId))

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetFolderTabsStore()
  resetClosedTabStackForTests()
  localStorage.clear()
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  useTabStore.setState({ tabsHydrated: true })
})

// #1235 第 7 行：「让我的智能体接着做」要的是一个空白草稿，排队区是空的。
describe("freshDraft", () => {
  it("does not reuse the group's draft whose queue holds an unsent message", () => {
    const old = useTabStore.getState().openNewConversationTab(1, "/demo")
    storeQueue(old.tabId)
    const fresh = useTabStore
      .getState()
      .openNewConversationTab(1, "/demo", { freshDraft: true })
    expect(fresh.tabId).not.toBe(old.tabId)
    expect(useTabStore.getState().activeTabId).toBe(fresh.tabId)
    expect(queued(fresh.tabId)).toEqual([])
    // 原来那个草稿和它的消息原样留着。
    expect(queued(old.tabId).map((i) => i.id)).toEqual(["q1"])
  })

  it("does not reuse a draft the user is typing in", () => {
    const old = useTabStore.getState().openNewConversationTab(1, "/demo")
    setLiveComposerContent(
      buildNewConversationDraftStorageKey(old.tabId),
      "composer-1",
      true
    )
    const fresh = useTabStore
      .getState()
      .openNewConversationTab(1, "/demo", { freshDraft: true })
    expect(fresh.tabId).not.toBe(old.tabId)
    setLiveComposerContent(
      buildNewConversationDraftStorageKey(old.tabId),
      "composer-1",
      false
    )
  })

  it("still reuses a blank draft", () => {
    const old = useTabStore.getState().openNewConversationTab(1, "/demo")
    const fresh = useTabStore
      .getState()
      .openNewConversationTab(1, "/demo", { freshDraft: true })
    expect(fresh.tabId).toBe(old.tabId)
  })

  it("does not claim a closed draft's parked queue (#1042)", () => {
    const old = useTabStore.getState().openNewConversationTab(1, "/demo")
    storeQueue(old.tabId)
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    useTabStore.getState().closeTab(old.tabId)
    const fresh = useTabStore
      .getState()
      .openNewConversationTab(1, "/demo", { freshDraft: true })
    expect(queued(fresh.tabId)).toEqual([])
    // 寄存的那份留给之后普通的新建草稿。
    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(queued(next.tabId).map((i) => i.id)).toEqual(["q1"])
  })

  it("chat mode: does not reuse a chat draft whose queue holds a message", () => {
    const old = useTabStore.getState().openChatModeTab()
    storeQueue(old.tabId)
    const fresh = useTabStore.getState().openChatModeTab({ freshDraft: true })
    expect(fresh.tabId).not.toBe(old.tabId)
    expect(queued(fresh.tabId)).toEqual([])
    expect(queued(old.tabId).map((i) => i.id)).toEqual(["q1"])
  })
})

// 第 2 次返工：「让我的智能体接着做」开出来的草稿用我当前标签的智能体，
// 复用的空白草稿原来是别的智能体也要改过来。
describe("openContinueDraft", () => {
  beforeEach(() => resetContinuePromptsForTests())

  it("no project open: re-points a reused blank chat draft to my current agent", () => {
    const chat = useTabStore
      .getState()
      .openChatModeTab({ forceAgent: "claude_code" })
    useTabStore.getState().openTab(1, 7, "gemini", true)
    useAppWorkspaceStore.setState({ activeFolderId: null })
    openContinueDraft("hello")
    const st = useTabStore.getState()
    const active = st.rawTabs.find((t) => t.id === st.activeTabId)
    expect(active?.id).toBe(chat.tabId)
    expect(active?.agentType).toBe("gemini")
    expect(
      consumeContinuePrompt(chat.tabId, { agentType: "gemini", folderId: 0 })
    ).toBe("hello")
  })

  it("project open: the draft runs on my current agent, not the folder default", () => {
    useAppWorkspaceStore.setState({
      folders: [{ ...folder, default_agent_type: "codex" } as FolderDetail],
      allFolders: [{ ...folder, default_agent_type: "codex" } as FolderDetail],
      activeFolderId: 1,
    })
    useTabStore.getState().openTab(1, 7, "gemini", true)
    openContinueDraft("hello")
    const st = useTabStore.getState()
    const active = st.rawTabs.find((t) => t.id === st.activeTabId)
    expect(active?.conversationId).toBeNull()
    expect(active?.agentType).toBe("gemini")
  })
})
