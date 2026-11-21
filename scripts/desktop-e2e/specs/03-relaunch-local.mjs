// 第 3 段，第三次启动：上次在开始页选了本机，这次直接进本机工作区，不再停在开始页；记号还在
import {
  MAIN_VIEW_KEY,
  MARKER_KEY,
  codegPids,
  lsGet,
  notes,
  shot,
  step,
  useMainWindow,
  waitForUi,
  waitWorkspace,
  writeResult,
} from "./lib.mjs"

describe("桌面 app 退出重开（第三次启动）", () => {
  after(() => writeResult())

  it("上次选了本机，这次直接进本机工作区", async () => {
    await step("主窗口界面画出来，只有一个 app 进程", async () => {
      const s = await waitForUi()
      await useMainWindow()
      const pids = codegPids()
      notes.pids = pids
      if (pids.length !== 1)
        throw new Error(`codeg 进程：${pids.join(" ") || "无"}`)
      return s
    })
    await step("直接进本机工作区", async () => {
      await waitWorkspace()
      const view = await lsGet(MAIN_VIEW_KEY)
      if (view !== "local")
        throw new Error(`${MAIN_VIEW_KEY}=${JSON.stringify(view)}`)
      return { view }
    })
    await step("第 1 段写的记号还在", async () => {
      const v = await lsGet(MARKER_KEY)
      if (!v || !v.startsWith("e2e-"))
        throw new Error(`${MARKER_KEY}=${JSON.stringify(v)}`)
      return v
    })
    await shot("01-relaunch-local")
  })
})
