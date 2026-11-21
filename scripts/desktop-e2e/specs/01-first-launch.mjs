// 第一次启动（新装）：读主窗口 DOM、点按钮回开始页、开设置窗口并切过去、留一个 localStorage 记号给第二次启动查
import {
  MAIN_VIEW_KEY,
  MARKER_KEY,
  click,
  codegPids,
  invoke,
  lsGet,
  notes,
  shot,
  step,
  waitForUi,
  writeResult,
} from "./lib.mjs"

describe("桌面 app 第一次启动", () => {
  let main = null

  after(() => writeResult())

  it("主窗口画出来，读得到 DOM", async () => {
    await step("主窗口界面画出来", async () => {
      const s = await waitForUi()
      if (s.tauri !== "object")
        throw new Error(`没有 __TAURI_INTERNALS__：${JSON.stringify(s)}`)
      main = await browser.getWindowHandle()
      notes.mainHandle = main
      notes.pids = codegPids()
      return s
    })
    await step("$('body').getText() 读到文字", async () => {
      const text = await $("body").getText()
      if (!text.trim()) throw new Error("body 没有文字")
      notes.bodyText = text.slice(0, 300)
      // 对照：页面自己算的 innerText（W3C 的 getElementText 应该和它一样，只含看得见的文字）
      const inner = await browser.execute(() => document.body.innerText)
      notes.bodyInnerText = inner.slice(0, 300)
      notes.getTextMatchesInnerText = text.trim() === inner.trim()
      return {
        getText: text.slice(0, 120),
        innerText: inner.slice(0, 120),
        same: notes.getTextMatchesInnerText,
      }
    })
    await shot("01-launch")
  })

  it("新装直接进本机工作区，点「Quick actions」→「Back to start page」回到开始页", async () => {
    await step("本机工作区画出来（有 Quick actions 按钮）", async () => {
      await $('button[title="Quick actions"]').waitForDisplayed({
        timeout: 60000,
      })
      return { view: await lsGet(MAIN_VIEW_KEY) }
    })
    await step("点 Quick actions，菜单打开", () =>
      click(
        'button[title="Quick actions"]',
        async () => (await $$("[role='menuitem']").length) > 0,
        "quick-actions"
      )
    )
    await step("点菜单里的 Back to start page，开始页出来", async () => {
      const how = await click(
        "//*[@role='menuitem'][contains(., 'Back to start page')]",
        async () => await $("#start-local").isExisting(),
        "back-to-start"
      )
      const h1 = await $("h1").getText()
      const local = await $("#start-local").getText()
      const view = await lsGet(MAIN_VIEW_KEY)
      if (view !== "start")
        throw new Error(`${MAIN_VIEW_KEY}=${JSON.stringify(view)}`)
      notes.startPage = { h1, local }
      return { how, h1, local, view }
    })
    await shot("02-start-page")
  })

  it("开设置窗口、切过去读 DOM、关掉、切回主窗口", async () => {
    await step("open_settings_window 开出第二个窗口句柄", async () => {
      const r = await invoke("open_settings_window", { section: "web-service" })
      if (r && "err" in r) throw new Error(`open_settings_window：${r.err}`)
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length > 1,
        { timeout: 30000, timeoutMsg: "没出现第二个窗口句柄" }
      )
      const handles = await browser.getWindowHandles()
      notes.handlesWithSettings = handles
      return handles
    })
    await step("切到设置窗口，读得到它的 DOM", async () => {
      let found = null
      await browser.waitUntil(
        async () => {
          for (const h of await browser.getWindowHandles()) {
            await browser.switchToWindow(h)
            if ((await browser.getUrl()).includes("/settings")) {
              found = h
              return true
            }
          }
          return false
        },
        { timeout: 30000, timeoutMsg: "没有地址带 /settings 的窗口" }
      )
      await waitForUi(60000)
      const url = await browser.getUrl()
      const title = await browser.getTitle()
      const text = (await $("body").getText()).slice(0, 200)
      await shot("03-settings")
      return { handle: found, url, title, text }
    })
    await step("切回主窗口，从主窗口关掉设置窗口", async () => {
      // 先切回去：在设置窗口里关它自己，回不来结果（no such window）
      await browser.switchToWindow(main)
      const r = await invoke("plugin:window|close", { label: "settings" })
      if (r && "err" in r) throw new Error(`close：${r.err}`)
      await browser.waitUntil(
        async () => (await browser.getWindowHandles()).length === 1,
        { timeout: 20000, timeoutMsg: "设置窗口没关掉" }
      )
      return {
        url: await browser.getUrl(),
        handles: await browser.getWindowHandles(),
      }
    })
  })

  it("留一个 localStorage 记号给第二次启动", async () => {
    await step("写 localStorage 记号", async () => {
      const value = `spike-${Date.now()}`
      await browser.execute(
        (k, v) => localStorage.setItem(k, v),
        MARKER_KEY,
        value
      )
      if ((await lsGet(MARKER_KEY)) !== value) throw new Error("没写进去")
      notes.marker = value
      // WebKit 把 localStorage 落盘是异步的，等一下再让 app 退出
      await browser.pause(3000)
      return value
    })
  })
})
