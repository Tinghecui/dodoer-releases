// jenny fork: pure helpers of the conversation's "Jenny progress" tab — the
// record's state and the curves it draws. A record keeps a long task's key
// numbers only, the first one being the main chart.
// The view is src/components/progress/progress-detail.tsx.

import type { JennyProgressDetail } from "@/lib/types"

/** The one state the record shows, in the words of Jenny's `finish --state`.
 *  `unregistered`: no agent said how the session's latest turn ended. */
export type JennyRecordState =
  | "open"
  | "blocked"
  | "completed"
  | "failed"
  | "unregistered"

export function recordState(d: JennyProgressDetail): JennyRecordState {
  if (d.registration === "none" || d.registration === "missed") {
    return "unregistered"
  }
  // A newer turn is running, so what an older turn said no longer holds.
  if (d.registration === "pending") return "open"
  if (d.completionState === "blocked") return "blocked"
  if (d.completionState === "completed") {
    // A failed hand-back ends the turn without turning it into a success.
    return d.taskStatus === "failed" ? "failed" : "completed"
  }
  return "open"
}

/** A point of a curve: a time in ms and a value. */
export interface SeriesPoint {
  t: number
  v: number
}

type Metric = JennyProgressDetail["metrics"][number]

export function metricSeries(metric: Metric): SeriesPoint[] {
  return metric.history.flatMap((p) => {
    const t = Date.parse(p.at)
    return Number.isFinite(t) ? [{ t, v: p.value }] : []
  })
}

const HOUR = 3_600_000

/** The time span all of a record's charts share, so they line up: from the
 *  first point to the last. While the task runs the axis goes on to now, so a
 *  number that stopped moving shows as a flat line. That tail is never longer
 *  than the curve (or an hour), or a session left open would squeeze its curve.
 *  Null while there is no span to draw. */
export function timeDomain(
  d: JennyProgressDetail,
  now: number
): [number, number] | null {
  const times = d.metrics.flatMap((m) => metricSeries(m).map((p) => p.t))
  if (times.length === 0) return null
  const start = Math.min(...times)
  const last = Math.max(...times)
  const end =
    recordState(d) === "open"
      ? Math.max(last, Math.min(now, last + Math.max(last - start, HOUR)))
      : last
  return end > start ? [start, end] : null
}

/** A chart's value range with room around the line: its points and target. */
export function valueRange(metric: Metric): {
  min: number
  max: number
  range: [number, number]
} {
  const values = [
    ...metric.history.map((p) => p.value),
    ...(metric.target === null ? [] : [metric.target]),
  ]
  const min = Math.min(...values)
  const max = Math.max(...values)
  const pad = (max - min || Math.abs(max) || 1) * 0.12
  return { min, max, range: [min - pad, max + pad] }
}
