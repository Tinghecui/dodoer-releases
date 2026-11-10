import { create } from "zustand"
import { samePrStatus } from "@/lib/pr-status"
import type { FolderPrStatus, FolderPrStatusEntry } from "@/lib/types"

/**
 * Pull-request status per worktree folder, for the sidebar rows and their
 * hover bubble. Fed by `PrStatusPoller` (the backend's cached answers plus its
 * `folder://pr-status` pushes); client-only and not persisted.
 *
 * Its own store rather than a slice of the workspace store: a row subscribes
 * to its folder's entry here, and this store only changes when a status does —
 * not on every conversation upsert.
 */
interface PrStatusState {
  byFolder: ReadonlyMap<number, FolderPrStatus>
  /** The sidebar's "Show pull request status" toggle (persisted). */
  enabled: boolean
}

const ENABLED_KEY = "workspace:sidebar-show-pr-status"

export const usePrStatusStore = create<PrStatusState>(() => ({
  byFolder: new Map(),
  // On by default; the sidebar's mount effect applies a stored "off".
  enabled: true,
}))

/** Merge entries in, keeping the old object for an unchanged folder so its
 *  row does not re-render. A no-op when nothing changed. */
export function applyPrStatuses(entries: readonly FolderPrStatusEntry[]): void {
  const prev = usePrStatusStore.getState().byFolder
  let next: Map<number, FolderPrStatus> | null = null
  for (const entry of entries) {
    const have = (next ?? prev).get(entry.folder_id)
    if (have && samePrStatus(have, entry.status)) continue
    next ??= new Map(prev)
    next.set(entry.folder_id, entry.status)
  }
  if (next) usePrStatusStore.setState({ byFolder: next })
}

export function usePrStatus(
  folderId: number | null | undefined
): FolderPrStatus | undefined {
  return usePrStatusStore((s) =>
    folderId == null || !s.enabled ? undefined : s.byFolder.get(folderId)
  )
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
