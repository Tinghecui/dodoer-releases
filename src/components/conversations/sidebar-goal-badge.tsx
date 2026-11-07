"use client"

import { Goal } from "lucide-react"
import { useTranslations } from "next-intl"
import type { ConversationGoalStatus } from "@/lib/conversation-goal-status"
import { cn } from "@/lib/utils"

/**
 * The "this session is on a goal" mark of a sidebar row. The row's
 * `in_progress` colour only lasts a turn — the moment the agent answers,
 * the row settles to unread/blue even though its goal is still armed and it
 * will wake itself up again (a background monitor, a `/goal` resume). This
 * badge stays for as long as the goal does, in the running colour so the
 * row reads "still working" at a glance; a paused goal goes muted.
 */
export function SidebarGoalBadge({ goal }: { goal: ConversationGoalStatus }) {
  const t = useTranslations("Folder.sidebar")
  const paused = goal.status === "paused"
  const label = paused ? t("goalPausedBadge") : t("goalActiveBadge")
  const title = goal.objective ? `${label}: ${goal.objective}` : label
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      title={title}
      data-goal-status={goal.status}
    >
      <Goal
        className={cn(
          "h-3.5 w-3.5",
          paused ? "text-muted-foreground" : "text-[var(--st-run)]"
        )}
        aria-hidden
      />
      <span className="sr-only">{title}</span>
    </span>
  )
}
