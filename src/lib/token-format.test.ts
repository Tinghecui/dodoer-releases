import { describe, expect, it } from "vitest"
import { formatTokensCompact } from "./token-format"

describe("formatTokensCompact", () => {
  it("switches to a two-decimal B step from one billion", () => {
    expect(formatTokensCompact(4_769_000_000)).toBe("4.77B")
    expect(formatTokensCompact(3_200_400_000)).toBe("3.20B")
    expect(formatTokensCompact(1_000_000_000)).toBe("1.00B")
  })

  it("moves up a step instead of printing 1000M or 1000K", () => {
    expect(formatTokensCompact(999_960_000)).toBe("1.00B")
    expect(formatTokensCompact(999_960)).toBe("1M")
  })

  it("keeps one trimmed decimal for K and M", () => {
    expect(formatTokensCompact(999_000_000)).toBe("999M")
    expect(formatTokensCompact(1_284_000)).toBe("1.3M")
    expect(formatTokensCompact(45_600)).toBe("45.6K")
    expect(formatTokensCompact(2_000)).toBe("2K")
  })

  it("prints small counts in full and never a negative", () => {
    expect(formatTokensCompact(842)).toBe("842")
    expect(formatTokensCompact(0)).toBe("0")
    expect(formatTokensCompact(-5)).toBe("0")
    expect(formatTokensCompact(Number.NaN)).toBe("0")
  })
})
