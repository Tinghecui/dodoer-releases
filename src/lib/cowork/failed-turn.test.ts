import { afterEach, describe, expect, it, vi } from "vitest"

import type { LiveContentBlock } from "@/contexts/acp-connections-context"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import type { MessageTurn, PromptDraft } from "@/lib/types"
import {
  draftFromUserTurn,
  failedTurnRequeueKind,
  lostConnectionRetryTurn,
  lostTurnRequeueKind,
  lostTurnRetryPlan,
  readFailedTurnSend,
  writeFailedTurnSend,
  turnErrorKindOf,
  turnHadAgentOutput,
} from "./failed-turn"

const turnError: LiveContentBlock = {
  type: "turn_error",
  message: "被终止 · SIGKILL",
  fromAgent: false,
}
const toolCall = {
  type: "tool_call",
  info: { tool_call_id: "t1", title: "Run sleep 300 in background" },
} as unknown as LiveContentBlock

describe("failedTurnRequeueKind", () => {
  it("不放回已经执行过工具调用的失败轮次", () => {
    expect(failedTurnRequeueKind([toolCall, turnError], false)).toBeNull()
  })

  it("不放回已经回过文字或思考的失败轮次", () => {
    expect(
      failedTurnRequeueKind([{ type: "text", text: "好的" }, turnError], false)
    ).toBeNull()
    expect(
      failedTurnRequeueKind(
        [{ type: "thinking", text: "想一想" }, turnError],
        false
      )
    ).toBeNull()
  })

  it("没有任何输出就失败的，放回并标成 turn_failed", () => {
    expect(failedTurnRequeueKind([turnError], false)).toBe("turn_failed")
    expect(
      failedTurnRequeueKind([{ type: "text", text: "  " }, turnError], false)
    ).toBe("turn_failed")
  })

  it("要登录的保持 auth", () => {
    expect(failedTurnRequeueKind([turnError], true)).toBe("auth")
  })

  it("没失败的不放回", () => {
    expect(failedTurnRequeueKind([toolCall], false)).toBeNull()
    expect(failedTurnRequeueKind([], false)).toBeNull()
    expect(failedTurnRequeueKind(null, false)).toBeNull()
  })
})

describe("turnHadAgentOutput", () => {
  it("用户中途插话和 turn_error 不算输出", () => {
    expect(
      turnHadAgentOutput([
        { type: "steering", id: "n1", text: "停一下", createdAt: "" },
        turnError,
      ])
    ).toBe(false)
  })
})

// 第 11 次返工（#650，收件箱 #716）：智能体进程在回合里退出、什么都没回，
// 也没有 turn_error 这一行时，消息不能跟着这一轮消失，要放回排队区带重试。
describe("lostTurnRequeueKind", () => {
  it("puts the message back when the agent went away before answering", () => {
    expect(lostTurnRequeueKind([], "disconnected")).toBe("turn_failed")
    expect(lostTurnRequeueKind(null, "error")).toBe("turn_failed")
  })

  it("keeps a message the agent already answered out of the queue", () => {
    expect(lostTurnRequeueKind([toolCall], "disconnected")).toBeNull()
  })

  it("does nothing for a turn that ended normally", () => {
    expect(lostTurnRequeueKind([], "connected")).toBeNull()
  })
})

// #1120：连接断了的那一轮，「重试」要重发的是哪条消息。
describe("lost connection retry", () => {
  const TS = "2026-11-21T00:00:00.000Z"
  const user = (id: string, text: string): MessageTurn => ({
    id,
    role: "user",
    blocks: [
      { type: "text", text },
      { type: "image", data: "AAAA", mime_type: "image/png", uri: null },
    ],
    timestamp: TS,
  })
  const reply: MessageTurn = {
    id: "a1",
    role: "assistant",
    blocks: [{ type: "text", text: "好" }],
    timestamp: TS,
  }
  const lostLine = (kind?: "connection_lost"): MessageTurn => ({
    id: "f1",
    role: "system",
    blocks: [
      {
        type: "turn_error",
        message: "The connection to Claude was lost.",
        ...(kind ? { kind } : {}),
      },
    ],
    timestamp: TS,
  })

  it("认出连接断了、建议开新会话的失败记录", () => {
    const record = {
      id: "t1:error",
      revision: 1,
      category: "connection",
      severity: "error",
      title: "The connection to Claude was lost.",
      actions: ["new_session"],
    }
    expect(turnErrorKindOf(record)).toBe("connection_lost")
    expect(turnErrorKindOf({ ...record, actions: ["retry"] })).toBeUndefined()
    expect(turnErrorKindOf({ ...record, category: "limit" })).toBeUndefined()
  })

  it("最后一轮是连接断了的失败时，重发这一轮的用户消息", () => {
    const turns = [user("u0", "早一点的"), reply, user("u1", "kill $PPID")]
    expect(
      lostConnectionRetryTurn([...turns, reply, lostLine("connection_lost")])
        ?.id
    ).toBe("u1")
    // 别的失败、失败后面又有东西的，都不给重试。
    expect(lostConnectionRetryTurn([...turns, lostLine()])).toBeNull()
    expect(
      lostConnectionRetryTurn([...turns, lostLine("connection_lost"), reply])
    ).toBeNull()
  })

  it("从用户消息还原出要重发的内容", () => {
    expect(draftFromUserTurn(user("u1", "kill $PPID"))).toEqual({
      blocks: [
        { type: "text", text: "kill $PPID" },
        { type: "image", data: "AAAA", mime_type: "image/png", uri: null },
      ],
      displayText: "kill $PPID",
    })
    expect(
      draftFromUserTurn({ id: "u", role: "user", blocks: [], timestamp: TS })
    ).toBeNull()
  })

  // #1120 返工：「重试」到底重发什么。
  const withFile: PromptDraft = {
    blocks: [
      { type: "text", text: "看看这个文件" },
      {
        type: "resource",
        uri: "file:///tmp/demo/notes.md",
        mime_type: "text/markdown",
        text: "# 笔记",
        blob: null,
      },
    ],
    displayText: "看看这个文件",
  }
  const turns = [user("u1", "看看这个文件"), lostLine("connection_lost")]
  const queued = (id: string, failed: boolean): QueuedMessage => ({
    id,
    draft: withFile,
    modeId: "plan",
    failed,
  })

  it("记着当初发出去的原样时，重发原样（带附件），不从对话里还原", () => {
    expect(
      lostTurnRetryPlan({
        turns,
        kept: { draft: withFile, modeId: "plan", queueItemId: null },
        queue: [],
        selectedModeId: "default",
      })
    ).toEqual({ kind: "enqueue", draft: withFile, modeId: "plan" })
  })

  it("这一轮的消息已经放回排队区时，重试的是排队区里那一条", () => {
    const kept = { draft: withFile, modeId: "plan", queueItemId: "q1" }
    expect(
      lostTurnRetryPlan({
        turns,
        kept,
        queue: [queued("q1", true), queued("q2", false)],
        selectedModeId: null,
      })
    ).toEqual({ kind: "queue", itemId: "q1" })
    // 那一条已经在发了（不是失败的）：不给。
    expect(
      lostTurnRetryPlan({
        turns,
        kept,
        queue: [queued("q1", false)],
        selectedModeId: null,
      })
    ).toBeNull()
    // 排队区里还有别的消息（第 4 次返工）：照样给，放到排队区最前面重发。
    expect(
      lostTurnRetryPlan({
        turns,
        kept: { ...kept, queueItemId: null },
        queue: [queued("q2", true)],
        selectedModeId: null,
      })
    ).toEqual({ kind: "enqueue", draft: withFile, modeId: "plan" })
    // 记着的排队 id 已经不在排队区（发出去了、被删了）、排队区里有别的：也给。
    expect(
      lostTurnRetryPlan({
        turns,
        kept,
        queue: [queued("q2", false)],
        selectedModeId: null,
      })
    ).toEqual({ kind: "enqueue", draft: withFile, modeId: "plan" })
  })

  it("只认这次失败的那条：附件、多出来的字不一样都不算（第 4 次返工）", () => {
    const fileOnly = (name: string): PromptDraft => ({
      blocks: [
        {
          type: "resource_link",
          uri: `file:///tmp/demo/${name}`,
          name,
        },
      ],
      displayText: "",
    })
    const shownAs = (text: string): MessageTurn => ({
      id: "u9",
      role: "user",
      blocks: [{ type: "text", text }],
      timestamp: TS,
    })
    const at = (turn: MessageTurn) => [turn, lostLine("connection_lost")]
    const plan = (turn: MessageTurn, draft: PromptDraft) =>
      lostTurnRetryPlan({
        turns: at(turn),
        kept: { draft, modeId: "plan", queueItemId: null },
        queue: [],
        selectedModeId: "default",
      })
    // 两台设备各发了一个只带附件的消息：本机那份是 a.md，失败的是 b.md。
    expect(
      plan(shownAs("[@b.md](file:///tmp/demo/b.md)"), fileOnly("a.md"))
    ).toMatchObject({ modeId: "default" })
    // 附件对得上的照样用原样。
    expect(
      plan(shownAs("[@a.md](file:///tmp/demo/a.md)"), fileOnly("a.md"))
    ).toEqual({ kind: "enqueue", draft: fileOnly("a.md"), modeId: "plan" })
    // 本机的字只是失败那条的一部分：不是同一条。
    const short: PromptDraft = {
      blocks: [{ type: "text", text: "看看" }],
      displayText: "看看",
    }
    expect(plan(shownAs("看看这个文件，再删掉它"), short)).toMatchObject({
      modeId: "default",
    })
    // 字一样、附件不一样：不是同一条。
    const withA: PromptDraft = {
      blocks: [{ type: "text", text: "看看" }, ...fileOnly("a.md").blocks],
      displayText: "看看",
    }
    expect(
      plan(shownAs("看看\n[@b.md](file:///tmp/demo/b.md)"), withA)
    ).toMatchObject({ modeId: "default" })
    // 只带图片：图片不一样就不是同一条。
    const imageOnly: PromptDraft = {
      blocks: [{ type: "image", data: "BBBB", mime_type: "image/png" }],
      displayText: "",
    }
    expect(plan(user("u9", ""), imageOnly)).toMatchObject({
      modeId: "default",
    })
    expect(
      plan(
        {
          id: "u9",
          role: "user",
          blocks: [{ type: "image", data: "BBBB", mime_type: "image/png" }],
          timestamp: TS,
        },
        imageOnly
      )
    ).toEqual({ kind: "enqueue", draft: imageOnly, modeId: "plan" })
  })

  it("记着的是上一轮的消息、不是这次失败的那条时，不用它（第 3 次返工）", () => {
    // 别的设备在同一个会话里发了新消息又失败了，本机存着的还是自己上一轮的。
    const other = [user("u2", "另一台上发的"), lostLine("connection_lost")]
    expect(
      lostTurnRetryPlan({
        turns: other,
        kept: { draft: withFile, modeId: "plan", queueItemId: null },
        queue: [],
        selectedModeId: "default",
      })
    ).toEqual({
      kind: "enqueue",
      draft: { blocks: expect.any(Array), displayText: "另一台上发的" },
      modeId: "default",
    })
    // 智能体的记录里把附件写成了文字跟在后面，也还认得出是同一条。
    const withContext = [
      user("u1", "看看这个文件\n[@notes.md](file:///tmp/demo/notes.md)"),
      lostLine("connection_lost"),
    ]
    expect(
      lostTurnRetryPlan({
        turns: withContext,
        kept: { draft: withFile, modeId: "plan", queueItemId: null },
        queue: [],
        selectedModeId: "default",
      })
    ).toEqual({ kind: "enqueue", draft: withFile, modeId: "plan" })
  })

  it("什么都没记着、对话里也还原不出内容时不给重试", () => {
    const empty: MessageTurn = {
      id: "u1",
      role: "user",
      blocks: [],
      timestamp: TS,
    }
    expect(
      lostTurnRetryPlan({
        turns: [empty, lostLine("connection_lost")],
        kept: null,
        queue: [],
        selectedModeId: null,
      })
    ).toBeNull()
    expect(
      lostTurnRetryPlan({
        turns,
        kept: null,
        queue: [],
        selectedModeId: "default",
      })
    ).toEqual({
      kind: "enqueue",
      draft: { blocks: expect.any(Array), displayText: "看看这个文件" },
      modeId: "default",
    })
  })
})

describe("failed turn send across a reload", () => {
  afterEach(() => localStorage.clear())

  it("存下失败那一轮发出去的原样，刷新后读得回来，清掉后没有", () => {
    const rec = {
      draft: {
        blocks: [
          { type: "text" as const, text: "kill $PPID" },
          {
            type: "resource_link" as const,
            uri: "file:///tmp/demo/a.ts",
            name: "a.ts",
          },
        ],
        displayText: "kill $PPID",
      },
      modeId: null,
      queueItemId: "q1",
    }
    writeFailedTurnSend(7, rec)
    expect(readFailedTurnSend(7)).toEqual(rec)
    expect(readFailedTurnSend(8)).toBeNull()
    writeFailedTurnSend(7, null)
    expect(readFailedTurnSend(7)).toBeNull()
  })

  it("存不下新的一轮时，不留上一轮的旧记录（第 2 次返工）", () => {
    const old = {
      draft: {
        blocks: [{ type: "text" as const, text: "旧的" }],
        displayText: "旧的",
      },
      modeId: null,
      queueItemId: null,
    }
    writeFailedTurnSend(7, old)
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new DOMException("full", "QuotaExceededError")
      })
    try {
      writeFailedTurnSend(7, {
        draft: {
          blocks: [{ type: "text" as const, text: "新的" }],
          displayText: "新的",
        },
        modeId: null,
        queueItemId: null,
      })
    } finally {
      setItem.mockRestore()
    }
    expect(readFailedTurnSend(7)).toBeNull()
  })

  it("读不懂的当没有", () => {
    writeFailedTurnSend(7, {
      draft: { blocks: [], displayText: "" },
      modeId: null,
      queueItemId: null,
    })
    localStorage.setItem(
      Object.keys(localStorage).find((k) => k.endsWith(":7"))!,
      "{bad"
    )
    expect(readFailedTurnSend(7)).toBeNull()
  })
})
