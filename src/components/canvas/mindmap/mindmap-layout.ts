import { UNOPENABLE_CATEGORY_ID } from "@/lib/conversation-taxonomy"
import type { DbConversationSummary } from "@/lib/types"
import type { MindMapCategory, MindMapTree } from "./mindmap-model"

/**
 * Geometry of the conversation mind map, a one-way "logic chart": the project
 * on the left, every branch a tidy tree growing to the right, each parent
 * centred on its children. Pure and deterministic — sizes come from estimated
 * text widths, not the DOM — so a relayout never waits on a measure pass and
 * tests can pin the numbers.
 */

export type MindMapNodeKind = "root" | "category" | "conversation" | "more"

export interface MindMapLayoutNode {
  id: string
  kind: MindMapNodeKind
  /** Top-left corner, flow units. */
  x: number
  y: number
  width: number
  height: number
  depth: number
  /** Palette slot of the top-level branch; -1 unclassified / the root. */
  branch: number
  category?: MindMapCategory
  conversation?: DbConversationSummary
  /** kind=more: the category whose hidden leaves it stands for. */
  moreOf?: MindMapCategory
}

export interface MindMapLayoutEdge {
  id: string
  source: string
  target: string
  /** Depth of the target node: thick near the root, thin at the leaves. */
  depth: number
  branch: number
}

export interface MindMapLayout {
  nodes: MindMapLayoutNode[]
  edges: MindMapLayoutEdge[]
}

export const ROOT_HEIGHT = 64
export const CATEGORY_HEIGHT = 40
export const SUBCATEGORY_HEIGHT = 34
export const LEAF_WIDTH = 320
export const LEAF_HEIGHT = 32
export const MORE_WIDTH = 132
export const MORE_HEIGHT = 28

/** Room for the curve between a parent and its children's column. */
const ROOT_GAP_X = 96
const BRANCH_GAP_X = 72
const LEAF_GAP_Y = 8
const CATEGORY_GAP_Y = 16
const TOP_BRANCH_GAP_Y = 24

/** Node ids, stable across relayouts so React keeps each node's DOM. */
export const mindMapNodeId = {
  root: "root",
  category: (id: string) => `c:${id}`,
  conversation: (id: number) => `v:${id}`,
  more: (categoryId: string) => `m:${categoryId}`,
}

/**
 * Rough rendered width of `text` at `fontPx`: CJK and full-width characters a
 * full em, Latin capitals and digits a bit wider than lower case. Good enough
 * to size a pill; the pill truncates whatever the estimate misses.
 */
export function estimateTextWidth(text: string, fontPx: number): number {
  let width = 0
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if (code >= 0x2e80) width += fontPx
    else if (ch === " ") width += fontPx * 0.3
    else if (/[A-Z0-9]/.test(ch)) width += fontPx * 0.64
    else width += fontPx * 0.54
  }
  return width
}

const clamp = (v: number, lo: number, hi: number) =>
  Math.min(hi, Math.max(lo, v))

export function rootWidth(label: string): number {
  return Math.round(clamp(estimateTextWidth(label, 18) + 64, 160, 340))
}

export function categoryWidth(
  label: string,
  depth: number,
  total: number
): number {
  const font = depth === 1 ? 14 : 13
  // Around the name, as measured in the browser: padding and border (28),
  // the collapse toggle and the gaps (32), and the count badge — 12 of
  // padding plus about 7 per digit.
  const chrome = 72 + 7 * String(total).length
  return Math.round(
    clamp(estimateTextWidth(label, font) + chrome, 120, depth === 1 ? 300 : 270)
  )
}

/** One laid-out subtree before it is placed: its node and its children. */
interface Box {
  node: Omit<MindMapLayoutNode, "x" | "y">
  children: Box[]
  /** Height of the whole subtree, the node included. */
  span: number
  /** Vertical gap between this box's children. */
  childGap: number
}

function leafBox(
  conversation: DbConversationSummary,
  depth: number,
  branch: number
): Box {
  return {
    node: {
      id: mindMapNodeId.conversation(conversation.id),
      kind: "conversation",
      width: LEAF_WIDTH,
      height: LEAF_HEIGHT,
      depth,
      branch,
      conversation,
    },
    children: [],
    span: LEAF_HEIGHT,
    childGap: 0,
  }
}

function categoryBox(category: MindMapCategory, label: string): Box {
  const height = category.depth === 1 ? CATEGORY_HEIGHT : SUBCATEGORY_HEIGHT
  const node: Box["node"] = {
    id: mindMapNodeId.category(category.id),
    kind: "category",
    // The "can't open" branch also carries an icon before its name.
    width:
      categoryWidth(label, category.depth, category.total) +
      (category.id === UNOPENABLE_CATEGORY_ID ? 20 : 0),
    height,
    depth: category.depth,
    branch: category.branch,
    category,
  }
  const children: Box[] = []
  if (!category.collapsed) {
    // Sub-categories first, then this category's own conversations.
    for (const child of category.children)
      children.push(categoryBox(child, child.name))
    for (const leaf of category.leaves)
      children.push(leafBox(leaf, category.depth + 1, category.branch))
    if (category.hiddenLeaves > 0) {
      children.push({
        node: {
          id: mindMapNodeId.more(category.id),
          kind: "more",
          width: MORE_WIDTH,
          height: MORE_HEIGHT,
          depth: category.depth + 1,
          branch: category.branch,
          moreOf: category,
        },
        children: [],
        span: MORE_HEIGHT,
        childGap: 0,
      })
    }
  }
  const childGap = category.children.length > 0 ? CATEGORY_GAP_Y : LEAF_GAP_Y
  return { node, children, childGap, span: spanOf(height, children, childGap) }
}

function spanOf(height: number, children: Box[], gap: number): number {
  if (children.length === 0) return height
  const stacked =
    children.reduce((sum, c) => sum + c.span, 0) + gap * (children.length - 1)
  return Math.max(height, stacked)
}

/**
 * Place `box` with its left edge at `x`, its subtree's band starting at `top`
 * and its own node centred in that band; its children follow one column to
 * the right.
 */
function place(
  box: Box,
  x: number,
  top: number,
  parentId: string,
  nodes: MindMapLayoutNode[],
  edges: MindMapLayoutEdge[]
) {
  const { node } = box
  const y = top + (box.span - node.height) / 2
  nodes.push({ ...node, x, y })
  edges.push({
    id: `${parentId}->${node.id}`,
    source: parentId,
    target: node.id,
    depth: node.depth,
    branch: node.branch,
  })
  placeColumn(
    box.children,
    x + node.width + BRANCH_GAP_X,
    top,
    box.span,
    box.childGap,
    node.id,
    nodes,
    edges
  )
}

/** Stack `boxes` as one column at `x`, centred in the band `top`..`top+span`. */
function placeColumn(
  boxes: Box[],
  x: number,
  top: number,
  span: number,
  gap: number,
  parentId: string,
  nodes: MindMapLayoutNode[],
  edges: MindMapLayoutEdge[]
) {
  if (boxes.length === 0) return
  const stacked =
    boxes.reduce((sum, c) => sum + c.span, 0) + gap * (boxes.length - 1)
  let cursor = top + (span - stacked) / 2
  for (const child of boxes) {
    place(child, x, cursor, parentId, nodes, edges)
    cursor += child.span + gap
  }
}

/**
 * Lay out the mind map: the root at the origin's left, vertically centred on
 * y = 0, and every top-level branch stacked in one column to its right, in
 * the tree's order (first category on top).
 */
export function layoutMindMap(
  rootLabel: string,
  tree: MindMapTree,
  categoryLabel: (category: MindMapCategory) => string
): MindMapLayout {
  const nodes: MindMapLayoutNode[] = []
  const edges: MindMapLayoutEdge[] = []

  const rootW = rootWidth(rootLabel)
  const root: MindMapLayoutNode = {
    id: mindMapNodeId.root,
    kind: "root",
    x: 0,
    y: -ROOT_HEIGHT / 2,
    width: rootW,
    height: ROOT_HEIGHT,
    depth: 0,
    branch: -1,
  }
  nodes.push(root)

  const boxes = tree.categories.map((c) => categoryBox(c, categoryLabel(c)))
  const span = spanOf(0, boxes, TOP_BRANCH_GAP_Y)
  placeColumn(
    boxes,
    rootW + ROOT_GAP_X,
    -span / 2,
    span,
    TOP_BRANCH_GAP_Y,
    root.id,
    nodes,
    edges
  )
  return { nodes, edges }
}
