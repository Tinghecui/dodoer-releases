// Same-origin portal links. Cowork's nginx answers both paths on every
// employee domain and redirects to the portal, so they work without knowing
// the portal's own hostname.
//
// A desktop window bound to a remote workspace has no portal session (it
// holds the workspace token itself), so there the account page opens in the
// system browser, on the workspace's own domain, and there is no sign-out.
//
// "Open in desktop app" asks cowork-web (via nginx, with the portal session
// cookie) for a one-time `codeg://cowork/connect` link and follows it; the
// desktop app takes over from there. Browser only: a desktop window already
// is the desktop app.

import { isDesktop, isRemoteDesktopWindow, openUrl } from "@/lib/platform"
import { getServerBaseUrl } from "@/lib/transport"
import { clearStoredToken } from "./sso"

export const COWORK_ACCOUNT_URL = "/_cowork/account"
export const COWORK_LOGOUT_URL = "/_cowork/logout"
export const COWORK_DESKTOP_LINK_URL = "/_cowork/desktop-link"

export function openCoworkAccount(): void {
  if (isRemoteDesktopWindow()) {
    void openUrl(`${getServerBaseUrl()}${COWORK_ACCOUNT_URL}`)
    return
  }
  window.location.assign(COWORK_ACCOUNT_URL)
}

/** Whether "sign out" means anything here (see the header comment). */
export function coworkCanSignOut(): boolean {
  return !isRemoteDesktopWindow()
}

export function coworkSignOut(): void {
  clearStoredToken()
  window.location.assign(COWORK_LOGOUT_URL)
}

/** Whether "open in desktop app" makes sense here (see the header comment). */
export function coworkCanOpenInDesktop(): boolean {
  return !isDesktop()
}

/**
 * Get a one-time desktop link and hand it to the OS. Rejects with the portal's
 * message (not signed in, not a codeg workspace, ...) for the caller to show.
 */
export async function openCoworkInDesktop(): Promise<void> {
  const res = await fetch(COWORK_DESKTOP_LINK_URL, {
    method: "POST",
    credentials: "same-origin",
    redirect: "manual",
    headers: { Accept: "application/json" },
  })
  const body = (await res.json().catch(() => null)) as {
    link?: unknown
    error?: { message?: unknown }
  } | null
  if (!res.ok) {
    const message = body?.error?.message
    throw new Error(
      typeof message === "string" && message ? message : `HTTP ${res.status}`
    )
  }
  const link = body?.link
  if (typeof link !== "string" || !link.startsWith("codeg://cowork/connect?")) {
    throw new Error("unexpected response")
  }
  window.location.assign(link)
}
