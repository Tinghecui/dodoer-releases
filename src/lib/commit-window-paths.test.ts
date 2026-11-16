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

  it("ignores values that are not a list of paths", () => {
    expect(parseCommitPathsParam(null)).toBeNull()
    expect(parseCommitPathsParam("README.md")).toBeNull()
    expect(parseCommitPathsParam('{"a":1}')).toBeNull()
    expect(parseCommitPathsParam("[]")).toBeNull()
    expect(parseCommitPathsParam('[1, "a.md"]')).toEqual(["a.md"])
  })
})
