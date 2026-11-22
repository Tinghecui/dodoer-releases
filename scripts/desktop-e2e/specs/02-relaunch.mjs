// 第 2 段，第二次启动（同一个数据目录，第 1 段的 app 已经退了）：只有一个 app 进程、localStorage 记号还在、
// 停在开始页（上次回到了开始页，N3）、上次开着的远程工作区窗口回来了、网页服务随 app 启动且默认只绑本机（#684）；
// 在开始页选本机，进本机工作区并记住这个选择；给第 3 段准备（排队的消息、网页服务地址 0.0.0.0）。
// 后几项移植自 scripts/desktop-linux-smoke.mjs 的第二次启动。
import { mkdirSync } from "node:fs"
import { join } from "node:path"
import process from "node:process"
import {
  QUEUE_PREFIX,
  QUEUE_TEXT,
  WEB_PORT,
  fmtListen,
  invoke,
  listening,
  loadState,
  must,
  ok,
  saveState,
  waitFor,
  windowLabels,
  MAIN_VIEW_KEY,
  MARKER_KEY,
  click,
  codegPids,
  flushStorage,
  lsGet,
  notes,
  shot,
  step,
  useMainWindow,
  waitForUi,
  waitStartPage,
  waitText,
  waitWorkspace,
  writeResult,
} from "./lib.mjs"

describe("桌面 app 退出重开（第二次启动）", () => {
  after(() => writeResult())

  it("重开以后状态还在", async () => {
    await step("主窗口界面画出来", async () => {
      const s = await waitForUi()
      await useMainWindow()
      return s
    })
    await step("只有这一个 app 进程（上一次的退干净了）", async () => {
      const pids = codegPids()
      notes.pids = pids
      if (pids.length !== 1)
        throw new Error(`codeg 进程：${pids.join(" ") || "无"}`)
      return pids
    })
    await step("localStorage 记号还在", async () => {
      const v = await lsGet(MARKER_KEY)
      if (!v || !v.startsWith("e2e-"))
        throw new Error(`${MARKER_KEY}=${JSON.stringify(v)}`)
      return v
    })
    await step("停在开始页（上次回到了开始页）", async () => {
      const h1 = await waitStartPage()
      const view = await lsGet(MAIN_VIEW_KEY)
      if (view !== "start")
        throw new Error(`${MAIN_VIEW_KEY}=${JSON.stringify(view)}`)
      return { view, h1 }
    })
    await shot("01-relaunch-start-page")
  })

  it("上次开着的远程工作区窗口回来了", async () => {
    await step("窗口列表里有 remote-workspace-<id>", async () => {
      const { remoteId } = loadState()
      must(remoteId != null, "第 1 段没开出远程窗口")
      const label = `remote-workspace-${remoteId}`
      const back = await waitFor(
        async () => (await windowLabels()).includes(label),
        30000
      )
      must(
        back,
        `窗口列表里没有 ${label}：${JSON.stringify(await windowLabels())}`
      )
      return label
    })
  })

  it(`网页服务随 app 启动：默认只绑 127.0.0.1:${WEB_PORT}（#684）`, async () => {
    await step(`${WEB_PORT} 只在 127.0.0.1 上听，GET / → 200`, async () => {
      must(loadState().webAutoStart, "第 1 段没设成随 app 启动")
      const ls = await waitFor(() => {
        const l = listening(WEB_PORT)
        return l.length ? l : null
      }, 60000)
      must(ls, `60 秒内 ${WEB_PORT} 没人听`)
      must(
        ls.every((l) => l.addr === "127.0.0.1"),
        `不只绑在 127.0.0.1：${fmtListen(ls)}`
      )
      const status = ok(
        await invoke("get_web_server_status"),
        "get_web_server_status"
      )
      must(status && status.bindHost === "127.0.0.1", JSON.stringify(status))
      const res = await fetch(`http://127.0.0.1:${WEB_PORT}/`, {
        signal: AbortSignal.timeout(5000),
      })
      must(res.status === 200, `GET / → ${res.status}`)
      return fmtListen(ls)
    })
  })

  it("开始页 → 选本机：进本机工作区，并记住这个选择", async () => {
    await step("点「本机」那一段的按钮，进本机工作区", async () => {
      await useMainWindow()
      await click('section[aria-labelledby="start-local"] button')
      await waitWorkspace()
      await waitText("No open chats")
      return ""
    })
    await step("记住了选本机", async () => {
      await browser.waitUntil(
        async () => (await lsGet(MAIN_VIEW_KEY)) === "local",
        { timeout: 10000, timeoutMsg: `${MAIN_VIEW_KEY} 不是 local` }
      )
      await flushStorage()
      return { view: "local" }
    })
    await shot("02-local-workspace")
  })

  it("给第 3 段准备：会话开成 tab、放一条排队的消息", async () => {
    await step("建文件夹和会话、开成 tab", async () => {
      const dir = join(process.env.E2E_DATA_DIR, "e2e-project")
      mkdirSync(dir, { recursive: true })
      const folder = ok(
        await invoke("open_folder_in_workspace", { path: dir }),
        "open_folder_in_workspace"
      )
      const conversationId = ok(
        await invoke("create_conversation", {
          folderId: folder.id,
          agentType: "claude_code",
          title: "e2e queued conversation",
        }),
        "create_conversation"
      )
      let last = null
      const saved = await waitFor(async () => {
        const tabs = ok(await invoke("list_opened_tabs"), "list_opened_tabs")
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
        last = await invoke("save_opened_tabs", {
          items,
          expectedVersion: tabs.version,
          origin: "desktop-e2e",
        })
        return null
      }, 15000)
      must(saved, `tab 没存上：${JSON.stringify(last)}`)
      saveState({ conversationId })
      return { folder: folder.id, conversationId, tabs: saved.items.length }
    })
    await step("localStorage 里放一条排队的消息", async () => {
      const { conversationId } = loadState()
      must(conversationId != null, "会话没建成")
      const queueItemId = `e2e-queued-${Date.now()}`
      await browser.execute(
        (k, v) => localStorage.setItem(k, v),
        `${QUEUE_PREFIX}${conversationId}`,
        JSON.stringify([
          {
            id: queueItemId,
            draft: {
              blocks: [{ type: "text", text: QUEUE_TEXT }],
              displayText: QUEUE_TEXT,
            },
            modeId: null,
          },
        ])
      )
      saveState({ queueItemId })
      return queueItemId
    })
  })

  it("给第 3 段准备：网页服务地址改成 0.0.0.0", async () => {
    await step("网页服务地址改成 0.0.0.0", async () => {
      ok(
        await invoke("update_web_service_config", {
          config: { token: null, port: null, autoStart: true, host: "0.0.0.0" },
        }),
        "update_web_service_config"
      )
      saveState({ webAnyHost: true })
      await flushStorage()
      return ""
    })
  })
})
