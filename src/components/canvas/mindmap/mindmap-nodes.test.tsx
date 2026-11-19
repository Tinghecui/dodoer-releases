import { render } from "@testing-library/react"
import { ReactFlowProvider, type NodeProps } from "@xyflow/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it } from "vitest"
import { TooltipProvider } from "@/components/ui/tooltip"
import enMessages from "@/i18n/messages/en.json"
import type { DbConversationSummary } from "@/lib/types"
import {
  useBackgroundPendingStore,
  type BackgroundPending,
} from "@/stores/background-pending-store"
import { useConversationSeenStore } from "@/stores/conversation-seen-store"
import {
  MindMapActionsProvider,
  MindMapLeaf,
  type MindMapActions,
  type MindMapLeafNode,
} from "./mindmap-nodes"

const actions: MindMapActions = {
  openConversation: () => {},
  toggleCategory: () => {},
  showMore: () => {},
  moveConversation: () => {},
  fit: () => {},
  categoryRows: [],
  assignmentOf: () => null,
  now: Date.parse("2026-10-01T00:10:00Z"),
}

function conv(extra: Partial<DbConversationSummary> = {}) {
  const c: DbConversationSummary = {
    id: 7,
    folder_id: 1,
    title: "Demo",
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:08:00Z",
    pinned_at: null,
    ...extra,
  } as DbConversationSummary
  return c
}

function renderLeaf(conversation: DbConversationSummary) {
  const props = {
    data: { conversation },
  } as unknown as NodeProps<MindMapLeafNode>
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ReactFlowProvider>
        <TooltipProvider>
          <MindMapActionsProvider value={actions}>
            <MindMapLeaf {...props} />
          </MindMapActionsProvider>
        </TooltipProvider>
      </ReactFlowProvider>
    </NextIntlClientProvider>
  )
}

function setServer(pending: BackgroundPending | null) {
  const byConversation = new Map<number, BackgroundPending>()
  if (pending) byConversation.set(7, pending)
  useBackgroundPendingStore.setState({ bySession: new Map(), byConversation })
}

describe("MindMapLeaf background status", () => {
  beforeEach(() => {
    // 一轮结束、没看过：节点本来是未读。
    useConversationSeenStore.setState({
      baselineAt: 0,
      seen: {},
      markedUnread: {},
    })
    setServer(null)
  })

  it("keeps the unread dot when there is no background work", () => {
    const { container } = renderLeaf(conv())
    expect(container.querySelector("[data-jenny-unread-dot]")).not.toBeNull()
    expect(container.querySelector("[data-background-pending]")).toBeNull()
    expect(container.querySelector("[data-background-uncertain]")).toBeNull()
  })

  it("shows the hourglass and holds back unread while background work is out", () => {
    setServer({ count: 1, names: ["Sleep for 10 minutes in background"] })
    const { container } = renderLeaf(conv())
    expect(container.querySelector("[data-background-pending]")).not.toBeNull()
    expect(container.querySelector("[data-jenny-unread-dot]")).toBeNull()
    expect(
      container
        .querySelector("[data-mindmap-leaf-state]")
        ?.getAttribute("data-mindmap-leaf-state")
    ).toBe("running")
  })

  it("shows the server's「?」once the agent is gone", () => {
    setServer({
      count: 0,
      names: ["Sleep for 10 minutes in background"],
      state: "uncertain",
      reason: "agent_exited",
    })
    const { container } = renderLeaf(conv())
    expect(
      container
        .querySelector("[data-background-uncertain]")
        ?.getAttribute("data-background-uncertain")
    ).toBe("agent_exited")
    expect(container.querySelector("[data-jenny-unread-dot]")).toBeNull()
  })
})
