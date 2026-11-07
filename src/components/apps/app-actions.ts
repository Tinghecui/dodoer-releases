"use client"

import {
  listWorkbenchApps,
  restartWorkbenchApp,
  saveWorkbenchApps,
  startWorkbenchApp,
  stopWorkbenchApp,
} from "@/lib/api"
import {
  getBrowserTabState,
  releaseBrowserTab,
} from "@/lib/browser/browser-tab-store"
import { buildFileTabId } from "@/lib/file-tab-id"
import type { WorkbenchApp, WorkbenchAppsSnapshot } from "@/lib/types"
import { staleAppSurfaces } from "@/lib/workbench-apps"
import { useWorkbenchAppsStore } from "@/stores/workbench-apps-store"

/**
 * Take a list as the current one — from a read, another window's save
 * (`workbench-apps://changed`), or our own save's answer. The pages of apps
 * it no longer shows (removed, or moved to another address) are closed here,
 * so every window drops them, not only the one that saved.
 */
export function applyAppsSnapshot(snapshot: WorkbenchAppsSnapshot): void {
  const before = useWorkbenchAppsStore.getState().apps
  for (const surfaceId of staleAppSurfaces(before, snapshot.apps)) {
    const storeKey = buildFileTabId({ kind: "browser", id: surfaceId })
    if (getBrowserTabState(storeKey)) releaseBrowserTab(storeKey)
  }
  useWorkbenchAppsStore.getState().applySnapshot(snapshot)
}

/** Read the list and every status; failures are kept for the page to show. */
export async function refreshApps(): Promise<void> {
  try {
    applyAppsSnapshot(await listWorkbenchApps())
  } catch (error) {
    useWorkbenchAppsStore
      .getState()
      .setLoadError(error instanceof Error ? error.message : String(error))
    throw error
  }
}

/** Save `apps` as the whole list. */
export async function saveApps(apps: WorkbenchApp[]): Promise<void> {
  applyAppsSnapshot(await saveWorkbenchApps(apps))
}

/** The list with `app` in place of the one with its id, or added at the end. */
export function withApp(
  apps: readonly WorkbenchApp[],
  app: WorkbenchApp
): WorkbenchApp[] {
  const index = apps.findIndex((existing) => existing.id === app.id)
  if (index === -1) return [...apps, app]
  const next = [...apps]
  next[index] = app
  return next
}

/** The list without the app `id`. */
export function withoutApp(
  apps: readonly WorkbenchApp[],
  id: string
): WorkbenchApp[] {
  return apps.filter((app) => app.id !== id)
}

/** The list with app `id` moved `delta` places; the same list when it would
 *  fall off an end. */
export function movedApp(
  apps: readonly WorkbenchApp[],
  id: string,
  delta: number
): readonly WorkbenchApp[] {
  const from = apps.findIndex((app) => app.id === id)
  const to = from + delta
  if (from === -1 || to < 0 || to >= apps.length) return apps
  const next = [...apps]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}

/** Start / stop / restart an app's service. The answer is the app's status
 *  right away; the status events carry the rest (answering, exiting). */
export async function runAppAction(
  action: "start" | "stop" | "restart",
  id: string
): Promise<void> {
  const call =
    action === "start"
      ? startWorkbenchApp
      : action === "stop"
        ? stopWorkbenchApp
        : restartWorkbenchApp
  useWorkbenchAppsStore.getState().applyStatus(await call(id))
}
