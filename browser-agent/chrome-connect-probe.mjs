/**
 * Asks the Chrome a person is using whether an outside program may drive it,
 * and prints what it could do there. The measurements `docs/agent-chrome.md`
 * (section 10) needs before any of it is built.
 *
 *     node browser-agent/chrome-connect-probe.mjs
 *
 * Needs Node 22+ (the global WebSocket) and Chrome 144+ with the switch at
 * chrome://inspect/#remote-debugging turned on. Chrome asks the person to
 * allow each connection; this makes two. It opens one background tab on
 * example.com and closes it again; nothing else in the browser is touched,
 * and no address or title of the person's own tabs is printed.
 *
 * Manual, not part of `pnpm test`: it needs a person's own browser.
 */
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

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

console.log("Chrome 如果弹窗问是否允许远程调试，请点「允许」。")
const ws = await connect("第一次连接")
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

const made = await send("Target.createTarget", {
  url: "https://example.com",
  background: true,
})
const targetId = made.result?.targetId
say("后台新开标签", targetId ? "成功" : failure(made))

if (targetId) {
  const attached = await send("Target.attachToTarget", {
    targetId,
    flatten: true,
  })
  const session = attached.result?.sessionId
  say("接上这个标签", session ? "成功" : failure(attached))
  await send("Page.enable", {}, session)
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const evaluate = async (expression, extra = {}) => {
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

  say(
    "后台标签读页面",
    await evaluate("document.title + ' / ' + document.visibilityState")
  )
  say("navigator.webdriver", await evaluate("String(navigator.webdriver)"))

  const tree = await send("Page.getFrameTree", {}, session)
  const world = await send(
    "Page.createIsolatedWorld",
    { frameId: tree.result?.frameTree.frame.id, worldName: "probe" },
    session
  )
  const contextId = world.result?.executionContextId
  say(
    "隔离环境",
    contextId
      ? await evaluate("document.querySelectorAll('*').length + ' 个元素'", {
          contextId,
        })
      : failure(world)
  )

  await evaluate(
    "document.addEventListener('click', (e) => { window.__probe = String(e.isTrusted) }); 1"
  )
  for (const type of ["mousePressed", "mouseReleased"]) {
    await send(
      "Input.dispatchMouseEvent",
      { type, x: 60, y: 60, button: "left", clickCount: 1 },
      session
    )
  }
  say(
    "后台标签真点击 isTrusted",
    await evaluate("window.__probe ?? '没收到点击'")
  )

  const shot = await send(
    "Page.captureScreenshot",
    { format: "jpeg", quality: 30 },
    session
  )
  say(
    "后台标签截图",
    shot.result?.data
      ? `成功 ${Math.round(shot.result.data.length / 1024)}KB`
      : failure(shot)
  )

  const closed = await send("Target.closeTarget", { targetId })
  say("关掉测试标签", closed.result?.success ? "成功" : failure(closed))
}

ws.close()
await new Promise((resolve) => setTimeout(resolve, 1500))
console.log("现在测第二次连接：如果又弹窗，请再点「允许」。")
const again = await connect("第二次连接")
again?.close()

console.log(`\n===== 把下面这段贴给我 =====\n${lines.join("\n")}`)
console.log(
  "另外请告诉我：1) 一共弹了几次窗  2) Chrome 顶上有没有出现提示条，写的什么"
)
process.exit(0)
