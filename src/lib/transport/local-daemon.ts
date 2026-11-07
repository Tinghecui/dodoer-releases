// Cowork fork (daemon/client split, step 2): which daemon this window's app
// has. Set by the app before any page code runs (`window.__CODEG_LOCAL_DAEMON__`,
// `src-tauri/src/commands/local_daemon.rs`): "child" — a `codeg-server` child
// process the window reaches through the remote-workspace proxy, as connection
// `connectionId` — "embedded", the daemon inside the app, or "client" (step
// 3): none at all — the client-only edition, whose windows open saved remote
// workspaces only and whose local window shows how to connect
// (`src/components/cowork/client-only-home.tsx`). Absent outside the app (web
// build) and in an app from before the split, which is embedded.

export type LocalDaemonMode = "child" | "embedded" | "client"

export interface LocalDaemonInfo {
  mode: LocalDaemonMode
  connectionId: number
}

/** The id the app gives its own daemon in the proxy; never a saved row. */
export const LOCAL_DAEMON_CONNECTION_ID = -1

export function localDaemonInfo(): LocalDaemonInfo | null {
  if (typeof window === "undefined") return null
  const raw = (window as unknown as { __CODEG_LOCAL_DAEMON__?: unknown })
    .__CODEG_LOCAL_DAEMON__
  if (!raw || typeof raw !== "object") return null
  const { mode, connectionId } = raw as Partial<LocalDaemonInfo>
  if (mode !== "child" && mode !== "embedded" && mode !== "client") return null
  return {
    mode,
    connectionId:
      typeof connectionId === "number" && Number.isInteger(connectionId)
        ? connectionId
        : LOCAL_DAEMON_CONNECTION_ID,
  }
}

/** Whether this window's daemon is the app's child process. */
export function isLocalChildDaemon(): boolean {
  return localDaemonInfo()?.mode === "child"
}

/**
 * Whether this app is the client-only edition: no daemon of its own, so the
 * local window has no workspace to show — only the way to a server's.
 */
export function isClientOnlyApp(): boolean {
  return localDaemonInfo()?.mode === "client"
}
