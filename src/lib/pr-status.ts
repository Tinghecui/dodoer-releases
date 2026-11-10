import type { FolderPrStatus, PrChecksSummary, PrHint } from "@/lib/types"

/** Pushed by the backend whenever a folder's pull-request status changes. */
export const FOLDER_PR_STATUS_EVENT = "folder://pr-status"

/** How the row's checks glyph reads. `fraction` is the share of finished
 *  checks, floored to quarters so the pie moves in visible steps. */
export type ChecksIndicator =
  | { kind: "running"; fraction: number }
  | { kind: "passed" }
  | { kind: "failed" }

const PIE_PIECES = 4

/** `null` when there is nothing to draw: the forge would not say, or no
 *  checks are configured. Any failure reads as failed even while others are
 *  still running — that is the news. */
export function checksIndicator(
  checks: PrChecksSummary
): ChecksIndicator | null {
  if (!checks.available || checks.total <= 0) return null
  if (checks.failure > 0) return { kind: "failed" }
  if (checks.pending > 0) {
    const completed = Math.max(0, checks.total - checks.pending)
    const fraction =
      Math.floor((completed / checks.total) * PIE_PIECES) / PIE_PIECES
    return { kind: "running", fraction }
  }
  return { kind: "passed" }
}

export type PrVisualState = "open" | "draft" | "merged" | "closed"

export function prVisualState(hint: PrHint): PrVisualState {
  if (hint.state === "merged") return "merged"
  if (hint.state === "closed") return "closed"
  return hint.draft ? "draft" : "open"
}

/** Statuses are small, flat JSON from the backend in a stable field order. */
export function samePrStatus(a: FolderPrStatus, b: FolderPrStatus): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b)
}

/** The worktree folders (`parent_id` set) that hold at least one listed
 *  conversation, ascending — the folders whose pull request the sidebar can
 *  show. Conversations in the main checkout are left out on purpose: they
 *  share whatever branch it has checked out, so "their" pull request is not
 *  theirs. */
export function worktreeFolderIds(
  folders: readonly { id: number; parent_id: number | null }[],
  conversations: readonly { folder_id: number }[]
): number[] {
  const worktrees = new Set<number>()
  for (const folder of folders) {
    if (folder.parent_id != null) worktrees.add(folder.id)
  }
  if (worktrees.size === 0) return []
  const ids = new Set<number>()
  for (const conversation of conversations) {
    if (worktrees.has(conversation.folder_id)) ids.add(conversation.folder_id)
  }
  return [...ids].sort((a, b) => a - b)
}
