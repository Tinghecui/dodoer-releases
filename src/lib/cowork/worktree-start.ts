// Checks around a draft's "start in a new worktree" choice (Cowork-only flow:
// the branch dropdown plans it, the first send creates it).

import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"

/** Characters git refuses anywhere in a ref name (besides control characters). */
const FORBIDDEN_CHARS = " ~^:?*[\\"

/**
 * Whether git would take `name` as a branch name: the rules of
 * `git check-ref-format --branch`, which is what the backend runs before it
 * creates the worktree (`plan_conversation_worktree` in `commands/folders.rs`).
 * Checked here as well so a bad name is refused where it is typed, not when
 * the first message is sent.
 *
 * `@{` is refused outright. Git itself reads `@{-1}` as "the branch checked
 * out before" and would accept it, which is never what a name typed into the
 * dialog means.
 */
export function isValidBranchName(name: string): boolean {
  if (name === "" || name === "@" || name === "HEAD") return false
  if (name.startsWith("-") || name.startsWith("/")) return false
  if (name.endsWith("/") || name.endsWith(".")) return false
  if (name.includes("..") || name.includes("//") || name.includes("@{")) {
    return false
  }
  for (const ch of name) {
    const code = ch.charCodeAt(0)
    if (code < 0x20 || code === 0x7f || FORBIDDEN_CHARS.includes(ch)) {
      return false
    }
  }
  return name
    .split("/")
    .every((part) => !part.startsWith(".") && !part.endsWith(".lock"))
}

/** Why the dialog refuses a typed branch name; `null` when it takes it. */
export type BranchNameProblem = "invalid" | "exists"

/**
 * Checks a name typed into "adjust new worktree" the way the backend will when
 * the first message is sent: git must take it as a branch name, and no local
 * branch may have it already (`plan_conversation_worktree` refuses
 * `refs/heads/<name>` with "Branch already exists"). An empty name is fine:
 * the agent names the branch after the first message.
 */
export function branchNameProblem(
  name: string,
  localBranches: readonly string[]
): BranchNameProblem | null {
  if (name === "") return null
  if (!isValidBranchName(name)) return "invalid"
  return localBranches.includes(name) ? "exists" : null
}

/**
 * What a failed backend command said, for a toast: its message, then the
 * detail when that adds something ("Invalid branch name: bad name"). The
 * shared `toErrorMessage` shows the detail ALONE, and for the worktree errors
 * the detail is only the name the user typed.
 */
export function commandErrorReason(error: unknown): string {
  const appError = extractAppCommandError(error)
  if (!appError) return toErrorMessage(error)
  const detail = appError.detail?.trim()
  return detail && detail !== appError.message
    ? `${appError.message}: ${detail}`
    : appError.message
}
