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
    expect(effect).toContain('mqFailHead("send_failed")')
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

  // #1323：连接失败过、服务又好了，点一次「重试」就重连并在连上后发出去，
  // 不弹「打开 Agents 设置」（Cowork 下凭据在门户，这个指引有误导）。
  it("reconnects and then retries on a failed connection, without the Agents settings toast (#1323)", () => {
    for (const [start, target] of [
      ["const handleQueueRetry = useCallback(", "retryAfterReconnect.note(id)"],
      [
        "const handleQueueRetryAll = useCallback(",
        'retryAfterReconnect.note("all")',
      ],
    ]) {
      const fn = between(start, "const queueHeadFailure =")
      const branch = fn.slice(
        fn.indexOf('if (agentUnavailable === "connect_failed") {'),
        fn.indexOf("toast.error")
      )
      expect(branch).toContain(target)
      expect(branch).toContain("handleFocus()")
      expect(branch).toContain("return")
    }
    const effect = between(
      "retryAfterReconnect.observe({",
      "// Cowork 加的（#423）"
    )
    // #1640：连接错误一清掉就重试，不等就绪（由自动发送去等）。
    expect(effect).not.toContain("ready: connectionReady")
    expect(effect).toContain("unavailable: agentUnavailable")
    expect(effect).toContain("mqRetryAll()")
    expect(effect).toContain("mqRetry(target)")
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
    // 没有会话号的草稿按标签存（#650），见下面那组。
    expect(hook).toContain(
      "dbConversationId != null\n      ? messageQueueStorageKey(dbConversationId)"
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
    // #833：分支名太长时换成翻译好的说明，别的错误照旧带上原因
    expect(handler).toContain("description: isBranchNameTooLongError(error)")
    expect(handler).toContain('tBranch("dialogs.branchNameTooLong"')
    expect(handler).toContain(": commandErrorReason(error)")
    expect(handler).toContain('mqFailHead("send_failed")')
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
      "// Cancel previous metadata sync"
    )
    expect(edge).toContain("mqRequeueFailed(")
    expect(edge).toContain(
      "autoResend = sessionLostRetry.noteFailed(sent.draft)"
    )
    // #1066：要自动重发的那一轮不升格进对话区（`settleEndedTurn`，单测在
    // runtime-session-lost-resend.test.ts）。
    expect(edge).toContain("settleEndedTurn(")
    expect(edge).toContain(
      "optimisticTurnId: sent.optimisticTurnId, autoResend"
    )
    expect(edge).not.toContain("    completeTurn(effectiveConversationId)")
    expect(source).toContain("optimisticTurnId: optimisticTurn.id,")
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

// #650：刷新后新会话的智能体还没连上就按了回车，会话当场建出来，
// 排队的消息按这个会话号存起来，刷新不丢。判断和单飞在
// `draft-early-create`（单测在它旁边），这里守着它接在面板上。
describe("a draft sent before the agent is ready is saved at once", () => {
  it("starts the create from the not-ready branch, after queueing", () => {
    const block = between(
      "if (!connectionReady) {",
      "const fromQueueFlush = opts?.fromQueueFlush ?? false"
    )
    const queuedAt = block.indexOf("keepInQueue()")
    const createAt = block.indexOf("createDraftConversationEarly(draft)")
    expect(queuedAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(queuedAt)
  })

  it("shares the send path's single-flight and binds the tab", () => {
    const early = between(
      "const createDraftConversationEarly = useCallback(",
      "const handleSend = useCallback("
    )
    expect(early).toContain("startDraftCreateEarly(")
    expect(early).toContain("createConversationPendingRef,")
    // 两条分支都经 createOrAdoptDraftConversation 建（第 2 次返工，见下面）。
    expect(early.split("createOrAdoptDraftConversation(").length).toBe(3)
    expect(early).toContain("bindConversationTab(")
    expect(early).toContain("setCreatedConversationId(newConversationId)")
    expect(early).toContain("refreshConversations()")
    // 不在这里发消息：连上以后由排队区自动发出。
    expect(early).not.toContain("lifecycleSend(")
  })

  it("re-runs the queue flush once the row is bound", () => {
    // 建会话期间连接先好了，自动发送会被单飞挡回队首（长度不变）；
    // 会话号到了要再跑一次，不然消息停在队列里。
    const start = source.indexOf("// Flush queued messages whenever the agent")
    const deps = source.slice(
      source.indexOf("}, [", source.indexOf("clearTimeout(timer)", start)),
      source.indexOf("])", source.indexOf("clearTimeout(timer)", start))
    )
    expect(deps).toMatch(/\bdbConversationId\b/)
  })

  // 返工：请求返回前刷新也不能丢。没有会话号时按标签存。
  it("keeps a draft's queue under its tab until the row exists", () => {
    const hook = between(
      "const messageQueue = useMessageQueue(",
      "const {\n    queue: msgQueue,"
    )
    expect(hook).toContain("messageQueueStorageKey(dbConversationId)")
    expect(hook).toContain("draftMessageQueueStorageKey(tabId)")
  })

  // 第 8 次返工：绑上会话以后、排队区挪过去之前刷新，回来按会话号读，
  // 标签那份也要读回来。
  it("reads the tab's draft copy back once bound", () => {
    const hook = between(
      "const messageQueue = useMessageQueue(",
      "const {\n    queue: msgQueue,"
    )
    expect(hook).toContain("alsoReadKey: draftMessageQueueStorageKey(tabId)")
  })

  // 第 9 次返工：刷新回来的已绑标签 id 按会话号重新生成，按标签读不回；
  // 每处把草稿标签绑上会话之前，先把排队区挪到会话号下。
  it("moves the queue to the conversation key before every bind", () => {
    const binds = source.split("bindConversationTab(").slice(1)
    expect(binds.length).toBe(6)
    let from = 0
    for (let i = 0; i < binds.length; i += 1) {
      const at = source.indexOf("bindConversationTab(\n", from)
      const lead = source.slice(Math.max(0, at - 400), at)
      expect(lead).toMatch(
        /moveQueueStorageTo\(\s*messageQueueStorageKey\([^)]*\)\s*\)/
      )
      from = at + 1
    }
  })

  // 第 10 次返工：连上以后自动发送出队的那条，存储里留到后端收下，或者
  // 按新 id 放回排队区以后才拿掉；发送途中刷新读得回来。
  // 第 12 次返工：连上了、排队区空着，新会话回车直接发，建会话之前就存下来。
  it("stores a direct first send before the create starts", () => {
    const send = between(
      "const handleSend = useCallback(",
      "handleSendRef.current = handleSend"
    )
    const unbound = send.slice(
      send.indexOf("createConversationPendingRef.current = true")
    )
    // #970：第三个参数是这次发送的 clientMessageId
    const held = unbound.indexOf("queueItemId ??= mqHold(")
    expect(held).toBeGreaterThan(-1)
    expect(held).toBeLessThan(unbound.indexOf("void (async () => {"))
    expect(send).toMatch(/let queueItemId = opts\?\.queueItemId/)
  })

  it("keeps the flushed message stored until the send settles", () => {
    expect(source).toContain("{ fromQueueFlush: true, queueItemId: next.id }")
    const send = between(
      "const handleSend = useCallback(",
      "handleSendRef.current = handleSend"
    )
    expect(send).toMatch(/if \(queueItemId\) mqSettle\(queueItemId\)/)
    // 两条真正发出去的路都在后端收下后才拿掉
    expect(send.split("onSendAccepted: settleQueued").length - 1).toBe(2)
    // 放回排队区（keepInQueue、撞上忙、发送失败、建会话失败）以后才拿掉
    const keep = send.slice(
      send.indexOf("const keepInQueue = () => {"),
      send.indexOf("if (!hasPersistedConversation && !canAutoConnect)")
    )
    expect(keep).toMatch(/mqRequeueFront\([^)]*\)\s*settleQueued\(\)/)
    expect(send).toMatch(
      /const onTurnInProgress = \(\) => \{[\s\S]*?settleQueued\(\)\s*\}/
    )
    expect(
      send.match(/mqRequeueFailed\([^)]*\)\s*settleQueued\(\)/g)
    ).toHaveLength(2)
    const lifecycle = readFileSync(
      join(__dirname, "..", "..", "hooks", "use-connection-lifecycle.ts"),
      "utf8"
    )
    expect(lifecycle).toMatch(
      /await sendPrompt\(draft\.blocks, opts\)\s*opts\?\.onSendAccepted\?\.\(\)/
    )
  })

  it("re-runs the queue flush after a failed early create", () => {
    const early = between(
      "const createDraftConversationEarly = useCallback(",
      "const handleSend = useCallback("
    )
    expect(early).toContain("setEarlyCreateFailures((n) => n + 1)")
    const start = source.indexOf("// Flush queued messages whenever the agent")
    const deps = source.slice(
      source.indexOf("}, [", source.indexOf("clearTimeout(timer)", start)),
      source.indexOf("])", source.indexOf("clearTimeout(timer)", start))
    )
    expect(deps).toMatch(/\bearlyCreateFailures\b/)
  })

  it("marks the session for cleanup when the view is gone", () => {
    const early = between(
      "const createDraftConversationEarly = useCallback(",
      "const handleSend = useCallback("
    )
    const parts = early.split("if (!mountedRef.current) {")
    // chat 和普通两条分支都要标。
    expect(parts.length).toBe(3)
    for (const part of parts.slice(1)) {
      expect(part.slice(0, 300)).toContain(
        "setPendingCleanup(effectiveConversationId, true)"
      )
    }
  })

  it("creates once a chat draft's scratch dir is ready", () => {
    const effect = between(
      "queuedDraftNeedsEarlyCreate({",
      "createDraftConversationEarly(msgQueue[0].draft)"
    )
    expect(effect).toContain("connectionReady")
    expect(source).toMatch(
      /\}, \[[^\]]*chatDraftDir[^\]]*createDraftConversationEarly/
    )
  })
})

// #650 第 2 次返工：按回车后马上刷新，建会话请求可能已经在后端成功、浏览器
// 没收到会话号。刷新回来点重试要找回那一行，不再建一个。找回的逻辑在
// `createOrAdoptDraftConversation`（单测在 draft-early-create 旁边），
// 这里守着面板上建会话的四个地方都经它走、绑好以后清掉票据。
describe("a retried draft reuses the row an interrupted create made", () => {
  const early = () =>
    between(
      "const createDraftConversationEarly = useCallback(",
      "const handleSend = useCallback("
    )
  const sendCreate = () =>
    between(
      "if (createConversationPendingRef.current) {\n        keepInQueue()",
      '} catch (e) {\n          console.error("[ConversationTabView] create conversation:"'
    )

  for (const [name, block] of [
    ["early create", early],
    ["send path", sendCreate],
  ] as const) {
    it(`${name}: chat and normal both create through the ticket`, () => {
      const b = block()
      expect(b.split("createOrAdoptDraftConversation(").length).toBe(3)
      expect(b).not.toMatch(/await createChatConversation\(/)
      expect(b).not.toMatch(/await createConversation\(/)
    })

    it(`${name}: clears the ticket once bound, mounted or not`, () => {
      const b = block()
      for (const part of b.split("if (!mountedRef.current) {").slice(1)) {
        expect(part.slice(0, 300)).toContain("clearDraftCreateTicket(tabId)")
      }
      const binds = b.split("bindConversationTab(").length - 1
      expect(binds).toBe(2)
      expect(b.split("clearDraftCreateTicket(tabId)").length - 1).toBe(3)
    })
  }
})

// #650 第 5 次返工（人定的）：按回车后建好的那条会话就是这条消息的归宿。
// 刷新回来，草稿标签要当场绑上刷新前那次建出来的会话（排队区随之换成按
// 会话号存），不等点重试；建好或找回的行不能一直算「进行中」。找回和标记的
// 逻辑在 `recoverDraftConversation` / `createOrAdoptDraftConversation`
// （单测在 draft-early-create 旁边），这里守着它们接在面板上。
describe("a reloaded draft lands on the conversation its Enter made", () => {
  const recovery = () =>
    between(
      "recoverDraftConversation(tabId, DRAFT_CREATE_DEPS",
      "// 只在挂载时跑一次（见上）。"
    )

  it("marks created rows not running through the status write", () => {
    const deps = between(
      "const DRAFT_CREATE_DEPS: DraftCreateDeps = {",
      "function buildVirtualConversationId"
    )
    expect(deps).toContain("markConversationNotRunning:")
    expect(deps).toContain('updateConversationStatus(id, "pending_review")')
  })

  it("looks the row up once on mount, for a draft only", () => {
    const effect = between(
      "// #650 第 5 次返工：刷新回来的草稿标签",
      "recoverDraftConversation(tabId, DRAFT_CREATE_DEPS"
    )
    expect(effect).toContain("dbConvIdRef.current != null")
    expect(effect).toContain("pendingWorktree")
    // 和建会话共用单飞：找的时候点重试不会另建一个。
    expect(effect).toContain("createConversationPendingRef.current = true")
  })

  it("binds the tab to the found row and leaves the welcome page", () => {
    const b = recovery()
    expect(b).toContain("setCreatedConversationId(res.conversationId)")
    expect(b).toContain("bindConversationTab(")
    expect(b).toContain("upsertFolder(res.folder)")
    expect(b).toContain("clearDraftCreateTicket(tabId)")
    expect(b).toContain("setHasSentMessage(true)")
    expect(b).toContain("createConversationPendingRef.current = false")
    expect(b).toContain("setDraftRecoveryDone(true)")
  })

  it("re-runs the queue flush once the lookup is done", () => {
    const start = source.indexOf("// Flush queued messages whenever the agent")
    const deps = source.slice(
      source.indexOf("}, [", source.indexOf("clearTimeout(timer)", start)),
      source.indexOf("])", source.indexOf("clearTimeout(timer)", start))
    )
    expect(deps).toMatch(/\bdraftRecoveryDone\b/)
  })
  // 第 7 次返工（P1）：找不到时当场建，但只在这个标签还有排队的消息时；
  // 刚挂载时排队区还没读回来，要看存储里那份。
  it("tells the lookup whether a message is waiting under the tab", () => {
    const b = recovery()
    expect(b).toContain("hasQueued:")
    expect(b).toContain("readStoredQueue(draftMessageQueueStorageKey(tabId))")
  })

  // 第 7 次返工（P1）：按回车那一刻就记下要建会话，请求发出去之前刷新也知道。
  it("notes the create the moment Enter is pressed", () => {
    const early = between(
      "const createDraftConversationEarly = useCallback(",
      "startDraftCreateEarly("
    )
    expect(early).toContain("noteDraftCreateIntent(")
  })

  // 第 7 次返工（P2）：标成「待复查」会改更新时间，不能因此显示「已完成，尚未查看」。
  it("keeps a row it marks not running from reading unread", () => {
    const deps = between(
      "const DRAFT_CREATE_DEPS: DraftCreateDeps = {",
      "function buildVirtualConversationId"
    )
    expect(deps).toContain("markConversationSeen(id)")
  })
})

// 第 11 次返工（收件箱 #716 的 P1）：聊天模式回车后 0.3～0.8 秒刷新再点重试，
// 会话卡在「进行中」、最后消息消失。判断在 `sessionIdForBoundDraft`、
// `lostTurnRequeueKind`（各自有单测），这里查它们接在面板上。
describe("a chat draft bound after a reload retries on a fresh session", () => {
  it("drops the new dir's session in every chat bind", () => {
    const calls = source.match(/sessionIdForBoundDraft\(\{/g) ?? []
    // 提前建会话、发送那条路、挂载时找回，三处 chat 绑定
    expect(calls.length).toBe(3)
    expect(source).not.toContain(
      "setExternalId(effectiveConversationId, sessionIdRef.current ?? null)\n            setDbConversationId(effectiveConversationId, newConversationId)\n            if (!mountedRef.current) {\n              setPendingCleanup(effectiveConversationId, true)\n              clearDraftCreateTicket(tabId)\n              refreshConversations()\n              return\n            }\n            upsertFolder(res.folder)"
    )
  })

  it("clears the session before the recovered chat row is bound", () => {
    const recover = between(
      "const res = await recoverDraftConversation(",
      "clearDraftCreateTicket(tabId)"
    )
    const keep = recover.indexOf("sessionIdForBoundDraft(")
    expect(keep).toBeGreaterThan(-1)
    expect(recover.indexOf("bindConversationTab(", keep)).toBeGreaterThan(keep)
  })

  it("puts the message back when the agent quits mid-turn", () => {
    expect(source).toContain(
      "failedTurnRequeueKind(liveContent, authFailed) ??\n      lostTurnRequeueKind(liveContent, connStatus)"
    )
  })
})

// #792：连上了、但连的还是上一个会话的目录时，排队的消息不能一直等就绪。
describe("a connection bound to another target does not hold the queue forever", () => {
  it("re-requests the connection from the send path", () => {
    const start = source.indexOf("if (!connectionReady) {")
    const block = source.slice(start, start + 600)
    expect(block).toContain("notReadyRecovery(connStatusRef.current)")
    expect(block).toContain('recovery === "retarget"')
    expect(block).toContain("retargetConnection()")
  })

  it("fails the head after the stale-target timeout", () => {
    const effect = between(
      "const staleConnectedTarget =",
      "// Mirror the connection's liveMessage"
    )
    expect(effect).toContain(
      'connStatus === "connected" && (!connectionReady || selectorsLoading)'
    )
    // 计时本身（满 15 秒、加消息不清零）由 use-stale-target-fail.test.ts 跑
    expect(effect).toContain("useStaleTargetFail({")
    expect(effect).toContain("stale: staleConnectedTarget")
    expect(effect).toContain("queueLength: msgQueue.length")
    expect(effect).toContain("headFailed: queueHeadFailed")
    expect(effect).toContain("isReady: () => connectionReadyRef.current")
    expect(effect).toContain("retargetConnection()")
    expect(effect).toContain('mqFailHead("send_failed")')
  })
})

// #868：连的目录和智能体都对，会话却一直没初始化完（selectorsLoading 一直为真），
// 排队自动发送被它挡住；兜底计时也要管这种，到点强制重连（同参数的
// retargetConnection 会被 connect 去重）。
describe("a session that never finishes initializing does not hold the queue forever", () => {
  it("counts a never-ready session as stale", () => {
    const effect = between(
      "const staleConnectedTarget =",
      "// Mirror the connection's liveMessage"
    )
    expect(effect).toContain(
      'connStatus === "connected" && (!connectionReady || selectorsLoading)'
    )
    expect(effect).toContain(
      "isReady: () => connectionReadyRef.current && !selectorsLoadingRef.current"
    )
  })

  it("force-reconnects a right-target connection, retargets a wrong one", () => {
    const effect = between(
      "const staleConnectedTarget =",
      "// Mirror the connection's liveMessage"
    )
    const onTimeout = effect.slice(effect.indexOf("onTimeout:"))
    expect(onTimeout).toContain("if (!connectionReadyRef.current)")
    expect(onTimeout).toContain("retargetConnection()")
    expect(onTimeout).toContain("void forceReconnect()")
    expect(onTimeout).toContain('mqFailHead("send_failed")')
  })

  // 审查打回：发完就切到别的标签，后台标签到点也要重连，只看能不能连。
  it("force-reconnects a background tab too, as long as it can connect", () => {
    const effect = between(
      "const staleConnectedTarget =",
      "// Mirror the connection's liveMessage"
    )
    const onTimeout = effect.slice(effect.indexOf("onTimeout:"))
    expect(onTimeout).toContain(
      "else if (canForceReconnectRef.current) void forceReconnect()"
    )
    const refs = between(
      "const canForceReconnectRef",
      "const staleConnectedTarget ="
    )
    expect(refs).toContain("canAutoConnect && agentUnavailableReason == null")
    expect(refs).not.toContain("isActive")
  })
})

// #1118：自动重发也没连上，连接停在「未连接」又没留下失败记录时，没有谁会再去连，
// 排队区不能一直写「启动较慢，已等待 N 秒」：满时限再连一次，并把队首标失败、带重试。
// 判断「没有连接在进行」的是 `queueWaitsOnIdleConnection`（queue-flush.test.ts）。
describe("a queue waiting on a connection nobody is starting", () => {
  it("fails the head after the timeout and tries the connection once more", () => {
    const effect = between(
      "const queueIdleDisconnected =",
      "const queueWaitingForConnect ="
    )
    expect(effect).toContain("queueWaitsOnIdleConnection(composerConnStatus)")
    expect(effect).toContain("isActive &&")
    expect(effect).toContain("canAutoConnect &&")
    expect(effect).toContain("agentUnavailable == null")
    expect(effect).toContain("stale: queueIdleDisconnected")
    expect(effect).toContain("queueLength: msgQueue.length")
    expect(effect).toContain("headFailed: queueHeadFailed")
    expect(effect).toContain(
      "isReady: () => !queueWaitsOnIdleConnection(composerConnStatus)"
    )
    const onTimeout = effect.slice(effect.indexOf("onTimeout:"))
    expect(onTimeout).toContain("handleFocus()")
    expect(onTimeout).toContain('mqFailHead("send_failed")')
  })

  it("does not tell the user the message will send by itself while nothing connects", () => {
    const waiting = between(
      "const queueWaitingForConnect =",
      "const queueSlowWaitSeconds ="
    )
    expect(waiting).toContain("!queueIdleDisconnected")
  })
})

// #970：发出去的那条带着 clientMessageId 存下，退出重开后会话里有同一个 id
// 的用户消息时，读回的「发送失败」拿掉。
describe("a send that reached the backend before a quit", () => {
  it("stores the send's clientMessageId with the held and the dequeued item", () => {
    const send = between("const handleSend = useCallback(", "    [\n")
    expect(send).toMatch(
      /if \(queueItemId\)\s*mqStampInFlight\(queueItemId, optimisticTurn\.id, firstOfConversation\)/
    )
    expect(send).toMatch(
      /mqHold\(\s*draft,\s*selectedModeIdArg \?\? null,\s*optimisticTurn\.id,\s*firstOfConversation\s*\)/
    )
    // 发之前会话里有没有消息，在加乐观轮次之前看
    expect(send.indexOf("const firstOfConversation =")).toBeGreaterThan(-1)
    expect(send.indexOf("const firstOfConversation =")).toBeLessThan(
      send.indexOf("appendOptimisticTurn(")
    )
  })

  it("drops the restored copy once the conversation shows that id", () => {
    const effect = between(
      "const pendingUserMessageId =",
      "const connStatusRef = useRef(connStatus)"
    )
    expect(effect).toContain("conn.pendingUserMessage?.messageId")
    expect(effect).toContain(
      "deliveredClientMessageIds(pendingUserMessageId, detail?.turns)"
    )
    // 智能体还在回时不按文字认：把进行中的用户消息 id 一起交给它
    expect(effect).toMatch(
      /firstUserTurnText\(\s*detail\?\.turns,\s*detail\?\.turns_offset,\s*pendingUserMessageId\s*\)/
    )
    expect(effect).toContain(
      "mqDropDelivered(deliveredUserTurnIds, deliveredFirstUserText)"
    )
  })
})

// #984：发送请求没等到回应，服务器其实收下了：不留「发送失败」的副本。
// 判断逻辑在 `uncertain-send.ts` 里单测，这里守住它接在面板上。
describe("a send that got no answer but reached the server", () => {
  it("is not rolled back when the server already echoed it", () => {
    const failed = between(
      "const onSendFailed: SendFailedCallback = (_error, info) => {",
      "// Pin the tab if it was a temporary preview"
    )
    const delivered = failed.indexOf(
      "info?.uncertain && uncertainSends.echoed(optimisticTurn.id)"
    )
    expect(delivered).toBeGreaterThan(-1)
    expect(failed.indexOf('return "delivered"')).toBeGreaterThan(delivered)
    expect(failed.indexOf('return "delivered"')).toBeLessThan(
      failed.indexOf("removeOptimisticTurn(")
    )
    // 没回传过的：照旧放回排队区标失败，并记下它的排队 id。
    expect(failed).toContain(
      "const queueItemId = mqRequeueFailed(draft, selectedModeIdArg ?? null)"
    )
    // 第 1 次返工：记下的是放回去的那份草稿本身，迟到的回传靠它认出用户改没改过。
    expect(failed.replace(/\s+/g, " ")).toContain(
      "uncertainSends.noteUncertain(optimisticTurn.id, { queueItemId, draft, })"
    )
  })

  it("takes the failed copy out when the server echoes it later", () => {
    const live = between(
      'if (envelope.type !== "user_message") return',
      "appendViewerUserTurn("
    )
    expect(live).toContain("uncertainSends.noteEcho(envelope.message_id)")
    // 第 1 次返工：只拿掉原样没动过的副本（用户改过、正在改的留着）。
    const takeBack =
      "mqRemoveIfUnchanged(uncertainCopy.queueItemId, uncertainCopy.draft)"
    expect(live).toContain(takeBack)
    expect(live).not.toContain("mqRemove(uncertainCopy")
    const snapshot = between(
      "const pending = conn.pendingUserMessage",
      "appendViewerUserTurn("
    )
    expect(snapshot).toContain("uncertainSends.noteEcho(pending.messageId)")
    expect(snapshot).toContain(takeBack)
    expect(snapshot).not.toContain("mqRemove(uncertainCopy")
  })
})
