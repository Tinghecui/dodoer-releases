// The only file that imports the Sentry SDK. `index.ts` loads it with
// `import()`, so it is its own chunk and only a workspace whose server has
// telemetry on downloads it (docs/telemetry.md §5.3).
//
// Collected: uncaught and reported errors, the page load, API call spans
// (`beginApiCall`), the event socket's drops and reconnects (`noteWs`), turns
// (`turnStarted`, with a warning for each the fallback had to settle), what
// users write in "Report a problem", and breadcrumbs of clicks and
// navigations. Not collected: console output,
// fetch/XHR (API calls are timed in the transports instead), request bodies,
// cookies, IPs, session replays. Everything is scrubbed (`scrub.ts`).

import {
  breadcrumbsIntegration,
  browserApiErrorsIntegration,
  browserSessionIntegration,
  browserTracingIntegration,
  captureException,
  captureFeedback,
  captureMessage,
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
  type FeedbackContext,
  type Surface,
  type Turn,
  type TurnEnd,
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
/** Longest feedback kept: it was written to be read, so it is not cut to
 *  the length of an error message. */
export const MAX_FEEDBACK_CHARS = 4000

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
  watchVisibility()
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
      } else if (result === "timeout" || result === "network") {
        noteNetworkFailure(
          command,
          result,
          surface,
          Math.round(performance.now() - started)
        )
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

// ─── Network failures ─────────────────────────────────────────────────────
//
// A call the server never answered (a timeout, a failed fetch) says the link
// is bad, and a page polling over a bad link says so many times a minute.
// While the page is hidden each one is only counted, and one summary goes
// out when it is shown again; while it is in view the same command failing
// the same way is logged one by one `NETWORK_FAILURES_PER_MINUTE` times a
// minute, and the rest as one count when the minute is over. What a page
// counted when it is closed is dropped.

/** Times one command failing one way is logged a minute while in view. */
export const NETWORK_FAILURES_PER_MINUTE = 5
/** Commands a hidden-page summary names. */
export const SUMMARY_TOP_COMMANDS = 5

type NetworkResult = "timeout" | "network"
interface Held {
  command: string
  result: NetworkResult
  count: number
}

let failureSurface: Surface = "web"
let failureWindowStart = 0
/** Failures logged in this minute, by `command:result`. */
const failuresInWindow = new Map<string, number>()
/** Failures past the limit in this minute, by `command:result`. */
const heldInView = new Map<string, Held>()
let heldTimer: ReturnType<typeof setTimeout> | null = null
let hiddenSince: number | null = null
/** Failures while hidden, by `command:result`. */
const heldHidden = new Map<string, Held>()
let watchingVisibility = false

function pageHidden(): boolean {
  return (
    typeof document !== "undefined" && document.visibilityState === "hidden"
  )
}

function hold(into: Map<string, Held>, command: string, result: NetworkResult) {
  const key = `${command}:${result}`
  const held = into.get(key)
  if (held) held.count++
  else into.set(key, { command, result, count: 1 })
}

function noteNetworkFailure(
  command: string,
  result: NetworkResult,
  surface: Surface,
  durationMs: number
): void {
  failureSurface = surface
  const now = Date.now()
  if (pageHidden()) {
    hiddenSince ??= now
    hold(heldHidden, command, result)
    return
  }
  if (now - failureWindowStart >= 60_000) {
    flushHeldInView()
    failureWindowStart = now
  }
  const key = `${command}:${result}`
  const logged = (failuresInWindow.get(key) ?? 0) + 1
  failuresInWindow.set(key, logged)
  if (logged <= NETWORK_FAILURES_PER_MINUTE) {
    logger.warn("API call failed", {
      command,
      result,
      duration_ms: durationMs,
      surface,
      ...pageState(),
    })
    return
  }
  hold(heldInView, command, result)
  heldTimer ??= setTimeout(flushHeldInView, failureWindowStart + 60_000 - now)
}

/** One log for each command that failed past the limit, and a new minute. */
function flushHeldInView(): void {
  if (heldTimer !== null) clearTimeout(heldTimer)
  heldTimer = null
  for (const held of heldInView.values()) {
    logger.warn("API call failed again", {
      command: held.command,
      result: held.result,
      count: held.count,
      surface: failureSurface,
    })
  }
  heldInView.clear()
  failuresInWindow.clear()
  failureWindowStart = 0
}

/** One log for all the page counted while it was hidden. */
function flushHeldHidden(): void {
  const since = hiddenSince
  hiddenSince = null
  if (heldHidden.size === 0) return
  const byCommand = new Map<string, number>()
  let total = 0
  let timeouts = 0
  for (const held of heldHidden.values()) {
    total += held.count
    if (held.result === "timeout") timeouts += held.count
    byCommand.set(held.command, (byCommand.get(held.command) ?? 0) + held.count)
  }
  heldHidden.clear()
  const top = [...byCommand]
    .sort((a, b) => b[1] - a[1])
    .slice(0, SUMMARY_TOP_COMMANDS)
    .map(([command, count]) => `${command}:${count}`)
    .join(",")
  logger.warn("API calls failed while hidden", {
    count: total,
    timeouts,
    network: total - timeouts,
    commands: byCommand.size,
    top_commands: top,
    hidden_ms: since === null ? -1 : Date.now() - since,
    surface: failureSurface,
  })
}

function onVisibilityChange(): void {
  if (pageHidden()) {
    hiddenSince = Date.now()
    flushHeldInView()
  } else {
    flushHeldHidden()
  }
}

function watchVisibility(): void {
  if (watchingVisibility || typeof document === "undefined") return
  watchingVisibility = true
  if (pageHidden()) hiddenSince = Date.now()
  document.addEventListener("visibilitychange", onVisibilityChange)
}

// ─── The event socket ─────────────────────────────────────────────────────

let connectingSince: number | null = null
let readySince: number | null = null
let reconnect: { span: Span; since: number } | null = null
/** The socket's last step ("none" in a remote desktop window, whose events
 *  come through the app), and how often it closed on this page. */
let wsState: WsNote["type"] | "none" = "none"
let wsCloses = 0
/** A live socket the transport dropped itself (network lost, "Reconnect
 *  now"): no close event comes for it, and the link is likely down, so a log
 *  sent now would be lost. Logged as "Event socket closed" once it is back. */
let droppedLive: {
  reason: string
  aliveMs: number
  page: ReturnType<typeof pageState>
} | null = null

function logDroppedLive(): void {
  if (!droppedLive) return
  logger.warn("Event socket closed", {
    code: 0,
    clean: false,
    alive_ms: droppedLive.aliveMs,
    reason: droppedLive.reason,
    ...droppedLive.page,
  })
  droppedLive = null
}

/** `at` is when it happened (`performance.now()`), for steps noted before
 *  telemetry started and replayed now. */
export function noteWs(note: WsNote, at?: number): void {
  const now = at ?? performance.now()
  wsState = note.type
  if (note.type === "closed") wsCloses++
  switch (note.type) {
    case "connecting":
      connectingSince ??= now
      return
    case "ready": {
      const connectMs =
        connectingSince === null ? null : Math.round(now - connectingSince)
      connectingSince = null
      readySince = now
      logDroppedLive()
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
      if (note.reason !== "closed" && readySince !== null && !droppedLive) {
        droppedLive = {
          reason: note.reason,
          aliveMs: Math.round(now - readySince),
          page: pageState(),
        }
      }
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
      // 拿到 401 说明网是通的，这时发得出去
      logDroppedLive()
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

// ─── Turns ────────────────────────────────────────────────────────────────

/** Echoes of the send itself, not a sign the reply is coming. */
const ECHO_EVENTS = new Set(["user_message", "user_prompt_sent"])
/** The reply itself: what the user sees appear. */
const REPLY_EVENTS = new Set([
  "content_delta",
  "thinking",
  "tool_call",
  "plan_update",
  "permission_request",
  "question_request",
  "plan_approval_request",
])
/** Event types a stranded-turn warning lists, in the order they came. */
const MAX_EVENT_TYPES = 20
const QUIET_ENDS: ReadonlySet<TurnEnd> = new Set([
  "complete",
  "busy",
  "replaced",
  "closed",
])

export function turnStarted(agent: string): Turn {
  const started = performance.now()
  const closesBefore = wsCloses
  const span = rootSpan("chat turn", "ui.turn", config?.tracesSampleRate ?? 0, {
    "codeg.agent": agent,
  })
  const since = () => Math.round(performance.now() - started)
  let events = 0
  let firstEventMs: number | null = null
  let firstReplyMs: number | null = null
  const types: string[] = []
  let ended = false
  return {
    noteEvent(type) {
      if (ended) return
      events++
      if (types.length < MAX_EVENT_TYPES) types.push(type)
      if (ECHO_EVENTS.has(type)) return
      firstEventMs ??= since()
      if (REPLY_EVENTS.has(type)) firstReplyMs ??= since()
    },
    end(how, details = {}) {
      if (ended) return
      ended = true
      const facts = {
        outcome: how,
        agent,
        duration_ms: since(),
        events,
        first_event_ms: firstEventMs ?? -1,
        first_reply_ms: firstReplyMs ?? -1,
        ws_drops: wsCloses - closesBefore,
        ws_state: wsState,
        conn_status: details.connStatus ?? "none",
        row_status: details.rowStatus ?? "none",
        ...pageState(),
      }
      for (const [key, value] of Object.entries(facts)) {
        span.setAttribute(`codeg.${key}`, value)
      }
      span.setStatus(
        QUIET_ENDS.has(how)
          ? { code: SPAN_OK }
          : { code: SPAN_ERROR, message: how }
      )
      span.end()
      if (how === "stranded") {
        // The #172 symptom: counted as one issue, whoever it happens to.
        withScope((scope) => {
          scope.setFingerprint(["stranded-turn"])
          scope.setContext("turn", { ...facts, event_types: types.join(" ") })
          captureMessage("Turn finished without reaching this tab", "warning")
        })
      } else if (!QUIET_ENDS.has(how)) {
        logger.warn("Turn failed", facts)
      }
    },
  }
}

// ─── Feedback ─────────────────────────────────────────────────────────────

export function sendFeedback(message: string, context: FeedbackContext): void {
  withScope((scope) => {
    // Feedback skips `beforeSend`: its request and breadcrumbs are scrubbed
    // here instead.
    scope.addEventProcessor((event) => scrubEvent(event as SentryErrorEvent))
    captureFeedback(
      {
        message: scrubText(message.trim(), MAX_FEEDBACK_CHARS),
        source: "account-menu",
        url:
          typeof location === "undefined" ? undefined : pathOnly(location.href),
        tags: {
          conversation_id: context.conversationId ?? "none",
          agent: context.agent ?? "none",
          ws_state: wsState,
          ws_closes: wsCloses,
          ...pageState(),
        },
      },
      {},
      scope
    )
  })
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
  wsState = "none"
  wsCloses = 0
  droppedLive = null
  if (heldTimer !== null) clearTimeout(heldTimer)
  heldTimer = null
  failureSurface = "web"
  failureWindowStart = 0
  failuresInWindow.clear()
  heldInView.clear()
  hiddenSince = null
  heldHidden.clear()
  if (watchingVisibility) {
    document.removeEventListener("visibilitychange", onVisibilityChange)
    watchingVisibility = false
  }
}
