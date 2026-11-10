// Cowork fork (daemon/client split, step 2): which daemon this window's app
// has. Set by the app before any page code runs (`window.__CODEG_LOCAL_DAEMON__`,
// `src-tauri/src/commands/local_daemon.rs`): "child" — a `codeg-server` child
// process the window reaches through the remote-workspace proxy, as connection
// `connectionId` — "embedded", the daemon inside the app, or "client": none
// at all (`CODEG_DESKTOP_DAEMON=client`), so the windows open saved remote
// workspaces only and the main one shows its start page without the local
// workspace (`src/components/cowork/start-home.tsx`). Absent outside the app
// (web build) and in an app from before the split, which is embedded.

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
