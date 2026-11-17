import { describe, expect, it } from "vitest"

import type { LiveContentBlock } from "@/contexts/acp-connections-context"
import { failedTurnRequeueKind, turnHadAgentOutput } from "./failed-turn"

const turnError: LiveContentBlock = {
  type: "turn_error",
  message: "被终止 · SIGKILL",
  fromAgent: false,
}
const toolCall = {
  type: "tool_call",
  info: { tool_call_id: "t1", title: "Run sleep 300 in background" },
} as unknown as LiveContentBlock

describe("failedTurnRequeueKind", () => {
  it("不放回已经执行过工具调用的失败轮次", () => {
    expect(failedTurnRequeueKind([toolCall, turnError], false)).toBeNull()
  })

  it("不放回已经回过文字或思考的失败轮次", () => {
    expect(
      failedTurnRequeueKind([{ type: "text", text: "好的" }, turnError], false)
    ).toBeNull()
    expect(
      failedTurnRequeueKind(
        [{ type: "thinking", text: "想一想" }, turnError],
        false
      )
    ).toBeNull()
  })

  it("没有任何输出就失败的，放回并标成 turn_failed", () => {
    expect(failedTurnRequeueKind([turnError], false)).toBe("turn_failed")
    expect(
      failedTurnRequeueKind([{ type: "text", text: "  " }, turnError], false)
    ).toBe("turn_failed")
  })

  it("要登录的保持 auth", () => {
    expect(failedTurnRequeueKind([turnError], true)).toBe("auth")
  })

  it("没失败的不放回", () => {
    expect(failedTurnRequeueKind([toolCall], false)).toBeNull()
    expect(failedTurnRequeueKind([], false)).toBeNull()
    expect(failedTurnRequeueKind(null, false)).toBeNull()
  })
})

describe("turnHadAgentOutput", () => {
  it("用户中途插话和 turn_error 不算输出", () => {
    expect(
      turnHadAgentOutput([
        { type: "steering", id: "n1", text: "停一下", createdAt: "" },
        turnError,
      ])
    ).toBe(false)
  })
})
