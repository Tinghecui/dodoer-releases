import { describe, expect, it } from "vitest"

import { mergeTail } from "./loop-session-transcript"
import type { MessageTurn } from "@/lib/types"

const turns = (...ids: string[]) =>
  ids.map((id) => ({ id })) as unknown as MessageTurn[]
const ids = (shown: { turns: MessageTurn[] }) => shown.turns.map((t) => t.id)
const view = (firstIndex: number, ...turnIds: string[]) => ({
  firstIndex,
  total: firstIndex + turnIds.length,
  omittedBlocks: 0,
  turns: turns(...turnIds),
})

describe("mergeTail", () => {
  it("keeps the older turns already paged in", () => {
    const merged = mergeTail(view(0, "a", "b", "c"), view(2, "c2", "d"))
    expect(merged.firstIndex).toBe(0)
    expect(merged.total).toBe(4)
    expect(ids(merged)).toEqual(["a", "b", "c2", "d"])
  })
  it("takes the tail whole when nothing older is held", () => {
    expect(ids(mergeTail(null, view(5, "f")))).toEqual(["f"])
    expect(ids(mergeTail(view(5, "f"), view(5, "f2", "g")))).toEqual([
      "f2",
      "g",
    ])
  })
})
