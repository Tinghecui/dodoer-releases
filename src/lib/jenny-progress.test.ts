import { describe, expect, it } from "vitest"

import type { JennyProgressDetail } from "@/lib/types"

import {
  metricSeries,
  recordState,
  timeDomain,
  valueRange,
} from "./jenny-progress"

const T = (hhmm: string) => `2026-11-01T${hhmm}:00+08:00`
const ms = (hhmm: string) => Date.parse(T(hhmm))

function record(patch: Partial<JennyProgressDetail> = {}): JennyProgressDetail {
  return {
    sessionId: "s1",
    taskStatus: "active",
    completionState: "open",
    registration: "current",
    updatedAt: T("11:45"),
    humanSummary: null,
    challengeSummary: null,
    metrics: [],
    revision: 3,
    ...patch,
  }
}

function metric(
  patch: Partial<JennyProgressDetail["metrics"][number]> = {}
): JennyProgressDetail["metrics"][number] {
  return {
    id: "files",
    label: "Files",
    value: 40,
    unit: "files",
    target: 100,
    history: [
      { at: T("10:00"), value: 10 },
      { at: T("11:00"), value: 40 },
    ],
    ...patch,
  }
}

describe("recordState", () => {
  it("reads the agent's registered end, and a failed hand-back as failed", () => {
    expect(recordState(record())).toBe("open")
    expect(recordState(record({ completionState: "blocked" }))).toBe("blocked")
    expect(recordState(record({ completionState: "completed" }))).toBe(
      "completed"
    )
    expect(
      recordState(
        record({ completionState: "completed", taskStatus: "failed" })
      )
    ).toBe("failed")
  })

  it("never shows an older turn's end as the current one", () => {
    const done = { completionState: "completed" as const }
    expect(recordState(record({ ...done, registration: "pending" }))).toBe(
      "open"
    )
    expect(recordState(record({ ...done, registration: "missed" }))).toBe(
      "unregistered"
    )
    expect(recordState(record({ ...done, registration: "none" }))).toBe(
      "unregistered"
    )
  })
})

describe("timeDomain", () => {
  it("runs from the first point to the last, across every chart", () => {
    const d = record({
      metrics: [
        metric(),
        metric({
          id: "rows",
          history: [
            { at: T("10:30"), value: 1 },
            { at: T("11:30"), value: 2 },
          ],
        }),
      ],
    })
    expect(timeDomain(d, ms("11:30"))).toEqual([ms("10:00"), ms("11:30")])
  })

  const twoPoints = (patch: Partial<JennyProgressDetail> = {}) =>
    record({
      metrics: [
        metric({
          history: [
            { at: T("10:00"), value: 1 },
            { at: T("10:30"), value: 2 },
          ],
        }),
      ],
      ...patch,
    })

  it("goes on to now while the task runs, so a stall shows as a flat line", () => {
    expect(timeDomain(twoPoints(), ms("11:00"))).toEqual([
      ms("10:00"),
      ms("11:00"),
    ])
  })

  it("keeps the tail no longer than the curve, or an hour", () => {
    const later = ms("23:00")
    expect(timeDomain(twoPoints(), later)).toEqual([ms("10:00"), ms("11:30")])
    const long = record({
      metrics: [
        metric({
          history: [
            { at: T("08:00"), value: 1 },
            { at: T("10:00"), value: 2 },
          ],
        }),
      ],
    })
    expect(timeDomain(long, later)).toEqual([ms("08:00"), ms("12:00")])
  })

  it("ends at the last point once the task has ended", () => {
    for (const patch of [
      {
        completionState: "completed" as const,
        taskStatus: "completed" as const,
      },
      { completionState: "blocked" as const, taskStatus: "blocked" as const },
      { registration: "none" as const },
    ]) {
      expect(timeDomain(twoPoints(patch), ms("23:00"))).toEqual([
        ms("10:00"),
        ms("10:30"),
      ])
    }
  })

  it("never ends before the last point when the clock is behind", () => {
    expect(timeDomain(twoPoints(), ms("09:00"))).toEqual([
      ms("10:00"),
      ms("10:30"),
    ])
  })

  it("is empty while there is no curve to draw", () => {
    expect(timeDomain(record(), ms("12:00"))).toBeNull()
    const onePoint = (patch: Partial<JennyProgressDetail> = {}) =>
      record({
        metrics: [metric({ history: [{ at: T("10:00"), value: 10 }] })],
        ...patch,
      })
    expect(
      timeDomain(
        onePoint({ completionState: "completed", taskStatus: "completed" }),
        ms("12:00")
      )
    ).toBeNull()
    expect(timeDomain(onePoint(), ms("10:00"))).toBeNull()
    // A running number held since its first report is a flat line, not nothing.
    expect(timeDomain(onePoint(), ms("10:20"))).toEqual([
      ms("10:00"),
      ms("10:20"),
    ])
  })
})

describe("metricSeries", () => {
  it("keeps each point's time and value and skips a bad time", () => {
    expect(
      metricSeries(
        metric({
          history: [
            { at: "not a time", value: 1 },
            { at: T("10:00"), value: 10 },
          ],
        })
      )
    ).toEqual([{ t: ms("10:00"), v: 10 }])
  })
})

describe("valueRange", () => {
  it("covers the points and the target, with room around them", () => {
    const { min, max, range } = valueRange(metric())
    expect([min, max]).toEqual([10, 100])
    expect(range[0]).toBeLessThan(10)
    expect(range[1]).toBeGreaterThan(100)
  })

  it("leaves an open-ended number to its own points", () => {
    const { min, max } = valueRange(metric({ target: null }))
    expect([min, max]).toEqual([10, 40])
  })

  it("still has a height for a flat line", () => {
    const { range } = valueRange(
      metric({ target: null, history: [{ at: T("10:00"), value: 0 }] })
    )
    expect(range[1]).toBeGreaterThan(range[0])
  })
})
