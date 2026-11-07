"use client"

import { Activity } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { StatusBarRight } from "@/components/layout/status-bar"
import { useAppUpdate } from "@/components/providers/update-provider"
import { useAlertContext } from "@/contexts/alert-context"
import { useTaskContext } from "@/contexts/task-context"
import { useCoworkText } from "@/lib/cowork/i18n"
import { cn } from "@/lib/utils"

/**
 * Cowork: the top-right capsule's one status button. The right half of the
 * status bar (update, tasks, computer use, MCP, alerts) used to sit
 * in the capsule itself, ~200px of mixed glyphs that made the corner hard to
 * read and pushed the tab strip beneath it aside. Now it lives in this
 * button's popover, and the button sums up what used to be on show:
 *
 * - alerts: a count badge in the worst alert's colour (red / amber);
 * - an update to act on (offered and not dismissed, or ready to restart): an
 *   accent dot, only while there are no alerts;
 * - a background task or update in flight: the icon turns into a spinner.
 *
 * MCP stays out of the summary: its glyph is deliberately toneless (see
 * StatusBarMcp), and the popover shows it.
 */
export function StatusIndicator({ className }: { className?: string }) {
  const t = useCoworkText()
  const { alerts } = useAlertContext()
  const { tasks } = useTaskContext()
  const update = useAppUpdate()

  const alertTone =
    alerts.length === 0
      ? null
      : alerts.some((a) => a.level === "error")
        ? "bg-red-500"
        : "bg-amber-500"

  let updateBusy = false
  let updateWaiting = false
  if (update) {
    const { state, isUpdating, restartCountdown, isRestarting } = update
    const restarting =
      restartCountdown !== null || state.status === "restarting" || isRestarting
    const ready = state.status === "ready_to_restart"
    updateBusy = restarting || (isUpdating && !ready)
    updateWaiting =
      ready ||
      (!!update.available &&
        !restarting &&
        !isUpdating &&
        update.available.version !== update.dismissedVersion)
  }
  const busy =
    updateBusy ||
    tasks.some((task) => task.status === "running" || task.status === "pending")

  const label = [
    t("statusItems"),
    alerts.length > 0 && t("statusAlerts", { count: String(alerts.length) }),
    updateWaiting && t("statusUpdate"),
    busy && t("statusBusy"),
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-status-indicator=""
          className={cn("relative", className)}
          title={label}
          aria-label={label}
        >
          {busy ? (
            <span
              data-status-busy=""
              className="size-3 animate-spin rounded-full border-[1.5px] border-current border-t-transparent"
            />
          ) : (
            <Activity className="h-[0.9375rem] w-[0.9375rem]" />
          )}
          {alertTone ? (
            <span
              data-status-alerts=""
              className={cn(
                "absolute top-0 right-0 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-[0.1875rem] text-[0.5625rem] leading-none font-semibold text-white tabular-nums",
                alertTone
              )}
            >
              {alerts.length > 99 ? "99+" : alerts.length}
            </span>
          ) : (
            updateWaiting && (
              <span
                data-status-update=""
                className="absolute top-1 right-1 size-1.5 rounded-full bg-primary"
              />
            )
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-2">
        <StatusBarRight className="justify-end" />
      </PopoverContent>
    </Popover>
  )
}
