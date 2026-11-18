"use client"

import { useTranslations } from "next-intl"
import type { ConversationStatus, DbConversationSummary } from "@/lib/types"
import { STATUS_ORDER } from "@/lib/types"
import { useIsCanceledTaskConversation } from "@/stores/canceled-task-store"
import { isInterruptedTurn } from "./interrupted-turn-bar"

/**
 * 会话状态写成哪一句话（#652）。`cancelled` 不只是用户点了停止：智能体断开、
 * 拒绝、跑不了的回合也记成 `cancelled`，所以照侧栏的说法：被打断的写「被打断」，
 * 其他的写「本轮未完成」；只有用户取消了的工作任务会话才写「已取消」。
 * 别的状态照旧用 `Folder.statusLabels`。
 */
export type ConversationStatusLabelKey =
  | { scope: "statusLabels"; key: ConversationStatus }
  | {
      scope: "sidebar"
      key: "statusInterruptedBadge" | "statusCancelledBadge"
    }

export function conversationStatusLabelKey({
  status,
  interrupted,
  taskCanceled,
}: {
  status: ConversationStatus
  interrupted: boolean
  taskCanceled: boolean
}): ConversationStatusLabelKey {
  if (status !== "cancelled") return { scope: "statusLabels", key: status }
  if (interrupted) return { scope: "sidebar", key: "statusInterruptedBadge" }
  if (taskCanceled) return { scope: "statusLabels", key: "cancelled" }
  return { scope: "sidebar", key: "statusCancelledBadge" }
}

function isKnownStatus(value: string): value is ConversationStatus {
  return (STATUS_ORDER as string[]).includes(value)
}

/** 一个会话的状态文字；不认识的状态原样返回。 */
export function useConversationStatusLabel(
  summary: Pick<DbConversationSummary, "id" | "status" | "interrupted_at">
): string {
  const tStatus = useTranslations("Folder.statusLabels")
  const tSidebar = useTranslations("Folder.sidebar")
  const taskCanceled = useIsCanceledTaskConversation(summary.id)
  if (!isKnownStatus(summary.status)) return summary.status
  const label = conversationStatusLabelKey({
    status: summary.status,
    interrupted: isInterruptedTurn(summary),
    taskCanceled,
  })
  return label.scope === "sidebar" ? tSidebar(label.key) : tStatus(label.key)
}
