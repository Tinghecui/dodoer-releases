import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FolderDetail } from "@/lib/types"

/**
 * 「这一页是在当前页里打开的」这个记录要扛得住刷新、扛得住在设置里切换分区
 * （#1332 第 2 次返工）。刷新用 `vi.resetModules()` 重新载入模块来模拟：
 * 模块里的变量全没了，只剩浏览器里的东西（地址、sessionStorage）。
 */

type Nav = typeof import("@/lib/in-page-navigation")

async function freshModule(): Promise<Nav> {
  vi.resetModules()
  return import("@/lib/in-page-navigation")
}

function stubMatchMedia(matches: boolean) {
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query: string) =>
      ({
        matches,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList
  )
}

let nav: Nav

beforeEach(async () => {
  window.sessionStorage.clear()
  nav = await freshModule()
  nav.setInPageRouter({ push: vi.fn(), back: vi.fn() })
})

afterEach(() => {
  vi.restoreAllMocks()
  window.sessionStorage.clear()
  window.history.replaceState({}, "", "/")
})

describe("在当前页打开的记录（#1332）", () => {
  it("在提交页上刷新以后还认得出是在当前页打开的", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/commit?folderId=1&paths=a.ts")
    window.history.replaceState({}, "", "/commit?folderId=1&paths=a.ts")

    const reloaded = await freshModule()
    expect(reloaded.wasOpenedInPage()).toBe(true)
  })

  it("刷新以后拉宽、带 opener，做完也是返回而不是关标签页", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/commit?folderId=1")

    const reloaded = await freshModule()
    const back = vi.fn()
    reloaded.setInPageRouter({ push: vi.fn(), back })
    stubMatchMedia(false)
    // jsdom 的 opener 是普通属性，没法 spy：直接换成一个对象，用完删掉
    Object.defineProperty(window, "opener", { configurable: true, value: {} })
    vi.spyOn(window.history, "length", "get").mockReturnValue(3)
    try {
      expect(reloaded.leaveIfOpenedInPage()).toBe(true)
      expect(back).toHaveBeenCalledTimes(1)
    } finally {
      Reflect.deleteProperty(window, "opener")
    }
  })

  it("在设置里切换到别的分区，还算在当前页打开的", () => {
    nav.navigateInPage("/settings/general")
    window.history.replaceState({}, "", "/settings/appearance")
    expect(nav.wasOpenedInPage()).toBe(true)
  })

  it("别的页面不算（设置的记录不套到提交页上）", () => {
    nav.navigateInPage("/settings/general")
    window.history.replaceState({}, "", "/commit?folderId=1")
    expect(nav.wasOpenedInPage()).toBe(false)
  })

  it("设置里切换过分区，按返回退一节以后，拉宽也还认得出", () => {
    nav.navigateInPage("/settings/general")
    window.history.replaceState({}, "", "/settings/appearance")
    vi.spyOn(window.history, "length", "get").mockReturnValue(4)
    nav.leaveInPage()
    // 只退回到上一个设置分区
    window.history.replaceState({}, "", "/settings/general")
    stubMatchMedia(false)
    expect(nav.wasOpenedInPage()).toBe(true)
  })

  it("用浏览器后退回到工作区、再前进回新建项目页，还认得出", () => {
    nav.navigateInPage("/project-boot")
    window.history.replaceState({}, "", "/workspace")
    expect(nav.wasOpenedInPage()).toBe(false)
    window.history.replaceState({}, "", "/project-boot")
    expect(nav.wasOpenedInPage()).toBe(true)
  })

  it("后退、前进回提交页并拉宽，做完也是返回而不是关标签页", () => {
    nav.navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/workspace")
    window.history.replaceState({}, "", "/commit?folderId=1")
    stubMatchMedia(false)
    const back = vi.fn()
    nav.setInPageRouter({ push: vi.fn(), back })
    vi.spyOn(window.history, "length", "get").mockReturnValue(3)
    expect(nav.leaveIfOpenedInPage()).toBe(true)
    expect(back).toHaveBeenCalledTimes(1)
  })

  it("从当前页打开的设置里再打开导入会话，退回设置还认得出", () => {
    nav.navigateInPage("/settings/general")
    nav.navigateInPage("/import-sessions")
    window.history.replaceState({}, "", "/settings/general")
    expect(nav.wasOpenedInPage()).toBe(true)
  })

  it("另开窗口那一下不把记录复制给新窗口，打开后记录照旧", () => {
    nav.navigateInPage("/settings/general")
    let seenByNewWindow: string | null = "unset"
    nav.withoutInPageRecord(() => {
      seenByNewWindow = window.sessionStorage.getItem("codeg.inPage.openedRoot")
    })
    expect(seenByNewWindow).toBeNull()
    window.history.replaceState({}, "", "/settings/general")
    expect(nav.wasOpenedInPage()).toBe(true)
  })

  it("新建项目页上刷新以后建好的文件夹也记得下来、回到工作区取得到", async () => {
    const detail = {
      id: 7,
      path: "/tmp/demo-app",
      git_branch: null,
    } as unknown as FolderDetail
    nav.navigateInPage("/project-boot")
    window.history.replaceState({}, "", "/project-boot")

    const reloaded = await freshModule()
    expect(reloaded.wasOpenedInPage()).toBe(true)
    reloaded.setPendingWorkspaceFolder(detail)

    // 回到工作区那一下也可能是整页载入
    const workspace = await freshModule()
    expect(workspace.takePendingWorkspaceFolder()).toEqual(detail)
    expect(workspace.takePendingWorkspaceFolder()).toBeNull()
  })

  it("sessionStorage 用不了时退回内存，不报错", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied")
    })
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied")
    })
    nav.navigateInPage("/stash?folderId=1")
    window.history.replaceState({}, "", "/stash?folderId=1")
    expect(nav.wasOpenedInPage()).toBe(true)
  })
})

/** 模拟这一页的载入方式（`performance` 的 navigation 条目）。 */
function stubNavigationType(type: string) {
  vi.spyOn(performance, "getEntriesByType").mockImplementation(
    (entryType: string) =>
      (entryType === "navigation"
        ? [{ type } as unknown as PerformanceEntry]
        : []) as PerformanceEntryList
  )
}

describe("直接打开的页面不认之前留下的记录（#1354）", () => {
  it("在当前页打开过新建项目页、离开后再直接输入地址：建好去工作区，不后退", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/project-boot")
    // 用浏览器后退或跳到别的网站离开，记录还在；之后在地址栏直接输入
    window.history.replaceState({}, "", "/project-boot")
    stubNavigationType("navigate")

    const direct = await freshModule()
    const push = vi.fn()
    const back = vi.fn()
    direct.setInPageRouter({ push, back })
    expect(direct.wasOpenedInPage()).toBe(false)
    direct.leaveProjectBootToWorkspace()
    expect(back).not.toHaveBeenCalled()
    expect(push).toHaveBeenCalledWith("/workspace")
  })

  it("在当前页打开过提交页，宽屏下再直接输入提交页地址：做完按另开的窗口关", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/commit?folderId=1")
    stubNavigationType("navigate")
    stubMatchMedia(false)

    const direct = await freshModule()
    const back = vi.fn()
    direct.setInPageRouter({ push: vi.fn(), back })
    expect(direct.leaveIfOpenedInPage()).toBe(false)
    expect(back).not.toHaveBeenCalled()
  })

  it("刷新、浏览器后退前进载入的照旧认得出", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/commit?folderId=1")

    stubNavigationType("reload")
    expect((await freshModule()).wasOpenedInPage()).toBe(true)
    stubNavigationType("back_forward")
    expect((await freshModule()).wasOpenedInPage()).toBe(true)
  })

  it("还没注册路由、整页跳过去的那一页照旧认得出", async () => {
    stubMatchMedia(true)
    const fresh = await freshModule()
    const assign = vi.fn()
    vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      pathname: "/settings/general",
      assign,
    } as Location)
    fresh.navigateInPage("/settings/general")
    expect(assign).toHaveBeenCalledWith("/settings/general")
    stubNavigationType("navigate")

    const landed = await freshModule()
    expect(landed.wasOpenedInPage()).toBe(true)
  })
})

describe("浏览器后退前进整页恢复在当前页打开过的页面（#1354 第 3 次返工）", () => {
  it("中间直接打开过别的页面清掉了记录，后退回提交页：宽屏下做完照旧返回", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/commit?folderId=1")
    // 提交页挂上以后给这一条历史记下来
    nav.syncInPageHistoryEntry()

    // 整页直接打开别的地址：记录被清掉
    window.history.replaceState(window.history.state, "", "/settings")
    stubNavigationType("navigate")
    const other = await freshModule()
    expect(other.wasOpenedInPage()).toBe(false)

    // 浏览器后退整页恢复提交页（history.state 跟着这一条历史回来）
    window.history.replaceState(window.history.state, "", "/commit?folderId=1")
    stubNavigationType("back_forward")
    stubMatchMedia(false)
    const restored = await freshModule()
    restored.setInPageRouter({ push: vi.fn(), back: vi.fn() })
    expect(restored.wasOpenedInPage()).toBe(true)
    // 在当前页里返回，不去 window.close
    expect(restored.leaveIfOpenedInPage()).toBe(true)
  })

  it("从 bfcache 恢复提交页（模块不重新载入、记录已被别的页面清掉）：宽屏下做完照旧返回", async () => {
    stubMatchMedia(true)
    nav.navigateInPage("/commit?folderId=1")
    window.history.replaceState({}, "", "/commit?folderId=1")
    // 提交页是整页载入的（刷新过），记录只在 sessionStorage 里
    stubNavigationType("reload")
    const commit = await freshModule()
    commit.syncInPageHistoryEntry()
    expect(commit.wasOpenedInPage()).toBe(true)

    // 用户直接打开别的地址，那个页面把 sessionStorage 里的记录清掉了
    window.sessionStorage.clear()
    // 按后退，浏览器从 bfcache 直接恢复提交页：不重新载入模块，只发 pageshow
    const event = new Event("pageshow")
    Object.defineProperty(event, "persisted", { value: true })
    window.dispatchEvent(event)

    stubMatchMedia(false)
    commit.setInPageRouter({ push: vi.fn(), back: vi.fn() })
    expect(commit.wasOpenedInPage()).toBe(true)
    expect(commit.leaveIfOpenedInPage()).toBe(true)
  })

  it("直接打开的页面不给历史记标记，后退回来也不当成在当前页打开的", async () => {
    window.history.replaceState({}, "", "/commit?folderId=1")
    stubNavigationType("navigate")
    const direct = await freshModule()
    direct.syncInPageHistoryEntry()
    stubNavigationType("back_forward")
    stubMatchMedia(false)
    expect((await freshModule()).wasOpenedInPage()).toBe(false)
  })
})
