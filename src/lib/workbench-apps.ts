import type { BrowserWorkspaceTab } from "@/contexts/workspace-context"
import { DEFAULT_BROWSER_PROFILE_ID } from "@/lib/browser/browser-prefs"
import { isRemoteHostAddress } from "@/lib/browser/remote-host"
import { buildFileTabId } from "@/lib/file-tab-id"
import type {
  WorkbenchApp,
  WorkbenchAppLaunch,
  WorkbenchAppStatus,
} from "@/lib/types"
import { randomUUID } from "@/lib/utils"

/** Backend events (`workbench_apps::STATUS_EVENT` / `CHANGED_EVENT`). */
export const WORKBENCH_APPS_STATUS_EVENT = "workbench-apps://status"
export const WORKBENCH_APPS_CHANGED_EVENT = "workbench-apps://changed"

/** Mirrors the backend's caps (`workbench_apps::config`), so the form stops
 *  where a save would be refused instead of failing on submit. */
export const APP_NAME_MAX = 80
export const APP_URL_MAX = 2048
export const APP_COMMAND_MAX = 4096
export const APP_DIR_MAX = 1024
export const MAX_APPS = 32

/** How an app reads at a glance, from its status. */
export type AppDisplayState =
  /** Something answers at its address. */
  | "running"
  /** codeg started it and is waiting for the address to answer. */
  | "starting"
  /** codeg's process runs, but the address does not answer. */
  | "notAnswering"
  /** Ended on its own. */
  | "exited"
  /** Could not be started, or kept failing. */
  | "failed"
  /** Nothing answers and codeg runs nothing for it. */
  | "stopped"
  /** No status has arrived yet. */
  | "unknown"

export function appDisplayState(
  status: WorkbenchAppStatus | undefined
): AppDisplayState {
  if (!status) return "unknown"
  if (status.reachable) return "running"
  switch (status.process) {
    case "starting":
      return "starting"
    case "running":
      return "notAnswering"
    case "exited":
      return "exited"
    case "failed":
      return "failed"
    default:
      return "stopped"
  }
}

/** Whether codeg can start the app's service (it has a command). */
export function appStartable(app: Pick<WorkbenchApp, "startCommand">) {
  return !!app.startCommand?.trim()
}

/** FNV-1a, 32 bits, hex: a short stable tag for an address. */
function shortHash(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * The built-in browser surface an app's page lives in. Its address is part of
 * the name: a surface is built for one page, so an app whose address changed
 * gets a new surface (and the old one is closed, see `staleAppSurfaces`)
 * rather than a navigation that history and Back could undo. Fits the
 * backend's tab id rule (`[A-Za-z0-9_-]{1,64}`).
 */
export function appSurfaceId(app: Pick<WorkbenchApp, "id" | "url">): string {
  return `app-${app.id}-${shortHash(app.url)}`
}

/**
 * The browser-tab record an app's page is shown through. It is not one of the
 * workspace's file tabs — the Apps page owns it — but it is the same shape, so
 * the built-in browser's view (native surface on the desktop, port bridge in
 * a browser) shows it unchanged. A loopback address seen from a window bound
 * to a remote codeg-server is that server's, so the page loads through it.
 */
export function appBrowserTab(app: WorkbenchApp): BrowserWorkspaceTab {
  const remote = isRemoteHostAddress(app.url)
  return {
    id: buildFileTabId({ kind: "browser", id: appSurfaceId(app) }),
    kind: "browser",
    folderId: null,
    title: app.name,
    description: null,
    path: null,
    language: "browser",
    content: "",
    loading: false,
    browser: {
      initialUrl: app.url,
      openerTabId: null,
      profile: DEFAULT_BROWSER_PROFILE_ID,
      ...(remote ? { remote: true as const } : {}),
    },
  }
}

/** The surfaces of `before` that `after` no longer shows: apps removed, or
 *  given another address. Their pages are closed when the list is saved. */
export function staleAppSurfaces(
  before: readonly WorkbenchApp[],
  after: readonly WorkbenchApp[]
): string[] {
  const kept = new Set(after.map(appSurfaceId))
  return before.map(appSurfaceId).filter((id) => !kept.has(id))
}

/** A fresh app id: lowercase hex, as the backend's id rule wants. */
export function newAppId(): string {
  return `app-${randomUUID().replace(/-/g, "").slice(0, 12).toLowerCase()}`
}

/** `host:port` of an address, for the list's second line. */
export function appAddressLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return parsed.host + (parsed.pathname === "/" ? "" : parsed.pathname)
  } catch {
    return url
  }
}

/** What a form submits: the user's text, before the backend normalizes it. */
export interface AppFormValues {
  name: string
  url: string
  startCommand: string
  workingDir: string
  launch: WorkbenchAppLaunch
}

export type AppFormError = "nameRequired" | "urlRequired" | "urlInvalid"

/** The first thing wrong with a form, checked as the backend will check it. */
export function validateAppForm(values: AppFormValues): AppFormError | null {
  if (!values.name.trim()) return "nameRequired"
  const url = values.url.trim()
  if (!url) return "urlRequired"
  try {
    const parsed = new URL(normalizeAppUrl(url))
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      !parsed.hostname
    ) {
      return "urlInvalid"
    }
  } catch {
    return "urlInvalid"
  }
  return null
}

/** An address typed without a scheme (`127.0.0.1:7500`) is an http one: these
 *  are local services, and a bare `host:port` would otherwise parse as a URL
 *  whose scheme is the host. */
export function normalizeAppUrl(raw: string): string {
  const trimmed = raw.trim()
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
    ? trimmed
    : `http://${trimmed}`
}

/** The app a form describes, keeping `id` (a new one for a new app). */
export function appFromForm(id: string, values: AppFormValues): WorkbenchApp {
  const startCommand = values.startCommand.trim()
  const workingDir = values.workingDir.trim()
  return {
    id,
    name: values.name.trim(),
    url: normalizeAppUrl(values.url),
    startCommand: startCommand || null,
    workingDir: workingDir || null,
    launch: values.launch,
  }
}
