// 第 1 段，第一次启动（新装、没有保存的服务器）：直接进本机工作区；用 Radix 菜单回开始页（stories.md N3）；开设置窗口切过去读 DOM、
// 切回来关掉；留一个 localStorage 记号给后面几段查。
// 文字一律读具体元素的 innerText（textOf），不读 body 的 getText。切窗口用 tauri-service 按 Tauri 窗口标签切（要 tauri-plugin-wdio）
import {
  MAIN_VIEW_KEY,
  MARKER_KEY,
  codegPids,
  flushStorage,
  invoke,
  lsGet,
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

  it("Quick actions →「Back to start page」回到开始页（N3）", async () => {
    await step("点 Quick actions（派发 pointer 事件），菜单打开", async () => {
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
    await shot("02-start-page")
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

  it("留一个 localStorage 记号给后面几段", async () => {
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
