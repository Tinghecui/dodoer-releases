// 一轮以失败结束时，这一轮发出的消息还要不要放回排队区（#424）。
//
// jenny 的 SQ5 在轮次失败时把刚发出的消息放回队首、标成失败、带「重试」，
// 防的是消息没送到。可智能体已经开始回复（有文字、思考、计划或工具调用）
// 就说明消息送到了、可能已经执行过一部分，这时再重试就是重复执行
// （比如把 kill 再跑一遍）。这种不放回，只留对话里「本轮失败」那一行。

import type { LiveContentBlock } from "@/contexts/acp-connections-context"
import type { QueueFailureKind, QueuedMessage } from "@/hooks/use-message-queue"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type {
  MessageTurn,
  PromptDraft,
  PromptInputBlock,
  SessionFailureRecord,
  TurnErrorKind,
} from "@/lib/types"

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

/**
 * 失败记录是哪一类失败（#1120）。只认 Rust `session_failure_ends_session` 认的
 * 那种：error 级、connection 类、建议开新会话——底下的 Claude CLI 被杀、崩了时，
 * claude-agent-acp 就这样收尾（「The connection to Claude was lost.」）。
 */
export function turnErrorKindOf(
  record: Pick<SessionFailureRecord, "category" | "severity" | "actions">
): TurnErrorKind | undefined {
  return record.severity === "error" &&
    record.category === "connection" &&
    (record.actions ?? []).includes("new_session")
    ? "connection_lost"
    : undefined
}

/** 这一条是不是「连接断了」的失败行（#1120）。 */
export function isLostConnectionLine(turn: MessageTurn): boolean {
  return (
    turn.role === "system" &&
    turn.blocks.some(
      (block) => block.type === "turn_error" && block.kind === "connection_lost"
    )
  )
}

/**
 * 对话最后是一行「连接断了」的失败时，「重试」要重发的那条用户消息（#1120）；
 * 不是这样结尾的给 null。失败行后面还有别的（已经接着发过、回过）就不算。
 */
export function lostConnectionRetryTurn(
  turns: readonly MessageTurn[]
): MessageTurn | null {
  const last = turns[turns.length - 1]
  if (!last || !isLostConnectionLine(last)) return null
  for (let i = turns.length - 2; i >= 0; i--) {
    if (turns[i].role === "user") return turns[i]
  }
  return null
}

/**
 * 从对话里的一条用户消息还原出要重发的内容：文字和图片（#1120）。刷新以后
 * 手上只有对话记录，没有当初发出去的原样。什么都没有的给 null。
 */
export function draftFromUserTurn(turn: MessageTurn): PromptDraft | null {
  const blocks: PromptInputBlock[] = []
  const texts: string[] = []
  for (const block of turn.blocks) {
    if (block.type === "text") {
      if (!block.text.trim()) continue
      blocks.push({ type: "text", text: block.text })
      texts.push(block.text)
    } else if (block.type === "image") {
      blocks.push({
        type: "image",
        data: block.data,
        mime_type: block.mime_type,
        uri: block.uri ?? null,
      })
    }
  }
  if (blocks.length === 0) return null
  return { blocks, displayText: texts.join("\n") }
}

/**
 * 失败那一轮当初发出去的原样（#1120 返工）：带附件的草稿、当时的模式，和它被
 * 放回排队区时的排队 id（智能体什么都没回、消息放回了排队区的那种；没放回给 null）。
 */
export interface FailedTurnSend {
  draft: PromptDraft
  modeId: string | null
  queueItemId: string | null
}

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

/**
 * 记着的原样是不是对话里这条用户消息（第 3 次返工，第 4 次返工收紧）。
 * 对话里那条可能把附件写成 `[名字](地址)` 夹在字中间，所以：当初打的每一段字
 * 都要在对话里那条的字里；把这些字和当初附件的写法（地址、名字）去掉以后，
 * 对话里那条不能还剩别的字（多出来的字、别的附件说明不是同一条）；当初带的
 * 图片也要在对话里那条里。只带附件的消息也就比得出来了。
 */
export function keptSendMatchesTurn(
  kept: FailedTurnSend,
  userTurn: MessageTurn
): boolean {
  let rest = normalizedText(
    userTurn.blocks
      .flatMap((block) => (block.type === "text" ? [block.text] : []))
      .join("\n")
  )
  const shownImages = userTurn.blocks.flatMap((block) =>
    block.type === "image" ? [block.data] : []
  )
  const mentions: string[] = []
  for (const block of kept.draft.blocks) {
    if (block.type === "text") {
      const piece = normalizedText(block.text)
      if (!piece) continue
      const at = rest.indexOf(piece)
      if (at < 0) return false
      rest = `${rest.slice(0, at)} ${rest.slice(at + piece.length)}`
    } else if (block.type === "image") {
      if (!shownImages.includes(block.data)) return false
    } else {
      mentions.push(block.uri)
      if (block.type === "resource_link" && block.name)
        mentions.push(block.name)
      const base = block.uri.split("/").pop()
      if (base) mentions.push(base)
    }
  }
  // 地址在前、长的在前，免得先去掉名字把地址拆碎。
  for (const mention of [...new Set(mentions)].sort(
    (a, b) => b.length - a.length
  )) {
    rest = rest.split(mention).join(" ")
  }
  // 剩下的只能是链接的括号、@ 这类写法和空白。
  return rest.replace(/[\s[\]()@<>]/g, "") === ""
}

/** 「重试」要做的事：重试排队区里已经放回去的那一条，或者把消息放进排队区。 */
export type LostTurnRetryPlan =
  | { kind: "queue"; itemId: string }
  | { kind: "enqueue"; draft: PromptDraft; modeId: string | null }

/**
 * 对话最后是「连接断了」的失败行时，「重试」该做什么；不该给按钮的给 null
 * （#1120 返工）。
 * - 这一轮的消息已经放回排队区（智能体什么都没回）：重试那一条，不再放一份；
 *   那一条已经在发了的不给。
 * - 否则把这一轮的消息放到排队区最前面（排队区里还有别的消息也给，它本来就
 *   排在那些前面，第 4 次返工）：记着当初的原样（带附件）就用原样，
 *   没记着的才从对话里还原文字和图片；什么都还原不出来的不给。
 */
export function lostTurnRetryPlan({
  turns,
  kept,
  queue,
  selectedModeId,
}: {
  turns: readonly MessageTurn[]
  kept: FailedTurnSend | null
  queue: readonly Pick<QueuedMessage, "id" | "failed">[]
  selectedModeId: string | null
}): LostTurnRetryPlan | null {
  const userTurn = lostConnectionRetryTurn(turns)
  if (!userTurn) return null
  // 记着的只按会话存，可能是本机上一轮的（另一台设备在同一会话里发了新的又
  // 失败了）：对不上这次失败的那条消息就不用它（第 3 次返工）。
  const own = kept && keptSendMatchesTurn(kept, userTurn) ? kept : null
  if (own?.queueItemId != null) {
    const item = queue.find((entry) => entry.id === own.queueItemId)
    if (item) {
      return item.failed === true ? { kind: "queue", itemId: item.id } : null
    }
  }
  if (own) return { kind: "enqueue", draft: own.draft, modeId: own.modeId }
  const draft = draftFromUserTurn(userTurn)
  return draft ? { kind: "enqueue", draft, modeId: selectedModeId } : null
}

// 刷新以后也要重发原样（带附件），所以失败那一轮发出去的存进 localStorage，
// 按会话存一份；下一轮不是失败收尾的、点过「重试」的就删掉。
const FAILED_TURN_PREFIX = "cowork:failed-turn-send:v1"
/** 太大的（贴了大图）不存，只留在内存里，刷新后退回从对话里还原。 */
const MAX_FAILED_TURN_CHARS = 512 * 1024

function failedTurnKey(conversationId: number): string {
  const remoteId = getActiveRemoteConnectionId()
  const scope = remoteId == null ? "local" : `remote-${remoteId}`
  return `${FAILED_TURN_PREFIX}:${scope}:${conversationId}`
}

function localStore(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

/** 存下（`rec` 为 null 时删掉）会话 `conversationId` 失败那一轮发出去的原样。 */
export function writeFailedTurnSend(
  conversationId: number,
  rec: FailedTurnSend | null
): void {
  const store = localStore()
  if (!store) return
  const key = failedTurnKey(conversationId)
  try {
    const raw = rec ? JSON.stringify(rec) : null
    if (raw == null || raw.length > MAX_FAILED_TURN_CHARS) {
      store.removeItem(key)
      return
    }
    store.setItem(key, raw)
  } catch {
    // 存不下（满了、不可用）：只留在内存里，同上。上一轮存着的旧记录也删掉，
    // 不然刷新后「重试」会重发上一轮的消息（第 2 次返工）。
    try {
      store.removeItem(key)
    } catch {
      // 删也删不了：没办法了，读的时候照旧。
    }
  }
}

/** 读回会话 `conversationId` 存着的失败那一轮；没有、读不懂的给 null。 */
export function readFailedTurnSend(
  conversationId: number
): FailedTurnSend | null {
  const store = localStore()
  if (!store) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(store.getItem(failedTurnKey(conversationId)) ?? "null")
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const { draft, modeId, queueItemId } = parsed as Record<string, unknown>
  if (!draft || typeof draft !== "object") return null
  const d = draft as Record<string, unknown>
  if (
    !Array.isArray(d.blocks) ||
    !d.blocks.every(
      (b) =>
        b != null &&
        typeof b === "object" &&
        typeof (b as { type?: unknown }).type === "string"
    ) ||
    typeof d.displayText !== "string"
  )
    return null
  if (modeId !== null && typeof modeId !== "string") return null
  if (queueItemId !== null && typeof queueItemId !== "string") return null
  return {
    draft: {
      blocks: d.blocks as PromptInputBlock[],
      displayText: d.displayText,
    },
    modeId,
    queueItemId,
  }
}
