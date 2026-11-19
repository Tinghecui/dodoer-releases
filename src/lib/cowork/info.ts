// Cowork mode detection and the two Cowork-only server endpoints.
//
// `POST /api/cowork_info` exists only on the Cowork build of codeg-server.
// On an upstream server the call fails and every Cowork feature stays hidden,
// so the UI degrades to plain codeg. The local desktop workspace never asks
// for these (its backend is this machine, not a Cowork server) — except for
// its telemetry alone (`loadLocalDaemonTelemetry`); a desktop window bound to
// a remote workspace asks that server, like the browser does.

import { useEffect, useSyncExternalStore } from "react"
import { extractAppCommandError } from "@/lib/app-error"
import { isDesktop, isRemoteDesktopWindow } from "@/lib/platform"
import { normalizeClientTelemetry, type ClientTelemetry } from "@/lib/telemetry"
import { getTransport } from "@/lib/transport"
import { PRODUCT_NAME } from "@/lib/cowork/brand"
import { isLocalChildDaemon } from "@/lib/transport/local-daemon"
import {
  getWebConnectionSnapshot,
  subscribeWebConnection,
} from "@/lib/transport/web-connection-store"
import type { FolderDetail } from "@/lib/types"

export interface CoworkInfo {
  product: string
  /** Absolute directory new projects are created in, if configured. */
  projectsRoot: string | null
  /** Served behind the Cowork portal (account menu, SSO). */
  portal: boolean
  updateDisabled: boolean
  /** Present when the server reports to Sentry (`CODEG_TELEMETRY_WEB_DSN`). */
  telemetry?: ClientTelemetry
}

export function normalizeCoworkInfo(raw: unknown): CoworkInfo | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const root =
    typeof r.projectsRoot === "string" && r.projectsRoot.trim()
      ? r.projectsRoot
      : null
  const telemetry = normalizeClientTelemetry(r.telemetry)
  return {
    product:
      typeof r.product === "string" && r.product ? r.product : PRODUCT_NAME,
    projectsRoot: root,
    portal: r.portal === true,
    updateDisabled: r.updateDisabled === true,
    ...(telemetry && { telemetry }),
  }
}

// `undefined` = not loaded yet; `null` = not a Cowork server.
let cached: CoworkInfo | null | undefined
let inflight: Promise<CoworkInfo | null> | null = null
const listeners = new Set<() => void>()

function publish(info: CoworkInfo | null) {
  cached = info
  for (const listener of listeners) listener()
}

/** Fetch (once) and cache the server's Cowork info. Never rejects. */
export function loadCoworkInfo(): Promise<CoworkInfo | null> {
  if (cached !== undefined) return Promise.resolve(cached)
  if (inflight) return inflight
  inflight = (async () => {
    if (isDesktop() && !isRemoteDesktopWindow()) return null
    return normalizeCoworkInfo(
      await getTransport().call<unknown>("cowork_info", {})
    )
  })()
    .then(
      (info) => {
        publish(info)
        return info
      },
      (err: unknown) => {
        // An upstream server answers 501 not_implemented: definitely not
        // Cowork, stop asking. Anything else (server restarting, network)
        // leaves the cache empty so `useCoworkInfo` retries; features (the
        // account menu with Sign out among them) stay hidden until then.
        if ((err as { code?: unknown } | null)?.code === "not_implemented") {
          publish(null)
        }
        return null
      }
    )
    .finally(() => {
      inflight = null
    })
  return inflight
}

/**
 * Where a local window of the desktop app reports (docs/telemetry.md §5.11):
 * `cowork_info.telemetry` of the app's own daemon, the `codeg-server` child,
 * and nothing else of `cowork_info` — the local workspace is not a Cowork
 * server's, so no other Cowork feature applies to it. Null outside such a
 * window (the browser, remote windows, an in-process daemon) and when the
 * daemon does not report (a build without DSNs, or diagnostics turned off).
 * Rejects when the daemon could not be asked, so the caller can try again.
 */
export async function loadLocalDaemonTelemetry(): Promise<ClientTelemetry | null> {
  if (!isDesktop() || isRemoteDesktopWindow() || !isLocalChildDaemon()) {
    return null
  }
  const raw = await getTransport().call<unknown>("cowork_info", {})
  return normalizeCoworkInfo(raw)?.telemetry ?? null
}

/** Last loaded value, or null while unknown / not Cowork. */
export function getCachedCoworkInfo(): CoworkInfo | null {
  return cached ?? null
}

/** Whether the server has answered: `getCachedCoworkInfo()` is null both
 *  while unknown (not loaded, or the last load failed) and for a server that
 *  is not Cowork; this tells the two apart. */
export function isCoworkInfoLoaded(): boolean {
  return cached !== undefined
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getServerSnapshot = () => null

/** Call `cb` whenever the web transport reports it is connected again. */
function onReconnect(cb: () => void): () => void {
  try {
    return subscribeWebConnection(() => {
      try {
        if (getWebConnectionSnapshot() === "connected") cb()
      } catch {
        // Transport gone mid-flight: the backoff timer still retries.
      }
    })
  } catch {
    // No web transport here (desktop shell, stubbed transport in tests).
    return () => {}
  }
}

export const INFO_RETRY_MIN_MS = 2_000
export const INFO_RETRY_MAX_MS = 60_000

/**
 * React view of the Cowork info; triggers the load on first use and, while
 * it keeps failing, retries with backoff and whenever the web connection
 * comes back.
 */
export function useCoworkInfo(): CoworkInfo | null {
  const info = useSyncExternalStore(
    subscribe,
    getCachedCoworkInfo,
    getServerSnapshot
  )
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let delay = INFO_RETRY_MIN_MS
    const attempt = () => {
      timer = undefined
      void loadCoworkInfo().then(() => {
        if (cancelled || cached !== undefined || timer !== undefined) return
        timer = setTimeout(attempt, delay)
        delay = Math.min(delay * 2, INFO_RETRY_MAX_MS)
      })
    }
    attempt()
    const unsubscribe = onReconnect(() => {
      if (cancelled || cached !== undefined) return
      if (timer !== undefined) clearTimeout(timer)
      delay = INFO_RETRY_MIN_MS
      attempt()
    })
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      unsubscribe()
    }
  }, [])
  return info
}

/**
 * The cached info as React state, WITHOUT starting a load: for surfaces that
 * only adjust what they say once something else (the account menu, mounted
 * whenever the portal is) has loaded it. Null while unknown / not Cowork.
 */
export function useCachedCoworkInfo(): CoworkInfo | null {
  return useSyncExternalStore(subscribe, getCachedCoworkInfo, getServerSnapshot)
}

/**
 * `isCoworkInfoLoaded()` as React state, WITHOUT starting a load (pair it with
 * `useCoworkInfo`). Its own snapshot, because `useCoworkInfo` stays `null`
 * when an upstream server's 501 turns "unknown" into "not Cowork" and so
 * would not re-render on that.
 */
export function useCoworkInfoLoaded(): boolean {
  return useSyncExternalStore(subscribe, isCoworkInfoLoaded, () => false)
}

/** Test hook: forget the cached info. */
export function resetCoworkInfoForTests(info?: CoworkInfo | null): void {
  cached = info
  inflight = null
}

export type ProjectNameIssue = "empty" | "invalid"

/** Client-side mirror of the server's checks; the server stays authoritative. */
export function validateProjectName(name: string): ProjectNameIssue | null {
  const trimmed = name.trim()
  if (!trimmed) return "empty"
  // A leading "." also covers "." and "..": no hidden directories.
  if (/[/\\\0]/.test(trimmed) || trimmed.startsWith(".")) {
    return "invalid"
  }
  return null
}

/**
 * Create `<projectsRoot>/<name>` on the server (a new git repository) and
 * open it as a workspace folder (the server does both, like `open_folder`).
 * Rejects when the name is taken: see `isProjectExistsError`.
 */
export function coworkCreateProject(name: string): Promise<FolderDetail> {
  return getTransport().call<FolderDetail>("cowork_create_project", {
    name: name.trim(),
  })
}

// Must mirror `PROJECT_EXISTS_I18N_KEY` in src-tauri/src/cowork.rs.
export const PROJECT_EXISTS_I18N_KEY = "cowork.projectExists"

/**
 * Whether `coworkCreateProject` failed because a project directory of that
 * name already exists (409; the server no longer reuses it).
 */
export function isProjectExistsError(error: unknown): boolean {
  return extractAppCommandError(error)?.i18n_key === PROJECT_EXISTS_I18N_KEY
}
