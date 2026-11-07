import type { useTranslations } from "next-intl"
import { toast } from "sonner"
import type {
  ConversationWorktreeCreated,
  ConversationWorktreeSetupResult,
} from "@/lib/types"

type BranchT = ReturnType<typeof useTranslations<"Folder.branchDropdown">>

/** Output kept in a failure toast — the tail is where the error is. */
const OUTPUT_TAIL_CHARS = 600

/** A failed setup stays up long enough to read the output. */
const FAILURE_DURATION_MS = 20_000

function tail(text: string, n: number): string {
  const trimmed = text.trim()
  return trimmed.length <= n ? trimmed : `…${trimmed.slice(-n)}`
}

/**
 * Tell the user what happened right after a conversation worktree was made:
 * what `.worktreeinclude` copied (or failed to), and that the init command is
 * now running. Silent when there was nothing to copy and nothing to run.
 */
export function notifyWorktreeCreated(
  created: ConversationWorktreeCreated,
  t: BranchT
): void {
  const { include, setup_command } = created
  if (include.failed.length > 0) {
    toast.warning(
      t("toasts.worktreeIncludeFailed", { count: include.failed.length }),
      {
        description: include.failed.slice(0, 5).join("\n"),
        duration: FAILURE_DURATION_MS,
      }
    )
  }
  const copied =
    include.copied.length > 0
      ? t("toasts.worktreeIncludeCopied", { count: include.copied.length })
      : null
  if (setup_command) {
    toast.info(t("toasts.worktreeSetupStarted", { command: setup_command }), {
      description: copied
        ? `${copied}\n${t("toasts.worktreeSetupStartedHint")}`
        : t("toasts.worktreeSetupStartedHint"),
    })
  } else if (copied) {
    toast.info(copied)
  }
}

/** The background init command's outcome. A failure is a warning, not an
 *  error: the conversation is already under way and keeps going. */
export function notifyWorktreeSetupResult(
  result: ConversationWorktreeSetupResult,
  t: BranchT
): void {
  if (result.ok) {
    toast.success(t("toasts.worktreeSetupDone", { command: result.command }))
    return
  }
  toast.warning(
    t("toasts.worktreeSetupFailed", {
      command: result.command,
      code: result.exit_code == null ? "?" : String(result.exit_code),
    }),
    {
      description: result.output_tail
        ? tail(result.output_tail, OUTPUT_TAIL_CHARS)
        : undefined,
      duration: FAILURE_DURATION_MS,
    }
  )
}
