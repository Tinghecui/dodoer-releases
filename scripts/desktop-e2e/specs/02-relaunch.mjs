// 第二次启动（同一个数据目录，第一次的 app 已经退了）：只有一个 app 进程、localStorage 记号还在、停在开始页（上次回到了开始页）
import {
  MAIN_VIEW_KEY,
  MARKER_KEY,
  codegPids,
  lsGet,
  notes,
  shot,
  step,
  waitForUi,
  writeResult,
} from "./lib.mjs"

describe("桌面 app 退出重开", () => {
  after(() => writeResult())

  it("重开以后状态还在", async () => {
    await step("主窗口界面画出来", () => waitForUi())
    await step("只有这一个 app 进程（上一次的退干净了）", async () => {
      const pids = codegPids()
      notes.pids = pids
      if (pids.length !== 1)
        throw new Error(`codeg 进程：${pids.join(" ") || "无"}`)
      return pids
    })
    await step("localStorage 记号还在", async () => {
      const v = await lsGet(MARKER_KEY)
      if (!v || !v.startsWith("spike-"))
        throw new Error(`${MARKER_KEY}=${JSON.stringify(v)}`)
      return v
    })
    await step("停在开始页", async () => {
      await $("#start-local").waitForExist({ timeout: 60000 })
      const view = await lsGet(MAIN_VIEW_KEY)
      if (view !== "start")
        throw new Error(`${MAIN_VIEW_KEY}=${JSON.stringify(view)}`)
      return { view, h1: await $("h1").getText() }
    })
    await shot("01-relaunch")
  })
})
