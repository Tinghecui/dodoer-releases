/**
 * Readable names for the worktrees a conversation opens for itself. A random
 * `adjective-animal` pair (`tidy-fox`) is easier to tell apart in a sidebar
 * and in `git worktree list` than the old `cv-main-x7k2p9` random tail, and
 * it never leaks the base branch into the new branch's name.
 */

const ADJECTIVES = [
  "agile",
  "bold",
  "brave",
  "bright",
  "calm",
  "clever",
  "crisp",
  "eager",
  "fair",
  "fleet",
  "fresh",
  "gentle",
  "glad",
  "happy",
  "jolly",
  "keen",
  "kind",
  "lively",
  "lucky",
  "merry",
  "neat",
  "nimble",
  "plucky",
  "proud",
  "quick",
  "quiet",
  "sharp",
  "snug",
  "steady",
  "sunny",
  "swift",
  "tidy",
  "warm",
  "wise",
  "witty",
  "zesty",
] as const

const ANIMALS = [
  "badger",
  "bear",
  "bison",
  "crane",
  "deer",
  "dove",
  "eagle",
  "egret",
  "falcon",
  "finch",
  "fox",
  "gecko",
  "hare",
  "heron",
  "ibis",
  "koala",
  "lark",
  "lemur",
  "lynx",
  "mole",
  "moose",
  "newt",
  "otter",
  "owl",
  "panda",
  "quail",
  "raven",
  "robin",
  "seal",
  "sparrow",
  "stork",
  "swan",
  "tapir",
  "wolf",
  "wren",
  "yak",
] as const

function pick<T>(items: readonly T[]): T {
  return items[Math.floor(Math.random() * items.length)]
}

/** `tidy-fox` — one path component, safe for a branch and a directory. */
export function randomWorktreeSlug(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`
}

/** Prefix of every conversation-worktree branch named by us. */
export const CONVERSATION_BRANCH_PREFIX = "cv/"

/** The default branch name for a conversation's new worktree. */
export function defaultConversationBranch(): string {
  return `${CONVERSATION_BRANCH_PREFIX}${randomWorktreeSlug()}`
}
