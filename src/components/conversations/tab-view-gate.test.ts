import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { collectDraftTabIds, tabViewKind } from "./tab-view-gate"

describe("tabViewKind", () => {
  it("刷新后恢复的标签在会话列表回来前先不挂", () => {
    expect(
      tabViewKind({
        conversationId: 7,
        conversationsLoaded: false,
        kind: undefined,
        mountedBefore: false,
      })
    ).toBe("wait")
  })

  it("草稿标签照常挂会话视图", () => {
    expect(
      tabViewKind({
        conversationId: null,
        conversationsLoaded: false,
        kind: undefined,
        mountedBefore: false,
      })
    ).toBe("chat")
  })

  // #1045：草稿发第一条消息、刚绑上会话号时列表还没回来（限流），视图不能被卸掉
  it("挂过会话视图的标签绑上会话号后不等列表", () => {
    expect(
      tabViewKind({
        conversationId: 7,
        conversationsLoaded: false,
        kind: undefined,
        mountedBefore: true,
      })
    ).toBe("chat")
  })

  it("列表回来后按会话类型挂 Loop 或普通视图", () => {
    expect(
      tabViewKind({
        conversationId: 7,
        conversationsLoaded: true,
        kind: "loop",
        mountedBefore: false,
      })
    ).toBe("loop")
    expect(
      tabViewKind({
        conversationId: 7,
        conversationsLoaded: true,
        kind: "regular",
        mountedBefore: true,
      })
    ).toBe("chat")
  })
})

describe("collectDraftTabIds", () => {
  it("记下草稿标签，绑上会话号后仍记得，刷新恢复的有号标签不算", () => {
    const first = collectDraftTabIds(
      [
        { id: "draft", conversationId: null },
        { id: "restored", conversationId: 3 },
      ],
      new Set()
    )
    expect([...first]).toEqual(["draft"])
    const bound = collectDraftTabIds(
      [
        { id: "draft", conversationId: 9 },
        { id: "restored", conversationId: 3 },
      ],
      first
    )
    expect(bound).toBe(first)
    expect(bound.has("draft")).toBe(true)
    expect(bound.has("restored")).toBe(false)
  })
})

describe("主区标签接上 tabViewKind", () => {
  const source = readFileSync(
    join(__dirname, "conversation-detail-panel.tsx"),
    "utf8"
  )
  it("把本页见过的草稿标签传给 mountedBefore", () => {
    expect(source).toContain("mountedBefore: draftTabIds.has(tab.id)")
    expect(source).toContain("collectDraftTabIds(tabs, seenDrafts.ids)")
  })
})
