// 第 3 段，第三次启动：上次在开始页选了本机，这次直接进本机工作区，不再停在开始页；记号还在；
// 排队的消息还在、标成失败、没有自己发出去（#681）；已存的网页服务地址 0.0.0.0 保持（#684）；
// 最后抹掉记住的选择再加载一次：有保存的服务器、第一次启动的样子是开始页。后几项移植自 scripts/desktop-linux-smoke.mjs 的第三次启动。
import {
  QUEUE_PREFIX,
  QUEUE_TEXT,
  REMOTE_NAME,
  WEB_PORT,
  click,
  fmtListen,
  invoke,
  listening,
  loadState,
  must,
  ok,
  waitFor,
  waitStartPage,
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

  it("排队的消息还在，标成失败，没有自己发出去（#681）", async () => {
    await step("界面上看得见那条标成失败的排队消息", async () => {
      const { conversationId } = loadState()
      must(conversationId != null, "第 2 段没把会话和排队消息准备好")
      const shown = await waitFor(() => browser.execute(queueItem), 30000)
      must(shown, "界面上没有标成失败的排队消息")
      must(shown.text.includes(QUEUE_TEXT), `排队消息的字不对：${shown.text}`)
      let seen = shown.visible ? shown : null
      let how = "一开始就在前面"
      // 那个会话的 tab 不在前面时整个面板是 visibility:hidden 的：像用户一样点侧栏里的这个会话切过去，再要求看得见
      if (!seen) {
        how = `一开始看不见（${shown.inHiddenTab ? "在后面的 tab 里" : ""}${shown.hiddenBy ? `被 ${shown.hiddenBy} 藏着` : ""}${shown.coveredBy ? `被 ${shown.coveredBy} 盖着` : ""}），点侧栏切过去`
        await click(`button[data-conversation-id="${conversationId}"]`)
        let last = shown
        seen = await waitFor(async () => {
          last = await browser.execute(queueItem)
          return last && last.visible ? last : null
        }, 20000)
        must(seen, `${how}以后还是看不见：${JSON.stringify(last)}`)
      }
      await shot("02-queued-message")
      return { how, items: seen.items }
    })
    await step("localStorage 里那条标上了失败原因、还在队列里", async () => {
      const { conversationId, queueItemId } = loadState()
      const stored = await waitFor(
        () =>
          browser.execute(
            (key, id) => {
              const raw = localStorage.getItem(key)
              const list = raw ? JSON.parse(raw) : []
              const item = list.find((i) => i.id === id)
              return item && item.failure
                ? { failure: item.failure, items: list.length }
                : null
            },
            `${QUEUE_PREFIX}${conversationId}`,
            queueItemId
          ),
        20000
      )
      must(stored, "localStorage 里那条没标上失败原因")
      return stored
    })
  })

  it("网页服务：已存的 0.0.0.0 保持（#684）", async () => {
    await step(
      `${WEB_PORT} 绑在 0.0.0.0；不带 host 再存一次还是 0.0.0.0`,
      async () => {
        must(loadState().webAnyHost, "第 2 段没设成 0.0.0.0")
        const ls = await waitFor(() => {
          const l = listening(WEB_PORT)
          return l.length ? l : null
        }, 60000)
        must(ls, `60 秒内 ${WEB_PORT} 没人听`)
        must(
          ls.every((l) => l.addr === "0.0.0.0"),
          `没绑在 0.0.0.0：${fmtListen(ls)}`
        )
        // 不认识地址这一项的旧客户端保存设置（不带 host）：存着的 0.0.0.0 不能被改回去
        ok(
          await invoke("update_web_service_config", {
            config: { token: null, port: null, autoStart: true },
          }),
          "update_web_service_config"
        )
        const cfg = ok(
          await invoke("get_web_service_config"),
          "get_web_service_config"
        )
        must(
          cfg.host === "0.0.0.0",
          `不带 host 保存以后变成了 ${JSON.stringify(cfg)}`
        )
        return fmtListen(ls)
      }
    )
  })

  it("有保存的服务器、没记住选择（第一次启动的样子）：主窗口是开始页", async () => {
    await step("抹掉记住的选择再加载，开始页列着保存的服务器", async () => {
      must(
        loadState().remoteId != null,
        "没有保存的服务器（第 1 段远程那项没成）"
      )
      await useMainWindow()
      await browser.execute((k) => {
        localStorage.removeItem(k)
        location.reload()
      }, MAIN_VIEW_KEY)
      await waitStartPage()
      const listed = await waitFor(() =>
        browser.execute((n) => document.body.innerText.includes(n), REMOTE_NAME)
      )
      must(listed, `开始页上没有 ${REMOTE_NAME}`)
      await shot("03-first-run-with-server")
      return REMOTE_NAME
    })
  })
})

// 排队那一条在不在 DOM 里、用户看不看得见：有大小、没有被 display:none / visibility:hidden 藏起来（visibility 会继承，
// 报的是真正设了它的那一层）、中心点上没有别的元素盖着（同 desktop-linux-smoke.mjs）
function queueItem() {
  const item = document.querySelector("[data-queue-item][data-queue-failed]")
  if (!item) return null
  const r = item.getBoundingClientRect()
  const name = (el) =>
    el.tagName.toLowerCase() +
    (el.id ? "#" + el.id : "") +
    "." +
    String(el.className).slice(0, 90)
  let hiddenBy = null
  for (let el = item; el && el !== document.body; el = el.parentElement) {
    const cs = getComputedStyle(el)
    const parentHidden =
      el.parentElement &&
      getComputedStyle(el.parentElement).visibility === "hidden"
    if (
      cs.display === "none" ||
      el.hidden ||
      (cs.visibility === "hidden" && !parentHidden)
    )
      hiddenBy = name(el)
  }
  let coveredBy = null
  if (!hiddenBy && r.width > 0 && r.height > 0) {
    const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
    if (!top) coveredBy = "窗口外"
    else if (!item.contains(top)) coveredBy = name(top)
  }
  return {
    text: item.textContent.slice(0, 200),
    items: document.querySelectorAll("[data-queue-item]").length,
    visible: r.width > 0 && r.height > 0 && !hiddenBy && !coveredBy,
    hiddenBy,
    coveredBy,
    inHiddenTab: !!item.closest(".conversation-tab-hidden"),
  }
}
