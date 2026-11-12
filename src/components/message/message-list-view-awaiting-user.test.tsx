/**
 * Cowork (AI QA #98): while the agent of the conversation on screen waits on
 * the user — a permission request, a question, a plan to approve — the live
 * capsule above the composer says so instead of "streaming".
 *
 * Renders the real `MessageListView` against the runtime store and the
 * awaiting-user store (the sidebar's "needs your answer" source), with the
 * virtual list stubbed out: only the capsule is looked at. Same harness as
 * `message-list-view-settle.test.tsx`.
 */
import { act, cleanup, render } from "@testing-library/react"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import {
  publishAwaitingUser,
  useAwaitingUserStore,
} from "@/stores/awaiting-user-store"
import {
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"

const { stableT } = vi.hoisted(() => ({
  // Translations answer with their key, so the capsule reads `streaming` or
  // `statusAwaitingPermissionBadge`.
  stableT: (key: string) => key,
}))

vi.mock("next-intl", () => ({
  useTranslations: () => stableT,
  useLocale: () => "en",
}))
vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(() => new Promise(() => {})),
  getFolderConversationTurns: vi.fn(),
  getFolderConversationOutline: vi.fn(() => new Promise(() => {})),
  readFileBase64: vi.fn(),
  readWorkspaceFileBase64: vi.fn(),
}))
vi.mock("@/components/message/virtualized-message-thread", () => ({
  VirtualizedMessageThread: () => null,
}))
vi.mock("@/components/ai-elements/message-thread", () => ({
  MessageThread: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
  MessageThreadScrollButton: () => null,
}))
vi.mock("@/components/message/conversation-message-thread", () => ({
  ConversationMessageThread: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("use-stick-to-bottom", () => ({
  useStickToBottomContext: () => ({ scrollToBottom: () => {} }),
}))
vi.mock("@/components/chat/agent-plan-overlay", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/components/chat/agent-plan-overlay")
  >()),
  AgentPlanOverlay: () => null,
}))
vi.mock("@/components/chat/sub-agent-overlay", () => ({
  SubAgentOverlay: () => null,
}))
vi.mock("@/components/message/session-viewer-host", () => ({
  SessionViewerHost: ({ children }: { children: ReactNode }) => <>{children}</>,
}))
vi.mock("@/components/message/selection-action-bubble", () => ({
  SelectionActionBubble: () => null,
}))
vi.mock("@/components/message/use-transcript-known-invocations", () => ({
  useTranscriptKnownInvocations: () => null,
}))
vi.mock("@/hooks/use-model-labels", () => ({
  useModelLabels: () => (id: string | null | undefined) => id ?? null,
}))
vi.mock("@/hooks/use-appearance", () => ({
  useChatAnimationsEnabled: () => false,
}))
vi.mock("@/lib/browser/use-page-handoff-name", () => ({
  usePageHandoffName: () => "page",
}))
vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

import { MessageListView } from "./message-list-view"

const CID = 41
const SESSION_ID = "ext-41"
const at = (n: number) => new Date(1_700_000_000_000 + n * 1000).toISOString()

const TURNS: MessageTurn[] = [
  {
    id: "u1",
    role: "user",
    blocks: [{ type: "text", text: "Write notes.txt" }],
    timestamp: at(1),
  },
]

function detail(): DbConversationDetail {
  return {
    summary: {
      id: CID,
      folder_id: 1,
      agent_type: "claude_code",
      title: "t",
      title_locked: false,
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: SESSION_ID,
      message_count: TURNS.length,
      child_count: 0,
      created_at: at(0),
      updated_at: at(1),
      pinned_at: null,
    },
    turns: TURNS,
    session_stats: null,
  }
}

const LIVE: LiveMessage = {
  id: "live-7",
  role: "assistant",
  content: [{ type: "text", text: "I'll write the file now." }],
  startedAt: Date.parse(at(2)),
}

function seed(): void {
  const session: ConversationRuntimeSession = {
    conversationId: CID,
    externalId: SESSION_ID,
    dbConversationId: CID,
    detail: detail(),
    detailLoading: false,
    detailError: null,
    acpLoadError: null,
    localTurns: [],
    backgroundTurns: [],
    pendingBackgroundSettlements: [],
    pendingCancelledTurnReports: null,
    optimisticTurns: [],
    liveMessage: null,
    syncState: "idle",
    activeTurnToken: null,
    lastTurnOwned: false,
    liveOwnsActiveTurn: false,
    delegationKickoffText: null,
    sessionStats: null,
    historyAssistantBaseline: null,
    batchBoundaryIndex: null,
    batchBoundaryPrefixHash: null,
    loadingOlderTurns: false,
    olderTurnsPrependEpoch: 0,
    pendingOutOfTurnContent: false,
    pendingCleanup: false,
  }
  useConversationRuntimeStore.setState({
    byConversationId: new Map([[CID, session]]),
  })
}

/** A connection on `sessionId` with a permission request up. */
const askPermission = (sessionId: string) =>
  publishAwaitingUser([
    {
      connectionId: "c",
      sessionId,
      parentConnectionId: null,
      pendingPermission: { request_id: "r", tool_call: null, options: [] },
      pendingAskQuestion: null,
      pendingPlanApproval: null,
    },
  ])

function renderLiveTranscript() {
  seed()
  act(() => {
    useConversationRuntimeStore
      .getState()
      .actions.setLiveMessage(CID, LIVE, true)
  })
  const { container } = render(
    <MessageListView
      conversationId={CID}
      imageRoot={null}
      agentType="claude_code"
      availableCommands={[]}
      connStatus="prompting"
    />
  )
  return () =>
    container.querySelector("[data-live-turn-stats]")?.textContent ?? null
}

beforeEach(() => {
  resetConversationRuntimeStore()
  useAwaitingUserStore.setState({ bySession: new Map() })
})

afterEach(() => {
  cleanup()
  resetConversationRuntimeStore()
  useAwaitingUserStore.setState({ bySession: new Map() })
})

describe("MessageListView: the live capsule while the agent waits on the user", () => {
  it("names the wait while a permission request is up, and streams again once answered", () => {
    const capsule = renderLiveTranscript()
    expect(capsule()).toContain("streaming")

    act(() => askPermission(SESSION_ID))
    expect(capsule()).toContain("statusAwaitingPermissionBadge")
    expect(capsule()).not.toContain("streaming")

    act(() => publishAwaitingUser([]))
    expect(capsule()).toContain("streaming")
    expect(capsule()).not.toContain("statusAwaitingPermissionBadge")
  })

  it("is not touched by another session's request", () => {
    const capsule = renderLiveTranscript()
    act(() => askPermission("some-other-session"))
    expect(capsule()).toContain("streaming")
    expect(capsule()).not.toContain("statusAwaitingPermissionBadge")
  })
})
