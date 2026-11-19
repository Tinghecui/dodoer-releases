import { describe, expect, it } from "vitest"

import {
  editFragmentTexts,
  editFragmentTextsAt,
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

describe("editFragmentTextsAt", () => {
  it("把往后挪的插入补成片段后面的那几行", () => {
    // 片段里新增行在 3 + 1 = 4 行，后端说在第 5 行：后面那一行是空行
    expect(editFragmentTextsAt("c\n", "c\n\n", 3, 5)).toEqual({
      oldText: "c\n\n",
      newText: "c\n\n\n",
    })
  })

  it("对不上的起始行只补齐换行", () => {
    // 没往后挪
    expect(editFragmentTextsAt("c", "c\n", 3, 4)).toEqual({
      oldText: "c\n",
      newText: "c\n\n",
    })
    // 不是纯插入
    expect(editFragmentTextsAt("b\n", "B\n\n", 3, 6)).toEqual({
      oldText: "b\n",
      newText: "B\n\n",
    })
    // 没有片段的起始行
    expect(editFragmentTextsAt("c\n", "c\n\n", undefined, 5)).toEqual({
      oldText: "c\n",
      newText: "c\n\n",
    })
  })
})
