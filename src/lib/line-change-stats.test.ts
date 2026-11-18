import { describe, expect, it } from "vitest"

import {
  editFragmentTexts,
  estimateEditFragmentStats,
} from "./line-change-stats"

describe("estimateEditFragmentStats", () => {
  it("末尾只加一个空行算 +1", () => {
    expect(estimateEditFragmentStats("y", "y\n")).toEqual({
      additions: 1,
      deletions: 0,
    })
    expect(estimateEditFragmentStats("y\n", "y\n\n")).toEqual({
      additions: 1,
      deletions: 0,
    })
  })

  it("末尾去掉一个空行算 -1", () => {
    expect(estimateEditFragmentStats("y\n", "y")).toEqual({
      additions: 0,
      deletions: 1,
    })
  })

  it("普通的改一行不变", () => {
    expect(estimateEditFragmentStats("a\nb", "a\nc")).toEqual({
      additions: 1,
      deletions: 1,
    })
    expect(estimateEditFragmentStats("a\nb\n", "a\nc\n")).toEqual({
      additions: 1,
      deletions: 1,
    })
  })

  it("两边都以换行结尾的不补，原样比", () => {
    expect(editFragmentTexts("a\n", "b\n")).toEqual({
      oldText: "a\n",
      newText: "b\n",
    })
    expect(editFragmentTexts("y", "y\n")).toEqual({
      oldText: "y\n",
      newText: "y\n\n",
    })
  })

  it("有一边是空的按原样算", () => {
    expect(estimateEditFragmentStats("", "a\nb\n")).toEqual({
      additions: 2,
      deletions: 0,
    })
    expect(estimateEditFragmentStats("a\nb", "")).toEqual({
      additions: 0,
      deletions: 2,
    })
  })
})
