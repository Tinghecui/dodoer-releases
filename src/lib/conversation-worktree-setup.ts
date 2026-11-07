import { createConversationWorktree } from "@/lib/api"
import { subscribe } from "@/lib/platform"
import type {
  ConversationWorktreeCreated,
  ConversationWorktreeSetupResult,
  ConversationWorktreeSpec,
} from "@/lib/types"

/** Backend channel the background setup command reports on (Rust
 *  `CONVERSATION_WORKTREE_SETUP_EVENT`). */
export const CONVERSATION_WORKTREE_SETUP_EVENT = "conversation-worktree://setup"

/** How long to keep listening for a setup that never reports (the server
 *  restarted mid-install, say) before letting the subscription go. */
const SETUP_WATCH_LIMIT_MS = 2 * 60 * 60 * 1000

/**
 * `createConversationWorktree`, plus the outcome of the init command it starts
 * in the background: `onSetupDone` fires once, with this worktree's result.
 *
 * The subscription is opened BEFORE the create call, because a quick command
 * can finish before the call's response arrives; events seen while the folder
 * id is still unknown are held and matched once it is (and delivered on a
 * later tick than the return, so the caller can announce the setup first).
 * Only the client that created the worktree listens, so the outcome is told
 * to the user who asked for it rather than to every open window.
 *
 * Listening is best-effort: if it cannot be set up, the worktree is still
 * created and the conversation still starts — the user just isn't told how
 * the install went.
 */
export async function createConversationWorktreeWatchingSetup(
  folderId: number,
  spec: ConversationWorktreeSpec,
  onSetupDone: (result: ConversationWorktreeSetupResult) => void
): Promise<ConversationWorktreeCreated> {
  const early: ConversationWorktreeSetupResult[] = []
  let target: number | null = null
  let finished = false
  let unsubscribe: (() => void) | null = null
  let limit: ReturnType<typeof setTimeout> | null = null

  const stop = () => {
    finished = true
    if (limit != null) clearTimeout(limit)
    unsubscribe?.()
    unsubscribe = null
  }
  const deliver = (result: ConversationWorktreeSetupResult) => {
    if (finished) return
    stop()
    onSetupDone(result)
  }

  try {
    unsubscribe = await subscribe<ConversationWorktreeSetupResult>(
      CONVERSATION_WORKTREE_SETUP_EVENT,
      (payload) => {
        if (finished) return
        if (target == null) early.push(payload)
        else if (payload.folder_id === target) deliver(payload)
      }
    )
  } catch {
    unsubscribe = null
  }

  let created: ConversationWorktreeCreated
  try {
    created = await createConversationWorktree(folderId, spec)
  } catch (e) {
    stop()
    throw e
  }

  if (created.setup_command == null || unsubscribe == null) {
    stop()
    return created
  }
  target = created.folder.id
  const seen = early.find((r) => r.folder_id === target)
  early.length = 0
  if (seen) {
    // After the caller has had its turn with `created` (announcing that the
    // setup is running), so the "finished" news never lands first.
    setTimeout(() => deliver(seen), 0)
  } else {
    limit = setTimeout(stop, SETUP_WATCH_LIMIT_MS)
  }
  return created
}
