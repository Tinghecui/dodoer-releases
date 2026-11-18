// Linux 桌面版 WebDriver 冒烟的公共部分（scripts/desktop-linux-smoke.mjs 用）：起 tauri-driver、建会话、等界面、
// 执行 JS、调 Tauri 命令、切窗口、截图、关 app。
//
// 不装 npm 依赖：W3C WebDriver 就是几个 HTTP 接口，直接用 Node 自带的 fetch。
//
//   环境：SMOKE_APP（桌面程序，默认 src-tauri/target/debug/codeg）、SMOKE_OUT（截图、日志、result.json 放哪，默认 smoke-out）、
//        TAURI_DRIVER（默认 ~/.cargo/bin/tauri-driver）
import { spawn, execFileSync } from "node:child_process"
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import process from "node:process"

export const APP = resolve(
  process.env.SMOKE_APP || "src-tauri/target/debug/codeg"
)
export const SERVER = join(dirname(APP), "codeg-server")
export const OUT = resolve(process.env.SMOKE_OUT || "smoke-out")
const DRIVER =
  process.env.TAURI_DRIVER || join(homedir(), ".cargo", "bin", "tauri-driver")
const DRIVER_PORT = 4444
const BASE = `http://127.0.0.1:${DRIVER_PORT}`

mkdirSync(OUT, { recursive: true })
// app 的数据库、日志都放这个临时目录；WebKit 自己的数据（localStorage）照旧在 XDG 目录下，每次启动是同一个
export const dataDir = mkdtempSync(join(tmpdir(), "desktop-linux-smoke-"))
export const t0 = Date.now()

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (msg) =>
  console.log(`[smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

export function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 })
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`
  }
}

// 每 intervalMs 调一次 fn，直到它返回真值（返回那个值）；到点返回 null。fn 抛错当作还没好
export async function waitFor(fn, timeoutMs = 20000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      // 还没好
    }
    if (Date.now() >= deadline) return null
    await sleep(intervalMs)
  }
}

export async function wd(method, path, body, timeoutMs = 60000) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    throw new Error(
      `${method} ${path} → ${res.status}，不是 JSON：${text.slice(0, 300)}`
    )
  }
  if (!res.ok || json?.value?.error) {
    throw new Error(
      `${method} ${path} → ${res.status} ${JSON.stringify(json.value).slice(0, 500)}`
    )
  }
  return json.value
}

let driverProc = null
let launches = 0

async function startDriver(tag, env) {
  const logFile = createWriteStream(join(OUT, `tauri-driver-${tag}.log`))
  driverProc = spawn(DRIVER, ["--port", String(DRIVER_PORT)], {
    env: { ...process.env, CODEG_DATA_DIR: dataDir, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  })
  driverProc.stdout.pipe(logFile)
  driverProc.stderr.pipe(logFile)
  driverProc.on("error", (e) => log(`tauri-driver 起不来：${e.message}`))
  const up = await waitFor(
    () => wd("GET", "/status", undefined, 2000).then(() => true),
    30000,
    300
  )
  if (!up) throw new Error("tauri-driver 30 秒内没有应答 /status")
}

export async function stopDriver() {
  if (!driverProc) return
  const p = driverProc
  driverProc = null
  p.kill("SIGTERM")
  await waitFor(() => p.exitCode !== null || p.signalCode !== null, 3000, 100)
  if (p.exitCode === null && p.signalCode === null) p.kill("SIGKILL")
}

export const pids = (name) =>
  sh("pgrep", ["-x", name])
    .split(/\s+/)
    .filter((s) => /^\d+$/.test(s))

// 等 app 进程退出；到点没退就 TERM、再 KILL，返回它是怎么没的
async function waitAppGone() {
  if (await waitFor(() => pids("codeg").length === 0, 20000)) return "自己退出"
  for (const pid of pids("codeg")) sh("kill", ["-TERM", pid])
  if (await waitFor(() => pids("codeg").length === 0, 10000))
    return "20 秒没退，SIGTERM 后退出"
  killApp()
  return "SIGTERM 也没退，SIGKILL"
}

export function killApp() {
  for (const pid of pids("codeg")) sh("kill", ["-KILL", pid])
}

export const exec = (sid, script, args = []) =>
  wd("POST", `/session/${sid}/execute/sync`, { script, args })

// 调一个 Tauri 命令（window.__TAURI_INTERNALS__.invoke），返回 { ok } 或 { err }
export const invoke = (sid, cmd, payload = {}) =>
  wd("POST", `/session/${sid}/execute/async`, {
    script: `
      const done = arguments[arguments.length - 1];
      try {
        window.__TAURI_INTERNALS__.invoke(arguments[0], arguments[1]).then(
          (r) => done({ ok: r === undefined ? null : r }),
          (e) => done({ err: typeof e === "string" ? e : JSON.stringify(e) })
        );
      } catch (e) { done({ err: String(e) }); }`,
    args: [cmd, payload],
  }).catch((e) => ({ err: `webdriver: ${e.message}` }))

export async function screenshot(sid, name) {
  try {
    const b64 = await wd("GET", `/session/${sid}/screenshot`)
    writeFileSync(join(OUT, name), Buffer.from(b64, "base64"))
    return true
  } catch (e) {
    log(`截图 ${name} 失败：${e.message}`)
    return false
  }
}

const PAGE_STATE = `
  const h1 = document.querySelector("h1");
  return {
    href: location.href,
    ready: document.readyState,
    title: document.title,
    h1: h1 ? h1.textContent : null,
    text: document.body ? document.body.innerText.slice(0, 400) : "",
    elements: document.querySelectorAll("*").length,
    buttons: document.querySelectorAll("button").length,
    tauri: typeof window.__TAURI_INTERNALS__,
  };`

export const pageState = (sid) => exec(sid, PAGE_STATE)

// 等当前窗口的界面画出来（加载完、有按钮），返回页面状态；到点返回最后一次读到的
export async function waitForUi(sid, timeoutMs = 120000) {
  let state = null
  await waitFor(
    async () => {
      state = await pageState(sid)
      return state.ready === "complete" && state.buttons > 0
    },
    timeoutMs,
    300
  )
  return state
}

// 开一次 app：起 tauri-driver、建会话（WebKitWebDriver 把 app 带起来）、等主窗口界面画出来。
// env 是只给这一次启动的环境变量。返回 { sid, state, sessionSeconds, uiSeconds }
export async function launch(env = {}) {
  launches += 1
  const started = Date.now()
  await startDriver(`launch${launches}`, env)
  const session = await wd(
    "POST",
    "/session",
    {
      capabilities: {
        alwaysMatch: {
          browserName: "wry",
          "tauri:options": { application: APP },
        },
      },
    },
    180000
  )
  const sid = session.sessionId
  const sessionSeconds = (Date.now() - started) / 1000
  await wd("POST", `/session/${sid}/timeouts`, { script: 30000 }).catch(
    () => {}
  )
  const state = await waitForUi(sid)
  return {
    sid,
    state,
    sessionSeconds,
    uiSeconds: (Date.now() - started) / 1000,
  }
}

// 关会话（app 跟着退），等进程没了，停 tauri-driver。返回 app 是怎么退的
export async function quit(sid) {
  await wd("DELETE", `/session/${sid}`).catch((e) =>
    log(`关会话出错：${e.message}`)
  )
  const how = await waitAppGone()
  await stopDriver()
  return how
}

export const handles = (sid) => wd("GET", `/session/${sid}/window/handles`)
export const switchTo = (sid, handle) =>
  wd("POST", `/session/${sid}/window`, { handle })

// 这个 app 现在有哪些 Tauri 窗口（标签）。从任何一个窗口里都能问（capabilities 给了 core:window:default）
export async function windowLabels(sid) {
  const r = await invoke(sid, "plugin:window|get_all_windows")
  return Array.isArray(r.ok) ? r.ok : []
}

// 切到地址满足 match(href) 的那个窗口；返回它的句柄，没找到返回 null（停在原来的窗口上）
export async function switchToWindow(sid, match, timeoutMs = 20000) {
  const original = await wd("GET", `/session/${sid}/window`).catch(() => null)
  const found = await waitFor(async () => {
    for (const h of await handles(sid)) {
      await switchTo(sid, h)
      const href = await exec(sid, "return location.href").catch(() => "")
      if (match(href)) return h
    }
    return null
  }, timeoutMs)
  if (!found && original) await switchTo(sid, original).catch(() => {})
  return found
}

// 在听的 TCP 端口（`ss -ltnpH` 的行，带进程）。用 sudo 跑：带令牌起的 codeg-server（app 自带的 daemon 子进程、
// 当远端用的那个）会把自己设成 non-dumpable（src-tauri/src/cowork.rs 的 make_non_dumpable，防同一用户的 agent 读它的
// /proc/<pid>/environ），它的 /proc/<pid>/fd 因此归 root，不带 sudo 的 ss 列得出端口、列不出是谁在听。
// GitHub 托管机器上 sudo 免密；没有 sudo 就退回不带的（子进程那项会报「没看到」，不会误判成过）
export function listeningAll() {
  for (const [cmd, args] of [
    ["sudo", ["-n", "ss", "-ltnpH"]],
    ["ss", ["-ltnpH"]],
  ]) {
    try {
      return execFileSync(cmd, args, {
        encoding: "utf8",
        timeout: 15000,
        stdio: ["ignore", "pipe", "pipe"],
      })
        .split("\n")
        .filter(Boolean)
    } catch {
      // 换下一个
    }
  }
  return []
}

export const listening = (port) =>
  listeningAll().filter((l) => l.includes(`:${port} `))

// 起一个独立的 codeg-server（当「远端服务器」用）。返回 { proc, url, token, stop }
export async function startServer(port, token) {
  const dir = mkdtempSync(join(tmpdir(), "desktop-linux-remote-"))
  const logFile = createWriteStream(join(OUT, `remote-server-${port}.log`))
  const proc = spawn(SERVER, [], {
    env: {
      ...process.env,
      CODEG_DATA_DIR: dir,
      CODEG_HOME: dir,
      CODEG_HOST: "127.0.0.1",
      CODEG_PORT: String(port),
      CODEG_TOKEN: token,
      CODEG_BRIDGE_PORTS: "off",
      CODEG_UPDATE_DISABLED: "1",
      CODEG_TELEMETRY_ENV: "ci",
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  proc.stdout.pipe(logFile)
  proc.stderr.pipe(logFile)
  const url = `http://127.0.0.1:${port}`
  const up = await waitFor(
    async () => {
      const res = await fetch(`${url}/api/health`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(2000),
      })
      return res.ok
    },
    90000,
    500
  )
  const stop = () => proc.kill("SIGKILL")
  if (!up) {
    stop()
    throw new Error(`远端 codeg-server 90 秒内没起来（${url}）`)
  }
  return { proc, url, token, stop }
}

const ELEMENT_KEY = "element-6066-11e4-a716-446655440000"

// 最近一次 click() 是怎么点成的 / 为什么没点成（写进检查的细节里）
export let lastClick = ""

// 等元素出现并点它。先用 WebDriver 的点击（真的鼠标事件）；它报错就退到在页面里派发事件：
// pointerdown + mouseup + click（Radix 的菜单按钮认 pointerdown，光 .click() 打不开）。
// using 是 "css selector" 或 "xpath"。点到了返回 true，到点没找到返回 false
export async function click(sid, using, value, timeoutMs = 20000) {
  let el = null
  const found = await waitFor(async () => {
    el = await wd("POST", `/session/${sid}/element`, { using, value })
    return true
  }, timeoutMs)
  if (!found) {
    lastClick = `没找到 ${value}`
    return false
  }
  // W3C 的键；老的 WebKitWebDriver 回的是 ELEMENT
  const id = el?.[ELEMENT_KEY] ?? el?.ELEMENT ?? Object.values(el || {})[0]
  try {
    await wd("POST", `/session/${sid}/element/${id}/click`, {})
    lastClick = "WebDriver 点击"
    return true
  } catch (e) {
    lastClick = `WebDriver 点击报错（${e.message.slice(0, 200)}），改用页面里派发事件`
  }
  try {
    await exec(
      sid,
      `const el = arguments[0];
       const r = el.getBoundingClientRect();
       const at = { bubbles: true, cancelable: true, composed: true, button: 0, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
       el.dispatchEvent(new PointerEvent("pointerdown", { ...at, pointerType: "mouse", pointerId: 1 }));
       el.dispatchEvent(new MouseEvent("mousedown", at));
       el.dispatchEvent(new PointerEvent("pointerup", { ...at, pointerType: "mouse", pointerId: 1 }));
       el.dispatchEvent(new MouseEvent("mouseup", at));
       el.dispatchEvent(new MouseEvent("click", at));`,
      [el]
    )
    return true
  } catch (e) {
    lastClick += `；也报错：${e.message.slice(0, 200)}`
    return false
  }
}

// 等页面里的条件成立：script 是一段返回值的 JS（可用 arguments），返回真值就把它交回来；到点返回 null
export const waitForJs = (sid, script, args = [], timeoutMs = 20000) =>
  waitFor(() => exec(sid, script, args), timeoutMs)

function filesUnder(dir, depth = 6) {
  const out = []
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const e of entries) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (depth > 0) out.push(...filesUnder(p, depth - 1))
    } else if (e.isFile()) out.push(p)
  }
  return out
}

// WebKit 的 localStorage 是攒一会儿才落盘的：等磁盘上的存储文件里出现 marker（UTF-16，localStorage 的存法）再关 app，
// 不靠固定的 sleep。找到返回那个文件，到点返回 null（调用方照常继续，重启后的检查会说明丢没丢）
export async function waitStorageFlushed(marker, timeoutMs = 20000) {
  const root = join(
    process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
  )
  const needles = [Buffer.from(marker, "utf16le"), Buffer.from(marker, "utf8")]
  return waitFor(
    () => {
      for (const file of filesUnder(root)) {
        if (!/localstorage|\.sqlite|-wal$/i.test(file)) continue
        try {
          if (statSync(file).size > 64 * 1024 * 1024) continue
          const data = readFileSync(file)
          if (needles.some((n) => data.includes(n))) return file
        } catch {
          // 正在写，下一轮再看
        }
      }
      return null
    },
    timeoutMs,
    500
  )
}
