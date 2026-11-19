// Sign-in links: `/login?token=<access token>` signs the browser in (#74).
// For deployments without the Cowork portal in front — behind the portal,
// `/login` is not reachable without a portal session anyway (#79).
//
// A token in an address stays in the browser history, in screenshots and in
// whatever the link was pasted into, so the value is taken out of the address
// bar the moment the page reads it. The bare `?token` stays: it is what keeps
// the form open (instead of the portal redirect) for a Cowork build should
// the token be rejected, and on a reload.

/**
 * Read the token of a sign-in link and drop it from the address bar (and the
 * current history entry). Null when the address carries no token value; the
 * address is left untouched then.
 */
export function takeLinkToken(): string | null {
  if (typeof window === "undefined") return null
  const url = new URL(window.location.href)
  const raw = url.searchParams.get("token")
  if (!raw) return null
  url.searchParams.set("token", "")
  const stripped = `${url.pathname}${url.search.replace(/^\?token=$/, "?token")}${url.hash}`
  // Keep the router's own history state; only the address changes.
  window.history.replaceState(window.history.state, "", stripped)
  return raw.trim() || null
}

// #873: a sign-in link opened while the portal session is valid is not used.
// The login page says so in the workspace — it has no toaster of its own and
// leaves right away — so the note is handed over through this tab's
// sessionStorage and raised once the workspace is on screen.
const LINK_TOKEN_IGNORED_KEY = "cowork.link-token-ignored"

/** Remember, for the workspace about to open, that the link's token was not used. */
export function noteLinkTokenIgnored(): void {
  try {
    sessionStorage.setItem(LINK_TOKEN_IGNORED_KEY, "1")
  } catch {
    // Storage refused: the stored credential is still kept, only the note is lost.
  }
}

/** Whether a sign-in link's token was just left unused; clears the note. */
export function takeLinkTokenIgnored(): boolean {
  try {
    if (sessionStorage.getItem(LINK_TOKEN_IGNORED_KEY) === null) return false
    sessionStorage.removeItem(LINK_TOKEN_IGNORED_KEY)
    return true
  } catch {
    return false
  }
}
