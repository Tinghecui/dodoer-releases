"use client"

import { Hourglass, Loader2, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

/**
 * The trailing badge of a conversation row: a spinner while it runs, an
 * hourglass while its turn has ended but background work it launched (a
 * background shell, a monitor) is still out — the agent will wake up again —
 * a cross when it was cancelled, otherwise its relative time ("5m", "2d").
 * Shared by the sidebar rows and the mind map's conversation nodes, so both
 * read alike.
 */
export function ConversationActivityBadge({
  running,
  waiting,
  cancelled,
  timeLabel,
  timeClassName,
}: {
  running: boolean
  /** Outstanding background work after the turn ended (see
   *  `useBackgroundPending`); ignored while `running`. */
  waiting?: { count: number; names: string[] } | null
  cancelled: boolean
  timeLabel?: string
  /** The time label's weight and colour (the sidebar emphasises the
   *  selected row's). */
  timeClassName?: string
}) {
  const t = useTranslations("Folder.sidebar")
  if (running) {
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        title={t("statusRunningBadge")}
      >
        {/* The turn is on a span, not the icon: an SVG element's transform
            animates on the main thread, laying the page out every frame for
            as long as the conversation runs. */}
        <span className="inline-flex animate-spin" aria-hidden>
          <Loader2 className="h-3.5 w-3.5 text-[var(--st-run)]" />
        </span>
        <span className="sr-only">{t("statusRunningBadge")}</span>
      </span>
    )
  }
  if (waiting) {
    const label = t("statusBackgroundBadge", { count: waiting.count })
    const title =
      waiting.names.length > 0 ? `${label}: ${waiting.names.join(", ")}` : label
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        title={title}
        data-background-pending=""
      >
        <span className="inline-flex animate-pulse" aria-hidden>
          <Hourglass className="h-3.5 w-3.5 text-[var(--st-run)]" />
        </span>
        <span className="sr-only">{title}</span>
      </span>
    )
  }
  if (cancelled) {
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        title={t("statusCancelledBadge")}
      >
        <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />
        <span className="sr-only">{t("statusCancelledBadge")}</span>
      </span>
    )
  }
  if (!timeLabel) return null
  return (
    <span
      className={cn(
        "relative shrink-0 tabular-nums text-[0.71875rem]",
        timeClassName ?? "font-normal text-muted-foreground/70"
      )}
    >
      {timeLabel}
    </span>
  )
}
