#!/usr/bin/env node
// Linux 桌面版的 WebDriver 冒烟（可行性验证，公开镜像 desktop-linux.yml 跑它）。
// tauri-driver（包着 WebKitWebDriver）开桌面 app → 等主窗口 → 读标题 / 页面 → 截图 → 读写 localStorage →
// 退出再开一次，确认 localStorage 还在 → 看内置网页服务（默认 3080）绑在哪个地址。
//
// 不装任何 npm 依赖：W3C WebDriver 就是几个 HTTP 接口，直接用 Node 自带的 fetch。
//
//   用法：xvfb-run -a dbus-run-session -- node scripts/desktop-linux-smoke.mjs
//   环境：SMOKE_APP（桌面程序，默认 src-tauri/target/debug/codeg）、SMOKE_OUT（截图、日志、result.json 放哪，默认 smoke-out）、
//        TAURI_DRIVER（默认 ~/.cargo/bin/tauri-driver）、GITHUB_STEP_SUMMARY 有就把结果表写进去。
//
// 网页服务：桌面版默认不开。开法是把「随 app 启动」打开（Tauri 命令 update_web_service_config，autoStart=true），
// 下一次启动 app 就在进程里跑 daemon 并监听网页服务端口（src-tauri/src/local_daemon.rs 的 decide_mode）。
// 所以第一次启动里打开这个开关，第二次启动后用 ss 看端口。
import { spawn, execFileSync } from "node:child_process"
import {
  createWriteStream,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  appendFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

const APP = resolve(process.env.SMOKE_APP || "src-tauri/target/debug/codeg")
const OUT = resolve(process.env.SMOKE_OUT || "smoke-out")
const DRIVER =
  process.env.TAURI_DRIVER || join(homedir(), ".cargo", "bin", "tauri-driver")
const DRIVER_PORT = 4444
const BASE = `http://127.0.0.1:${DRIVER_PORT}`
const WEB_PORT = 3080
const LS_KEY = "desktop-linux-smoke"
const LS_VALUE = `smoke-${Date.now()}`
// 主窗口显示本机工作区还是开始页，记在 localStorage 的这个键里（src/lib/cowork/start-page.ts）
const MAIN_VIEW_KEY = "cowork:main-window-view:v1"

mkdirSync(OUT, { recursive: true })
const dataDir = mkdtempSync(join(tmpdir(), "desktop-linux-smoke-"))
const t0 = Date.now()
const checks = []
const timings = {}
const notes = {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (msg) =>
  console.log(`[smoke +${((Date.now() - t0) / 1000).toFixed(1)}s] ${msg}`)

function check(name, ok, detail = "") {
  checks.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 600) })
  log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `：${detail}` : ""}`)
  return Boolean(ok)
}

function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 15000 })
  } catch (e) {
    return `${e.stdout || ""}${e.stderr || ""}`
  }
}

async function wd(method, path, body, timeoutMs = 60000) {
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
async function startDriver(tag) {
  const logFile = createWriteStream(join(OUT, `tauri-driver-${tag}.log`))
  driverProc = spawn(DRIVER, ["--port", String(DRIVER_PORT)], {
    env: {
      ...process.env,
      // app 的数据库、日志都放临时目录；WebKit 自己的数据（localStorage）照旧在 XDG 目录下，两次启动是同一个
      CODEG_DATA_DIR: dataDir,
    },
    stdio: ["ignore", "pipe", "pipe"],
  })
  driverProc.stdout.pipe(logFile)
  driverProc.stderr.pipe(logFile)
  driverProc.on("error", (e) => log(`tauri-driver 起不来：${e.message}`))
  for (let i = 0; i < 60; i++) {
    try {
      await wd("GET", "/status", undefined, 2000)
      return
    } catch {
      await sleep(500)
    }
  }
  throw new Error("tauri-driver 30 秒内没有应答 /status")
}

async function stopDriver() {
  if (!driverProc) return
  const p = driverProc
  driverProc = null
  p.kill("SIGTERM")
  await sleep(1000)
  if (p.exitCode === null) p.kill("SIGKILL")
}

const appPids = () =>
  sh("pgrep", ["-x", "codeg"])
    .split(/\s+/)
    .filter((s) => /^\d+$/.test(s))

// 等 app 进程退出；到点没退就 TERM、再 KILL，返回它是怎么没的
async function waitAppGone() {
  for (let i = 0; i < 40; i++) {
    if (appPids().length === 0) return "自己退出"
    await sleep(500)
  }
  for (const pid of appPids()) sh("kill", ["-TERM", pid])
  for (let i = 0; i < 20; i++) {
    if (appPids().length === 0) return "20 秒没退，SIGTERM 后退出"
    await sleep(500)
  }
  for (const pid of appPids()) sh("kill", ["-KILL", pid])
  await sleep(1000)
  return "SIGTERM 也没退，SIGKILL"
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
    userAgent: navigator.userAgent,
  };`

const exec = (sid, script, args = []) =>
  wd("POST", `/session/${sid}/execute/sync`, { script, args })

// 调一个 Tauri 命令（window.__TAURI_INTERNALS__.invoke），返回 { ok } 或 { err }
const invoke = (sid, cmd, payload = {}) =>
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
  })

async function screenshot(sid, name) {
  try {
    const b64 = await wd("GET", `/session/${sid}/screenshot`)
    writeFileSync(join(OUT, name), Buffer.from(b64, "base64"))
    return true
  } catch (e) {
    log(`截图失败：${e.message}`)
    return false
  }
}

// 开一次 app：建会话、等页面有内容。返回 { sid, state }
async function launch(tag) {
  const started = Date.now()
  await startDriver(tag)
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
  timings[`${tag}_session_s`] = (Date.now() - started) / 1000
  await wd("POST", `/session/${sid}/timeouts`, { script: 30000 }).catch(
    () => {}
  )
  let state = null
  for (let i = 0; i < 180; i++) {
    try {
      state = await exec(sid, PAGE_STATE)
      // 刚加载完时页面上只有一个标题；等界面真的画出来（有按钮）
      if (state.ready === "complete" && state.buttons > 0) break
    } catch (e) {
      state = { error: e.message }
    }
    await sleep(1000)
  }
  timings[`${tag}_page_s`] = (Date.now() - started) / 1000
  // 再等界面稳下来（侧栏等是后画的），重读一次
  await sleep(2000)
  state = await exec(sid, PAGE_STATE).catch(() => state)
  return { sid, state }
}

async function quit(sid) {
  await wd("DELETE", `/session/${sid}`).catch((e) =>
    log(`关会话出错：${e.message}`)
  )
  const how = await waitAppGone()
  await stopDriver()
  return how
}

const listening = () => sh("ss", ["-ltnpH"])

async function main() {
  log(`app=${APP}`)
  log(`数据目录=${dataDir}`)

  // ── 第一次启动 ──
  const first = await launch("launch1")
  const s1 = first.state || {}
  notes.launch1 = s1
  check(
    "第一次启动：WebDriver 会话建起来、主窗口页面加载完",
    s1.ready === "complete" && s1.buttons > 0,
    `href=${s1.href} title=${JSON.stringify(s1.title)} h1=${JSON.stringify(s1.h1)} 元素数=${s1.elements}${s1.error ? ` error=${s1.error}` : ""}`
  )
  check(
    "页面里有 Tauri 的接口（window.__TAURI_INTERNALS__）",
    s1.tauri === "object",
    `typeof=${s1.tauri}`
  )
  notes.handles1 = await wd(
    "GET",
    `/session/${first.sid}/window/handles`
  ).catch((e) => e.message)
  check("截图", await screenshot(first.sid, "launch1.png"), "launch1.png")

  const wrote = await exec(
    first.sid,
    `localStorage.setItem(arguments[0], arguments[1]); return localStorage.getItem(arguments[0]);`,
    [LS_KEY, LS_VALUE]
  ).catch((e) => `error: ${e.message}`)
  check("执行 JS：localStorage 写了能读回", wrote === LS_VALUE, wrote)

  const status1 = await invoke(first.sid, "get_web_server_status").catch(
    (e) => ({ err: e.message })
  )
  notes.webStatus1 = status1
  check(
    "调 Tauri 命令（get_web_server_status）",
    status1 && !("err" in status1),
    JSON.stringify(status1)
  )
  const ss1 = listening()
  writeFileSync(join(OUT, "ss-launch1.txt"), ss1)
  notes.port3080Launch1 = ss1
    .split("\n")
    .filter((l) => l.includes(`:${WEB_PORT} `))
  log(
    `第一次启动时 ${WEB_PORT} 端口：${notes.port3080Launch1.length ? notes.port3080Launch1.join(" | ") : "没人听（网页服务默认不开）"}`
  )

  // 打开「网页服务随 app 启动」，下次启动生效
  const cfg = await invoke(first.sid, "update_web_service_config", {
    config: { token: null, port: null, autoStart: true },
  }).catch((e) => ({ err: e.message }))
  notes.webConfig = cfg
  check(
    "打开「网页服务随 app 启动」（update_web_service_config）",
    cfg && cfg.ok && cfg.ok.autoStart === true,
    JSON.stringify(cfg).replace(/"token":"[^"]*"/, '"token":"…"')
  )

  // 新装的 app 主窗口直接进本机工作区；把记着的选择改成开始页，下次启动应该停在开始页
  notes.mainViewBefore = await exec(
    first.sid,
    `const before = localStorage.getItem(arguments[0]); localStorage.setItem(arguments[0], "start"); return before;`,
    [MAIN_VIEW_KEY]
  ).catch((e) => `error: ${e.message}`)
  log(
    `主窗口记着的视图：${JSON.stringify(notes.mainViewBefore)} → 改成 "start"`
  )

  // WebKit 的 localStorage 是攒一会儿才落盘的，等几秒再关
  await sleep(5000)
  const how1 = await quit(first.sid)
  notes.quit1 = how1
  log(`第一次退出：${how1}`)
  const orphans = sh("pgrep", ["-x", "codeg-server"]).trim()
  check(
    "app 退出后自带的 codeg-server 子进程也没了",
    orphans === "",
    orphans ? `还在：pid ${orphans}` : ""
  )

  // ── 第二次启动 ──
  const second = await launch("launch2")
  const s2 = second.state || {}
  notes.launch2 = s2
  check(
    "第二次启动：主窗口页面加载完",
    s2.ready === "complete" && s2.buttons > 0,
    `href=${s2.href} title=${JSON.stringify(s2.title)}${s2.error ? ` error=${s2.error}` : ""}`
  )
  // 开始页：标题是 h1，下面两段的标题 id 是 start-local / start-saved（src/components/cowork/start-home.tsx）
  let start = null
  for (let i = 0; i < 20; i++) {
    start = await exec(
      second.sid,
      `const h1 = document.querySelector("h1");
       return { h1: h1 ? h1.textContent : null, local: !!document.getElementById("start-local"), view: localStorage.getItem(arguments[0]) };`,
      [MAIN_VIEW_KEY]
    ).catch((e) => ({ error: e.message }))
    if (start.h1) break
    await sleep(1000)
  }
  notes.startPage = start
  check(
    "第二次启动停在开始页（上次写进 localStorage 的选择生效）",
    Boolean(start && start.h1),
    JSON.stringify(start)
  )
  const kept = await exec(
    second.sid,
    `return localStorage.getItem(arguments[0]);`,
    [LS_KEY]
  ).catch((e) => `error: ${e.message}`)
  check(
    "退出重开后 localStorage 还在",
    kept === LS_VALUE,
    `读到 ${JSON.stringify(kept)}，写的是 ${LS_VALUE}（第一次退出方式：${how1}）`
  )

  let lines = []
  for (let i = 0; i < 60 && lines.length === 0; i++) {
    lines = listening()
      .split("\n")
      .filter((l) => l.includes(`:${WEB_PORT} `))
    if (lines.length === 0) await sleep(1000)
  }
  const ss2 = listening()
  writeFileSync(join(OUT, "ss-launch2.txt"), ss2)
  notes.port3080Launch2 = lines
  check(
    `网页服务在听 ${WEB_PORT}`,
    lines.length > 0,
    lines.join(" | ") || "60 秒内没人听"
  )
  check(
    `${WEB_PORT} 只绑在 127.0.0.1（#684 之后的默认）`,
    lines.length > 0 &&
      lines.every((l) => l.includes(`127.0.0.1:${WEB_PORT} `)),
    lines.join(" | ")
  )
  const status2 = await invoke(second.sid, "get_web_server_status").catch(
    (e) => ({ err: e.message })
  )
  notes.webStatus2 = JSON.parse(
    JSON.stringify(status2).replace(/"token":"[^"]*"/, '"token":"…"')
  )
  const http = sh("curl", [
    "-s",
    "-o",
    "/dev/null",
    "-w",
    "%{http_code}",
    "--max-time",
    "5",
    `http://127.0.0.1:${WEB_PORT}/`,
  ])
  notes.webHttp = http
  log(`GET http://127.0.0.1:${WEB_PORT}/ → ${http}`)
  await screenshot(second.sid, "launch2.png")
  notes.quit2 = await quit(second.sid)
}

let crashed = null
try {
  await main()
} catch (e) {
  crashed = e
  check("脚本跑完", false, e.stack || e.message)
} finally {
  await stopDriver()
  for (const pid of appPids()) sh("kill", ["-KILL", pid])
  // app 自己的日志（数据目录下的 logs/），失败时靠它看卡在哪
  sh("cp", ["-r", join(dataDir, "logs"), join(OUT, "app-logs")])
}

const failed = checks.filter((c) => !c.ok)
timings.total_s = (Date.now() - t0) / 1000
writeFileSync(
  join(OUT, "result.json"),
  JSON.stringify({ checks, timings, notes, dataDir }, null, 2)
)
const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
const table = [
  `### 桌面版 Linux WebDriver 冒烟：${failed.length === 0 ? "全过" : `${failed.length} 项没过`}`,
  "",
  "| 检查 | 结果 | 细节 |",
  "| --- | --- | --- |",
  ...checks.map(
    (c) => `| ${esc(c.name)} | ${c.ok ? "过" : "没过"} | ${esc(c.detail)} |`
  ),
  "",
  `耗时（秒）：${Object.entries(timings)
    .map(([k, v]) => `${k}=${v.toFixed(1)}`)
    .join("，")}`,
  "",
].join("\n")
console.log(table)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`)
}
process.exit(failed.length === 0 && !crashed ? 0 : 1)
