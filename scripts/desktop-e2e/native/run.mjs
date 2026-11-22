// 桌面版原生层测试（公开镜像 desktop-e2e.yml 在 macOS 上调）：Appium 4 + Mac2 驱动按辅助功能（AX）树点原生的东西——
// 菜单栏、托盘菜单、设置 / 远程窗口的开关和位置、文件对话框、「重启以更新」弹层、多窗口焦点。WebDriver（DOM）碰不到这些，
// 而且 Appium 的点击是真的鼠标事件（DOM 那套是页面里派发的事件）。
// 同时连着 app 里内嵌的 WebDriver（127.0.0.1:4445）：准备状态（开窗口、下好更新）和核对网页里的结果用它。
//
// 用的是更新流程测试同一个 e2e 测试版、同一套测试包（update/prepare.sh 的输出）和同一个假更新源（update/feed.mjs）：
// 「重启以更新」弹层要先有一个下好的更新。
//
//   环境：E2E_UPDATE_WORK（prepare.sh 的输出目录，必填）、E2E_OUT（默认 e2e-out；本段的东西在 $E2E_OUT/native/）、
//        APPIUM_URL（默认 http://127.0.0.1:4723，workflow 起的 Appium）
//   只在 CI 机器上跑（CI=true）：会换掉 ~/Applications/dodoer.app、杀 codeg 进程
// 来历：源仓库 .cowork/journal/2026-11-22-e2e-native-appium.md
import { spawn, spawnSync, execFileSync } from "node:child_process"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"
import { fileURLToPath } from "node:url"
import { remote } from "webdriverio"
import { startFeed } from "../update/feed.mjs"

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
const OUT = join(resolve(root, process.env.E2E_OUT || "e2e-out"), "native")
mkdirSync(OUT, { recursive: true })
const APPIUM = new URL(process.env.APPIUM_URL || "http://127.0.0.1:4723")
const ARCH = readFileSync(join(WORK, "arch"), "utf8").trim()
const PUBKEY = readFileSync(
  join(WORK, "keys", "e2e-updater.key.pub"),
  "utf8"
).trim()
const APP = join(homedir(), "Applications", "dodoer.app")
const ENV_FILE = join(homedir(), ".codeg-e2e.env")
const BUNDLE_ID = "app.codeg"
const FEED_PORT = 47002
const WD_PORT = 4445
const REMOTE_PORT = 3982
const N = "1.999.0"
const N1 = "1.999.1"
const pkg = (v) => `dodoer-${v}-macos-${ARCH}.app.tar.gz`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ───────── 结果（同 update/run.mjs）─────────
const t0 = Date.now()
const steps = []
const notes = {}

async function step(name, fn) {
  const start = Date.now()
  try {
    const detail = (await fn()) ?? ""
    steps.push({ name, ok: true, seconds: (Date.now() - start) / 1000, detail })
    console.log(`[native] PASS ${name} ${JSON.stringify(detail).slice(0, 400)}`)
    return detail
  } catch (e) {
    const msg = String(e?.message || e).slice(0, 800)
    steps.push({
      name,
      ok: false,
      seconds: (Date.now() - start) / 1000,
      detail: msg,
    })
    console.log(`[native] FAIL ${name} ${msg}`)
    await screen(`fail-${steps.length}`)
    await axDump(`fail-${steps.length}`)
    return undefined
  }
}

function must(cond, detail) {
  if (!cond) throw new Error(detail)
}

function finish() {
  writeFileSync(
    join(OUT, "result-native.json"),
    JSON.stringify(
      {
        phase: "native",
        platform: process.platform,
        arch: ARCH,
        totalSeconds: (Date.now() - t0) / 1000,
        steps,
        notes,
        feedRequests: feed?.requests ?? [],
      },
      null,
      2
    )
  )
  const esc = (s) =>
    String(s).replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 160)
  const failed = steps.filter((s) => !s.ok).length
  const text = [
    `### 桌面原生层（Appium Mac2，macOS ${ARCH}）：${failed ? `${failed} 项没过` : "全过"}`,
    "",
    "| 步骤 | 结果 | 秒 |",
    "| --- | --- | --- |",
    ...steps.map(
      (s) =>
        `| ${esc(s.name)}${s.ok ? "" : `：${esc(s.detail)}`} | ${s.ok ? "过" : "**没过**"} | ${s.seconds.toFixed(1)} |`
    ),
    "",
  ].join("\n")
  console.log(text)
  writeFileSync(join(OUT, "summary.md"), text + "\n")
  if (process.env.GITHUB_STEP_SUMMARY)
    writeFileSync(process.env.GITHUB_STEP_SUMMARY, text + "\n", { flag: "a" })
  return failed
}

// ───────── app 和两个会话：dom（app 里的 WebDriver）、ax（Appium Mac2）─────────
let dom = null
let ax = null
let feed = null
let dataDir = null
let remoteServer = null

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 120000 })
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") }
}
function appPids() {
  if (!existsSync(APP)) return []
  const exe =
    sh("defaults", [
      "read",
      join(APP, "Contents", "Info.plist"),
      "CFBundleExecutable",
    ]).out.trim() || "codeg"
  return sh("pgrep", ["-f", `^${APP}/Contents/MacOS/${exe}( |$)`])
    .out.split(/\s+/)
    .filter((s) => /^\d+$/.test(s))
}
function allAppPids() {
  return sh("pgrep", ["-f", `^${APP}/Contents/MacOS/`])
    .out.split(/\s+/)
    .filter((s) => /^\d+$/.test(s))
}
async function quitApp() {
  if (dom) await dom.deleteSession().catch(() => {})
  dom = null
  for (const sig of ["-TERM", "-KILL"]) {
    const pids = allAppPids()
    if (!pids.length) return
    sh("kill", [sig, ...pids])
    for (let i = 0; i < 40 && allAppPids().length; i++) await sleep(250)
  }
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

async function domUi(label, timeout = 120000) {
  const deadline = Date.now() + timeout
  let last = ""
  while (Date.now() < deadline) {
    try {
      await dom.switchToWindow(label)
      const s = await dom.execute(() => ({
        ready: document.readyState,
        buttons: document.querySelectorAll("button").length,
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

const invoke = (cmd, payload = {}) =>
  dom.executeAsync(
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
const bodyText = () => dom.execute(() => document.body.innerText)
async function waitText(text, timeout = 30000, { absent = false } = {}) {
  const deadline = Date.now() + timeout
  let last = ""
  while (Date.now() < deadline) {
    last = await bodyText().catch(() => "")
    if (last.includes(text) !== absent) return
    await sleep(400)
  }
  throw new Error(
    `${absent ? "还有" : "没有"}「${text}」：${last.replace(/\s+/g, " ").slice(0, 240)}`
  )
}
// 页面里点（准备状态用；要测真点击的都走 ax）
async function domClick(selector, text = null) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    const ok = await dom
      .execute(
        (sel, txt) => {
          const el = [...document.querySelectorAll(sel)].find((e) => {
            const r = e.getBoundingClientRect()
            if (!(r.width > 0 && r.height > 0) || e.disabled) return false
            return txt === null || (e.innerText || "").includes(txt)
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
        text
      )
      .catch(() => false)
    if (ok) return
    await sleep(300)
  }
  throw new Error(`点不到 ${selector}${text ? `「${text}」` : ""}`)
}
const handles = () => dom.getWindowHandles()

// ───────── Appium（AX）小工具 ─────────
// 元素：XPath 按类型和 title / label / identifier 找。Mac2 的属性名见 appium-mac2-driver 的 README
const byTitle = (type, title) =>
  `//${type}[@title=${JSON.stringify(title)} or @label=${JSON.stringify(title)} or @identifier=${JSON.stringify(title)}]`
async function axFind(xpath, timeout = 20000) {
  const el = await ax.$(xpath)
  await el.waitForExist({ timeout, timeoutMsg: `AX 树里没有 ${xpath}` })
  return el
}
// 合上的菜单、关掉的面板：AX 树里多半还在，只是大小是 0（菜单项合上后是 x=0 y=屏幕高 0×0）
async function axHidden(xpath, timeout = 10000) {
  const deadline = Date.now() + timeout
  let last = null
  while (Date.now() < deadline) {
    const els = await ax.$$(xpath).catch(() => [])
    let shown = false
    for (const el of els) {
      const r = await ax.getElementRect(el.elementId).catch(() => null)
      if (r && r.width > 0 && r.height > 0) {
        shown = true
        last = r
      }
    }
    if (!shown) return
    await sleep(400)
  }
  throw new Error(
    `${timeout / 1000} 秒后还看得见 ${xpath}：${JSON.stringify(last)}`
  )
}
// 真的鼠标点元素的中心（不走 XCUIElement.click：别的进程画的面板，比如文件对话框，那样点不进去）
async function axClickCenter(el) {
  const r = await ax.getElementRect(el.elementId)
  await ax.execute("macos: click", {
    x: Math.round(r.x + r.width / 2),
    y: Math.round(r.y + r.height / 2),
  })
  return r
}
// 切到标题是 title 的窗口：Window 菜单里的窗口列表；没有这一项就按 ⌘`（下一个窗口）
async function focusWindow(title) {
  await (await axFind(byTitle("XCUIElementTypeMenuBarItem", "Window"))).click()
  const item = await ax.$(
    `//XCUIElementTypeMenuBarItem[@title='Window']//XCUIElementTypeMenuItem[@title=${JSON.stringify(title)}]`
  )
  if (await item.waitForExist({ timeout: 3000 }).catch(() => false)) {
    await item.click()
    return "Window 菜单"
  }
  await escape()
  await ax.execute("macos: keys", {
    keys: [{ key: "`", modifierFlags: 1 << 4 }],
  })
  return "⌘`"
}
const escape = () =>
  ax.execute("macos: keys", { keys: [{ key: "XCUIKeyboardKeyEscape" }] })
const axWindows = async () => {
  const els = await ax.$$("//XCUIElementTypeWindow")
  const out = []
  for (const el of els) {
    out.push({
      title: await el.getAttribute("title").catch(() => null),
      identifier: await el.getAttribute("identifier").catch(() => null),
      rect: await ax.getElementRect(el.elementId).catch(() => null),
      el,
    })
  }
  return out
}
// 窗口在主屏幕里（至少一半在）
async function onScreen(rect) {
  const info = await ax.execute("macos: deviceScreenInfo").catch(() => null)
  notes.screen = info
  const w = info?.screenSize?.width ?? info?.width ?? 1920
  const h = info?.screenSize?.height ?? info?.height ?? 1080
  const cx = rect.x + rect.width / 2
  const cy = rect.y + rect.height / 2
  return cx > 0 && cy > 0 && cx < w && cy < h
}
async function screen(name) {
  if (!ax) return
  try {
    const b64 = await ax.takeScreenshot()
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(b64, "base64"))
  } catch {
    // 拿不到截图
  }
}
async function axDump(name) {
  if (!ax) return
  try {
    writeFileSync(join(OUT, `${name}-ax.xml`), await ax.getPageSource())
  } catch {
    // 拿不到
  }
}
const domFocus = (label) =>
  dom.switchToWindow(label).then(() => dom.execute(() => document.hasFocus()))

// ───────── 跑 ─────────
feed = await startFeed({
  port: FEED_PORT,
  root,
  packagesDir: join(WORK, "feed"),
  arch: ARCH,
})
let failed = 0
try {
  await step(
    `准备：装 e2e 测试版 N（${N}），连上 app 里的 WebDriver`,
    async () => {
      await quitApp()
      rmSync(APP, { recursive: true, force: true })
      mkdirSync(join(homedir(), "Applications"), { recursive: true })
      execFileSync("ditto", [join(WORK, "apps", N, "dodoer.app"), APP])
      dataDir = mkdtempSync(join(tmpdir(), "e2e-native-data-"))
      rmSync(join(homedir(), ".codeg", "preferences.json"), { force: true })
      // 网页那边的存储按 bundle id 存（前面更新流程那几段留下的「查到的更新」「关掉的提示」）
      for (const d of ["WebKit", "Caches"])
        rmSync(join(homedir(), "Library", d, "app.codeg"), {
          recursive: true,
          force: true,
        })
      feed.publish(N, { package: pkg(N) })
      feed.promote(N)
      feed.publish(N1, { package: pkg(N1) })
      writeFileSync(
        ENV_FILE,
        [
          `CODEG_DATA_DIR=${dataDir}`,
          `CODEG_HOME=${dataDir}`,
          `CODEG_E2E_UPDATER_ENDPOINTS=${feed.endpoint()}`,
          `CODEG_E2E_UPDATER_PUBKEY=${PUBKEY}`,
          `TAURI_WEBDRIVER_PORT=${WD_PORT}`,
          "CODEG_TELEMETRY_ENV=ci",
          "",
        ].join("\n")
      )
      must(sh("open", ["-n", APP]).code === 0, "open -n 失败")
      const deadline = Date.now() + 120000
      while (Date.now() < deadline && !appPids().length) await sleep(300)
      must(await wdReady(120000), "WebDriver 服务器（4445）没答话")
      dom = await remote({
        hostname: "127.0.0.1",
        port: WD_PORT,
        path: "/",
        capabilities: {},
        logLevel: "warn",
      })
      await domUi("main")
      // 开始页就点「本机」
      for (let i = 0; i < 120; i++) {
        const where = await dom.execute(() =>
          document.getElementById("start-local")
            ? "start"
            : document.querySelector('button[title="Quick actions"]')
              ? "local"
              : "loading"
        )
        if (where === "local") break
        if (where === "start") await domClick("#start-local")
        await sleep(500)
      }
      return { pids: appPids() }
    }
  )

  await step("Appium Mac2 会话：按 bundle id 接上正在跑的 app", async () => {
    ax = await remote({
      protocol: APPIUM.protocol.replace(":", ""),
      hostname: APPIUM.hostname,
      port: Number(APPIUM.port),
      path: "/",
      logLevel: "warn",
      connectionRetryTimeout: 600000,
      capabilities: {
        platformName: "mac",
        "appium:automationName": "Mac2",
        "appium:bundleId": BUNDLE_ID,
        "appium:noReset": true,
        "appium:skipAppKill": true,
        // 第一次要现编 WebDriverAgentMac（xcodebuild），给足时间
        "appium:serverStartupTimeout": 600000,
        "appium:showServerLogs": false,
      },
    })
    const wins = await axWindows()
    must(wins.length >= 1, "AX 树里没有窗口")
    await screen("01-session")
    return wins.map((w) => ({ title: w.title, rect: w.rect }))
  })
  if (!ax) throw new Error("Appium 会话没起来，后面的都测不了")

  await step(
    "菜单栏：dodoer / File / Edit / View / Window / Help",
    async () => {
      const items = await ax.$$(
        "//XCUIElementTypeMenuBar//XCUIElementTypeMenuBarItem"
      )
      const titles = []
      for (const el of items) titles.push(await el.getAttribute("title"))
      notes.menuBar = titles
      for (const want of ["File", "Edit", "View", "Window", "Help"])
        must(titles.includes(want), `菜单栏里没有 ${want}：${titles.join(",")}`)
      return titles
    }
  )

  await step(
    "Window 菜单：真的点开，有 Open Local Workspace / Minimize，Esc 收起",
    async () => {
      await (
        await axFind(byTitle("XCUIElementTypeMenuBarItem", "Window"))
      ).click()
      await axFind(byTitle("XCUIElementTypeMenuItem", "Open Local Workspace"))
      await axFind(byTitle("XCUIElementTypeMenuItem", "Minimize"))
      await screen("02-window-menu")
      await escape()
      await axHidden(
        byTitle("XCUIElementTypeMenuItem", "Open Local Workspace"),
        10000
      )
    }
  )

  await step("app 菜单「About」：关于面板写着 1.999.0，关掉", async () => {
    // app 自己的菜单：菜单栏里除了苹果菜单和 File / Edit / View / Window / Help 的那一个
    const fixed = ["Apple", "File", "Edit", "View", "Window", "Help"]
    let appMenu = null
    for (const el of await ax.$$(
      "//XCUIElementTypeMenuBar//XCUIElementTypeMenuBarItem"
    )) {
      const title = await el.getAttribute("title")
      if (title && !fixed.includes(title)) {
        appMenu = el
        notes.appMenu = title
        break
      }
    }
    must(
      appMenu,
      `菜单栏里找不到 app 自己的菜单：${JSON.stringify(notes.menuBar)}`
    )
    await appMenu.click()
    // 只在 app 自己的菜单里找（苹果菜单里的「About This Mac」也以 About 开头，合着的时候也在 AX 树里）
    const about = await appMenu.$(
      ".//XCUIElementTypeMenuItem[starts-with(@title, 'About')]"
    )
    await about.waitForExist({ timeout: 10000 })
    notes.aboutItem = await about.getAttribute("title")
    await about.click()
    const version = await axFind(
      `//*[contains(@value, '${N}') or contains(@title, '${N}') or contains(@label, '${N}')]`,
      15000
    )
    notes.aboutVersion = await version.getAttribute("value").catch(() => null)
    await screen("03-about")
    await escape()
    await sleep(500)
    // 关于面板 Esc 不一定关：还在就点它的关闭按钮
    const close = await ax.$(
      "//XCUIElementTypeDialog//XCUIElementTypeButton[@identifier='_XCUI:CloseWindow']"
    )
    if (await close.isExisting().catch(() => false)) await close.click()
  })

  await step(
    "托盘：状态栏图标右键，有 Show Workspace / Quit CoTeam，Esc 收起",
    async () => {
      const item = await axFind("//XCUIElementTypeStatusItem", 15000)
      await ax.execute("macos: rightClick", { elementId: item.elementId })
      await axFind(byTitle("XCUIElementTypeMenuItem", "Show Workspace"), 10000)
      await axFind(byTitle("XCUIElementTypeMenuItem", "Quit CoTeam"), 10000)
      await screen("04-tray-menu")
      await escape()
      await axHidden(
        byTitle("XCUIElementTypeMenuItem", "Show Workspace"),
        10000
      )
    }
  )

  let settingsRect = null
  await step(
    "设置窗口：打开后是第二个窗口、在屏幕里、在最前（DOM 里 hasFocus）",
    async () => {
      await dom.switchToWindow("main")
      await call("open_settings_window", { section: "system" })
      await domUi("settings")
      const deadline = Date.now() + 20000
      let wins = []
      while (Date.now() < deadline) {
        wins = await axWindows()
        if (wins.length >= 2) break
        await sleep(500)
      }
      must(wins.length >= 2, `AX 树里只有 ${wins.length} 个窗口`)
      const settings =
        wins.find((w) => /settings|设置/i.test(w.title || "")) || wins[0]
      settingsRect = settings.rect
      must(
        settingsRect && (await onScreen(settingsRect)),
        `设置窗口不在屏幕里：${JSON.stringify(settingsRect)}`
      )
      must(await domFocus("settings"), "设置窗口没拿到焦点")
      await screen("05-settings")
      return wins.map((w) => ({ title: w.title, rect: w.rect }))
    }
  )

  await step(
    "多窗口焦点：用 Window 菜单（没有窗口列表就按 ⌘`）切到主窗口，焦点到主窗口；再切回设置窗口",
    async () => {
      // 运行机屏幕只有 1024×768，设置窗口把主窗口整个盖住，点不到主窗口的标题栏，所以走菜单 / 快捷键
      const wins = await axWindows()
      const settings = wins.find((w) => /settings|设置/i.test(w.title || ""))
      const main = wins.find((w) => w !== settings)
      must(
        main && settings,
        `窗口：${JSON.stringify(wins.map((w) => w.title))}`
      )
      const how = await focusWindow(main.title)
      await sleep(800)
      must(await domFocus("main"), `${how}切到主窗口，主窗口没拿到焦点`)
      must(!(await domFocus("settings")), `${how}切到主窗口，设置窗口还是焦点`)
      const how2 = await focusWindow(settings.title)
      await sleep(800)
      must(
        await domFocus("settings"),
        `${how2}切回设置窗口，设置窗口没拿到焦点`
      )
      return { how, how2, main: main.title, settings: settings.title }
    }
  )

  await step(
    "设置窗口：点红色关闭按钮关掉，DOM 那边窗口也没了；再开回到原来的位置",
    async () => {
      const wins = await axWindows()
      const settings = wins.find((w) => /settings|设置/i.test(w.title || ""))
      must(settings, "找不到设置窗口")
      const close = await settings.el.$(
        ".//XCUIElementTypeButton[@identifier='_XCUI:CloseWindow']"
      )
      await close.click()
      const deadline = Date.now() + 15000
      while (Date.now() < deadline && (await handles()).includes("settings"))
        await sleep(300)
      must(!(await handles()).includes("settings"), "设置窗口没关掉")
      await dom.switchToWindow("main")
      await call("open_settings_window", { section: "system" })
      await domUi("settings")
      await sleep(1000)
      const again = (await axWindows()).find((w) =>
        /settings|设置/i.test(w.title || "")
      )
      notes.settingsReopen = { before: settingsRect, after: again?.rect }
      must(again?.rect, "重开后找不到设置窗口")
      must(
        await onScreen(again.rect),
        `重开后设置窗口不在屏幕里：${JSON.stringify(again.rect)}`
      )
      return notes.settingsReopen
    }
  )

  await step(
    "远程工作区窗口：连本机起的 codeg-server，开窗口、在屏幕里，点关闭按钮关掉",
    async () => {
      const token = `e2e-native-${Date.now()}`
      const remoteDir = mkdtempSync(join(tmpdir(), "e2e-native-remote-"))
      remoteServer = spawn(join(APP, "Contents", "MacOS", "codeg-server"), [], {
        env: {
          ...process.env,
          CODEG_DATA_DIR: remoteDir,
          CODEG_HOME: remoteDir,
          CODEG_HOST: "127.0.0.1",
          CODEG_PORT: String(REMOTE_PORT),
          CODEG_TOKEN: token,
          CODEG_BRIDGE_PORTS: "off",
          CODEG_UPDATE_DISABLED: "1",
          CODEG_TELEMETRY_ENV: "ci",
        },
        stdio: "ignore",
      })
      const url = `http://127.0.0.1:${REMOTE_PORT}`
      let up = false
      for (let i = 0; i < 90 && !up; i++) {
        up = await fetch(`${url}/api/health`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: "{}",
        })
          .then((r) => r.ok)
          .catch(() => false)
        if (!up) await sleep(1000)
      }
      must(up, "远端 codeg-server 90 秒内没起来")
      await dom.switchToWindow("main")
      const conn = await call("create_remote_workspace_connection", {
        input: { name: "e2e-native-remote", baseUrl: url, token, headers: [] },
      })
      const before = (await axWindows()).length
      await call("open_remote_workspace", { id: conn.id })
      const label = `remote-workspace-${conn.id}`
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && !(await handles()).includes(label))
        await sleep(300)
      must((await handles()).includes(label), `没有 ${label}`)
      await domUi(label, 60000)
      let wins = []
      for (let i = 0; i < 40; i++) {
        wins = await axWindows()
        if (wins.length > before) break
        await sleep(500)
      }
      must(wins.length > before, `AX 树里窗口没多：${before} → ${wins.length}`)
      const remoteWin =
        wins.find((w) => /e2e-native-remote/.test(w.title || "")) || wins[0]
      must(
        await onScreen(remoteWin.rect),
        `远程窗口不在屏幕里：${JSON.stringify(remoteWin.rect)}`
      )
      await screen("06-remote-window")
      await (
        await remoteWin.el.$(
          ".//XCUIElementTypeButton[@identifier='_XCUI:CloseWindow']"
        )
      ).click()
      const gone = Date.now() + 15000
      while (Date.now() < gone && (await handles()).includes(label))
        await sleep(300)
      must(!(await handles()).includes(label), "远程窗口没关掉")
      return { title: remoteWin.title, rect: remoteWin.rect }
    }
  )

  await step(
    "文件对话框：打开选文件夹的对话框，点 Cancel，前端拿到的是「没选」",
    async () => {
      await dom.switchToWindow("main")
      await dom.execute(() => {
        window.__e2eDialog = "pending"
        window.__TAURI_INTERNALS__
          .invoke("plugin:dialog|open", {
            options: { directory: true, multiple: false },
          })
          .then(
            (r) =>
              (window.__e2eDialog = r === null ? "none" : JSON.stringify(r)),
            (e) => (window.__e2eDialog = `error:${String(e)}`)
          )
      })
      // 对话框的 Cancel 的 identifier 是 CancelButton（标题也是 Cancel 的按钮别处还有）
      const CANCEL = "//XCUIElementTypeButton[@identifier='CancelButton']"
      const cancel = await axFind(CANCEL, 20000)
      await sleep(500)
      await screen("07-file-dialog")
      const at = await axClickCenter(cancel)
      const deadline = Date.now() + 15000
      let got = "pending"
      while (Date.now() < deadline && got === "pending") {
        got = await dom.execute(() => window.__e2eDialog)
        await sleep(300)
      }
      must(got === "none", `对话框回的是 ${got}（点在 ${JSON.stringify(at)}）`)
      await axHidden(CANCEL, 10000)
    }
  )

  await step(
    `「重启以更新」弹层：下好 N+1 后真的点右上角状态按钮 →「Restart to update」药丸，弹层出来；Esc 收起不重启，再开点弹层里的「Restart to update」重开进 N+1`,
    async () => {
      await dom.switchToWindow("settings")
      await domClick("#auto-update-mode-off")
      await domClick("#update-channel-early")
      // 2026-11-22 公开 main 那次切到抢先版后写的是「已是最新」（假更新源上有 N+1）：再手动查一次，
      // 两次都没有就失败，假更新源收到的请求记在 result-native.json 的 feedRequests 里
      const offered = await waitText(`Upgrade to v${N1}`, 20000).then(
        () => true,
        () => false
      )
      if (!offered) {
        notes.upgradeNotOfferedFirst = (await bodyText()).slice(0, 600)
        await domClick("button", "Check for updates")
        await waitText(`Upgrade to v${N1}`)
      }
      await domClick("button", `Upgrade to v${N1}`)
      await dom.switchToWindow("main")
      // 下好以后右上角状态按钮上出现小圆点（data-status-update）
      const deadline0 = Date.now() + 600000
      while (
        Date.now() < deadline0 &&
        !(await dom
          .execute(() => !!document.querySelector("[data-status-update]"))
          .catch(() => false))
      )
        await sleep(1000)
      const pidBefore = appPids()
      // 主窗口放到前面再点
      const main = (await axWindows()).find(
        (w) => !/settings|设置/i.test(w.title || "")
      )
      if (main) notes.restartFocus = await focusWindow(main.title)
      // 状态按钮的 aria-label 是「Status · Update …」（cowork/status-indicator.tsx）
      // 开弹层的按钮（aria-haspopup）在 AX 里是 PopUpButton，不是 Button：状态按钮的 label 是「Status · update available」；
      // 药丸是 PopUpButton，弹层里那个「Restart to update」是 Button
      // 只在主窗口里找（设置窗口在它后面，也有「Restart to update」）
      const inMain = main
        ? `//XCUIElementTypeWindow[@title=${JSON.stringify(main.title)}]`
        : ""
      const button = (cond) =>
        `${inMain}//*[(self::XCUIElementTypeButton or self::XCUIElementTypePopUpButton) and (${cond})]`
      const STATUS_BTN = button(
        "starts-with(@label, 'Status') or starts-with(@title, 'Status')"
      )
      const PILL = button(
        "contains(@title, 'Restart to update') or contains(@label, 'Restart to update')"
      )
      const updatePopOpen = () =>
        dom
          .execute(() =>
            [
              ...document.querySelectorAll(
                "[data-radix-popper-content-wrapper]"
              ),
            ].some((w) => !w.querySelector("[data-status-bar-right]"))
          )
          .catch(() => false)
      const openPill = async () => {
        await (await axFind(STATUS_BTN, 20000)).click()
        await (await axFind(PILL, 10000)).click()
        const d = Date.now() + 10000
        while (Date.now() < d && !(await updatePopOpen())) await sleep(300)
        must(await updatePopOpen(), "点了药丸，DOM 里更新弹层没开")
      }
      await openPill()
      await screen("08-restart-popover")
      await escape()
      const deadline = Date.now() + 10000
      while (Date.now() < deadline && (await updatePopOpen())) await sleep(300)
      must(!(await updatePopOpen()), "按了 Esc 弹层还在")
      await sleep(2000)
      must(
        JSON.stringify(appPids()) === JSON.stringify(pidBefore),
        "收起弹层 app 却重启了"
      )
      // 再开一次，点弹层里的那个「Restart to update」：它是普通 Button（药丸是 PopUpButton），取看得见的那个
      await escape().catch(() => {})
      await openPill()
      const buttons = await ax.$$(
        `${inMain}//XCUIElementTypeButton[contains(@title, 'Restart to update') or contains(@label, 'Restart to update')]`
      )
      let target = null
      for (const el of buttons) {
        const r = await ax.getElementRect(el.elementId).catch(() => null)
        if (r && r.width > 0 && r.height > 0) target = el
      }
      must(
        target,
        `弹层里没有看得见的「Restart to update」按钮（${buttons.length} 个）`
      )
      await target.click()
      const d2 = Date.now() + 240000
      let pids = appPids()
      while (
        Date.now() < d2 &&
        (pids.length !== 1 || pids[0] === pidBefore[0])
      ) {
        await sleep(1000)
        pids = appPids()
      }
      must(
        pids.length === 1 && pids[0] !== pidBefore[0],
        `没重开：之前 ${pidBefore.join(",")}，现在 ${pids.join(",")}`
      )
      return { pidBefore, pidAfter: pids }
    }
  )
} finally {
  failed = finish()
  if (ax) await ax.deleteSession().catch(() => {})
  if (remoteServer) remoteServer.kill()
  await quitApp().catch(() => {})
  if (dataDir && existsSync(join(dataDir, "logs")))
    sh("cp", ["-R", join(dataDir, "logs"), join(OUT, "app-logs")])
  rmSync(ENV_FILE, { force: true })
  await feed.close()
}
process.exit(failed ? 1 : 0)
