// What leaves the browser is scrubbed here (docs/telemetry.md §5.7): no
// paths, tokens, e-mail addresses, URL paths or query strings, and none of
// the fields that carry content. A port of `src-tauri/src/telemetry/scrub.rs`;
// both test against `scrub-cases.json`.

/** Messages are cut to this many characters. */
export const MAX_CHARS = 500

/** Fields dropped whole, matched on the last segment of the key
 *  (`code.file.path` → `path`), case-insensitively. */
export const DROPPED_FIELDS = [
  "working_dir",
  "cwd",
  "path",
  "file",
  "title",
  "prompt",
  "text",
  "content",
  "token",
  "password",
  "secret",
  "authorization",
  "cookie",
]

export const REDACTED = "<redacted>"

const URL_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g
const AUTH_SCHEME_RE = /\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]+/gi
const SECRET_VALUE_RE =
  /\b(token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)(["']?\s*[:=]\s*["']?)[^\s"'&,;]+/gi
const EMAIL_RE =
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g
const WINDOWS_PATH_RE = /\b[A-Za-z]:\\[^\s"'<>]*/g
const HOME_PATH_RE =
  /(^|[\s"'(=:,[])(?:\/home|\/Users)\/[^/\s"'<>]+(?:\/[^\s"'<>]*)?/g
const DEEP_PATH_RE =
  /(^|[\s"'(=:,[])(\/[A-Za-z0-9._@+-]+)(?:\/[^/\s"'<>),\]]+){2,}\/?/g
const LONG_TOKEN_RE = /[A-Za-z0-9+/=_-]{32,}/g
const UUID_RE =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/

/** A URL keeps its scheme and host; user info, path, query and fragment go. */
function scrubUrl(url: string): string {
  const at = url.indexOf("://")
  if (at < 0) return REDACTED
  const scheme = url.slice(0, at)
  const rest = url.slice(at + 3).split(/[?#]/)[0]
  const slash = rest.indexOf("/")
  const authority = slash < 0 ? rest : rest.slice(0, slash)
  const path = slash < 0 ? "" : rest.slice(slash)
  const host = authority.slice(authority.lastIndexOf("@") + 1)
  return `${scheme}://${host}${path === "" || path === "/" ? path : `/${REDACTED}`}`
}

/** A run of 32+ token characters with both letters and digits is a key, a
 *  hash or a token — unless it holds a UUID (connection and session ids). */
function scrubLongToken(token: string): string {
  return /\d/.test(token) && /[A-Za-z]/.test(token) && !UUID_RE.test(token)
    ? REDACTED
    : token
}

function truncate(text: string): string {
  const chars = Array.from(text)
  return chars.length > MAX_CHARS
    ? `${chars.slice(0, MAX_CHARS).join("")}…`
    : text
}

/** Scrub one string. */
export function scrubText(text: string): string {
  const s = text
    .replace(URL_RE, scrubUrl)
    .replace(JWT_RE, REDACTED)
    .replace(AUTH_SCHEME_RE, `$1 ${REDACTED}`)
    .replace(SECRET_VALUE_RE, `$1$2${REDACTED}`)
    .replace(EMAIL_RE, "<email>")
    .replace(WINDOWS_PATH_RE, "<path>")
    .replace(HOME_PATH_RE, `$1~/${REDACTED}`)
    .replace(DEEP_PATH_RE, `$1$2/${REDACTED}`)
    .replace(LONG_TOKEN_RE, scrubLongToken)
  return truncate(s)
}

/** Whether a field named `key` is dropped whole. */
export function dropsField(key: string): boolean {
  const last = key.split(/[.:]/).pop() ?? key
  return DROPPED_FIELDS.includes(last.toLowerCase())
}

/** Scrub a JSON-like value: strings scrubbed, dropped fields removed from
 *  objects at any depth. */
export function scrubValue(value: unknown): unknown {
  if (typeof value === "string") return scrubText(value)
  if (Array.isArray(value)) return value.map(scrubValue)
  if (value && typeof value === "object") {
    return scrubRecord(value as Record<string, unknown>)
  }
  return value
}

/** {@link scrubValue} over an object's entries. */
export function scrubRecord<T extends Record<string, unknown>>(record: T): T {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (!dropsField(key)) out[key] = scrubValue(value)
  }
  return out as T
}
