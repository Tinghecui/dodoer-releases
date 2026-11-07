/**
 * jenny fork: small rules the Loop conversation's view and panel share. All of
 * it is derived from what `get_loop_conversation` returns; nothing is stored.
 */

import type {
  JennyLoopConversation,
  JennyLoopEntry,
  JennyLoopRunState,
  JennyLoopSession,
  JennyLoopStage,
} from "@/lib/types"

/** The order a Loop goes through its phases. */
export const LOOP_PHASES = [
  "prepare",
  "impl",
  "deploy",
  "test",
  "reflect",
] as const

/** Each phase keeps one colour wherever it shows, so a stage reads at a glance
 *  in a long list. `launcher` and an unknown phase stay neutral. */
const PHASE_TONE: Record<string, string> = {
  prepare: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  impl: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  deploy: "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  test: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  reflect: "bg-pink-500/15 text-pink-700 dark:text-pink-300",
}
const PHASE_EDGE: Record<string, string> = {
  prepare: "border-sky-500/60",
  impl: "border-blue-500/60",
  deploy: "border-violet-500/60",
  test: "border-amber-500/60",
  reflect: "border-pink-500/60",
}
export function phaseTone(phase: string): string {
  return PHASE_TONE[phase] ?? "bg-muted text-muted-foreground"
}
export function phaseEdge(phase: string): string {
  return PHASE_EDGE[phase] ?? "border-border"
}

export const RUN_STATE_DOT: Record<JennyLoopRunState, string> = {
  running: "bg-[var(--st-run-dot)]",
  paused: "bg-[var(--st-unread)]",
  stopped: "bg-[var(--st-fail)]",
  blocked: "bg-[var(--st-unread)]",
  completed: "bg-[var(--st-ok)]",
}

/** The Loop a folder's conversation is about now: the running one, else the
 *  newest. */
export function liveLoop(
  detail: JennyLoopConversation | null
): JennyLoopEntry | null {
  const loops = detail?.loops ?? []
  return (
    [...loops].reverse().find((l) => l.runState === "running") ??
    loops[loops.length - 1] ??
    null
  )
}

/** The stage to open by default: the one at work, else the last one. */
export function liveStage(loop: JennyLoopEntry | null): JennyLoopStage | null {
  if (!loop) return null
  return (
    loop.stages.find((s) => s.current) ??
    loop.stages[loop.stages.length - 1] ??
    null
  )
}

/** A stage still being written reads fresh; a finished one never changes. */
export function sessionIsLive(
  loop: JennyLoopEntry,
  stage: JennyLoopStage
): boolean {
  return loop.runState === "running" && stage.result === null
}

/** A stage's own agents first, then the helpers they started. */
export function splitSessions(stage: JennyLoopStage): {
  main: JennyLoopSession[]
  helpers: JennyLoopSession[]
} {
  return {
    main: stage.sessions.filter((s) => s.role !== "subagent"),
    helpers: stage.sessions.filter((s) => s.role === "subagent"),
  }
}

export function stageResultKind(
  stage: JennyLoopStage
): "passed" | "failed" | "running" | "unfinished" | "other" {
  if (stage.result === "passed") return "passed"
  if (stage.result === "failed") return "failed"
  if (stage.result) return "other"
  return stage.current ? "running" : "unfinished"
}

/** How long a stage took, as short as it can be said. */
export function formatStageMinutes(minutes: number | null): string | null {
  if (minutes === null || !Number.isFinite(minutes) || minutes < 0) return null
  if (minutes < 1) return "<1m"
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = Math.floor(minutes / 60)
  const rest = Math.round(minutes - hours * 60)
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** How many stages of each phase a Loop has gone through. */
export function phaseCounts(loop: JennyLoopEntry): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const stage of loop.stages) {
    counts[stage.phase] = (counts[stage.phase] ?? 0) + 1
  }
  return counts
}
