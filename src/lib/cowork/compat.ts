// Client side of the server's `/api/health` contract (`src-tauri/src/compat.rs`),
// which a server also sends as `server_info` on the event socket
// (`src/lib/transport/server-info.ts`).
//
// The desktop app and the server are released apart, so a remote window checks
// once, when it connects, whether the two work together: a server too old for
// this client ("ask an administrator to upgrade Cowork") or a client too old
// for the server ("update the app"). A server from before the contract sends
// none of the fields: API version 0, no minimum, no features.

/** Raise when this client starts relying on what only a newer server has (the
 * server's `API_VERSION`). 0 accepts servers from before the contract. */
export const MIN_SERVER_API_VERSION = 0

/** The newest server `API_VERSION` this client knows, told to the server in the
 * WS `hello` (informational: the client still judges). Bump with the server's. */
export const CLIENT_API_VERSION = 1

export interface ServerCompat {
  apiVersion: number
  minDesktopVersion: string | null
  features: string[]
}

export type CompatVerdict =
  | { kind: "ok" }
  | { kind: "server_too_old"; apiVersion: number; required: number }
  | { kind: "desktop_too_old"; version: string; required: string }

/** The contract fields of a `/api/health` answer, tolerating any shape. */
export function readServerCompat(health: unknown): ServerCompat {
  const h = (health && typeof health === "object" ? health : {}) as Record<
    string,
    unknown
  >
  const apiVersion =
    typeof h.api_version === "number" && Number.isInteger(h.api_version)
      ? h.api_version
      : 0
  const minDesktopVersion =
    typeof h.min_desktop_version === "string" &&
    parseVersion(h.min_desktop_version)
      ? h.min_desktop_version
      : null
  const features = Array.isArray(h.features)
    ? h.features.filter((f): f is string => typeof f === "string")
    : []
  return { apiVersion, minDesktopVersion, features }
}

/** Whether a server offers an optional ability (see `FEATURES` in compat.rs). */
export function serverHasFeature(server: ServerCompat, name: string): boolean {
  return server.features.includes(name)
}

/** The server is judged first: when it is too old, updating the app won't help. */
export function judgeCompat(
  server: ServerCompat,
  desktopVersion: string,
  minServerApiVersion: number = MIN_SERVER_API_VERSION
): CompatVerdict {
  if (server.apiVersion < minServerApiVersion) {
    return {
      kind: "server_too_old",
      apiVersion: server.apiVersion,
      required: minServerApiVersion,
    }
  }
  const required = server.minDesktopVersion
  if (required && compareVersions(desktopVersion, required) < 0) {
    return { kind: "desktop_too_old", version: desktopVersion, required }
  }
  return { kind: "ok" }
}

/** `major.minor.patch`, ignoring a `v` prefix and any pre-release / build
 * suffix; null when it isn't one. */
function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version.trim())
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}

/** Negative / 0 / positive like a sort comparator. A version that doesn't
 * parse counts as equal, so it never triggers a warning on its own. */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return 0
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i]
  }
  return 0
}
