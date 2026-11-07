"use client"

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"

/** What a sidebar count chip shows (jenny fork): past 99 it reads "99+", so
 *  hundreds of unread sessions cannot widen the header or a folder row. The
 *  exact number stays in the chip's tooltip and screen-reader label. */
export function formatBadgeCount(count: number): string {
  return count > 99 ? "99+" : String(count)
}

/** Folder / group header chip: number of UNREAD sessions (jenny fork).
 *  Blue, so it reads apart from the amber "running" chip beside it; renders
 *  nothing at zero. Same geometry as the running chip. */
export function UnreadCountBadge({
  count,
  global = false,
}: {
  count: number
  global?: boolean
}) {
  const t = useTranslations("Folder.sidebar")
  if (count <= 0) return null
  const label = t("unreadCountBadge", { count })
  return (
    <span
      title={label}
      data-jenny-unread-count={count}
      data-global-unread-count={global ? count : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "h-4 min-w-4 rounded-full px-[0.3125rem]",
        "text-[0.65625rem] font-semibold leading-none tabular-nums",
        "bg-[color-mix(in_srgb,var(--st-unread)_14%,transparent)] text-[var(--st-unread-ink)]"
      )}
    >
      <span aria-hidden>{formatBadgeCount(count)}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

export function RunningCountBadge({
  count,
  global = false,
}: {
  count: number
  global?: boolean
}) {
  const t = useTranslations("Folder.sidebar")
  if (count <= 0) return null
  const label = t("runningCountBadge", { count })
  return (
    <span
      title={label}
      data-global-running-count={global ? count : undefined}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "h-4 min-w-4 rounded-full px-[0.3125rem]",
        "text-[0.65625rem] font-semibold leading-none tabular-nums",
        "bg-[color-mix(in_srgb,var(--st-run)_18%,transparent)] text-[var(--st-run-ink)]"
      )}
    >
      <span aria-hidden>{formatBadgeCount(count)}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** Session row marker for an UNREAD session: a solid blue dot. */
export function UnreadDot() {
  const t = useTranslations("Folder.sidebar")
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      title={t("statusUnreadBadge")}
      data-jenny-unread-dot=""
    >
      <span
        aria-hidden
        className="h-2 w-2 rounded-full bg-[var(--st-unread)]"
      />
      <span className="sr-only">{t("statusUnreadBadge")}</span>
    </span>
  )
}
