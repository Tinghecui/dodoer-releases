import { describe, expect, it } from "vitest"

import {
  isRenameStatus,
  rollbackPaths,
  rollbackPathsForStatus,
  scopeGitStatusEntriesForDirectory,
  splitGitStatusEntry,
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

describe("splitGitStatusEntry", () => {
  it("splits only rename and copy lines", () => {
    expect(splitGitStatusEntry({ status: "R", file: "a.md -> b.md" })).toEqual({
      status: "R",
      file: "b.md",
      originalFile: "a.md",
    })
    expect(
      splitGitStatusEntry({ status: "??", file: "note -> todo.md" })
    ).toEqual({ status: "??", file: "note -> todo.md" })
  })

  it("keeps spaces at the ends of a plain name", () => {
    expect(splitGitStatusEntry({ status: "M", file: " a.md " })).toEqual({
      status: "M",
      file: " a.md ",
    })
  })
})

describe("rollbackPathsForStatus", () => {
  const RAW = [
    { status: "R", file: "a.md -> dst/b.md" },
    { status: "R", file: "src/c.md -> dst/d.md" },
    { status: "M", file: "dst/plain.md" },
    { status: "??", file: "x -> y.md" },
  ]

  it("restores the old name of a renamed file picked in the panels", () => {
    expect(rollbackPathsForStatus(["dst/b.md"], RAW)).toEqual([
      "a.md",
      "dst/b.md",
    ])
  })

  it("covers several targets without repeating a path", () => {
    expect(
      rollbackPathsForStatus(["dst/b.md", "dst/d.md", "dst/plain.md"], RAW)
    ).toEqual(["a.md", "dst/b.md", "src/c.md", "dst/d.md", "dst/plain.md"])
    expect(rollbackPathsForStatus(["dst", "dst/b.md"], RAW)).toEqual([
      "a.md",
      "src/c.md",
      "dst",
      "dst/b.md",
    ])
  })

  it("leaves a plain file whose name contains the arrow alone", () => {
    expect(rollbackPathsForStatus(["x -> y.md"], RAW)).toEqual(["x -> y.md"])
  })
})

describe("scopeGitStatusEntriesForDirectory", () => {
  it("lists renamed files under their new name", () => {
    expect(
      scopeGitStatusEntriesForDirectory(
        [
          { status: "R", file: "old/a.md -> docs/a.md" },
          { status: "M", file: "docs/b.md" },
          { status: "M", file: "other/c.md" },
        ],
        "docs"
      )
    ).toEqual([
      { path: "docs/a.md", status: "R" },
      { path: "docs/b.md", status: "M" },
    ])
  })

  it("does not cut a plain name that contains the arrow", () => {
    expect(
      scopeGitStatusEntriesForDirectory(
        [{ status: "??", file: "docs/x -> y.md" }],
        "docs"
      )
    ).toEqual([{ path: "docs/x -> y.md", status: "??" }])
  })

  it("keeps spaces at the ends of a name", () => {
    expect(
      scopeGitStatusEntriesForDirectory(
        [
          { status: "M", file: " a.md" },
          { status: "R", file: "b.md -> c.md " },
        ],
        ""
      )
    ).toEqual([
      { path: " a.md", status: "M" },
      { path: "c.md ", status: "R" },
    ])
  })

  it("finds the files of a new directory only when git expands it", () => {
    // #795: -unormal 只给 `?? newdir/`，筛完是空的；-uall 逐个列出文件。
    expect(
      scopeGitStatusEntriesForDirectory(
        [{ status: "??", file: "newdir/" }],
        "newdir"
      )
    ).toEqual([])
    expect(
      scopeGitStatusEntriesForDirectory(
        [
          { status: "??", file: "newdir/a.md" },
          { status: "??", file: "newdir/x -> y.md" },
        ],
        "newdir"
      )
    ).toEqual([
      { path: "newdir/a.md", status: "??" },
      { path: "newdir/x -> y.md", status: "??" },
    ])
  })

  it("drops the trailing slash of an untracked directory", () => {
    expect(
      scopeGitStatusEntriesForDirectory([{ status: "??", file: "new/" }], "")
    ).toEqual([{ path: "new", status: "??" }])
  })
})
