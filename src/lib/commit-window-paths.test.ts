import { describe, expect, it } from "vitest"

import {
  COMMIT_PATHS_MAX_ENCODED_LENGTH,
  appendCommitPathsParam,
  commitPathsTooLong,
  parseCommitPathsParam,
  parseCommitScopeParam,
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

  // #528: the untracked group's root carries one scope flag, not every file.
  it("carries a scope flag instead of listing files", () => {
    const route = appendCommitPathsParam(
      "/commit?folderId=3",
      null,
      "untracked"
    )
    expect(route).toBe("/commit?folderId=3&scope=untracked")
    const params = new URL(route, "http://localhost").searchParams
    expect(params.get("paths")).toBeNull()
    expect(parseCommitScopeParam(params.get("scope"))).toBe("untracked")
  })

  it("carries a directory together with its group's scope", () => {
    const route = appendCommitPathsParam(
      "/commit?folderId=3",
      ["docs"],
      "tracked"
    )
    const params = new URL(route, "http://localhost").searchParams
    expect(parseCommitPathsParam(params.get("paths"))).toEqual(["docs"])
    expect(parseCommitScopeParam(params.get("scope"))).toBe("tracked")
  })

  it("reads only the known scopes", () => {
    expect(parseCommitScopeParam(null)).toBeNull()
    expect(parseCommitScopeParam("untracked")).toBe("untracked")
    expect(parseCommitScopeParam("tracked")).toBe("tracked")
    expect(parseCommitScopeParam("all")).toBeNull()
    expect(parseCommitScopeParam("")).toBeNull()
  })

  // #528: past ~8KB the portal's proxy answers 414, so long lists stay out.
  it("tells when the encoded paths would make the address too long", () => {
    expect(COMMIT_PATHS_MAX_ENCODED_LENGTH).toBe(6000)
    expect(commitPathsTooLong(["docs"])).toBe(false)
    expect(commitPathsTooLong(null)).toBe(false)
    const many = Array.from(
      { length: 200 },
      (_, i) => `src/generated/fixtures/sample-${i}.json`
    )
    expect(commitPathsTooLong(many)).toBe(true)
    // Right at the edge: the encoded JSON of one path is exactly the limit.
    // `["` and `"]` each encode to 6 characters (`%5B%22`, `%22%5D`).
    const edge = "a".repeat(COMMIT_PATHS_MAX_ENCODED_LENGTH - 12)
    expect(encodeURIComponent(JSON.stringify([edge])).length).toBe(
      COMMIT_PATHS_MAX_ENCODED_LENGTH
    )
    expect(commitPathsTooLong([edge])).toBe(false)
    expect(commitPathsTooLong([`${edge}a`])).toBe(true)
  })
})
