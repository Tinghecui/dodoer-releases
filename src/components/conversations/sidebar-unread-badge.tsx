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

/** Bell chip: number of sessions whose agent is parked on the user (a
 *  question, a permission, a plan approval). Solid, where the running and
 *  unread chips are tinted — these are the ones that need the user now.
 *  Renders nothing at zero. */
export function AwaitingCountBadge({ count }: { count: number }) {
  const t = useTranslations("Folder.sidebar")
  if (count <= 0) return null
  const label = t("awaitingCountBadge", { count })
  return (
    <span
      title={label}
      data-global-awaiting-count={count}
      className={cn(
        "inline-flex shrink-0 items-center justify-center",
        "h-4 min-w-4 rounded-full px-[0.3125rem]",
        "text-[0.65625rem] font-semibold leading-none tabular-nums",
        "bg-[var(--st-run-dot)] text-black"
      )}
    >
      <span aria-hidden>{formatBadgeCount(count)}</span>
      <span className="sr-only">{label}</span>
    </span>
  )
}

/** How the unread session's last turn ended, for the unread mark's wording:
 *  it finished; it did not (`cancelled` — a Stop, or a turn the agent refused
 *  or could not run, #102); or it belongs to a work task the user canceled
 *  (#178), which says so. */
export type UnreadEnding = "finished" | "unfinished" | "canceled"

/** The ending of a row whose status is `cancelled` or not, and whether it is
 *  a canceled work task's session — which wins whatever the status: a task
 *  canceled after its turn ended still reads "cancelled". */
export function unreadEndingOf(
  cancelled: boolean,
  taskCanceled: boolean
): UnreadEnding {
  if (taskCanceled) return "canceled"
  return cancelled ? "unfinished" : "finished"
}

/** Title and screen-reader text of the unread mark (the dot here, or the
 *  activity badge's cross it rides on). */
export const UNREAD_LABEL_KEYS = {
  finished: "statusUnreadBadge",
  unfinished: "statusCancelledUnreadBadge",
  canceled: "statusUnreadCancelledBadge",
} as const satisfies Record<UnreadEnding, string>

/** Session row marker for an UNREAD session: a solid blue dot, worded by how
 *  the turn ended (`ending`, "finished" by default). */
export function UnreadDot({ ending = "finished" }: { ending?: UnreadEnding }) {
  const t = useTranslations("Folder.sidebar")
  const label = t(UNREAD_LABEL_KEYS[ending])
  return (
    <span
      className="relative inline-flex shrink-0 items-center justify-center"
      title={label}
      data-jenny-unread-dot=""
    >
      <span
        aria-hidden
        className="h-2 w-2 rounded-full bg-[var(--st-unread)]"
      />
      <span className="sr-only">{label}</span>
    </span>
  )
}
