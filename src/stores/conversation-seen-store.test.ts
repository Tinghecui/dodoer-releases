import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  countUnreadByGroup,
  ensureSeenHydrated,
  isConversationUnread,
  clearConversationUnreadMark,
  markConversationAccepted,
  markConversationSeen,
  markConversationUnread,
  pruneSeen,
  useConversationSeenStore,
  withoutUnreadChange,
} from "./conversation-seen-store"

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
}))

const T0 = Date.parse("2026-10-07T10:00:00Z")
const iso = (ms: number) => new Date(ms).toISOString()

function conv(
  id: number,
  status: string,
  updatedAt: number,
  extra: { parent_id?: number | null; folder_id?: number } = {}
) {
  return {
    id,
    status,
    updated_at: iso(updatedAt),
    parent_id: extra.parent_id ?? null,
    folder_id: extra.folder_id ?? 1,
  }
}

const snapshot = (seen: Record<string, number> = {}) => ({
  baselineAt: T0,
  seen,
  markedUnread: {},
})

describe("isConversationUnread", () => {
  it("marks a turn that ended after the baseline as unread", () => {
    expect(
      isConversationUnread(conv(1, "pending_review", T0 + 1), snapshot())
    ).toBe(true)
    expect(isConversationUnread(conv(1, "cancelled", T0 + 1), snapshot())).toBe(
      true
    )
  })

  it("does not flag sessions finished before unread tracking started", () => {
    expect(
      isConversationUnread(conv(1, "pending_review", T0 - 1), snapshot())
    ).toBe(false)
  })

  it("never flags running or completed sessions", () => {
    expect(
      isConversationUnread(conv(1, "in_progress", T0 + 5), snapshot())
    ).toBe(false)
    expect(isConversationUnread(conv(1, "completed", T0 + 5), snapshot())).toBe(
      false
    )
  })

  it("clears once accepted after the turn ended, and returns on a newer turn", () => {
    const seen = { "1": T0 + 10 }
    expect(
      isConversationUnread(conv(1, "pending_review", T0 + 5), snapshot(seen))
    ).toBe(false)
    expect(
      isConversationUnread(conv(1, "pending_review", T0 + 20), snapshot(seen))
    ).toBe(true)
  })

  it("ignores delegation sub-sessions", () => {
    expect(
      isConversationUnread(
        conv(2, "pending_review", T0 + 5, { parent_id: 1 }),
        snapshot()
      )
    ).toBe(false)
  })
})

describe("countUnreadByGroup", () => {
  it("counts unread per display group through the mapping", () => {
    const list = [
      conv(1, "pending_review", T0 + 1, { folder_id: 10 }),
      conv(2, "cancelled", T0 + 1, { folder_id: 11 }),
      conv(3, "in_progress", T0 + 1, { folder_id: 10 }),
      conv(4, "pending_review", T0 + 1, { folder_id: 12 }),
    ]
    const counts = countUnreadByGroup(list, snapshot(), (f) =>
      f === 11 ? 10 : f
    )
    expect(counts.get(10)).toBe(2)
    expect(counts.get(12)).toBe(1)
    expect(counts.has(11)).toBe(false)
  })
})

describe("persistence", () => {
  beforeEach(() => {
    localStorage.clear()
    useConversationSeenStore.setState({
      scope: null,
      baselineAt: 0,
      seen: {},
      markedUnread: {},
    })
  })

  it("creates a baseline once and reloads it", () => {
    ensureSeenHydrated()
    const first = useConversationSeenStore.getState().baselineAt
    expect(first).toBeGreaterThan(0)
    useConversationSeenStore.setState({ scope: null, baselineAt: 0 })
    ensureSeenHydrated()
    expect(useConversationSeenStore.getState().baselineAt).toBe(first)
  })

  it("stores seen marks so they survive a reload", () => {
    markConversationSeen(7, iso(Date.now() + 60_000))
    const stamped = useConversationSeenStore.getState().seen["7"]
    expect(stamped).toBeGreaterThan(Date.now())
    useConversationSeenStore.setState({ scope: null, seen: {} })
    ensureSeenHydrated()
    expect(useConversationSeenStore.getState().seen["7"]).toBe(stamped)
  })
})

describe("pruneSeen", () => {
  it("keeps the newest entries", () => {
    const pruned = pruneSeen({ a: 1, b: 3, c: 2 }, 2)
    expect(Object.keys(pruned).sort()).toEqual(["b", "c"])
  })
})

describe("hand-set unread marks", () => {
  beforeEach(() => {
    localStorage.clear()
    useConversationSeenStore.setState({
      scope: null,
      baselineAt: 0,
      seen: {},
      markedUnread: {},
    })
  })

  const state = () => useConversationSeenStore.getState()

  it("makes any root conversation unread, whatever its status", () => {
    const running = conv(5, "in_progress", Date.now())
    expect(isConversationUnread(running, state())).toBe(false)
    markConversationUnread(5)
    expect(isConversationUnread(running, state())).toBe(true)
  })

  it("ignores marks on sub-sessions", () => {
    markConversationUnread(6)
    expect(
      isConversationUnread(conv(6, "completed", 0, { parent_id: 1 }), state())
    ).toBe(false)
  })

  it("accepted clears the hand-set mark and the status-based unread", () => {
    ensureSeenHydrated()
    const ended = conv(7, "pending_review", Date.now() + 1_000)
    markConversationUnread(7)
    expect(isConversationUnread(ended, state())).toBe(true)
    markConversationAccepted(7, ended.updated_at)
    expect(isConversationUnread(ended, state())).toBe(false)
  })

  it("turns unread again when a turn ends after it was accepted", () => {
    ensureSeenHydrated()
    const first = conv(8, "pending_review", Date.now() + 1_000)
    markConversationAccepted(8, first.updated_at)
    expect(isConversationUnread(first, state())).toBe(false)
    const next = conv(8, "pending_review", Date.now() + 120_000)
    expect(isConversationUnread(next, state())).toBe(true)
  })

  it("clearing the mark alone does not stamp the conversation as seen", () => {
    markConversationUnread(9)
    clearConversationUnreadMark(9)
    expect(state().markedUnread["9"]).toBeUndefined()
    expect(state().seen["9"]).toBeUndefined()
  })

  it("stores marks so they survive a reload", () => {
    markConversationUnread(10)
    useConversationSeenStore.setState({ scope: null, markedUnread: {} })
    ensureSeenHydrated()
    expect(state().markedUnread["10"]).toBeGreaterThan(0)
  })

  it("counts hand-set marks in the folder unread badge", () => {
    markConversationUnread(11)
    const counts = countUnreadByGroup(
      [{ ...conv(11, "in_progress", Date.now()), folder_id: 4 }],
      state()
    )
    expect(counts.get(4)).toBe(1)
  })

  it("loads data written before marks existed", () => {
    localStorage.setItem(
      "jenny:conversation-seen:v1:local",
      JSON.stringify({ baselineAt: 5, seen: { "1": 9 } })
    )
    ensureSeenHydrated()
    expect(state().markedUnread).toEqual({})
    expect(state().seen).toEqual({ "1": 9 })
  })
})

describe("withoutUnreadChange", () => {
  beforeEach(() => {
    localStorage.clear()
    useConversationSeenStore.setState({
      scope: null,
      baselineAt: 0,
      seen: {},
      markedUnread: {},
    })
  })

  const state = () => useConversationSeenStore.getState()

  it("keeps an unread conversation unread after a user edit", async () => {
    ensureSeenHydrated()
    const ended = conv(20, "pending_review", Date.now() + 1_000)
    await withoutUnreadChange(ended, async () => {})
    expect(isConversationUnread(ended, state())).toBe(true)
  })

  it("keeps a read conversation read after a user edit", async () => {
    ensureSeenHydrated()
    const before = conv(21, "pending_review", Date.now() - 1_000)
    markConversationAccepted(21, before.updated_at)
    await withoutUnreadChange(before, async () => {})
    const after = conv(21, "pending_review", Date.now())
    expect(isConversationUnread(after, state())).toBe(false)
  })
})
