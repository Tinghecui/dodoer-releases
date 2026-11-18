#!/usr/bin/env node
// Linux 桌面版的 WebDriver 冒烟：只有桌面 app 才有的行为（公开镜像 desktop-linux.yml 每晚跑、PR 打 linux-desktop 标签跑）。
// tauri-driver（包着 WebKitWebDriver）把桌面 app 开三次，中间退出重开，每项检查各自报 过 / 没过 / 跳过，带截图。
//
//   用法：xvfb-run -a dbus-run-session -- node scripts/desktop-linux-smoke.mjs
//   环境：见 scripts/desktop-linux-webdriver.mjs；GITHUB_STEP_SUMMARY 有就把结果表写进去；
//        SMOKE_FORCE_FAIL=1 加一项必挂的检查（验证「红了有人知道」那条链路用）。
//
// 三次启动：
//   1（新装，daemon 是子进程）：主窗口、新装直接进本机、网页服务默认不开、设置窗口、远程工作区窗口、内置浏览器 tab、回到开始页
//   2（网页服务随 app 启动 → daemon 在进程内）：localStorage 还在、停在开始页、远程窗口回来、网页服务默认只绑本机、开始页选本机
//   3：直接进本机、排队的消息还在且标成失败、已存的 0.0.0.0 保持
// 写检查的规矩：等条件（waitFor / waitForJs / click），不写固定的 sleep；一项挂了不拦后面的，依赖没成的报「跳过」。
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { join } from "node:path"
import process from "node:process"
import {
  APP,
  OUT,
  click,
  lastClick,
  dataDir,
  exec,
  invoke,
  killApp,
  launch,
  listening,
  listeningAll,
  log,
  pids,
  quit,
  screenshot,
  sh,
  startServer,
  stopDriver,
  switchTo,
  switchToWindow,
  t0,
  waitFor,
  waitForJs,
  waitForUi,
  waitStorageFlushed,
  wd,
  windowLabels,
} from "./desktop-linux-webdriver.mjs"

const WEB_PORT = 3080
const REMOTE_PORT = 3981
const LS_KEY = "desktop-linux-smoke"
const LS_VALUE = `smoke-${Date.now()}`
// 主窗口显示本机工作区还是开始页，记在 localStorage 的这个键里（src/lib/cowork/start-page.ts）
const MAIN_VIEW_KEY = "cowork:main-window-view:v1"
// 排队消息在 localStorage 里的键（src/lib/cowork/message-queue-storage.ts）：前缀:local:<会话 id>
const QUEUE_PREFIX = "cowork:message-queue:v1:local:"
const QUEUE_ITEM_ID = `smoke-queued-${Date.now()}`
const QUEUE_TEXT = "desktop linux smoke queued message"

const checks = []
const timings = {}
const notes = {}

class Skip extends Error {}
const skip = (why) => {
  throw new Skip(why)
}
const must = (cond, detail) => {
  if (!cond) throw new Error(detail)
}
const brief = (v) =>
  JSON.stringify(v)
    .replace(/"token":"[^"]*"/g, '"token":"…"')
    .slice(0, 500)

// 跑一项检查：fn 返回细节（字符串）算过，抛 Skip 算跳过，抛别的算没过。shot 是失败 / 成功都截的图（当前窗口）
async function check(name, fn, { sid = null, shot = null } = {}) {
  let status = "pass"
  let detail = ""
  try {
    detail = (await fn()) || ""
  } catch (e) {
    status = e instanceof Skip ? "skip" : "fail"
    detail = e.message
  }
  if (sid && shot && status !== "skip") await screenshot(sid, `${shot}.png`)
  checks.push({
    name,
    status,
    detail: String(detail).slice(0, 700),
    screenshot: sid && shot && status !== "skip" ? `${shot}.png` : null,
  })
  log(
    `${{ pass: "PASS", fail: "FAIL", skip: "SKIP" }[status]} ${name}${detail ? `：${detail}` : ""}`
  )
  return status === "pass"
}

const ok = (r, what) => {
  must(r && !("err" in r), `${what}：${brief(r)}`)
  return r.ok
}
const lsGet = (sid, key) =>
  exec(sid, "return localStorage.getItem(arguments[0]);", [key])
const startPage = (sid) =>
  exec(
    sid,
    `const h1 = document.querySelector("h1");
     return { h1: h1 ? h1.textContent : null, local: !!document.getElementById("start-local"),
              buttons: document.querySelectorAll("button").length, text: document.body.innerText.slice(0, 600) };`
  )
// 开始页画出来（有标题、有「本机」那一段）
const waitStartPage = (sid) =>
  waitFor(async () => {
    const s = await startPage(sid)
    return s.h1 && s.local ? s : null
  })
// 本机工作区画出来（没有开始页，有侧栏脚上的「快捷操作」按钮）
const waitWorkspace = (sid) =>
  waitForJs(
    sid,
    `return !document.getElementById("start-local") && !!document.querySelector('button[title="Quick actions"]');`
  )

let remote = null
let remoteId = null
let conversationId = null

// ───────── 第一次启动：新装 ─────────
async function firstLaunch() {
  const first = await launch()
  const { sid } = first
  timings.launch1_session_s = first.sessionSeconds
  timings.launch1_ui_s = first.uiSeconds
  const main = await wd("GET", `/session/${sid}/window`)

  await check(
    "启动：WebDriver 会话建起来，主窗口界面画出来",
    async () => {
      const s = first.state || {}
      must(
        s.ready === "complete" && s.buttons > 0 && s.tauri === "object",
        brief(s)
      )
      return `${s.href}，标题 ${JSON.stringify(s.title)}，${s.buttons} 个按钮`
    },
    { sid, shot: "01-launch" }
  )

  await check(
    "新装的 app 主窗口直接进本机工作区（没有保存的服务器）",
    async () => {
      must(
        await waitWorkspace(sid),
        `没等到本机工作区：${brief(await startPage(sid))}`
      )
      const view = await waitForJs(
        sid,
        "return localStorage.getItem(arguments[0]);",
        [MAIN_VIEW_KEY]
      )
      must(view === "local", `${MAIN_VIEW_KEY}=${JSON.stringify(view)}`)
      return `${MAIN_VIEW_KEY}="local"`
    }
  )

  await check("网页服务默认不开；自带的 daemon 子进程只听本机", async () => {
    const status = ok(
      await invoke(sid, "get_web_server_status"),
      "get_web_server_status"
    )
    must(status === null, `网页服务在跑：${brief(status)}`)
    const cfg = ok(
      await invoke(sid, "get_web_service_config"),
      "get_web_service_config"
    )
    must(
      cfg.autoStart === false && cfg.host == null,
      `配置不是默认：${brief(cfg)}`
    )
    must(
      listening(WEB_PORT).length === 0,
      `${WEB_PORT} 有人听：${listening(WEB_PORT).join(" | ")}`
    )
    // 子进程是 app 起的那个 codeg-server（这时候当远端用的那个还没起）。它起得比界面晚一点，等它开始听
    const childPids = pids("codeg-server")
    let all = []
    const child = await waitFor(() => {
      all = listeningAll()
      const mine = all.filter((l) =>
        childPids.some((pid) => l.includes(`pid=${pid},`))
      )
      return mine.length ? mine : null
    }, 20000)
    must(
      child,
      `没看到 codeg-server 子进程（pid ${childPids.join(" ") || "无"}）在听端口：${all.join(" | ").replace(/\s+/g, " ")}`
    )
    // 核心断言：子进程只绑 127.0.0.1，没有 0.0.0.0 / [::] / 别的网卡
    must(
      child.every((l) => /\s127\.0\.0\.1:\d+\s/.test(l)),
      `子进程不只听 127.0.0.1：${child.join(" | ")}`
    )
    const ports = child.map((l) => l.match(/\s127\.0\.0\.1:(\d+)\s/)[1])
    return `子进程 pid ${childPids.join(" ")} 听 ${ports.map((p) => `127.0.0.1:${p}`).join("、")}；${WEB_PORT} 没人听`
  })

  await check(
    "设置窗口：能打开、切过去、读到配置",
    async () => {
      ok(
        await invoke(sid, "open_settings_window", { section: "web-service" }),
        "open_settings_window"
      )
      const handle = await switchToWindow(sid, (href) =>
        href.includes("/settings")
      )
      must(
        handle,
        `没有地址带 /settings 的窗口；窗口：${brief(await windowLabels(sid))}`
      )
      const s = await waitForUi(sid, 30000)
      must(s && s.buttons > 0, `设置页没画出来：${brief(s)}`)
      const lang = ok(
        await invoke(sid, "get_system_language_settings"),
        "get_system_language_settings"
      )
      const labels = await windowLabels(sid)
      must(
        labels.includes("settings"),
        `窗口列表里没有 settings：${brief(labels)}`
      )
      return `${s.href}，${s.buttons} 个按钮，语言设置 ${brief(lang)}`
    },
    { sid, shot: "02-settings" }
  )
  await check("设置窗口：关得掉", async () => {
    await switchTo(sid, main)
    if (!(await windowLabels(sid)).includes("settings"))
      skip("设置窗口没开出来")
    ok(await invoke(sid, "plugin:window|close", { label: "settings" }), "close")
    const gone = await waitFor(
      async () => !(await windowLabels(sid)).includes("settings")
    )
    must(gone, `关了还在：${brief(await windowLabels(sid))}`)
    return ""
  })
  await switchTo(sid, main)

  await check(
    "远程服务器：令牌连上本机另起的 codeg-server，开出远程工作区窗口",
    async () => {
      remote = await startServer(
        REMOTE_PORT,
        `smoke-remote-${Date.now()}-token`
      )
      const conn = ok(
        await invoke(sid, "create_remote_workspace_connection", {
          input: {
            name: "smoke-remote",
            baseUrl: remote.url,
            token: remote.token,
            headers: [],
          },
        }),
        "create_remote_workspace_connection"
      )
      remoteId = conn.id
      ok(
        await invoke(sid, "open_remote_workspace", { id: remoteId }),
        "open_remote_workspace"
      )
      const handle = await switchToWindow(sid, (href) =>
        href.includes(`remoteConnectionId=${remoteId}`)
      )
      must(
        handle,
        `没有远程工作区窗口；窗口：${brief(await windowLabels(sid))}`
      )
      const s = await waitForUi(sid, 60000)
      must(s && s.buttons > 0, `远程窗口没画出来：${brief(s)}`)
      // 从远程窗口经 app 的代理问远端一句，确认真的连着那台服务器
      const viaRemote = ok(
        await invoke(sid, "remote_http_call", {
          connectionId: remoteId,
          command: "get_system_language_settings",
          args: {},
        }),
        "remote_http_call"
      )
      const labels = await windowLabels(sid)
      must(
        labels.includes(`remote-workspace-${remoteId}`),
        `窗口列表里没有 remote-workspace-${remoteId}：${brief(labels)}`
      )
      return `窗口 remote-workspace-${remoteId}，${s.buttons} 个按钮，远端答复 ${brief(viaRemote)}`
    },
    { sid, shot: "03-remote-window" }
  )
  await switchTo(sid, main)

  await check(
    "内置浏览器：开一个 tab，页面加载到远端的地址（间接看，tab 本身 WebDriver 切不过去）",
    async () => {
      if (!remote) skip("远端服务器没起来")
      const tabId = "smoke-tab"
      ok(
        await invoke(sid, "browser_open_tab", {
          tabId,
          url: `${remote.url}/`,
          bounds: { x: 320, y: 120, width: 640, height: 420 },
        }),
        "browser_open_tab"
      )
      let tab = null
      const loaded = await waitFor(async () => {
        const tabs = ok(
          await invoke(sid, "browser_list_tabs"),
          "browser_list_tabs"
        )
        tab = tabs.find((t) => t.tabId === tabId) || null
        return tab && !tab.loading && String(tab.url).startsWith(remote.url)
      }, 30000)
      must(loaded, `tab 没加载到 ${remote.url}：${brief(tab)}`)
      ok(await invoke(sid, "browser_close", { tabId }), "browser_close")
      return `url=${tab.url} title=${JSON.stringify(tab.title)} surface=${tab.surface}`
    }
  )

  await check(
    "本机工作区 → 回到开始页，保存的服务器列在上面",
    async () => {
      await switchTo(sid, main)
      must(
        await click(sid, "css selector", 'button[title="Quick actions"]'),
        `没点到「Quick actions」：${lastClick}`
      )
      const how = lastClick
      must(
        await click(
          sid,
          "xpath",
          "//*[@role='menuitem'][contains(., 'Back to start page')]"
        ),
        `菜单里没点到「Back to start page」：${lastClick}`
      )
      const s = await waitStartPage(sid)
      must(s, `开始页没出来：${brief(await startPage(sid))}`)
      const view = await lsGet(sid, MAIN_VIEW_KEY)
      must(view === "start", `${MAIN_VIEW_KEY}=${JSON.stringify(view)}`)
      if (remoteId != null) {
        const listed = await waitForJs(
          sid,
          `return document.body.innerText.includes("smoke-remote");`
        )
        must(listed, `开始页上没有 smoke-remote：${s.text}`)
      }
      return `标题 ${JSON.stringify(s.h1)}，${MAIN_VIEW_KEY}="start"（${how}）`
    },
    { sid, shot: "04-start-page" }
  )

  // 为第二次启动做准备：写个记号；打开「网页服务随 app 启动」（不指定地址，走默认）
  await switchTo(sid, main)
  await exec(sid, "localStorage.setItem(arguments[0], arguments[1]);", [
    LS_KEY,
    LS_VALUE,
  ])
  notes.webConfig1 = await invoke(sid, "update_web_service_config", {
    config: { token: null, port: null, autoStart: true },
  })
  notes.flushed1 = await waitStorageFlushed(LS_VALUE)
  const before = pids("codeg-server")
  notes.quit1 = await quit(sid)

  await check(
    "app 退出后进程清干净（自带的 codeg-server 子进程、WebKit 的进程）",
    async () => {
      const mine = remote ? [String(remote.proc.pid)] : []
      const left = () => [
        ...pids("codeg-server").filter((p) => !mine.includes(p)),
        ...pids("WebKitWebProcess"),
        ...pids("WebKitNetworkProcess"),
      ]
      const clean = await waitFor(() => left().length === 0, 15000)
      must(clean, `还在：pid ${left().join(" ")}`)
      // 退不掉、被脚本 TERM / KILL 掉的，进程清干净了也不算过
      must(notes.quit1 === "自己退出", `app 没自己退：${notes.quit1}`)
      return `退出方式：${notes.quit1}；退出前 codeg-server ${before.length} 个，现在只剩当远端的那个`
    }
  )
}

// ───────── 第二次启动：网页服务随 app 启动 ─────────
async function secondLaunch() {
  const second = await launch()
  const { sid } = second
  timings.launch2_session_s = second.sessionSeconds
  timings.launch2_ui_s = second.uiSeconds
  // 会话落在哪个窗口不一定（远程窗口也回来了），先切回主窗口
  const main = await switchToWindow(
    sid,
    (href) =>
      href.includes("/workspace") && !href.includes("remoteConnectionId")
  )

  await check("退出重开：localStorage 还在", async () => {
    must(main, "没找到主窗口")
    const kept = await lsGet(sid, LS_KEY)
    must(
      kept === LS_VALUE,
      `读到 ${JSON.stringify(kept)}，写的是 ${LS_VALUE}（落盘文件：${notes.flushed1}）`
    )
    return kept
  })

  await check(
    "退出重开：主窗口停在开始页（上次回到了开始页）",
    async () => {
      const s = await waitStartPage(sid)
      must(s, `开始页没出来：${brief(await startPage(sid))}`)
      return `标题 ${JSON.stringify(s.h1)}`
    },
    { sid, shot: "05-restart-start-page" }
  )

  await check("退出重开：上次开着的远程工作区窗口回来了", async () => {
    if (remoteId == null) skip("远程窗口上次没开出来")
    const label = `remote-workspace-${remoteId}`
    const back = await waitFor(
      async () => (await windowLabels(sid)).includes(label),
      30000
    )
    must(back, `窗口列表里没有 ${label}：${brief(await windowLabels(sid))}`)
    return label
  })

  await check(
    `网页服务随 app 启动：默认只绑 127.0.0.1:${WEB_PORT}（#684）`,
    async () => {
      must(
        notes.webConfig1 && notes.webConfig1.ok,
        `上次没设成：${brief(notes.webConfig1)}`
      )
      const lines = await waitFor(() => {
        const l = listening(WEB_PORT)
        return l.length ? l : null
      }, 60000)
      must(lines, `60 秒内 ${WEB_PORT} 没人听`)
      must(
        lines.every((l) => l.includes(`127.0.0.1:${WEB_PORT} `)),
        `不只绑在 127.0.0.1：${lines.join(" | ")}`
      )
      const status = ok(
        await invoke(sid, "get_web_server_status"),
        "get_web_server_status"
      )
      must(status && status.bindHost === "127.0.0.1", brief(status))
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/`, {
        signal: AbortSignal.timeout(5000),
      })
      must(res.status === 200, `GET / → ${res.status}`)
      return `${lines.join(" | ").replace(/\s+/g, " ")}；GET / → 200`
    }
  )

  await check(
    "开始页 → 选本机：进本机工作区，并记住这个选择",
    async () => {
      must(
        await click(
          sid,
          "css selector",
          'section[aria-labelledby="start-local"] button'
        ),
        `没点到「Open local workspace」：${lastClick}`
      )
      must(
        await waitWorkspace(sid),
        `没进本机工作区：${brief(await startPage(sid))}`
      )
      const view = await waitForJs(
        sid,
        `return localStorage.getItem(arguments[0]) === "local" ? "local" : null;`,
        [MAIN_VIEW_KEY]
      )
      must(
        view,
        `${MAIN_VIEW_KEY}=${JSON.stringify(await lsGet(sid, MAIN_VIEW_KEY))}`
      )
      return `${MAIN_VIEW_KEY}="local"`
    },
    { sid, shot: "06-local-workspace" }
  )

  // 为第三次启动做准备。
  // 1) 一个存了库、开着 tab 的会话，localStorage 里给它放一条排队的消息（没有 agent 也能建会话）
  await check(
    "准备：建一个文件夹和会话、开成 tab，放一条排队的消息",
    async () => {
      const dir = join(dataDir, "smoke-project")
      mkdirSync(dir, { recursive: true })
      const folder = ok(
        await invoke(sid, "open_folder_in_workspace", { path: dir }),
        "open_folder_in_workspace"
      )
      conversationId = ok(
        await invoke(sid, "create_conversation", {
          folderId: folder.id,
          agentType: "claude_code",
          title: "smoke queued conversation",
        }),
        "create_conversation"
      )
      const saved = await waitFor(async () => {
        const tabs = ok(
          await invoke(sid, "list_opened_tabs"),
          "list_opened_tabs"
        )
        if (
          tabs.items.some(
            (t) => t.conversation_id === conversationId && t.is_active
          )
        )
          return tabs
        const items = [
          ...tabs.items.map((t) => ({ ...t, is_active: false })),
          {
            id: tabs.items.reduce((m, t) => Math.max(m, t.id), 0) + 1,
            folder_id: folder.id,
            conversation_id: conversationId,
            agent_type: "claude_code",
            position: tabs.items.length,
            is_active: true,
            is_pinned: false,
          },
        ]
        notes.saveTabs = await invoke(sid, "save_opened_tabs", {
          items,
          expectedVersion: tabs.version,
          origin: "desktop-linux-smoke",
        })
        return null
      }, 15000)
      must(saved, `tab 没存上：${brief(notes.saveTabs)}`)
      await exec(sid, "localStorage.setItem(arguments[0], arguments[1]);", [
        `${QUEUE_PREFIX}${conversationId}`,
        JSON.stringify([
          {
            id: QUEUE_ITEM_ID,
            draft: {
              blocks: [{ type: "text", text: QUEUE_TEXT }],
              displayText: QUEUE_TEXT,
            },
            modeId: null,
          },
        ]),
      ])
      return `文件夹 ${folder.id}，会话 ${conversationId}，tab ${saved.items.length} 个`
    }
  )
  // 2) 网页服务地址改成 0.0.0.0（#684：已经存了 0.0.0.0 的保持）
  notes.webConfig2 = await invoke(sid, "update_web_service_config", {
    config: { token: null, port: null, autoStart: true, host: "0.0.0.0" },
  })
  notes.flushed2 = await waitStorageFlushed(QUEUE_ITEM_ID)
  notes.quit2 = await quit(sid)
}

// ───────── 第三次启动 ─────────
async function thirdLaunch() {
  const third = await launch()
  const { sid } = third
  timings.launch3_session_s = third.sessionSeconds
  timings.launch3_ui_s = third.uiSeconds
  const main = await switchToWindow(
    sid,
    (href) =>
      href.includes("/workspace") && !href.includes("remoteConnectionId")
  )

  await check(
    "退出重开：上次选了本机，这次直接进本机工作区",
    async () => {
      must(main, "没找到主窗口")
      must(
        await waitWorkspace(sid),
        `没进本机工作区：${brief(await startPage(sid))}`
      )
      return ""
    },
    { sid, shot: "07-restart-local" }
  )

  await check(
    "退出重开：排队的消息还在，标成失败，没有自己发出去（#681）",
    async () => {
      if (conversationId == null) skip("上次没把会话和排队消息准备好")
      const key = `${QUEUE_PREFIX}${conversationId}`
      // 排队那一条在不在 DOM 里、用户看不看得见：有大小、没有被 display:none / visibility:hidden 藏起来（visibility 会继承，
      // 报的是真正设了它的那一层）、中心点上没有别的元素盖着
      const QUEUE_ITEM = `
        const item = document.querySelector("[data-queue-item][data-queue-failed]");
        if (!item) return null;
        const r = item.getBoundingClientRect();
        const name = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + "." + String(el.className).slice(0, 90);
        let hiddenBy = null;
        for (let el = item; el && el !== document.body; el = el.parentElement) {
          const cs = getComputedStyle(el);
          const parentHidden = el.parentElement && getComputedStyle(el.parentElement).visibility === "hidden";
          if (cs.display === "none" || el.hidden || (cs.visibility === "hidden" && !parentHidden)) hiddenBy = name(el);
        }
        const tab = item.closest(".conversation-tab-hidden");
        let coveredBy = null;
        if (!hiddenBy && r.width > 0 && r.height > 0) {
          const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          if (!top) coveredBy = "窗口外";
          else if (!item.contains(top)) coveredBy = name(top);
        }
        return { text: item.textContent.slice(0, 200), items: document.querySelectorAll("[data-queue-item]").length,
                 rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)],
                 visible: r.width > 0 && r.height > 0 && !hiddenBy && !coveredBy,
                 hiddenBy, coveredBy, inHiddenTab: !!tab, title: document.title };`
      const shown = await waitForJs(sid, QUEUE_ITEM, [], 30000)
      must(
        shown,
        `界面上没有标成失败的排队消息；localStorage：${await lsGet(sid, key)}；${brief(await startPage(sid))}`
      )
      must(shown.text.includes(QUEUE_TEXT), `排队消息的字不对：${brief(shown)}`)
      // 读回来的队列会写回 localStorage，带上 failure:"restored"；一直留在队列里就是没自己发
      const stored = await waitForJs(
        sid,
        `const raw = localStorage.getItem(arguments[0]);
         const list = raw ? JSON.parse(raw) : [];
         const item = list.find((i) => i.id === arguments[1]);
         return item && item.failure ? { failure: item.failure, items: list.length } : null;`,
        [key, QUEUE_ITEM_ID]
      )
      must(
        stored,
        `localStorage 里那条没标上失败原因：${await lsGet(sid, key)}`
      )
      // 那个会话的 tab 不在前面时（重启后前面是别的 tab），它的整个面板是 visibility:hidden 的，排队区自然看不见。
      // 像用户一样点侧栏里的这个会话切过去，再要求看得见
      let how = "一开始就在前面"
      let seen = shown.visible ? shown : null
      if (!seen) {
        const tabs = await invoke(sid, "list_opened_tabs")
        notes.queueBefore = { shown, tabs: tabs.ok || tabs }
        how = `一开始看不见（${shown.inHiddenTab ? "在后面的 tab 里" : ""}${shown.hiddenBy ? `被 ${shown.hiddenBy} 藏着` : ""}${shown.coveredBy ? `被 ${shown.coveredBy} 盖着` : ""}），点侧栏切过去`
        must(
          await click(
            sid,
            "css selector",
            `button[data-conversation-id="${conversationId}"]`
          ),
          `${how}，没点到侧栏里的会话：${lastClick}`
        )
        let last = shown
        seen = await waitFor(async () => {
          last = await exec(sid, QUEUE_ITEM)
          return last && last.visible ? last : null
        }, 20000)
        must(seen, `${how}以后还是看不见：${brief(last)}`)
      }
      return `界面 ${seen.items} 条、标成失败、看得见（${how}，位置 ${seen.rect.join(",")}）；存的 failure=${stored.failure}`
    },
    { sid, shot: "08-queued-message" }
  )

  await check(`网页服务：已存的 0.0.0.0 保持（#684）`, async () => {
    must(
      notes.webConfig2 && notes.webConfig2.ok,
      `上次没设成：${brief(notes.webConfig2)}`
    )
    const lines = await waitFor(() => {
      const l = listening(WEB_PORT)
      return l.length ? l : null
    }, 60000)
    must(lines, `60 秒内 ${WEB_PORT} 没人听`)
    must(
      lines.every((l) => l.includes(`0.0.0.0:${WEB_PORT} `)),
      `没绑在 0.0.0.0：${lines.join(" | ")}`
    )
    // 不认识地址这一项的旧客户端保存设置（不带 host）：存着的 0.0.0.0 不能被改回去
    ok(
      await invoke(sid, "update_web_service_config", {
        config: { token: null, port: null, autoStart: true },
      }),
      "update_web_service_config"
    )
    const cfg = ok(
      await invoke(sid, "get_web_service_config"),
      "get_web_service_config"
    )
    must(cfg.host === "0.0.0.0", `不带 host 保存以后变成了 ${brief(cfg)}`)
    return `${lines.join(" | ").replace(/\s+/g, " ")}；不带 host 再存一次还是 0.0.0.0`
  })

  await check(
    "有保存的服务器、没记住选择（第一次启动的样子）：主窗口是开始页",
    async () => {
      if (remoteId == null) skip("没有保存的服务器（远程那项没成）")
      // 把记住的选择抹掉再重新加载主窗口，就是「有服务器、第一次启动」时主窗口看到的状态
      await exec(
        sid,
        "localStorage.removeItem(arguments[0]); location.reload();",
        [MAIN_VIEW_KEY]
      )
      const s = await waitStartPage(sid)
      must(s, `开始页没出来：${brief(await startPage(sid))}`)
      must(
        s.text.includes("smoke-remote"),
        `开始页上没有 smoke-remote：${s.text}`
      )
      return `标题 ${JSON.stringify(s.h1)}，列着 smoke-remote`
    },
    { sid, shot: "09-first-run-with-server" }
  )

  notes.quit3 = await quit(sid)

  await check("每次关会话 app 都自己退出（没靠脚本 TERM / KILL）", async () => {
    const all = [notes.quit1, notes.quit2, notes.quit3]
    must(
      all.every((how) => how === "自己退出"),
      all.map((how, i) => `第 ${i + 1} 次：${how}`).join("；")
    )
    return "三次都是"
  })
}

async function main() {
  log(`app=${APP}`)
  log(`数据目录=${dataDir}`)

  // 不开窗口：app 自带的 daemon 子进程起得来、带令牌 200、错令牌 401、被杀以后自动重启、停得掉（codeg --local-daemon-smoke）
  await check(
    "自带的 daemon 子进程：起、鉴权、被杀后自动重启、停（--local-daemon-smoke）",
    async () => {
      try {
        const out = execFileSync(APP, ["--local-daemon-smoke"], {
          encoding: "utf8",
          timeout: 180000,
          stdio: ["ignore", "pipe", "pipe"],
        })
        return out.trim().split("\n").slice(-1)[0] || ""
      } catch (e) {
        throw new Error(
          `退出码 ${e.status}：${`${e.stdout || ""}${e.stderr || ""}`.slice(-500)}`
        )
      }
    }
  )

  await firstLaunch()
  await secondLaunch()
  await thirdLaunch()

  if (process.env.SMOKE_FORCE_FAIL === "1") {
    await check("故意失败（SMOKE_FORCE_FAIL=1，验证报红用）", async () =>
      must(false, "故意的")
    )
  }
}

let crashed = null
try {
  await main()
} catch (e) {
  crashed = e
  await check("脚本跑完", async () => must(false, e.stack || e.message))
} finally {
  await stopDriver()
  killApp()
  if (remote) remote.stop()
  // app 自己的日志（数据目录下的 logs/），失败时靠它看卡在哪
  sh("cp", ["-r", join(dataDir, "logs"), join(OUT, "app-logs")])
}

const count = (status) => checks.filter((c) => c.status === status).length
const failed = count("fail")
timings.total_s = (Date.now() - t0) / 1000
writeFileSync(
  join(OUT, "result.json"),
  JSON.stringify({ checks, timings, notes, dataDir }, null, 2)
)
const esc = (s) => s.replace(/\|/g, "\\|").replace(/\n/g, " ")
const word = { pass: "过", fail: "**没过**", skip: "跳过" }
const table = [
  `### 桌面版 Linux WebDriver 冒烟：${failed === 0 ? "全过" : `${failed} 项没过`}（过 ${count("pass")}，没过 ${failed}，跳过 ${count("skip")}）`,
  "",
  "| # | 检查 | 结果 | 细节 | 截图 |",
  "| --- | --- | --- | --- | --- |",
  ...checks.map(
    (c, i) =>
      `| ${i + 1} | ${esc(c.name)} | ${word[c.status]} | ${esc(c.detail)} | ${c.screenshot || ""} |`
  ),
  "",
  `耗时（秒）：${Object.entries(timings)
    .map(([k, v]) => `${k}=${v.toFixed(1)}`)
    .join("，")}。截图、日志在这次 run 的 artifact desktop-linux-smoke 里。`,
  "",
].join("\n")
console.log(table)
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${table}\n`)
}
process.exit(failed === 0 && !crashed ? 0 : 1)
