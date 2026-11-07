"use client"

/**
 * jenny fork: a time chart for the "Jenny progress" tab. Every chart of one
 * record takes the same time span, so their x axes line up. Points are the
 * number's key changes, so the line runs straight from one to the next; past
 * its last point it holds the last value, drawn fainter.
 */

import { useEffect, useRef, useState } from "react"
import type { SeriesPoint } from "@/lib/jenny-progress"

/** Drawing width until the real one is measured; text keeps its size by
 *  drawing at the width the chart actually gets. */
const DEFAULT_W = 300
const RIGHT = 8
const TOP = 6
const AXIS_H = 14
/** Above this many points the dots would hide the line. */
const MAX_DOTS = 40

export function formatChartTime(t: number, span: number): string {
  return new Date(t).toLocaleString(undefined, {
    ...(span >= 20 * 3_600_000 ? { month: "numeric", day: "numeric" } : {}),
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function TimeChart({
  label,
  domain,
  yRange,
  yLabels,
  points,
  color,
  pointTitle,
  target,
  plotHeight = 72,
  yLabelWidth = 34,
}: {
  /** Read out instead of the drawing. */
  label: string
  domain: [number, number]
  yRange: [number, number]
  yLabels: { v: number; text: string }[]
  points: SeriesPoint[]
  color: string
  /** Shown when hovering a point. */
  pointTitle: (p: SeriesPoint) => string
  /** A dashed level line, e.g. a metric's target. */
  target?: { v: number; color: string }
  plotHeight?: number
  /** Room left of the plot for the value labels. */
  yLabelWidth?: number
}) {
  const box = useRef<HTMLDivElement>(null)
  const [W, setW] = useState(DEFAULT_W)
  useEffect(() => {
    const el = box.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(([entry]) => {
      const width = Math.round(entry.contentRect.width)
      if (width > 0) setW(width)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  const left = yLabelWidth
  const [t0, t1] = domain
  const [lo, hi] = yRange
  const plotW = W - left - RIGHT
  const x = (t: number) => left + ((t - t0) / (t1 - t0 || 1)) * plotW
  const y = (v: number) =>
    TOP + plotHeight - ((v - lo) / (hi - lo || 1)) * plotHeight
  const axisTop = TOP + plotHeight + 4
  const height = axisTop + AXIS_H
  const last = points[points.length - 1]
  const dots = points.length <= MAX_DOTS ? points : last ? [last] : []

  return (
    <div ref={box}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="block h-auto w-full overflow-visible"
        role="img"
        aria-label={label}
      >
        {yLabels.map((l) => (
          <g key={l.v}>
            <line
              x1={left}
              x2={W - RIGHT}
              y1={y(l.v)}
              y2={y(l.v)}
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={left - 4}
              y={y(l.v) + 3}
              textAnchor="end"
              fontSize={10}
              fill="var(--muted-foreground)"
            >
              {l.text}
            </text>
          </g>
        ))}
        {target ? (
          <line
            x1={left}
            x2={W - RIGHT}
            y1={y(target.v)}
            y2={y(target.v)}
            stroke={target.color}
            strokeWidth={1.25}
            strokeDasharray="4 3"
            data-chart-target=""
          />
        ) : null}
        {points.length > 1 ? (
          <path
            d={points
              .map((p, i) => `${i === 0 ? "M" : "L"}${x(p.t)},${y(p.v)}`)
              .join("")}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            data-chart-line=""
          />
        ) : null}
        {last && last.t < t1 ? (
          <path
            d={`M${x(last.t)},${y(last.v)}H${x(t1)}`}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeOpacity={0.35}
            data-chart-hold=""
          />
        ) : null}
        {dots.map((p, i) => (
          <circle
            key={i}
            cx={x(p.t)}
            cy={y(p.v)}
            r={p === last ? 3.5 : 2.5}
            fill={color}
            stroke="var(--background)"
            strokeWidth={1}
            data-chart-point=""
          >
            <title>{pointTitle(p)}</title>
          </circle>
        ))}
        <text
          x={left}
          y={axisTop + 10}
          fontSize={10}
          fill="var(--muted-foreground)"
        >
          {formatChartTime(t0, t1 - t0)}
        </text>
        <text
          x={W - RIGHT}
          y={axisTop + 10}
          textAnchor="end"
          fontSize={10}
          fill="var(--muted-foreground)"
        >
          {formatChartTime(t1, t1 - t0)}
        </text>
      </svg>
    </div>
  )
}
