/**
 * #1066：智能体不认这个会话了（`session_lost`），这一轮没开始，消息放回排队区、
 * 自动重发一次。失败的那一轮不能再升格进对话区，不然重发出去以后同一条用户
 * 消息出现两次，第一条下面还挂着「本轮失败」；刷新后服务器那边只有一条。
 * 第二次还失败、不再自动重发的，照旧留着失败行（消息不能悄悄消失）。
 */

import { afterEach, describe, expect, it } from "vitest"

import type { LiveMessage } from "@/contexts/acp-connections-context"
import type { MessageTurn } from "@/lib/types"
import { settleEndedTurn } from "@/lib/cowork/session-lost-retry"
import {
  getRuntimeSession,
  getTimelineTurns,
  resetConversationRuntimeStore,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"

const CID = 1066
const TS = "2026-11-20T00:00:00.000Z"
const TEXT = "不用再做清理了。只回复：ok"

function userTurn(id: string): MessageTurn {
  return {
    id,
    role: "user",
    blocks: [{ type: "text", text: TEXT }],
    timestamp: TS,
  }
}

function failedLive(id: string): LiveMessage {
  return {
    id,
    role: "assistant",
    content: [
      { type: "turn_error", message: "会话已经结束", fromAgent: false },
    ],
    startedAt: Date.parse(TS),
  }
}

function replyLive(id: string): LiveMessage {
  return {
    id,
    role: "assistant",
    content: [{ type: "text", text: "ok" }],
    startedAt: Date.parse(TS),
  }
}

const store = () => useConversationRuntimeStore.getState().actions

/** 发一条：乐观用户消息进去，这一轮的 liveMessage 跟上。 */
function send(turnId: string, live: LiveMessage) {
  store().appendOptimisticTurn(CID, userTurn(turnId), turnId)
  store().setLiveMessage(CID, live, true)
}

function timeline() {
  return getTimelineTurns(CID).map((t) => t.turn)
}

const userCount = () => timeline().filter((t) => t.role === "user").length
const hasTurnError = () =>
  timeline().some((t) => t.blocks.some((b) => b.type === "turn_error"))

afterEach(() => resetConversationRuntimeStore())

describe("a lost-session turn that is resent automatically", () => {
  it("shows the message once after the resend, with no failure line", () => {
    send("u1", failedLive("m1"))
    settleEndedTurn(store(), CID, { optimisticTurnId: "u1", autoResend: true })

    // 自动重发：排队区那条再发出去，这次正常回复。
    send("u2", replyLive("m2"))
    settleEndedTurn(store(), CID, {
      optimisticTurnId: "u2",
      autoResend: false,
    })

    expect(userCount()).toBe(1)
    expect(hasTurnError()).toBe(false)
    expect(getRuntimeSession(CID)?.optimisticTurns).toEqual([])
    expect(getRuntimeSession(CID)?.syncState).toBe("idle")
  })

  it("keeps the failure line when the message will not be resent again", () => {
    send("u1", failedLive("m1"))
    settleEndedTurn(store(), CID, {
      optimisticTurnId: "u1",
      autoResend: false,
    })

    expect(userCount()).toBe(1)
    expect(hasTurnError()).toBe(true)
  })
})
