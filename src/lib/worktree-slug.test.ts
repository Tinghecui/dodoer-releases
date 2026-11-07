import { describe, expect, it } from "vitest"
import {
  CONVERSATION_BRANCH_PREFIX,
  defaultConversationBranch,
  randomWorktreeSlug,
} from "./worktree-slug"

describe("randomWorktreeSlug", () => {
  it("is a single lowercase adjective-animal path component", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomWorktreeSlug()).toMatch(/^[a-z]+-[a-z]+$/)
    }
  })
})

describe("defaultConversationBranch", () => {
  it("prefixes the slug so conversation branches group together", () => {
    const name = defaultConversationBranch()
    expect(name.startsWith(CONVERSATION_BRANCH_PREFIX)).toBe(true)
    expect(name.slice(CONVERSATION_BRANCH_PREFIX.length)).toMatch(
      /^[a-z]+-[a-z]+$/
    )
  })
})
