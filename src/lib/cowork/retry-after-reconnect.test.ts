import { describe, expect, it } from "vitest"
import { createRetryAfterReconnect } from "./retry-after-reconnect"

// #1323：连接失败过、服务又好了，排队区点一次「重试」就要连上并发出去。
describe("createRetryAfterReconnect", () => {
  it("retries the noted message once the reconnect is ready", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    // 点下去的那一刻还是「连接失败」，不算这次重连失败。
    expect(r.observe({ ready: false, unavailable: "connect_failed" })).toBe(
      null
    )
    expect(r.observe({ ready: false, unavailable: null })).toBe(null)
    expect(r.observe({ ready: true, unavailable: null })).toBe("q1")
    // 只重试一次。
    expect(r.observe({ ready: true, unavailable: null })).toBe(null)
  })

  it("drops the pending retry when the new connect fails too", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    expect(r.observe({ ready: false, unavailable: null })).toBe(null)
    expect(r.observe({ ready: false, unavailable: "connect_failed" })).toBe(
      null
    )
    // 以后别的时候连上了，不替用户重发。
    expect(r.observe({ ready: true, unavailable: null })).toBe(null)
  })

  it("drops the pending retry when the agent turns out not installed", () => {
    const r = createRetryAfterReconnect()
    r.note("q1")
    expect(r.observe({ ready: false, unavailable: "not_installed" })).toBe(null)
    expect(r.observe({ ready: true, unavailable: null })).toBe(null)
  })

  it("lets Retry all win over a single retry", () => {
    const r = createRetryAfterReconnect()
    r.note("all")
    r.note("q2")
    expect(r.observe({ ready: true, unavailable: null })).toBe("all")
  })

  it("does nothing with nothing noted", () => {
    const r = createRetryAfterReconnect()
    expect(r.observe({ ready: true, unavailable: null })).toBe(null)
  })
})
