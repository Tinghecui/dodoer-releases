"use client"

/**
 * jenny fork: the aux panel's Jenny registration when a Loop conversation is
 * on screen. A session's registration says how one turn ended; a Loop's says
 * where the whole run stands: its phase, its exit conditions and how close its
 * numbers are, plus the registration of the agent at work now.
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { CheckCircle2, Circle } from "lucide-react"

import { ProgressDetailBody } from "@/components/progress/progress-detail"
import { TimeChart } from "@/components/progress/time-chart"
import { ScrollArea } from "@/components/ui/scroll-area"
import { getJennyProgress } from "@/lib/api"
import {
  formatStageMinutes,
  liveLoop,
  liveStage,
  LOOP_PHASES,
  phaseCounts,
  phaseTone,
  RUN_STATE_DOT,
  stageResultKind,
} from "@/lib/jenny-loop"
import { metricSeries, valueRange } from "@/lib/jenny-progress"
import type { JennyLoopEntry, JennyProgressDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import { useLoopConversationStore } from "@/stores/loop-conversation-store"

const POLL_MS = 20_000
const RESULT_INK: Record<string, string> = {
  passed: "text-[var(--st-ok)]",
  failed: "text-[var(--st-fail)]",
  running: "text-[var(--st-run-ink)]",
}

function formatWhen(iso: string | null): string | null {
  if (!iso) return null
  const t = new Date(iso)
  return Number.isNaN(t.getTime())
    ? null
    : t.toLocaleString(undefined, {
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-[0.6875rem] text-muted-foreground">
        {label}
      </dt>
      <dd className="truncate text-sm font-semibold tabular-nums">{value}</dd>
    </div>
  )
}

function MetricBlock({
  metric,
}: {
  metric: JennyLoopEntry["metrics"][number]
}) {
  const shaped = { ...metric, value: metric.value ?? 0 }
  const points = metricSeries(shaped)
  const { min, max, range } = valueRange(shaped)
  const times = points.map((p) => p.t)
  const start = Math.min(...times)
  const end = Math.max(...times)
  return (
    <li data-loop-metric={metric.id}>
      <div className="flex items-baseline gap-2 text-xs">
        <span className="min-w-0 flex-1 truncate">{metric.label}</span>
        <span className="shrink-0 font-mono tabular-nums">
          {metric.value ?? "—"}
          {metric.target !== null ? ` / ${metric.target}` : ""} {metric.unit}
        </span>
      </div>
      {end > start ? (
        <div className="mt-1">
          <TimeChart
            label={metric.label}
            domain={[start, end]}
            yRange={range}
            yLabels={[...new Set([min, max])].map((v) => ({
              v,
              text: String(Number(v.toFixed(2))),
            }))}
            points={points}
            color="var(--chart-1)"
            pointTitle={(p) =>
              `${new Date(p.t).toLocaleString()} — ${p.v} ${metric.unit}`
            }
            target={
              metric.target === null
                ? undefined
                : { v: metric.target, color: "var(--muted-foreground)" }
            }
            plotHeight={56}
          />
        </div>
      ) : null}
    </li>
  )
}

/** The Jenny record of the agent at work: stage agents register like any other
 *  session. */
function CurrentAgentRegistration({ sessionId }: { sessionId: string }) {
  const t = useTranslations("JennyLoop")
  const [detail, setDetail] = useState<JennyProgressDetail | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    let dropped = false
    const read = () =>
      getJennyProgress(sessionId)
        .then((record) => {
          if (dropped) return
          setDetail(record)
          setNow(Date.now())
        })
        .catch(() => {
          if (!dropped) setDetail(null)
        })
    void read()
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") void read()
    }, POLL_MS)
    return () => {
      dropped = true
      window.clearInterval(timer)
    }
  }, [sessionId])
  if (!detail) return null
  return (
    <section
      className="border-t border-border/60 pt-3"
      data-loop-agent-record={sessionId}
    >
      <h3 className="px-4 pb-1 text-xs font-medium">
        {t("agentRegistration")}
      </h3>
      <ProgressDetailBody detail={detail} now={now} />
    </section>
  )
}

export function LoopProgressPanel({ folderId }: { folderId: number }) {
  const t = useTranslations("JennyLoop")
  const entry = useLoopConversationStore((s) => s.byFolder[folderId])
  const load = useLoopConversationStore((s) => s.load)
  const selected = useLoopConversationStore((s) => s.selectedLoop[folderId])
  const selectLoop = useLoopConversationStore((s) => s.selectLoop)
  const focusStage = useLoopConversationStore((s) => s.focusStage)
  const detail = entry?.detail ?? null

  useEffect(() => {
    // The view polls while it shows; this covers a panel opened before it.
    if (!detail) void load(folderId)
  }, [detail, folderId, load])

  const loop = useMemo(
    () =>
      detail?.loops.find((l) => l.id === selected) ?? liveLoop(detail) ?? null,
    [detail, selected]
  )
  const counts = useMemo(() => (loop ? phaseCounts(loop) : {}), [loop])
  const stageNow = useMemo(() => liveStage(loop), [loop])
  const stagesNewestFirst = useMemo(
    () => (loop ? [...loop.stages].reverse() : []),
    [loop]
  )

  if (!loop) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground">
        {entry?.error ?? t("empty")}
      </div>
    )
  }

  const running = loop.runState === "running"
  const agentAtWork =
    running && stageNow
      ? stageNow.sessions.find((s) => s.role !== "subagent")
      : undefined
  const met = loop.exitConditions.filter((c) => c.done).length
  const runLabel = {
    running: t("runRunning"),
    paused: t("runPaused"),
    stopped: t("runStopped"),
    blocked: t("runBlocked"),
    completed: t("runCompleted"),
  }[loop.runState]

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="min-w-0 pb-3 pt-2" data-loop-panel={loop.id}>
        <div className="space-y-2 px-4 pb-3 pt-1">
          {(detail?.loops.length ?? 0) > 1 ? (
            <select
              value={loop.id}
              onChange={(e) => selectLoop(folderId, e.target.value)}
              aria-label={t("chooseLoop")}
              className="w-full rounded-md border border-border bg-background px-2 py-1 text-xs"
              data-loop-select=""
            >
              {[...(detail?.loops ?? [])].reverse().map((l) => (
                <option key={l.id} value={l.id}>
                  {l.title === l.id ? l.id : `${l.id}｜${l.title}`}
                </option>
              ))}
            </select>
          ) : null}
          <div className="flex items-center gap-1.5 text-xs">
            <span
              className={cn(
                "size-2 rounded-full",
                RUN_STATE_DOT[loop.runState]
              )}
            />
            <span className="font-medium">{runLabel}</span>
            {loop.model ? (
              <span className="truncate text-muted-foreground">
                · {loop.model}
              </span>
            ) : null}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {loop.title}
          </p>
          {loop.humanIntervention ? (
            <p
              className="rounded-lg bg-[color-mix(in_oklab,var(--st-run)_14%,transparent)] px-2.5 py-2 text-xs leading-relaxed"
              data-loop-need=""
            >
              <span className="font-semibold text-[var(--st-run-ink)]">
                {t("needsYou")}
              </span>
              {" — "}
              {loop.humanIntervention}
            </p>
          ) : null}
          {loop.requirementChallenge ? (
            <p className="text-xs leading-relaxed" data-loop-challenge="">
              <span className="font-medium text-primary">
                {t("challenged")}
              </span>
              {" — "}
              {loop.requirementChallenge}
            </p>
          ) : null}
        </div>

        {/* Where the run stands: one chip per phase, the live one marked. */}
        <section className="border-t border-border/60 px-4 py-3">
          <ol className="flex flex-wrap items-center gap-1" data-loop-flow="">
            {LOOP_PHASES.filter(
              (p) => p !== "prepare" || counts[p] || loop.phase === p
            )
              .filter((p) => p !== "deploy" || counts[p] || loop.phase === p)
              .map((phase) => {
                const here = running && loop.phase === phase
                return (
                  <li
                    key={phase}
                    className={cn(
                      "rounded-md px-1.5 py-0.5 text-[0.6875rem]",
                      here
                        ? cn(
                            "font-semibold ring-1 ring-current",
                            phaseTone(phase)
                          )
                        : "bg-muted/50 text-muted-foreground"
                    )}
                    aria-current={here ? "step" : undefined}
                  >
                    {t(`phase.${phase}`)} {counts[phase] ?? 0}
                  </li>
                )
              })}
          </ol>
          <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat
              label={t("statCycle")}
              value={loop.cycle !== null ? String(loop.cycle) : "—"}
            />
            <Stat
              label={t("statTests")}
              value={loop.testRound !== null ? String(loop.testRound) : "—"}
            />
            <Stat
              label={t("statExit")}
              value={`${met}/${loop.exitConditions.length}`}
            />
            <Stat
              label={t("statEta")}
              value={
                running ? (formatWhen(loop.estimatedCompletionAt) ?? "—") : "—"
              }
            />
          </dl>
        </section>

        {loop.exitConditions.length > 0 ? (
          <section className="border-t border-border/60 px-4 py-3">
            <h3 className="mb-1.5 text-xs font-medium">
              {t("exitConditions")}
            </h3>
            <ul className="space-y-1.5" data-loop-exit-conditions="">
              {loop.exitConditions.map((c) => (
                <li
                  key={c.id}
                  className="flex items-start gap-1.5 text-xs leading-relaxed"
                  title={c.evidence.join("\n") || undefined}
                >
                  {c.done ? (
                    <CheckCircle2
                      className="mt-0.5 size-3.5 shrink-0 text-[var(--st-ok)]"
                      aria-label={t("conditionMet")}
                    />
                  ) : (
                    <Circle
                      className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                      aria-label={t("conditionOpen")}
                    />
                  )}
                  <span className="min-w-0 line-clamp-3">{c.label}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {loop.metrics.length > 0 ? (
          <section className="border-t border-border/60 px-4 py-3">
            <h3 className="mb-1.5 text-xs font-medium">{t("numbers")}</h3>
            <ul className="space-y-3">
              {loop.metrics.map((m) => (
                <MetricBlock key={m.id} metric={m} />
              ))}
            </ul>
          </section>
        ) : null}

        {agentAtWork ? (
          <CurrentAgentRegistration sessionId={agentAtWork.sessionId} />
        ) : null}

        {stagesNewestFirst.length > 0 ? (
          <section className="border-t border-border/60 px-4 py-3">
            <h3 className="mb-1.5 text-xs font-medium">{t("stages")}</h3>
            <ul className="space-y-0.5" data-loop-stage-list="">
              {stagesNewestFirst.map((stage) => {
                const kind = stageResultKind(stage)
                return (
                  <li key={stage.id}>
                    <button
                      type="button"
                      onClick={() => focusStage(folderId, loop.id, stage.id)}
                      className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs hover:bg-muted/50"
                    >
                      <span
                        className={cn(
                          "shrink-0 rounded px-1 text-[0.6875rem] font-medium",
                          phaseTone(stage.phase)
                        )}
                      >
                        {stage.id}
                      </span>
                      <span
                        className={cn(
                          "shrink-0 text-[0.6875rem]",
                          RESULT_INK[kind] ?? "text-muted-foreground"
                        )}
                      >
                        {t(`result.${kind}`)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-muted-foreground">
                        {stage.summary}
                      </span>
                      <span className="shrink-0 tabular-nums text-[0.6875rem] text-muted-foreground">
                        {formatStageMinutes(stage.durationMinutes)}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ) : null}
      </div>
    </ScrollArea>
  )
}
