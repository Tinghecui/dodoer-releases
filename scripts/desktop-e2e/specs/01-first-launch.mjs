// 第 1 段，第一次启动（新装、没有保存的服务器）：直接进本机工作区；网页服务默认不开、daemon 子进程只听本机；开设置窗口切过去读 DOM、
// 切回来关掉；连上远端开远程工作区窗口；内置浏览器开 tab；用 Radix 菜单回开始页（stories.md N3），上面列着保存的服务器；
// 给第 2 段准备（记号、网页服务随 app 启动）。后几项移植自 scripts/desktop-linux-smoke.mjs 的第一次启动。
// 文字一律读具体元素的 innerText（textOf），不读 body 的 getText。切窗口用 tauri-service 按 Tauri 窗口标签切（要 tauri-plugin-wdio）
import {
  MAIN_VIEW_KEY,
  MARKER_KEY,
  codegPids,
  flushStorage,
  REMOTE,
  REMOTE_NAME,
  WEB_PORT,
  fmtListen,
  invoke,
  listening,
  listeningAll,
  loadState,
  lsGet,
  must,
  ok,
  pids,
  saveState,
  waitFor,
  windowLabels,
  notes,
  pointerClick,
  shot,
  step,
  textOf,
  useMainWindow,
  waitForUi,
  waitStartPage,
  waitText,
  waitWorkspace,
  writeResult,
} from "./lib.mjs"

describe("桌面 app 第一次启动", () => {
  after(() => writeResult())

  it("主窗口画出来，tauri-plugin-wdio 两半都在", async () => {
    await step("主窗口界面画出来（window.wdioTauri 在）", async () => {
      const s = await waitForUi()
      if (s.tauri !== "object")
        throw new Error(`没有 __TAURI_INTERNALS__：${JSON.stringify(s)}`)
      await useMainWindow()
      notes.pids = codegPids()
      return s
    })
    await step("browser.tauri：窗口标签、当前窗口", async () => {
      const windows = await browser.tauri.listWindows()
      if (!windows.includes("main"))
        throw new Error(`窗口里没有 main：${JSON.stringify(windows)}`)
      const label = await browser.tauri.execute(({ core }) =>
        core.invoke("plugin:wdio|get_active_window_label")
      )
      return { windows, label }
    })
    await step("新装直接进本机工作区：空会话区的文字", async () => {
      await waitWorkspace()
      const view = await lsGet(MAIN_VIEW_KEY)
      if (view !== "local") throw new Error(`${MAIN_VIEW_KEY}=${view}`)
      await waitText("No open chats")
      return { view }
    })
    await shot("01-launch")
  })

  it("网页服务默认不开；自带的 daemon 子进程只听本机", async () => {
    await step(
      "get_web_server_status / get_web_service_config 是默认的",
      async () => {
        const status = ok(
          await invoke("get_web_server_status"),
          "get_web_server_status"
        )
        must(status === null, `网页服务在跑：${JSON.stringify(status)}`)
        const cfg = ok(
          await invoke("get_web_service_config"),
          "get_web_service_config"
        )
        must(
          cfg.autoStart === false && cfg.host == null,
          `配置不是默认：${JSON.stringify(cfg)}`
        )
        const web = listening(WEB_PORT)
        must(web.length === 0, `${WEB_PORT} 有人听：${fmtListen(web)}`)
        return { autoStart: cfg.autoStart }
      }
    )
    await step("daemon 子进程（codeg-server）只绑 127.0.0.1", async () => {
      // 子进程起得比界面晚一点，等它开始听；当远端用的那个 codeg-server（run.sh 起的）不算
      let all = []
      const child = await waitFor(() => {
        const mine = pids("codeg-server").filter((p) => p !== REMOTE.pid)
        all = listeningAll()
        const ls = all.filter((l) => l.pids.some((p) => mine.includes(p)))
        return ls.length ? ls : null
      }, 20000)
      must(child, `没看到 codeg-server 子进程在听端口：${fmtListen(all)}`)
      must(
        child.every((l) => l.addr === "127.0.0.1"),
        `子进程不只听 127.0.0.1：${fmtListen(child)}`
      )
      return fmtListen(child)
    })
  })

  it("开设置窗口、按标签切过去读 DOM、切回主窗口关掉它", async () => {
    await step("open_settings_window，窗口列表里多了 settings", async () => {
      const r = await invoke("open_settings_window", {
        section: "web-service",
      })
      if (r && "err" in r) throw new Error(`open_settings_window：${r.err}`)
      await browser.waitUntil(
        async () => (await browser.tauri.listWindows()).includes("settings"),
        { timeout: 30000, timeoutMsg: "窗口列表里没有 settings" }
      )
      return await browser.tauri.listWindows()
    })
    await step("tauri.switchWindow('settings')，读得到它的 DOM", async () => {
      await browser.tauri.switchWindow("settings")
      await waitForUi(60000)
      const url = await browser.getUrl()
      if (!url.includes("/settings")) throw new Error(`url=${url}`)
      const title = await browser.getTitle()
      const text = await browser.execute(() => document.body.innerText)
      if (!text.includes("Web Service"))
        throw new Error(`设置窗口里没有「Web Service」：${text.slice(0, 200)}`)
      await shot("03-settings")
      return { url, title }
    })
    await step("切回主窗口，从主窗口关掉设置窗口", async () => {
      // 先切回去：在设置窗口里关它自己，回不来结果（no such window）
      await browser.tauri.switchWindow("main")
      const r = await invoke("plugin:window|close", { label: "settings" })
      if (r && "err" in r) throw new Error(`close：${r.err}`)
      await browser.waitUntil(
        async () => !(await browser.tauri.listWindows()).includes("settings"),
        { timeout: 20000, timeoutMsg: "设置窗口没关掉" }
      )
      return {
        url: await browser.getUrl(),
        windows: await browser.tauri.listWindows(),
      }
    })
  })

  it("远程服务器：令牌连上另起的 codeg-server，开出远程工作区窗口", async () => {
    await step("建连接、开远程工作区窗口、切过去", async () => {
      must(
        REMOTE.url,
        "run.sh 没把远端 codeg-server 起起来（E2E_REMOTE_URL 是空的）"
      )
      const conn = ok(
        await invoke("create_remote_workspace_connection", {
          input: {
            name: REMOTE_NAME,
            baseUrl: REMOTE.url,
            token: REMOTE.token,
            headers: [],
          },
        }),
        "create_remote_workspace_connection"
      )
      saveState({ remoteId: conn.id })
      ok(
        await invoke("open_remote_workspace", { id: conn.id }),
        "open_remote_workspace"
      )
      const label = `remote-workspace-${conn.id}`
      const found = await waitFor(
        async () => (await windowLabels()).includes(label),
        30000
      )
      must(
        found,
        `窗口列表里没有 ${label}：${JSON.stringify(await windowLabels())}`
      )
      await browser.tauri.switchWindow(label)
      const s = await waitForUi(60000)
      must(
        (await browser.getUrl()).includes(`remoteConnectionId=${conn.id}`),
        `url=${await browser.getUrl()}`
      )
      await shot("04-remote-window")
      return { label, buttons: s.buttons }
    })
    await step("经 app 的代理问远端一句（remote_http_call）", async () => {
      await useMainWindow()
      const { remoteId } = loadState()
      must(remoteId != null, "远程连接没建成")
      const r = ok(
        await invoke("remote_http_call", {
          connectionId: remoteId,
          command: "get_system_language_settings",
          args: {},
        }),
        "remote_http_call"
      )
      return JSON.stringify(r).slice(0, 120)
    })
  })

  it("内置浏览器：开一个 tab，加载到远端的地址", async () => {
    await step("browser_open_tab → browser_list_tabs 里加载完", async () => {
      must(REMOTE.url, "远端服务器没起来")
      await useMainWindow()
      const tabId = "e2e-tab"
      ok(
        await invoke("browser_open_tab", {
          tabId,
          url: `${REMOTE.url}/`,
          bounds: { x: 320, y: 120, width: 640, height: 420 },
        }),
        "browser_open_tab"
      )
      let tab = null
      const loaded = await waitFor(async () => {
        const tabs = ok(await invoke("browser_list_tabs"), "browser_list_tabs")
        tab = tabs.find((t) => t.tabId === tabId) || null
        return tab && !tab.loading && String(tab.url).startsWith(REMOTE.url)
      }, 30000)
      must(loaded, `tab 没加载到 ${REMOTE.url}：${JSON.stringify(tab)}`)
      ok(await invoke("browser_close", { tabId }), "browser_close")
      return { url: tab.url, surface: tab.surface }
    })
  })

  it("Quick actions →「Back to start page」回到开始页（N3）", async () => {
    await step("点 Quick actions（派发 pointer 事件），菜单打开", async () => {
      await useMainWindow()
      await pointerClick('button[title="Quick actions"]')
      await $("[role='menuitem']").waitForDisplayed({ timeout: 10000 })
      return (await $$("[role='menuitem']").length) + " 个菜单项"
    })
    await step(
      "点 Back to start page，开始页的标题和「本机」那一段",
      async () => {
        await pointerClick(
          "//*[@role='menuitem'][contains(., 'Back to start page')]"
        )
        const h1 = await waitStartPage(20000)
        const local = await textOf("#start-local")
        if (local !== "Work on this computer")
          throw new Error(`#start-local=${local}`)
        const view = await lsGet(MAIN_VIEW_KEY)
        if (view !== "start") throw new Error(`${MAIN_VIEW_KEY}=${view}`)
        return { h1, local, view }
      }
    )
    await step("开始页上列着保存的服务器", async () => {
      must(loadState().remoteId != null, "远程连接没建成")
      const listed = await waitFor(() =>
        browser.execute((n) => document.body.innerText.includes(n), REMOTE_NAME)
      )
      must(listed, `开始页上没有 ${REMOTE_NAME}`)
      return REMOTE_NAME
    })
    await shot("02-start-page")
  })

  it("给第 2 段准备：记号、网页服务随 app 启动", async () => {
    await step("网页服务设成随 app 启动（不指定地址）", async () => {
      ok(
        await invoke("update_web_service_config", {
          config: { token: null, port: null, autoStart: true },
        }),
        "update_web_service_config"
      )
      saveState({ webAutoStart: true })
      return ""
    })
    await step("写 localStorage 记号", async () => {
      const value = `e2e-${Date.now()}`
      await browser.execute(
        (k, v) => localStorage.setItem(k, v),
        MARKER_KEY,
        value
      )
      if ((await lsGet(MARKER_KEY)) !== value) throw new Error("没写进去")
      notes.marker = value
      // WebKit 把 localStorage 落盘是异步的，等一下再让 app 退出
      await flushStorage()
      return value
    })
  })
})
