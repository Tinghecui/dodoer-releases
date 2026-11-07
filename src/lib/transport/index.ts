import { detectEnvironment } from "./detect"
import { localDaemonInfo } from "./local-daemon"
import type { RemoteTransportConfig, Transport } from "./types"

export type { RemoteTransportConfig, Transport, UnsubscribeFn } from "./types"

let _shellTransport: Transport | null = null
let _localTransport: Transport | null = null
let _remoteTransport: Transport | null = null
let _remoteConfig: RemoteTransportConfig | null = null

function createTauriTransport(): Transport {
  // Use dynamic require to avoid bundling tauri deps in web mode.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { TauriTransport } = require("./tauri-transport") as {
    TauriTransport: new () => Transport
  }
  return new TauriTransport()
}

function createWebTransport(baseUrl: string): Transport {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { WebTransport } = require("./web-transport") as {
    WebTransport: new (baseUrl: string) => Transport
  }
  return new WebTransport(baseUrl)
}

export function getShellTransport(): Transport {
  if (!_shellTransport) {
    const env = detectEnvironment()
    _shellTransport =
      env === "tauri"
        ? createTauriTransport()
        : createWebTransport(window.location.origin)
  }
  return _shellTransport
}

export function configureRemoteDesktopTransport(
  config: RemoteTransportConfig
): void {
  _remoteTransport?.destroy?.()
  _remoteConfig = config
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RemoteDesktopTransport } = require("./remote-desktop-transport") as {
    RemoteDesktopTransport: new (config: RemoteTransportConfig) => Transport
  }
  _remoteTransport = new RemoteDesktopTransport(config)
}

export function clearRemoteDesktopTransport(): void {
  _remoteTransport?.destroy?.()
  _remoteTransport = null
  _remoteConfig = null
}

export function getActiveRemoteConnectionId(): number | null {
  return _remoteConfig?.id ?? null
}

function randomWindowInstanceId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return `local-${globalThis.crypto.randomUUID()}`
  }
  return `local-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

/// Cowork fork (daemon/client split): a local window of an app whose daemon
/// is a child process talks to it as a remote window talks to its server,
/// and to the app for what only the app does (`local-daemon-transport.ts`).
function createLocalDaemonTransport(connectionId: number): Transport {
  const shell = getShellTransport()
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { RemoteDesktopTransport } = require("./remote-desktop-transport") as {
    RemoteDesktopTransport: new (config: RemoteTransportConfig) => Transport
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { LocalDaemonTransport } = require("./local-daemon-transport") as {
    LocalDaemonTransport: new (shell: Transport, daemon: Transport) => Transport
  }
  const windowInstanceId = randomWindowInstanceId()
  // The proxy drops this window's event subscriptions when it closes, as it
  // does for a remote window's.
  shell.call("local_daemon_attach_window", { windowInstanceId }).catch(() => {})
  const daemon = new RemoteDesktopTransport({
    id: connectionId,
    name: "local",
    // The proxy resolves the child's address itself (it changes on restart).
    baseUrl: "",
    token: "",
    windowInstanceId,
  })
  return new LocalDaemonTransport(shell, daemon)
}

function getLocalTransport(): Transport {
  if (detectEnvironment() === "tauri") {
    const info = localDaemonInfo()
    if (info?.mode === "child") {
      if (!_localTransport) {
        _localTransport = createLocalDaemonTransport(info.connectionId)
      }
      return _localTransport
    }
    // "embedded": the daemon is in the app, so the app's own commands are
    // it. "client" (the client-only edition): there is no daemon, and the
    // local window renders no workspace (`ClientOnlyGate`), so what little it
    // calls — saved connections, windows, the updater — is the app's too.
  }
  return getShellTransport()
}

export function getTransport(): Transport {
  return _remoteTransport ?? getLocalTransport()
}

export function isDesktop(): boolean {
  return detectEnvironment() === "tauri"
}

/// True when the current window is a Tauri client bound to a remote
/// codeg-server (a remote-desktop window). Distinct from `isDesktop()`,
/// which is purely a runtime check — a remote-desktop window IS a Tauri
/// runtime but its API calls and file ops must target the remote host,
/// not the local filesystem.
export function isRemoteDesktopMode(): boolean {
  return _remoteTransport !== null
}

/// Base URL of the codeg server backing the current transport, for building
/// raw resource URLs that bypass the JSON transport (iframes, downloads).
/// Remote-desktop → the remote host; web → this page's origin. In pure-desktop
/// mode there's no server (callers use loopback / `invoke`), so this returns
/// the local origin only as a harmless fallback.
export function getServerBaseUrl(): string {
  if (_remoteConfig) return _remoteConfig.baseUrl.replace(/\/+$/, "")
  return typeof window !== "undefined" ? window.location.origin : ""
}

/// Surface a remote-server 401 to the same UI the transport uses for its
/// own auth failures. Direct `invoke()` calls (workspace file
/// upload/download) bypass `RemoteDesktopTransport.call`, so without
/// this they'd toast "token invalid" but never raise the
/// `connection-expired` dialog the rest of the app uses. Calling this on
/// a non-remote-desktop window is a no-op so the helper is safe to use
/// unconditionally from a 401 catch block.
export function notifyRemoteDesktopUnauthorized(): void {
  _remoteConfig?.onUnauthorized?.()
}

/**
 * Test-only: clear the cached shell + remote transports so a subsequent
 * `getTransport()` / `getShellTransport()` call re-runs environment detection
 * against the current `window` mock. The module-level singletons would
 * otherwise stick across test cases. Not intended for production use.
 * @internal
 */
export function __resetTransportForTests(): void {
  // Hard guard: collapses to a no-op outside vitest. Turbopack/webpack DCE
  // the dead branch in `next build` so the function ships as a single
  // `return` in the prod bundle instead of reaching into module state.
  if (process.env.NODE_ENV !== "test") return
  _shellTransport?.destroy?.()
  _localTransport?.destroy?.()
  _remoteTransport?.destroy?.()
  _shellTransport = null
  _localTransport = null
  _remoteTransport = null
  _remoteConfig = null
}
