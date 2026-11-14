// The connection to the person's own Chrome (`docs/agent-chrome.md`): thin
// wrappers over the `browser_chrome_*` commands and the event that follows
// the connection's state.
//
// This app's own shell, like the built-in browser's commands and for the same
// reason: Chrome runs on this computer, whichever server the window's
// workspace lives on.

import { getShellTransport } from "@/lib/transport"
import type { UnsubscribeFn } from "@/lib/transport/types"

export type ChromeState = "disconnected" | "waiting" | "connected"

/** Why there is no connection, when the person did not end it themselves.
 *  Mirrors `ChromeProblem` in `src-tauri/src/browser/chrome/link.rs`. */
export type ChromeProblem =
  | "switch-off"
  | "file-denied"
  | "file-unreadable"
  | "bad-endpoint"
  | "not-running"
  | "rejected"
  | "timed-out"
  | "lost"

/** Mirrors `ChromeStatus` in `src-tauri/src/browser/chrome/link.rs`. */
export interface ChromeStatus {
  state: ChromeState
  problem: ChromeProblem | null
  detail: string | null
  /** `Chrome/154.0.8037.98`, once connected. */
  product: string | null
  /** The file Chrome writes its endpoint to, as an address Chrome can open. */
  portFileUrl: string | null
}

export const CHROME_STATUS_EVENT = "browser://chrome"

/** Where the switch is. Chrome opens `chrome://` addresses only when they are
 *  typed or pasted into its own address bar, so this is copied, never opened. */
export const CHROME_SWITCH_URL = "chrome://inspect/#remote-debugging"

export function chromeStatus(): Promise<ChromeStatus> {
  return getShellTransport().call<ChromeStatus>("browser_chrome_status")
}

/**
 * Connect, and resolve with where that ended — once the person has answered
 * Chrome's dialog, which can take minutes. `endpoint` is what they pasted
 * when the app could not read Chrome's file itself. A connection that was not
 * made resolves too, with the reason in `problem`.
 */
export function chromeConnect(endpoint?: string): Promise<ChromeStatus> {
  return getShellTransport().call<ChromeStatus>("browser_chrome_connect", {
    endpoint: endpoint ?? null,
  })
}

/** End the connection, or the attempt at one. */
export function chromeDisconnect(): Promise<ChromeStatus> {
  return getShellTransport().call<ChromeStatus>("browser_chrome_disconnect")
}

/** macOS: open System Settings where reading Chrome's file is allowed. */
export function chromeOpenPrivacySettings(): Promise<void> {
  return getShellTransport().call<void>("browser_chrome_open_privacy_settings")
}

/** Every change of state, including the ones nobody here asked for (Chrome
 *  quit; another window connected). */
export function subscribeChromeStatus(
  handler: (status: ChromeStatus) => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe<ChromeStatus>(
    CHROME_STATUS_EVENT,
    handler
  )
}
