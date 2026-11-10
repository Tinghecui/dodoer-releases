// Cowork fork: what the desktop app's main window shows — the local workspace,
// or the start page (`src/components/cowork/start-home.tsx`) offering it next
// to the saved servers. Remote workspace windows never show the start page.
//
// The choice is remembered in the app's own localStorage (every window of the
// app shares the origin, but only the main window reads or writes this key):
// "local" whenever the main window shows the local workspace, "start" when
// the person goes back to the start page from it. With nothing remembered —
// the first launch of a version that has the start page — the main window
// shows the start page only when there is a server to offer: a fresh install
// (and anyone who never saved a server) goes straight to the local workspace,
// as before.

export const MAIN_WINDOW_VIEW_KEY = "cowork:main-window-view:v1"

export type MainWindowView = "local" | "start"

export function readMainWindowView(): MainWindowView | null {
  try {
    const value = window.localStorage.getItem(MAIN_WINDOW_VIEW_KEY)
    return value === "local" || value === "start" ? value : null
  } catch {
    return null
  }
}

export function rememberMainWindowView(view: MainWindowView): void {
  try {
    window.localStorage.setItem(MAIN_WINDOW_VIEW_KEY, view)
  } catch {
    // Storage unavailable: the next launch decides afresh.
  }
}

/**
 * What the main window opens on. `hasLocalDaemon` is false only when the app
 * runs without one (`CODEG_DESKTOP_DAEMON=client`): then there is no local
 * workspace to show. `savedServers` is the number of saved remote
 * connections, or null while not known yet — the answer is null too when it
 * depends on it.
 */
export function initialMainWindowView(
  hasLocalDaemon: boolean,
  remembered: MainWindowView | null,
  savedServers: number | null
): MainWindowView | null {
  if (!hasLocalDaemon) return "start"
  if (remembered) return remembered
  if (savedServers === null) return null
  return savedServers > 0 ? "start" : "local"
}

/** Reload the window (a function of its own so tests can stand in for it). */
export function reloadWindow(): void {
  window.location.reload()
}
