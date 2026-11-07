// Cowork fork: the optional `hello` → `server_info` handshake on the event
// socket (`src-tauri/src/web/ws.rs`), shared by `WebTransport` and
// `RemoteDesktopTransport`.
//
// After every `__ready__` the transport sends a `hello`; a server that knows the
// handshake answers with the `/api/health` contract (`src/lib/cowork/compat.ts`).
// So a client learns on every reconnect — a restart is when Cowork upgrades the
// server — what it would otherwise only learn by asking `/api/health` again.
// A server from before the handshake ignores the `hello` and never answers:
// listeners just never fire, and `/api/health` (API version 0) still applies.
// Upstream codeg clients never send one, so they never see a `server_info`.

import {
  CLIENT_API_VERSION,
  readServerCompat,
  type ServerCompat,
} from "@/lib/cowork/compat"
import { WS_HELLO_ACTION, WS_SERVER_INFO_TYPE } from "./constants"
import type { UnsubscribeFn } from "./types"

export type ServerInfoListener = (info: ServerCompat) => void

export class ServerInfoChannel {
  private latest: ServerCompat | null = null
  private listeners = new Set<ServerInfoListener>()

  /**
   * @param client who is asking, for the server's log (`codeg-web`, `codeg-desktop`)
   * @param version this client's version; may be async, may be unknown
   */
  constructor(
    private readonly client: string,
    private readonly version: () =>
      | Promise<string | undefined>
      | string
      | undefined
  ) {}

  /** Sends the `hello` through `send` (the socket must be ready). Never throws. */
  async hello(send: (frame: object) => unknown): Promise<void> {
    let version: string | undefined
    try {
      version = await this.version()
    } catch {
      version = undefined
    }
    try {
      await send({
        action: WS_HELLO_ACTION,
        client: this.client,
        version,
        api_version: CLIENT_API_VERSION,
      })
    } catch (err) {
      // An older server never answers anyway; nothing depends on this.
      console.debug("[ServerInfo] hello not sent:", err)
    }
  }

  /** Takes a `server_info` frame (true) and leaves every other frame (false). */
  handleFrame(frame: unknown): boolean {
    if (!isServerInfoFrame(frame)) return false
    const info = readServerCompat(frame)
    this.latest = info
    for (const listener of this.listeners) {
      try {
        listener(info)
      } catch (err) {
        console.error("[ServerInfo] listener threw:", err)
      }
    }
    return true
  }

  /** The last answer on the current socket, null before one (or ever). */
  current(): ServerCompat | null {
    return this.latest
  }

  /** Called for every answer, and at once with the current one if any. */
  subscribe(listener: ServerInfoListener): UnsubscribeFn {
    this.listeners.add(listener)
    if (this.latest) listener(this.latest)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The socket dropped: what the next one says may differ. */
  reset(): void {
    this.latest = null
  }

  destroy(): void {
    this.latest = null
    this.listeners.clear()
  }
}

export function isServerInfoFrame(frame: unknown): boolean {
  return (
    !!frame &&
    typeof frame === "object" &&
    (frame as { type?: unknown }).type === WS_SERVER_INFO_TYPE
  )
}
