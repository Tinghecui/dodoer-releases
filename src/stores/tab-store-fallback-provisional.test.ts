import { beforeEach, describe, expect, it, vi } from "vitest"

import { resetAppWorkspaceStore } from "./app-workspace-store"
import { resetTabStore, runCorrectionOnce, useTabStore } from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

// AI QA #436：草稿标签页在 provisional 时不自动连接，所以 provisional
// 必须在一次性的纠正跑过以后不再出现，不然这个草稿永远连不上。
function seedDraft() {
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
    ],
    activeTabId: "draft",
  })
}

const draft = () => useTabStore.getState().rawTabs.find((t) => t.id === "draft")

beforeEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
  seedDraft()
})

describe("setDraftAgentFromFallback", () => {
  it("stays provisional before the correction has run", () => {
    useTabStore.getState().setDraftAgentFromFallback("draft", "gemini")
    expect(draft()?.agentType).toBe("gemini")
    expect(draft()?.agentTypeProvisional).toBe(true)
  })

  it("is final once the one-shot correction has run", () => {
    useTabStore.getState().setAgentAvailability(["claude_code"], true)
    runCorrectionOnce()
    useTabStore.getState().setDraftAgentFromFallback("draft", "gemini")
    expect(draft()?.agentType).toBe("gemini")
    expect(draft()?.agentTypeProvisional).toBe(false)
  })
})
