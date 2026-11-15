// The connection to the person's own Chrome (`docs/agent-chrome.md`): thin
// wrappers over the `browser_chrome_*` commands and the event that follows
// the connection's state.
//
// This app's own shell, like the built-in browser's commands and for the same
// reason: Chrome runs on this computer, whichever server the window's
// workspace lives on.

import {
  BROWSER_AGENT_ACTIVITY_EVENT,
  type AgentAction,
  type AgentActivityPayload,
  type AgentOutcome,
  type GrantLevel,
} from "@/lib/browser/types"
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

/** One web page open in the connected Chrome. Mirrors `ChromeTab` in
 *  `src-tauri/src/browser/chrome/tabs.rs`: a title and a host name, never the
 *  full address. What the person has open is theirs to see; an agent is told
 *  of a tab only once the person hands it over (`chromeShare`). */
export interface ChromeTab {
  /** The app's own name for the tab. */
  id: string
  title: string
  host: string
}

/** What an action was aimed at. Mirrors `ActivityTarget` in
 *  `src-tauri/src/browser/chrome/activity.rs`: the element's name from the
 *  agent's snapshot, or only "a password field". Never what was typed. For
 *  running code, the code the agent sent (its first 4000 characters). */
export type ChromeActivityTarget =
  | { kind: "named"; name: string }
  | { kind: "password" }
  | { kind: "code"; code: string }

/** One agent's one attempt on one Chrome tab. Mirrors `ActivityEntry` in
 *  `src-tauri/src/browser/chrome/activity.rs`. */
export interface ChromeActivityEntry {
  /** Unix milliseconds. */
  at: number
  action: AgentAction
  outcome: AgentOutcome
  /** The site the tab was on at the time. */
  host: string | null
  /** Whose agent: `local`, or a remote window's label. */
  scope: string
  target: ChromeActivityTarget | null
}

export const CHROME_STATUS_EVENT = "browser://chrome"

export const CHROME_TABS_EVENT = "browser://chrome-tabs"

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

/** The connected Chrome's web pages, oldest first; empty when not connected. */
export function chromeTabs(): Promise<ChromeTab[]> {
  return getShellTransport().call<ChromeTab[]>("browser_chrome_tabs")
}

/**
 * What agents did to each of the connected Chrome's tabs, oldest first, by
 * tab id: the last 50 per tab and 500 in all, kept in memory and emptied
 * when the connection ends. The app's own record for the person; no agent
 * can read it.
 */
export function chromeActivity(): Promise<
  Record<string, ChromeActivityEntry[]>
> {
  return getShellTransport().call<Record<string, ChromeActivityEntry[]>>(
    "browser_chrome_activity"
  )
}

/** Every attempt an agent makes on any tab (`browser://agent-activity`),
 *  for asking `chromeActivity` again. */
export function subscribeAgentActivity(
  handler: (activity: AgentActivityPayload) => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe<AgentActivityPayload>(
    BROWSER_AGENT_ACTIVITY_EVENT,
    handler
  )
}

/**
 * Hand the Chrome tab `tabId` to agents at `level`, or take it back with
 * `"none"`. Once handed over the tab is in the built-in browser's tab states
 * under the same id (`browser://state`, owner `chrome`), which is where its
 * level is read from.
 */
export function chromeShare(tabId: string, level: GrantLevel): Promise<void> {
  return getShellTransport().call<void>("browser_chrome_share", {
    tabId,
    level,
  })
}

/**
 * Whether this window's agents may use the person's Chrome: the app's own
 * agents in a local window, that server's in a remote one. With it on, a web
 * page they open goes to a Chrome window kept for agents, signed in as the
 * person, and the tabs the person hands over reach them too.
 */
export function chromeAgents(): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_chrome_agents")
}

/** Turn this window's switch on or off. Off lets go of the pages its agents
 *  opened; they stay open in Chrome. */
export function chromeSetAgents(on: boolean): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_chrome_set_agents", { on })
}

/**
 * Whether agents may run their own code (`browser_eval`) in the Chrome tabs
 * handed to them to read and act on. One switch for this computer's Chrome,
 * off until the person turns it on; the backend keeps it only in memory
 * (`docs/agent-chrome.md` 13.5).
 */
export function chromeEval(): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_chrome_eval")
}

/** Turn running code in Chrome on or off. The app's own shell only: no
 *  agent can reach this. */
export function chromeSetEval(on: boolean): Promise<boolean> {
  return getShellTransport().call<boolean>("browser_chrome_set_eval", { on })
}

/** Bring a Chrome tab (an id from the list) to the front. */
export function chromeActivate(tabId: string): Promise<void> {
  return getShellTransport().call<void>("browser_chrome_activate", { tabId })
}

/** The `ownerWindow` of a page an agent opened in Chrome starts with this
 *  (`AGENT_OWNER_PREFIX` in `src-tauri/src/browser/chrome/lending.rs`). */
export const AGENT_OWNER_PREFIX = "chrome@"

/** The labels of remote workspace windows start with this
 *  (`REMOTE_WORKSPACE_LABEL_PREFIX` in
 *  `src-tauri/src/commands/workspace_windows.rs`). */
const REMOTE_WINDOW_PREFIX = "remote-workspace-"

/** Whose switch a window's is, as the backend names it (`scope_of_window` in
 *  `src-tauri/src/browser/chrome_share.rs`): a remote window's own, and one
 *  for every local window together — the app's own agents. */
export function chromeAgentsScope(windowLabel: string): string {
  return windowLabel.startsWith(REMOTE_WINDOW_PREFIX) ? windowLabel : "local"
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

/** Every change of the tab list, emptied when the connection ends. */
export function subscribeChromeTabs(
  handler: (tabs: ChromeTab[]) => void
): Promise<UnsubscribeFn> {
  return getShellTransport().subscribe<ChromeTab[]>(CHROME_TABS_EVENT, handler)
}
