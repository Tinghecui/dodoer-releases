/**
 * #792 返工：连接停在旧目标时，满 15 秒要把队首标失败；等待期间又排了消息、
 * 回调换了引用，都不能把计时清零重来。
 */

import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { STALE_TARGET_FAIL_MS } from "@/lib/queue-flush"
import { useStaleTargetFail } from "./use-stale-target-fail"

type Props = {
  stale: boolean
  queued: number
  headFailed: boolean
  ready: boolean
  onTimeout: () => void
}

function setup(initial: Props) {
  return renderHook(
    (p: Props) =>
      useStaleTargetFail({
        stale: p.stale,
        queueLength: p.queued,
        headFailed: p.headFailed,
        isReady: () => p.ready,
        onTimeout: p.onTimeout,
      }),
    { initialProps: initial }
  )
}

describe("useStaleTargetFail", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("fires once the stale target has held for the full timeout", () => {
    const onTimeout = vi.fn()
    setup({
      stale: true,
      queued: 1,
      headFailed: false,
      ready: false,
      onTimeout,
    })
    vi.advanceTimersByTime(STALE_TARGET_FAIL_MS - 1)
    expect(onTimeout).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it("does not restart the wait when more messages are queued", () => {
    const onTimeout = vi.fn()
    const props: Props = {
      stale: true,
      queued: 1,
      headFailed: false,
      ready: false,
      onTimeout,
    }
    const { rerender } = setup(props)
    vi.advanceTimersByTime(10_000)
    rerender({ ...props, queued: 2 })
    vi.advanceTimersByTime(3_000)
    rerender({ ...props, queued: 3 })
    vi.advanceTimersByTime(2_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
  })

  it("does not restart the wait when the callback identity changes", () => {
    const first = vi.fn()
    const second = vi.fn()
    const props: Props = {
      stale: true,
      queued: 1,
      headFailed: false,
      ready: false,
      onTimeout: first,
    }
    const { rerender } = setup(props)
    vi.advanceTimersByTime(10_000)
    rerender({ ...props, onTimeout: second })
    vi.advanceTimersByTime(5_000)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })

  it("cancels when the connection leaves the stale state", () => {
    const onTimeout = vi.fn()
    const props: Props = {
      stale: true,
      queued: 1,
      headFailed: false,
      ready: false,
      onTimeout,
    }
    const { rerender } = setup(props)
    vi.advanceTimersByTime(10_000)
    rerender({ ...props, stale: false })
    vi.advanceTimersByTime(STALE_TARGET_FAIL_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("stays idle with an empty queue or a failed head", () => {
    const onTimeout = vi.fn()
    const props: Props = {
      stale: true,
      queued: 0,
      headFailed: false,
      ready: false,
      onTimeout,
    }
    const { rerender } = setup(props)
    vi.advanceTimersByTime(STALE_TARGET_FAIL_MS)
    rerender({ ...props, queued: 1, headFailed: true })
    vi.advanceTimersByTime(STALE_TARGET_FAIL_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })

  it("does nothing if the connection became ready by the deadline", () => {
    const onTimeout = vi.fn()
    const props: Props = {
      stale: true,
      queued: 1,
      headFailed: false,
      ready: false,
      onTimeout,
    }
    const { rerender } = setup(props)
    rerender({ ...props, ready: true })
    vi.advanceTimersByTime(STALE_TARGET_FAIL_MS)
    expect(onTimeout).not.toHaveBeenCalled()
  })
})
