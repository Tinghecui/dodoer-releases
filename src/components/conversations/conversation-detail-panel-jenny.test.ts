import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

// Guards for the jenny fork's "never make the user wait for the agent" send
// path. The behavioural cores are unit-tested (selector-reconcile,
// selectors-cache); these assert they stay wired into the panel.
const source = readFileSync(
  join(__dirname, "conversation-detail-panel.tsx"),
  "utf8"
)
const chatInput = readFileSync(
  join(__dirname, "..", "chat", "chat-input.tsx"),
  "utf8"
)

describe("jenny fork: send before the agent is ready", () => {
  it("queues instead of dropping when the connection is not ready", () => {
    const start = source.indexOf("if (!connectionReady) {")
    expect(start).toBeGreaterThan(-1)
    const block = source.slice(start, start + 300)
    expect(block).toContain("keepInQueue()")
    expect(block).toContain("handleFocus()")
    // The old silent drop must not come back.
    expect(source).not.toContain(
      "if (!connectionReady) return\n\n      const fromQueueFlush"
    )
  })

  it("keeps the message when agents are not enabled yet", () => {
    const start = source.indexOf(
      "if (!hasPersistedConversation && !canAutoConnect) {"
    )
    const block = source.slice(start, start + 200)
    expect(block).toContain("keepInQueue()")
  })

  it("waits for the session to finish initializing before flushing", () => {
    const start = source.indexOf("// Flush queued messages whenever the agent")
    const end = source.indexOf("clearTimeout(timer)", start)
    const flush = source.slice(start, end)
    expect(flush).toContain("if (selectorsLoading) return")
  })

  // Cowork fork: SQ4's saved-pick check is gone. It re-applied this browser's
  // per-agent picks to whatever conversation was sending, switching it to
  // another conversation's model; the server applies a conversation's own
  // values on connect instead.
  it("never re-applies the per-agent picks to a conversation", () => {
    expect(source).not.toContain("reconcileSessionPrefs")
    expect(source).not.toContain("diffConfigPreferences(")
    expect(source).not.toContain("getSavedPrefsForConnect")
  })

  // SQ5: a turn that fails after the message left puts the message back at
  // the front of the queue, marked failed, so the queue's retry can resend it.
  it("re-queues the sent message as failed when its turn fails", () => {
    const start = source.indexOf("const lastSentRef = useRef<")
    const block = source.slice(start, start + 900)
    expect(block).toContain('block.type === "turn_error"')
    // Cowork fork: the call also says when the failure was a sign-in refusal.
    expect(block).toContain("mqRequeueFailed(sent.draft, sent.modeId,")
  })

  it("wires the queue into the welcome composer", () => {
    const welcome = source.indexOf("flush\n                tall")
    const block = source.slice(welcome - 1200, welcome)
    expect(block).toContain("onEnqueue={mqEnqueue}")
    expect(block).toContain("queue={msgQueue}")
  })

  it("keeps the agent picker clickable while connecting", () => {
    expect(source).not.toContain(
      "disabled={isConnecting || dbConversationId != null}"
    )
    expect(source).toContain("agentType: connectAgent,")
  })

  it("does not lock the send button when a queue can hold the message", () => {
    expect(chatInput).toContain("allowOfflineCompose || onEnqueue")
  })
})
