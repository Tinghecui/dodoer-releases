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
