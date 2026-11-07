import { create } from "zustand"

import type {
  WorkbenchApp,
  WorkbenchAppStatus,
  WorkbenchAppsSnapshot,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/**
 * The Apps page: the saved list, every app's live status, and which app is on
 * screen.
 *
 * The list arrives whole (a read, or `workbench-apps://changed` after any
 * window saves) and statuses arrive whole too (`workbench-apps://status`), so
 * each replaces what was there; there is nothing to merge. Session memory
 * only — which app is selected, and which have been opened — so leaving the
 * page and coming back finds it as it was, while a restart begins at the
 * first app.
 */
interface WorkbenchAppsState {
  apps: readonly WorkbenchApp[]
  statuses: Readonly<Record<string, WorkbenchAppStatus>>
  /** The first list landed. */
  hydrated: boolean
  /** Why the last list read failed, while nothing newer has loaded. */
  loadError: string | null
  /** The app on screen; the first one when nothing was picked. */
  selectedId: string | null
  /** Apps whose page has been on screen this session. Their pages stay loaded
   *  while another app is shown, as a browser keeps its tabs. */
  openedIds: readonly string[]
  /** jenny fork: the app list on the page's right is shown (else folded
   *  away). Remembered per browser, like the sidebar's own open state. */
  listOpen: boolean
  toggleList: () => void
  applySnapshot: (snapshot: WorkbenchAppsSnapshot) => void
  applyStatuses: (statuses: readonly WorkbenchAppStatus[]) => void
  applyStatus: (status: WorkbenchAppStatus) => void
  setLoadError: (message: string | null) => void
  select: (id: string) => void
  reset: () => void
}

function byId(
  statuses: readonly WorkbenchAppStatus[]
): Record<string, WorkbenchAppStatus> {
  const out: Record<string, WorkbenchAppStatus> = {}
  for (const status of statuses) out[status.id] = status
  return out
}

/** The selection, kept when its app still exists, else the first app. */
function keepSelection(
  apps: readonly WorkbenchApp[],
  selectedId: string | null
): string | null {
  if (selectedId && apps.some((app) => app.id === selectedId)) return selectedId
  return apps[0]?.id ?? null
}

const LIST_OPEN_KEY = "jenny:apps-list-open"

function readListOpen(): boolean {
  try {
    return localStorage.getItem(LIST_OPEN_KEY) !== "0"
  } catch {
    return true
  }
}

function writeListOpen(open: boolean): void {
  try {
    localStorage.setItem(LIST_OPEN_KEY, open ? "1" : "0")
  } catch {
    // Storage blocked: the fold still works for this session.
  }
}

const INITIAL = {
  apps: [] as readonly WorkbenchApp[],
  statuses: {} as Readonly<Record<string, WorkbenchAppStatus>>,
  hydrated: false,
  loadError: null as string | null,
  selectedId: null as string | null,
  openedIds: [] as readonly string[],
}

export const useWorkbenchAppsStore = create<WorkbenchAppsState>((set) => ({
  ...INITIAL,
  listOpen: readListOpen(),
  toggleList: () =>
    set((state) => {
      writeListOpen(!state.listOpen)
      return { listOpen: !state.listOpen }
    }),
  applySnapshot: (snapshot) =>
    set((state) => {
      const ids = new Set(snapshot.apps.map((app) => app.id))
      return {
        apps: snapshot.apps,
        statuses: byId(snapshot.statuses),
        hydrated: true,
        loadError: null,
        selectedId: keepSelection(snapshot.apps, state.selectedId),
        openedIds: state.openedIds.filter((id) => ids.has(id)),
      }
    }),
  applyStatuses: (statuses) => set({ statuses: byId(statuses) }),
  applyStatus: (status) =>
    set((state) => ({
      statuses: { ...state.statuses, [status.id]: status },
    })),
  setLoadError: (message) => set({ loadError: message }),
  select: (id) =>
    set((state) =>
      state.apps.some((app) => app.id === id) ? { selectedId: id } : {}
    ),
  reset: () => set(INITIAL),
}))

/** Mark `id`'s page as opened (it then stays loaded); a no-op when it is. */
export function markAppOpened(id: string): void {
  const { openedIds } = useWorkbenchAppsStore.getState()
  if (openedIds.includes(id)) return
  useWorkbenchAppsStore.setState({ openedIds: [...openedIds, id] })
}

registerBackendScopedStoreReset(() => useWorkbenchAppsStore.getState().reset())
