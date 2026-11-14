// The web UI's telemetry never talks to Sentry itself: each envelope is an
// ordinary API call, `POST /api/telemetry_envelope`, and codeg-server
// forwards it (docs/telemetry.md §5.4). Same origin, same auth, no ad
// blocker in the way, and a remote desktop window goes through its proxy
// like every other call. `sentry.ts` hands `sendEnvelope` to the SDK's
// `createTransport`, which keeps its buffering, rate limits and client
// reports.

import { extractAppCommandError } from "@/lib/app-error"
import { getTransport } from "@/lib/transport"
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
    return response(
      await getTransport().call<EnvelopeResult | null>(ENVELOPE_COMMAND, {
        envelope: bodyText(request.body),
      })
    )
  } catch (err) {
    const status = REFUSED[extractAppCommandError(err)?.code ?? ""]
    if (status === undefined) throw err
    return response({ statusCode: status })
  }
}
