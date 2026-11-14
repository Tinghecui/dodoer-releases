/**
 * Asks the Chrome a person is using whether an outside program may drive it,
 * and prints what it could do there. The measurements `docs/agent-chrome.md`
 * (section 10) needs before any of it is built.
 *
 *     node browser-agent/chrome-connect-probe.mjs
 *
 * Needs Node 22+ (the global WebSocket) and Chrome 144+ with the switch at
 * chrome://inspect/#remote-debugging turned on. Chrome asks the person to
 * allow the connection. It opens a few tabs on example.com, some of them in
 * windows of their own (minimized, or minimized later), and closes them again;
 * nothing else in the browser is touched, and no address or title of the
 * person's own tabs is printed. What only the person at the screen can see —
 * whether Chrome jumped in front of what they were doing — it asks them, a
 * yes or a no at a time.
 *
 * Manual, not part of `pnpm test`: it needs a person's own browser.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { createInterface } from "node:readline/promises"

const lines = []
function say(key, value) {
  lines.push(`${key}: ${value}`)
  console.log(`${key}: ${value}`)
}

if (typeof WebSocket === "undefined") {
  console.log(`需要 Node 22 以上，现在是 ${process.version}`)
  process.exit(1)
}

// Where Chrome writes the port and the browser endpoint once the switch is
// on. Overridable so the probe itself can be tried against a test browser.
const portFile =
  process.env.PROBE_PORT_FILE ??
  join(
    homedir(),
    "Library/Application Support/Google/Chrome/DevToolsActivePort"
  )
let port
let path
if (process.env.PROBE_WS_PATH) {
  // The second line of the file, read some other way (Chrome itself can
  // always open it as a file:// page) when macOS keeps this process out of
  // Chrome's folder.
  port = process.env.PROBE_PORT ?? "9222"
  path = process.env.PROBE_WS_PATH.trim()
} else {
  try {
    ;[port, path] = readFileSync(portFile, "utf8").trim().split("\n")
  } catch (error) {
    // The reason matters: macOS can refuse another app the read of Chrome's
    // profile folder (EPERM), which is a different fix from a switch that is
    // off (ENOENT).
    if (error.code === "EPERM" || error.code === "EACCES") {
      say(
        "端口文件",
        `有，但 macOS 不让终端读它（${error.code}）。到「系统设置 → 隐私与安全性 → 文件与文件夹」里给终端打开「Google Chrome」，再跑一次`
      )
    } else if (error.code === "ENOENT") {
      say("端口文件", "没有（开关没打开，或者这个版本的 Chrome 不写这个文件）")
    } else {
      say("端口文件", `读不到：${error.code ?? ""} ${error.message}`)
    }
    process.exit(1)
  }
}
say(
  "端口文件",
  process.env.PROBE_WS_PATH ? `手动给的，端口 ${port}` : `有，端口 ${port}`
)

function connect(label) {
  return new Promise((resolve) => {
    const started = Date.now()
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`)
    const timer = setTimeout(() => {
      say(label, "90 秒没连上")
      ws.close()
      resolve(null)
    }, 90_000)
    ws.onopen = () => {
      clearTimeout(timer)
      const seconds = Math.round((Date.now() - started) / 1000)
      say(label, `连上了，用了 ${seconds} 秒`)
      resolve(ws)
    }
    ws.onerror = (event) => {
      clearTimeout(timer)
      say(label, `失败 ${event.message ?? ""}`.trim())
      resolve(null)
    }
  })
}

/** `send(method, params, sessionId)` → the reply, or an error after 8 s. */
function cdp(ws) {
  let lastId = 0
  const waiting = new Map()
  ws.onmessage = (message) => {
    const reply = JSON.parse(message.data)
    const done = waiting.get(reply.id)
    if (!done) return
    waiting.delete(reply.id)
    done(reply)
  }
  return (method, params = {}, sessionId) =>
    new Promise((resolve) => {
      const id = ++lastId
      const timer = setTimeout(() => {
        waiting.delete(id)
        resolve({ error: { message: "8 秒没回应" } })
      }, 8000)
      waiting.set(id, (reply) => {
        clearTimeout(timer)
        resolve(reply)
      })
      ws.send(JSON.stringify({ id, method, params, sessionId }))
    })
}

const failure = (reply) => reply.error?.message ?? "失败"

/** A yes or no from the person watching the screen, kept with the rest. */
async function ask(key, question) {
  if (!process.stdin.isTTY) {
    say(key, "没问（不是在终端里跑的）")
    return null
  }
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  })
  const typed = await terminal.question(
    `\n>>> ${question}\n>>> 有就输入 y，没有就输入 n，然后按回车: `
  )
  terminal.close()
  const answer = typed.trim().toLowerCase()
  const yes = answer.startsWith("y") || answer.startsWith("有")
  const no = answer.startsWith("n") || answer.startsWith("没")
  say(key, yes ? "有" : no ? "没有" : `答的是「${typed.trim()}」`)
  return yes
}

console.log("Chrome 如果弹窗问是否允许远程调试，请点「允许」。")
const ws = await connect("连接")
if (!ws) process.exit(1)
const send = cdp(ws)

const version = await send("Browser.getVersion")
say("Chrome 版本", version.result?.product ?? failure(version))

const targets = await send("Target.getTargets")
say(
  "看得到的标签数",
  targets.result?.targetInfos.filter((t) => t.type === "page").length ??
    failure(targets)
)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Runs `expression` in the tab behind `session`; the value, or why not. */
async function evaluate(session, expression, extra = {}) {
  const reply = await send(
    "Runtime.evaluate",
    { expression, returnByValue: true, ...extra },
    session
  )
  return (
    reply.result?.exceptionDetails?.text ??
    reply.result?.result?.value ??
    failure(reply)
  )
}

/** Opens a tab on example.com and attaches to it. `null` when Chrome said no. */
async function openTab(label, params) {
  const made = await send("Target.createTarget", {
    url: "https://example.com",
    ...params,
  })
  const targetId = made.result?.targetId
  if (!targetId) {
    say(label, failure(made))
    return null
  }
  const tab = await attach(targetId)
  say(label, tab ? "成功" : "开了，但接不上")
  return tab
}

async function attach(targetId) {
  const attached = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })
  const session = attached.result?.sessionId
  if (!session) return null
  await send("Page.enable", {}, session)
  for (let i = 0; i < 16; i++) {
    const state = await evaluate(
      session,
      "location.href !== 'about:blank' && document.readyState"
    )
    if (state === "complete") break
    await sleep(500)
  }
  const placed = await send("Browser.getWindowForTarget", { targetId })
  return { targetId, session, windowId: placed.result?.windowId }
}

/** A real (browser-level) click on the tab, and whether the page got it. */
async function click(tab) {
  await evaluate(
    tab.session,
    "window.__probe = undefined; document.addEventListener('click', (e) => { window.__probe = String(e.isTrusted) }, { once: true }); 1"
  )
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(
      "Input.dispatchMouseEvent",
      { type, x: 60, y: 60, button: "left", clickCount: 1 },
      tab.session
    )
  }
  await sleep(300)
  const got = await evaluate(tab.session, "window.__probe ?? '没收到'")
  const state = await evaluate(
    tab.session,
    "document.visibilityState + (document.hasFocus() ? '，有焦点' : '，没焦点')"
  )
  return `${got === "true" ? "收到了，isTrusted 是 true" : got}（页面 ${state}）`
}

/** The same click once the page has been told it is focused. */
async function clickFocused(tab) {
  const emulated = await send(
    "Emulation.setFocusEmulationEnabled",
    { enabled: true },
    tab.session
  )
  return emulated.error ? failure(emulated) : await click(tab)
}

async function screenshot(tab) {
  const shot = await send(
    "Page.captureScreenshot",
    { format: "jpeg", quality: 30 },
    tab.session
  )
  return shot.result?.data
    ? `成功 ${Math.round(shot.result.data.length / 1024)}KB`
    : failure(shot)
}

const opened = []

// A tab behind the one the person is looking at.
const hidden = await openTab("后台新开标签", { background: true })
if (hidden) {
  opened.push(hidden)
  say(
    "后台标签读页面",
    await evaluate(
      hidden.session,
      "document.title + ' / ' + document.visibilityState"
    )
  )
  say(
    "navigator.webdriver",
    await evaluate(hidden.session, "String(navigator.webdriver)")
  )

  const tree = await send("Page.getFrameTree", {}, hidden.session)
  const world = await send(
    "Page.createIsolatedWorld",
    { frameId: tree.result?.frameTree.frame.id, worldName: "probe" },
    hidden.session
  )
  const contextId = world.result?.executionContextId
  say(
    "隔离环境",
    contextId
      ? await evaluate(
          hidden.session,
          "document.querySelectorAll('*').length + ' 个元素'",
          { contextId }
        )
      : failure(world)
  )

  say("后台标签真点击", await click(hidden))

  // Whether a page told it is focused takes the click a background tab
  // otherwise never sees. Before the screenshot, which might wake the tab by
  // itself: the two were in the other order once, and could not be told
  // apart.
  say("后台标签假装有焦点后真点击", await clickFocused(hidden))
  say("后台标签截图", await screenshot(hidden))
}

// A window that is never on screen: born minimized. If Chrome honours it,
// the agent's window can come into being without interrupting anybody.
console.log(
  "\n马上要开一个「一出生就最小化」的窗口。请留意：Chrome 有没有自己跳到最前面。"
)
await sleep(3000)
const quiet = await openTab("最小化着开窗口", {
  newWindow: true,
  background: true,
  windowState: "minimized",
})
if (quiet) {
  opened.push(quiet)
  const placed = await send("Browser.getWindowBounds", {
    windowId: quiet.windowId,
  })
  say(
    "这个窗口是不是单独的",
    quiet.windowId === hidden?.windowId ? "不是（落在用户的窗口）" : "是"
  )
  say(
    "这个窗口现在的状态",
    placed.result?.bounds?.windowState ?? failure(placed)
  )
  await sleep(1500)
  await ask(
    "最小化着开窗口时 Chrome 有没有跳出来",
    "刚才 Chrome 有没有自己跳到最前面，或者闪出一个窗口？"
  )
  say("最小化着开的窗口里真点击", await click(quiet))
  say("最小化着开的窗口里假装有焦点后真点击", await clickFocused(quiet))
  say("最小化着开的窗口里截图", await screenshot(quiet))
}

// A window of the agent's own, opened the ordinary way: where its tabs would
// live, so that each is the current tab of its window without taking the
// person's.
console.log("\n马上要开一个普通的新窗口。请留意：Chrome 有没有自己跳到最前面。")
await sleep(3000)
const own = await openTab("单独窗口开标签", {
  newWindow: true,
  background: true,
})
if (own) {
  opened.push(own)
  await sleep(1500)
  await ask(
    "普通新窗口出现时 Chrome 有没有跳出来",
    "刚才 Chrome 有没有自己跳到最前面，打断你？"
  )
  say(
    "单独窗口和后台标签是不是同一个窗口",
    own.windowId === hidden?.windowId ? "是（没有新开窗口）" : "不是"
  )
  say("单独窗口里真点击", await click(own))

  // Chrome has no "open in this window". The two ways a second tab might
  // still land beside the first:
  const next = await openTab("再开一个标签（不指定窗口）", { background: true })
  if (next) {
    opened.push(next)
    say(
      "它落在",
      next.windowId === own.windowId
        ? "智能体的窗口"
        : next.windowId === hidden?.windowId
          ? "用户的窗口"
          : "别的窗口"
    )
  }

  const before = await send("Target.getTargets")
  const known = new Set(before.result?.targetInfos.map((t) => t.targetId))
  await evaluate(
    own.session,
    "window.open('https://example.com/?probe', '_blank', 'noopener'); 1",
    { userGesture: true }
  )
  await sleep(1500)
  const after = await send("Target.getTargets")
  const popped = after.result?.targetInfos.find(
    (t) => t.type === "page" && !known.has(t.targetId)
  )
  if (popped) {
    const tab = await attach(popped.targetId)
    if (tab) {
      opened.push(tab)
      say(
        "从智能体的标签里 window.open",
        tab.windowId === own.windowId ? "开在智能体的窗口" : "开在别的窗口"
      )
      say("这样开出来的标签真点击", await click(tab))
      say("原来那个标签这时真点击", await click(own))
    } else {
      opened.push({ targetId: popped.targetId })
      say("从智能体的标签里 window.open", "开了，但接不上")
    }
  } else {
    say("从智能体的标签里 window.open", "没开出来")
  }

  // The window out of sight entirely.
  const minimized = await send("Browser.setWindowBounds", {
    windowId: own.windowId,
    bounds: { windowState: "minimized" },
  })
  if (minimized.error) {
    say("把智能体的窗口最小化", failure(minimized))
  } else {
    await sleep(1500)
    const front = opened.at(-1).session ? opened.at(-1) : own
    say("窗口最小化后真点击", await click(front))
    say("窗口最小化后截图", await screenshot(front))
  }
}

// Chrome's own notice that something outside is driving it: whether there is
// one, and whether it leaves with the connection.
const noticed = await ask(
  "连着时 Chrome 有没有「正受到控制」的提示",
  "现在看一眼 Chrome：窗口顶上有没有一条「Chrome 正受到自动测试软件控制」之类的提示？"
)

let left = 0
for (const tab of opened) {
  const closed = await send("Target.closeTarget", { targetId: tab.targetId })
  if (!closed.result?.success) left += 1
}
say("关掉测试标签", left === 0 ? "成功" : `有 ${left} 个没关掉，请手动关`)

ws.close()
if (noticed) {
  await sleep(2000)
  await ask(
    "断开后还有没有那条提示",
    "脚本已经断开连接。再看一眼 Chrome：顶上还有没有那条提示？"
  )
}

console.log(`\n===== 把下面这段贴给我 =====\n${lines.join("\n")}`)
process.exit(0)
