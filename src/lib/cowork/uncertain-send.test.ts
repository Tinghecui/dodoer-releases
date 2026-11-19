import { describe, expect, it } from "vitest"

import {
  createUncertainSendWatch,
  isUncertainSendError,
} from "@/lib/cowork/uncertain-send"

describe("isUncertainSendError (#984)", () => {
  it("counts a remote request that got no answer", () => {
    expect(
      isUncertainSendError({
        code: "network_error",
        message: "Remote HTTP request failed",
        detail: "operation timed out",
      })
    ).toBe(true)
    expect(
      isUncertainSendError({
        code: "network_error",
        message: "Failed to parse remote response",
      })
    ).toBe(true)
  })

  it("counts a web timeout and a fetch that never reached the server", () => {
    expect(isUncertainSendError(new Error("Request timed out"))).toBe(true)
    expect(isUncertainSendError(new TypeError("Failed to fetch"))).toBe(true)
  })

  it("does not count a server that answered with a refusal", () => {
    expect(
      isUncertainSendError({
        code: "network_error",
        message: "Remote returned HTTP 413 Payload Too Large",
      })
    ).toBe(false)
    expect(
      isUncertainSendError({ code: "http_error", message: "HTTP 413" })
    ).toBe(false)
    expect(
      isUncertainSendError({
        code: "task_execution_failed",
        message: "image attachment unavailable",
      })
    ).toBe(false)
    expect(isUncertainSendError(new Error("boom"))).toBe(false)
  })
})

describe("createUncertainSendWatch (#984)", () => {
  it("knows a message the server echoed before the request failed", () => {
    const watch = createUncertainSendWatch()
    expect(watch.echoed("optimistic-1")).toBe(false)
    watch.noteEcho("optimistic-1")
    expect(watch.echoed("optimistic-1")).toBe(true)
    expect(watch.echoed("optimistic-2")).toBe(false)
  })

  it("hands back the queued copy once the server echoes it later", () => {
    const watch = createUncertainSendWatch<{ queueItemId: string }>()
    const copy = { queueItemId: "queue-a" }
    watch.noteUncertain("optimistic-1", copy)
    expect(watch.noteEcho("optimistic-2")).toBeNull()
    // 交回记下的那份原样（调用方拿它认出用户改没改过副本）。
    expect(watch.noteEcho("optimistic-1")).toBe(copy)
    // 只交回一次。
    expect(watch.noteEcho("optimistic-1")).toBeNull()
  })

  it("keeps only the latest echoes", () => {
    const watch = createUncertainSendWatch()
    for (let i = 0; i < 60; i += 1) watch.noteEcho(`m-${i}`)
    expect(watch.echoed("m-0")).toBe(false)
    expect(watch.echoed("m-59")).toBe(true)
  })
})
