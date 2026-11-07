import { describe, expect, it } from "vitest"
import type { DbConversationSummary } from "@/lib/types"
import {
  categoryWidth,
  estimateTextWidth,
  layoutMindMap,
  LEAF_WIDTH,
  mindMapNodeId,
  ROOT_HEIGHT,
  rootWidth,
  type MindMapLayout,
  type MindMapLayoutNode,
} from "./mindmap-layout"
import type { MindMapCategory, MindMapTree } from "./mindmap-model"

function conv(id: number): DbConversationSummary {
  return {
    id,
    folder_id: 1,
    title: `Conversation ${id}`,
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
    updated_at: "2026-10-01T00:00:00Z",
    pinned_at: null,
  }
}

let nextConversation = 1

function cat(
  id: string,
  {
    depth = 1,
    branch = 0,
    leaves = 0,
    hidden = 0,
    collapsed = false,
    children = [],
  }: {
    depth?: number
    branch?: number
    leaves?: number
    hidden?: number
    collapsed?: boolean
    children?: MindMapCategory[]
  } = {}
): MindMapCategory {
  const own = Array.from({ length: leaves }, () => conv(nextConversation++))
  return {
    id,
    name: id,
    rule: `rule of ${id}`,
    depth,
    branch,
    total: own.length + hidden + children.reduce((sum, c) => sum + c.total, 0),
    collapsed,
    children,
    leaves: own,
    hiddenLeaves: hidden,
  }
}

function tree(categories: MindMapCategory[]): MindMapTree {
  return {
    total: categories.reduce((sum, c) => sum + c.total, 0),
    categories,
  }
}

const label = (c: MindMapCategory) => c.name

function byId(layout: MindMapLayout): Map<string, MindMapLayoutNode> {
  return new Map(layout.nodes.map((n) => [n.id, n]))
}

function overlaps(a: MindMapLayoutNode, b: MindMapLayoutNode): boolean {
  return (
    a.x < b.x + b.width &&
    b.x < a.x + a.width &&
    a.y < b.y + b.height &&
    b.y < a.y + a.height
  )
}

/** A project the size of a busy month: both sides, sub-categories, caps. */
function busyTree(): MindMapTree {
  return tree([
    cat("frontend", {
      branch: 0,
      leaves: 3,
      children: [
        cat("canvas", { depth: 2, branch: 0, leaves: 8, hidden: 5 }),
        cat("settings-ui", { depth: 2, branch: 0, leaves: 2 }),
      ],
    }),
    cat("backend", { branch: 1, leaves: 6 }),
    cat("release", { branch: 2, leaves: 1, collapsed: true }),
    cat("docs", {
      branch: 3,
      children: [cat("guides", { depth: 2, branch: 3, leaves: 4 })],
    }),
    cat("research", { branch: 4, leaves: 8, hidden: 30 }),
    cat("__unclassified__", { branch: -1, leaves: 5 }),
  ])
}

describe("text and node sizes", () => {
  it("counts CJK as a full em and clamps pill widths", () => {
    expect(estimateTextWidth("画布", 14)).toBe(28)
    expect(estimateTextWidth("ab", 10)).toBeCloseTo(10.8)
    expect(rootWidth("")).toBe(160)
    expect(rootWidth("x".repeat(500))).toBe(340)
    expect(categoryWidth("", 1, 0)).toBe(120)
    expect(categoryWidth("y".repeat(500), 1, 9)).toBe(300)
    expect(categoryWidth("y".repeat(500), 2, 9)).toBe(270)
    // Room for the name beside a two-digit count, and more for a longer one:
    // "Testing" is 50px wide in the browser and needs 80px around it.
    expect(categoryWidth("Testing", 1, 13)).toBeGreaterThanOrEqual(50 + 80)
    expect(categoryWidth("Testing", 1, 2811)).toBe(
      categoryWidth("Testing", 1, 13) + 14
    )
  })
})

describe("layoutMindMap", () => {
  it("puts the root at the origin, centred on y = 0", () => {
    const layout = layoutMindMap("codeg", tree([]), label)
    expect(layout.edges).toEqual([])
    expect(layout.nodes).toHaveLength(1)
    const [root] = layout.nodes
    expect(root.id).toBe(mindMapNodeId.root)
    expect(root.x).toBe(0)
    expect(root.y).toBe(-ROOT_HEIGHT / 2)
  })

  it("grows every branch to the right of the root, in order", () => {
    const layout = layoutMindMap(
      "codeg",
      tree([cat("a", { leaves: 2 }), cat("b", { branch: 1, leaves: 2 })]),
      label
    )
    const nodes = byId(layout)
    const root = nodes.get("root")!
    const a = nodes.get("c:a")!
    const b = nodes.get("c:b")!
    // One column right of the root, first category on top, the column
    // centred on the root.
    expect(a.x).toBeGreaterThan(root.x + root.width)
    expect(b.x).toBe(a.x)
    expect(a.y).toBeLessThan(b.y)
    const top = Math.min(...layout.nodes.map((n) => n.y))
    const bottom = Math.max(...layout.nodes.map((n) => n.y + n.height))
    expect(top + bottom).toBeCloseTo(0)
    // Leaves sit one column further right, beside their own category.
    for (const leaf of layout.nodes.filter((n) => n.kind === "conversation")) {
      const parent = leaf.branch === 0 ? a : b
      expect(leaf.x).toBeGreaterThan(parent.x + parent.width)
      expect(leaf.width).toBe(LEAF_WIDTH)
    }
  })

  it("never overlaps two nodes of a busy project", () => {
    const layout = layoutMindMap("A long project name", busyTree(), label)
    const { nodes } = layout
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        expect(
          overlaps(nodes[i], nodes[j]),
          `${nodes[i].id} overlaps ${nodes[j].id}`
        ).toBe(false)
      }
    }
  })

  it("links every node but the root exactly once, from its left", () => {
    const layout = layoutMindMap("codeg", busyTree(), label)
    const nodes = byId(layout)
    expect(nodes.size).toBe(layout.nodes.length)
    const incoming = new Map<string, number>()
    for (const e of layout.edges) {
      expect(nodes.has(e.source)).toBe(true)
      const source = nodes.get(e.source)!
      const target = nodes.get(e.target)!
      expect(target.x).toBeGreaterThan(source.x + source.width)
      expect(e.depth).toBe(target.depth)
      incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1)
    }
    for (const n of layout.nodes) {
      expect(incoming.get(n.id) ?? 0).toBe(n.kind === "root" ? 0 : 1)
    }
  })

  it("draws a collapsed category without its contents", () => {
    const layout = layoutMindMap("codeg", busyTree(), label)
    const release = layout.nodes.find((n) => n.id === "c:release")!
    expect(release.category?.collapsed).toBe(true)
    expect(layout.edges.some((e) => e.source === "c:release")).toBe(false)
  })

  it("stands a 'more' node for hidden leaves", () => {
    const layout = layoutMindMap("codeg", busyTree(), label)
    const more = layout.nodes.filter((n) => n.kind === "more")
    expect(more.map((n) => n.id).sort()).toEqual(["m:canvas", "m:research"])
    expect(more.find((n) => n.id === "m:research")?.moreOf?.hiddenLeaves).toBe(
      30
    )
  })

  it("puts sub-categories before the parent's own conversations", () => {
    const layout = layoutMindMap("codeg", busyTree(), label)
    const children = layout.edges
      .filter((e) => e.source === "c:frontend")
      .map((e) => byId(layout).get(e.target)!)
    const firstLeaf = children.findIndex((n) => n.kind === "conversation")
    expect(children.slice(0, firstLeaf).map((n) => n.id)).toEqual([
      "c:canvas",
      "c:settings-ui",
    ])
    // Top to bottom in that order.
    const ys = children.map((n) => n.y)
    expect([...ys].sort((p, q) => p - q)).toEqual(ys)
  })

  it("is deterministic", () => {
    nextConversation = 1
    const first = layoutMindMap("codeg", busyTree(), label)
    nextConversation = 1
    const second = layoutMindMap("codeg", busyTree(), label)
    expect(second).toEqual(first)
  })
})
