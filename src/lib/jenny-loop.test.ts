import { describe, expect, it } from "vitest"

import {
  formatStageMinutes,
  liveLoop,
  liveStage,
  phaseCounts,
  sessionIsLive,
  splitSessions,
  stageResultKind,
} from "./jenny-loop"
import type {
  JennyLoopConversation,
  JennyLoopEntry,
  JennyLoopSession,
  JennyLoopStage,
} from "./types"

function session(patch: Partial<JennyLoopSession>): JennyLoopSession {
  return {
    agentType: "codex",
    sessionId: "s",
    role: "stage",
    label: null,
    ...patch,
  } as JennyLoopSession
}
function stage(patch: Partial<JennyLoopStage>): JennyLoopStage {
  return {
    id: "impl-01",
    phase: "impl",
    number: 1,
    cycle: 1,
    result: null,
    summary: null,
    evidence: [],
    durationMinutes: null,
    current: false,
    sessions: [],
    ...patch,
  } as JennyLoopStage
}
function loop(patch: Partial<JennyLoopEntry>): JennyLoopEntry {
  return {
    id: "loop01",
    runState: "completed",
    stages: [],
    ...patch,
  } as JennyLoopEntry
}
const conversation = (loops: JennyLoopEntry[]) =>
  ({ loops }) as JennyLoopConversation

describe("liveLoop", () => {
  it("prefers the running Loop over a newer stopped one", () => {
    const running = loop({ id: "loop02", runState: "running" })
    const newer = loop({ id: "loop03", runState: "stopped" })
    expect(liveLoop(conversation([loop({}), running, newer]))?.id).toBe(
      "loop02"
    )
  })
  it("falls back to the newest, and to nothing without Loops", () => {
    expect(liveLoop(conversation([loop({}), loop({ id: "loop02" })]))?.id).toBe(
      "loop02"
    )
    expect(liveLoop(conversation([]))).toBeNull()
    expect(liveLoop(null)).toBeNull()
  })
})

describe("liveStage", () => {
  it("is the stage at work, else the last", () => {
    const at = stage({ id: "impl-02", current: true })
    const last = stage({ id: "test-02" })
    expect(liveStage(loop({ stages: [at, last] }))?.id).toBe("impl-02")
    expect(liveStage(loop({ stages: [stage({}), last] }))?.id).toBe("test-02")
    expect(liveStage(loop({}))).toBeNull()
  })
})

describe("sessionIsLive", () => {
  it("re-reads only an unfinished stage of a running Loop", () => {
    const running = loop({ runState: "running" })
    expect(sessionIsLive(running, stage({}))).toBe(true)
    expect(sessionIsLive(running, stage({ result: "passed" }))).toBe(false)
    expect(sessionIsLive(loop({ runState: "paused" }), stage({}))).toBe(false)
  })
})

describe("splitSessions", () => {
  it("keeps helpers apart from the stage's own agents", () => {
    const { main, helpers } = splitSessions(
      stage({
        sessions: [
          session({ sessionId: "a" }),
          session({ sessionId: "b", role: "subagent" }),
          session({ sessionId: "c", role: "node" }),
        ],
      })
    )
    expect(main.map((s) => s.sessionId)).toEqual(["a", "c"])
    expect(helpers.map((s) => s.sessionId)).toEqual(["b"])
  })
})

describe("stageResultKind", () => {
  it("names each outcome and tells a stage at work from an abandoned one", () => {
    expect(stageResultKind(stage({ result: "passed" }))).toBe("passed")
    expect(stageResultKind(stage({ result: "failed" }))).toBe("failed")
    expect(stageResultKind(stage({ result: "skipped" }))).toBe("other")
    expect(stageResultKind(stage({ current: true }))).toBe("running")
    expect(stageResultKind(stage({}))).toBe("unfinished")
  })
})

describe("formatStageMinutes", () => {
  it("says a duration as short as it can", () => {
    expect(formatStageMinutes(null)).toBeNull()
    expect(formatStageMinutes(-1)).toBeNull()
    expect(formatStageMinutes(0.4)).toBe("<1m")
    expect(formatStageMinutes(22.2)).toBe("22m")
    expect(formatStageMinutes(60)).toBe("1h")
    expect(formatStageMinutes(158)).toBe("2h 38m")
  })
})

describe("phaseCounts", () => {
  it("counts the stages of each phase", () => {
    expect(
      phaseCounts(
        loop({
          stages: [
            stage({}),
            stage({ id: "impl-02" }),
            stage({ id: "test-01", phase: "test" }),
          ],
        })
      )
    ).toEqual({ impl: 2, test: 1 })
  })
})
