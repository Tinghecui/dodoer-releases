/**
 * #1006：排队的消息等连接起来等满 15 秒，要报出已等的秒数（换提示、给重连），
 * 连上了就清掉；它只是计时，不负责把队首标失败。
 */

import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import { STALE_TARGET_FAIL_MS } from "@/lib/queue-flush"
import { useSlowConnectWait } from "./use-slow-connect-wait"

describe("useSlowConnectWait", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("stays null until the wait has lasted the full timeout", () => {
    const { result } = renderHook(() => useSlowConnectWait(true))
    act(() => {
      vi.advanceTimersByTime(STALE_TARGET_FAIL_MS - 1000)
    })
    expect(result.current).toBeNull()
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBe(15)
  })

  it("keeps counting the seconds while the agent is still starting", () => {
    const { result } = renderHook(() => useSlowConnectWait(true))
    act(() => {
      vi.advanceTimersByTime(20_000)
    })
    expect(result.current).toBe(20)
  })

  it("clears once the connection is ready and restarts the next wait", () => {
    const { result, rerender } = renderHook(
      ({ waiting }: { waiting: boolean }) => useSlowConnectWait(waiting),
      { initialProps: { waiting: true } }
    )
    act(() => {
      vi.advanceTimersByTime(STALE_TARGET_FAIL_MS)
    })
    expect(result.current).toBe(15)
    rerender({ waiting: false })
    expect(result.current).toBeNull()
    rerender({ waiting: true })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    expect(result.current).toBeNull()
  })

  it("never reports while nothing is waiting", () => {
    const { result } = renderHook(() => useSlowConnectWait(false))
    act(() => {
      vi.advanceTimersByTime(60_000)
    })
    expect(result.current).toBeNull()
  })
})
