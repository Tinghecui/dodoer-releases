"use client"

/**
 * jenny fork: one Jenny progress record — the body of the conversation's
 * "Jenny progress" tab. It shows only what Jenny registers (its
 * `docs/progress-protocol.md`): how the latest turn ended, what only the user
 * can do while the agent works on the rest, and a long task's key numbers over
 * time. The first number is the main chart, the others small charts below it.
 */

import { useTranslations } from "next-intl"
import { formatRelative } from "@/components/conversations/sidebar-conversation-grouping"
import {
  metricSeries,
  recordState,
  timeDomain,
  valueRange,
  type JennyRecordState,
} from "@/lib/jenny-progress"
import type { JennyProgressDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import { formatChartTime, TimeChart } from "./time-chart"

/** Status dot per state — the window's fixed status colours. */
const STATE_DOT: Record<JennyRecordState, string> = {
  open: "bg-[var(--st-run)]",
  blocked: "bg-[var(--st-fail)]",
  failed: "bg-[var(--st-fail)]",
  completed: "bg-[var(--st-ok)]",
  unregistered: "bg-muted-foreground/40",
}

const STATE_INK: Record<JennyRecordState, string> = {
  open: "text-[var(--st-run-ink)]",
  blocked: "text-[var(--st-fail-ink)]",
  failed: "text-[var(--st-fail-ink)]",
  completed: "text-[var(--st-ok-ink)]",
  unregistered: "text-muted-foreground",
}

const STATE_KEYS = {
  open: "stateOpen",
  blocked: "stateBlocked",
  failed: "stateFailed",
  completed: "stateCompleted",
  unregistered: "stateUnregistered",
} as const satisfies Record<JennyRecordState, string>

/** The theme's own contrast colour: a status colour here would read as a status. */
const LINE = "var(--primary)"
const MAIN_PLOT_H = 150

type Metric = JennyProgressDetail["metrics"][number]

/** Below 1 the leading digits are the number: 0.0042 must not read as 0. */
function formatNumber(v: number): string {
  return String(Number(Math.abs(v) < 1 ? v.toPrecision(2) : v.toFixed(2)))
}

function formatAxisNumber(v: number): string {
  if (Math.abs(v) < 1) return formatNumber(v)
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(v)
}

function MetricChart({
  metric,
  domain,
  plotHeight,
}: {
  metric: Metric
  domain: [number, number]
  plotHeight?: number
}) {
  const points = metricSeries(metric)
  if (points.length === 0) return null
  const { min, max, range } = valueRange(metric)
  return (
    <TimeChart
      label={metric.label}
      domain={domain}
      yRange={range}
      yLabels={[...new Set([min, max])].map((v) => ({
        v,
        text: formatAxisNumber(v),
      }))}
      points={points}
      color={LINE}
      pointTitle={(p) =>
        `${formatChartTime(p.t, domain[1] - domain[0])} — ${formatNumber(p.v)} ${metric.unit}`
      }
      target={
        metric.target === null
          ? undefined
          : { v: metric.target, color: "var(--muted-foreground)" }
      }
      plotHeight={plotHeight}
    />
  )
}

export function ProgressDetailBody({
  detail,
  now,
}: {
  detail: JennyProgressDetail
  now: number
}) {
  const t = useTranslations("JennyProgress")
  const state = recordState(detail)
  const domain = timeDomain(detail, now)
  const [main, ...others] = detail.metrics
  const mainLast = main?.history[main.history.length - 1]

  return (
    <>
      <div className="px-4 pb-3 pt-1">
        <div className="flex items-center gap-1.5">
          <span className={cn("size-2 rounded-full", STATE_DOT[state])} />
          <span className={cn("text-xs font-medium", STATE_INK[state])}>
            {t(STATE_KEYS[state])}
          </span>
          <span className="text-xs text-muted-foreground">
            · {formatRelative(detail.updatedAt, now)}
          </span>
        </div>
        {detail.humanSummary ? (
          <p
            className="mt-2 rounded-lg bg-[color-mix(in_oklab,var(--st-run)_14%,transparent)] px-2.5 py-2 text-xs leading-relaxed"
            data-jenny-need=""
          >
            <span className="font-semibold text-[var(--st-run-ink)]">
              {t("flagNeedsHuman")}
            </span>
            {" — "}
            {detail.humanSummary}
          </p>
        ) : null}
        {detail.challengeSummary ? (
          <p className="mt-2 text-xs leading-relaxed">
            <span className="font-medium text-primary">
              {t("flagChallenged")}
            </span>
            {" — "}
            {detail.challengeSummary}
          </p>
        ) : null}
      </div>

      {main ? (
        <section
          className="border-t border-border/60 px-4 py-3"
          data-jenny-main-chart={main.id}
        >
          <div className="flex items-baseline gap-2 text-xs text-muted-foreground">
            <h3 className="min-w-0 flex-1 truncate">{main.label}</h3>
            {mainLast ? (
              <span
                className="shrink-0"
                title={new Date(mainLast.at).toLocaleString()}
              >
                {formatRelative(mainLast.at, now)}
              </span>
            ) : null}
          </div>
          <p className="mb-2 mt-0.5 flex items-baseline gap-1.5">
            <span className="text-2xl font-semibold tabular-nums">
              {formatNumber(main.value)}
            </span>
            <span className="text-xs text-muted-foreground">
              {main.target === null
                ? main.unit
                : t("ofTarget", {
                    target: formatNumber(main.target),
                    unit: main.unit,
                  })}
            </span>
          </p>
          {domain ? (
            <MetricChart
              metric={main}
              domain={domain}
              plotHeight={MAIN_PLOT_H}
            />
          ) : null}
        </section>
      ) : (
        <p className="border-t border-border/60 px-4 py-3 text-xs leading-relaxed text-muted-foreground">
          {t("noNumbers")}
        </p>
      )}

      {others.length > 0 ? (
        <ul className="space-y-3 border-t border-border/60 px-4 py-3">
          {others.map((m) => (
            <li key={m.id} data-jenny-metric={m.id}>
              <div className="flex items-baseline gap-2 text-xs">
                <span className="min-w-0 flex-1 truncate">{m.label}</span>
                <span className="shrink-0 font-mono tabular-nums">
                  {formatNumber(m.value)}{" "}
                  {m.target === null
                    ? m.unit
                    : t("ofTarget", {
                        target: formatNumber(m.target),
                        unit: m.unit,
                      })}
                </span>
              </div>
              {domain ? <MetricChart metric={m} domain={domain} /> : null}
            </li>
          ))}
        </ul>
      ) : null}

      {domain && detail.metrics.some((m) => m.target !== null) ? (
        <p className="px-4 text-[0.6875rem] text-muted-foreground">
          {t("targetLine")}
        </p>
      ) : null}
    </>
  )
}
