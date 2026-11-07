import {
  UNCLASSIFIED_CATEGORY_ID,
  UNOPENABLE_CATEGORY_ID,
  type ConversationTaxonomy,
  type TaxonomyAssignment,
} from "@/lib/conversation-taxonomy"
import { formatConversationTitle } from "@/lib/conversation-title"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import { compareByRecency, isCanvasEligible } from "../canvas-model"

/** Leaves a category shows before its "N more" node. */
export const DEFAULT_LEAF_LIMIT = 8
/** How many more leaves one click on "N more" reveals. */
export const LEAF_LIMIT_STEP = 24
/** Deeper categories are drawn at this depth: the nightly plan allows two
 *  levels, this only keeps a hand-edited tree from running off the screen. */
const MAX_DEPTH = 3

export interface MindMapCategory {
  /** The taxonomy's category id, {@link UNCLASSIFIED_CATEGORY_ID} or
   *  {@link UNOPENABLE_CATEGORY_ID}. */
  id: string
  name: string
  rule: string | null
  /** 1 for a top-level branch. */
  depth: number
  /** Palette slot of the top-level branch this sits in; -1 for unclassified. */
  branch: number
  /** Conversations in this subtree that pass the search. */
  total: number
  collapsed: boolean
  children: MindMapCategory[]
  /** The conversations drawn as leaves, newest first. */
  leaves: DbConversationSummary[]
  /** Direct conversations past the leaf limit. */
  hiddenLeaves: number
}

export interface MindMapTree {
  /** Conversations of the project that pass the search. */
  total: number
  /** Top-level branches; unclassified, then unopenable, when they have
   *  anything, come last. A category with no conversations is left out. */
  categories: MindMapCategory[]
}

/** Branches folded until the user opens them: for these, the stored fold set
 *  names the ones the user OPENED. */
const FOLDED_BY_DEFAULT: ReadonlySet<string> = new Set([UNOPENABLE_CATEGORY_ID])

/** Whether `categoryId` is folded, given the stored fold set (see
 *  `useMindMapViewStore`): membership flips the category's default. */
export function isCategoryFolded(
  categoryId: string,
  stored: ReadonlySet<string>
): boolean {
  return FOLDED_BY_DEFAULT.has(categoryId)
    ? !stored.has(categoryId)
    : stored.has(categoryId)
}

/** The fold set that folds (or opens) every category of `tree`. */
export function foldSetFor(tree: MindMapTree, folded: boolean): string[] {
  return allCategoryIds(tree).filter(
    (id) => FOLDED_BY_DEFAULT.has(id) !== folded
  )
}

export interface BuildMindMapInput {
  taxonomy: ConversationTaxonomy | null
  /** The project's conversations (see {@link projectConversations}). */
  conversations: readonly DbConversationSummary[]
  query?: string
  collapsed?: ReadonlySet<string>
  leafLimits?: ReadonlyMap<string, number>
  /** Conversations that would open empty (see `listUnopenableConversations`):
   *  they move to the folded "can't open" branch, under the same categories. */
  unopenable?: ReadonlySet<number>
}

/** The folders a project spans: the root and its worktree children, as a
 *  canvas folder region merges them. */
export function projectFolderIds(
  rootFolderId: number,
  allFolders: readonly FolderDetail[]
): Set<number> {
  const ids = new Set<number>([rootFolderId])
  for (const f of allFolders) {
    if (f.parent_id === rootFolderId) ids.add(f.id)
  }
  return ids
}

/** The conversations a project's mind map places: its root-level work, the
 *  same scope a canvas region shows. */
export function projectConversations(
  rootFolderId: number,
  allFolders: readonly FolderDetail[],
  conversations: readonly DbConversationSummary[]
): DbConversationSummary[] {
  const ids = projectFolderIds(rootFolderId, allFolders)
  return conversations.filter(
    (c) => ids.has(c.folder_id) && isCanvasEligible(c)
  )
}

/** Folders that can have a mind map: projects in the sidebar, never the
 *  hidden chat folders or worktree children (they belong to their root). */
export function mindMapProjects(
  allFolders: readonly FolderDetail[]
): FolderDetail[] {
  return allFolders.filter((f) => f.kind !== "chat" && f.parent_id == null)
}

/** The assignment that places `conversation`, when its category still exists,
 *  or the user's own removal from every category (no category). */
export function liveAssignment(
  taxonomy: ConversationTaxonomy | null,
  conversationId: number,
  categoryIds: ReadonlySet<string>
): TaxonomyAssignment | null {
  const a = taxonomy?.assignments[String(conversationId)]
  if (!a) return null
  return a.category_id === null || categoryIds.has(a.category_id) ? a : null
}

interface RawCategory {
  id: string
  name: string
  rule: string | null
  parentId: string | null
  order: number
}

/**
 * Parents that exist and do not loop back; anything else is treated as a
 * top-level branch rather than dropped, so a bad write can never hide
 * conversations.
 */
function sanitizeParents(raw: RawCategory[]): Map<string, string | null> {
  const byId = new Map(raw.map((c) => [c.id, c]))
  const parentOf = new Map<string, string | null>()
  for (const c of raw) {
    let parent = c.parentId != null && byId.has(c.parentId) ? c.parentId : null
    // Walk up: a cycle (or an absurd depth) demotes this node to the top.
    const seen = new Set<string>([c.id])
    let cursor = parent
    let steps = 0
    while (cursor != null) {
      if (seen.has(cursor) || steps > 32) {
        parent = null
        break
      }
      seen.add(cursor)
      steps += 1
      cursor = byId.get(cursor)?.parentId ?? null
      if (cursor != null && !byId.has(cursor)) cursor = null
    }
    parentOf.set(c.id, parent)
  }
  return parentOf
}

function matchesQuery(text: string | null | undefined, q: string): boolean {
  return q.length > 0 && (text ?? "").toLocaleLowerCase().includes(q)
}

/**
 * The project's mind map: categories as a tree, each holding its
 * conversations (newest first, capped), plus an "unclassified" branch for
 * conversations without a live category.
 *
 * A category with no conversations is not drawn. With a search, a category
 * shows only the conversations whose title matches — all of its own when its
 * name matches. Collapsing is ignored while searching: a hit must be visible.
 */
export function buildMindMapTree({
  taxonomy,
  conversations,
  query = "",
  collapsed = new Set<string>(),
  leafLimits = new Map<string, number>(),
  unopenable = new Set<number>(),
}: BuildMindMapInput): MindMapTree {
  const q = query.trim().toLocaleLowerCase()
  const searching = q.length > 0

  const raw: RawCategory[] = (taxonomy?.categories ?? []).map((c, order) => ({
    id: c.id,
    name: c.name,
    rule: c.rule,
    parentId: c.parent_id,
    order,
  }))
  const parentOf = sanitizeParents(raw)
  const categoryIds = new Set(raw.map((c) => c.id))

  // Direct members per category, newest first. A conversation that would
  // open empty keeps its category, but in the "can't open" branch's copy of
  // the tree rather than in the live one.
  const members = new Map<string, DbConversationSummary[]>()
  const unopenableMembers = new Map<string, DbConversationSummary[]>()
  for (const conversation of [...conversations].sort(compareByRecency)) {
    const assignment = liveAssignment(taxonomy, conversation.id, categoryIds)
    const key = assignment?.category_id ?? UNCLASSIFIED_CATEGORY_ID
    const into = unopenable.has(conversation.id) ? unopenableMembers : members
    const list = into.get(key)
    if (list) list.push(conversation)
    else into.set(key, [conversation])
  }

  const childrenOf = new Map<string | null, RawCategory[]>()
  for (const c of raw) {
    const parent = parentOf.get(c.id) ?? null
    const list = childrenOf.get(parent)
    if (list) list.push(c)
    else childrenOf.set(parent, [c])
  }

  const titlePasses = (v: DbConversationSummary) =>
    !searching || matchesQuery(formatConversationTitle(v.title), q)

  const leafFields = (id: string, own: DbConversationSummary[]) => {
    const limit = leafLimits.get(id) ?? DEFAULT_LEAF_LIMIT
    return {
      leaves: own.slice(0, limit),
      hiddenLeaves: Math.max(0, own.length - limit),
    }
  }

  /** One category's subtree over `from`; `idPrefix` keeps the "can't open"
   *  copy's ids (folds, leaf limits, React Flow nodes) apart from the live
   *  tree's. A category with nothing in it is not drawn. */
  const build = (
    c: RawCategory,
    depth: number,
    branch: number,
    ancestorMatched: boolean,
    from: Map<string, DbConversationSummary[]>,
    idPrefix: string
  ): MindMapCategory | null => {
    const nameMatched = ancestorMatched || matchesQuery(c.name, q)
    const passes = (v: DbConversationSummary) => nameMatched || titlePasses(v)
    const visibleOwn = (from.get(c.id) ?? []).filter(passes)

    let children: MindMapCategory[] = []
    if (depth < MAX_DEPTH) {
      children = (childrenOf.get(c.id) ?? [])
        .map((child) =>
          build(child, depth + 1, branch, nameMatched, from, idPrefix)
        )
        .filter((child): child is MindMapCategory => child != null)
    } else {
      // Too deep to draw: fold the rest of the subtree's conversations in.
      const stack = [...(childrenOf.get(c.id) ?? [])]
      while (stack.length > 0) {
        const d = stack.pop()!
        visibleOwn.push(...(from.get(d.id) ?? []).filter(passes))
        stack.push(...(childrenOf.get(d.id) ?? []))
      }
      visibleOwn.sort(compareByRecency)
    }

    const total =
      visibleOwn.length + children.reduce((sum, ch) => sum + ch.total, 0)
    if (total === 0) return null

    const id = `${idPrefix}${c.id}`
    return {
      id,
      name: c.name,
      rule: c.rule,
      depth,
      branch,
      total,
      collapsed: !searching && isCategoryFolded(id, collapsed),
      children,
      ...leafFields(id, visibleOwn),
    }
  }

  const categories: MindMapCategory[] = []
  ;(childrenOf.get(null) ?? []).forEach((c, index) => {
    const node = build(c, 1, index, false, members, "")
    if (node) categories.push(node)
  })

  // Unclassified: no rule, no sub-categories, searched by title.
  const unclassified = (members.get(UNCLASSIFIED_CATEGORY_ID) ?? []).filter(
    titlePasses
  )
  if (unclassified.length > 0) {
    categories.push({
      id: UNCLASSIFIED_CATEGORY_ID,
      name: "",
      rule: null,
      depth: 1,
      branch: -1,
      total: unclassified.length,
      collapsed:
        !searching && isCategoryFolded(UNCLASSIFIED_CATEGORY_ID, collapsed),
      children: [],
      ...leafFields(UNCLASSIFIED_CATEGORY_ID, unclassified),
    })
  }

  // Can't open: the same categories again, holding only those conversations,
  // with the ones that had no category as its own leaves.
  const unopenablePrefix = `${UNOPENABLE_CATEGORY_ID}/`
  const unopenableChildren = (childrenOf.get(null) ?? [])
    .map((c) => build(c, 2, -1, false, unopenableMembers, unopenablePrefix))
    .filter((c): c is MindMapCategory => c != null)
  const unopenableOwn = (
    unopenableMembers.get(UNCLASSIFIED_CATEGORY_ID) ?? []
  ).filter(titlePasses)
  const unopenableTotal =
    unopenableOwn.length +
    unopenableChildren.reduce((sum, c) => sum + c.total, 0)
  if (unopenableTotal > 0) {
    categories.push({
      id: UNOPENABLE_CATEGORY_ID,
      name: "",
      rule: null,
      depth: 1,
      branch: -1,
      total: unopenableTotal,
      collapsed:
        !searching && isCategoryFolded(UNOPENABLE_CATEGORY_ID, collapsed),
      children: unopenableChildren,
      ...leafFields(UNOPENABLE_CATEGORY_ID, unopenableOwn),
    })
  }

  return {
    total: categories.reduce((sum, c) => sum + c.total, 0),
    categories,
  }
}

/** Every category id in the tree, for "collapse all". */
export function allCategoryIds(tree: MindMapTree): string[] {
  const ids: string[] = []
  const walk = (c: MindMapCategory) => {
    ids.push(c.id)
    c.children.forEach(walk)
  }
  tree.categories.forEach(walk)
  return ids
}

/** Categories a conversation can be moved to, as indented menu rows. */
export function categoryMenuRows(
  taxonomy: ConversationTaxonomy | null
): { id: string; name: string; depth: number }[] {
  const raw: RawCategory[] = (taxonomy?.categories ?? []).map((c, order) => ({
    id: c.id,
    name: c.name,
    rule: c.rule,
    parentId: c.parent_id,
    order,
  }))
  const parentOf = sanitizeParents(raw)
  const childrenOf = new Map<string | null, RawCategory[]>()
  for (const c of raw) {
    const parent = parentOf.get(c.id) ?? null
    const list = childrenOf.get(parent)
    if (list) list.push(c)
    else childrenOf.set(parent, [c])
  }
  const rows: { id: string; name: string; depth: number }[] = []
  const walk = (c: RawCategory, depth: number) => {
    rows.push({ id: c.id, name: c.name, depth })
    for (const child of childrenOf.get(c.id) ?? []) walk(child, depth + 1)
  }
  for (const top of childrenOf.get(null) ?? []) walk(top, 1)
  return rows
}

/** The categories `conversationId` sits in, top-level branch first; empty
 *  when it has none (or the taxonomy is not in yet). */
export function categoryPath(
  taxonomy: ConversationTaxonomy | null,
  conversationId: number
): { id: string; name: string }[] {
  const raw: RawCategory[] = (taxonomy?.categories ?? []).map((c, order) => ({
    id: c.id,
    name: c.name,
    rule: c.rule,
    parentId: c.parent_id,
    order,
  }))
  const byId = new Map(raw.map((c) => [c.id, c]))
  const assignment = liveAssignment(
    taxonomy,
    conversationId,
    new Set(byId.keys())
  )
  const parentOf = sanitizeParents(raw)
  const path: { id: string; name: string }[] = []
  let id = assignment?.category_id ?? null
  while (id != null) {
    const c = byId.get(id)
    if (!c) break
    path.unshift({ id: c.id, name: c.name })
    id = parentOf.get(id) ?? null
  }
  return path
}
