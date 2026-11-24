// The web UI's telemetry never talks to Sentry itself: each envelope is an
// ordinary API call, `POST /api/telemetry_envelope`, and codeg-server
// forwards it (docs/telemetry.md §5.4). Same origin, same auth, no ad
// blocker in the way, and a remote desktop window goes through its proxy
// like every other call. `sentry.ts` hands `sendEnvelope` to the SDK's
// `createTransport`, which keeps its buffering, rate limits and client
// reports.

import { extractAppCommandError } from "@/lib/app-error"
import { getTransport, isDesktop, isRemoteDesktopMode } from "@/lib/transport"
import {
  codegAuthHeaders,
  getCodegToken,
  unauthorizedSource,
} from "@/lib/transport/web-auth"
import { notifyWebUnauthorized } from "@/lib/transport/web-connection-store"
import { ENVELOPE_COMMAND } from "./index"

/** What the server answers: Sentry's status and rate-limit headers. */
interface EnvelopeResult {
  statusCode?: number
  rateLimits?: string | null
  retryAfter?: string | null
}

/** The SDK's `TransportRequest` / `TransportMakeRequestResponse`. */
export interface EnvelopeRequest {
  body: string | Uint8Array
}
export interface EnvelopeResponse {
  statusCode?: number
  headers: {
    "x-sentry-rate-limits": string | null
    "retry-after": string | null
  }
}

function bodyText(body: string | Uint8Array): string {
  return typeof body === "string" ? body : new TextDecoder().decode(body)
}

function response(result: EnvelopeResult | null): EnvelopeResponse {
  return {
    statusCode: result?.statusCode,
    headers: {
      "x-sentry-rate-limits": result?.rateLimits ?? null,
      "retry-after": result?.retryAfter ?? null,
    },
  }
}

// The server refused the envelope itself: telemetry is off there (404), or
// the envelope is too big or not ours (400). Sending it again cannot help.
const REFUSED: Record<string, number> = { not_found: 404, invalid_input: 400 }

/** Browsers refuse a `keepalive` request whose body is over 64 KiB; leave
 *  room for the JSON around the envelope. */
const KEEPALIVE_MAX_BYTES = 60_000

/** pagehide 已经来了、页面还没回来（sentry.ts 在 pagehide 时设、页面重新
 *  显示时清）。有的浏览器离开页面时 pagehide 先到、visibilityState 还是
 *  visible，只看 hidden 的话这一刻的 flush 仍走普通请求，随页面一起被取消。 */
let pageLeaving = false

export function notePageLeaving(leaving: boolean): void {
  pageLeaving = leaving
}

/**
 * 页面正在离开（刷新、关掉、切走，SDK 在 hidden 时会把攒着的日志发出去）：
 * 网页版的普通请求会随页面一起被浏览器取消，断网恢复那一刻记下的
 * 「Event socket closed / back」就这样丢了（#1331）。这时直接带 keepalive
 * 发，页面没了请求也会送完。桌面端和远端桌面窗口不走网页的 fetch，照旧。
 */
function keepaliveBody(envelope: string): string | null {
  if (typeof document === "undefined") return null
  if (!pageLeaving && document.visibilityState !== "hidden") return null
  if (isDesktop() || isRemoteDesktopMode()) return null
  const body = JSON.stringify({ envelope })
  if (new TextEncoder().encode(body).byteLength > KEEPALIVE_MAX_BYTES) {
    return null
  }
  return body
}

/** keepalive 的请求没发出去（fetch 本身抛了），交给普通调用再发一次 */
const NOT_SENT = Symbol("keepalive-not-sent")

async function sendKeepalive(
  body: string
): Promise<EnvelopeResult | null | typeof NOT_SENT> {
  let res: Response
  try {
    res = await fetch(`/api/${ENVELOPE_COMMAND}`, {
      method: "POST",
      keepalive: true,
      headers: {
        "Content-Type": "application/json",
        ...codegAuthHeaders(getCodegToken()),
      },
      body,
    })
  } catch {
    // 浏览器拒发（keepalive 的总额度满了、请求体超限、页面正在卸载、断网）：
    // 各家浏览器抛的不一定是 TypeError（也有 DOMException 之类），fetch 本身
    // 抛的一律当没发出去，退回普通调用，它失败了离线包装层会留着以后再发。
    // 服务器已经回了的（401、502、拒收）不走这里，照下面原样处理，不重发。
    return NOT_SENT
  }
  if (res.status === 401) {
    // 和 WebTransport.callOnce 一样：令牌被拒就弹登录失效的对话框，
    // 页面在后台时也要让用户回来就看到
    notifyWebUnauthorized(
      unauthorizedSource(res.headers.get("www-authenticate"))
    )
    throw new Error("Unauthorized")
  }
  if (!res.ok) {
    throw await res.json().catch(() => ({
      code: "network_error",
      message: `HTTP ${res.status}`,
    }))
  }
  const text = await res.text()
  return text ? (JSON.parse(text) as EnvelopeResult | null) : null
}

async function post(envelope: string): Promise<EnvelopeResult | null> {
  const body = keepaliveBody(envelope)
  if (body !== null) {
    const result = await sendKeepalive(body)
    if (result !== NOT_SENT) return result
  }
  return getTransport().call<EnvelopeResult | null>(ENVELOPE_COMMAND, {
    envelope,
  })
}

/**
 * Send one serialized envelope through the server. Rejects when it did not
 * get there or Sentry could not be reached (offline, server down, a 502):
 * the offline wrapper then keeps the envelope and sends it later. A refusal
 * resolves with its status, so it is dropped rather than retried.
 */
export async function sendEnvelope(
  request: EnvelopeRequest
): Promise<EnvelopeResponse> {
  try {
    return response(await post(bodyText(request.body)))
  } catch (err) {
    const status = REFUSED[extractAppCommandError(err)?.code ?? ""]
    if (status === undefined) throw err
    return response({ statusCode: status })
  }
}
