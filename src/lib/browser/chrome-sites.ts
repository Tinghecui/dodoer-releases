// The sites agents are kept off in the person's own Chrome
// (`docs/agent-chrome.md` 13.3): the default list and the person's edits to
// it, kept by the app in `chrome-sites.json` (`src-tauri/src/browser/chrome/
// sensitive.rs`). What is kept off is (defaults − allowed) ∪ blocked, every
// entry matched by host with its subdomains.
//
// This app's own shell only, like the rest of `chrome-api.ts`: the list is
// about the Chrome on this computer, whichever window asks, and no agent tool
// reaches these commands.

import { getShellTransport } from "@/lib/transport"
import type { UnsubscribeFn } from "@/lib/transport/types"

/** Mirrors `ChromeSites` in `src-tauri/src/commands/browser_chrome.rs`. */
export interface ChromeSites {
  /** The list the app ships with. */
  defaults: string[]
  /** Sites the person keeps agents off besides the defaults. */
  blocked: string[]
  /** Entries of `defaults` the person lets agents use after all. */
  allowed: string[]
  /** The person paused the list: agents may use every site, the list kept
   *  as it is. Missing from an app older than the pause. */
  paused?: boolean
  /** `defaults` by kind, in order (`mail`, `accounts`, `payments`, `banks`,
   *  `exchanges`). Missing from an app older than the groups. */
  groups?: ChromeSiteGroup[]
}

/** Mirrors `ChromeSiteGroup` in `browser_chrome.rs`. */
export interface ChromeSiteGroup {
  id: string
  sites: string[]
}

export interface ChromeSiteEdits {
  blocked: string[]
  allowed: string[]
  /** Left out, the pause stays as it is. */
  paused?: boolean
}

/** Sent to every window of the app after each change of the list or the
 *  pause, with what `chromeSites()` would answer (`SITES_EVENT` in
 *  `src-tauri/src/browser/chrome/mod.rs`). */
export const CHROME_SITES_EVENT = "browser://chrome-sites"

export function chromeSites(): Promise<ChromeSites> {
  return getShellTransport().call<ChromeSites>("browser_chrome_sites")
}

/** Keep the edits and put them in force; a Chrome tab agents have on a site
 *  now kept off is let go of. Resolves with the edits as the app kept them.
 *  `paused` goes only when given: an older app has no such argument. */
export function chromeSetSites(edits: ChromeSiteEdits): Promise<ChromeSites> {
  return getShellTransport().call<ChromeSites>("browser_chrome_set_sites", {
    blocked: edits.blocked,
    allowed: edits.allowed,
    ...(edits.paused === undefined ? {} : { paused: edits.paused }),
  })
}

/** Every change of the list or the pause, whichever window made it: the
 *  settings page and the sidebar's Chrome panel follow each other this way. */
export function subscribeChromeSites(
  handler: (sites: ChromeSites) => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe<ChromeSites>(CHROME_SITES_EVENT, handler)
}

/** Longest a host name can be (RFC 1035). */
const MAX_HOST_LEN = 253

/**
 * What the person typed as the bare host name a site is listed under — lower
 * case, no trailing dot, no leading `*.` (subdomains are always included), no
 * scheme, sign-in, port, path or query. `null` when no host name is left.
 * Mirrors `normalize_site` in `sensitive.rs`, which has the last word.
 */
export function normalizeSite(input: string): string | null {
  let site = input.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
  if (site.startsWith("*.")) site = site.slice(2)
  if (!site) return null
  const address = site.includes("://") ? site : `http://${site}`
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return null
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null
  const host = url.hostname.replace(/\.+$/, "").toLowerCase()
  if (!host || host.length > MAX_HOST_LEN || host.startsWith(".")) return null
  return host
}
