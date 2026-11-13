"use client"

import {
  Hourglass,
  ListTodo,
  Loader2,
  MessageCircleQuestionMark,
  ShieldAlert,
  XCircle,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import type { AwaitingUserKind } from "@/stores/awaiting-user-store"
import { cn } from "@/lib/utils"

/** The mark and wording per thing the agent waits on the user for — the same
 *  icons the prompts themselves carry in the conversation. */
const AWAITING: Record<
  AwaitingUserKind,
  {
    icon: LucideIcon
    label:
      | "statusAwaitingQuestionBadge"
      | "statusAwaitingPermissionBadge"
      | "statusAwaitingPlanBadge"
  }
> = {
  question: {
    icon: MessageCircleQuestionMark,
    label: "statusAwaitingQuestionBadge",
  },
  permission: { icon: ShieldAlert, label: "statusAwaitingPermissionBadge" },
  plan: { icon: ListTodo, label: "statusAwaitingPlanBadge" },
}

/**
 * The trailing badge of a conversation row: a filled mark while the agent is
 * parked on the user (a question to answer, a permission or a plan to
 * approve) — its turn is still running then, but it is the user's move — a
 * spinner while it runs, an
 * hourglass while its turn has ended but background work it launched (a
 * background shell, a monitor) is still out — the agent will wake up again —
 * a red cross when the turn did not finish, otherwise its relative time
 * ("5m", "2d"). Shared by the sidebar rows and the mind map's conversation
 * nodes, so both read alike.
 *
 * `cancelled` covers more than a user's Stop: a turn the agent refused or
 * could not run (not signed in, rejected) is stored as cancelled too, so the
 * cross says "this turn did not finish" rather than "cancelled". Such a row
 * is unread as well; the unread dot then rides on the cross (`unread`) —
 * the caller drops its own dot, whose wording ("finished") would contradict
 * the cross (#102).
 */
export function ConversationActivityBadge({
  awaiting,
  running,
  waiting,
  cancelled,
  unread = false,
  timeLabel,
  timeClassName,
}: {
  /** What the agent waits on the user for (see `useAwaitingUser`); outranks
   *  `running`, which stays true the whole time it waits. */
  awaiting?: AwaitingUserKind | null
  running: boolean
  /** Outstanding background work after the turn ended (see
   *  `useBackgroundPending`); ignored while `running`. */
  waiting?: { count: number; names: string[] } | null
  cancelled: boolean
  /** Unread, shown on the cancelled cross only (see above); the other marks
   *  leave unread to the caller. */
  unread?: boolean
  timeLabel?: string
  /** The time label's weight and colour (the sidebar emphasises the
   *  selected row's). */
  timeClassName?: string
}) {
  const t = useTranslations("Folder.sidebar")
  if (awaiting) {
    const { icon: Icon, label } = AWAITING[awaiting]
    const title = t(label)
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        title={title}
        data-awaiting-user={awaiting}
      >
        {/* Filled, unlike the outline spinner and hourglass it replaces, so
            "needs you" reads apart from "working" at a glance; black on the
            running dot's yellow holds its contrast in both themes. */}
        <span
          className="inline-flex h-[1.125rem] w-[1.125rem] animate-pulse items-center justify-center rounded-full bg-[var(--st-run-dot)] text-black"
          aria-hidden
        >
          <Icon className="h-3 w-3" strokeWidth={2.25} />
        </span>
        <span className="sr-only">{title}</span>
      </span>
    )
  }
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
    const title = t(
      unread ? "statusCancelledUnreadBadge" : "statusCancelledBadge"
    )
    return (
      <span
        className="relative inline-flex shrink-0 items-center justify-center"
        title={title}
        data-turn-unfinished=""
        data-unread={unread ? "" : undefined}
      >
        <XCircle className="h-3.5 w-3.5 text-destructive" aria-hidden />
        {unread && (
          // The unread dot, shrunk onto the cross's top-right corner; the
          // sidebar's ring colour cuts it out of the cross beneath.
          <span
            aria-hidden
            className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-[var(--st-unread)] ring-1 ring-sidebar"
          />
        )}
        <span className="sr-only">{title}</span>
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
