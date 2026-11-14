// Telemetry entry point (docs/telemetry.md §5.3). Everything else calls only
// this file, which never imports the Sentry SDK: `sentry.ts` is loaded with
// `import()` once the server's `cowork_info` says telemetry is on, so a
// workspace without it never downloads the SDK and every call here is a
// no-op. Errors caught before that are kept (at most 20) and sent once it
// starts.

/** The API command envelopes go through (`transport.ts`); must match
 *  `ENVELOPE_COMMAND` in src-tauri/src/telemetry/mod.rs. Never timed itself. */
export const ENVELOPE_COMMAND = "telemetry_envelope"

/** `cowork_info.telemetry`; mirrors `ClientTelemetry` in
 *  src-tauri/src/telemetry/mod.rs. */
export interface ClientTelemetry {
  dsn: string
  environment: string
  release: string
  tracesSampleRate: number
  /** Sample rates of the polled commands, already capped by the above. */
  commandSampleRates: Record<string, number>
  user: string
}

export function normalizeClientTelemetry(raw: unknown): ClientTelemetry | null {
  if (!raw || typeof raw !== "object") return null
  const r = raw as Record<string, unknown>
  if (typeof r.dsn !== "string" || !r.dsn) return null
  const rate = (value: unknown, fallback: number) =>
    typeof value === "number" && value >= 0 && value <= 1 ? value : fallback
  const tracesSampleRate = rate(r.tracesSampleRate, 1)
  const commandSampleRates: Record<string, number> = {}
  if (r.commandSampleRates && typeof r.commandSampleRates === "object") {
    for (const [command, value] of Object.entries(r.commandSampleRates)) {
      commandSampleRates[command] = rate(value, tracesSampleRate)
    }
  }
  const text = (value: unknown, fallback: string) =>
    typeof value === "string" && value ? value : fallback
  return {
    dsn: r.dsn,
    environment: text(r.environment, "production"),
    release: text(r.release, "unknown"),
    tracesSampleRate,
    commandSampleRates,
    user: text(r.user, ""),
  }
}

/** Which kind of window this is: the browser, or a desktop window bound to
 *  a remote server (its calls go through the desktop app's proxy). */
export type Surface = "web" | "remote-desktop"

/** How an API call ended: "ok", an HTTP status, no answer in time, no
 *  answer at all, or the request never left (the browser refused it). */
export type ApiResult = "ok" | "timeout" | "network" | "error" | number

export interface ApiCall {
  /** Trace headers for the request (`sentry-trace`, `baggage`); empty
   *  while telemetry is off or the call is not sampled. */
  headers: Record<string, string>
  end(result: ApiResult): void
}

/** What the web transport's event socket went through. */
export type WsNote =
  | { type: "connecting" }
  | { type: "ready"; attempts: number }
  | { type: "closed"; code: number; wasClean: boolean }
  | { type: "reconnecting"; reason: "closed" | "network_lost" | "manual" }
  | { type: "unauthorized" }

/** How a turn this tab sent ended. */
export type TurnEnd =
  /** The reply ran here and ended. */
  | "complete"
  /** It ended in an error: the agent quit, needed credentials, … */
  | "error"
  /** Its reply never reached this tab; the fallback settled it (#172). */
  | "stranded"
  /** Refused, a turn was already running; the message waits in the queue. */
  | "busy"
  /** The send itself failed. */
  | "send_failed"
  /** A newer send took its place before it ended. */
  | "replaced"
  /** The conversation's panel went away first. */
  | "closed"

/** What the panel saw when the turn ended. */
export interface TurnDetails {
  /** The agent connection's status. */
  connStatus?: string | null
  /** The sidebar row's status. */
  rowStatus?: string | null
}

/** One turn this tab sent, from the send until the panel settles it. */
export interface Turn {
  /** An event of the conversation's connection reached this tab. */
  noteEvent(type: string): void
  /** Only the first call counts. */
  end(how: TurnEnd, details?: TurnDetails): void
}

/** Sent along with what the user wrote in "Report a problem". */
export interface FeedbackContext {
  conversationId: number | null
  agent: string | null
}

type Backend = typeof import("./sentry")

const MAX_EARLY_ERRORS = 20
const NO_HEADERS: Record<string, string> = Object.freeze({}) as Record<
  string,
  string
>
const NO_CALL: ApiCall = { headers: NO_HEADERS, end: () => {} }
const NO_TURN: Turn = { noteEvent: () => {}, end: () => {} }

let backend: Backend | null = null
let starting: Promise<void> | null = null
let early: Array<{ error: unknown; context?: Record<string, unknown> }> = []
const listeners = new Set<() => void>()

/**
 * Load the SDK and start reporting. Called with `cowork_info.telemetry`;
 * only the first call counts. Never rejects: telemetry failing to start
 * must not break the page.
 */
export function startTelemetry(
  config: ClientTelemetry,
  surface: Surface
): Promise<void> {
  starting ??= import("./sentry")
    .then((loaded) => {
      loaded.start(config, surface)
      backend = loaded
      const kept = early
      early = []
      for (const { error, context } of kept) loaded.reportError(error, context)
      for (const listener of listeners) listener()
    })
    .catch((err: unknown) => {
      early = []
      console.warn("[telemetry] could not start:", err)
    })
  return starting
}

/** Whether reports are being sent. */
export function isTelemetryOn(): boolean {
  return backend !== null
}

/** Be told once telemetry has started (for `useSyncExternalStore`). */
export function subscribeTelemetry(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Report a caught error; `context` is scrubbed before it leaves. */
export function reportError(
  error: unknown,
  context?: Record<string, unknown>
): void {
  if (backend) {
    backend.reportError(error, context)
  } else if (early.length < MAX_EARLY_ERRORS) {
    early.push({ error, context })
  }
}

/** Start timing one API call; call `end` exactly once. */
export function beginApiCall(command: string, surface: Surface): ApiCall {
  if (!backend || command === ENVELOPE_COMMAND) return NO_CALL
  return backend.beginApiCall(command, surface)
}

/** Note a step of the event socket's life. Dropped while telemetry is off. */
export function noteWs(note: WsNote): void {
  backend?.noteWs(note)
}

/** Start timing a turn this tab sends to `agent`; end it exactly once. */
export function turnStarted(agent: string): Turn {
  return backend ? backend.turnStarted(agent) : NO_TURN
}

/** Send what the user wrote; false (and nothing sent) while telemetry is
 *  off. Scrubbed like everything else. */
export function sendFeedback(
  message: string,
  context: FeedbackContext
): boolean {
  if (!backend || !message.trim()) return false
  backend.sendFeedback(message, context)
  return true
}

/**
 * Catch uncaught errors from page load until the SDK takes over (its own
 * global handlers replace these). Returns the uninstaller.
 */
export function installEarlyCapture(): () => void {
  if (typeof window === "undefined") return () => {}
  const onError = (event: ErrorEvent) => {
    if (!backend) reportError(event.error ?? event.message)
  }
  const onRejection = (event: PromiseRejectionEvent) => {
    if (!backend) reportError(event.reason)
  }
  window.addEventListener("error", onError)
  window.addEventListener("unhandledrejection", onRejection)
  return () => {
    window.removeEventListener("error", onError)
    window.removeEventListener("unhandledrejection", onRejection)
  }
}

/** Test hook: back to "never started". */
export function resetTelemetryForTests(): void {
  backend = null
  starting = null
  early = []
  listeners.clear()
}

/** Test hook: errors kept until the SDK starts. */
export function earlyErrorsForTests(): number {
  return early.length
}
