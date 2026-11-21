// 两个 spec 共用的小工具：等界面、调 Tauri 命令、点击（记下是怎么点成的）、截图、把每一步的用时写进 result-phase<N>.json
import { execFileSync } from "node:child_process"
import { writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import process from "node:process"

export const OUT = resolve(process.env.E2E_OUT || "e2e-out")
export const PHASE = process.env.E2E_PHASE || "1"
// 主窗口显示本机工作区还是开始页（src/lib/cowork/start-page.ts）
export const MAIN_VIEW_KEY = "cowork:main-window-view:v1"
export const MARKER_KEY = "desktop-e2e-spike"

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
  }))

// 等当前窗口加载完、画出按钮
export async function waitForUi(timeout = 120000) {
  let state = null
  await browser.waitUntil(
    async () => {
      state = await pageState()
      return state.ready === "complete" && state.buttons > 0
    },
    { timeout, interval: 300, timeoutMsg: "界面没画出来" }
  )
  // 显式切一次到当前窗口：@wdio/tauri-service 在每次 $ / click / getTitle 之前要「找焦点窗口」，靠的是
  // tauri-plugin-wdio 的命令；我们没装那个插件，每次都要空等 ~10 秒（run 44936024276 Linux 那格）。
  // 用户自己 switchToWindow 过，服务就不再自动找（window.ts 的 userSwitchedWindowCache）
  await browser.switchToWindow(await browser.getWindowHandle())
  return state
}

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

// 点一个元素。先用 WebDriver 的点击；没生效（check 返回假）再退到页面里派发 pointer/mouse 事件
// （Radix 的菜单按钮认 pointerdown）。返回怎么点成的
export async function click(selector, check, label) {
  const el = await $(selector)
  await el.waitForDisplayed({ timeout: 20000 })
  let how = "WebDriver elementClick"
  try {
    await el.click()
  } catch (e) {
    how = `elementClick 报错：${e.message.slice(0, 200)}`
  }
  const worked = await browser
    .waitUntil(check, { timeout: 4000, interval: 200 })
    .catch(() => false)
  if (worked) {
    notes[`click:${label}`] = how
    return how
  }
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
    node.dispatchEvent(
      new PointerEvent("pointerdown", {
        ...at,
        pointerType: "mouse",
        pointerId: 1,
      })
    )
    node.dispatchEvent(new MouseEvent("mousedown", at))
    node.dispatchEvent(
      new PointerEvent("pointerup", {
        ...at,
        pointerType: "mouse",
        pointerId: 1,
      })
    )
    node.dispatchEvent(new MouseEvent("mouseup", at))
    node.dispatchEvent(new MouseEvent("click", at))
  }, el)
  await browser.waitUntil(check, {
    timeout: 10000,
    interval: 200,
    timeoutMsg: `${label}：WebDriver 点击和页面里派发事件都没生效（${how}）`,
  })
  how = `${how} 没生效 → 页面里派发事件`
  notes[`click:${label}`] = how
  return how
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
