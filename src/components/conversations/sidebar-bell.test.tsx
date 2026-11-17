import { act, cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it } from "vitest"

import { SidebarBell } from "./sidebar-bell"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import { useConversationSeenStore } from "@/stores/conversation-seen-store"
import {
  replaceServerBackgroundPending,
  useBackgroundPendingStore,
} from "@/stores/background-pending-store"
import { useAwaitingUserStore } from "@/stores/awaiting-user-store"
import type { DbConversationSummary } from "@/lib/types"
import enMessages from "@/i18n/messages/en.json"

function conv(id: number): DbConversationSummary {
  const at = new Date(Date.now() + 1_000).toISOString()
  return {
    id,
    folder_id: 0,
    title: `conv-${id}`,
    title_locked: false,
    agent_type: "claude_code",
    status: "pending_review",
    kind: "chat",
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

function renderBell() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SidebarBell pressed={false} onClick={() => {}} />
    </NextIntlClientProvider>
  )
}

const running = (container: HTMLElement) =>
  container
    .querySelector("[data-global-running-count]")
    ?.getAttribute("data-global-running-count") ?? null
const unread = (container: HTMLElement) =>
  container
    .querySelector("[data-global-unread-count]")
    ?.getAttribute("data-global-unread-count") ?? null

// Cowork fork (#386): a conversation still waiting on background work counts
// as running, not as unread — the same as its row, which holds back the
// unread dot. One marked「?」by the server is not running (#435), but is not
// unread either.
describe("SidebarBell with background work", () => {
  beforeEach(() => {
    localStorage.clear()
    resetAppWorkspaceStore()
    useConversationSeenStore.setState({
      scope: null,
      baselineAt: 0,
      seen: {},
      markedUnread: {},
    })
    useBackgroundPendingStore.setState({
      bySession: new Map(),
      byConversation: new Map(),
    })
    useAwaitingUserStore.setState({
      bySession: new Map(),
      byTaskConversation: new Set(),
    })
    useAppWorkspaceStore.setState({ conversations: [conv(1), conv(2)] })
  })
  afterEach(() => cleanup())

  it("counts a waiting conversation as running, not unread, until it settles", () => {
    act(() =>
      replaceServerBackgroundPending([
        { conversation_id: 1, count: 1, names: ["Watch CI"] },
      ])
    )
    const { container } = renderBell()
    expect(running(container)).toBe("1")
    expect(unread(container)).toBe("1")

    act(() => replaceServerBackgroundPending([]))
    expect(running(container)).toBeNull()
    expect(unread(container)).toBe("2")
  })

  // #435: no live process moves a「?」conversation, so it is not running —
  // but it still holds its unread dot back.
  it("leaves a「?」conversation out of the running count", () => {
    act(() =>
      replaceServerBackgroundPending([
        {
          conversation_id: 2,
          count: 0,
          names: [],
          state: "uncertain",
          reason: "agent_exited",
          tasks: [],
        },
      ])
    )
    const { container } = renderBell()
    expect(running(container)).toBeNull()
    expect(unread(container)).toBe("1")
  })
})
