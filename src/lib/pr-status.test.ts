import { describe, expect, it } from "vitest"
import {
  agentPrConversationIds,
  checksIndicator,
  prRepoFromUrl,
  prVisualState,
  samePrStatus,
  worktreeFolderIds,
} from "./pr-status"
import type { PrChecksSummary, PrHint } from "./types"

function checks(overrides: Partial<PrChecksSummary> = {}): PrChecksSummary {
  return {
    available: true,
    total: 0,
    success: 0,
    failure: 0,
    neutral: 0,
    pending: 0,
    ...overrides,
  }
}

function hint(overrides: Partial<PrHint> = {}): PrHint {
  return {
    provider: "github",
    number: 12,
    url: "https://github.com/acme/app/pull/12",
    state: "open",
    draft: false,
    branch: "feat",
    base_ref: "main",
    mergeable: null,
    merge_state: null,
    review_decision: null,
    checks: checks(),
    ...overrides,
  }
}

describe("checksIndicator", () => {
  it("draws nothing when the forge would not say or nothing is configured", () => {
    expect(checksIndicator(checks({ available: false, total: 3 }))).toBeNull()
    expect(checksIndicator(checks({ total: 0 }))).toBeNull()
  })

  it("fills the pie in quarters while checks run", () => {
    expect(checksIndicator(checks({ total: 4, pending: 4 }))).toEqual({
      kind: "running",
      fraction: 0,
    })
    expect(
      checksIndicator(checks({ total: 3, success: 2, pending: 1 }))
    ).toEqual({ kind: "running", fraction: 0.5 })
    expect(
      checksIndicator(checks({ total: 8, success: 7, pending: 1 }))
    ).toEqual({ kind: "running", fraction: 0.75 })
  })

  it("reads failed as soon as one check fails, even while others run", () => {
    expect(
      checksIndicator(checks({ total: 3, failure: 1, pending: 2 }))
    ).toEqual({ kind: "failed" })
  })

  it("reads passed once nothing is pending and nothing failed", () => {
    expect(
      checksIndicator(checks({ total: 3, success: 2, neutral: 1 }))
    ).toEqual({ kind: "passed" })
  })
})

describe("prVisualState", () => {
  it("separates draft from open and keeps merged/closed", () => {
    expect(prVisualState(hint())).toBe("open")
    expect(prVisualState(hint({ draft: true }))).toBe("draft")
    expect(prVisualState(hint({ state: "merged", draft: true }))).toBe("merged")
    expect(prVisualState(hint({ state: "closed" }))).toBe("closed")
  })
})

describe("prRepoFromUrl", () => {
  it("reads the repository out of each forge's pull request URL", () => {
    expect(prRepoFromUrl("https://github.com/acme/app/pull/42")).toBe(
      "acme/app"
    )
    expect(
      prRepoFromUrl("https://git.corp.com/team/sub/app/-/merge_requests/7")
    ).toBe("team/sub/app")
    expect(prRepoFromUrl("https://gitea.example.com/acme/app/pulls/3")).toBe(
      "acme/app"
    )
  })

  it("gives up on anything that isn't a pull request URL", () => {
    expect(prRepoFromUrl("")).toBeNull()
    expect(prRepoFromUrl("not a url")).toBeNull()
    expect(prRepoFromUrl("https://github.com/pull/42")).toBeNull()
    expect(prRepoFromUrl("https://github.com/acme/app")).toBeNull()
  })
})

describe("worktreeFolderIds", () => {
  it("lists worktree folders holding a conversation, once, ascending", () => {
    const folders = [
      { id: 1, parent_id: null },
      { id: 5, parent_id: 1 },
      { id: 3, parent_id: 1 },
      { id: 9, parent_id: 1 },
    ]
    const conversations = [
      { folder_id: 5 },
      { folder_id: 1 },
      { folder_id: 3 },
      { folder_id: 5 },
    ]
    expect(worktreeFolderIds(folders, conversations)).toEqual([3, 5])
  })

  it("is empty without worktrees", () => {
    expect(
      worktreeFolderIds([{ id: 1, parent_id: null }], [{ folder_id: 1 }])
    ).toEqual([])
  })
})

describe("agentPrConversationIds", () => {
  const conversation = (
    id: number,
    overrides: Partial<{
      folder_id: number
      agent_type: string
      external_id: string | null
      updated_at: string
      parent_id: number | null
    }> = {}
  ) => ({
    id,
    folder_id: 1,
    agent_type: "claude_code",
    external_id: `s-${id}`,
    updated_at: `2026-11-14T10:00:${String(id).padStart(2, "0")}Z`,
    parent_id: null,
    ...overrides,
  })
  const folders = [
    { id: 1, parent_id: null },
    { id: 2, parent_id: 1 },
  ]

  it("lists top-level Claude conversations outside codeg worktrees", () => {
    expect(
      agentPrConversationIds(folders, [
        conversation(4),
        conversation(3, { folder_id: 2 }),
        conversation(2, { agent_type: "codex" }),
        conversation(5, { external_id: null }),
        conversation(6, { parent_id: 4 }),
        conversation(1),
      ])
    ).toEqual([1, 4])
  })

  it("keeps the most recently updated up to the cap", () => {
    const many = Array.from({ length: 70 }, (_, i) => conversation(i + 1))
    const ids = agentPrConversationIds(folders, many)
    expect(ids).toHaveLength(64)
    expect(ids[0]).toBe(7)
    expect(ids[63]).toBe(70)
  })
})

describe("samePrStatus", () => {
  it("compares by value", () => {
    expect(
      samePrStatus({ kind: "pr", ...hint() }, { kind: "pr", ...hint() })
    ).toBe(true)
    expect(
      samePrStatus(
        { kind: "pr", ...hint() },
        { kind: "pr", ...hint({ number: 13 }) }
      )
    ).toBe(false)
  })
})
