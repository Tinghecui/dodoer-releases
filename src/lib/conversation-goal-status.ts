import type { ContentBlock, MessageTurn } from "@/lib/types"
import {
  normalizeGoalStatus,
  normalizeToolName,
} from "@/lib/tool-call-normalization"

/**
 * The goal a conversation's agent currently holds, read off the transcript.
 *
 * Every agent's goal transitions reach the frontend as the canonical synthetic
 * `create_goal` (opens a run, status `active`) / `update_goal` (any later
 * status, or a clear) tool calls — the live path builds them from
 * `session_info_update._meta.goal`, the history parsers from the agent's own
 * rollout (see `src-tauri/src/acp/codex_goal.rs`). So the LAST such marker in
 * the timeline is the goal's current state, and the sidebar can show "this
 * session is still on a goal" without the backend growing a column for it.
 *
 * `GoalCard` (`goal-tool-call.tsx`) reads the same markers to draw the capsule;
 * this module only answers the sidebar's narrower question.
 */
export interface ConversationGoalStatus {
  /** snake_case goal status: `active`, `paused`, `complete`, `limited`, … */
  status: string
  objective: string | null
}

/**
 * Statuses under which the agent still holds the goal and will pick it back
 * up on its own (a background monitor firing, a `/goal resume`) — i.e. the
 * session is "on a goal" even though no turn is in flight.
 */
const OPEN_GOAL_STATUSES: ReadonlySet<string> = new Set(["active", "paused"])

export function isGoalOpen(
  goal: ConversationGoalStatus | null | undefined
): goal is ConversationGoalStatus {
  return Boolean(goal && OPEN_GOAL_STATUSES.has(goal.status))
}

function isGoalToolName(
  toolName: string
): "create_goal" | "update_goal" | null {
  const normalized = normalizeToolName(toolName)
  return normalized === "create_goal" || normalized === "update_goal"
    ? normalized
    : null
}

function parseJsonObject(
  raw: string | null | undefined
): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function stringField(
  obj: Record<string, unknown> | null,
  key: string
): string | null {
  const value = obj?.[key]
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/**
 * Resolve one goal marker's status/objective. Precedence mirrors
 * `goal-tool-call.tsx`'s `resolveGoalInfo`: the tool RESULT's `{"goal":{…}}`
 * snapshot is the agent's own word and wins; the tool INPUT (`{status,
 * objective}` for `update_goal`, `{objective}` for `create_goal`) backs it up;
 * a `create_goal` with neither is `active` by definition. A result whose
 * `goal` is `null` is a clear — the goal is gone whatever the input said.
 */
function resolveMarker(
  toolName: "create_goal" | "update_goal",
  input: Record<string, unknown> | null,
  output: Record<string, unknown> | null
): ConversationGoalStatus {
  const objective =
    stringField(output?.goal as Record<string, unknown> | null, "objective") ??
    stringField(input, "objective")
  if (output && "goal" in output && output.goal === null) {
    return { status: "cleared", objective }
  }
  const rawStatus =
    stringField(output?.goal as Record<string, unknown> | null, "status") ??
    stringField(input, "status") ??
    (toolName === "create_goal" ? "active" : "cleared")
  return { status: normalizeGoalStatus(rawStatus), objective }
}

/**
 * The newest goal marker across `turns` (oldest first — timeline order), or
 * `null` when the transcript never set a goal. Scans from the end so the
 * common "no goal" case costs a walk and the common "goal just updated" case
 * costs almost nothing.
 */
export function findLatestGoalStatus(
  turns: readonly MessageTurn[]
): ConversationGoalStatus | null {
  for (let ti = turns.length - 1; ti >= 0; ti--) {
    const blocks = turns[ti]!.blocks
    for (let bi = blocks.length - 1; bi >= 0; bi--) {
      const block = blocks[bi]!
      if (block.type !== "tool_use") continue
      const toolName = isGoalToolName(block.tool_name)
      if (!toolName) continue
      return resolveMarker(
        toolName,
        parseJsonObject(block.input_preview),
        parseJsonObject(
          findResult(blocks, bi, block.tool_use_id)?.output_preview
        )
      )
    }
  }
  return null
}

/** The `tool_result` paired with the `tool_use` at `useIndex` — the parsers
 *  and the live reducer both emit it right after its call, in the same turn. */
function findResult(
  blocks: readonly ContentBlock[],
  useIndex: number,
  toolUseId: string | null
): Extract<ContentBlock, { type: "tool_result" }> | null {
  if (!toolUseId) return null
  for (let i = useIndex + 1; i < blocks.length; i++) {
    const block = blocks[i]!
    if (block.type === "tool_result" && block.tool_use_id === toolUseId) {
      return block
    }
  }
  return null
}
