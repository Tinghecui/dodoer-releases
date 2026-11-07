import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDebouncedValue } from "./use-debounced-value"

describe("useDebouncedValue", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("returns the first value at once and settles later changes", () => {
    const { result, rerender } = renderHook(
      ({ v }) => useDebouncedValue(v, 300),
      { initialProps: { v: "grok" } }
    )
    expect(result.current).toBe("grok")
    rerender({ v: "codex" })
    rerender({ v: "claude_code" })
    act(() => vi.advanceTimersByTime(299))
    expect(result.current).toBe("grok")
    act(() => vi.advanceTimersByTime(1))
    expect(result.current).toBe("claude_code")
  })
})
