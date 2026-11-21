// 第 2 段，第二次启动（同一个数据目录，第 1 段的 app 已经退了）：只有一个 app 进程、localStorage 记号还在、
// 停在开始页（上次回到了开始页，N3）；在开始页选本机，进本机工作区并记住这个选择（第 3 段查）
import {
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

  it("开始页 → 选本机：进本机工作区，并记住这个选择", async () => {
    await step("点「本机」那一段的按钮，进本机工作区", async () => {
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
})
