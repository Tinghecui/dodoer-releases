// 桌面版更新流程测试（公开镜像 desktop-e2e.yml 在 macOS 上调）：装 e2e 测试版 N = 1.999.0 到 ~/Applications/dodoer.app，
// 指向同一个进程里的假更新源（feed.mjs），把更新、重启、回退、切渠道、强杀、空闲重启、旧纯客户端版升级走一遍。
// 包是 prepare.sh 做的（N、N+1 = 1.999.1，测试密钥签名）。
//
// 不用 @wdio/tauri-service：更新会让 app 自己退出、经 LaunchServices（open -n）重开，tauri-service 那种「自己起 app、自己收」的会话跟不上。
// 这里用 webdriverio 的 remote() 直接连 app 里内嵌的 WebDriver 服务器（127.0.0.1:4445，tauri-plugin-wdio-webdriver；它不管 capabilities），
// app 每重开一次就重新连一次。app 读的设置（数据目录、更新地址、测试公钥）写在 ~/.codeg-e2e.env（e2e::load_env_file），
// open -n 起的进程不继承环境变量。
//
// 分几段（E2E_UPDATE_PHASES，默认 "A B C D E"），每段开头自己把要的版本装好、换一个新的数据目录，前一段挂了不影响后一段：
//   A 发现新版、切渠道、版本号刷新、下载、「重启以更新」、重启进 N+1（PR648 269 480 396，故事 N5）
//   B 装着 N+1、稳定版上回退到 N（PR643；Intel 上跑同一段 = PR349）
//   C 下好以后点重启、安装中途强杀、再打开：重启意图不算数，被打断的对话只标打断、不自动接着做（PR642、PR614 的强杀那条）
//   D 自动安装档、开着一个终端（长任务）时不自动重启，关掉以后空闲了才自动重启进新版（PR592）
//   E 模拟的旧纯客户端版（不带 codeg-server）从 latest-client.json 更新成完整版（故事 N5 后半句）
//
//   环境：E2E_UPDATE_WORK（prepare.sh 的输出目录，必填）、E2E_OUT（默认 e2e-out；本段的东西在 $E2E_OUT/update/）、E2E_UPDATE_PHASES
//   只在 CI 机器上跑（CI=true）：会改 ~/Applications/dodoer.app、~/.codeg-e2e.env，会杀叫 codeg 的进程
// 来历：源仓库 .cowork/journal/2026-11-22-e2e-update-feed.md
import { execFileSync, spawnSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { remote } from "webdriverio"
import { startFeed } from "./feed.mjs"

if (process.env.CI !== "true") {
  console.error(
    "只在 CI 机器上跑（CI=true）：会换掉 ~/Applications/dodoer.app、杀 codeg 进程"
  )
  process.exit(2)
}
const here = fileURLToPath(new URL(".", import.meta.url))
const root = resolve(here, "..", "..", "..")
const WORK = process.env.E2E_UPDATE_WORK
if (!WORK || !existsSync(join(WORK, "feed")))
  throw new Error("E2E_UPDATE_WORK 没设，或者里面没有 prepare.sh 的输出")
const OUT = join(resolve(root, process.env.E2E_OUT || "e2e-out"), "update")
mkdirSync(OUT, { recursive: true })
const PHASES = (process.env.E2E_UPDATE_PHASES || "A B C D E")
  .split(/\s+/)
  .filter(Boolean)
const ARCH = readFileSync(join(WORK, "arch"), "utf8").trim()
const PUBKEY = readFileSync(
  join(WORK, "keys", "e2e-updater.key.pub"),
  "utf8"
).trim()
const APP = join(homedir(), "Applications", "dodoer.app")
const ENV_FILE = join(homedir(), ".codeg-e2e.env")
const FEED_PORT = 47001
const WD_PORT = 4445
const N = "1.999.0"
const N1 = "1.999.1"
const pkg = (v) => `dodoer-${v}-macos-${ARCH}.app.tar.gz`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────── 结果：每一步的名字、过没过、秒数，和 run.sh 的 result-phase<N>.json 一个格式 ─────────
const t0 = Date.now()
const steps = []
const notes = {}
let skipRest = null // 这一段前面有一步没过：后面的步骤不再跑，记成没过（原因写前一步）

async function step(phase, name, fn) {
  const start = Date.now()
  const label = `${phase} ${name}`
  if (skipRest) {
    steps.push({
      phase,
      name,
      ok: false,
      seconds: 0,
      detail: `没跑：${skipRest}`,
    })
    console.log(`[update] SKIP ${label}`)
    return undefined
  }
  try {
    const detail = (await fn()) ?? ""
    steps.push({
      phase,
      name,
      ok: true,
      seconds: (Date.now() - start) / 1000,
      detail,
    })
    console.log(
      `[update] PASS ${label} ${JSON.stringify(detail).slice(0, 400)}`
    )
    return detail
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 800)
    steps.push({
      phase,
      name,
      ok: false,
      seconds: (Date.now() - start) / 1000,
      detail: msg,
    })
    console.log(`[update] FAIL ${label} ${msg}`)
    await shot(`${phase}-fail-${steps.length}`)
    await dumpText(`${phase}-fail-${steps.length}`)
    skipRest = `前面「${name}」没过`
    return undefined
  }
}

function writeResult() {
  writeFileSync(
    join(OUT, "result-update.json"),
    JSON.stringify(
      {
        phase: "update",
        platform: process.platform,
        arch: ARCH,
        totalSeconds: (Date.now() - t0) / 1000,
        steps,
        notes,
        feedRequests: feed?.requests.slice(-400) ?? [],
      },
      null,
      2
    )
  )
}

function summary() {
  const esc = (s) =>
    String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)
  const failed = steps.filter((s) => !s.ok).length
  const lines = [
    `### 桌面更新流程（macOS ${ARCH}）：${failed ? `${failed} 项没过` : "全过"}`,
    "",
    "| 段 | 步骤 | 结果 | 秒 |",
    "| --- | --- | --- | --- |",
    ...steps.map(
      (s) =>
        `| ${s.phase} | ${esc(s.name)}${s.ok ? "" : `：${esc(s.detail)}`} | ${s.ok ? "过" : "**没过**"} | ${s.seconds.toFixed(1)} |`
    ),
    "",
  ]
  const text = lines.join("\n")
  console.log(text)
  writeFileSync(join(OUT, "summary.md"), text + "\n")
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n", { flag: "a" })
  return failed
}

function must(cond, detail) {
  if (!cond) throw new Error(detail)
}

// ───────── app：装、起、连、退 ─────────
let b = null // 当前连着的 WebDriver 会话
let feed = null
let dataDir = null

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120000, ...opts })
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }
}

// app 的主进程（不算它带起来的 codeg-server 等）：包里的 CFBundleExecutable
function appPids() {
  if (!existsSync(APP)) return []
  const exe =
    sh("defaults", [
      "read",
      join(APP, "Contents", "Info.plist"),
      "CFBundleExecutable",
    ]).out.trim() || "codeg"
  // 从头比：重开时的 relauncher（/bin/sh -c … codeg-relaunch <pid> … <这个程序> …）命令行里也有这个路径
  const r = sh("pgrep", ["-f", `^${APP}/Contents/MacOS/${exe}( |$)`])
  return r.out.split(/\s+/).filter((s) => /^\d+$/.test(s))
}
function allAppPids() {
  const r = sh("pgrep", ["-f", `^${APP}/Contents/MacOS/`])
  return r.out.split(/\s+/).filter((s) => /^\d+$/.test(s))
}
const argsOf = (pid) => sh("ps", ["-o", "args=", "-p", pid]).out.trim()
const plistVersion = () =>
  sh("defaults", [
    "read",
    join(APP, "Contents", "Info.plist"),
    "CFBundleShortVersionString",
  ]).out.trim()

function writeEnv(manifest = "latest.json") {
  writeFileSync(
    ENV_FILE,
    [
      "# desktop-e2e update suite (scripts/desktop-e2e/update/run.mjs)",
      `CODEG_DATA_DIR=${dataDir}`,
      `CODEG_HOME=${dataDir}`,
      `CODEG_E2E_UPDATER_ENDPOINTS=${feed.endpoint(manifest)}`,
      `CODEG_E2E_UPDATER_PUBKEY=${PUBKEY}`,
      `TAURI_WEBDRIVER_PORT=${WD_PORT}`,
      "CODEG_TELEMETRY_ENV=ci",
      "",
    ].join("\n")
  )
}

async function disconnect() {
  if (b) await b.deleteSession().catch(() => {})
  b = null
}

// 退出 app：先 TERM，10 秒没走就 -9；它带起来的 codeg-server 一起
async function quitApp() {
  await disconnect()
  for (const sig of ["-TERM", "-KILL"]) {
    const pids = allAppPids()
    if (!pids.length) return
    sh("kill", [sig, ...pids])
    for (let i = 0; i < 40 && allAppPids().length; i++) await sleep(250)
  }
  must(!allAppPids().length, `退不掉：${allAppPids().join(" ")}`)
}

// 换一个版本的 .app（prepare.sh 做的 apps/<名字>/dodoer.app），新的数据目录
async function installFresh(name, manifest = "latest.json") {
  await quitApp()
  rmSync(APP, { recursive: true, force: true })
  mkdirSync(join(homedir(), "Applications"), { recursive: true })
  execFileSync("ditto", [join(WORK, "apps", name, "dodoer.app"), APP])
  dataDir = mkdtempSync(join(tmpdir(), "e2e-update-data-"))
  // 「自动更新」「更新通道」存在 ~/.codeg/preferences.json（CODEG_HOME 不管它），每段从默认开始
  rmSync(join(homedir(), ".codeg", "preferences.json"), { force: true })
  // 网页那边的存储（localStorage 里记着上一段查到的更新、关掉的提示）也按 bundle id 存，不跟数据目录走
  for (const d of ["WebKit", "Caches"])
    rmSync(join(homedir(), "Library", d, "app.codeg"), {
      recursive: true,
      force: true,
    })
  writeEnv(manifest)
  notes[`data-${name}-${Date.now()}`] = dataDir
}

function launch() {
  const r = sh("open", ["-n", APP])
  must(r.code === 0, `open -n 失败：${r.out}`)
}

async function wdReady(timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${WD_PORT}/status`, {
        signal: AbortSignal.timeout(2000),
      })
      if (r.ok) return true
    } catch {
      // 还没起来
    }
    await sleep(500)
  }
  return false
}

// 等一个新的 app 主进程（不在 before 里）起来、它的 WebDriver 服务器答话，连上主窗口
async function connect({ before = [], timeout = 180000 } = {}) {
  await disconnect()
  const deadline = Date.now() + timeout
  let pid = null
  while (Date.now() < deadline) {
    const now = appPids()
    const fresh = now.filter((p) => !before.includes(p))
    // 旧的要走了才算（不然 4445 还是旧的在答）
    if (fresh.length && !now.some((p) => before.includes(p))) {
      pid = fresh[0]
      break
    }
    await sleep(300)
  }
  must(
    pid,
    `没有新的 app 进程（之前 ${before.join(",") || "无"}，现在 ${appPids().join(",") || "无"}）`
  )
  must(
    await wdReady(Math.max(5000, deadline - Date.now())),
    "WebDriver 服务器（4445）没答话"
  )
  b = await remote({
    hostname: "127.0.0.1",
    port: WD_PORT,
    path: "/",
    capabilities: {},
    logLevel: "warn",
    connectionRetryCount: 2,
    connectionRetryTimeout: 60000,
    waitforTimeout: 20000,
  })
  await waitUi("main")
  return pid
}

async function waitUi(label, timeout = 120000) {
  const deadline = Date.now() + timeout
  let last = ""
  while (Date.now() < deadline) {
    try {
      await b.switchToWindow(label)
      const s = await b.execute(() => ({
        ready: document.readyState,
        buttons: document.querySelectorAll("button").length,
        href: location.href,
      }))
      last = JSON.stringify(s)
      if (s.ready === "complete" && s.buttons > 0) return s
    } catch (e) {
      last = String(e?.message || e)
    }
    await sleep(500)
  }
  throw new Error(`${label} 窗口没画出来：${last.slice(0, 200)}`)
}

// 主窗口：开始页就点「本机」，等本机工作区（侧栏脚上的「快捷操作」）
async function enterLocal() {
  await b.switchToWindow("main")
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const where = await b.execute(() =>
      document.getElementById("start-local")
        ? "start"
        : document.querySelector('button[title="Quick actions"]')
          ? "local"
          : "loading"
    )
    if (where === "local") return where
    if (where === "start") await clickSel("#start-local")
    await sleep(500)
  }
  throw new Error("没进本机工作区")
}

// ───────── 页面里的小工具 ─────────
const bodyText = () => b.execute(() => document.body.innerText)

async function waitText(text, timeout = 30000, { absent = false } = {}) {
  const deadline = Date.now() + timeout
  let last = ""
  while (Date.now() < deadline) {
    last = await bodyText().catch(() => "")
    if (last.includes(text) !== absent) return true
    await sleep(400)
  }
  throw new Error(
    `${absent ? "还有" : "没有"}「${text}」：${last.replace(/\s+/g, " ").slice(0, 240)}`
  )
}

// 点一个看得见、没禁用的元素：selector 选中的里头第一个（text 不是 null 时要文字里带 text，exact 时要整个相等；
// 没有文字的按钮看 aria-label）。按真实点击的顺序派发 pointer / mouse 事件：macOS 插件的 elementClick 只是 el.click()，
// Radix 的东西认 pointerdown（specs/lib.mjs 的 pointerClick）
async function clickWhere(selector, text, exact, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const ok = await b
      .execute(
        (sel, txt, ex) => {
          const el = [...document.querySelectorAll(sel)].find((e) => {
            const r = e.getBoundingClientRect()
            if (!(r.width > 0 && r.height > 0) || e.disabled) return false
            if (txt === null) return true
            const t = (e.innerText || e.getAttribute("aria-label") || "").trim()
            return ex ? t === txt : t.includes(txt)
          })
          if (!el) return false
          const r = el.getBoundingClientRect()
          const at = {
            bubbles: true,
            cancelable: true,
            composed: true,
            button: 0,
            clientX: r.x + r.width / 2,
            clientY: r.y + r.height / 2,
          }
          const p = {
            ...at,
            pointerType: "mouse",
            pointerId: 1,
            isPrimary: true,
          }
          el.dispatchEvent(new PointerEvent("pointerdown", p))
          el.dispatchEvent(new MouseEvent("mousedown", at))
          el.dispatchEvent(new PointerEvent("pointerup", p))
          el.dispatchEvent(new MouseEvent("mouseup", at))
          el.dispatchEvent(new MouseEvent("click", at))
          return true
        },
        selector,
        text,
        exact
      )
      .catch(() => false)
    if (ok) return
    await sleep(300)
  }
  throw new Error(`点不到 ${selector}${text === null ? "" : `「${text}」`}`)
}
const clickSel = (selector, timeout = 20000) =>
  clickWhere(selector, null, false, timeout)
const clickText = (
  text,
  { selector = "button", timeout = 20000, exact = false } = {}
) => clickWhere(selector, text, exact, timeout)

const invoke = (cmd, payload = {}) =>
  b.executeAsync(
    (c, p, done) => {
      try {
        window.__TAURI_INTERNALS__.invoke(c, p).then(
          (r) => done({ ok: r === undefined ? null : r }),
          (e) => done({ err: typeof e === "string" ? e : JSON.stringify(e) })
        )
      } catch (e) {
        done({ err: String(e) })
      }
    },
    cmd,
    payload
  )
async function call(cmd, payload) {
  const r = await invoke(cmd, payload)
  must(r && !("err" in r), `${cmd}：${JSON.stringify(r).slice(0, 300)}`)
  return r.ok
}
// 发了就不管（app 可能在答话之前就退出）
const fire = (cmd, payload = {}) =>
  b
    .execute(
      (c, p) => {
        window.__TAURI_INTERNALS__.invoke(c, p).catch(() => {})
        return true
      },
      cmd,
      payload
    )
    .catch(() => false)

// 本机 daemon（app 带起来的 codeg-server）上的命令：经 app 的代理（同前端 local-daemon 那条路）
async function daemon(command, args = {}) {
  const id = await b.execute(
    () => window.__CODEG_LOCAL_DAEMON__?.connectionId ?? null
  )
  must(id !== null, "没有本机 daemon 的连接（__CODEG_LOCAL_DAEMON__）")
  return call("remote_http_call", { connectionId: id, command, args })
}

async function shot(name) {
  if (!b) return
  try {
    await b.saveScreenshot(join(OUT, `${name}.png`))
  } catch {
    // 窗口没了
  }
}
async function dumpText(name) {
  if (!b) return
  try {
    const handles = await b.getWindowHandles()
    const parts = []
    for (const h of handles) {
      await b.switchToWindow(h)
      parts.push(`=== ${h}\n${await bodyText()}`)
    }
    writeFileSync(join(OUT, `${name}.txt`), parts.join("\n\n"))
    await b.switchToWindow("main").catch(() => {})
  } catch {
    // 窗口没了
  }
}

// 设置窗口的「系统」页（软件更新在这里）
async function openSystemSettings() {
  await b.switchToWindow("main")
  await call("open_settings_window", { section: "system" })
  const deadline = Date.now() + 30000
  while (
    Date.now() < deadline &&
    !(await b.getWindowHandles()).includes("settings")
  )
    await sleep(300)
  await waitUi("settings")
  await waitText("Current version")
}
const inWindow = async (label, fn) => {
  await b.switchToWindow(label)
  return fn()
}

// app 的日志（数据目录 logs/ 下所有文件）里有没有 needle
function logsHave(needle) {
  const dir = join(dataDir, "logs")
  const walk = (d) =>
    existsSync(d)
      ? readdirSync(d, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]
        )
      : []
  return walk(dir).some((f) => {
    try {
      return readFileSync(f, "utf8").includes(needle)
    } catch {
      return false
    }
  })
}
async function waitLog(needle, timeout) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (logsHave(needle)) return true
    await sleep(1000)
  }
  throw new Error(`日志里 ${timeout / 1000} 秒内没有「${needle}」`)
}

const journal = () => {
  try {
    return JSON.parse(
      readFileSync(join(dataDir, "update", "journal.json"), "utf8")
    )
  } catch {
    return null
  }
}

// 主窗口的「状态栏」：桌面宽度下不常显示，收在右上角的状态按钮（cowork/status-indicator.tsx）的弹层里，
// 有可操作的更新时按钮上一个小圆点（data-status-update）。更新药丸（「New v…」「Restart to update」）在那个弹层里，
// 点它再开自己的弹层（升级、「Restart to update」、「Later」）
const POPOVER = "[data-radix-popper-content-wrapper]"
const STATUS = "[data-status-bar-right]"
const UPDATE_POP = `${POPOVER}:not(:has(${STATUS}))`
const visible = (sel) =>
  b
    .execute(
      (s) =>
        [...document.querySelectorAll(s)].some((e) => {
          const r = e.getBoundingClientRect()
          return r.width > 0 && r.height > 0
        }),
      sel
    )
    .catch(() => false)
async function openStatus() {
  await b.switchToWindow("main")
  if (await visible(STATUS)) return
  await clickSel("[data-status-indicator]")
  const deadline = Date.now() + 5000
  while (Date.now() < deadline && !(await visible(STATUS))) await sleep(200)
  must(await visible(STATUS), "右上角状态按钮的弹层没打开")
}
const statusText = () =>
  b
    .execute(
      (s) =>
        [...document.querySelectorAll(s)].map((e) => e.innerText).join("\n"),
      STATUS
    )
    .catch(() => "")
// 主窗口状态栏里有没有 text（absent：等它没有）
async function waitStatus(text, timeout = 30000, { absent = false } = {}) {
  const deadline = Date.now() + timeout
  let last = ""
  while (Date.now() < deadline) {
    const shown = await openStatus().then(
      () => true,
      () => false
    )
    if (shown) {
      last = await statusText()
      if (last.includes(text) !== absent) return true
    }
    await sleep(500)
  }
  throw new Error(
    `主窗口状态栏${absent ? "还有" : "没有"}「${text}」：${last.replace(/\s+/g, " ").slice(0, 240)}`
  )
}
// 更新药丸 → 它自己的弹层（已经开着就不再点：再点会关上）
async function openPopover(pill = "Restart to update") {
  if (await visible(UPDATE_POP)) return
  await openStatus()
  await clickText(pill, { selector: `${STATUS} button` })
  const deadline = Date.now() + 10000
  while (Date.now() < deadline && !(await visible(UPDATE_POP))) await sleep(200)
  must(await visible(UPDATE_POP), "更新药丸的弹层没打开")
}
async function restartFromStatusBar() {
  await b.switchToWindow("main")
  await openPopover()
  await clickText("Restart to update", { selector: `${UPDATE_POP} button` })
}

// 开始下载（设置页的「Upgrade to v<版本>」），等状态栏出现「Restart to update」
async function downloadTo(version, timeout = 600000) {
  await b.switchToWindow("settings")
  await clickText(`Upgrade to v${version}`)
  await waitStatus("Restart to update", timeout)
}

// 版本号：桌面主程序认的（check_app_update 回的 currentVersion）、设置页写的、包里 Info.plist 写的
async function versions() {
  const check = await invoke("check_app_update")
  return {
    running:
      check?.ok?.currentVersion ?? `?${JSON.stringify(check).slice(0, 120)}`,
    plist: plistVersion(),
  }
}

// ───────── 各段 ─────────

// 每段开头的更新源：v1.999.0（有包，也是稳定版、history.json 里只有它），v1.999.1（有包，最新 = 抢先版）
function baseFeed() {
  feed.reset()
  feed.publish(N, { package: pkg(N) })
  feed.promote(N)
  feed.publish(N1, { package: pkg(N1) })
}

async function phaseA() {
  const P = "A"
  baseFeed()
  let pidN = null
  await step(
    P,
    `装 N（${N}）、新数据目录，第一次启动进本机工作区`,
    async () => {
      await installFresh(N)
      launch()
      pidN = await connect()
      await enterLocal()
      await shot("A-01-launch")
      return { pid: pidN, args: argsOf(pidN) }
    }
  )
  await step(
    P,
    "按 Info.plist 的版本运行（e2e 测试版），走的是测试公钥和假更新源",
    async () => {
      const v = await versions()
      must(v.running === N && v.plist === N, JSON.stringify(v))
      // 默认稳定版：查的是 stable/latest.json，稳定版就是 N，没有更新
      must(
        feed.requested("/releases/download/stable/latest.json").length > 0,
        "假更新源没收到稳定版清单的请求"
      )
      return v
    }
  )
  await step(P, "设置 → 系统：自动更新设成「Off」", async () => {
    await openSystemSettings()
    await clickSel("#auto-update-mode-off")
    await sleep(800)
    const prefs = await call("get_update_preferences")
    must(prefs?.mode === "off", JSON.stringify(prefs))
    must(
      prefs?.channelsAvailable === true || prefs?.channels_available === true,
      `没有通道可选：${JSON.stringify(prefs)}`
    )
    return prefs
  })
  await step(
    P,
    "稳定版（默认）点「Check for updates」：已是最新（PR648）",
    async () => {
      await inWindow("settings", () =>
        clickText("Check for updates", { exact: true })
      )
      await waitText("You're on the latest version")
      await shot("A-02-stable-latest")
    }
  )
  await step(
    P,
    `切到抢先版：马上重查，设置页出现「Upgrade to v${N1}」和「· Early」（PR648）`,
    async () => {
      const since = Date.now()
      await clickSel("#update-channel-early")
      await waitText(`Upgrade to v${N1}`)
      await waitText("· Early")
      must(
        feed.requested("/releases/latest/download/latest.json", since).length >
          0,
        "没去查抢先版的清单"
      )
      await shot("A-03-early-offer")
    }
  )
  await step(P, `主窗口状态栏跟着出现「New v${N1}」（PR648）`, async () => {
    await waitStatus(`New v${N1}`, 30000)
    const dot = await b.execute(
      () => !!document.querySelector("[data-status-update]")
    )
    await shot("A-04-main-offer")
    return { dot }
  })
  await step(
    P,
    "切回稳定版：主窗口的升级提示马上消失，设置页也没有升级按钮（PR648）",
    async () => {
      await b.switchToWindow("settings")
      await clickSel("#update-channel-stable")
      await waitText(`Upgrade to v${N1}`, 15000, { absent: true })
      await waitStatus(`New v${N1}`, 15000, { absent: true })
    }
  )
  await step(
    P,
    `抢先版上又出了一版（只有清单的 1.999.2）：点刷新图标，按钮上的版本号变成 1.999.2（PR269）`,
    async () => {
      await b.switchToWindow("settings")
      await clickSel("#update-channel-early")
      await waitText(`Upgrade to v${N1}`)
      feed.publish("1.999.2", { package: null })
      await clickSel('button[aria-label="Check for updates"]')
      await waitText("Upgrade to v1.999.2")
      await shot("A-05-recheck-newer")
      // 撤掉 1.999.2（它没有包），再刷新一次回到 N+1
      feed.unpublish("1.999.2")
      await clickSel('button[aria-label="Check for updates"]')
      await waitText(`Upgrade to v${N1}`)
    }
  )
  await step(
    P,
    `点「Upgrade to v${N1}」：下载完状态栏是「Restart to update」，包存在 update/staged/${N1}/（0700 / 0600），装着的还是 N`,
    async () => {
      const t = Date.now()
      await downloadTo(N1)
      const dir = join(dataDir, "update", "staged", N1)
      must(existsSync(dir), `没有 ${dir}`)
      const mode = (p) => (statSync(p).mode & 0o777).toString(8)
      const files = readdirSync(dir).map((f) => `${f}:${mode(join(dir, f))}`)
      must(mode(dir) === "700", `目录权限 ${mode(dir)}`)
      must(
        readdirSync(dir).every((f) => mode(join(dir, f)) === "600"),
        `文件权限 ${files.join(" ")}`
      )
      must(plistVersion() === N, `包已经换了：${plistVersion()}`)
      await shot("A-06-ready")
      return { seconds: (Date.now() - t) / 1000, files }
    }
  )
  await step(
    P,
    `下好以后又出了更新的一版：状态栏弹层和设置页都只写 v${N1}（PR480）`,
    async () => {
      feed.publish("1.999.3", { package: null })
      await b.switchToWindow("settings")
      await clickSel('button[aria-label="Check for updates"]').catch(() => {})
      await sleep(5000)
      const settings = await bodyText()
      must(
        !settings.includes("1.999.3"),
        `设置页出现了 1.999.3：${settings.replace(/\s+/g, " ").slice(0, 300)}`
      )
      await b.switchToWindow("main")
      await openPopover()
      await sleep(500)
      const pop = await b.execute(
        (sel) =>
          [...document.querySelectorAll(sel)]
            .map((e) => e.innerText)
            .join("\n"),
        UPDATE_POP
      )
      await shot("A-07-popover")
      feed.unpublish("1.999.3")
      must(pop.includes(N1), `弹层里没有 ${N1}：${pop.slice(0, 300)}`)
      must(
        !pop.includes("1.999.3"),
        `弹层里出现了 1.999.3：${pop.slice(0, 300)}`
      )
    }
  )
  await step(
    P,
    `状态栏弹层点「Restart to update」：退出、换包、重开进 N+1，只有一个 app 进程（PR396，故事 N5）`,
    async () => {
      const before = appPids()
      await restartFromStatusBar()
      const pid = await connect({ before, timeout: 240000 })
      const v = await versions()
      must(v.running === N1 && v.plist === N1, JSON.stringify(v))
      const pids = appPids()
      must(pids.length === 1, `app 进程：${pids.join(",")}`)
      must(
        logsHave(`installed ${N1}, relaunching into it`),
        "日志里没有「installed …, relaunching into it」"
      )
      await enterLocal()
      await shot("A-08-after-update")
      return { pid, ...v }
    }
  )
  await step(
    P,
    `新版确认跑起来（日志「confirmed running ${N1}」），升级日志记着`,
    async () => {
      await waitLog(`confirmed running ${N1}`, 240000)
      const j = journal()
      notes.journalA = j
      return { last: j?.last_outcome ?? j?.outcome ?? null }
    }
  )
}

async function phaseB() {
  const P = "B"
  // 稳定版：history.json = [N]，N 有自己的包；装着的是 N+1（从抢先版切过来、比稳定版新）
  baseFeed()
  await step(P, `装 N+1（${N1}）、新数据目录，启动`, async () => {
    await installFresh(N1)
    launch()
    await connect()
    await enterLocal()
    const v = await versions()
    must(v.running === N1, JSON.stringify(v))
    return v
  })
  await step(
    P,
    "稳定版、自动更新 Off，点「Roll back」：确认框说回到 v1.999.0（PR643）",
    async () => {
      await openSystemSettings()
      await clickSel("#auto-update-mode-off")
      await clickSel("#update-channel-stable").catch(() => {})
      await sleep(800)
      await clickText("Roll back", { exact: true })
      await waitText(`Roll back to v${N}?`, 60000)
      await shot("B-01-rollback-dialog")
    }
  )
  await step(
    P,
    `确认回退：下的是 v${N} 自己的包（不报找不到包），下好后「Restart to update」（PR643 / PR349）`,
    async () => {
      const since = Date.now()
      await clickText(`Roll back to v${N}`, {
        selector: "[role=alertdialog] button, [role=dialog] button",
      })
      await waitStatus("Restart to update", 600000)
      const got = feed.requested(`/releases/download/v${N}/${pkg(N)}`, since)
      must(
        got.length > 0,
        `没下 v${N} 的包 ${pkg(N)}：${JSON.stringify(feed.requests.slice(-8))}`
      )
      must(
        feed.requested(
          `/api/repos/e2e/fake/contents/src-tauri/src/db/migration/mod.rs`,
          0
        ).length > 0,
        "回退前没读那一版的数据库迁移列表"
      )
    }
  )
  await step(P, `重启：回到 N（${N}），app 正常打开`, async () => {
    const before = appPids()
    await fire("restart_app")
    await connect({ before, timeout: 240000 })
    await enterLocal()
    const v = await versions()
    must(v.running === N && v.plist === N, JSON.stringify(v))
    await shot("B-02-rolled-back")
    return v
  })
}

async function phaseC() {
  const P = "C"
  baseFeed()
  let before = []
  await step(P, `装 N、新数据目录、Off + 抢先版，下好 N+1`, async () => {
    await installFresh(N)
    launch()
    await connect()
    await enterLocal()
    await openSystemSettings()
    await clickSel("#auto-update-mode-off")
    await clickSel("#update-channel-early")
    await waitText(`Upgrade to v${N1}`)
    await downloadTo(N1)
  })
  await step(
    P,
    "点重启，重启意图一写下（resume:false）就在安装中途 kill -9 主进程（PR642）",
    async () => {
      before = appPids()
      const intent = join(dataDir, "restart-intent.json")
      await fire("restart_app")
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !existsSync(intent)) await sleep(20)
      must(existsSync(intent), "30 秒内没写 restart-intent.json")
      const raw = readFileSync(intent, "utf8")
      await sleep(800)
      sh("kill", ["-9", ...before])
      await disconnect()
      notes.intentAtKill = raw
      must(
        /"resume"\s*:\s*false/.test(raw),
        `重启意图不是 resume:false：${raw.slice(0, 200)}`
      )
      return raw.slice(0, 200)
    }
  )
  await step(
    P,
    "再打开：app 正常起来，包没坏（还是 N 或已是 N+1），日志说重启意图不算数、不自动接着做",
    async () => {
      await sleep(3000)
      const v0 = plistVersion()
      must(v0 === N || v0 === N1, `Info.plist 的版本：${v0}`)
      const sig = sh("codesign", ["--verify", "--deep", "--strict", APP])
      must(sig.code === 0, `包的签名坏了：${sig.out.slice(0, 200)}`)
      launch()
      await connect({ before })
      await enterLocal()
      // 本机服务停机时记下的名单（restart-resume.json，新进程起来改名成 .done.json）带着的重启意图必须是 resume:false；
      // 强杀以后服务没来得及记的，就没有名单、什么都不接。两种都不能有「conversation resumed」
      const saidNo = await waitLog("[restart] not resuming", 90000).catch(
        () => false
      )
      const recorded = ["restart-resume.json", "restart-resume.done.json"]
        .map((f) => join(dataDir, f))
        .filter(existsSync)
        .map((f) => readFileSync(f, "utf8"))
      for (const raw of recorded)
        must(
          !/"resume"\s*:\s*true/.test(raw),
          `停机名单里的重启意图是 resume:true：${raw.slice(0, 200)}`
        )
      must(
        !logsHave("[restart] conversation resumed"),
        "日志里有「conversation resumed」"
      )
      const v = await versions()
      notes.afterKill = { ...v, saidNo: !!saidNo, recorded: recorded.length }
      await shot("C-01-after-kill")
      return notes.afterKill
    }
  )
}

async function phaseD() {
  const P = "D"
  baseFeed()
  let terminalId = null
  let pidN = null
  await step(
    P,
    "装 N、新数据目录，本机 daemon 里开一个跑着长命令的终端",
    async () => {
      await installFresh(N)
      launch()
      pidN = await connect()
      await enterLocal()
      terminalId = `e2e-long-task-${Date.now()}`
      const args = {
        workingDir: homedir(),
        working_dir: homedir(),
        initialCommand: "sleep 1800",
        initial_command: "sleep 1800",
        terminalId,
        terminal_id: terminalId,
      }
      const id = await daemon("terminal_spawn", args)
      if (typeof id === "string") terminalId = id
      const list = await daemon("terminal_list", {})
      must(
        Array.isArray(list) && list.length > 0,
        `terminal_list：${JSON.stringify(list).slice(0, 200)}`
      )
      return { terminalId, terminals: list.length }
    }
  )
  await step(
    P,
    "自动更新设成「Install automatically」、抢先版，下好 N+1",
    async () => {
      await openSystemSettings()
      await clickSel("#auto-update-mode-auto")
      await clickSel("#update-channel-early")
      // 自动安装档查到就自己下（设置页那时已经没有升级按钮）；两分钟没下好再去点升级
      const ready = await waitStatus("Restart to update", 120000).catch(
        () => false
      )
      if (!ready) await downloadTo(N1)
      await waitStatus("Restart to update", 600000)
    }
  )
  await step(
    P,
    "开着终端时等 150 秒：没有自动重启，升级日志记下 blocked.terminal（PR592）",
    async () => {
      await sleep(150000)
      must(appPids().includes(pidN), `app 重启了：${appPids().join(",")}`)
      const j = journal()
      notes.journalD = j
      const blocked = j?.attempt?.blocked ?? j?.blocked ?? {}
      must(Number(blocked.terminal) > 0, `blocked：${JSON.stringify(blocked)}`)
      return blocked
    }
  )
  await step(
    P,
    "关掉终端：空闲两次检查以后自己重启进 N+1（后台打开，--relaunched-in-background）",
    async () => {
      await daemon("terminal_kill", { terminalId, terminal_id: terminalId })
      const before = [pidN]
      await disconnect()
      const pid = await connect({ before, timeout: 360000 })
      const v = await versions()
      must(v.running === N1, JSON.stringify(v))
      const args = argsOf(pid)
      notes.idleRelaunchArgs = args
      must(args.includes("--relaunched-in-background"), `新进程的参数：${args}`)
      await shot("D-01-idle-restarted")
      return { ...v, args }
    }
  )
}

async function phaseE() {
  const P = "E"
  baseFeed()
  await step(
    P,
    "装模拟的旧纯客户端版（1.999.0、不带 codeg-server），更新地址 latest-client.json",
    async () => {
      await installFresh("client", "latest-client.json")
      must(
        !existsSync(join(APP, "Contents", "MacOS", "codeg-server")),
        "包里还有 codeg-server"
      )
      launch()
      await connect()
      const mode = await b.execute(
        () => window.__CODEG_LOCAL_DAEMON__?.mode ?? null
      )
      notes.clientMode = mode
      must(mode !== "child", `没有 codeg-server 还是 child：${mode}`)
      return { mode }
    }
  )
  await step(
    P,
    "抢先版查到 N+1（从 latest-client.json），下好，重启",
    async () => {
      await openSystemSettings()
      await clickSel("#auto-update-mode-off")
      await clickSel("#update-channel-early")
      await waitText(`Upgrade to v${N1}`)
      const deadline = Date.now() + 30000
      const asked = () =>
        feed.requested("/releases/latest/download/latest-client.json").length
      while (Date.now() < deadline && !asked()) await sleep(500)
      must(
        asked() > 0,
        `没查 latest-client.json：${JSON.stringify(feed.requests.slice(-6))}`
      )
      await downloadTo(N1)
      const before = appPids()
      await fire("restart_app")
      await connect({ before, timeout: 240000 })
    }
  )
  await step(
    P,
    "换成了完整版：N+1、包里有 codeg-server、本机 daemon 是子进程（child）",
    async () => {
      const v = await versions()
      must(v.running === N1 && v.plist === N1, JSON.stringify(v))
      must(
        existsSync(join(APP, "Contents", "MacOS", "codeg-server")),
        "包里没有 codeg-server"
      )
      const deadline = Date.now() + 60000
      let mode = null
      while (Date.now() < deadline) {
        mode = await b
          .execute(() => window.__CODEG_LOCAL_DAEMON__?.mode ?? null)
          .catch(() => null)
        if (mode === "child") break
        await sleep(1000)
      }
      must(mode === "child", `本机 daemon：${mode}`)
      await enterLocal()
      await shot("E-01-full-edition")
      return { ...v, mode }
    }
  )
}

const PHASE_FNS = { A: phaseA, B: phaseB, C: phaseC, D: phaseD, E: phaseE }

feed = await startFeed({
  port: FEED_PORT,
  root,
  packagesDir: join(WORK, "feed"),
  arch: ARCH,
})
let failed = 0
try {
  for (const p of PHASES) {
    skipRest = null
    const fn = PHASE_FNS[p]
    if (!fn) throw new Error(`不认识的段 ${p}`)
    const tp = Date.now()
    await fn()
    console.log(`[update] 段 ${p}：${((Date.now() - tp) / 1000).toFixed(0)} 秒`)
    // 每段的 app 日志留一份
    if (dataDir && existsSync(join(dataDir, "logs")))
      sh("cp", ["-R", join(dataDir, "logs"), join(OUT, `app-logs-${p}`)])
  }
} finally {
  writeResult()
  failed = summary()
  await quitApp().catch(() => {})
  rmSync(ENV_FILE, { force: true })
  await feed.close()
}
process.exit(failed ? 1 : 0)
