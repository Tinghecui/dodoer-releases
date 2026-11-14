// The only file that imports the Sentry SDK. `index.ts` loads it with
// `import()`, so it is its own chunk and only a workspace whose server has
// telemetry on downloads it (docs/telemetry.md §5.3).
//
// Collected: uncaught and reported errors, the page load, API call spans
// (`beginApiCall`), the event socket's drops and reconnects (`noteWs`), and
// breadcrumbs of clicks and navigations. Not collected: console output,
// fetch/XHR (API calls are timed in the transports instead), request bodies,
// cookies, IPs, session replays. Everything is scrubbed (`scrub.ts`).

import {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  browserSessionIntegration,
  browserTracingIntegration,
  captureException,
  createTransport,
  dedupeIntegration,
  eventFiltersIntegration,
  functionToStringIntegration,
  getTraceData,
  globalHandlersIntegration,
  httpContextIntegration,
  init,
  linkedErrorsIntegration,
  logger,
  makeBrowserOfflineTransport,
  setTags,
  setUser,
  startInactiveSpan,
  startNewTrace,
  withScope,
} from "@sentry/browser"
import type {
  Breadcrumb,
  BreadcrumbHint,
  ErrorEvent as SentryErrorEvent,
  Log,
  Span,
} from "@sentry/browser"

import {
  ENVELOPE_COMMAND,
  type ApiCall,
  type ApiResult,
  type ClientTelemetry,
  type Surface,
  type WsNote,
} from "./index"
import { scrubRecord, scrubText } from "./scrub"
import { sendEnvelope } from "./transport"

/** A span's own sample rate, read by `tracesSampler`. */
const SAMPLE_RATE = "codeg.sample_rate"
/** Errors one page sends at most, and how long the same one stays quiet. */
export const MAX_ERRORS = 30
export const REPEAT_WINDOW_MS = 60_000
/** Logs one page sends per minute at most. */
export const LOGS_PER_MINUTE = 120

const SPAN_OK = 1
const SPAN_ERROR = 2

let config: ClientTelemetry | null = null

export function start(next: ClientTelemetry, surface: Surface): void {
  config = next
  init({
    dsn: next.dsn,
    environment: next.environment,
    release: next.release,
    // Set so every envelope carries its DSN in the header, which the server
    // checks before forwarding; the transport below ignores the URL.
    tunnel: `/api/${ENVELOPE_COMMAND}`,
    transport: makeBrowserOfflineTransport((options) =>
      createTransport(options, sendEnvelope)
    ),
    defaultIntegrations: false,
    integrations: [
      eventFiltersIntegration(),
      functionToStringIntegration(),
      browserApiErrorsIntegration(),
      // No console breadcrumbs: those come from `consoleIntegration`, left
      // out, as console output can hold content.
      breadcrumbsIntegration({
        fetch: false,
        xhr: false,
        dom: { serializeAttribute: "data-testid" },
        history: true,
        sentry: true,
      }),
      globalHandlersIntegration(),
      linkedErrorsIntegration(),
      dedupeIntegration(),
      httpContextIntegration(),
      browserSessionIntegration(),
      browserTracingIntegration({
        instrumentNavigation: false,
        traceFetch: false,
        traceXHR: false,
        enableLongTask: false,
        enableLongAnimationFrame: false,
        enableInp: false,
      }),
    ],
    tracesSampler: ({ attributes }) => {
      const own = attributes?.[SAMPLE_RATE]
      return typeof own === "number" ? own : next.tracesSampleRate
    },
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: { request: { allow: ["User-Agent"] }, response: false },
      httpBodies: [],
      urlQueryParams: false,
    },
    ignoreErrors: [/ResizeObserver loop/],
    beforeSend: (event) => (admitError(event) ? scrubEvent(event) : null),
    beforeBreadcrumb: scrubBreadcrumb,
    beforeSendLog: (log) => (admitLog() ? scrubLog(log) : null),
  })
  if (next.user) setUser({ id: next.user })
  setTags({
    surface,
    web_version:
      process.env.CODEG_RELEASE_VERSION || process.env.CODEG_APP_VERSION,
  })
}

// ─── Budgets ──────────────────────────────────────────────────────────────

let errorsSent = 0
const lastSent = new Map<string, number>()

/** At most `MAX_ERRORS` a page, and the same one once a minute. */
export function admitError(event: SentryErrorEvent): boolean {
  if (errorsSent >= MAX_ERRORS) return false
  const first = event.exception?.values?.[0]
  const key = `${first?.type ?? ""}:${first?.value ?? event.message ?? ""}`
  const now = Date.now()
  const last = lastSent.get(key)
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return false
  lastSent.set(key, now)
  errorsSent++
  return true
}

let logWindowStart = 0
let logsInWindow = 0

function admitLog(): boolean {
  const now = Date.now()
  if (now - logWindowStart >= 60_000) {
    logWindowStart = now
    logsInWindow = 0
  }
  return ++logsInWindow <= LOGS_PER_MINUTE
}

// ─── Scrubbing ────────────────────────────────────────────────────────────

/** Messages, exception values and extras scrubbed; the user is only its
 *  id; no headers but the browser's own. */
export function scrubEvent(event: SentryErrorEvent): SentryErrorEvent {
  if (event.message) event.message = scrubText(event.message)
  for (const exception of event.exception?.values ?? []) {
    if (exception.value) exception.value = scrubText(exception.value)
  }
  if (event.extra) event.extra = scrubRecord(event.extra)
  if (event.breadcrumbs) {
    event.breadcrumbs = event.breadcrumbs.map((b) => scrubBreadcrumb(b) ?? b)
  }
  if (event.user) event.user = event.user.id ? { id: event.user.id } : {}
  if (event.request) {
    delete event.request.cookies
    delete event.request.data
    delete event.request.query_string
    if (event.request.url) event.request.url = pathOnly(event.request.url)
  }
  return event
}

function pathOnly(url: string): string {
  try {
    return new URL(url, "http://x").pathname
  } catch {
    return scrubText(url)
  }
}

/** An element as its tag and `data-testid`: never its text, title or label,
 *  which can hold a conversation's title. */
export function describeElement(target: unknown): string {
  if (!target || typeof target !== "object" || !("tagName" in target)) {
    return "<unknown>"
  }
  const el = target as Element
  const tag = String(el.tagName).toLowerCase()
  const testId = el.getAttribute?.("data-testid")
  return testId ? `${tag}[data-testid="${testId}"]` : tag
}

export function scrubBreadcrumb(
  breadcrumb: Breadcrumb,
  hint?: BreadcrumbHint
): Breadcrumb | null {
  if (breadcrumb.category?.startsWith("ui.")) {
    const event = hint?.event as Event | undefined
    if (event) {
      breadcrumb.message = describeElement(event.target)
    } else if (breadcrumb.message) {
      breadcrumb.message = breadcrumb.message.split(/[^a-z0-9-]/i)[0]
    }
    return breadcrumb
  }
  if (breadcrumb.category === "navigation" && breadcrumb.data) {
    for (const key of ["from", "to"]) {
      const value = breadcrumb.data[key]
      if (typeof value === "string") breadcrumb.data[key] = pathOnly(value)
    }
    return breadcrumb
  }
  if (breadcrumb.message) breadcrumb.message = scrubText(breadcrumb.message)
  if (breadcrumb.data) breadcrumb.data = scrubRecord(breadcrumb.data)
  return breadcrumb
}

export function scrubLog(log: Log): Log {
  if (typeof log.message === "string") log.message = scrubText(log.message)
  if (log.attributes) log.attributes = scrubRecord(log.attributes)
  return log
}

// ─── Reports ──────────────────────────────────────────────────────────────

export function reportError(
  error: unknown,
  context?: Record<string, unknown>
): void {
  withScope((scope) => {
    if (context) scope.setContext("details", scrubRecord(context))
    captureException(error)
  })
}

function pageState() {
  return {
    visible: typeof document === "undefined" || !document.hidden,
    online: typeof navigator === "undefined" || navigator.onLine !== false,
  }
}

/** A span that starts a trace of its own: one API call, one reconnect. */
function rootSpan(
  name: string,
  op: string,
  rate: number,
  attributes: Record<string, string | number | boolean>
): Span {
  return startNewTrace(() =>
    startInactiveSpan({
      name,
      op,
      parentSpan: null,
      attributes: { [SAMPLE_RATE]: rate, ...attributes },
    })
  )
}

function traceHeaders(span: Span): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(getTraceData({ span }))) {
    if (typeof value === "string" && name !== "traceparent") {
      headers[name] = value
    }
  }
  return headers
}

/** Whether a result points at the network or the server rather than at
 *  what was asked (a 4xx is the request's own problem). */
export function isFailure(result: ApiResult): boolean {
  return typeof result === "number" ? result >= 500 : result !== "ok"
}

export function beginApiCall(command: string, surface: Surface): ApiCall {
  const rate =
    config?.commandSampleRates[command] ?? config?.tracesSampleRate ?? 0
  const started = performance.now()
  const span = rootSpan(`POST /api/${command}`, "http.client", rate, {
    "codeg.command": command,
    "codeg.surface": surface,
  })
  // The desktop app's proxy builds its own request headers, so a remote
  // window's calls are matched to the server's by time and request id.
  const headers = surface === "web" ? traceHeaders(span) : {}
  let ended = false
  return {
    headers,
    end(result) {
      if (ended) return
      ended = true
      if (typeof result === "number") {
        span.setAttribute("http.response.status_code", result)
      }
      span.setStatus(
        result === "ok" || !isFailure(result)
          ? { code: SPAN_OK }
          : { code: SPAN_ERROR, message: String(result) }
      )
      span.end()
      if (result === 501) {
        // A command this server does not have: the page and the server are
        // from different versions.
        logger.warn("API command not implemented", { command, surface })
      } else if (isFailure(result)) {
        logger.warn("API call failed", {
          command,
          result: String(result),
          duration_ms: Math.round(performance.now() - started),
          surface,
          ...pageState(),
        })
      }
    },
  }
}

// ─── The event socket ─────────────────────────────────────────────────────

let connectingSince: number | null = null
let readySince: number | null = null
let reconnect: { span: Span; since: number } | null = null

export function noteWs(note: WsNote): void {
  const now = performance.now()
  switch (note.type) {
    case "connecting":
      connectingSince ??= now
      return
    case "ready": {
      const connectMs =
        connectingSince === null ? null : Math.round(now - connectingSince)
      connectingSince = null
      readySince = now
      if (reconnect) {
        reconnect.span.setAttribute("codeg.attempts", note.attempts)
        reconnect.span.setStatus({ code: SPAN_OK })
        reconnect.span.end()
        logger.info("Event socket back", {
          down_ms: Math.round(now - reconnect.since),
          attempts: note.attempts,
          ...pageState(),
        })
        reconnect = null
      } else if (connectMs !== null) {
        logger.info("Event socket ready", { connect_ms: connectMs })
      }
      return
    }
    case "closed": {
      const aliveMs = readySince === null ? null : Math.round(now - readySince)
      readySince = null
      const attributes = {
        code: note.code,
        clean: note.wasClean,
        alive_ms: aliveMs ?? -1,
        ...pageState(),
      }
      if (note.wasClean) logger.info("Event socket closed", attributes)
      else logger.warn("Event socket closed", attributes)
      return
    }
    case "reconnecting":
      readySince = null
      if (!reconnect) {
        reconnect = {
          span: rootSpan("event socket reconnect", "websocket.reconnect", 1, {
            "codeg.reason": note.reason,
            ...pageState(),
          }),
          since: now,
        }
      }
      return
    case "unauthorized":
      readySince = null
      if (reconnect) {
        reconnect.span.setStatus({
          code: SPAN_ERROR,
          message: "unauthenticated",
        })
        reconnect.span.end()
        reconnect = null
      }
      return
  }
}

/** Test hook: forget budgets and socket state. */
export function resetForTests(): void {
  config = null
  errorsSent = 0
  lastSent.clear()
  logWindowStart = 0
  logsInWindow = 0
  connectingSince = null
  readySince = null
  reconnect = null
}
