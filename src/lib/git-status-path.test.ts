import { describe, expect, it } from "vitest"

import {
  isRenameStatus,
  rollbackPaths,
  splitGitStatusRename,
} from "./git-status-path"

describe("isRenameStatus", () => {
  it("is true for renames and copies", () => {
    for (const status of ["R", "RM", "RD", "C", "CM"]) {
      expect(isRenameStatus(status)).toBe(true)
    }
  })

  it("is false for other changes", () => {
    for (const status of ["M", "A", "D", "AM", "MM", "??", "UU"]) {
      expect(isRenameStatus(status)).toBe(false)
    }
  })
})

describe("splitGitStatusRename", () => {
  it("leaves a plain path alone", () => {
    expect(splitGitStatusRename("src/a.ts")).toEqual({ file: "src/a.ts" })
  })

  it("splits a rename into the old and the new name", () => {
    expect(splitGitStatusRename("readme.md -> README.md")).toEqual({
      file: "README.md",
      originalFile: "readme.md",
    })
  })

  it("cuts at the last separator, keeping spaces and non-ASCII names", () => {
    expect(splitGitStatusRename("a -> b/旧 名.md -> c/新 名.md")).toEqual({
      file: "c/新 名.md",
      originalFile: "a -> b/旧 名.md",
    })
  })
})

describe("splitGitStatusRename keeps spaces at the ends of names", () => {
  it("does not trim a leading or trailing space off either side", () => {
    expect(splitGitStatusRename("old  ->  new.md")).toEqual({
      file: " new.md",
      originalFile: "old ",
    })
  })
})

describe("rollbackPaths", () => {
  const ENTRIES = [
    { status: "R", file: "b.md", originalFile: "a.md" },
    { status: "R", file: "dst/新 b.md", originalFile: "src/a.md" },
    { status: "R", file: "dst/c.md", originalFile: "dst/old c.md" },
    { status: "C", file: "dst/copy.md", originalFile: "keep.md" },
    { status: "M", file: "dst/plain.md" },
  ]

  it("restores the old name before the new one for a renamed file", () => {
    expect(rollbackPaths("b.md", ENTRIES)).toEqual(["a.md", "b.md"])
  })

  it("adds old names outside a directory, but not ones already inside it", () => {
    expect(rollbackPaths("dst", ENTRIES)).toEqual(["src/a.md", "dst"])
  })

  it("leaves the source of a copy and plain files alone", () => {
    expect(rollbackPaths("dst/copy.md", ENTRIES)).toEqual(["dst/copy.md"])
    expect(rollbackPaths("dst/plain.md", ENTRIES)).toEqual(["dst/plain.md"])
  })

  it("skips an old name that a new untracked file now occupies", () => {
    const entries = [
      { status: "R", file: "b.md", originalFile: "a.md" },
      { status: "R", file: "dst/b.md", originalFile: "src/a.md" },
      { status: "??", file: "a.md" },
      { status: "??", file: "src/a.md" },
    ]
    expect(rollbackPaths("b.md", entries)).toEqual(["b.md"])
    expect(rollbackPaths("dst", entries)).toEqual(["dst"])
  })

  it("needs nothing extra for the whole repository", () => {
    expect(rollbackPaths(".", ENTRIES)).toEqual(["."])
  })
})
