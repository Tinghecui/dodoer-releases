import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { isStrandedTurn, type SentTurnWatch } from "./stranded-turn"

// Cowork fork (#172): a reply whose events never reached the tab left the sent
// message under "进行中" until a reload, while the sidebar already read the
// conversation as finished.

const sentAt = "2026-11-13T06:57:20Z"
const watch = (over: Partial<SentTurnWatch> = {}): SentTurnWatch => ({
  summaryUpdatedAt: sentAt,
  sawPrompting: false,
  ...over,
})

describe("isStrandedTurn", () => {
  it("is stranded once the row has moved on and the tab never saw the turn run", () => {
    expect(
      isStrandedTurn(watch(), "connected", {
        status: "pending_review",
        updated_at: "2026-11-13T06:58:00Z",
      })
    ).toBe(true)
  })

  it("counts a draft's first send, which had no row yet", () => {
    expect(
      isStrandedTurn(watch({ summaryUpdatedAt: null }), "connected", {
        status: "pending_review",
        updated_at: "2026-11-13T06:58:00Z",
      })
    ).toBe(true)
  })

  it("leaves a turn the tab watched run to the prompting→idle edge", () => {
    expect(
      isStrandedTurn(watch({ sawPrompting: true }), "connected", {
        status: "pending_review",
        updated_at: "2026-11-13T06:58:00Z",
      })
    ).toBe(false)
  })

  it("waits while the connection is prompting or the row says in progress", () => {
    const done = { status: "pending_review" as const, updated_at: "x" }
    expect(isStrandedTurn(watch(), "prompting", done)).toBe(false)
    expect(
      isStrandedTurn(watch(), "connected", {
        status: "in_progress",
        updated_at: "2026-11-13T06:57:21Z",
      })
    ).toBe(false)
  })

  it("does not read the previous turn's row as this one's end", () => {
    expect(
      isStrandedTurn(watch(), "connected", {
        status: "pending_review",
        updated_at: sentAt,
      })
    ).toBe(false)
    expect(
      isStrandedTurn(watch({ summaryUpdatedAt: null }), "connected", null)
    ).toBe(false)
  })

  it("has nothing to settle without a send", () => {
    expect(
      isStrandedTurn(null, "connected", {
        status: "pending_review",
        updated_at: "2026-11-13T06:58:00Z",
      })
    ).toBe(false)
  })
})

describe("the panel settles a stranded turn", () => {
  const source = readFileSync(
    join(__dirname, "conversation-detail-panel.tsx"),
    "utf8"
  )
  const effect = source.slice(
    source.indexOf(
      "// Cowork fork (#172): settle a turn this tab never saw run"
    ),
    source.indexOf(
      "// Auto-send queued messages when agent finishes responding."
    )
  )

  it("marks the send as seen running and settles from the saved conversation", () => {
    expect(effect).toContain("lastSentRef.current.watch.sawPrompting = true")
    expect(effect).toContain("STRANDED_TURN_GRACE_MS")
    expect(effect).toContain("completeTurn(effectiveConversationId)")
    expect(effect).toContain("refetchDetail(effectiveConversationId)")
    // Re-checked when the grace runs out, against the live status.
    expect(effect).toContain("connStatusRef.current")
  })

  it("records the row as it was when the message went out", () => {
    expect(source).toContain("summaryUpdatedAt: rowUpdatedAtRef.current")
  })
})
