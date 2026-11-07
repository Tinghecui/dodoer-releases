// Cowork upgrade hint for the status-bar account menu.
//
// Behind the portal, nginx answers `GET /_cowork/upgrade` on every employee
// domain by asking cowork-web (with the portal session cookie) whether a newer
// cowork release exists. Only an admin (in personal mode: the one user) gets a
// hint; everyone else, and anyone not signed in, gets `null`. cowork-web
// serves a cached answer (it checks upstream every 6 hours), so polling here
// is cheap. Upgrading itself stays in the portal: the hint only links there.

import { useEffect, useSyncExternalStore } from "react"

export const COWORK_UPGRADE_URL = "/_cowork/upgrade"
export const UPGRADE_POLL_MS = 30 * 60_000
export const UPGRADE_RETRY_MS = 5 * 60_000

export interface CoworkUpgradeHint {
  current: string
  latest: string
  /** Portal page to upgrade from; absent when the portal hostname is unknown. */
  url: string | null
}

export function normalizeUpgradeHint(raw: unknown): CoworkUpgradeHint | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (r.newer !== true) return null
  if (typeof r.latest !== "string" || !r.latest) return null
  return {
    current: typeof r.current === "string" ? r.current : "",
    latest: r.latest,
    url:
      typeof r.url === "string" && /^https:\/\/\S+$/.test(r.url) ? r.url : null,
  }
}

// `undefined` = never fetched; `null` = nothing to upgrade (or not allowed).
let cached: CoworkUpgradeHint | null | undefined
let fetchedAt = 0
let lastFailed = false
let inflight: Promise<CoworkUpgradeHint | null> | null = null
const listeners = new Set<() => void>()

function publish(hint: CoworkUpgradeHint | null, failed: boolean) {
  cached = hint
  fetchedAt = Date.now()
  lastFailed = failed
  for (const listener of listeners) listener()
}

/** Ask the portal (via nginx) once; concurrent callers share the request. Never rejects. */
export function loadCoworkUpgradeHint(): Promise<CoworkUpgradeHint | null> {
  if (inflight) return inflight
  inflight = (async () => {
    const res = await fetch(COWORK_UPGRADE_URL, {
      credentials: "same-origin",
      redirect: "manual",
      headers: { Accept: "application/json" },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return normalizeUpgradeHint(await res.json())
  })()
    .then(
      (hint) => {
        publish(hint, false)
        return hint
      },
      () => {
        // No nginx in front (plain codeg), server restarting, network: keep
        // whatever we had and retry sooner than the regular poll.
        publish(cached ?? null, true)
        return cached ?? null
      }
    )
    .finally(() => {
      inflight = null
    })
  return inflight
}

export function getCachedCoworkUpgradeHint(): CoworkUpgradeHint | null {
  return cached ?? null
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

const getServerSnapshot = () => null

/**
 * React view of the hint. `enabled` (the server is Cowork behind the portal)
 * gates the fetch; while enabled it re-asks every 30 minutes, or 5 minutes
 * after a failure, and once more whenever the tab becomes visible again.
 */
export function useCoworkUpgradeHint(
  enabled: boolean
): CoworkUpgradeHint | null {
  const hint = useSyncExternalStore(
    subscribe,
    getCachedCoworkUpgradeHint,
    getServerSnapshot
  )
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const due = () =>
      cached === undefined ||
      Date.now() - fetchedAt >=
        (lastFailed ? UPGRADE_RETRY_MS : UPGRADE_POLL_MS)
    const schedule = () => {
      if (cancelled) return
      if (timer !== undefined) clearTimeout(timer)
      const wait = Math.max(
        0,
        fetchedAt +
          (lastFailed ? UPGRADE_RETRY_MS : UPGRADE_POLL_MS) -
          Date.now()
      )
      timer = setTimeout(tick, cached === undefined ? 0 : wait)
    }
    const tick = () => {
      timer = undefined
      if (cancelled) return
      if (!due()) return schedule()
      void loadCoworkUpgradeHint().then(schedule)
    }
    const onVisible = () => {
      if (document.visibilityState === "visible" && due()) tick()
    }
    document.addEventListener("visibilitychange", onVisible)
    schedule()
    return () => {
      cancelled = true
      if (timer !== undefined) clearTimeout(timer)
      document.removeEventListener("visibilitychange", onVisible)
    }
  }, [enabled])
  return enabled ? hint : null
}

/** Full-page navigation to the portal's upgrade page. */
export function openCoworkUpgrade(hint: CoworkUpgradeHint): void {
  if (hint.url) window.location.assign(hint.url)
}

/** Test hook: forget the cached hint. */
export function resetCoworkUpgradeForTests(
  hint?: CoworkUpgradeHint | null
): void {
  cached = hint
  fetchedAt = hint === undefined ? 0 : Date.now()
  lastFailed = false
  inflight = null
}
