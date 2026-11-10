import { describe, expect, it } from "vitest"
import {
  checksIndicator,
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
