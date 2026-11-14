import { create } from "zustand"
import { samePrStatus } from "@/lib/pr-status"
import type {
  ConversationPrStatusEntry,
  FolderPrStatus,
  FolderPrStatusEntry,
} from "@/lib/types"

/**
 * Pull-request status per worktree folder — and per conversation outside
 * worktrees, whose agent may have made one itself — for the sidebar rows and
 * their hover bubble. Fed by `PrStatusPoller` (the backend's cached answers
 * plus its `folder://pr-status` / `conversation://pr-status` pushes);
 * client-only and not persisted.
 *
 * Its own store rather than a slice of the workspace store: a row subscribes
 * to its folder's entry here, and this store only changes when a status does —
 * not on every conversation upsert.
 */
interface PrStatusState {
  byFolder: ReadonlyMap<number, FolderPrStatus>
  byConversation: ReadonlyMap<number, FolderPrStatus>
  /** The sidebar's "Show pull request status" toggle (persisted). */
  enabled: boolean
}

const ENABLED_KEY = "workspace:sidebar-show-pr-status"

export const usePrStatusStore = create<PrStatusState>(() => ({
  byFolder: new Map(),
  byConversation: new Map(),
  // On by default; the sidebar's mount effect applies a stored "off".
  enabled: true,
}))

/** Merge entries in, keeping the old object for an unchanged folder so its
 *  row does not re-render. A no-op when nothing changed. */
export function applyPrStatuses(entries: readonly FolderPrStatusEntry[]): void {
  const next = merged(
    usePrStatusStore.getState().byFolder,
    entries.map((entry) => [entry.folder_id, entry.status] as const)
  )
  if (next) usePrStatusStore.setState({ byFolder: next })
}

export function applyConversationPrStatuses(
  entries: readonly ConversationPrStatusEntry[]
): void {
  const next = merged(
    usePrStatusStore.getState().byConversation,
    entries.map((entry) => [entry.conversation_id, entry.status] as const)
  )
  if (next) usePrStatusStore.setState({ byConversation: next })
}

/** `prev` with `entries` merged in, or `null` when nothing changed. */
function merged(
  prev: ReadonlyMap<number, FolderPrStatus>,
  entries: readonly (readonly [number, FolderPrStatus])[]
): Map<number, FolderPrStatus> | null {
  let next: Map<number, FolderPrStatus> | null = null
  for (const [id, status] of entries) {
    const have = (next ?? prev).get(id)
    if (have && samePrStatus(have, status)) continue
    next ??= new Map(prev)
    next.set(id, status)
  }
  return next
}

/** The row's status: its worktree folder's, else the conversation's own (the
 *  poller asks about one or the other, never both). */
export function usePrStatus(
  folderId: number | null | undefined,
  conversationId?: number | null
): FolderPrStatus | undefined {
  return usePrStatusStore((s) => {
    if (!s.enabled) return undefined
    const folder = folderId == null ? undefined : s.byFolder.get(folderId)
    if (folder) return folder
    return conversationId == null
      ? undefined
      : s.byConversation.get(conversationId)
  })
}

export function loadPrStatusEnabled(): boolean {
  if (typeof window === "undefined") return true
  try {
    return localStorage.getItem(ENABLED_KEY) !== "false"
  } catch {
    return true
  }
}

export function setPrStatusEnabled(enabled: boolean): void {
  usePrStatusStore.setState({ enabled })
  try {
    localStorage.setItem(ENABLED_KEY, String(enabled))
  } catch {
    /* ignore */
  }
}
