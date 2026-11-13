import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import type { QuestionSpec, WorkTask } from "@/lib/types"
import {
  awaitingUserOf,
  publishAwaitingUser,
  publishTaskAwaiting,
  useAwaitingUser,
  useAwaitingUserStore,
} from "./awaiting-user-store"

const question = (questions: number = 1) => ({
  question_id: "q1",
  questions: Array.from({ length: questions }, () => ({}) as QuestionSpec),
  created_at: "2026-11-12T00:00:00Z",
})
const permission = { request_id: "r1", tool_call: null, options: [] }
const plan = {
  approval_id: "a1",
  tool_call_id: "t1",
  plan_markdown: "",
  created_at: "2026-11-12T00:00:00Z",
}

type Conn =
  Parameters<typeof publishAwaitingUser>[0] extends Iterable<infer C>
    ? C
    : never

function conn(
  connectionId: string,
  sessionId: string | null,
  over: Partial<Conn> = {}
): Conn {
  return {
    connectionId,
    sessionId,
    parentConnectionId: null,
    pendingPermission: null,
    pendingAskQuestion: null,
    pendingPlanApproval: null,
    ...over,
  }
}

const sessions = () => useAwaitingUserStore.getState().bySession

beforeEach(() => {
  useAwaitingUserStore.setState({
    bySession: new Map(),
    byTaskConversation: new Set(),
  })
})

/** A task row, reduced to what `publishTaskAwaiting` reads. */
function task(
  id: number,
  status: WorkTask["status"],
  over: Partial<WorkTask> = {}
): WorkTask {
  return {
    id,
    status,
    conversation_id: id * 10,
    merge_awaiting_input: false,
    ...over,
  } as WorkTask
}
const parkedMerge = (id: number, over: Partial<WorkTask> = {}) =>
  task(id, "merging", { merge_awaiting_input: true, ...over })
const taskConversations = () =>
  useAwaitingUserStore.getState().byTaskConversation

describe("awaitingUserOf", () => {
  it("is null with no prompt, and for a question set that asks nothing", () => {
    expect(awaitingUserOf(conn("c", "s"))).toBeNull()
    expect(
      awaitingUserOf(conn("c", "s", { pendingAskQuestion: question(0) }))
    ).toBeNull()
  })

  it("names the prompt, a permission ahead of a question ahead of a plan", () => {
    expect(
      awaitingUserOf(conn("c", "s", { pendingAskQuestion: question() }))
    ).toBe("question")
    expect(awaitingUserOf(conn("c", "s", { pendingPlanApproval: plan }))).toBe(
      "plan"
    )
    expect(
      awaitingUserOf(
        conn("c", "s", {
          pendingPermission: permission,
          pendingAskQuestion: question(),
          pendingPlanApproval: plan,
        })
      )
    ).toBe("permission")
  })

  it("reads Claude Code's ExitPlanMode permission as a plan approval", () => {
    const exitPlan = {
      request_id: "r2",
      tool_call: {
        title: "Ready to code?",
        kind: "switch_mode",
        rawInput: { plan: "1. add a line to README" },
      },
      options: [],
    }
    expect(
      awaitingUserOf(conn("c", "s", { pendingPermission: exitPlan }))
    ).toBe("plan")
    const bash = {
      request_id: "r3",
      tool_call: {
        title: "ls",
        kind: "execute",
        rawInput: { command: "ls" },
      },
      options: [],
    }
    expect(awaitingUserOf(conn("c", "s", { pendingPermission: bash }))).toBe(
      "permission"
    )
  })
})

describe("publishAwaitingUser", () => {
  it("keys by session and skips sessionless and idle connections", () => {
    publishAwaitingUser([
      conn("c0", null, { pendingAskQuestion: question() }),
      conn("c1", "a", { pendingAskQuestion: question() }),
      conn("c2", "b"),
      conn("c3", "c", { pendingPermission: permission }),
    ])
    expect([...sessions()]).toEqual([
      ["a", "question"],
      ["c", "permission"],
    ])
  })

  it("marks every ancestor of a sub-agent that asks", () => {
    publishAwaitingUser([
      conn("root", "root-session"),
      conn("child", null, { parentConnectionId: "root" }),
      conn("grandchild", "gc-session", {
        parentConnectionId: "child",
        pendingAskQuestion: question(),
      }),
    ])
    expect([...sessions()].sort()).toEqual([
      ["gc-session", "question"],
      ["root-session", "question"],
    ])
  })

  it("survives a parent that is gone and a parent cycle", () => {
    publishAwaitingUser([
      conn("orphan", "o", {
        parentConnectionId: "missing",
        pendingPlanApproval: plan,
      }),
      conn("x", "x-session", {
        parentConnectionId: "y",
        pendingPermission: permission,
      }),
      conn("y", "y-session", { parentConnectionId: "x" }),
    ])
    expect([...sessions()].sort()).toEqual([
      ["o", "plan"],
      ["x-session", "permission"],
      ["y-session", "permission"],
    ])
  })

  it("keeps the prompt that stacks first when two land on one session", () => {
    publishAwaitingUser([
      conn("viewer", "a", { pendingPlanApproval: plan }),
      conn("owner", "a", { pendingAskQuestion: question() }),
    ])
    expect(sessions().get("a")).toBe("question")
  })

  it("leaves the map reference alone when nothing changed", () => {
    publishAwaitingUser([conn("c", "a", { pendingAskQuestion: question() })])
    const before = sessions()
    publishAwaitingUser([conn("c", "a", { pendingAskQuestion: question() })])
    expect(sessions()).toBe(before)
    publishAwaitingUser([conn("c", "a", { pendingPermission: permission })])
    expect(sessions().get("a")).toBe("permission")
    publishAwaitingUser([conn("c", "a")])
    expect(sessions().size).toBe(0)
  })
})

describe("useAwaitingUser", () => {
  it("follows the session behind an external id", () => {
    const { result } = renderHook(() => useAwaitingUser("a"))
    expect(result.current).toBeNull()
    act(() =>
      publishAwaitingUser([conn("c", "a", { pendingAskQuestion: question() })])
    )
    expect(result.current).toBe("question")
    act(() => publishAwaitingUser([conn("c", "a")]))
    expect(result.current).toBeNull()
  })

  it("is null for a conversation without an external id", () => {
    act(() =>
      publishAwaitingUser([conn("c", "a", { pendingAskQuestion: question() })])
    )
    const { result } = renderHook(() => useAwaitingUser(null))
    expect(result.current).toBeNull()
  })
})

// #167: a merge or a task run the task engine runs headless waits on the user
// before any connection here knows of it — the task list is the only source
// until then.
describe("publishTaskAwaiting", () => {
  it("collects the conversations of merges parked on the user", () => {
    publishTaskAwaiting([
      parkedMerge(1),
      // Landing, not waiting.
      task(2, "merging"),
      // The mark means nothing off `merging`.
      task(3, "review", { merge_awaiting_input: true }),
      // No session to answer in.
      parkedMerge(5, { conversation_id: null }),
    ])
    expect([...taskConversations()]).toEqual([10])
  })

  it("collects the runs parked at awaiting_input too, and only those", () => {
    publishTaskAwaiting([
      task(1, "awaiting_input"),
      // Working, or done with the turn: nothing to answer.
      task(2, "running"),
      task(3, "review"),
      task(4, "preparing"),
      // No session to answer in.
      task(5, "awaiting_input", { conversation_id: null }),
      parkedMerge(6),
    ])
    expect([...taskConversations()].sort((a, b) => a - b)).toEqual([10, 60])
  })

  it("drops a run once its prompt is answered (back to running)", () => {
    publishTaskAwaiting([task(1, "awaiting_input"), task(2, "awaiting_input")])
    publishTaskAwaiting([task(1, "running"), task(2, "awaiting_input")])
    expect([...taskConversations()]).toEqual([20])
    publishTaskAwaiting([task(1, "running"), task(2, "canceled")])
    expect(taskConversations().size).toBe(0)
  })

  it("drops a merge once it stops waiting, and keeps the set when nothing moved", () => {
    publishTaskAwaiting([parkedMerge(1), parkedMerge(2)])
    const before = taskConversations()
    publishTaskAwaiting([parkedMerge(2), parkedMerge(1)])
    expect(taskConversations()).toBe(before)
    publishTaskAwaiting([task(1, "merging"), parkedMerge(2)])
    expect([...taskConversations()]).toEqual([20])
    publishTaskAwaiting([])
    expect(taskConversations().size).toBe(0)
  })

  it("leaves the connection source alone", () => {
    publishAwaitingUser([conn("c", "a", { pendingAskQuestion: question() })])
    const live = sessions()
    publishTaskAwaiting([parkedMerge(1)])
    expect(sessions()).toBe(live)
  })
})

describe("useAwaitingUser with the task source", () => {
  it("reads a headless merge's conversation as awaiting a permission", () => {
    const { result } = renderHook(() => useAwaitingUser("sess-10", 10))
    expect(result.current).toBeNull()
    act(() => publishTaskAwaiting([parkedMerge(1)]))
    expect(result.current).toBe("permission")
    act(() => publishTaskAwaiting([task(1, "merging")]))
    expect(result.current).toBeNull()
  })

  it("marks the row before its session id is known", () => {
    act(() => publishTaskAwaiting([parkedMerge(1)]))
    const { result } = renderHook(() => useAwaitingUser(null, 10))
    expect(result.current).toBe("permission")
  })

  it("lets an attached connection name the real kind", () => {
    act(() => {
      publishTaskAwaiting([parkedMerge(1)])
      publishAwaitingUser([
        conn("c", "sess-10", { pendingAskQuestion: question() }),
      ])
    })
    const { result } = renderHook(() => useAwaitingUser("sess-10", 10))
    expect(result.current).toBe("question")
    // The connection's prompt was answered; the task list has not caught up.
    act(() => publishAwaitingUser([conn("c", "sess-10")]))
    expect(result.current).toBe("permission")
  })

  it("reads a run at awaiting_input as awaiting a permission, once per row", () => {
    const { result } = renderHook(() => useAwaitingUser("sess-10", 10))
    act(() => publishTaskAwaiting([task(1, "awaiting_input")]))
    expect(result.current).toBe("permission")
    // The connection attaches and names the kind: still the one row's mark.
    act(() =>
      publishAwaitingUser([
        conn("c", "sess-10", { pendingAskQuestion: question() }),
      ])
    )
    expect(result.current).toBe("question")
    act(() => {
      publishAwaitingUser([conn("c", "sess-10")])
      publishTaskAwaiting([task(1, "running")])
    })
    expect(result.current).toBeNull()
  })

  it("another conversation's merge does not touch this one", () => {
    act(() => publishTaskAwaiting([parkedMerge(2)]))
    const { result } = renderHook(() => useAwaitingUser("sess-10", 10))
    expect(result.current).toBeNull()
  })
})
