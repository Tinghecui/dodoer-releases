#!/usr/bin/env node
// 接口约定：网页端、桌面 app 的远端窗口、老版本桌面 app 经 HTTP 调 codeg-server 的接口清单，
// 存在 src-tauri/src/web/api-contract.json。前后端常由不同的 PR 改，接口名对不上要到真机上才发现，
// 所以清单由两边的测试一起守着，哪边改了没跟上另一边就红：
//
//   - src/lib/transport/api-contract.test.ts（vitest）：用这里的函数从源码里重新抽一遍，和清单逐条比——
//     server 挂了哪些路由（router.rs 和它 merge 进来的）、前端（src/）调了哪些、前端调的 server 都有。
//   - src-tauri/src/web/router.rs 的 tests（Rust）：对真正建出来的 router 逐条请求清单上的路由，确认都挂着
//     （源码抽错了、路由被 cfg 去掉了、改了名，这里会红）。错误码和 HTTP 状态在 web/handlers/error.rs 的 tests。
//
// 改了路由或前端的调用之后：
//
//   node scripts/api-contract.mjs          重写清单，打印这次清单变了什么、该想想的事（API_VERSION 等）
//   node scripts/api-contract.mjs --check  只比较，不写（和 vitest 查的一样）
//
// 清单里 routes 的值是「谁调它」：web = 本仓库的前端在调（抽出来的，不用手写）；不是前端调的写明调用方
// （codeg-cli、forge 的 webhook、桌面 app 的 Rust 代码、老版本桌面 app……），新出现的写成 "?"，要人填上。
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..")
export const CONTRACT_FILE = "src-tauri/src/web/api-contract.json"
const RUST_SRC = "src-tauri/src"
const ROUTER_FILE = "src-tauri/src/web/router.rs"
const ROUTER_FN = "build_router_with_proxy_auth"
/** Routes the frontend calls are marked with this; anything else names who calls it. */
export const WEB = "web"
/** A route nobody has said the caller of yet. */
export const UNKNOWN_CALLER = "?"
/** Transports that pass on a command they were given; their `call(command)` is not a call site. */
export const FORWARDERS = ["src/lib/transport/local-daemon-transport.ts"]

const read = (root, rel) => readFileSync(join(root, rel), "utf8")

// ─── Rust: a small scanner, enough for router code ─────────────────────────

/** Index just past the string / char literal starting at `i`, or -1. */
function skipRustLiteral(src, i) {
  const c = src[i]
  // r"…", r#"…"#, br"…" (sticky: matched at `i` only)
  const raw = /b?r(#*)"/y
  raw.lastIndex = i
  const r = raw.exec(src)
  if (r && (i === 0 || !/[\w]/.test(src[i - 1]))) {
    const close = `"${r[1]}`
    const end = src.indexOf(close, i + r[0].length)
    return end < 0 ? src.length : end + close.length
  }
  if (
    c === '"' ||
    (c === "b" && src[i + 1] === '"' && !/\w/.test(src[i - 1] ?? ""))
  ) {
    let j = c === "b" ? i + 2 : i + 1
    while (j < src.length && src[j] !== '"') j += src[j] === "\\" ? 2 : 1
    return j + 1
  }
  if (c === "'") {
    // '.' / '\n' / '\'' are chars; 'a in `&'a str` is a lifetime.
    if (src[i + 1] === "\\") {
      const end = src.indexOf("'", i + 3)
      return end < 0 ? -1 : end + 1
    }
    if (src[i + 2] === "'") return i + 3
  }
  return -1
}

/** The source with comments blanked out (same length, so offsets hold). */
export function stripRustComments(src) {
  let out = ""
  let i = 0
  while (i < src.length) {
    const end = skipRustLiteral(src, i)
    if (end > i) {
      out += src.slice(i, end)
      i = end
    } else if (src.startsWith("//", i)) {
      const nl = src.indexOf("\n", i)
      const stop = nl < 0 ? src.length : nl
      out += " ".repeat(stop - i)
      i = stop
    } else if (src.startsWith("/*", i)) {
      let depth = 0
      let j = i
      do {
        if (src.startsWith("/*", j)) {
          depth++
          j += 2
        } else if (src.startsWith("*/", j)) {
          depth--
          j += 2
        } else j++
      } while (depth > 0 && j < src.length)
      out += src.slice(i, j).replace(/[^\n]/g, " ")
      i = j
    } else {
      out += src[i]
      i++
    }
  }
  return out
}

const OPEN = { "(": ")", "[": "]", "{": "}" }

/** Index of the bracket closing the one at `open`. */
function closing(src, open) {
  const stack = []
  for (let i = open; i < src.length; i++) {
    const end = skipRustLiteral(src, i)
    if (end > i) {
      i = end - 1
      continue
    }
    const c = src[i]
    if (OPEN[c]) stack.push(OPEN[c])
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) throw new Error(`unbalanced ${c} at ${i}`)
      if (stack.length === 0) return i
    }
  }
  throw new Error(`unclosed bracket at ${open}`)
}

/** Split `text` at the top-level occurrences of `sep` (a single char). */
function splitTop(text, sep) {
  const parts = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const end = skipRustLiteral(text, i)
    if (end > i) {
      i = end - 1
      continue
    }
    if (OPEN[text[i]]) i = closing(text, i)
    else if (text[i] === sep) {
      parts.push(text.slice(start, i))
      start = i + 1
    }
  }
  parts.push(text.slice(start))
  return parts.map((p) => p.trim()).filter(Boolean)
}

/**
 * `a::b::c(x).d(y).e::<T>(z)` → { head: "a::b::c", headArgs: "x", calls: [["d","y"],["e","z"]] }.
 * `head` is a path; `headArgs` is null when the head is not called.
 */
function parseChain(expr) {
  const m = /^[A-Za-z_][\w]*(?:::[A-Za-z_][\w]*)*/.exec(expr)
  if (!m) return null
  let i = m[0].length
  let headArgs = null
  if (expr[i] === "(") {
    const end = closing(expr, i)
    headArgs = expr.slice(i + 1, end)
    i = end + 1
  }
  const calls = []
  const step = /\s*\.\s*([A-Za-z_]\w*)\s*(?:::\s*<[^()]*>)?\s*\(/y
  for (;;) {
    step.lastIndex = i
    const s = step.exec(expr)
    if (!s) break
    const open = step.lastIndex - 1
    const end = closing(expr, open)
    calls.push([s[1], expr.slice(open + 1, end)])
    i = end + 1
  }
  return { head: m[0], headArgs, calls, rest: expr.slice(i).trim() }
}

/** `src-tauri/src/web/router.rs` → ["web", "router"]; `…/mod.rs` → its directory. */
function modulePathOf(rel) {
  const parts = relative(RUST_SRC, rel).replace(/\.rs$/, "").split("/")
  if (parts.at(-1) === "mod" || parts.at(-1) === "lib") parts.pop()
  return parts
}

/** The file of module `crate::a::b` (["a", "b"]). */
function moduleFile(root, segments) {
  for (const candidate of [
    `${RUST_SRC}/${segments.join("/")}.rs`,
    `${RUST_SRC}/${segments.join("/")}/mod.rs`,
  ]) {
    try {
      if (statSync(join(root, candidate)).isFile()) return candidate
    } catch {
      // try the next one
    }
  }
  throw new Error(`no file for module crate::${segments.join("::")}`)
}

/** Resolve `crate::a::b::NAME` / `super::NAME` / `NAME` seen in `file` to [moduleFile, NAME]. */
function resolveItem(root, file, path) {
  const segments = path.split("::")
  const name = segments.pop()
  let mod
  if (segments[0] === "crate") mod = segments.slice(1)
  else {
    mod = modulePathOf(file)
    for (const s of segments) {
      if (s === "super") mod = mod.slice(0, -1)
      else if (s !== "self") mod = [...mod, s]
    }
  }
  return [segments.length === 0 ? file : moduleFile(root, mod), name]
}

function rustSource(root, file, cache) {
  if (!cache.has(file)) cache.set(file, stripRustComments(read(root, file)))
  return cache.get(file)
}

/** The value of `const NAME: &str = "…";` that `path` names, from `file`. */
function rustStrConst(root, file, path, cache) {
  const [target, name] = resolveItem(root, file, path)
  const m = new RegExp(`\\bconst ${name}: &str = "([^"]*)";`).exec(
    rustSource(root, target, cache)
  )
  if (!m) throw new Error(`${path} (from ${file}): no \`const ${name}: &str\``)
  return m[1]
}

/** The body (between the braces) of `fn name(` in `file`. */
function rustFnBody(root, file, name, cache) {
  const src = rustSource(root, file, cache)
  const m = new RegExp(`\\bfn ${name}\\s*[<(]`).exec(src)
  if (!m) throw new Error(`${file}: no fn ${name}`)
  const open = src.indexOf("{", m.index)
  return src.slice(open + 1, closing(src, open))
}

const METHODS = new Set(["get", "post", "put", "delete", "patch", "any"])

function routeMethods(expr, where) {
  const chain = parseChain(expr)
  const head = chain?.head.split("::").pop()
  if (!chain || !METHODS.has(head) || chain.headArgs === null)
    throw new Error(`${where}: can't read the method of \`${expr}\``)
  const methods = [head]
  for (const [name] of chain.calls) if (METHODS.has(name)) methods.push(name)
  return methods.map((m) => m.toUpperCase())
}

function routePath(root, file, expr, cache) {
  const literal = /^"([^"]*)"$/.exec(expr)
  if (literal) return literal[1]
  if (/^[\w:]+$/.test(expr)) return rustStrConst(root, file, expr, cache)
  throw new Error(`${file}: can't read the route path \`${expr}\``)
}

/**
 * The routes a router expression builds, as ["METHOD", "/path"] pairs.
 * Follows `.route`, `.merge` and `.nest` into local variables (`env`) and into
 * functions elsewhere in the crate that return a `Router`.
 */
function routerRoutes(root, file, expr, env, cache) {
  const chain = parseChain(expr)
  if (!chain) throw new Error(`${file}: can't read the router \`${expr}\``)
  let routes
  if (chain.head === "Router::new" && chain.headArgs !== null) routes = []
  else if (chain.headArgs === null && env.has(chain.head))
    routes = [...env.get(chain.head)]
  else if (chain.headArgs !== null) {
    const [target, name] = resolveItem(root, file, chain.head)
    routes = routerFnRoutes(root, target, name, cache)
  } else throw new Error(`${file}: unknown router \`${chain.head}\``)
  if (chain.rest)
    throw new Error(
      `${file}: can't read \`${chain.rest.slice(0, 60)}\` after a router`
    )
  for (const [call, args] of chain.calls) {
    if (call === "route") {
      const [path, method] = splitTop(args, ",")
      for (const m of routeMethods(method, file))
        routes.push([m, routePath(root, file, path, cache)])
    } else if (call === "merge") {
      routes.push(...routerRoutes(root, file, args, env, cache))
    } else if (call === "nest") {
      const [prefix, inner] = splitTop(args, ",")
      const at = routePath(root, file, prefix, cache)
      for (const [m, p] of routerRoutes(root, file, inner, env, cache))
        routes.push([m, at + p])
    } else if (call === "route_service" || call === "nest_service") {
      throw new Error(
        `${file}: .${call}(…) is not read yet; teach scripts/api-contract.mjs`
      )
    }
    // .layer, .fallback, .with_state, … don't add routes.
  }
  return routes
}

/** The routes of the `Router` that `fn name` in `file` returns. */
function routerFnRoutes(root, file, name, cache) {
  const statements = splitTop(rustFnBody(root, file, name, cache), ";")
  const env = new Map()
  let tail = null
  for (const statement of statements) {
    const binding =
      /^let\s+(?:mut\s+)?(\w+)\s*(?::\s*[\w:<>]+\s*)?=\s*([\s\S]*)$/.exec(
        statement
      )
    const expr = binding ? binding[2] : statement
    const chain = parseChain(expr)
    const isRouter =
      chain &&
      ((chain.head === "Router::new" && chain.headArgs !== null) ||
        (chain.headArgs === null && env.has(chain.head)))
    if (binding && isRouter)
      env.set(binding[1], routerRoutes(root, file, expr, env, cache))
    else if (binding && env.has(binding[1]))
      // `let api = if … { api.route(…) } else { api }`: not read; say so
      // rather than keep the old routes under the name.
      throw new Error(`${file}: can't read how \`${binding[1]}\` is rebuilt`)
    else if (!binding) tail = statement
  }
  if (tail === null)
    throw new Error(`${file}: fn ${name} has no tail expression`)
  return routerRoutes(root, file, tail, env, cache)
}

/** Every route the server's router serves: "METHOD /path" (sorted, unique). */
export function serverRoutes(root = ROOT) {
  const routes = routerFnRoutes(root, ROUTER_FILE, ROUTER_FN, new Map())
  return [...new Set(routes.map(([m, p]) => `${m} ${p}`))].sort(compareRoutes)
}

/** The app's Tauri commands (`generate_handler![…]` in lib.rs). */
export function tauriCommands(root = ROOT) {
  const lib = stripRustComments(read(root, `${RUST_SRC}/lib.rs`))
  const start = lib.indexOf("generate_handler![")
  if (start < 0) throw new Error("lib.rs: no generate_handler![")
  const open = lib.indexOf("[", start)
  const body = lib
    .slice(open + 1, closing(lib, open))
    .replace(/#\[[^\]]*\]/g, "")
  return new Set(
    body
      .split(",")
      .map((entry) => entry.trim().split("::").pop())
      .filter(Boolean)
  )
}

/** `API_VERSION` in compat.rs. */
export function apiVersion(root = ROOT) {
  const m = /pub const API_VERSION: u32 = (\d+);/.exec(
    read(root, `${RUST_SRC}/compat.rs`)
  )
  if (!m) throw new Error("compat.rs: no API_VERSION")
  return Number(m[1])
}

// ─── Frontend ───────────────────────────────────────────────────────────────

const COMMAND_NAME = /^[a-z][a-z0-9_]*$/
/** Receivers of `.call(…)` that are a transport (`getTransport()`, `shell`, …). */
const TRANSPORT_RECEIVER = /transport|shell|daemon/i

function frontendFiles(root) {
  const out = []
  const walk = (dir) => {
    for (const name of readdirSync(join(root, dir))) {
      const rel = `${dir}/${name}`
      if (statSync(join(root, rel)).isDirectory()) {
        if (name !== "__tests__" && name !== "node_modules") walk(rel)
      } else if (
        /\.(ts|tsx)$/.test(name) &&
        !/\.(test|spec)\.tsx?$/.test(name) &&
        !name.endsWith(".d.ts") &&
        name !== "test-setup.ts"
      )
        out.push(rel)
    }
  }
  walk("src")
  return out.sort()
}

/** A string or template literal with each `${…}` as `${name}` (or `${}`). */
function literalText(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text
    for (const span of node.templateSpans) {
      text += `\${${ts.isIdentifier(span.expression) ? span.expression.text : ""}}`
      text += span.literal.text
    }
    return text
  }
  return null
}

/**
 * What the frontend calls over HTTP:
 * - `commands`: names given to a transport's `call(…)` (or to a function that
 *   builds `/api/${name}` itself), each POST /api/<name>;
 * - `paths`: other `/api/…` and `/ws/…` URLs written out in a literal
 *   (`${…}` kept as `${name}`);
 * - `dynamic`: `call(…)` sites whose command name can't be read here.
 * Each maps to the places ("file:line") it comes from.
 */
export function frontendCalls(root = ROOT) {
  const commands = new Map()
  const paths = new Map()
  const dynamic = []
  const parsed = []
  const consts = new Map()
  const add = (map, key, where) =>
    map.set(key, [...(map.get(key) ?? []), where])

  for (const file of frontendFiles(root)) {
    const text = read(root, file)
    if (!/\.call\b|\/api\/|\/ws\/|_COMMAND\b/.test(text)) continue
    const sf = ts.createSourceFile(
      file,
      text,
      ts.ScriptTarget.Latest,
      true,
      file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS
    )
    parsed.push(sf)
    // `const NAME = "literal"` anywhere: command names passed by constant.
    const collect = (node) => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer &&
        ts.isStringLiteral(node.initializer)
      )
        add(consts, node.name.text, node.initializer.text)
      ts.forEachChild(node, collect)
    }
    collect(sf)
  }
  const constValue = (name) => {
    const values = [...new Set(consts.get(name) ?? [])]
    return values.length === 1 ? values[0] : null
  }

  for (const sf of parsed) {
    const where = (node) =>
      `${sf.fileName}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`
    // Functions that put one of their parameters after `/api/` themselves.
    const wrappers = new Map()
    const findWrappers = (node) => {
      const text = literalText(node)
      const m = text && /\/api\/\$\{(\w+)\}/.exec(text)
      if (m) {
        let fn = node.parent
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent
        const index = fn?.parameters.findIndex(
          (p) => ts.isIdentifier(p.name) && p.name.text === m[1]
        )
        const name =
          fn &&
          (ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
          fn.name
            ? fn.name.getText(sf)
            : null
        // A transport's own `call(command)` is read at its call sites below.
        if (name && name !== "call" && index >= 0) wrappers.set(name, index)
      }
      ts.forEachChild(node, findWrappers)
    }
    findWrappers(sf)

    const visit = (node) => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression
        const viaCall =
          ts.isPropertyAccessExpression(callee) && callee.name.text === "call"
        const wrapper =
          ts.isIdentifier(callee) && wrappers.has(callee.text)
            ? wrappers.get(callee.text)
            : null
        const arg = viaCall
          ? node.arguments[0]
          : wrapper !== null
            ? node.arguments[wrapper]
            : null
        // `fn.call(thisArg, …)` is everywhere; only a transport's names a command.
        const transport =
          wrapper !== null ||
          (viaCall && TRANSPORT_RECEIVER.test(callee.expression.getText(sf)))
        if (
          arg &&
          (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))
        ) {
          if (COMMAND_NAME.test(arg.text)) add(commands, arg.text, where(node))
        } else if (arg && transport) {
          const name = ts.isIdentifier(arg) ? constValue(arg.text) : null
          if (name !== null && COMMAND_NAME.test(name))
            add(commands, name, where(node))
          else dynamic.push(`${where(node)} ${node.getText(sf).split("\n")[0]}`)
        }
      }
      const text = literalText(node)
      if (text) {
        // Not `@tauri-apps/api/…`, not `https://forge/api/v4/…`: this origin's own.
        for (const m of text.matchAll(
          /(?<![\w@.-])(\/api\/|\/ws\/)([^\s"'`?#]*)/g
        )) {
          const rest = m[2].replace(
            /\$\{(\w+)\}/g,
            (all, id) => constValue(id) ?? all
          )
          // `/api/${command}` alone is a transport's own `call`, read above.
          if (rest === "" || /^\$\{\w*\}$/.test(rest)) continue
          add(paths, m[1] + rest, where(node))
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  return { commands, paths, dynamic: dynamic.sort() }
}

// ─── The contract ───────────────────────────────────────────────────────────

/** Order routes by path, then method. */
export function compareRoutes(a, b) {
  const [ma, pa] = a.split(" ")
  const [mb, pb] = b.split(" ")
  return pa < pb ? -1 : pa > pb ? 1 : ma < mb ? -1 : ma > mb ? 1 : 0
}

/** Whether a frontend URL (`${…}` placeholders) is served by route path `pattern`. */
export function pathMatches(pattern, url) {
  const re = new RegExp(
    `^${pattern
      .split(/(\{\*?\w+\})/)
      .map((part) =>
        /^\{\*\w+\}$/.test(part)
          ? ".+"
          : /^\{\w+\}$/.test(part)
            ? "[^/]+"
            : part.replace(/[.*+?^$()|[\]\\]/g, "\\$&")
      )
      .join("")}$`
  )
  const sample = url.replace(/\$\{\w*\}/g, "x")
  return re.test(sample) || (sample.endsWith("/") && re.test(`${sample}x`))
}

export function readContract(root = ROOT) {
  return JSON.parse(read(root, CONTRACT_FILE))
}

/**
 * The contract the sources say, given the current one (whose callers of
 * non-web routes, error codes and notes carry over), and what doesn't fit.
 */
export function buildContract(root = ROOT, previous = readContract(root)) {
  const routes = serverRoutes(root)
  const front = frontendCalls(root)
  const tauri = tauriCommands(root)
  const problems = []
  const webRoutes = new Set()

  for (const [command, places] of front.commands) {
    const route = `POST /api/${command}`
    if (routes.includes(route)) webRoutes.add(route)
    else if (routes.some((r) => r.endsWith(` /api/${command}`)))
      problems.push(
        `前端经 transport 调 ${command}（${places[0]}），transport 发的是 POST，server 上它不是`
      )
    else if (!tauri.has(command))
      problems.push(
        `前端调 ${command}（${places[0]}），server 没有 ${route}，桌面 app 也没有这条 Tauri 命令：名字对不上，或者另一边的 PR 还没合`
      )
    // else: only the app has it (`SHELL_ONLY_COMMANDS`); not an HTTP route.
  }
  for (const site of front.dynamic) {
    if (!FORWARDERS.some((file) => site.startsWith(`${file}:`)))
      problems.push(
        `读不出命令名：${site}。清单看不见它调的接口，命令名写成字面量或 const 字符串`
      )
  }
  for (const [url, places] of front.paths) {
    const prefix = url.startsWith("/ws/") ? "" : "/api"
    const local = url.startsWith("/ws/") ? url : url.slice("/api".length)
    const hits = routes.filter((r) =>
      pathMatches(r.split(" ")[1], prefix + local)
    )
    if (hits.length === 0)
      problems.push(`前端用了 ${url}（${places[0]}），server 没有这个路由`)
    for (const hit of hits) webRoutes.add(hit)
  }

  const callers = {}
  for (const route of routes) {
    const before = previous.routes?.[route]
    callers[route] = webRoutes.has(route)
      ? WEB
      : before && before !== WEB
        ? before
        : UNKNOWN_CALLER
  }
  const contract = {
    _readme: previous._readme,
    apiVersion: apiVersion(root),
    errorCodes: previous.errorCodes,
    routes: callers,
  }
  return { contract, problems }
}

/** `a、b、c`, at most `max` of them. */
function list(items, max = 12) {
  const shown = items.slice(0, max).join("、")
  return items.length > max ? `${shown} …共 ${items.length} 条` : shown
}

/** What changed between two contracts, in words, with what to think about. */
export function describeChange(before, after) {
  const notes = []
  const b = before.routes ?? {}
  const a = after.routes ?? {}
  const added = Object.keys(a).filter((r) => !(r in b))
  const removed = Object.keys(b).filter((r) => !(r in a))
  const nowWeb = Object.keys(a).filter(
    (r) => a[r] === WEB && b[r] !== undefined && b[r] !== WEB
  )
  const noLongerWeb = Object.keys(a).filter((r) => b[r] === WEB && a[r] !== WEB)
  const newWeb = added.filter((r) => a[r] === WEB)
  if (added.length) notes.push(`新路由：${list(added)}`)
  if (removed.length)
    notes.push(
      `去掉的路由：${list(removed)}。` +
        (removed.some((r) => b[r] === WEB)
          ? "其中有前端调过的：已经发出去的桌面 app（远端窗口用的是 app 自带的前端）还会调它，" +
            "要么留着（src-tauri/src/legacy_client.rs），要么调高 MIN_DESKTOP_VERSION（compat.rs）"
          : "")
    )
  if (newWeb.length || nowWeb.length)
    notes.push(
      `前端新调的：${list([...newWeb, ...nowWeb])}。老 server 没有它：` +
        "前端在日常流程里不先查就调的，要升 API_VERSION（compat.rs、src/lib/cowork/compat.ts 的 " +
        "CLIENT_API_VERSION / MIN_SERVER_API_VERSION）；只在一个入口后面的，加一个 FEATURES 让前端先查（serverHasFeature）"
    )
  if (noLongerWeb.length)
    notes.push(
      `前端不再调的：${list(noLongerWeb)}。路由先别删，老桌面 app 还在调；在 ${CONTRACT_FILE} 里写明谁还调它`
    )
  if (before.apiVersion !== after.apiVersion)
    notes.push(`API_VERSION ${before.apiVersion} → ${after.apiVersion}`)
  return notes
}

export function formatContract(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`
}

function main(argv) {
  const check = argv.includes("--check")
  const before = readContract()
  const { contract, problems } = buildContract(ROOT, before)
  const unknown = Object.entries(contract.routes)
    .filter(([, caller]) => caller === UNKNOWN_CALLER)
    .map(([route]) => route)
  const changed = formatContract(contract) !== read(ROOT, CONTRACT_FILE)
  for (const note of describeChange(before, contract)) console.log(`- ${note}`)
  if (unknown.length)
    console.log(
      `这些路由前端不调，写明谁调它（${CONTRACT_FILE} 里的 "${UNKNOWN_CALLER}"）：\n  ${unknown.join("\n  ")}`
    )
  for (const problem of problems) console.error(`✗ ${problem}`)
  if (check) {
    if (changed)
      console.error(
        `✗ ${CONTRACT_FILE} 和源码不一致：跑 node scripts/api-contract.mjs`
      )
    process.exitCode = changed || problems.length || unknown.length ? 1 : 0
    return
  }
  if (changed) {
    writeFileSync(join(ROOT, CONTRACT_FILE), formatContract(contract))
    console.log(`已写 ${CONTRACT_FILE}`)
  } else console.log(`${CONTRACT_FILE} 没变`)
  process.exitCode = problems.length || unknown.length ? 1 : 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1])
  main(process.argv.slice(2))
