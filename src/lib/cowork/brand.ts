// Cowork brand overlay.
//
// The fork keeps every code identifier (`codeg-server`, `codeg_token`, the
// `codeg-*` WebSocket subprotocols, …) untouched and only swaps the
// user-visible product name. Message catalogs are rewritten when loaded (see
// `i18n/messages.ts`) so the upstream JSON files stay byte-identical and
// rebases onto new upstream releases don't conflict on translations.
//
// This fork (jenny's p-codeg) already renamed the upstream "Codeg" to
// "dodoer" in its sources and catalogs, so the overlay swaps both spellings.
// Build with NEXT_PUBLIC_PRODUCT_NAME=dodoer to get the source name back
// (the overlay is then off), or =Codeg for the upstream name.

import type { AbstractIntlMessages } from "next-intl"

/** The name the upstream project uses. */
export const UPSTREAM_PRODUCT_NAME = "Codeg"
/** The name this fork's sources and message catalogs carry. */
export const SOURCE_PRODUCT_NAME = "dodoer"

export function resolveProductName(configured?: string): string {
  return configured?.trim() || "Cowork"
}

export const PRODUCT_NAME = resolveProductName(
  process.env.NEXT_PUBLIC_PRODUCT_NAME
)

/** A Cowork build (the overlay is on); false for a source-named build. */
export const COWORK_BUILD = PRODUCT_NAME !== SOURCE_PRODUCT_NAME

const UPSTREAM_NAME_RE = /\bCodeg\b/g

/**
 * The fork's own spelling, "dodoer" / "Dodoer", as a word: not inside an
 * identifier such as `dodoer-managed` or `dodoer_x`, and not a path segment.
 */
const SOURCE_NAME_RE = /(?<![-\w./~`$@:\\])[Dd]odoer(?![-\w/~`:\\]|\.\w)/g

/**
 * Lower-case "codeg" used as the product name in prose ("every codeg window",
 * "codeg's server"), but not as part of a path, binary, config key or flag:
 * no neighbouring `-` `_` `/` `~` `` ` `` `:` `\\` `"` or word character, and
 * no `.` before it or `.x` after it (`~/.codeg`, `codeg.db`, `codeg-mcp`,
 * `[providers.codeg]`). A sentence-ending "codeg." still counts as prose.
 */
const PROSE_NAME_RE = /(?<![-\w./~`$@:\\"])codeg(?![-\w/~`:\\"]|\.\w)/g

/** Replace the upstream product name in a user-visible string. */
export function brandText(text: string, name: string = PRODUCT_NAME): string {
  if (name === SOURCE_PRODUCT_NAME) return text
  // Inline code spans (`codeg serve`) are commands, not prose: leave them.
  return text
    .replace(UPSTREAM_NAME_RE, name)
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(SOURCE_NAME_RE, name).replace(PROSE_NAME_RE, name)
    )
    .join("")
}

/**
 * Deep-copy a message catalog with the product name swapped: the fork's
 * "dodoer", the capitalised word "Codeg" and prose "codeg" (see
 * {@link brandText}). Paths, binary names and config keys (`~/.codeg`,
 * `codeg-mcp`, `dodoer-managed`) stay as they are.
 *
 * The catalogs the app imports are precompiled (`precompile: true` in
 * `next.config.ts`): a message with arguments, plurals or tags is not a
 * string but an icu-minify array such as `["Hello ", ["name"], "!"]`. Only
 * its literal text is rewritten; the arrays stay arrays (copying them as
 * objects made every such message fail with "e is not iterable" and show
 * its key) and argument, tag and option names are kept.
 */
export function brandMessages<T extends AbstractIntlMessages>(
  messages: T,
  name: string = PRODUCT_NAME
): T {
  if (name === SOURCE_PRODUCT_NAME) return messages
  // A compiled message or plural/select branch: literals, `#` (0) and nodes.
  const part = (p: unknown): unknown =>
    typeof p === "string"
      ? brandText(p, name)
      : Array.isArray(p)
        ? compiledNode(p)
        : p
  const compiled = (m: unknown): unknown =>
    Array.isArray(m) ? m.map(part) : part(m)
  // `[arg]`, `[tag, ...children]`, `[arg, 1-3 select/plural, {options}]` or
  // `[arg, 4-6 number/date/time, style?]` (icu-minify's format).
  const compiledNode = ([nodeName, type, ...rest]: unknown[]): unknown[] => {
    if (type === undefined) return [nodeName]
    if (typeof type !== "number" || type === 0)
      return [nodeName, part(type), ...rest.map(part)]
    if (type > 3) return [nodeName, type, ...rest]
    const options: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rest[0] as object))
      options[key] = compiled(value)
    return [nodeName, type, options]
  }
  const walk = (node: unknown): unknown => {
    if (typeof node === "string" || Array.isArray(node)) return compiled(node)
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node)) out[key] = walk(value)
      return out
    }
    return node
  }
  return walk(messages) as T
}

/** `document.title` helper: "<page> - Cowork", or just the product name. */
export function brandTitle(page?: string | null): string {
  return page ? `${page} - ${PRODUCT_NAME}` : PRODUCT_NAME
}
