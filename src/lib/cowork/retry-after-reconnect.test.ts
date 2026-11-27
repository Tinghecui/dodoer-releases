import { describe, expect, it } from "vitest"
import { createRetryAfterReconnect } from "./retry-after-reconnect"

// #1323：连接失败过、服务又好了，排队区点一次「重试」就要连上并发出去。
describe("createRetryAfterReconnect", () => {
  it("retries the noted message once the connect error clears", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    // 点下去的那一刻还是「连接失败」，不算这次重连失败。
    expect(r.observe({ unavailable: "connect_failed" })).toBe(null)
    expect(r.observe({ unavailable: null })).toBe("q1")
    // 只重试一次。
    expect(r.observe({ unavailable: null })).toBe(null)
  })

  // #1640：重连途中连接错误先清掉、连接还没就绪，接着又冒出别的中间状态，
  // 这次重试不能丢；清掉失败标记以后由自动发送去等连接。
  it("retries as soon as the error clears, before the connection is ready", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    expect(r.observe({ unavailable: "connect_failed" })).toBe(null)
    expect(r.observe({ unavailable: null })).toBe("q1")
  })

  it("keeps waiting while the connect error is still there", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    expect(r.observe({ unavailable: "connect_failed" })).toBe(null)
    expect(r.observe({ unavailable: "connect_failed" })).toBe(null)
    expect(r.observe({ unavailable: null })).toBe("q1")
  })

  it("drops the pending retry when the agent turns out not installed", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    expect(r.observe({ unavailable: "not_installed" })).toBe(null)
    expect(r.observe({ unavailable: null })).toBe(null)
  })

  it("lets Retry all win over a single retry", () => {
    const r = createRetryAfterReconnect()
    r.note("all")
    r.note("q2")
    expect(r.observe({ unavailable: null })).toBe("all")
  })

  it("does nothing with nothing noted", () => {
    const r = createRetryAfterReconnect()
    expect(r.observe({ unavailable: null })).toBe(null)
  })
})
