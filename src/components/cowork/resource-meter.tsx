"use client"

import { useEffect, useState, type ReactNode } from "react"
import { TriangleAlert } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useCoworkText } from "@/lib/cowork/i18n"
import {
  HISTORY_MS,
  formatBytes,
  formatBytesOf,
  formatPercent,
  memoryHeadline,
  shouldAnnounceCritical,
  useResourceWatch,
  useSystemResources,
  type MemoryPressure,
  type ResourceSample,
} from "@/lib/cowork/resources"
import { notify } from "@/lib/notify"
import { isDesktop, isRemoteDesktopWindow } from "@/lib/platform"
import { cn } from "@/lib/utils"

/** A meter's state. Memory takes the server's verdict; disk and a cgroup
 *  limit are judged by how full they are. CPU is never "wrong": busy is what
 *  it is for. */
type Tone = MemoryPressure

// The fill carries the state; the track is a lighter step of the same colour,
// so the state reads across the whole bar.
const FILL: Record<Tone, string> = {
  normal: "bg-primary",
  warning: "bg-amber-500",
  critical: "bg-red-500",
}
const TRACK: Record<Tone, string> = {
  normal: "bg-primary/15",
  warning: "bg-amber-500/20",
  critical: "bg-red-500/20",
}
const ICON: Record<Tone, string> = {
  normal: "",
  warning: "text-amber-500",
  critical: "text-red-500",
}
const BADGE: Record<Tone, string> = {
  normal: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400",
  warning: "bg-yellow-500/10 text-yellow-700 dark:text-yellow-500",
  critical: "bg-red-500/10 text-red-600 dark:text-red-400",
}

/** A cgroup limit, by the same headroom the server judges memory by. */
function limitTone(usedRatio: number): Tone {
  return usedRatio > 0.93 ? "critical" : usedRatio > 0.85 ? "warning" : "normal"
}

/** A disk fills slowly and is noticed late: flag it well before it is full. */
function diskTone(usedRatio: number): Tone {
  return usedRatio > 0.97 ? "critical" : usedRatio > 0.9 ? "warning" : "normal"
}

function clamp(ratio: number): number {
  return Number.isFinite(ratio) ? Math.min(Math.max(ratio, 0), 1) : 0
}

/** The trigger's glyph: one small upright bar per figure (CPU, memory). */
function Bar({ ratio, className }: { ratio: number; className?: string }) {
  return (
    <span
      className={cn(
        "relative h-3 w-[0.1875rem] overflow-hidden rounded-[1px]",
        className
      )}
    >
      <span className="absolute inset-0 bg-current opacity-20" />
      <span
        className="absolute inset-x-0 bottom-0 bg-current"
        // Never empty: an idle machine still shows that the bar is there.
        style={{ height: `${Math.max(clamp(ratio) * 100, 8)}%` }}
      />
    </span>
  )
}

function Meter({ ratio, tone }: { ratio: number; tone: Tone }) {
  return (
    <div className={cn("h-1.5 overflow-hidden rounded-full", TRACK[tone])}>
      <div
        className={cn(
          "h-full rounded-full transition-[width] duration-500",
          FILL[tone]
        )}
        style={{ width: `${clamp(ratio) * 100}%` }}
      />
    </div>
  )
}

/** The last few minutes of one figure, 0–100, beside its current value. */
function Trend({
  history,
  pick,
}: {
  history: ResourceSample[]
  pick: (sample: ResourceSample) => number | null
}) {
  const points = history.flatMap((sample) => {
    const value = pick(sample)
    return value === null ? [] : [{ at: sample.at, value }]
  })
  if (points.length < 2) return null
  // By time, not by index: the poller speeds up while the popover is open.
  const start = points[points.length - 1].at - HISTORY_MS
  const path = points
    .map(({ at, value }) => {
      const x = (clamp((at - start) / HISTORY_MS) * 100).toFixed(1)
      const y = (17 - clamp(value / 100) * 14).toFixed(1)
      return `${x},${y}`
    })
    .join(" ")
  return (
    <svg
      aria-hidden="true"
      data-resource-trend=""
      viewBox="0 0 100 20"
      preserveAspectRatio="none"
      className="h-4 w-16 shrink-0 text-muted-foreground/70"
    >
      <polyline
        points={path}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

function Row({
  label,
  value,
  trend,
  hint,
  hintTitle,
  children,
}: {
  label: string
  value: string
  trend?: ReactNode
  hint?: string
  hintTitle?: string
  children?: ReactNode
}) {
  return (
    <div data-resource-row="" className="flex flex-col gap-1">
      <div className="flex items-center gap-2">
        <span className="text-2xs font-medium">{label}</span>
        <span className="ml-auto flex items-center gap-2">
          {trend}
          <span className="text-2xs tabular-nums">{value}</span>
        </span>
      </div>
      {children}
      {hint && (
        <span
          className="truncate text-3xs text-muted-foreground"
          title={hintTitle}
        >
          {hint}
        </span>
      )}
    </div>
  )
}

/**
 * Cowork: how loaded the machine behind this workspace is, at the foot of the
 * sidebar beside the workspace's name (or in the bottom-left capsule while
 * the sidebar is collapsed) — the server in a browser or a remote window,
 * this computer in the local workspace.
 *
 * The trigger is a glance: two small bars (CPU, memory) and the memory
 * percentage, the figure that decides whether the next build fits. It stays
 * as quiet as the rest of the bar until memory runs short; then the bars take
 * the warning colour and a warning sign joins them, so the state never rides
 * on colour alone. Running out for real also raises one toast per episode,
 * kept in the alert list.
 *
 * The popover has the detail: CPU with load, memory, swap, disk and — on a
 * Linux server — what this workspace's own processes use, against its memory
 * limit when it has one.
 *
 * Renders nothing while there is no reading, and for good when the server has
 * none to give (an older server, Windows).
 */
export function ResourceMeter({ className }: { className?: string }) {
  const t = useCoworkText()
  const { latest, history } = useSystemResources()
  const [open, setOpen] = useState(false)
  useResourceWatch(open)

  const where =
    isDesktop() && !isRemoteDesktopWindow()
      ? t("resourcesThisComputer")
      : t("resourcesServer")
  const headline = latest ? memoryHeadline(latest) : null

  useEffect(() => {
    const headline = latest && memoryHeadline(latest)
    if (!latest || !headline) return
    if (!shouldAnnounceCritical(latest.memoryPressure)) return
    notify({
      level: "warning",
      key: "cowork-memory-pressure",
      title: t("resourcesCriticalTitle"),
      description: [
        t("resourcesCriticalDetail", {
          where,
          available: formatBytes(headline.availableBytes),
          total: formatBytes(headline.totalBytes),
        }),
        t("resourcesCriticalHint"),
      ].join("\n"),
    })
  }, [latest, t, where])

  if (!latest) return null

  const { cpu, memory, swap, disk, workspace } = latest
  const pressure = latest.memoryPressure
  const cpuUsage = cpu ? cpu.usagePercent : null
  const cpuRatio = (cpuUsage ?? 0) / 100
  const cpuText = cpuUsage === null ? "—" : `${Math.round(cpuUsage)}%`
  const memoryText = headline ? formatPercent(headline.usedRatio) : "—"
  const summary = t("resourcesSummary", { cpu: cpuText, memory: memoryText })
  const pressureLabel = t(
    pressure === "critical"
      ? "resourcesPressureCritical"
      : pressure === "warning"
        ? "resourcesPressureWarning"
        : "resourcesPressureNormal"
  )
  const label = [
    `${t("resources")} (${where})`,
    summary,
    pressure !== "normal" && pressureLabel,
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-resource-meter=""
          data-pressure={pressure}
          title={label}
          aria-label={label}
          className={cn(
            "flex h-6 shrink-0 items-center gap-1.5 rounded-full px-1.5 tabular-nums transition-colors hover:bg-[var(--g-hover)] hover:text-foreground",
            className
          )}
        >
          {pressure !== "normal" && (
            <TriangleAlert className={cn("size-3", ICON[pressure])} />
          )}
          <span aria-hidden="true" className="flex items-end gap-0.5">
            <Bar ratio={cpuRatio} />
            <Bar ratio={headline?.usedRatio ?? 0} className={ICON[pressure]} />
          </span>
          <span>{memoryText}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="start" className="w-72 gap-3 p-3">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-xs font-medium">
            {t("resources")}
            <span className="font-normal text-muted-foreground">
              {" · "}
              {where}
            </span>
          </span>
          <span
            data-resource-pressure={pressure}
            className={cn(
              "flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-3xs font-medium",
              BADGE[pressure]
            )}
          >
            {pressure === "normal" ? (
              <span
                aria-hidden="true"
                className="size-1.5 rounded-full bg-emerald-500"
              />
            ) : (
              <TriangleAlert aria-hidden="true" className="size-3" />
            )}
            {pressureLabel}
          </span>
        </div>

        {pressure !== "normal" && (
          <p className="text-2xs text-muted-foreground">
            {t(
              pressure === "critical"
                ? "resourcesCriticalHint"
                : "resourcesWarningHint"
            )}
          </p>
        )}

        {cpu && (
          <Row
            label={t("resourcesCpu")}
            value={cpuText}
            trend={<Trend history={history} pick={(sample) => sample.cpu} />}
            hint={
              cpu.loadAverage
                ? t("resourcesLoad", {
                    count: String(cpu.cores),
                    load: cpu.loadAverage.map((v) => v.toFixed(2)).join(" / "),
                  })
                : t("resourcesCores", { count: String(cpu.cores) })
            }
          >
            <Meter ratio={cpuRatio} tone="normal" />
          </Row>
        )}

        {memory && (
          <Row
            label={t("resourcesMemory")}
            value={formatBytesOf(
              memory.totalBytes - memory.availableBytes,
              memory.totalBytes
            )}
            trend={<Trend history={history} pick={(sample) => sample.memory} />}
            hint={t("resourcesAvailable", {
              value: formatBytes(memory.availableBytes),
            })}
          >
            <Meter
              ratio={1 - memory.availableBytes / memory.totalBytes}
              // With a tighter cgroup limit the verdict is about that limit,
              // and is shown on its own meter below.
              tone={headline?.limited ? "normal" : pressure}
            />
          </Row>
        )}

        {workspace && (
          <Row
            label={t("resourcesWorkspace")}
            value={formatBytes(workspace.usedBytes)}
            hint={t("resourcesWorkspaceHint")}
          />
        )}

        {workspace?.limit && (
          // Its own row: the limit may sit on a group this workspace shares,
          // and then the usage against it is the group's.
          <Row
            label={t("resourcesLimit")}
            value={formatBytesOf(
              workspace.limit.usedBytes,
              workspace.limit.limitBytes
            )}
          >
            <Meter
              ratio={workspace.limit.usedBytes / workspace.limit.limitBytes}
              tone={
                headline?.limited
                  ? pressure
                  : limitTone(
                      workspace.limit.usedBytes / workspace.limit.limitBytes
                    )
              }
            />
          </Row>
        )}

        {swap && (
          <Row
            label={t("resourcesSwap")}
            value={formatBytesOf(swap.usedBytes, swap.totalBytes)}
          >
            <Meter ratio={swap.usedBytes / swap.totalBytes} tone="normal" />
          </Row>
        )}

        {disk && (
          <Row
            label={t("resourcesDisk")}
            value={formatBytesOf(
              disk.totalBytes - disk.availableBytes,
              disk.totalBytes
            )}
            hint={`${t("resourcesFree", {
              value: formatBytes(disk.availableBytes),
            })} · ${disk.path}`}
            hintTitle={disk.path}
          >
            <Meter
              ratio={1 - disk.availableBytes / disk.totalBytes}
              tone={diskTone(1 - disk.availableBytes / disk.totalBytes)}
            />
          </Row>
        )}
      </PopoverContent>
    </Popover>
  )
}
