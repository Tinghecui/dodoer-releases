import { describe, expect, it } from "vitest"
import { TabRecency, pickTabsToEvict } from "./tab-limit"

const keepNone = () => false

describe("pickTabsToEvict", () => {
  it("picks nothing while the strip is within the cap", () => {
    const recency = new TabRecency()
    recency.sync(["a", "b", "c"], "a")
    expect(pickTabsToEvict(["a", "b", "c"], 3, recency, keepNone)).toEqual([])
  })

  it("closes tabs in the order they were opened when none was revisited", () => {
    const recency = new TabRecency()
    const ids = ["a", "b", "c", "d", "e"]
    recency.sync(ids, null)
    expect(pickTabsToEvict(ids, 3, recency, keepNone)).toEqual(["a", "b"])
  })

  it("keeps a tab the user went back to", () => {
    const recency = new TabRecency()
    recency.sync(["a", "b", "c"], null)
    recency.sync(["a", "b", "c"], "a")
    recency.sync(["a", "b", "c", "d"], "d")
    expect(pickTabsToEvict(["a", "b", "c", "d"], 3, recency, keepNone)).toEqual(
      ["b"]
    )
  })

  it("treats a tab added but not yet active as just used", () => {
    const recency = new TabRecency()
    recency.sync(["a", "b", "c"], "c")
    recency.sync(["a", "b", "c", "new"], "c")
    expect(
      pickTabsToEvict(["a", "b", "c", "new"], 3, recency, keepNone)
    ).toEqual(["a"])
  })

  it("never picks a kept tab, even if that leaves the strip over the cap", () => {
    const recency = new TabRecency()
    const ids = ["a", "b", "c", "d"]
    recency.sync(ids, "d")
    const keep = (id: string) => id === "a" || id === "b" || id === "c"
    expect(pickTabsToEvict(ids, 2, recency, keep)).toEqual([])
    expect(pickTabsToEvict(ids, 3, recency, (id) => id === "a")).toEqual(["b"])
  })

  it("forgets closed tabs, so a reopened tab counts as new", () => {
    const recency = new TabRecency()
    recency.sync(["a", "b", "c"], "c")
    recency.sync(["b", "c"], "c")
    recency.sync(["b", "c", "a"], "c")
    expect(pickTabsToEvict(["b", "c", "a"], 2, recency, keepNone)).toEqual([
      "b",
    ])
  })

  it("never picks the tab opened most recently, even in the background", () => {
    const recency = new TabRecency()
    recency.sync(["a", "b", "c"], "b")
    recency.sync(["a", "b", "c", "x"], "b")
    // b is active, a and c must be kept (say, unsaved edits): nothing closes,
    // rather than the tab the user just opened.
    const keep = (id: string) => id !== "x"
    expect(pickTabsToEvict(["a", "b", "c", "x"], 3, recency, keep)).toEqual([])
  })
})
