import { describe, expect, it } from "vitest"

import { defaultConversationBranch } from "@/lib/worktree-slug"

import { commandErrorReason, isValidBranchName } from "./worktree-start"

// Each verdict below was checked against `git check-ref-format --branch`
// (git 2.43), except `@` and `@{…}`: git expands those to another branch's
// name, and a name typed into the dialog never means that.
describe("isValidBranchName", () => {
  it.each([
    "main",
    "feature/x",
    "cv/tidy-fox",
    "a.b",
    "a@b",
    "@a",
    "a@",
    "head",
    "refs/heads/x",
    "中文分支",
    "a]b",
    "a{b",
    "a.lockb",
    "x.LOCK",
    "fix-#97_retry+1",
  ])("accepts %j", (name) => {
    expect(isValidBranchName(name)).toBe(true)
  })

  it.each([
    ["empty", ""],
    ["the name from the report", "bad name..~^:"],
    ["a space", "a b"],
    ["two dots", "a..b"],
    ["a tilde", "a~b"],
    ["a caret", "a^b"],
    ["a colon", "a:b"],
    ["a question mark", "a?b"],
    ["an asterisk", "a*b"],
    ["an opening bracket", "a[b"],
    ["a backslash", "a\\b"],
    ["a tab", "a\tb"],
    ["a newline", "a\nb"],
    ["DEL", "a\u007fb"],
    ["a leading dash", "-x"],
    ["a leading slash", "/x"],
    ["a trailing slash", "x/"],
    ["a trailing dot", "x."],
    ["a trailing .lock", "x.lock"],
    ["a .lock component", "a.lock/b"],
    ["a trailing .lock component", "a/b.lock"],
    ["a double slash", "a//b"],
    ["@{", "a@{b"],
    ["@{-1}", "@{-1}"],
    ["@ alone", "@"],
    ["HEAD", "HEAD"],
    ["a leading dot", ".x"],
    ["a component with a leading dot", "a/.b"],
  ])("refuses %s", (_what, name) => {
    expect(isValidBranchName(name)).toBe(false)
  })

  it("accepts the names we generate ourselves", () => {
    for (let i = 0; i < 20; i++) {
      expect(isValidBranchName(defaultConversationBranch())).toBe(true)
    }
  })
})

describe("commandErrorReason", () => {
  it("puts the message before a detail that is only the name", () => {
    // What `plan_conversation_worktree` returns; `toErrorMessage` would show
    // "bad name..~^:" alone.
    expect(
      commandErrorReason({
        code: "invalid_input",
        message: "Invalid branch name",
        detail: "bad name..~^:",
      })
    ).toBe("Invalid branch name: bad name..~^:")
  })

  it("reads an error that arrives as JSON in an Error's message", () => {
    expect(
      commandErrorReason(
        new Error(
          JSON.stringify({
            code: "already_exists",
            message: "Branch already exists",
            detail: "cv/tidy-fox",
          })
        )
      )
    ).toBe("Branch already exists: cv/tidy-fox")
  })

  it("shows the message alone when there is no detail, or it says the same", () => {
    expect(
      commandErrorReason({ code: "io", message: "disk full", detail: null })
    ).toBe("disk full")
    expect(
      commandErrorReason({
        code: "io",
        message: "disk full",
        detail: "disk full",
      })
    ).toBe("disk full")
  })

  it("falls back to the plain text of anything else", () => {
    expect(commandErrorReason(new Error("network down"))).toBe("network down")
    expect(commandErrorReason("boom")).toBe("boom")
  })
})
