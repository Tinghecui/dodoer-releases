// Cowork mode detection and the two Cowork-only server endpoints.
//
// `POST /api/cowork_info` exists only on the Cowork build of codeg-server.
// On an upstream server the call fails and every Cowork feature stays hidden,
// so the UI degrades to plain codeg. The local desktop workspace never asks
// (its backend is this machine, not a Cowork server); a desktop window bound
// to a remote workspace asks that server, like the browser does.

import { useEffect, useSyncExternalStore } from "react"
import { isDesktop, isRemoteDesktopWindow } from "@/lib/platform"
import { getTransport } from "@/lib/transport"
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
}

export function normalizeCoworkInfo(raw: unknown): CoworkInfo | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  const root =
    typeof r.projectsRoot === "string" && r.projectsRoot.trim()
      ? r.projectsRoot
      : null
  return {
    product: typeof r.product === "string" && r.product ? r.product : "Cowork",
    projectsRoot: root,
    portal: r.portal === true,
    updateDisabled: r.updateDisabled === true,
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

/** Last loaded value, or null while unknown / not Cowork. */
export function getCachedCoworkInfo(): CoworkInfo | null {
  return cached ?? null
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
 * Create `<projectsRoot>/<name>` on the server and open it as a workspace
 * folder (the server does both, like `open_folder`).
 */
export function coworkCreateProject(name: string): Promise<FolderDetail> {
  return getTransport().call<FolderDetail>("cowork_create_project", {
    name: name.trim(),
  })
}
