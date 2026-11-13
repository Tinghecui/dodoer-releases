/**
 * Cowork fork (#172): a turn this tab sent whose live stream never reached it.
 *
 * The panel settles a turn on the connection status going from "prompting"
 * back to idle. A tab that never saw "prompting" for its send — the reply's
 * events missed it, or came back folded into a snapshot that already showed
 * the turn over — never gets that edge, and keeps showing the user message
 * under a spinning "进行中" until the page is reloaded, while the sidebar
 * (fed by its own channel) already reads the conversation as finished.
 *
 * What the panel remembers about its last send, for telling that apart.
 */
export interface SentTurnWatch {
  /** The sidebar row's `updated_at` when the message went out; null when the
   *  conversation had no row yet (a draft's first send). */
  summaryUpdatedAt: string | null
  /** Whether this tab saw the connection go "prompting" after the send. */
  sawPrompting: boolean
}

/** How long a stranded-looking turn is given before the panel settles it from
 *  the saved conversation, so live events that are merely late land first. */
export const STRANDED_TURN_GRACE_MS = 2_000

/**
 * True when the send is over by the server's account but this tab never saw
 * it run: the sidebar row moved on since the send to a status a running turn
 * never has, and the connection here is not prompting and never was.
 *
 * Every condition is needed. A row bumped while the turn is still running
 * reads `in_progress`; a turn this tab watched run settles the normal way; and
 * a row whose `updated_at` is the one from before the send describes the
 * previous turn.
 */
export function isStrandedTurn(
  watch: SentTurnWatch | null,
  connStatus: string | null | undefined,
  summary: { status: string; updated_at: string } | null
): boolean {
  if (!watch || watch.sawPrompting) return false
  if (connStatus === "prompting") return false
  if (!summary || summary.status === "in_progress") return false
  return summary.updated_at !== watch.summaryUpdatedAt
}
