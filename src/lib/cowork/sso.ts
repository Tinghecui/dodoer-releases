// Portal single sign-on behind the Cowork reverse proxy.
//
// Cowork puts codeg-server behind nginx, which authenticates the browser
// against the portal session (auth_request) and then overwrites the
// `Authorization` header — and, for WebSocket upgrades, the
// `Sec-WebSocket-Protocol` header — with the employee's real token. The
// browser therefore never learns the token: it stores a fixed placeholder and
// sends that everywhere. Without the proxy the placeholder is simply rejected
// (401) and the regular token login form takes over.

export const COWORK_SSO_TOKEN = "cowork-sso"

const TOKEN_KEY = "codeg_token"

/**
 * Outcome of the credential-less probe: `ok` (a proxy injected a valid token;
 * the placeholder is stored), `denied` (401 / 403 / a redirect: no proxy, or
 * the portal session is gone), or `unavailable` (network error, 5xx, anything
 * else: the server may just be restarting).
 */
export type SsoProbe = "ok" | "denied" | "unavailable"

/**
 * Probe `/api/health` WITHOUT credentials. A 200 with the health payload can
 * only happen when a proxy injected a valid token, so store the placeholder
 * and report success. Redirects are not followed: an expired portal session
 * may bounce to the portal's own login page, whose 200 must not count.
 */
export async function probeCoworkSso(): Promise<SsoProbe> {
  let res: Response
  try {
    res = await fetch("/api/health", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
      credentials: "same-origin",
      redirect: "manual",
    })
  } catch {
    return "unavailable"
  }
  if (
    res.type === "opaqueredirect" ||
    res.status === 401 ||
    res.status === 403 ||
    (res.status >= 300 && res.status < 400)
  ) {
    return "denied"
  }
  if (!res.ok) return "unavailable"
  const body = (await res.json().catch(() => null)) as {
    status?: unknown
  } | null
  if (!body || body.status !== "ok") return "unavailable"
  try {
    localStorage.setItem(TOKEN_KEY, COWORK_SSO_TOKEN)
  } catch {
    return "unavailable"
  }
  return "ok"
}

export async function tryCoworkSso(): Promise<boolean> {
  return (await probeCoworkSso()) === "ok"
}

const BOUNCE_KEY = "cowork_sso_bounce"
/** A second denial this soon after sending the user to the portal = no loop. */
export const PORTAL_BOUNCE_WINDOW_MS = 2 * 60 * 1000

/**
 * What /login does when SSO did not succeed. Cowork users never see the
 * server's access token, so in a Cowork build a denied probe (portal session
 * expired, or never signed in) goes to the portal, which signs them in again;
 * the token form stays reachable at `/login?token`. The form is shown instead
 * for an upstream-named build, an explicit `?token`, a server that is down
 * (`unavailable`), or when the portal already sent the user back here within
 * {@link PORTAL_BOUNCE_WINDOW_MS} without a working session (no redirect loop).
 */
export function ssoFallback(
  probe: SsoProbe,
  opts: {
    coworkBuild: boolean
    manualToken: boolean
    lastBounce: number | null
    now: number
  }
): "portal" | "form" {
  if (probe !== "denied" || !opts.coworkBuild || opts.manualToken) return "form"
  if (
    opts.lastBounce !== null &&
    opts.now - opts.lastBounce < PORTAL_BOUNCE_WINDOW_MS
  )
    return "form"
  return "portal"
}

export function lastPortalBounce(): number | null {
  try {
    const raw = sessionStorage.getItem(BOUNCE_KEY)
    const at = raw ? Number(raw) : NaN
    return Number.isFinite(at) ? at : null
  } catch {
    return null
  }
}

/** Full-page navigation to the portal (same-origin path nginx redirects). */
export function sendToPortalLogin(url: string): void {
  try {
    sessionStorage.setItem(BOUNCE_KEY, String(Date.now()))
  } catch {
    // No session storage: the loop guard is off, the redirect still works.
  }
  window.location.assign(url)
}

/** Forget the stored token (real or placeholder). */
export function clearStoredToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY)
  } catch {
    // Storage can be unavailable (privacy mode); nothing to clear then.
  }
}
