import type {
  ConnectionState,
  PendingPermission,
} from "@/contexts/acp-connections-context"
import {
  asRecord,
  extractPlanMarkdown,
  isPlanModeToolName,
  normalizeToolName,
} from "@/lib/plan-parse"
import { codexMarksPlanReview } from "@/lib/tool-call-normalization"
import type {
  PendingPlanApprovalState,
  PendingQuestionState,
} from "@/lib/types"

/**
 * What a connection is parked on until the user answers: the three prompts
 * that resolve WITHOUT driving a new turn — a permission request, a codeg-mcp
 * `ask_user_question`, a plan approval. The same three the backend's
 * `blocked_on` reports for a delegated task (Rust `BlockedKind`). The legacy
 * free-text `pendingQuestion` is not one of them: it is answered by sending a
 * prompt.
 */
export interface BlockingPrompts {
  permission: PendingPermission | null
  askQuestion: PendingQuestionState | null
  planApproval: PendingPlanApprovalState | null
  /** One stable id per decision asked for (`permission:<request_id>`, …): a
   *  new decision brings a new id, an answered one takes its id away. */
  ids: string[]
}

type PromptFields = Pick<
  ConnectionState,
  "pendingPermission" | "pendingAskQuestion" | "pendingPlanApproval"
>

/** The connection's blocking prompts, or `null` when it waits on nobody. */
export function blockingPrompts(
  conn: PromptFields | null | undefined
): BlockingPrompts | null {
  if (!conn) return null
  const permission = conn.pendingPermission ?? null
  // A question set with no questions renders no card, so it asks nothing.
  const askQuestion =
    conn.pendingAskQuestion && conn.pendingAskQuestion.questions.length > 0
      ? conn.pendingAskQuestion
      : null
  const planApproval = conn.pendingPlanApproval ?? null
  const ids: string[] = []
  if (permission) ids.push(`permission:${permission.request_id}`)
  if (askQuestion) ids.push(`question:${askQuestion.question_id}`)
  if (planApproval) ids.push(`plan:${planApproval.approval_id}`)
  if (ids.length === 0) return null
  return { permission, askQuestion, planApproval, ids }
}

function toolCallRecord(toolCall: unknown): Record<string, unknown> | null {
  if (typeof toolCall !== "string") return asRecord(toolCall)
  try {
    return asRecord(JSON.parse(toolCall))
  } catch {
    return null
  }
}

/**
 * Whether a permission request is really a plan approval. Only Grok raises
 * one of its own (`pendingPlanApproval`); Claude Code's ExitPlanMode ("Ready
 * to code?") and codex-acp's Plan-mode review gate ask through an ordinary
 * permission request, so "what is the user asked for" has to look inside it.
 *
 * Read off the request's tool call, as the connection store holds it (the
 * live call's `kind` and `_meta.claudeCode.toolName` merged in):
 * - Claude Code's own tool name, `ExitPlanMode` (in `_meta.claudeCode`, or
 *   `name`, which claude-agent-acp sends a non-AIR client);
 * - codex-acp's `_meta.codex.kind === "plan_review"` marker;
 * - otherwise a plan-mode tool (`switch_mode` kind, …) whose input carries a
 *   plan. The AIR request names no tool at all — only the plan in `rawInput`
 *   — so a plan with no kind counts too. EnterPlanMode (also `switch_mode`,
 *   no plan) stays an ordinary permission.
 */
export function isPlanApprovalPermission(
  permission: Pick<PendingPermission, "tool_call"> | null | undefined
): boolean {
  const call = toolCallRecord(permission?.tool_call)
  if (!call) return false
  const meta = asRecord(call._meta)
  const names = [
    asRecord(meta?.claudeCode)?.toolName,
    call.name,
    call.toolName,
    call.tool_name,
  ]
  if (
    names.some(
      (name) =>
        typeof name === "string" && normalizeToolName(name) === "exitplanmode"
    )
  ) {
    return true
  }
  if (codexMarksPlanReview(meta)) return true
  if (!extractPlanMarkdown(call)) return false
  const kind = typeof call.kind === "string" ? call.kind.trim() : ""
  return kind === "" || isPlanModeToolName(kind)
}
