import { beforeEach, describe, expect, it, vi } from "vitest"

import { resetClosedTabStackForTests } from "@/lib/closed-tab-stack"
import {
  buildNewConversationDraftStorageKey,
  saveMessageInputDraftV2,
} from "@/lib/message-input-draft"
import { MAX_CONVERSATION_TABS } from "@/lib/tab-limit"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore, type TabItemInternal } from "./tab-store"
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

const folder = { id: 1, name: "repo", path: "/repo" } as unknown as FolderDetail

const tabId = (conversationId: number) => `conv-1-claude_code-${conversationId}`

function open(conversationId: number) {
  useTabStore.getState().openTab(1, conversationId, "claude_code", true)
}

const ids = () => useTabStore.getState().rawTabs.map((tab) => tab.id)
const settle = () => new Promise<void>((resolve) => queueMicrotask(resolve))

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetClosedTabStackForTests()
  localStorage.clear()
  useAppWorkspaceStore.setState({ folders: [folder], allFolders: [folder] })
  useTabStore.setState({ tabsHydrated: true })
})

describe("conversation tab cap", () => {
  it("is five tabs", () => {
    expect(MAX_CONVERSATION_TABS).toBe(5)
  })

  it("closes the oldest tab when a sixth opens", async () => {
    for (let id = 1; id <= 6; id += 1) open(id)
    await settle()
    expect(ids()).toEqual([2, 3, 4, 5, 6].map(tabId))
    expect(useTabStore.getState().activeTabId).toBe(tabId(6))
  })

  it("keeps a tab the user went back to", async () => {
    for (let id = 1; id <= 5; id += 1) open(id)
    useTabStore.getState().switchTab(tabId(1))
    open(6)
    await settle()
    expect(ids()).toEqual([1, 3, 4, 5, 6].map(tabId))
  })

  it("trims a restored strip that is already over the cap", async () => {
    useTabStore.setState({ tabsHydrated: false })
    const restored: TabItemInternal[] = [1, 2, 3, 4, 5, 6, 7].map((id) => ({
      id: tabId(id),
      kind: "conversation",
      folderId: 1,
      conversationId: id,
      agentType: "claude_code",
      title: `t${id}`,
      isPinned: true,
    }))
    useTabStore.setState({ rawTabs: restored, activeTabId: tabId(1) })
    useTabStore.setState({ tabsHydrated: true })
    await settle()
    expect(ids()).toEqual([1, 4, 5, 6, 7].map(tabId))
  })

  it("keeps the tab another split pane is showing", async () => {
    open(1)
    open(2)
    useTabStore.getState().splitTab(tabId(1), "right", { move: true })
    useTabStore.getState().switchTab(tabId(2))
    for (let id = 3; id <= 6; id += 1) open(id)
    await settle()
    const { groupSelection } = useTabStore.getState()
    expect(Object.values(groupSelection)).toContain(tabId(1))
    expect(ids()).toContain(tabId(1))
    expect(ids()).not.toContain(tabId(2))
    expect(ids()).toHaveLength(5)
  })

  it("leaves a draft with unsent text open", async () => {
    const draft = useTabStore.getState().openNewConversationTab(1, "/repo")
    saveMessageInputDraftV2(buildNewConversationDraftStorageKey(draft.tabId), {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    })
    for (let id = 1; id <= 5; id += 1) open(id)
    await settle()
    expect(ids()).toEqual([draft.tabId, ...[2, 3, 4, 5].map(tabId)])
  })
})
