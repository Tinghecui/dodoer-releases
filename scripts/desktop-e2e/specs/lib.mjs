// 各段 spec 共用的小工具：等界面、选主窗口、调 Tauri 命令、点击、截图、把每一步的用时写进 result-phase<N>.json
// （scripts/desktop-e2e/run.sh 拿它写公开日志里的摘要表）
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"

export const OUT = resolve(process.env.E2E_OUT || "e2e-out")
export const PHASE = process.env.E2E_PHASE || "1"
// 主窗口显示本机工作区还是开始页（src/lib/cowork/start-page.ts）
export const MAIN_VIEW_KEY = "cowork:main-window-view:v1"
export const MARKER_KEY = "desktop-e2e"
export const START_TITLE = "Where do you want to work?"

const t0 = Date.now()
const steps = []
export const notes = {}

// 记一步：名字、过没过、用了几秒、细节
export async function step(name, fn) {
  const start = Date.now()
  try {
    const detail = (await fn()) ?? ""
    steps.push({ name, ok: true, seconds: (Date.now() - start) / 1000, detail })
    console.log(`[e2e] PASS ${name} ${JSON.stringify(detail).slice(0, 400)}`)
  } catch (e) {
    steps.push({
      name,
      ok: false,
      seconds: (Date.now() - start) / 1000,
      detail: String(e?.message || e).slice(0, 800),
    })
    console.log(`[e2e] FAIL ${name} ${String(e?.message || e).slice(0, 800)}`)
    await shot(`fail-${steps.length}`)
    throw e
  }
}

export function writeResult() {
  writeFileSync(
    join(OUT, `result-phase${PHASE}.json`),
    JSON.stringify(
      {
        phase: PHASE,
        platform: process.platform,
        arch: process.arch,
        totalSeconds: (Date.now() - t0) / 1000,
        steps,
        notes,
      },
      null,
      2
    )
  )
}

export async function shot(name) {
  try {
    await browser.saveScreenshot(join(OUT, `phase${PHASE}-${name}.png`))
  } catch (e) {
    console.log(`[e2e] 截图 ${name} 失败：${e.message}`)
  }
}

export const pageState = () =>
  browser.execute(() => ({
    href: location.href,
    ready: document.readyState,
    title: document.title,
    buttons: document.querySelectorAll("button").length,
    tauri: typeof window.__TAURI_INTERNALS__,
    wdio: typeof window.wdioTauri === "object",
  }))

// 等当前窗口加载完、画出按钮。e2e 版的前端带着 @wdio/tauri-plugin（window.wdioTauri），tauri-service 靠它
// 找焦点窗口；没有它每次 $ / click 之前要空等 ~10 秒（run 44936024276），所以这里也等它就位
export async function waitForUi(timeout = 120000) {
  let state = null
  await browser.waitUntil(
    async () => {
      state = await pageState()
      return state.ready === "complete" && state.buttons > 0 && state.wdio
    },
    {
      timeout,
      interval: 300,
      timeoutMsg: "界面没画出来，或者 window.wdioTauri 不在",
    }
  )
  return state
}

// 显式选中主窗口。显式选过窗口以后 tauri-service 就不再在每条命令前自动找焦点窗口：页面正在换（工作区 ↔ 开始页）时
// 那一步偶尔卡到 30 秒的脚本超时（#1189 第 3 次重跑），切窗口都由 spec 自己来
export async function useMainWindow() {
  await browser.tauri.switchWindow("main")
}

// 开始页画出来：标题和「本机」那一段
export async function waitStartPage(timeout = 60000) {
  await $("#start-local").waitForExist({ timeout })
  const h1 = await textOf("h1")
  if (h1 !== START_TITLE) throw new Error(`h1=${h1}`)
  return h1
}

// 本机工作区画出来：没有开始页，有侧栏脚上的「快捷操作」按钮
export async function waitWorkspace(timeout = 60000) {
  await browser.waitUntil(
    () =>
      browser.execute(
        () =>
          !document.getElementById("start-local") &&
          !!document.querySelector('button[title="Quick actions"]')
      ),
    { timeout, interval: 300, timeoutMsg: "没进本机工作区" }
  )
}

// 等页面上出现一段字（body 的 innerText）：工作区先画出侧栏，会话区的字晚一点才出来（#1207 Linux 那次 0.4 秒就去读，没读到）
export async function waitText(text, timeout = 20000) {
  let last = ""
  const found = await browser
    .waitUntil(
      async () => {
        last = await browser.execute(() => document.body.innerText)
        return last.includes(text)
      },
      { timeout, interval: 300 }
    )
    .catch(() => false)
  if (!found) throw new Error(`没有「${text}」：${last.slice(0, 200)}`)
}

// 等 WebKit 把 localStorage 落盘再让 app 退出（tauri-service 收尾时直接杀 app）
export const flushStorage = () => browser.pause(3000)

// 调一个 Tauri 命令，返回 { ok } 或 { err }
export const invoke = (cmd, payload = {}) =>
  browser.executeAsync(
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

export const lsGet = (key) =>
  browser.execute((k) => localStorage.getItem(k), key)

// 一个元素看得见的文字（innerText，不是 textContent：macOS 插件的 getText 返回 textContent，会带上 script / style）
export const textOf = (selector) =>
  browser.execute(
    (sel) => document.querySelector(sel)?.innerText ?? null,
    selector
  )

// 普通按钮：WebDriver 的 elementClick
export async function click(selector) {
  const el = await $(selector)
  await el.waitForDisplayed({ timeout: 20000 })
  await el.click()
}

// Radix 的菜单按钮 / 菜单项认 pointerdown，macOS 插件的 elementClick 只是 el.click()（spike 3/3 点不开），
// 所以在页面里按真实点击的顺序派发 pointer / mouse 事件（Linux 的 WebKitWebDriver 也一样用这条，两边同一条路）
export async function pointerClick(selector) {
  const el = await $(selector)
  await el.waitForDisplayed({ timeout: 20000 })
  await browser.execute((node) => {
    const r = node.getBoundingClientRect()
    const at = {
      bubbles: true,
      cancelable: true,
      composed: true,
      button: 0,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
    }
    const pointer = {
      ...at,
      pointerType: "mouse",
      pointerId: 1,
      isPrimary: true,
    }
    node.dispatchEvent(new PointerEvent("pointerdown", pointer))
    node.dispatchEvent(new MouseEvent("mousedown", at))
    node.dispatchEvent(new PointerEvent("pointerup", pointer))
    node.dispatchEvent(new MouseEvent("mouseup", at))
    node.dispatchEvent(new MouseEvent("click", at))
  }, el)
}

export function codegPids() {
  try {
    return execFileSync("pgrep", ["-x", "codeg"], { encoding: "utf8" })
      .split(/\s+/)
      .filter(Boolean)
  } catch {
    return []
  }
}
