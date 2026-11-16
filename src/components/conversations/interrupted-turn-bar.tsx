"use client"

import { CirclePause } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import type { DbConversationSummary } from "@/lib/types"

/**
 * 这一行是不是「被打断」的（#369）：上一轮没跑完，程序或服务器就关了、崩了、
 * 被杀了。服务器把这种行记成 `cancelled` 并写上 `interrupted_at`；用户自己
 * 点「停止」的只有 `cancelled`。下一次状态写入，服务器和本地都会清掉
 * `interrupted_at`。侧栏、思维导图、对话页都用这一个判断。
 */
export function isInterruptedTurn(
  summary: Pick<DbConversationSummary, "status" | "interrupted_at">
): boolean {
  return summary.status === "cancelled" && !!summary.interrupted_at
}

/**
 * 对话页输入框上方的提示条：上一轮被打断了，右边一个「继续」。只在用户点
 * 「继续」时调 `onContinue`（由对话页走普通发送），从不自动重发。
 * 没被打断时什么都不渲染。
 */
export function InterruptedTurnBar({
  interrupted,
  onContinue,
}: {
  interrupted: boolean
  onContinue: () => void
}) {
  const t = useTranslations("Folder.chat.interruptedTurn")
  if (!interrupted) return null
  return (
    <div
      role="status"
      data-testid="interrupted-turn"
      className="@container border-b border-border bg-muted/40 px-3 py-2 text-xs"
    >
      <div className="mx-auto flex w-full chat-content-w items-center gap-2">
        <CirclePause
          className="h-4 w-4 shrink-0 text-[var(--st-unread)]"
          aria-hidden
        />
        <span className="min-w-0 flex-1 leading-snug">{t("notice")}</span>
        <Button
          variant="outline"
          size="sm"
          className="h-7 shrink-0"
          data-testid="interrupted-turn-continue"
          onClick={onContinue}
        >
          {t("continue")}
        </Button>
      </div>
    </div>
  )
}
