import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  popClosedTab,
  resetClosedTabStackForTests,
} from "@/lib/closed-tab-stack"
import {
  draftMessageQueueStorageKey,
  readStoredQueue,
} from "@/lib/cowork/message-queue-storage"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetFolderTabsStore, useFolderTabsStore } from "./folder-tabs-store"
import { resetTabStore, useTabStore } from "./tab-store"
import type { ConversationWorktreeSpec, FolderDetail } from "@/lib/types"

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
const other = {
  id: 2,
  name: "other",
  path: "/other",
} as unknown as FolderDetail

const spec: ConversationWorktreeSpec = {
  kind: "branch_off",
  branch: "qa/queue-keep",
  base: null,
}

const storeQueue = (draftTabId: string, ids: string[] = ["q1"]) =>
  localStorage.setItem(
    draftMessageQueueStorageKey(draftTabId),
    JSON.stringify(
      ids.map((id) => ({
        id,
        draft: {
          blocks: [{ type: "text", text: `queue-920 ${id}` }],
          displayText: `queue-920 ${id}`,
        },
        modeId: null,
        failure: "send",
      }))
    )
  )

const queuedIds = (tabId: string) =>
  readStoredQueue(draftMessageQueueStorageKey(tabId)).map((i) => i.id)

const tab = (id: string) =>
  useTabStore.getState().rawTabs.find((t) => t.id === id)

/** 开一个排队区存着没发出去的消息、选了新工作树的草稿。 */
function queuedDraft(folderId = 1, workingDir = "/demo") {
  const draft = useTabStore
    .getState()
    .openNewConversationTab(folderId, workingDir)
  useTabStore.getState().setDraftWorktree(draft.tabId, spec)
  storeQueue(draft.tabId)
  return draft.tabId
}

function expectClaimedBy(newTabId: string, oldTabId: string) {
  expect(newTabId).not.toBe(oldTabId)
  expect(
    readStoredQueue(draftMessageQueueStorageKey(newTabId)).map((i) => i.id)
  ).toEqual(["q1"])
  expect(localStorage.getItem(draftMessageQueueStorageKey(oldTabId))).toBeNull()
  expect(tab(newTabId)?.pendingWorktree).toEqual(spec)
}

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  resetFolderTabsStore()
  resetClosedTabStackForTests()
  localStorage.clear()
  useAppWorkspaceStore.setState({
    folders: [folder, other],
    allFolders: [folder, other],
  })
  useTabStore.setState({ tabsHydrated: true })
})

// #1042：关掉排队区存着没发出去消息的草稿，又没有补草稿接着用时，消息
// 交给这个项目下一个新建（或重开）的草稿，不能留在关掉的标签名下找不回。
describe("closing a draft whose queue holds an unsent message (#1042)", () => {
  it("tabs follow the folder: the next new draft of the folder gets the queue and the worktree choice", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const oldId = queuedDraft()
    useTabStore.getState().closeTab(oldId)
    expect(useTabStore.getState().rawTabs).toEqual([])

    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expectClaimedBy(next.tabId, oldId)
  })

  it("other tabs still open: the next new draft gets it too", () => {
    const oldId = queuedDraft()
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    useTabStore.getState().closeTab(oldId)
    expect(tab(oldId)).toBeUndefined()

    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expectClaimedBy(next.tabId, oldId)
  })

  it("reopening the closed draft (the Ctrl+Shift+T path) gets it back", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const oldId = queuedDraft()
    useTabStore.getState().closeTab(oldId)

    // 照 workspace-chrome-controller 的重开：弹出关闭标签栈，按快照重开
    const closed = popClosedTab()
    expect(closed?.kind).toBe("conversation")
    if (closed?.kind !== "conversation") return
    expect(closed.conversationId).toBeNull()
    const next = useTabStore
      .getState()
      .openNewConversationTab(closed.folderId, closed.workingDir ?? "/demo", {
        index: closed.index,
      })
    expectClaimedBy(next.tabId, oldId)
  })

  it("two closed drafts with different worktrees each come back with their own, nothing dropped", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const many = Array.from({ length: 40 }, (_, i) => `a${i}`)
    const otherSpec: ConversationWorktreeSpec = {
      kind: "branch_off",
      branch: "qa/other",
      base: null,
    }
    // 两个草稿同时开着（比如分屏的两组各一个），先后关掉
    const x = queuedDraft()
    storeQueue(x, many)
    const draftY = { ...tab(x)!, id: "new-conv-y", pendingWorktree: otherSpec }
    useTabStore.setState({
      rawTabs: [...useTabStore.getState().rawTabs, draftY],
    })
    storeQueue("new-conv-y", ["b1"])
    useTabStore.getState().closeTab(x)
    useTabStore.getState().closeTab("new-conv-y")
    expect(useTabStore.getState().rawTabs).toEqual([])

    // 后关的先领，各自带着自己的新工作树选择
    const n1 = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(queuedIds(n1.tabId)).toEqual(["b1"])
    expect(tab(n1.tabId)?.pendingWorktree).toEqual(otherSpec)
    useTabStore.getState().setDraftWorktree(n1.tabId, null)
    localStorage.removeItem(draftMessageQueueStorageKey(n1.tabId))
    useTabStore.getState().closeTab(n1.tabId)

    const n2 = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(queuedIds(n2.tabId)).toEqual(many)
    expect(tab(n2.tabId)?.pendingWorktree).toEqual(spec)
  })

  it("a reused draft that has its own queue does not take another draft's", () => {
    const oldId = queuedDraft()
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    useTabStore.getState().closeTab(oldId)

    const own = queuedDraft(2, "/other")
    storeQueue(own, ["own"])
    const reused = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(reused.tabId).toBe(own)
    expect(queuedIds(own)).toEqual(["own"])
  })

  it("is handed over only once, and not to another folder's draft", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const oldId = queuedDraft()
    useTabStore.getState().closeTab(oldId)

    const elsewhere = useTabStore.getState().openNewConversationTab(2, "/other")
    expect(
      readStoredQueue(draftMessageQueueStorageKey(elsewhere.tabId))
    ).toEqual([])
    expect(tab(elsewhere.tabId)?.pendingWorktree).toBeUndefined()

    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expectClaimedBy(next.tabId, oldId)
    useTabStore.getState().setDraftWorktree(next.tabId, null)
    localStorage.removeItem(draftMessageQueueStorageKey(next.tabId))
    useTabStore.getState().closeTab(next.tabId)

    const again = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(readStoredQueue(draftMessageQueueStorageKey(again.tabId))).toEqual(
      []
    )
    expect(tab(again.tabId)?.pendingWorktree).toBeUndefined()
  })

  // 第 2 次返工：审查员指出的四种情况
  it("a reused blank draft of another folder takes it at once and keeps the worktree after the retarget", async () => {
    const oldId = queuedDraft()
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    useTabStore.getState().closeTab(oldId)
    const blank = useTabStore.getState().openNewConversationTab(2, "/other")

    const reused = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(reused.tabId).toBe(blank.tabId)
    expectClaimedBy(reused.tabId, oldId)
    useTabStore.getState().consumeDraftRetargets()
    await vi.waitFor(() => expect(tab(reused.tabId)?.folderId).toBe(1))
    expect(tab(reused.tabId)?.workingDir).toBe("/demo")
    expect(tab(reused.tabId)?.pendingWorktree).toEqual(spec)
  })

  it("a queue without a worktree choice only goes to a draft in the same directory", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const draft = useTabStore.getState().openNewConversationTab(1, "/demo")
    storeQueue(draft.tabId)
    useTabStore.getState().closeTab(draft.tabId)

    const sub = useTabStore.getState().openNewConversationTab(1, "/demo/sub")
    expect(queuedIds(sub.tabId)).toEqual([])
    useTabStore.getState().closeTab(sub.tabId)

    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(queuedIds(next.tabId)).toEqual(["q1"])
    expect(tab(next.tabId)?.pendingWorktree).toBeUndefined()
  })

  it("reopening into a reused draft that has a worktree choice drops it when the queue had none", () => {
    const draft = useTabStore.getState().openNewConversationTab(1, "/demo")
    storeQueue(draft.tabId)
    const copy = tab(draft.tabId)!
    useTabStore.getState().openTab(1, 7, "claude_code", true)
    useTabStore.getState().closeTab(draft.tabId)
    // 同一项目里另一个选了新工作树的空草稿（新建会话会先领走消息，直接放进去）
    const blank = { tabId: "new-conv-blank" }
    useTabStore.setState({
      rawTabs: [
        ...useTabStore.getState().rawTabs,
        { ...copy, id: blank.tabId, pendingWorktree: spec },
      ],
    })

    const reopened = useTabStore
      .getState()
      .openNewConversationTab(1, "/demo", { index: 0 })
    expect(reopened.tabId).toBe(blank.tabId)
    expect(queuedIds(reopened.tabId)).toEqual(["q1"])
    expect(tab(reopened.tabId)?.pendingWorktree).toBeUndefined()
  })

  // #1191：领回消息后切到别的聊天再点同一项目的「新建会话」，复用的是这个
  // 排队区有消息的草稿，新工作树选择不能被 #837 的重置清掉。
  it("reusing a draft whose queue still holds the claimed message keeps its worktree choice", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const oldId = queuedDraft()
    useTabStore.getState().closeTab(oldId)
    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expectClaimedBy(next.tabId, oldId)

    useTabStore.getState().openChatModeTab()
    const again = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(again.tabId).toBe(next.tabId)
    expect(queuedIds(again.tabId)).toEqual(["q1"])
    expect(tab(again.tabId)?.pendingWorktree).toEqual(spec)
  })

  it("a reused draft with an empty queue still has its worktree choice reset (#837)", () => {
    const draft = useTabStore.getState().openNewConversationTab(1, "/demo")
    useTabStore.getState().setDraftWorktree(draft.tabId, spec)
    const again = useTabStore.getState().openNewConversationTab(1, "/demo")
    expect(again.tabId).toBe(draft.tabId)
    expect(tab(again.tabId)?.pendingWorktree).toBeUndefined()
  })

  it("storage too full to copy the queue on close still leaves it claimable", () => {
    useFolderTabsStore.getState().setEnabled(true)
    const oldId = queuedDraft()
    const setItem = Storage.prototype.setItem
    const spy = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(function (this: Storage, key: string, value: string) {
        // 只有排队消息本身存不下，寄存清单这种小条目还写得进去
        if (key.includes(":draft-") && !key.endsWith(":parks")) {
          throw new DOMException("full", "QuotaExceededError")
        }
        setItem.call(this, key, value)
      })
    useTabStore.getState().closeTab(oldId)
    spy.mockRestore()

    const next = useTabStore.getState().openNewConversationTab(1, "/demo")
    expectClaimedBy(next.tabId, oldId)
  })
})
