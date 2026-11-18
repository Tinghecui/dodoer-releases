// Brand overlay.
//
// The fork keeps every code identifier (`codeg-server`, `codeg_token`, the
// `codeg-*` WebSocket subprotocols, …) untouched and only swaps the
// user-visible product name. Message catalogs are rewritten when loaded (see
// `i18n/messages.ts`) so the upstream JSON files stay byte-identical and
// rebases onto new upstream releases don't conflict on translations.
//
// This fork (jenny's p-codeg) already renamed the upstream "Codeg" to
// "dodoer" in its sources and catalogs, and the server build used to call
// itself "Cowork"; the overlay swaps all of them for the one display name,
// CoTeam, in every build (2026-11-18, `.cowork/journal/2026-11-18-coteam-display-name.md`).
//
// NEXT_PUBLIC_PRODUCT_NAME no longer names the product: it only tells the
// builds apart. The desktop package is built with =dodoer (not a Cowork
// build), the server's web build leaves it unset (a Cowork build).

import type { AbstractIntlMessages } from "next-intl"

/** The name the upstream project uses. */
export const UPSTREAM_PRODUCT_NAME = "Codeg"
/** The name this fork's sources and message catalogs carry. */
export const SOURCE_PRODUCT_NAME = "dodoer"
/** The name the server build used to show. */
export const COWORK_PRODUCT_NAME = "Cowork"
/** 界面上唯一的产品名，两种构建都一样。 */
export const DISPLAY_NAME = "CoTeam"

/** 界面、标签页标题、导出的对话里显示的产品名。 */
export const PRODUCT_NAME = DISPLAY_NAME

/**
 * 是不是 Cowork 构建：只看 NEXT_PUBLIC_PRODUCT_NAME 是不是 `dodoer`（桌面包）。
 * 和原来 `(configured?.trim() || "Cowork") !== "dodoer"` 的取值一样。
 */
export function isCoworkBuild(configured?: string): boolean {
  return configured?.trim() !== SOURCE_PRODUCT_NAME
}

/** A Cowork build (the server's web build); false for the desktop package. */
export const COWORK_BUILD = isCoworkBuild(process.env.NEXT_PUBLIC_PRODUCT_NAME)

// 名字后面可以紧跟一个 s：德语的所有格（"dodoers Fenster" = dodoer 的窗口），
// 也是产品名，换成 "CoTeams"（捕获组 1 是这个 s）。
// 大写的 "Codeg" 和下面几条一样不碰路径、命令和标识符（`/opt/Codeg/bin`、
// `Codeg-x`、`Codeg.app`），反引号里的也不换（见 brandTextAs）。
const UPSTREAM_NAME_RE = /(?<![-\w./~`$@:\\])Codeg(s?)(?![-\w/~`:\\]|\.\w)/g

/**
 * The fork's own spelling, "dodoer" / "Dodoer", as a word: not inside an
 * identifier such as `dodoer-managed` or `dodoer_x`, and not a path segment.
 */
const SOURCE_NAME_RE = /(?<![-\w./~`$@:\\])[Dd]odoer(s?)(?![-\w/~`:\\]|\.\w)/g

/**
 * Lower-case "codeg" used as the product name in prose ("every codeg window",
 * "codeg's server"), but not as part of a path, binary, config key or flag:
 * no neighbouring `-` `_` `/` `~` `` ` `` `:` `\\` `"` or word character, and
 * no `.` before it or `.x` after it (`~/.codeg`, `codeg.db`, `codeg-mcp`,
 * `[providers.codeg]`). A sentence-ending "codeg." still counts as prose.
 */
const PROSE_NAME_RE = /(?<![-\w./~`$@:\\"])codeg(s?)(?![-\w/~`:\\"]|\.\w)/g

/**
 * The server build's old name "Cowork" as a word, written like
 * {@link SOURCE_NAME_RE}: not `cowork-sso`, `COWORK_*`, `/opt/cowork` or the
 * lower-case `cowork` command (case-sensitive), nor `Cowork-x`, `Cowork_x`,
 * `Cowork/x`, `Cowork.x`.
 */
const COWORK_NAME_RE = /(?<![-\w./~`$@:\\])Cowork(s?)(?![-\w/~`:\\]|\.\w)/g

/** Replace the upstream product name in a user-visible string. */
export function brandText(text: string, name: string = PRODUCT_NAME): string {
  return brandTextAs(text, name, name)
}

// `sourceAs`：fork 自己的 "dodoer" 换成什么。一般就是显示名；指着系统里那个
// app 的句子换成「显示名 (dodoer)」，见 SYSTEM_NAME_KEYS。所有格（"dodoers"）
// 一律换成「显示名 + s」：括号夹在中间读不通，那几句里教用户去系统里找的
// 地方用的都是不带 s 的名字。
function brandTextAs(text: string, name: string, sourceAs: string): string {
  const named = (_: string, s: string) => name + s
  // Inline code spans (`codeg serve`) are commands, not prose: leave them.
  return text
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part
            .replace(UPSTREAM_NAME_RE, named)
            .replace(SOURCE_NAME_RE, (_, s: string) =>
              s ? name + s : sourceAs
            )
            .replace(PROSE_NAME_RE, named)
            .replace(COWORK_NAME_RE, named)
    )
    .join("")
}

/**
 * 消息目录里教用户去 macOS 的系统设置、应用程序文件夹里找这个 app 的句子。
 * 桌面包在系统里的名字还是 dodoer（`src-tauri/tauri*.json` 的 productName 不改），
 * 只写 CoTeam 用户会找不到，所以这几条里的 "dodoer" 换成 "CoTeam (dodoer)"。
 */
export const SYSTEM_NAME_KEYS: readonly string[] = [
  "ChromeSettings.problemFileDenied",
  "ComputerUse.codegGranted",
  "ComputerUse.permissions.why",
  "DesktopNotificationSettings.identityDegradedHint",
]

/** 系统里看到的 app 名字（桌面包的 productName）。 */
export const SYSTEM_APP_NAME = SOURCE_PRODUCT_NAME

/**
 * 后端评论末尾实际写的名字（`src-tauri/src/cowork.rs` 的 PRODUCT_NAME，
 * `forge/deliver.rs` 的 comment_footer 用它）。设置页说「每条评论末尾加上
 * “🤖 Generated with …”」，这里写的必须和真发出去的一样，不能跟着显示名走。
 * 后端改名时一起改（brand.test.ts 会拿它和 cowork.rs 对）。
 */
export const COMMENT_FOOTER_NAME = "Cowork"

/** 设置页里引用评论署名原文的那一条。 */
const COMMENT_FOOTER_KEY = "Forge.settingsCommentFooterHint"

/**
 * Deep-copy a message catalog with the product name swapped: the fork's
 * "dodoer", the capitalised word "Codeg", prose "codeg" and the word
 * "Cowork" (see
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
  // 当前这一条用哪种替换（按键的完整路径，见 walk）。
  let text = (s: string) => brandText(s, name)
  const systemAs = `${name} (${SYSTEM_APP_NAME})`
  const footerFrom = `Generated with ${name}`
  const footerTo = `Generated with ${COMMENT_FOOTER_NAME}`
  const textFor = (path: string) =>
    SYSTEM_NAME_KEYS.includes(path)
      ? (s: string) => brandTextAs(s, name, systemAs)
      : path === COMMENT_FOOTER_KEY
        ? (s: string) => brandText(s, name).split(footerFrom).join(footerTo)
        : (s: string) => brandText(s, name)
  // A compiled message or plural/select branch: literals, `#` (0) and nodes.
  const part = (p: unknown): unknown =>
    typeof p === "string" ? text(p) : Array.isArray(p) ? compiledNode(p) : p
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
  const walk = (node: unknown, path: string): unknown => {
    if (typeof node === "string" || Array.isArray(node)) {
      text = textFor(path)
      return compiled(node)
    }
    if (node && typeof node === "object") {
      const out: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(node))
        out[key] = walk(value, path ? `${path}.${key}` : key)
      return out
    }
    return node
  }
  return walk(messages, "") as T
}

/** `document.title` helper: "<page> - CoTeam", or just the product name. */
export function brandTitle(page?: string | null): string {
  return page ? `${page} - ${PRODUCT_NAME}` : PRODUCT_NAME
}
