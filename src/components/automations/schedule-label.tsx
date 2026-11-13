"use client"

import { useMemo } from "react"
import { useLocale, useTranslations } from "next-intl"
import { describeCron } from "@/lib/cron-humanize"

const DOW_KEYS = [
  "dow0",
  "dow1",
  "dow2",
  "dow3",
  "dow4",
  "dow5",
  "dow6",
] as const

/**
 * Render a cron expression as a localized human-readable cadence
 * ("Weekdays at 9:00 AM"). Unrecognized expressions fall back to the raw cron
 * in a monospace span. Time-of-day is formatted in the active locale.
 */
export function ScheduleLabel({ cron }: { cron: string }) {
  const t = useTranslations("Automations")
  const locale = useLocale()
  const d = useMemo(() => describeCron(cron), [cron])

  const time = (hour: number, minute: number) =>
    new Date(2000, 0, 1, hour, minute).toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    })

  switch (d.kind) {
    case "everyMinutes":
      return <>{t("schedEveryMinutes", { n: d.n })}</>
    case "hourly":
      return <>{t("schedHourly")}</>
    case "daily":
      return <>{t("schedDaily", { time: time(d.hour, d.minute) })}</>
    case "weekdays":
      return <>{t("schedWeekdays", { time: time(d.hour, d.minute) })}</>
    case "weekly":
      return (
        <>
          {t("schedWeekly", {
            day: t(DOW_KEYS[d.dow]),
            time: time(d.hour, d.minute),
          })}
        </>
      )
    case "monthly":
      return (
        <>{t("schedMonthly", { day: d.dom, time: time(d.hour, d.minute) })}</>
      )
    case "raw":
      return <span className="font-mono">{d.cron}</span>
  }
}

/**
 * A schedule as a readable cadence with the cron underneath — for the detail
 * page and the builder preview, where the expression itself matters too. One
 * the humanizer can't describe reads "Custom schedule" rather than repeating
 * the cron twice with nothing readable (AI QA #163).
 */
export function ScheduleSummary({
  cron,
  className,
}: {
  cron: string
  className?: string
}) {
  const t = useTranslations("Automations")
  const custom = useMemo(() => describeCron(cron).kind === "raw", [cron])
  return (
    <span className={className}>
      {custom ? <span>{t("schedCustom")}</span> : <ScheduleLabel cron={cron} />}
      <span className="font-mono text-xs text-muted-foreground">{cron}</span>
    </span>
  )
}
