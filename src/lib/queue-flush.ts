/**
 * Rate-limiting for the conversation message-queue auto-flush.
 *
 * When a queued message is sent but the backend rejects it because a turn is
 * already in flight (TurnBusyError), the draft is re-queued. The queue's
 * level-triggered flush would otherwise re-send it immediately — and if the
 * backend stays busy while the client still believes it is idle (the
 * "prompting" broadcast is delayed or missed), that becomes a retry storm of
 * one bounced send per round-trip. This backoff bounds the retry RATE.
 */

/** Minimum gap between auto-flush retries after a bounced (busy) send. */
export const QUEUE_FLUSH_RETRY_BACKOFF_MS = 1000

/**
 * Milliseconds to wait before the next queue-flush attempt, given `now` and the
 * timestamp of the last bounce (`lastBounceAt`, 0 if none). Returns 0 when no
 * bounce has happened recently — a normal queued message flushes promptly; only
 * a just-bounced retry is delayed.
 */
export function flushRetryDelayMs(
  now: number,
  lastBounceAt: number,
  backoffMs: number = QUEUE_FLUSH_RETRY_BACKOFF_MS
): number {
  // Clamp elapsed at 0 so a skewed/future bounce timestamp is treated as
  // just-bounced (full backoff) rather than yielding an unbounded delay. The
  // result is always within [0, backoffMs].
  const elapsed = Math.max(0, now - lastBounceAt)
  if (elapsed >= backoffMs) return 0
  return backoffMs - elapsed
}

/**
 * Whether a send should be routed to the TAIL of the message queue instead of
 * being sent immediately, to preserve FIFO order.
 *
 * The shared send handler serves two callers: the queue auto-flush (which
 * dequeued the head and must send it now — `fromQueueFlush`), and direct input
 * sends. A direct send issued while the queue is non-empty must NOT jump ahead
 * of already-queued items — it belongs at the tail. The auto-flush always sends
 * (it IS draining the queue), so it never tail-routes.
 */
export function shouldQueueDirectSend(
  fromQueueFlush: boolean,
  queueLength: number
): boolean {
  return !fromQueueFlush && queueLength > 0
}

/**
 * Whether the live connection is ready to accept a send for THIS tab: connected,
 * its established cwd matches the tab's intended working dir, AND it belongs to
 * the agent the tab currently has selected.
 *
 * Bare `connStatus === "connected"` is insufficient. A chat draft that just
 * retargeted into folderless mode (or any tab mid-reconnect) can read a stale
 * "connected" belonging to the PREVIOUS cwd for a render or two before the
 * reconnect lands. Sending then would deliver the prompt to the wrong
 * agent/workspace.
 *
 * The agent check covers the same hazard on the other axis: switching a draft's
 * agent leaves the OLD agent's connection live — at the same cwd — until the
 * lifecycle's reconnect lands, and for a not-installed target it never lands at
 * all. All three terms belong together because the queue auto-flush DEQUEUES
 * before handing the message to the send path: if the flush gate were weaker
 * than the send's own check, the message would be taken off the queue and then
 * silently dropped.
 *
 * Nullish cwds are normalized so `null`/`undefined` compare equal (both mean "no
 * cwd yet"). A nullish `connectedAgentType` means no agent has been recorded for
 * the connection yet, which is not a mismatch.
 */
export function isConnectionReady(
  connStatus: string | null | undefined,
  connectedWorkingDir: string | null | undefined,
  intendedWorkingDir: string | null | undefined,
  connectedAgentType: string | null | undefined,
  selectedAgentType: string | null | undefined
): boolean {
  return (
    connStatus === "connected" &&
    (connectedWorkingDir ?? null) === (intendedWorkingDir ?? null) &&
    (connectedAgentType == null || connectedAgentType === selectedAgentType)
  )
}

/**
 * Whether a direct submit must be rejected because an unbound new-tab create is
 * already in flight (single-flight the create).
 *
 * A second submit fired before the first create resolves (double Enter / double
 * click) would otherwise append an optimistic turn it can never deliver: the
 * create-pending guard that actually stops the duplicate returns only AFTER the
 * optimistic append. `hasPersistedId` is true once the tab is bound to a real
 * conversation row, so only the unbound path is single-flighted — persisted
 * conversations keep their legitimate concurrent queued-send behavior.
 */
export function shouldRejectDuplicateCreate(
  hasPersistedId: boolean,
  createPending: boolean
): boolean {
  return !hasPersistedId && createPending
}

/**
 * #792：回车时连接还没就绪，按连接状态决定怎么把它推向就绪。
 *
 * - `reconnect`：断了 / 出错，重连一次（handleFocus）。
 * - `retarget`：已经连上，但连的是别的目录或智能体（刚用完上一个会话就新建
 *   聊天时会遇到）。这时 handleFocus 什么都不做，要按这个标签现在的参数再
 *   请求一次连接，connect 会断开旧的、按新目录重连。
 * - `wait`：正在连 / 正在回复，等它自己就绪。
 */
export function notReadyRecovery(
  connStatus: string | null | undefined
): "reconnect" | "retarget" | "wait" {
  if (connStatus === "error" || connStatus === "disconnected")
    return "reconnect"
  if (connStatus === "connected") return "retarget"
  return "wait"
}

/**
 * #1118：排队的消息在等的连接是「未连接」（断了，或者还没开始连），也就是眼下
 * 没有连接在进行。自动连接只在打开标签、换目录 / 智能体时跑，智能体不认会话后的
 * 自动重发也只试一次；那次没连上又没留下失败记录时，就没有谁会再去连，消息会
 * 一直等。连接中、已连上、正在回复都还在往就绪走；出错的另有失败提示
 * （`connectFailed`），这里都不算。
 */
export function queueWaitsOnIdleConnection(
  connStatus: string | null | undefined
): boolean {
  return connStatus == null || connStatus === "disconnected"
}

/**
 * #792：「已经连上、但连的不是这个标签要的目录 / 智能体」持续这么久还没就绪，
 * 就再请求一次连接，并把排队区队首标成失败、带重试，不再一直显示「正在等待就绪」。
 */
export const STALE_TARGET_FAIL_MS = 15_000
