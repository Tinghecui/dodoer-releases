import { describe, expect, it } from "vitest"
import {
  UNCLASSIFIED_CATEGORY_ID,
  UNOPENABLE_CATEGORY_ID,
  type ConversationTaxonomy,
  type TaxonomyCategory,
} from "@/lib/conversation-taxonomy"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import {
  allCategoryIds,
  buildMindMapTree,
  categoryMenuRows,
  categoryPath,
  DEFAULT_LEAF_LIMIT,
  foldSetFor,
  isCategoryFolded,
  liveAssignment,
  mindMapProjects,
  projectConversations,
} from "./mindmap-model"

function conv(
  id: number,
  title: string,
  extra: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title,
    title_locked: false,
    agent_type: "codex",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-01T00:00:00Z",
    // Higher id = newer, so recency order is easy to read in assertions.
    updated_at: `2026-10-01T00:00:${String(id % 60).padStart(2, "0")}Z`,
    pinned_at: null,
    ...extra,
  }
}

function folder(id: number, extra: Partial<FolderDetail> = {}): FolderDetail {
  return {
    id,
    name: `f${id}`,
    path: `/p/f${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-10-01T00:00:00Z",
    sort_order: 0,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...extra,
  }
}

function taxonomy(
  categories: TaxonomyCategory[],
  assignments: Record<number, string>
): ConversationTaxonomy {
  return {
    folder_id: 1,
    revision: 1,
    categories,
    assignments: Object.fromEntries(
      Object.entries(assignments).map(([id, category_id]) => [
        id,
        {
          category_id,
          source: "nightly" as const,
          confidence: null,
          assigned_at: "2026-10-01T00:00:00Z",
        },
      ])
    ),
    reorganized_at: null,
    reorganize_summary: null,
  }
}

const cat = (
  id: string,
  name: string,
  parent_id: string | null = null
): TaxonomyCategory => ({ id, name, parent_id, rule: `rule of ${name}` })

describe("project scope", () => {
  it("merges worktree children and keeps root-level work only", () => {
    const folders = [folder(1), folder(2, { parent_id: 1 }), folder(3)]
    const rows = [
      conv(10, "root"),
      conv(11, "in worktree", { folder_id: 2 }),
      conv(12, "other project", { folder_id: 3 }),
      conv(13, "delegate child", { parent_id: 10 }),
      conv(14, "loop row", { kind: "loop" }),
    ]
    expect(projectConversations(1, folders, rows).map((c) => c.id)).toEqual([
      10, 11,
    ])
  })

  it("lists only root, non-chat folders as projects", () => {
    const folders = [
      folder(1),
      folder(2, { parent_id: 1 }),
      folder(3, { kind: "chat" }),
    ]
    expect(mindMapProjects(folders).map((f) => f.id)).toEqual([1])
  })
})

describe("buildMindMapTree", () => {
  it("puts every conversation without a taxonomy under unclassified", () => {
    const tree = buildMindMapTree({
      taxonomy: null,
      conversations: [conv(1, "a"), conv(2, "b")],
    })
    expect(tree.total).toBe(2)
    expect(tree.categories).toHaveLength(1)
    const [only] = tree.categories
    expect(only.id).toBe(UNCLASSIFIED_CATEGORY_ID)
    expect(only.branch).toBe(-1)
    // Newest first.
    expect(only.leaves.map((c) => c.id)).toEqual([2, 1])
  })

  it("nests categories, counts subtrees and keeps the taxonomy's order", () => {
    const tree = buildMindMapTree({
      taxonomy: taxonomy(
        [cat("ui", "UI"), cat("api", "API"), cat("ui-css", "CSS", "ui")],
        { 1: "ui", 2: "ui-css", 3: "api", 4: "ui-css" }
      ),
      conversations: [conv(1, "a"), conv(2, "b"), conv(3, "c"), conv(4, "d")],
    })
    expect(tree.categories.map((c) => c.id)).toEqual(["ui", "api"])
    const ui = tree.categories[0]
    expect(ui.total).toBe(3)
    expect(ui.leaves.map((c) => c.id)).toEqual([1])
    expect(ui.children.map((c) => c.id)).toEqual(["ui-css"])
    expect(ui.children[0].depth).toBe(2)
    expect(ui.children[0].branch).toBe(0)
    expect(ui.children[0].leaves.map((c) => c.id)).toEqual([4, 2])
    expect(tree.categories[1].branch).toBe(1)
    expect(tree.total).toBe(4)
  })

  it("sends conversations of a deleted category to unclassified", () => {
    const tree = buildMindMapTree({
      taxonomy: taxonomy([cat("ui", "UI")], { 1: "ui", 2: "gone" }),
      conversations: [conv(1, "a"), conv(2, "b")],
    })
    expect(tree.categories.map((c) => c.id)).toEqual([
      "ui",
      UNCLASSIFIED_CATEGORY_ID,
    ])
    expect(tree.categories[1].leaves.map((c) => c.id)).toEqual([2])
  })

  it("keeps a conversation taken out by hand under unclassified, by hand", () => {
    const t = taxonomy([cat("ui", "UI")], { 1: "ui" })
    t.assignments["2"] = {
      category_id: null,
      source: "manual",
      confidence: null,
      assigned_at: "2026-10-01T00:00:00Z",
    }
    const tree = buildMindMapTree({
      taxonomy: t,
      conversations: [conv(1, "a"), conv(2, "b")],
    })
    expect(tree.categories[1].id).toBe(UNCLASSIFIED_CATEGORY_ID)
    expect(tree.categories[1].leaves.map((c) => c.id)).toEqual([2])
    // The leaf still knows who put it there.
    expect(liveAssignment(t, 2, new Set(["ui"]))?.source).toBe("manual")
    expect(liveAssignment(t, 3, new Set(["ui"]))).toBeNull()
  })

  it("caps leaves and reports how many are hidden", () => {
    const many = Array.from({ length: DEFAULT_LEAF_LIMIT + 5 }, (_, i) =>
      conv(i + 1, `t${i}`)
    )
    const tree = buildMindMapTree({
      taxonomy: taxonomy(
        [cat("x", "X")],
        Object.fromEntries(many.map((c) => [c.id, "x"]))
      ),
      conversations: many,
    })
    expect(tree.categories[0].leaves).toHaveLength(DEFAULT_LEAF_LIMIT)
    expect(tree.categories[0].hiddenLeaves).toBe(5)
    const more = buildMindMapTree({
      taxonomy: taxonomy(
        [cat("x", "X")],
        Object.fromEntries(many.map((c) => [c.id, "x"]))
      ),
      conversations: many,
      leafLimits: new Map([["x", 100]]),
    })
    expect(more.categories[0].hiddenLeaves).toBe(0)
  })

  it("filters by title, keeps a matching category whole, ignores collapse", () => {
    const tax = taxonomy([cat("ui", "Frontend"), cat("ops", "Deploy")], {
      1: "ui",
      2: "ui",
      3: "ops",
    })
    const rows = [conv(1, "fix button"), conv(2, "dark mode"), conv(3, "ci")]
    const byTitle = buildMindMapTree({
      taxonomy: tax,
      conversations: rows,
      query: "BUTTON",
      collapsed: new Set(["ui"]),
    })
    expect(byTitle.categories.map((c) => c.id)).toEqual(["ui"])
    expect(byTitle.categories[0].collapsed).toBe(false)
    expect(byTitle.categories[0].leaves.map((c) => c.id)).toEqual([1])
    expect(byTitle.total).toBe(1)

    const byName = buildMindMapTree({
      taxonomy: tax,
      conversations: rows,
      query: "deploy",
    })
    expect(byName.categories.map((c) => c.id)).toEqual(["ops"])
    expect(byName.categories[0].leaves.map((c) => c.id)).toEqual([3])
  })

  it("survives parent cycles and missing parents", () => {
    const tree = buildMindMapTree({
      taxonomy: taxonomy(
        [cat("a", "A", "b"), cat("b", "B", "a"), cat("c", "C", "nope")],
        { 1: "a", 2: "b", 3: "c" }
      ),
      conversations: [conv(1, "x"), conv(2, "y"), conv(3, "z")],
    })
    // Nothing is lost: every conversation is still on the map.
    expect(tree.total).toBe(3)
    expect(allCategoryIds(tree).sort()).toEqual(["a", "b", "c"])
  })

  it("marks collapsed categories", () => {
    const tree = buildMindMapTree({
      taxonomy: taxonomy([cat("ui", "UI")], { 1: "ui" }),
      conversations: [conv(1, "a")],
      collapsed: new Set(["ui"]),
    })
    expect(tree.categories[0].collapsed).toBe(true)
    // Counts do not depend on collapsing.
    expect(tree.categories[0].total).toBe(1)
  })
})

describe("categoryMenuRows", () => {
  it("lists categories depth-first with their depth", () => {
    const rows = categoryMenuRows(
      taxonomy(
        [cat("ui", "UI"), cat("api", "API"), cat("css", "CSS", "ui")],
        {}
      )
    )
    expect(rows).toEqual([
      { id: "ui", name: "UI", depth: 1 },
      { id: "css", name: "CSS", depth: 2 },
      { id: "api", name: "API", depth: 1 },
    ])
  })
})

describe("categoryPath", () => {
  it("walks from the conversation's category up to its top branch", () => {
    const tax = taxonomy(
      [
        { id: "ui", parent_id: null, name: "UI", rule: "" },
        { id: "css", parent_id: "ui", name: "CSS", rule: "" },
      ],
      { 1: "css" }
    )
    expect(categoryPath(tax, 1)).toEqual([
      { id: "ui", name: "UI" },
      { id: "css", name: "CSS" },
    ])
    expect(categoryPath(tax, 2)).toEqual([])
    expect(categoryPath(null, 1)).toEqual([])
  })
})

describe("conversations that would open empty", () => {
  const cats: TaxonomyCategory[] = [
    { id: "ui", parent_id: null, name: "UI", rule: "Screens." },
  ]
  const tax = taxonomy(cats, { 1: "ui", 2: "ui" })
  const conversations = [conv(1, "one"), conv(2, "two"), conv(3, "three")]

  it("move to a last branch, folded by default, under their categories", () => {
    const tree = buildMindMapTree({
      taxonomy: tax,
      conversations,
      unopenable: new Set([2, 3]),
    })
    expect(tree.categories.map((c) => c.id)).toEqual([
      "ui",
      UNOPENABLE_CATEGORY_ID,
    ])
    expect(tree.categories[0].leaves.map((c) => c.id)).toEqual([1])
    const unopenable = tree.categories[1]
    // 3 had no category: a leaf of the branch itself; 2 keeps "UI".
    expect(unopenable.leaves.map((c) => c.id)).toEqual([3])
    expect(unopenable.children.map((c) => [c.id, c.name, c.depth])).toEqual([
      [`${UNOPENABLE_CATEGORY_ID}/ui`, "UI", 2],
    ])
    expect(unopenable.children[0].leaves.map((c) => c.id)).toEqual([2])
    expect(unopenable.children[0].collapsed).toBe(false)
    expect(unopenable.total).toBe(2)
    expect(unopenable.collapsed).toBe(true)
    expect(tree.total).toBe(3)
  })

  it("leave a category out of the live tree once all of it is unopenable", () => {
    const tree = buildMindMapTree({
      taxonomy: tax,
      conversations,
      unopenable: new Set([1, 2]),
    })
    expect(tree.categories.map((c) => c.id)).toEqual([
      UNCLASSIFIED_CATEGORY_ID,
      UNOPENABLE_CATEGORY_ID,
    ])
  })

  it("open when the fold set names the branch, and show while searching", () => {
    const stored = new Set([UNOPENABLE_CATEGORY_ID])
    expect(isCategoryFolded(UNOPENABLE_CATEGORY_ID, stored)).toBe(false)
    expect(isCategoryFolded("ui", stored)).toBe(false)
    expect(isCategoryFolded("ui", new Set(["ui"]))).toBe(true)
    const opened = buildMindMapTree({
      taxonomy: tax,
      conversations,
      unopenable: new Set([3]),
      collapsed: stored,
    })
    expect(opened.categories[opened.categories.length - 1].collapsed).toBe(
      false
    )
    const searched = buildMindMapTree({
      taxonomy: tax,
      conversations,
      unopenable: new Set([3]),
      query: "three",
    })
    expect(searched.categories.map((c) => [c.id, c.collapsed])).toEqual([
      [UNOPENABLE_CATEGORY_ID, false],
    ])
  })

  it("fold and open with every other branch", () => {
    const tree = buildMindMapTree({
      taxonomy: tax,
      conversations,
      unopenable: new Set([3]),
    })
    expect(foldSetFor(tree, true)).toEqual(["ui"])
    expect(foldSetFor(tree, false)).toEqual([UNOPENABLE_CATEGORY_ID])
  })
})
