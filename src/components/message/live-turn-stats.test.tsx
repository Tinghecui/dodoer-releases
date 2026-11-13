import { cleanup, render } from "@testing-library/react"
import { NextIntlClientProvider, type Locale } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import { extractLiveEditStats, LiveTurnStats } from "./live-turn-stats"
import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import type { AwaitingUserKind } from "@/stores/awaiting-user-store"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"

// --- fixtures --------------------------------------------------------------

let toolIdCounter = 0

// A completed tool_call block with a deliberately NON-classifying title/kind
// ("tool"), so the tool is classified purely by `raw_input` shape. This means a
// regression in input-shape detection can't be masked by a title/kind fallback.
function toolBlock(rawInput: string): LiveContentBlock {
  toolIdCounter += 1
  return {
    type: "tool_call",
    info: {
      tool_call_id: `tc-${toolIdCounter}`,
      title: "tool",
      kind: "tool",
      status: "completed",
      content: null,
      raw_input: rawInput,
      raw_output_chunks: [],
      raw_output_total_bytes: 0,
      locations: null,
      meta: null,
      images: [],
    },
  }
}

function textBlock(text: string): LiveContentBlock {
  return { type: "text", text }
}

function msg(content: LiveContentBlock[]): LiveMessage {
  return { id: "m1", role: "assistant", content, startedAt: 0 }
}

// `{content, file_path}` → classified as "write"; additions = line count.
const writeInput = (content: string, filePath: string) =>
  JSON.stringify({ content, file_path: filePath })

// A minimal codex-style patch → classified as "apply_patch".
const applyPatch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`

// --- tests -----------------------------------------------------------------

describe("extractLiveEditStats", () => {
  it("counts a write tool's added lines and file", () => {
    const stats = extractLiveEditStats(
      msg([toolBlock(writeInput("a\nb\nc", "x.ts"))])
    )
    expect(stats).toEqual({ files: 1, additions: 3, deletions: 0 })
  })

  it("counts an apply_patch tool's added lines and file", () => {
    const stats = extractLiveEditStats(
      msg([toolBlock(applyPatch("*** Add File: new.ts\n+alpha\n+beta"))])
    )
    expect(stats).toEqual({ files: 1, additions: 2, deletions: 0 })
  })

  it("dedupes files and sums line counts across blocks", () => {
    const stats = extractLiveEditStats(
      msg([
        toolBlock(writeInput("a", "same.ts")),
        toolBlock(writeInput("b\nc", "same.ts")),
      ])
    )
    expect(stats).toEqual({ files: 1, additions: 3, deletions: 0 })
  })

  it("ignores non-edit blocks", () => {
    const stats = extractLiveEditStats(
      msg([textBlock("hello"), toolBlock('{"command":"ls"}')])
    )
    expect(stats).toEqual({ files: 0, additions: 0, deletions: 0 })
  })

  it("returns a stable result when called repeatedly (cache hit)", () => {
    const message = msg([toolBlock(writeInput("a\nb", "x.ts"))])
    const first = extractLiveEditStats(message)
    const second = extractLiveEditStats(message)
    expect(second).toEqual(first)
    expect(first).toEqual({ files: 1, additions: 2, deletions: 0 })
  })

  it("leaves out a write the user turned down or that failed", () => {
    // Rejected live: the permission request's "No" ends the call as failed.
    const rejected = toolBlock(writeInput("a\nb\nc", "notes.txt"))
    if (rejected.type !== "tool_call") throw new Error("fixture")
    rejected.info.status = "failed"
    // Reopened conversation: the detail load's approval stamp says rejected.
    const stamped = toolBlock(writeInput("x", "other.txt"))
    if (stamped.type !== "tool_call") throw new Error("fixture")
    stamped.info.meta = {
      "codeg.approval": { option_kind: "reject_once", option_name: "No" },
    }
    const landed = toolBlock(writeInput("p\nq", "kept.txt"))

    expect(extractLiveEditStats(msg([rejected, stamped]))).toEqual({
      files: 0,
      additions: 0,
      deletions: 0,
    })
    expect(extractLiveEditStats(msg([rejected, stamped, landed]))).toEqual({
      files: 1,
      additions: 2,
      deletions: 0,
    })
  })

  it("still counts an approved write", () => {
    const approved = toolBlock(writeInput("a", "ok.txt"))
    if (approved.type !== "tool_call") throw new Error("fixture")
    approved.info.meta = {
      "codeg.approval": { option_kind: "allow_once", option_name: "Yes" },
    }
    expect(extractLiveEditStats(msg([approved]))).toEqual({
      files: 1,
      additions: 1,
      deletions: 0,
    })
  })

  it("reuses a cached block's contribution when it reappears in a new message", () => {
    // The reducer preserves an unchanged block's reference across streaming
    // tokens, so the same block object shows up in successive messages. The
    // per-block cache must still aggregate it correctly alongside new blocks.
    const shared = toolBlock(writeInput("a\nb\nc", "x.ts"))
    const before = extractLiveEditStats(msg([shared]))
    expect(before).toEqual({ files: 1, additions: 3, deletions: 0 })

    const added = toolBlock(writeInput("p\nq", "z.ts"))
    const after = extractLiveEditStats(msg([shared, added]))
    expect(after).toEqual({ files: 2, additions: 5, deletions: 0 })
  })
})

describe("LiveTurnStats", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // That the agent is at work, and at what — thinking, running a step,
  // writing — is the transcript's to say: its header reads "Working", the step
  // shimmers and a ring turns at the foot of its rail. The row above the
  // composer keeps only its figures: no word, and no pulsing agent mark.
  it("opens on the time, with no mark or word for what the agent is doing", () => {
    vi.useFakeTimers()
    vi.setSystemTime(65_000)
    for (const content of [
      [{ type: "thinking", text: "Checking the logs" } as LiveContentBlock],
      [textBlock("Writing the fix")],
    ]) {
      const view = render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <LiveTurnStats message={msg(content)} />
        </NextIntlClientProvider>
      )
      const row = view.container.firstElementChild!.firstElementChild!
      expect(row.children).toHaveLength(1)
      expect(
        row.firstElementChild!.querySelector("svg.lucide-timer")
      ).toBeTruthy()
      expect(row.querySelectorAll("svg")).toHaveLength(1)
      expect(row.querySelector(".animate-pulse")).toBeNull()
      expect(row.textContent).toBe("1m 5s")
      view.unmount()
    }
  })
})

// AI QA #98: with a permission request left unanswered the capsule above the
// composer went on as if the agent were at work — the turn is still running
// then, but it is the user's move. The one state the row names.
describe("LiveTurnStats while the agent waits on the user", () => {
  afterEach(cleanup)

  // A turn that started 65 seconds ago: the timer reads "1m 5s".
  const liveMessage = (): LiveMessage => ({
    id: "m1",
    role: "assistant",
    content: [textBlock("About to write notes.txt")],
    startedAt: Date.now() - 65_000,
  })

  function renderCapsule(
    awaitingUser: AwaitingUserKind | null,
    locale: Locale = "en"
  ): string {
    const { container } = render(
      <NextIntlClientProvider
        locale={locale}
        messages={locale === "zh-CN" ? zhCNMessages : enMessages}
      >
        <LiveTurnStats message={liveMessage()} awaitingUser={awaitingUser} />
      </NextIntlClientProvider>
    )
    return container.querySelector("[data-live-turn-stats]")?.textContent ?? ""
  }

  // Upstream 0.43: the row has no word for what the agent is doing (the
  // transcript says it), so there is no "Streaming" left to replace.
  it("names nothing while nothing waits on the user", () => {
    const text = renderCapsule(null)
    expect(text).toBe("1m 5s")
  })

  it.each([
    ["permission", "Needs your approval"],
    ["question", "Needs your answer"],
    ["plan", "Plan needs your approval"],
  ] as const)("names a pending %s instead of streaming", (kind, wording) => {
    const text = renderCapsule(kind)
    expect(text).toContain(wording)
    expect(text).not.toContain("Streaming")
    expect(text).not.toContain("Thinking")
  })

  it("keeps the turn's elapsed time next to the wait", () => {
    expect(renderCapsule("permission")).toContain("1m 5s")
  })

  it("outranks the thinking state", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <LiveTurnStats
          message={{
            id: "m1",
            role: "assistant",
            content: [{ type: "thinking", text: "" }],
            startedAt: Date.now(),
          }}
          awaitingUser="question"
        />
      </NextIntlClientProvider>
    )
    expect(container.textContent).toContain("Needs your answer")
    expect(container.textContent).not.toContain("Thinking")
  })

  it("uses the sidebar badge's wording in Chinese too", () => {
    const text = renderCapsule("permission", "zh-CN")
    expect(text).toContain("等你批准操作")
    expect(text).not.toContain("生成中")
  })
})
