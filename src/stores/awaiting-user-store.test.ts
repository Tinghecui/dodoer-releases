import { act, renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it } from "vitest"

import type { QuestionSpec } from "@/lib/types"
import {
  awaitingUserOf,
  publishAwaitingUser,
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
  useAwaitingUserStore.setState({ bySession: new Map() })
})

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
