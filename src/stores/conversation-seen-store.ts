import { create } from "zustand"
import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { DbConversationSummary } from "@/lib/types"

// Sidebar "unread" tracking (jenny fork).
//
// A root conversation is UNREAD when its turn has ended (`pending_review` or
// `cancelled`) after the user last accepted it. "Last accepted" is a
// per-conversation timestamp kept in localStorage, so unread survives an app
// restart, and turns that ended while the app was closed are still caught on
// the next start (their `updated_at` is newer than the stored timestamp).
//
// Opening or viewing a conversation does NOT clear unread: only the sidebar
// context menu's "Accepted" action does (`markConversationAccepted`). The
// conversation on screen shows its unread marker like any other.
//
// The user can also mark a conversation unread by hand (sidebar menu or the
// `toggle_conversation_unread` shortcut). That mark holds whatever the status
// and likewise clears only on "Accepted".
//
// Nothing here touches the database: the fork must stay migration-compatible
// with the official build of the same version.

const STORAGE_PREFIX = "jenny:conversation-seen:v1"
/** Upper bound on stored entries; the oldest timestamps are dropped first. */
const MAX_ENTRIES = 3000

export const UNREAD_STATUSES: ReadonlySet<string> = new Set([
  "pending_review",
  "cancelled",
])

interface PersistedSeen {
  /** When unread tracking first ran for this backend. Conversations that
   *  finished before it (and were never viewed since) are not unread. */
  baselineAt: number
  /** Conversation id → epoch ms of the last time the user accepted it. */
  seen: Record<string, number>
  /** Conversation id → epoch ms it was marked unread by hand. Optional so
   *  data written before this field existed still loads. */
  markedUnread?: Record<string, number>
}

interface ConversationSeenState {
  /** Storage scope the data below belongs to (one per backend connection). */
  scope: string | null
  baselineAt: number
  seen: Record<string, number>
  markedUnread: Record<string, number>
}

export const useConversationSeenStore = create<ConversationSeenState>(() => ({
  scope: null,
  baselineAt: Date.now(),
  seen: {},
  markedUnread: {},
}))

function currentScope(): string {
  const remoteId = getActiveRemoteConnectionId()
  return `${STORAGE_PREFIX}:${remoteId == null ? "local" : `remote-${remoteId}`}`
}

function readTimes(value: unknown): Record<string, number> {
  const times: Record<string, number> = {}
  if (value && typeof value === "object") {
    for (const [id, at] of Object.entries(value)) {
      if (typeof at === "number" && Number.isFinite(at)) times[id] = at
    }
  }
  return times
}

function readPersisted(scope: string): Required<PersistedSeen> | null {
  try {
    const raw = localStorage.getItem(scope)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<PersistedSeen>
    if (typeof parsed.baselineAt !== "number") return null
    return {
      baselineAt: parsed.baselineAt,
      seen: readTimes(parsed.seen),
      markedUnread: readTimes(parsed.markedUnread),
    }
  } catch {
    return null
  }
}

function writePersisted(scope: string, data: PersistedSeen): void {
  try {
    localStorage.setItem(scope, JSON.stringify(data))
  } catch {
    // Storage full or unavailable: unread still works for this session.
  }
}

/** Load the stored data for the active backend once (and again if the
 *  backend changes). Safe to call often. */
export function ensureSeenHydrated(): void {
  const scope = currentScope()
  if (useConversationSeenStore.getState().scope === scope) return
  const stored = readPersisted(scope)
  if (stored) {
    useConversationSeenStore.setState({ scope, ...stored })
    return
  }
  const fresh: Required<PersistedSeen> = {
    baselineAt: Date.now(),
    seen: {},
    markedUnread: {},
  }
  writePersisted(scope, fresh)
  useConversationSeenStore.setState({ scope, ...fresh })
}

export function pruneSeen(
  seen: Record<string, number>,
  max: number = MAX_ENTRIES
): Record<string, number> {
  const entries = Object.entries(seen)
  if (entries.length <= max) return seen
  entries.sort((a, b) => b[1] - a[1])
  return Object.fromEntries(entries.slice(0, max))
}

function parseTime(iso: string | null | undefined): number {
  if (!iso) return 0
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

/** Stamp `conversationId` as seen as of now (or as of its
 *  `updatedAt`, if that is later — guards against clock skew with a remote
 *  backend). */
export function markConversationSeen(
  conversationId: number,
  updatedAt?: string | null
): void {
  ensureSeenHydrated()
  const state = useConversationSeenStore.getState()
  const at = Math.max(Date.now(), parseTime(updatedAt))
  const key = String(conversationId)
  if ((state.seen[key] ?? 0) >= at) return
  const seen = pruneSeen({ ...state.seen, [key]: at })
  useConversationSeenStore.setState({ seen })
  persist()
}

function persist(): void {
  const { scope, baselineAt, seen, markedUnread } =
    useConversationSeenStore.getState()
  if (scope) writePersisted(scope, { baselineAt, seen, markedUnread })
}

/** Mark a conversation unread by hand. */
export function markConversationUnread(conversationId: number): void {
  ensureSeenHydrated()
  const key = String(conversationId)
  const { markedUnread } = useConversationSeenStore.getState()
  if (markedUnread[key] != null) return
  useConversationSeenStore.setState({
    markedUnread: pruneSeen({ ...markedUnread, [key]: Date.now() }),
  })
  persist()
}

/** Drop a hand-set unread mark. Does not stamp the conversation as seen. */
export function clearConversationUnreadMark(conversationId: number): void {
  ensureSeenHydrated()
  const key = String(conversationId)
  const { markedUnread } = useConversationSeenStore.getState()
  if (markedUnread[key] == null) return
  const next = { ...markedUnread }
  delete next[key]
  useConversationSeenStore.setState({ markedUnread: next })
  persist()
}

/** "Accepted": the only action that clears unread. Drops the hand-set mark
 *  and stamps the conversation as seen, so it turns unread again only when a
 *  later turn ends. */
export function markConversationAccepted(
  conversationId: number,
  updatedAt?: string | null
): void {
  clearConversationUnreadMark(conversationId)
  markConversationSeen(conversationId, updatedAt)
}

/** Whether a conversation is unread right now (reads the live store). */
export function isConversationUnreadNow(conv: UnreadInput): boolean {
  ensureSeenHydrated()
  return isConversationUnread(conv, useConversationSeenStore.getState())
}

/** Run a user edit (rename, status set by hand) that bumps `updated_at`
 *  without turning the row unread: a conversation that was read stays read,
 *  and one that was unread stays unread until it is accepted. */
export async function withoutUnreadChange(
  conv: UnreadInput,
  edit: () => Promise<void>
): Promise<void> {
  const wasUnread = isConversationUnreadNow(conv)
  await edit()
  if (!wasUnread) markConversationSeen(conv.id)
}

type UnreadInput = Pick<
  DbConversationSummary,
  "id" | "status" | "updated_at" | "parent_id"
>

type SeenSnapshot = Pick<
  ConversationSeenState,
  "baselineAt" | "seen" | "markedUnread"
>

export function isConversationUnread(
  conv: UnreadInput,
  state: SeenSnapshot
): boolean {
  if (conv.parent_id != null) return false
  if (state.markedUnread[String(conv.id)] != null) return true
  if (!UNREAD_STATUSES.has(conv.status)) return false
  const seenAt = state.seen[String(conv.id)] ?? state.baselineAt
  return parseTime(conv.updated_at) > seenAt
}

/** Unread root conversations per display group (folder id after mapping a
 *  worktree child to its parent, when the caller wants that). */
export function countUnreadByGroup(
  conversations: readonly (UnreadInput & { folder_id: number })[],
  state: SeenSnapshot,
  groupOf: (folderId: number) => number = (id) => id
): Map<number, number> {
  const map = new Map<number, number>()
  for (const conv of conversations) {
    if (!isConversationUnread(conv, state)) continue
    const groupId = groupOf(conv.folder_id)
    map.set(groupId, (map.get(groupId) ?? 0) + 1)
  }
  return map
}

/** Hook: whether one conversation is unread. Re-renders only when the
 *  boolean flips. */
export function useIsConversationUnread(conv: UnreadInput): boolean {
  return useConversationSeenStore((s) => isConversationUnread(conv, s))
}
