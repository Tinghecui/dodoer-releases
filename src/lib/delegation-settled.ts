/**
 * The delegations a finished reply handed off whose outcome its agent never
 * read (cowork-codeg#173) — the candidates for the "sub-task finished after
 * this reply" notice under it.
 *
 * An async `delegate_to_agent` (or `resume_delegation`) acks at once and the
 * agent has to check back with `get_delegation_status`. When its turn ends
 * first — it said "waiting for your approval" and stopped — the task can
 * still finish afterwards, and nothing in the transcript says so: the agent
 * is deliberately not woken for it (that would spend tokens and set it
 * running on its own). The notice says it instead, and it is DERIVED, not
 * stored: the reply's own calls and checks say which tasks it never saw end,
 * and the card model (live binding → the meta the backend injects from the
 * child's row) says which of those have ended since. So it survives a reload
 * and never reaches the agent's context, and it goes away by itself once the
 * agent checks the task and reads the outcome.
 *
 * Kept free of React for unit testing; whether a candidate has actually
 * ended is the card model's call, made where the notice is drawn.
 */

import type { DelegationCardSource } from "@/hooks/use-delegation-card-model"
import type {
  AdaptedContentPart,
  AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { parseDelegateTaskId } from "@/lib/delegation-card"
import {
  buildDelegationTaskRows,
  parseStatusReport,
  taskEnding,
  type StatusReport,
} from "@/lib/delegation-status"
import { normalizeToolName } from "@/lib/tool-call-normalization"

export interface SettledNoticeCandidate {
  source: DelegationCardSource
  /** The broker task id the call reported (a resume: the one it names). */
  taskId: string
}

function collectStatusPolls(
  parts: readonly AdaptedContentPart[],
  out: AdaptedToolCallPart[]
): void {
  for (const part of parts) {
    if (part.type === "delegation-status-group") {
      out.push(...part.polls)
    } else if (part.type === "tool-call") {
      if (
        normalizeToolName(part.toolName).toLowerCase() ===
        "get_delegation_status"
      ) {
        out.push(part)
      }
    } else if (part.type === "goal-run") {
      collectStatusPolls(part.items, out)
    }
  }
}

/**
 * Of `sources` — the delegation calls `extractDelegationSources` read off a
 * reply's `parts` — the ones the reply never saw end: the call itself only
 * acked (a fast finish reports its outcome right in the call), and no
 * `get_delegation_status` check in the reply found the task over. One entry
 * per task, the newest call on it (a resume supersedes the delegation it
 * revived). A call refused outright, or one that names no task, never is.
 */
export function settledNoticeCandidates(
  sources: readonly DelegationCardSource[],
  parts: readonly AdaptedContentPart[]
): SettledNoticeCandidate[] {
  if (sources.length === 0) return []
  const polls: AdaptedToolCallPart[] = []
  collectStatusPolls(parts, polls)
  const newest = new Map<string, StatusReport>()
  for (const row of buildDelegationTaskRows(polls)) {
    if (row.taskId != null) newest.set(row.taskId, row.report)
  }
  const byTask = new Map<string, SettledNoticeCandidate>()
  for (const source of sources) {
    if (source.errorText || source.state === "output-error") continue
    const taskId =
      source.taskIdHint ?? parseDelegateTaskId(source.output, source.errorText)
    if (!taskId) continue
    // Newest call on the task wins, in its place in the order.
    byTask.delete(taskId)
    if (taskEnding(parseStatusReport(source.output, source.errorText))) {
      continue
    }
    if (taskEnding(newest.get(taskId))) continue
    byTask.set(taskId, { source, taskId })
  }
  return [...byTask.values()]
}
