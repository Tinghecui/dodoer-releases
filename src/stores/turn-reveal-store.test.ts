import { beforeEach, describe, expect, it } from "vitest"

import {
  requestTurnReveal,
  takeTurnReveal,
  useTurnRevealStore,
} from "./turn-reveal-store"

describe("turn-reveal-store", () => {
  beforeEach(() => {
    useTurnRevealStore.setState({ pending: null })
  })

  it("hands the request to its own conversation once", () => {
    requestTurnReveal({ conversationId: 7, turnId: "turn-4", turnIndex: 4 })
    expect(takeTurnReveal(8)).toBeNull()
    expect(takeTurnReveal(7)).toEqual({
      conversationId: 7,
      turnId: "turn-4",
      turnIndex: 4,
    })
    expect(takeTurnReveal(7)).toBeNull()
  })

  it("keeps only the newest request", () => {
    requestTurnReveal({ conversationId: 7, turnId: "turn-4", turnIndex: 4 })
    requestTurnReveal({ conversationId: 9, turnId: "turn-0", turnIndex: 0 })
    expect(takeTurnReveal(7)).toBeNull()
    expect(takeTurnReveal(9)?.turnId).toBe("turn-0")
  })
})
