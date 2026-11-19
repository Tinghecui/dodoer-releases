import { describe, expect, it } from "vitest"

import { defaultConversationBranch } from "@/lib/worktree-slug"

import {
  branchNameProblem,
  commandErrorReason,
  isBranchNameTooLongError,
  isValidBranchName,
  MAX_BRANCH_NAME_BYTES,
} from "./worktree-start"

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

describe("branchNameProblem", () => {
  const local = ["main", "feature/x"]

  it("refuses a name that is already a local branch", () => {
    expect(branchNameProblem("main", local)).toBe("exists")
    expect(branchNameProblem("feature/x", local)).toBe("exists")
  })

  it("refuses a name git would refuse, before looking at the list", () => {
    expect(branchNameProblem("bad name..~", local)).toBe("invalid")
  })

  it("takes a new valid name, and an empty one (named from the first message)", () => {
    expect(branchNameProblem("cv/tidy-fox", local)).toBeNull()
    expect(branchNameProblem("Main", local)).toBeNull()
    expect(branchNameProblem("", local)).toBeNull()
  })
})

// #833：名字太长时 git 要到 `worktree add` 写 refs/heads/<名字>.lock 才失败，
// 弹框里就要拦下。
describe("branchNameProblem: length", () => {
  it("refuses a name past the byte limit as too long", () => {
    expect(branchNameProblem(`qa/${"a".repeat(260)}`, [])).toBe("too_long")
    expect(branchNameProblem("a".repeat(MAX_BRANCH_NAME_BYTES + 1), [])).toBe(
      "too_long"
    )
  })

  it("takes a name right at the limit", () => {
    expect(branchNameProblem("a".repeat(MAX_BRANCH_NAME_BYTES), [])).toBeNull()
  })

  it("counts UTF-8 bytes, not characters", () => {
    // 「分」是 3 个字节
    const chars = Math.floor(MAX_BRANCH_NAME_BYTES / 3) + 1
    expect(branchNameProblem("分".repeat(chars), [])).toBe("too_long")
    expect(branchNameProblem("分".repeat(chars - 1), [])).toBeNull()
  })
})

describe("isBranchNameTooLongError", () => {
  it("knows the backend's too-long refusal and nothing else", () => {
    expect(
      isBranchNameTooLongError({
        code: "invalid_input",
        message: "Branch name too long",
        detail: "qa/aaa",
      })
    ).toBe(true)
    expect(
      isBranchNameTooLongError({
        code: "invalid_input",
        message: "Invalid branch name",
      })
    ).toBe(false)
    expect(isBranchNameTooLongError(new Error("boom"))).toBe(false)
  })
})
