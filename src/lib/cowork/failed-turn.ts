// 一轮以失败结束时，这一轮发出的消息还要不要放回排队区（#424）。
//
// jenny 的 SQ5 在轮次失败时把刚发出的消息放回队首、标成失败、带「重试」，
// 防的是消息没送到。可智能体已经开始回复（有文字、思考、计划或工具调用）
// 就说明消息送到了、可能已经执行过一部分，这时再重试就是重复执行
// （比如把 kill 再跑一遍）。这种不放回，只留对话里「本轮失败」那一行。

import type { LiveContentBlock } from "@/contexts/acp-connections-context"
import type { QueueFailureKind } from "@/hooks/use-message-queue"

/** 这一轮里智能体有没有产出过东西。turn_error 和用户中途插话不算。 */
export function turnHadAgentOutput(
  content: readonly LiveContentBlock[] | null | undefined
): boolean {
  return (content ?? []).some((block) => {
    switch (block.type) {
      case "text":
      case "thinking":
        return block.text.trim().length > 0
      case "plan":
      case "tool_call":
        return true
      default:
        return false
    }
  })
}

/**
 * 失败的一轮结束时，这一轮的消息放回排队区用的失败类型；不放回给 null。
 * 没失败、或者智能体已经有输出的，都不放回。要登录的保持 `auth`，
 * 其余标成 `turn_failed`（已经发出、本轮失败，重试会再发一次）。
 */
export function failedTurnRequeueKind(
  content: readonly LiveContentBlock[] | null | undefined,
  authFailed: boolean
): QueueFailureKind | null {
  const failed = (content ?? []).some((block) => block.type === "turn_error")
  if (!failed || turnHadAgentOutput(content)) return null
  return authFailed ? "auth" : "turn_failed"
}

/**
 * 回合进行中连接没了（智能体进程退出、连接出错），智能体什么都没回、也没有
 * `turn_error` 这一行时，消息放回排队区用的失败类型；不放回给 null（#650
 * 第 11 次返工，收件箱 #716：用户的消息任何情况下都不能消失）。
 * 智能体已经有输出的照 #424 不放回。
 */
export function lostTurnRequeueKind(
  content: readonly LiveContentBlock[] | null | undefined,
  connStatus: string | null | undefined
): QueueFailureKind | null {
  if (connStatus !== "disconnected" && connStatus !== "error") return null
  return turnHadAgentOutput(content) ? null : "turn_failed"
}
