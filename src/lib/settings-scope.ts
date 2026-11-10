// Cowork fork (daemon/client split, follow-up): which machine a settings
// window is editing. Since the split a settings window reaches two things —
// the app on this computer and a daemon (the app's own child, or a server
// the window is bound to) — and its pages are filed by which one keeps what
// they change. The nav groups and the scope badges read this; where a call
// actually goes is still decided by the transport (`lib/transport`).

import type { TransportEnvironment } from "@/lib/transport/detect"
import type { LocalDaemonInfo } from "@/lib/transport/local-daemon"

/**
 * Who answers a settings window:
 * - `remote`: a desktop window bound to a saved server connection;
 * - `child`: the app's own `codeg-server` child process;
 * - `embedded`: the daemon inside the app (the fallback; one process);
 * - `client`: the app's own window when it runs no daemon at all
 *   (`CODEG_DESKTOP_DAEMON=client`);
 * - `web`: a browser talking to the server that served the page.
 */
export type SettingsTargetKind =
  | "remote"
  | "child"
  | "embedded"
  | "client"
  | "web"

export interface SettingsTarget {
  kind: SettingsTargetKind
  /** The saved connection's name and URL; only for `remote`. */
  serverName?: string
  serverUrl?: string
}

export function settingsTargetFor(
  env: TransportEnvironment,
  daemon: Pick<LocalDaemonInfo, "mode"> | null,
  remote: { name: string; base_url: string } | null
): SettingsTarget {
  if (remote) {
    return {
      kind: "remote",
      serverName: remote.name,
      serverUrl: remote.base_url,
    }
  }
  if (env === "web") return { kind: "web" }
  if (daemon?.mode === "child") return { kind: "child" }
  if (daemon?.mode === "client") return { kind: "client" }
  return { kind: "embedded" }
}

/**
 * Where a page's settings are kept:
 * - `app`: the app on this computer (or, in a browser, this browser);
 * - `server`: the daemon the window is talking to.
 *
 * A page is filed by most of what it holds; the sections that go the other
 * way carry a `SettingScopeBadge` (General's terminal options are the
 * daemon's, System's proxy and language are kept by both).
 */
export type SettingsScope = "app" | "server"

/**
 * Whether the window has a daemon whose settings it can edit. An app running
 * without a local daemon (`CODEG_DESKTOP_DAEMON=client`) has none for its own
 * windows: its app-side commands would answer the server pages, but against a
 * database nothing ever reads.
 */
export function hasServerSettings(target: SettingsTarget): boolean {
  return target.kind !== "client"
}
