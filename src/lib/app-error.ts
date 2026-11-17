import { NOT_A_GIT_REPO_PATTERNS } from "@/i18n/git-error-patterns"
import type { AppCommandError } from "@/lib/types"
import { coworkText } from "@/lib/cowork/i18n"

type ObjectLike = Record<string, unknown>

function asObject(value: unknown): ObjectLike | null {
  return value !== null && typeof value === "object"
    ? (value as ObjectLike)
    : null
}

function normalizeString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function parseI18nParams(value: unknown): Record<string, string> | null {
  const obj = asObject(value)
  if (!obj) return null
  const out: Record<string, string> = {}
  for (const [key, raw] of Object.entries(obj)) {
    if (typeof raw === "string") {
      out[key] = raw
    } else if (typeof raw === "number" || typeof raw === "boolean") {
      out[key] = String(raw)
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

function parseErrorObject(value: unknown): AppCommandError | null {
  const obj = asObject(value)
  if (!obj) return null

  const code = normalizeString(obj.code)
  const message = normalizeString(obj.message)
  const detailRaw = normalizeString(obj.detail)
  const detail = detailRaw ?? null
  const i18nKey = normalizeString(obj.i18n_key)
  const i18nParams = parseI18nParams(obj.i18n_params)

  if (!code || !message) return null

  return {
    code,
    message,
    detail,
    i18n_key: i18nKey,
    i18n_params: i18nParams,
  }
}

export function extractAppCommandError(error: unknown): AppCommandError | null {
  const direct = parseErrorObject(error)
  if (direct) return direct

  const errorObject = asObject(error)
  const message = normalizeString(errorObject?.message)
  if (!message) return null

  try {
    const parsed = JSON.parse(message)
    return parseErrorObject(parsed)
  } catch {
    return null
  }
}

// Must mirror `AppErrorCode::NotAGitRepository` in src-tauri/src/app_error.rs.
// If the backend enum ever renames, both sides must change together.
export const NOT_A_GIT_REPO_CODE = "not_a_git_repository"

export function isNotAGitRepoError(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  if (appError?.code === NOT_A_GIT_REPO_CODE) return true

  const candidates = [appError?.detail, appError?.message]
  return candidates.some(
    (text) =>
      typeof text === "string" &&
      NOT_A_GIT_REPO_PATTERNS.some((pattern) => pattern.test(text))
  )
}

/**
 * Cowork fork: 桌面远程代理在远端回 HTTP 401（窗口口令被拒）时，放在
 * `i18n_params.reason` 里的标记（`remote_proxy.rs` 的 `REMOTE_TOKEN_REJECTED`）。
 * 两边要一起改。
 */
export const REMOTE_TOKEN_REJECTED_REASON = "remote_token_rejected"

/**
 * Cowork fork: 远程服务器（或它前面的 nginx / 门户）拒绝了这个窗口的口令。
 * 命令自己登录失败（git 推送、provider 的 key）也是 `authentication_failed`，
 * 但不带标记，不能当成连接过期。只认标记，不按文字兜底。
 */
export function isRemoteTokenRejected(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  return (
    appError?.code === "authentication_failed" &&
    appError.i18n_params?.reason === REMOTE_TOKEN_REJECTED_REASON
  )
}

/** Whether a command failed because the thing it named does not exist —
 *  `AppErrorCode::NotFound` on the backend. */
export function isNotFoundError(error: unknown): boolean {
  return extractAppCommandError(error)?.code === "not_found"
}

/**
 * Cowork fork: whether `fetch` rejected without any response — the server
 * could not be reached at all. Each engine words it differently (Chrome,
 * Firefox, Safari); a response with an error status never lands here.
 */
export function isFetchNetworkError(error: unknown): boolean {
  return (
    error instanceof TypeError &&
    /^(Failed to fetch|NetworkError\b|Load failed)/.test(error.message.trim())
  )
}

export function toErrorMessage(error: unknown): string {
  const appError = extractAppCommandError(error)
  if (appError) {
    return appError.detail?.trim() || appError.message
  }

  // Cowork fork: say what happened instead of the engine's bare "Failed to
  // fetch" (#71). In the language the page is shown in; it is set on <html>
  // by the i18n provider.
  if (isFetchNetworkError(error)) {
    const locale =
      typeof document === "undefined" ? "en" : document.documentElement.lang
    return coworkText(locale, "networkUnreachable")
  }

  if (error instanceof Error) {
    return error.message.trim()
  }

  if (typeof error === "string") {
    return error.trim()
  }

  // Cowork fork: 网页模式下非 2xx 时 throw 的是解析出来的错误体。门户、代理
  // 回的常是 `{ error: "..." }`，没有 code 的也可能只有 message；取其中的文字，
  // 不把整段 JSON 给用户看。
  const body = asObject(error)
  const bodyText =
    normalizeString(body?.error) ?? normalizeString(body?.message)
  if (bodyText) return bodyText

  try {
    const serialized = JSON.stringify(error)
    return serialized ? serialized.trim() : String(error)
  } catch {
    return String(error)
  }
}

/** Translator callable shape compatible with next-intl's scoped translator. */
export type AppErrorTranslator = (
  key: string,
  params?: Record<string, string | number>
) => string

/**
 * Like `toErrorMessage`, but prefers the backend-provided i18n hint when
 * present. The translator should be scoped to the namespace whose keys the
 * backend emits (e.g. for MCP errors, a translator scoped to `McpSettings`).
 *
 * Falls back to the English `message` when the key is missing OR the
 * translator throws (e.g. unknown key in a different translator's namespace).
 */
export function toLocalizedErrorMessage(
  error: unknown,
  translate: AppErrorTranslator
): string {
  const appError = extractAppCommandError(error)
  if (appError?.i18n_key) {
    try {
      const params = appError.i18n_params ?? undefined
      const localized = translate(appError.i18n_key, params)
      const trimmed = localized.trim()
      if (trimmed && trimmed !== appError.i18n_key) {
        return trimmed
      }
    } catch {
      // fall through to non-localized path
    }
  }
  return toErrorMessage(error)
}
