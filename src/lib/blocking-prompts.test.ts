import { describe, expect, it } from "vitest"

import {
  blockingPrompts,
  isPlanApprovalPermission,
} from "@/lib/blocking-prompts"

const PERMISSION = { request_id: "req-1", tool_call: {}, options: [] }
const QUESTION = {
  question_id: "q-1",
  questions: [
    {
      id: "q",
      question: "Which DB?",
      header: "DB",
      multi_select: false,
      options: [],
    },
  ],
  created_at: "2026-10-18T00:00:00Z",
}
const PLAN = {
  approval_id: "plan-1",
  tool_call_id: "tc-1",
  plan_markdown: "1. migrate",
  created_at: "2026-10-18T00:00:00Z",
}
const NONE = {
  pendingPermission: null,
  pendingAskQuestion: null,
  pendingPlanApproval: null,
}

describe("blockingPrompts", () => {
  it("is null for a connection waiting on nobody, or none at all", () => {
    expect(blockingPrompts(undefined)).toBeNull()
    expect(blockingPrompts(NONE)).toBeNull()
  })

  it("does not count a question set with no questions — it renders nothing", () => {
    expect(
      blockingPrompts({
        ...NONE,
        pendingAskQuestion: { ...QUESTION, questions: [] },
      })
    ).toBeNull()
  })

  it("names each decision by its own id, so only a new decision brings a new one", () => {
    const first = blockingPrompts({ ...NONE, pendingPermission: PERMISSION })
    expect(first?.permission).toBe(PERMISSION)
    expect(first?.ids).toEqual(["permission:req-1"])
    expect(
      blockingPrompts({
        ...NONE,
        pendingPermission: { ...PERMISSION, request_id: "req-2" },
      })?.ids
    ).toEqual(["permission:req-2"])

    const all = blockingPrompts({
      pendingPermission: PERMISSION,
      pendingAskQuestion: QUESTION,
      pendingPlanApproval: PLAN,
    })
    expect(all).toMatchObject({
      permission: PERMISSION,
      askQuestion: QUESTION,
      planApproval: PLAN,
    })
    expect(all?.ids).toEqual([
      "permission:req-1",
      "question:q-1",
      "plan:plan-1",
    ])
  })
})

describe("isPlanApprovalPermission", () => {
  const ask = (tool_call: unknown) => ({ tool_call })

  it("recognizes Claude Code's ExitPlanMode however the request names it", () => {
    // AIR request with the live call merged in: kind + `_meta.claudeCode`.
    expect(
      isPlanApprovalPermission(
        ask({
          toolCallId: "t1",
          title: "Approve Plan",
          kind: "switch_mode",
          rawInput: { plan: "1. edit README" },
          _meta: {
            permission: { title: "Ready to code?" },
            claudeCode: { toolName: "ExitPlanMode" },
          },
        })
      )
    ).toBe(true)
    // Bare AIR request, before the live call is merged: only the plan.
    expect(
      isPlanApprovalPermission(
        ask({ toolCallId: "t1", rawInput: { plan: "1. edit README" } })
      )
    ).toBe(true)
    // Non-AIR shape: the tool's own name.
    expect(
      isPlanApprovalPermission(ask({ name: "ExitPlanMode", rawInput: {} }))
    ).toBe(true)
    // Serialized as a JSON string.
    expect(
      isPlanApprovalPermission(
        ask(
          JSON.stringify({ kind: "switch_mode", raw_input: { plan: "do it" } })
        )
      )
    ).toBe(true)
  })

  it("recognizes codex's plan review gate by its marker", () => {
    expect(
      isPlanApprovalPermission(
        ask({
          title: "Implement this plan?",
          _meta: { codex: { kind: "plan_review", planItemId: "p1" } },
        })
      )
    ).toBe(true)
  })

  it("leaves ordinary permissions, and EnterPlanMode, as permissions", () => {
    expect(isPlanApprovalPermission(null)).toBe(false)
    expect(isPlanApprovalPermission(ask(null))).toBe(false)
    expect(isPlanApprovalPermission(ask({}))).toBe(false)
    expect(
      isPlanApprovalPermission(
        ask({
          title: "ls -la",
          kind: "execute",
          rawInput: { command: "ls -la" },
          _meta: { claudeCode: { toolName: "Bash" } },
        })
      )
    ).toBe(false)
    expect(
      isPlanApprovalPermission(
        ask({
          title: "Enter plan mode",
          kind: "switch_mode",
          rawInput: {},
          _meta: { claudeCode: { toolName: "EnterPlanMode" } },
        })
      )
    ).toBe(false)
    // A `plan` in the input of a tool that is not a plan-mode tool.
    expect(
      isPlanApprovalPermission(
        ask({ kind: "edit", rawInput: { plan: "x", file_path: "/a" } })
      )
    ).toBe(false)
  })
})
