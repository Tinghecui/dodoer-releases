/**
 * jenny fork: the conversation mind map's data — per project (a root folder),
 * a tree of categories with a classification rule each, and which category
 * every conversation sits in. Mirrors `src-tauri/src/taxonomy/model.rs`.
 *
 * The tree's shape (nodes and rules) only changes at night, when the Codex
 * automation reorganizes the project through `codeg-cli taxonomy`. During the
 * day Jev places each new conversation into one of the existing categories,
 * and the user may move a conversation by hand.
 */

/** Who placed a conversation: the nightly reorganization, Jev when the
 *  conversation started, or the user. */
export type TaxonomySource = "nightly" | "jev" | "manual"

export interface TaxonomyCategory {
  id: string
  /** Parent category, or null for a top-level branch. */
  parent_id: string | null
  name: string
  /** What belongs here, in words Jev and the nightly agent both read. */
  rule: string
}

export interface TaxonomyAssignment {
  /** Null: the user took the conversation out of every category (source
   *  `manual`). The nightly run and Jev leave it out. */
  category_id: string | null
  source: TaxonomySource
  /** Jev's confidence in its choice (0–1); null for the other sources. */
  confidence: number | null
  assigned_at: string
}

export interface ConversationTaxonomy {
  folder_id: number
  /** Bumped on every write; a client keeps the highest it has seen. */
  revision: number
  categories: TaxonomyCategory[]
  /** Keyed by conversation id (a JSON object key, so a string). */
  assignments: Record<string, TaxonomyAssignment>
  /** When the nightly reorganization last applied a plan, and what it said
   *  it changed. Null until the first one. */
  reorganized_at: string | null
  reorganize_summary: string | null
}

/** Payload of `conversation-taxonomy://changed`. */
export interface ConversationTaxonomyChangedEvent {
  folder_id: number
  revision: number
}

export const CONVERSATION_TAXONOMY_CHANGED_EVENT =
  "conversation-taxonomy://changed"

/** The branch that holds every conversation without a (live) category. Not a
 *  real category: it has no rule, and nothing can be moved INTO it except by
 *  clearing a conversation's assignment. */
export const UNCLASSIFIED_CATEGORY_ID = "__unclassified__"

/** The folded branch at the end of the map that holds the conversations that
 *  would open empty (their session file is gone), whatever their category.
 *  Not a real category either, and folded unless the user opens it. */
export const UNOPENABLE_CATEGORY_ID = "__unopenable__"
