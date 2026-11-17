import { describe, expect, it } from "vitest"

import {
  appendCommitPathsParam,
  parseCommitPathsParam,
} from "./commit-window-paths"

describe("commit window paths param", () => {
  it("round-trips paths through the window address", () => {
    const route = appendCommitPathsParam("/commit?folderId=3", [
      "README.md",
      "docs/a&b, c.md",
    ])
    expect(route.startsWith("/commit?folderId=3&paths=")).toBe(true)
    const params = new URL(route, "http://localhost").searchParams
    expect(params.get("folderId")).toBe("3")
    expect(parseCommitPathsParam(params.get("paths"))).toEqual([
      "README.md",
      "docs/a&b, c.md",
    ])
  })

  it("leaves the address alone without paths", () => {
    expect(appendCommitPathsParam("/commit?folderId=3", undefined)).toBe(
      "/commit?folderId=3"
    )
    expect(appendCommitPathsParam("/commit?folderId=3", [])).toBe(
      "/commit?folderId=3"
    )
  })

  it("tells a missing param from one that was given", () => {
    expect(parseCommitPathsParam(null)).toBeNull()
  })

  // #442: a param that is there but unreadable must not read as "no param"
  // (which ticks every tracked change).
  it("reads values that are not a list of paths as given but empty", () => {
    expect(parseCommitPathsParam("")).toEqual([])
    expect(parseCommitPathsParam("README.md")).toEqual([])
    expect(parseCommitPathsParam("[not json")).toEqual([])
    expect(parseCommitPathsParam('{"a":1}')).toEqual([])
    expect(parseCommitPathsParam("[]")).toEqual([])
    expect(parseCommitPathsParam('[1, "a.md"]')).toEqual(["a.md"])
  })
})
