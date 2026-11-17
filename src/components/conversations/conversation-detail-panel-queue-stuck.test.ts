import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Cowork fork: a message that can never be sent is flagged failed instead of
// waiting in the queue forever. The pieces are unit-tested where they live
// (`useMessageQueue.failHead`, the queue display's hint, `worktree-start`);
// these assert they stay wired into the panel, the same way
// `conversation-detail-panel-jenny.test.ts` guards the jenny send path.
const source = readFileSync(
  join(__dirname, "conversation-detail-panel.tsx"),
  "utf8"
)
const chatInput = readFileSync(
  join(__dirname, "..", "chat", "chat-input.tsx"),
  "utf8"
)

function between(start: string, end: string): string {
  const from = source.indexOf(start)
  expect(from).toBeGreaterThan(-1)
  const to = source.indexOf(end, from)
  expect(to).toBeGreaterThan(from)
  return source.slice(from, to)
}

describe("no usable agent fails the waiting message", () => {
  it("never counts a connection that is still coming up", () => {
    const predicate = between(
      "const connectFailed =",
      "const agentUnavailableReason ="
    )
    expect(predicate).toContain('connStatus === "error"')
    expect(predicate).toContain("autoConnectError != null")
    expect(predicate).toContain("selectedAgentNotInstalled")
    expect(predicate).toContain("agentsLoaded && usableAgentCount === 0")
    // `connecting` and `prompting` are the waits the queue exists for.
    expect(predicate).not.toContain('"connecting"')
    expect(predicate).not.toContain('"prompting"')
  })

  it("flags the head failed while the agent is unusable, and only then", () => {
    const effect = between(
      "if (agentUnavailable == null) return",
      "// Mirror the connection's liveMessage"
    )
    expect(effect).toContain(
      "if (msgQueue.length === 0 || queueHeadFailed) return"
    )
    expect(effect).toContain("mqFailHead()")
  })

  it("keeps the send path's own wait for a connection that is not ready", () => {
    // The send still parks the message and retries a dropped connection; it
    // is the effect above, not the send, that decides the wait is hopeless.
    const start = source.indexOf("if (!connectionReady) {")
    const block = source.slice(start, start + 300)
    expect(block).toContain("keepInQueue()")
    expect(block).not.toContain("mqFailHead")
  })

  it("does not un-fail a message while there is still no usable agent", () => {
    const retry = between(
      "const handleQueueRetry = useCallback(",
      "const queueHeadFailure ="
    )
    expect(retry).toContain("if (agentUnavailableReason == null) {")
    expect(retry.indexOf("mqRetry(id)")).toBeLessThan(
      retry.indexOf("handleFocus()")
    )
    expect(retry).toContain("onClick: handleOpenAgentsSettings")
  })

  it("reconnects a dropped connection when a usable agent's message is retried (#200)", () => {
    const retry = between(
      "const handleQueueRetry = useCallback(",
      "const queueHeadFailure ="
    )
    const usable = retry.slice(
      retry.indexOf("if (agentUnavailableReason == null) {"),
      retry.indexOf("return\n")
    )
    // Un-fail first, then start the connection the auto-flush waits for —
    // the same states handleSend reconnects from.
    expect(usable.indexOf("mqRetry(id)")).toBeGreaterThan(-1)
    expect(usable.indexOf("mqRetry(id)")).toBeLessThan(
      usable.indexOf("handleFocus()")
    )
    expect(usable).toContain("connStatusRef.current")
    expect(usable).toContain("status == null")
    expect(usable).toContain('status === "disconnected"')
    expect(usable).toContain('status === "error"')
    // A connection coming up, up, or mid-turn is left alone.
    expect(usable).not.toContain('"connecting"')
    expect(usable).not.toContain('"connected"')
    expect(usable).not.toContain('"prompting"')
  })

  it("routes both composers' retry and hint through the panel", () => {
    expect(source).not.toContain("onQueueRetry={mqRetry}")
    expect(source.split("onQueueRetry={handleQueueRetry}")).toHaveLength(3)
    expect(
      source.split("queueFailedHeadNotice={queueFailedHeadNotice}")
    ).toHaveLength(3)
  })

  it("routes both composers' Retry all through the panel", () => {
    expect(source.split("onQueueRetryAll={handleQueueRetryAll}")).toHaveLength(
      3
    )
  })

  it("does not un-fail anything on Retry all while there is no usable agent", () => {
    const retryAll = between(
      "const handleQueueRetryAll = useCallback(",
      "const queueHeadFailure ="
    )
    expect(retryAll).toContain("agentUnavailableReason")
    expect(retryAll).toContain("toast.error")
    expect(retryAll).toContain("`queue-agent-unavailable:${tabId}`")
    expect(retryAll).toContain("onClick: handleOpenAgentsSettings")
    const usable = retryAll.slice(
      retryAll.indexOf("if (agentUnavailableReason == null) {"),
      retryAll.indexOf("return\n")
    )
    // Reconnect only when something was cleared and the connection is down.
    expect(usable).toContain("mqRetryAll()")
    expect(usable.indexOf("mqRetryAll()")).toBeLessThan(
      usable.indexOf("handleFocus()")
    )
    expect(usable).toContain("cleared > 0")
    expect(usable).toContain('status === "disconnected"')
    expect(usable).toContain('status === "error"')
    expect(usable).toContain("status == null")
  })

  it("drops the waiting-for-the-agent line once the head is failed", () => {
    const start = chatInput.indexOf("data-jenny-queue-waiting")
    const condition = chatInput.slice(start - 500, start)
    expect(condition).toContain("!queue[0].failed &&")
  })
})

describe("a failed head says what to do about it", () => {
  it("links to where the agent signs in for a turn refused for credentials", () => {
    const notice = between(
      "const queueFailedHeadNotice = useMemo",
      "// Click-to-insert for a queued row"
    )
    const auth = notice.slice(
      notice.indexOf('if (queueHeadFailure === "auth") {'),
      notice.indexOf('if (queueHeadFailure === "restored") {')
    )
    expect(auth).toContain('tSessionFailure("action.login")')
    // Behind the portal: its AI accounts, and the label says so (#158).
    expect(auth).toContain("signInViaPortal(selectedAgent, coworkInfo)")
    expect(auth).toContain('coworkT("signInViaPortal")')
    expect(auth).toContain("onClick: () => openAgentSignIn(selectedAgent)")
  })

  it("says why a message read back after a reload waits (#159)", () => {
    const notice = between(
      'if (queueHeadFailure === "restored") {',
      "// Click-to-insert for a queued row"
    )
    expect(notice).toContain('coworkT("queueRestoredReason")')
  })

  it("sends the failure notice's Sign in where the agent signs in (#158)", () => {
    const handler = between('case "login":', 'case "new_session":')
    expect(handler).toContain("openAgentSignIn(selectedAgent)")
    expect(handler).not.toContain("handleOpenAgentsSettings")
  })

  it("keeps the queue of a saved conversation across a reload (#159)", () => {
    const hook = between(
      "const messageQueue = useMessageQueue(",
      "const {\n    queue: msgQueue,"
    )
    expect(hook).toContain(
      "dbConversationId != null ? messageQueueStorageKey(dbConversationId) : null"
    )
  })

  it("learns of the refusal from the error event of the turn in flight", () => {
    const listener = between(
      "// Cowork fork: note a turn refused for credentials",
      "// A turn the agent runs on its own"
    )
    expect(listener).toContain('envelope.type !== "error"')
    expect(listener).toContain("envelope.connection_id !== conn.connectionId")
    expect(listener).toContain('"turn_failed_auth_required"')
    // A new send must not inherit the previous turn's verdict.
    const send = between(
      "lastSentRef.current = {",
      "const onTurnInProgress = () => {"
    )
    expect(send).toContain("turnAuthFailedRef.current = false")
  })
})

describe("a worktree that cannot be created fails the message", () => {
  it("toasts the reason and flags the parked message failed", () => {
    const handler = between(
      "const failWorktreeStart = useCallback(",
      "const handleSend = useCallback("
    )
    expect(handler).toContain("description: commandErrorReason(error)")
    expect(handler).toContain("mqFailHead()")
    // …and the send's worktree branch hands its failure to it.
    const failure = between(
      "notifyWorktreeCreated(created, tBranch)",
      "// Connected AND the connection's cwd matches"
    )
    expect(failure).toContain("worktreeCreatePendingRef.current = false")
    expect(failure).toContain("failWorktreeStart(e)")
    expect(failure).not.toContain("toErrorMessage(e)")
  })
})

// #423：智能体不认这个会话了（`session_lost`），失败的那条消息自动重试一次。
// 判断在 `createSessionLostRetry`（单测在它旁边），这里守着它接在面板上。
describe("a lost session retries the message once", () => {
  it("notes the code during the turn and the message when the turn fails", () => {
    expect(source).toContain('envelope.code === "session_lost"')
    const edge = between(
      "const sessionLost = turnSessionLostRef.current",
      "completeTurn(effectiveConversationId)"
    )
    expect(edge).toContain("mqRequeueFailed(")
    expect(edge).toContain("sessionLostRetry.noteFailed(sent.draft)")
  })

  it("retries through the queue's own retry, once the old connection is gone", () => {
    const effect = between(
      "const route = sessionLostRetryRoute({",
      "reconnectInBackground,\n    sessionLostRetry,"
    )
    expect(effect).toContain(
      'if (route === "wait") return\n    if (!sessionLostRetry.takeReady(queueHead, connStatus)) return'
    )
    expect(effect).toContain("handleQueueRetry(queueHead.id)")
    // 切到别的会话以后：自己清掉失败标记、在后台重连。
    expect(effect).toContain(
      "mqRetry(queueHead.id)\n    reconnectInBackground()"
    )
  })
})
