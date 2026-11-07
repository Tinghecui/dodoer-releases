import { describe, expect, it } from "vitest"
import type { ContentBlock, MessageTurn } from "@/lib/types"
import { findLatestGoalStatus, isGoalOpen } from "./conversation-goal-status"

function turn(id: string, blocks: ContentBlock[]): MessageTurn {
  return { id, role: "assistant", blocks, timestamp: "2026-11-04T00:00:00Z" }
}

function toolUse(
  id: string,
  toolName: string,
  input: Record<string, unknown> | null
): ContentBlock {
  return {
    type: "tool_use",
    tool_use_id: id,
    tool_name: toolName,
    input_preview: input ? JSON.stringify(input) : null,
  }
}

function toolResult(id: string, output: unknown): ContentBlock {
  return {
    type: "tool_result",
    tool_use_id: id,
    output_preview: JSON.stringify(output),
    is_error: false,
  }
}

describe("findLatestGoalStatus", () => {
  it("returns null when the transcript never set a goal", () => {
    expect(
      findLatestGoalStatus([
        turn("t1", [toolUse("a", "bash", { command: "ls" })]),
      ])
    ).toBeNull()
  })

  it("reads an armed goal off a bare create_goal (Claude Code live form)", () => {
    const goal = findLatestGoalStatus([
      turn("t1", [
        toolUse("g1", "mcp__codeg__create_goal", { objective: "ship it" }),
      ]),
    ])
    expect(goal).toEqual({ status: "active", objective: "ship it" })
    expect(isGoalOpen(goal)).toBe(true)
  })

  it("classifies a title-only Codex marker and prefers the result snapshot", () => {
    const goal = findLatestGoalStatus([
      turn("t1", [
        toolUse("g1", "Goal updated (active): 分析 README", null),
        toolResult("g1", {
          goal: { objective: "分析 README 文件", status: "budgetLimited" },
        }),
      ]),
    ])
    expect(goal).toEqual({
      status: "budgetlimited",
      objective: "分析 README 文件",
    })
    expect(isGoalOpen(goal)).toBe(false)
  })

  it("the newest marker wins: a completing update_goal closes the goal", () => {
    const turns = [
      turn("t1", [toolUse("g1", "create_goal", { objective: "ship it" })]),
      turn("t2", [toolUse("x", "edit", { path: "a.ts" })]),
      turn("t3", [
        toolUse("g2", "functions.update_goal", {
          status: "complete",
          objective: "ship it",
        }),
        toolResult("g2", {
          goal: { objective: "ship it", status: "complete" },
        }),
      ]),
    ]
    const goal = findLatestGoalStatus(turns)
    expect(goal).toEqual({ status: "complete", objective: "ship it" })
    expect(isGoalOpen(goal)).toBe(false)
  })

  it("a paused goal is still open; a cleared one (goal: null) is not", () => {
    const paused = findLatestGoalStatus([
      turn("t1", [
        toolUse("g1", "update_goal", {
          status: "Paused",
          objective: "ship it",
        }),
      ]),
    ])
    expect(paused).toEqual({ status: "paused", objective: "ship it" })
    expect(isGoalOpen(paused)).toBe(true)

    const cleared = findLatestGoalStatus([
      turn("t1", [toolUse("g1", "create_goal", { objective: "ship it" })]),
      turn("t2", [
        toolUse("g2", "update_goal", null),
        toolResult("g2", { goal: null }),
      ]),
    ])
    expect(cleared).toEqual({ status: "cleared", objective: null })
    expect(isGoalOpen(cleared)).toBe(false)
  })

  it("a bare update_goal with no status reads as closed", () => {
    expect(
      isGoalOpen(
        findLatestGoalStatus([turn("t1", [toolUse("g", "update_goal", null)])])
      )
    ).toBe(false)
  })
})
