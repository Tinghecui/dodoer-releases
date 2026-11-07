import { type ReactElement } from "react"
import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { SidebarConversationCard } from "./sidebar-conversation-card"
import {
  useConversationRuntimeStore,
  type ConversationRuntimeSession,
} from "@/stores/conversation-runtime-store"
import type { DbConversationSummary, MessageTurn } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

function conv(id: number): DbConversationSummary {
  const at = "2026-11-04T10:00:00.000Z"
  return {
    id,
    folder_id: 1,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: at,
    updated_at: at,
    pinned_at: null,
  }
}

function goalTurn(
  toolName: string,
  input: Record<string, unknown>
): MessageTurn {
  return {
    id: `turn-${toolName}`,
    role: "assistant",
    timestamp: "2026-11-04T10:00:00.000Z",
    blocks: [
      {
        type: "tool_use",
        tool_use_id: `id-${toolName}`,
        tool_name: toolName,
        input_preview: JSON.stringify(input),
      },
    ],
  }
}

// Mirrors the store's internal `createEmptySession`; only `localTurns` and the
// draft→row binding matter here.
function session(
  conversationId: number,
  overrides: Partial<ConversationRuntimeSession>
): ConversationRuntimeSession {
  return {
    conversationId,
    externalId: null,
    dbConversationId: null,
    detail: null,
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
    ...overrides,
  }
}

function renderCard(c: DbConversationSummary): ReactElement {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarConversationCard
        conversation={c}
        isSelected={false}
        isOpenInTab={false}
        timeLabel="5m"
        onSelect={() => {}}
        onDoubleClick={() => {}}
        onRename={async () => {}}
        onDelete={async () => {}}
        onStatusChange={async () => {}}
      />
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  cleanup()
  useConversationRuntimeStore.setState({ byConversationId: new Map() })
})

describe("sidebar goal badge", () => {
  it("shows while the session's goal is armed, even after the turn ended", () => {
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [
          7,
          session(7, {
            localTurns: [
              goalTurn("create_goal", { objective: "merge PR #50" }),
            ],
          }),
        ],
      ]),
    })
    render(renderCard(conv(7)))
    const badge = screen.getByTitle("Goal in progress: merge PR #50")
    expect(badge.getAttribute("data-goal-status")).toBe("active")
  })

  it("goes away once the goal closes", () => {
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [
          7,
          session(7, {
            localTurns: [
              goalTurn("create_goal", { objective: "merge PR #50" }),
              goalTurn("update_goal", {
                status: "complete",
                objective: "merge PR #50",
              }),
            ],
          }),
        ],
      ]),
    })
    render(renderCard(conv(7)))
    expect(screen.queryByTitle(/^Goal /)).toBeNull()
  })

  it("finds a draft-keyed session through its bound row id", () => {
    useConversationRuntimeStore.setState({
      byConversationId: new Map([
        [
          -3,
          session(-3, {
            dbConversationId: 42,
            localTurns: [goalTurn("create_goal", { objective: "x" })],
          }),
        ],
      ]),
    })
    render(renderCard(conv(42)))
    expect(screen.getByTitle("Goal in progress: x")).toBeTruthy()
  })

  it("renders nothing for a row this client holds no session for", () => {
    render(renderCard(conv(99)))
    expect(screen.queryByTitle(/^Goal /)).toBeNull()
  })
})
