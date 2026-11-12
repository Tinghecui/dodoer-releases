"use client"

import { memo } from "react"
import {
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  type LucideIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { openUrl } from "@/lib/platform"
import {
  checksIndicator,
  prVisualState,
  type ChecksIndicator,
  type PrVisualState,
} from "@/lib/pr-status"
import type { ForgeProviderId, PrChecksSummary, PrHint } from "@/lib/types"
import { cn } from "@/lib/utils"
import { usePrStatus } from "@/stores/pr-status-store"
import { InfoItem } from "./session-details-content"

type StateLabelKey = "stateOpen" | "stateDraft" | "stateMerged" | "stateClosed"

/** Same icons and colours as the repository panel's rows
 *  (`forge/forge-issue-row.tsx`), so a pull request reads the same in both. */
const PR_STATE_GLYPH: Record<
  PrVisualState,
  { Icon: LucideIcon; className: string; labelKey: StateLabelKey }
> = {
  open: {
    Icon: GitPullRequest,
    className: "text-emerald-600",
    labelKey: "stateOpen",
  },
  draft: {
    Icon: GitPullRequestDraft,
    className: "text-muted-foreground",
    labelKey: "stateDraft",
  },
  merged: {
    Icon: GitMerge,
    className: "text-violet-500",
    labelKey: "stateMerged",
  },
  closed: {
    Icon: GitPullRequestClosed,
    className: "text-rose-600",
    labelKey: "stateClosed",
  },
}

const PROVIDER_NAME: Record<ForgeProviderId, string> = {
  github: "GitHub",
  gitlab: "GitLab",
  gitea: "Gitea",
  cnb: "CNB",
}

/** Where a pie slice of `fraction` ends on a circle of radius `r` around
 *  (6, 6), going clockwise from twelve o'clock. */
function piePath(fraction: number, r: number): string {
  const angle = fraction * 2 * Math.PI
  const x = 6 + r * Math.sin(angle)
  const y = 6 - r * Math.cos(angle)
  const largeArc = fraction > 0.5 ? 1 : 0
  return `M6 6 L6 ${6 - r} A${r} ${r} 0 ${largeArc} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`
}

/** The checks glyph: a ring that fills in quarters while CI runs, then a
 *  tick or a cross. Shape as well as colour tells the three apart. */
export function ChecksGlyph({
  indicator,
  className,
}: {
  indicator: ChecksIndicator
  className?: string
}) {
  const tone =
    indicator.kind === "passed"
      ? "text-emerald-600"
      : indicator.kind === "failed"
        ? "text-rose-600"
        : "text-amber-500"
  return (
    <svg
      viewBox="0 0 12 12"
      aria-hidden
      data-checks-glyph={indicator.kind}
      className={cn("h-3 w-3 shrink-0", tone, className)}
    >
      <circle
        cx="6"
        cy="6"
        r="5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      {indicator.kind === "running" &&
        (indicator.fraction >= 1 ? (
          <circle cx="6" cy="6" r="3" fill="currentColor" />
        ) : indicator.fraction > 0 ? (
          <path d={piePath(indicator.fraction, 3)} fill="currentColor" />
        ) : null)}
      {indicator.kind === "passed" && (
        <path
          d="M3.75 6.25 5.25 7.75 8.25 4.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}
      {indicator.kind === "failed" && (
        <path
          d="M4.25 4.25 7.75 7.75 M7.75 4.25 4.25 7.75"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.25"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

/** Checks only matter while the change can still land. */
function rowChecks(hint: PrHint): ChecksIndicator | null {
  return hint.state === "open" ? checksIndicator(hint.checks) : null
}

/**
 * The row's pull-request mark: state icon, number, and the checks glyph.
 * Display only — the row's right slot swaps to the quick actions on hover,
 * and the hover bubble (`SidebarPrDetails`) carries the link.
 *
 * Renders nothing unless the folder is a worktree whose branch has a pull
 * request; the poller only asks about worktree folders.
 */
export const SidebarPrIndicator = memo(function SidebarPrIndicator({
  folderId,
}: {
  folderId: number
}) {
  const t = useTranslations("Folder.prStatus")
  const status = usePrStatus(folderId)
  if (!status || status.kind !== "pr") return null
  const visual = prVisualState(status)
  const { Icon, className, labelKey } = PR_STATE_GLYPH[visual]
  const checks = rowChecks(status)
  const label = [
    t("rowLabel", { number: status.number, state: t(labelKey) }),
    checks ? checksLabel(t, checks, status.checks) : null,
  ]
    .filter(Boolean)
    .join(", ")
  return (
    <span
      className="mr-1.5 inline-flex shrink-0 items-center gap-1 text-[0.6875rem] text-muted-foreground/70"
      data-pr-indicator={visual}
    >
      <Icon className={cn("h-3 w-3 shrink-0", className)} aria-hidden />
      <span aria-hidden className="tabular-nums">
        #{status.number}
      </span>
      {checks && <ChecksGlyph indicator={checks} />}
      <span className="sr-only">{label}</span>
    </span>
  )
})

type PrT = ReturnType<typeof useTranslations<"Folder.prStatus">>

function checksLabel(
  t: PrT,
  indicator: ChecksIndicator,
  checks: PrChecksSummary
): string {
  switch (indicator.kind) {
    case "passed":
      return t("checksPassed")
    case "failed":
      return t("checksFailed", { count: checks.failure })
    case "running":
      return t("checksRunning", {
        done: checks.total - checks.pending,
        total: checks.total,
      })
  }
}

function checksBreakdown(t: PrT, checks: PrChecksSummary): string {
  const parts: string[] = []
  if (checks.success > 0)
    parts.push(t("checksSuccessCount", { count: checks.success }))
  if (checks.failure > 0)
    parts.push(t("checksFailureCount", { count: checks.failure }))
  if (checks.pending > 0)
    parts.push(t("checksPendingCount", { count: checks.pending }))
  if (checks.neutral > 0)
    parts.push(t("checksNeutralCount", { count: checks.neutral }))
  return parts.join(" · ")
}

/**
 * The hover bubble's pull-request field: a link to the pull request with its
 * state, review and checks — or, when there is no account to read the forge
 * with, how to get one. Nothing for a folder that is not a worktree.
 *
 * Request-free like the rest of the bubble: it reads what the poller already
 * stored.
 */
export function SidebarPrDetails({ folderId }: { folderId: number }) {
  const t = useTranslations("Folder.prStatus")
  const status = usePrStatus(folderId)
  if (!status || status.kind === "unavailable") return null

  if (status.kind === "no_account") {
    return (
      <InfoItem label={t("sectionLabel")}>
        <p className="text-xs text-muted-foreground" data-pr-hint="no-account">
          {status.provider === "github"
            ? t("noAccountGithub")
            : t("noAccountOther", {
                provider: PROVIDER_NAME[status.provider],
                host: status.host,
              })}
        </p>
      </InfoItem>
    )
  }

  if (status.kind === "no_pr") {
    return (
      <InfoItem label={t("sectionLabel")}>
        <span className="text-xs text-muted-foreground">{t("noPr")}</span>
      </InfoItem>
    )
  }

  const visual = prVisualState(status)
  const { Icon, className, labelKey } = PR_STATE_GLYPH[visual]
  const open = status.state === "open"
  const checks = open ? checksIndicator(status.checks) : null
  const breakdown = open ? checksBreakdown(t, status.checks) : ""
  return (
    <InfoItem label={t("sectionLabel")} valueClassName="space-y-1">
      <button
        type="button"
        disabled={!status.url}
        onClick={(event) => {
          event.stopPropagation()
          if (status.url) void openUrl(status.url)
        }}
        title={t("openInBrowser")}
        className="inline-flex max-w-full items-center gap-1.5 rounded-sm text-start text-xs hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:no-underline"
      >
        <Icon className={cn("h-3.5 w-3.5 shrink-0", className)} aria-hidden />
        <span className="font-medium tabular-nums">#{status.number}</span>
        <span className="text-muted-foreground">{t(labelKey)}</span>
        {open && status.review_decision === "approved" && (
          <span className="text-emerald-600">· {t("reviewApproved")}</span>
        )}
        {open && status.review_decision === "changes_requested" && (
          <span className="text-rose-600">· {t("reviewChangesRequested")}</span>
        )}
      </button>
      {open && checks && (
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ChecksGlyph indicator={checks} />
          <span>{breakdown}</span>
        </div>
      )}
      {open && !status.checks.available && (
        <p className="text-xs text-muted-foreground">
          {t("checksUnavailable")}
        </p>
      )}
      {open && status.mergeable === false && (
        <p className="text-xs text-rose-600">{t("conflicts")}</p>
      )}
    </InfoItem>
  )
}
