// Cowork fork (daemon/client split, step 2): the transport of a local window
// when the app's daemon is a child process.
//
// Two transports in one. Daemon commands go to the child exactly as a remote
// window's go to its server — `RemoteDesktopTransport`, through the app's
// proxy, as connection `LOCAL_DAEMON_CONNECTION_ID`. What only the app can do
// goes to the app (`TauriTransport`); `local-daemon-routing.ts` says which is
// which. Events come from both: the child's over its event socket, the app's
// own (browser, windows, updater) as Tauri events — no event name is emitted
// by both for the same thing, so a handler subscribed to both hears each once.
//
// Everything else that makes a window "local" stays as it was:
// `getActiveRemoteConnectionId()` is null and `isRemoteDesktopMode()` false,
// because the child runs on this machine — its files, its loopback and its
// native pickers are this computer's.

import type { ServerCompat } from "@/lib/cowork/compat"
import { localDaemonRoute } from "./local-daemon-routing"
import type {
  CallOptions,
  EventStream,
  Transport,
  UnsubscribeFn,
} from "./types"

export class LocalDaemonTransport implements Transport {
  /** The child's event stream (Subscribe-with-Snapshot). */
  eventStream?: () => EventStream

  constructor(
    private readonly shell: Transport,
    private readonly daemon: Transport
  ) {
    const stream = daemon.eventStream
    if (stream) this.eventStream = () => stream.call(daemon)
  }

  async call<T>(
    command: string,
    args?: Record<string, unknown>,
    options?: CallOptions
  ): Promise<T> {
    switch (localDaemonRoute(command)) {
      case "shell":
        return this.shell.call<T>(command, args, options)
      case "both": {
        const result = await this.daemon.call<T>(command, args, options)
        // The child keeps the setting; the app applies it to what it runs.
        await this.shell.call(command, args, options).catch((err) => {
          console.warn(`[local-daemon] ${command} in the app failed`, err)
        })
        return result
      }
      default:
        return this.daemon.call<T>(command, args, options)
    }
  }

  async subscribe<T>(
    event: string,
    handler: (payload: T) => void
  ): Promise<UnsubscribeFn> {
    const [fromShell, fromDaemon] = await Promise.all([
      this.shell.subscribe<T>(event, handler),
      this.daemon.subscribe<T>(event, handler),
    ])
    return () => {
      fromShell()
      fromDaemon()
    }
  }

  isDesktop(): boolean {
    return true
  }

  onReconnect(callback: () => void): UnsubscribeFn {
    return this.daemon.onReconnect?.(callback) ?? (() => {})
  }

  onReady(callback: () => void): UnsubscribeFn {
    return this.daemon.onReady?.(callback) ?? (() => {})
  }

  waitForReady(): Promise<void> {
    return this.daemon.waitForReady?.() ?? Promise.resolve()
  }

  onServerInfo(callback: (info: ServerCompat) => void): UnsubscribeFn {
    return this.daemon.onServerInfo?.(callback) ?? (() => {})
  }

  destroy(): void {
    this.daemon.destroy?.()
  }
}
