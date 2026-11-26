"use client"

// CoTeam 的会话留言（#1390）：侧栏里自己的会话有同事的新留言时，这一行时间
// 旁边的留言小图标和条数。只读 `summary`（轮询来的），不另发请求；打开这个
// 会话的留言栏、拉到留言后本地清零，图标跟着消失。手机端、团队功能不可用时
// 不画。原来的未读点不归它管。

import { memo } from "react"
import { MessageSquare } from "lucide-react"
import { useTranslations } from "next-intl"
import { useIsMobile } from "@/hooks/use-mobile"
import { teamSessionId } from "@/lib/cowork/team"
import { cn } from "@/lib/utils"
import {
  commentUnreadCount,
  useCoworkTeamStore,
} from "@/stores/cowork-team-store"

export const SessionCommentUnreadMark = memo(function SessionCommentUnreadMark({
  conversationId,
  className,
}: {
  conversationId: number | null | undefined
  className?: string
}) {
  const id = teamSessionId(conversationId)
  // 只订阅条数：别的会话的未读变了，这一行不重画。
  const count = useCoworkTeamStore((s) =>
    s.available && id ? commentUnreadCount(s.summary, "", id, true) : 0
  )
  const isMobile = useIsMobile()
  if (count <= 0 || isMobile) return null
  return <Mark count={count} className={className} />
})

function Mark({ count, className }: { count: number; className?: string }) {
  const t = useTranslations("CoworkTeam")
  const label = t("commentUnreadMark", { count })
  return (
    <span
      data-session-comment-unread=""
      role="img"
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex shrink-0 items-center gap-0.5 text-[0.6875rem] tabular-nums text-primary",
        className
      )}
    >
      <MessageSquare aria-hidden className="h-3 w-3" />
      {count}
    </span>
  )
}
