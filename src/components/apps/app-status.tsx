"use client"

import { useTranslations } from "next-intl"

import type { AppDisplayState } from "@/lib/workbench-apps"
import { cn } from "@/lib/utils"

/** Dot colour per state: green up, amber on its way or silent, red broken,
 *  grey down or not yet known. */
const DOT_CLASS: Record<AppDisplayState, string> = {
  running: "bg-emerald-500",
  starting: "bg-amber-500 animate-pulse",
  notAnswering: "bg-amber-500",
  exited: "bg-destructive",
  failed: "bg-destructive",
  stopped: "bg-muted-foreground/40",
  unknown: "bg-muted-foreground/25",
}

export function AppStatusDot({
  state,
  className,
}: {
  state: AppDisplayState
  className?: string
}) {
  const t = useTranslations("Apps.state")
  return (
    <span
      role="img"
      aria-label={t(state)}
      title={t(state)}
      data-app-state={state}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full",
        DOT_CLASS[state],
        className
      )}
    />
  )
}
