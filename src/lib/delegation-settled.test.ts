import { describe, expect, it } from "vitest"

import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { settledNoticeCandidates } from "@/lib/delegation-settled"

/**
 * Which of a finished reply's delegations it never saw end (cowork-codeg#173):
 * the ones the "sub-task finished after this reply" notice may speak for.
 */

const ack = (taskId: string) =>
  JSON.stringify({ task_id: taskId, status: "running" })

function delegateSource(
  id: string,
  output: string | null,
  extra: Partial<DelegationCardSource> = {}
): DelegationCardSource {
  return {
    parentToolUseId: id,
    input: null,
    output,
    errorText: null,
    state: "output-available",
    meta: null,
    ...extra,
  }
}

function check(
  id: string,
  taskId: string,
  output: string | null
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "mcp__codeg-mcp__get_delegation_status",
    input: JSON.stringify({ task_ids: [taskId] }),
    state: output == null ? "input-available" : "output-available",
    output,
  }
}

const running = (taskId: string) =>
  JSON.stringify({
    task_id: taskId,
    status: "running",
    message: "Running.\nAwaiting your decision: Edit docs/notes.md",
  })
const completed = (taskId: string) =>
  JSON.stringify({ task_id: taskId, status: "completed", text: "Done." })

describe("settledNoticeCandidates", () => {
  it("keeps a task the reply only ever saw running", () => {
    const source = delegateSource("pt-1", ack("t1"))
    const parts: AdaptedContentPart[] = [
      {
        type: "delegation-status-group",
        polls: [check("c1", "t1", running("t1"))],
      },
    ]
    expect(settledNoticeCandidates([source], parts)).toEqual([
      { source, taskId: "t1" },
    ])
    // Never checked at all, and checked by a bare status call: the same.
    expect(settledNoticeCandidates([source], [])).toHaveLength(1)
    expect(
      settledNoticeCandidates([source], [check("c1", "t1", running("t1"))])
    ).toHaveLength(1)
  })

  it("reads the task id off a content-only ack's text", () => {
    const source = delegateSource(
      "pt-1",
      "Delegated; the sub-agent is running in the background. " +
        "task_id=abcdef12-3456. Call get_delegation_status with this id."
    )
    expect(settledNoticeCandidates([source], [])).toEqual([
      { source, taskId: "abcdef12-3456" },
    ])
  })

  it("drops a task whose outcome the reply read", () => {
    const source = delegateSource("pt-1", ack("t1"))
    // A later check found it over — wherever in the reply it sits.
    const parts: AdaptedContentPart[] = [
      check("c1", "t1", running("t1")),
      { type: "text", text: "Still waiting." },
      {
        type: "goal-run",
        items: [
          {
            type: "delegation-status-group",
            polls: [check("c2", "t1", completed("t1"))],
          },
        ],
      } as AdaptedContentPart,
    ]
    expect(settledNoticeCandidates([source], parts)).toEqual([])
    // A fast finish reports its outcome in the call itself.
    expect(
      settledNoticeCandidates([delegateSource("pt-2", completed("t2"))], [])
    ).toEqual([])
  })

  it("keeps out a refused call and one that names no task", () => {
    expect(
      settledNoticeCandidates(
        [
          delegateSource("pt-1", null, {
            errorText: "delegation disabled",
            state: "output-error",
          }),
          delegateSource("pt-2", null, { state: "input-available" }),
        ],
        []
      )
    ).toEqual([])
  })

  it("speaks for a task once, by its newest call", () => {
    const first = delegateSource("pt-1", ack("t1"))
    const resume = delegateSource("pt-2", ack("t1"), { taskIdHint: "t1" })
    const other = delegateSource("pt-3", ack("t3"))
    expect(settledNoticeCandidates([first, other, resume], [])).toEqual([
      { source: other, taskId: "t3" },
      { source: resume, taskId: "t1" },
    ])
  })
})
