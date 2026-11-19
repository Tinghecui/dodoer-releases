import { beforeEach, describe, expect, it, vi } from "vitest"

import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import { resetTabStore, useTabStore } from "./tab-store"
import type { ConversationWorktreeSpec, FolderDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const repo = { id: 1, name: "repo", path: "/repo" } as unknown as FolderDetail
const worktree = {
  id: 2,
  name: "repo-cv-tidy-fox",
  path: "/wt/repo-cv-tidy-fox",
  parent_id: 1,
} as unknown as FolderDetail

const spec: ConversationWorktreeSpec = {
  kind: "branch_off",
  branch: "cv/tidy-fox",
  base: "main",
}

function seed() {
  useAppWorkspaceStore.setState({
    folders: [repo, worktree],
    allFolders: [repo, worktree],
  })
  useTabStore.setState({
    rawTabs: [
      {
        id: "draft",
        kind: "conversation",
        folderId: 1,
        conversationId: null,
        agentType: "claude_code",
        title: "new",
        isPinned: true,
        workingDir: "/repo",
      },
      {
        id: "bound",
        kind: "conversation",
        folderId: 1,
        conversationId: 7,
        agentType: "claude_code",
        title: "kept",
        isPinned: false,
      },
    ],
    activeTabId: "draft",
  })
}

const tab = (id: string) =>
  useTabStore.getState().rawTabs.find((t) => t.id === id)

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  seed()
})

describe("setDraftWorktree", () => {
  it("records and clears the choice on a draft", () => {
    useTabStore.getState().setDraftWorktree("draft", spec)
    expect(tab("draft")?.pendingWorktree).toEqual(spec)
    useTabStore.getState().setDraftWorktree("draft", null)
    expect(tab("draft")?.pendingWorktree).toBeUndefined()
  })

  it("ignores bound tabs — their working directory is already fixed", () => {
    const before = tab("bound")
    useTabStore.getState().setDraftWorktree("bound", spec)
    expect(tab("bound")).toBe(before)
  })
})

describe("the choice is dropped when the draft moves", () => {
  it("retargeting into the created worktree clears it", async () => {
    useTabStore.getState().setDraftWorktree("draft", spec)
    // What the first send does once the worktree exists: same draft, same
    // agent, new folder → a queued retarget.
    useTabStore.getState().openNewConversationTab(2, worktree.path, {
      forceAgent: "claude_code",
    })
    useTabStore.getState().consumeDraftRetargets()
    await vi.waitFor(() => {
      expect(tab("draft")?.folderId).toBe(2)
    })
    expect(tab("draft")?.workingDir).toBe(worktree.path)
    expect(tab("draft")?.pendingWorktree).toBeUndefined()
  })

  it("switching the draft to chat mode clears it", () => {
    useTabStore.getState().setDraftWorktree("draft", spec)
    useTabStore.getState().openChatModeTab()
    expect(tab("draft")?.isChat).toBe(true)
    expect(tab("draft")?.pendingWorktree).toBeUndefined()
  })
})

// #837：「新建会话」复用分组里已有的草稿时，给的是一份干净的草稿——上次选的
// 工作树分支（可能正是创建失败的那个）不再跟着。
describe("clicking new conversation resets the worktree choice", () => {
  const badSpec: ConversationWorktreeSpec = {
    kind: "branch_off",
    branch: `qa/${"a".repeat(260)}`,
    base: "main",
  }

  it("reusing the same draft clears it", () => {
    useTabStore.getState().setDraftWorktree("draft", badSpec)
    const opened = useTabStore.getState().openNewConversationTab(1, "/repo")
    expect(opened.tabId).toBe("draft")
    expect(tab("draft")?.pendingWorktree).toBeUndefined()
  })

  it("clears it when the reused draft also changes working dir", () => {
    useTabStore.getState().setDraftWorktree("draft", badSpec)
    const opened = useTabStore.getState().openNewConversationTab(1, "/repo/sub")
    expect(opened.tabId).toBe("draft")
    expect(tab("draft")?.workingDir).toBe("/repo/sub")
    expect(tab("draft")?.pendingWorktree).toBeUndefined()
  })

  it("clears it when the reused draft is retargeted to another folder", () => {
    useTabStore.getState().setDraftWorktree("draft", badSpec)
    const opened = useTabStore
      .getState()
      .openNewConversationTab(2, worktree.path)
    expect(opened.tabId).toBe("draft")
    expect(tab("draft")?.pendingWorktree).toBeUndefined()
  })

  it("a draft restored from a reload is cleared too", async () => {
    useTabStore.setState({
      rawTabs: [
        {
          id: "restored",
          kind: "conversation",
          folderId: 1,
          conversationId: null,
          agentType: "claude_code",
          title: "new",
          isPinned: true,
          workingDir: "/repo",
          pendingWorktree: badSpec,
        },
      ],
      activeTabId: "restored",
    })
    const opened = useTabStore.getState().openNewConversationTab(1, "/repo")
    expect(opened.tabId).toBe("restored")
    expect(tab("restored")?.pendingWorktree).toBeUndefined()
  })

  it("moving the draft itself (retargetTabId) keeps it until the retarget", () => {
    useTabStore.getState().setDraftWorktree("draft", spec)
    useTabStore.getState().openNewConversationTab(2, worktree.path, {
      forceAgent: "claude_code",
      retargetTabId: "draft",
    })
    expect(tab("draft")?.pendingWorktree).toEqual(spec)
  })

  it("startup recovery keeps the restored choice", () => {
    useTabStore.getState().setDraftWorktree("draft", spec)
    useTabStore.getState().recoverActiveContext()
    expect(tab("draft")?.pendingWorktree).toEqual(spec)
  })
})
