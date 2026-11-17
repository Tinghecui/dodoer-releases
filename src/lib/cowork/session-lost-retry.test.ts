import { describe, expect, it } from "vitest"

import {
  createSessionLostRetry,
  sessionLostRetryRoute,
} from "./session-lost-retry"

// #423：智能体不认这个会话时，这条消息自动重发一次；同一条再失败就留给用户点重试。
describe("createSessionLostRetry", () => {
  const draft = { displayText: "只回复 ok3" }

  it("retries a lost-session message once, after the old connection is gone", () => {
    const retry = createSessionLostRetry()
    expect(retry.noteFailed(draft)).toBe(true)
    const head = { draft, failed: true }
    // 连接还在出错、还在跑：先不动。
    expect(retry.takeReady(head, "error")).toBe(false)
    expect(retry.takeReady(head, "prompting")).toBe(false)
    expect(retry.takeReady(head, "disconnected")).toBe(true)
    // 只重试一次。
    expect(retry.takeReady(head, "disconnected")).toBe(false)
  })

  it("does not retry the same message a second time", () => {
    const retry = createSessionLostRetry()
    retry.noteFailed(draft)
    retry.takeReady({ draft, failed: true }, "disconnected")
    expect(retry.noteFailed(draft)).toBe(false)
    expect(retry.takeReady({ draft, failed: true }, "disconnected")).toBe(false)
  })

  it("leaves other heads alone", () => {
    const retry = createSessionLostRetry()
    retry.noteFailed(draft)
    expect(retry.takeReady(undefined, "disconnected")).toBe(false)
    expect(
      retry.takeReady({ draft: { displayText: "x" }, failed: true }, null)
    ).toBe(false)
    expect(retry.takeReady({ draft, failed: false }, "disconnected")).toBe(
      false
    )
  })
})

// 审查打回（#499）：发出去以后切到别的会话，原来那个标签不再是当前标签，
// 「重试」里的重连只管当前标签，消息会一直停在排队区。后台标签要自己连。
describe("sessionLostRetryRoute", () => {
  it("uses the queue's retry on the active tab", () => {
    expect(sessionLostRetryRoute({ isActive: true, canConnect: true })).toBe(
      "retry"
    )
    expect(sessionLostRetryRoute({ isActive: true, canConnect: false })).toBe(
      "retry"
    )
  })

  it("reconnects in the background on a tab the user switched away from", () => {
    expect(sessionLostRetryRoute({ isActive: false, canConnect: true })).toBe(
      "background"
    )
  })

  it("waits for the user to come back when the tab cannot connect by itself", () => {
    expect(sessionLostRetryRoute({ isActive: false, canConnect: false })).toBe(
      "wait"
    )
  })
})
