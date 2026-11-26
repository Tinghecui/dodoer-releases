/**
 * One status vocabulary for every activity step, after Zed's seven tool-call
 * states. Visually `pending` draws like `running` and `rejected` like `failed`
 * (with its own wording); `cancelled` is the "interrupted" state.
 */

import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import {
  isUnsettledToolCall,
  toolStatusCancelled,
} from "@/lib/tool-call-lifecycle"

export type StepStatus =
  | "pending"
  | "running"
  | "awaiting"
  | "succeeded"
  | "failed"
  | "rejected"
  | "cancelled"

/**
 * Claude Code's result for a call the user declined in the permission prompt,
 * and the generic "rejected/denied by user" wording other adapters use.
 */
const REJECTED_RE =
  /^The user doesn't want to proceed with this tool use|\b(?:rejected|denied|declined) by (?:the )?user\b/i
/** Claude Code's result for a call the user stopped mid-flight. */
const INTERRUPTED_RE = /^\[Request interrupted by user/i

export function isLiveStatus(status: StepStatus): boolean {
  return status === "pending" || status === "running"
}

export function isFailureStatus(status: StepStatus): boolean {
  return status === "failed" || status === "rejected"
}

/**
 * The status of one tool call. Liveness comes only from the adapter's own
 * lifecycle predicate (`isUnsettledToolCall`), so a call the adapter still
 * treats as in flight is never painted finished here — the same rule every
 * other surface follows.
 */
export function toolCallStatus(
  part: AdaptedToolCallPart,
  opts?: { awaiting?: boolean }
): StepStatus {
  if (opts?.awaiting) return "awaiting"
  const errorText = part.errorText?.trim()
  if (part.state === "output-error" || errorText) {
    const text = (errorText || part.output || "").trim()
    if (INTERRUPTED_RE.test(text)) return "cancelled"
    // 用户停止打断的调用，Claude 写的结果和拒绝是同一句话；解析器据中断记录
    // 把它标成 cancelled（#1555），以标记为准。
    if (toolStatusCancelled(part.toolStatus)) return "cancelled"
    if (REJECTED_RE.test(text)) return "rejected"
    return "failed"
  }
  if (isUnsettledToolCall(part)) {
    return part.state === "input-streaming" ? "pending" : "running"
  }
  // 一轮中途连接断了、刷新后补回失败时，没跑完的命令被标成中断（#1454）。
  if (toolStatusCancelled(part.toolStatus)) return "cancelled"
  return "succeeded"
}

/** Fold member statuses into one for a group row: anything live wins, then
 *  anything waiting on the user, then a failure. */
export function combineStatuses(statuses: StepStatus[]): StepStatus {
  if (statuses.some(isLiveStatus)) return "running"
  if (statuses.includes("awaiting")) return "awaiting"
  if (statuses.some(isFailureStatus)) return "failed"
  if (statuses.length > 0 && statuses.every((s) => s === "cancelled")) {
    return "cancelled"
  }
  return "succeeded"
}
