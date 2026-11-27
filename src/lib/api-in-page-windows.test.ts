import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * 手机布局（窄屏或 iOS 壳）下，设置、提交这些「另开窗口」的页面改为在当前页
 * 里打开（#1332）：不调用 window.open，也不调用桌面窗口命令，路径和参数沿用
 * 网页版原来的。宽屏网页版照旧另开窗口。
 */

const mocks = vi.hoisted(() => ({
  call: vi.fn(),
  shellCall: vi.fn(),
  isDesktop: vi.fn(() => false),
  push: vi.fn(),
  back: vi.fn(),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: mocks.call }),
  getShellTransport: () => ({ call: mocks.shellCall }),
  isDesktop: mocks.isDesktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
  notifyRemoteDesktopUnauthorized: vi.fn(),
}))

import {
  openCommitWindow,
  openFolderInWorkspace,
  openImportSessionsWindow,
  openMergeWindow,
  openProjectBootWindow,
  openPushWindow,
  openSettingsWindow,
  openStashWindow,
} from "@/lib/api"
import {
  navigateInPage,
  setInPageRouter,
  takePendingWorkspaceFolder,
} from "@/lib/in-page-navigation"

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

let unregister: () => void = () => {}

beforeEach(() => {
  mocks.call.mockReset()
  mocks.shellCall.mockReset()
  mocks.isDesktop.mockReset()
  mocks.isDesktop.mockReturnValue(false)
  mocks.push.mockReset()
  mocks.back.mockReset()
  unregister = setInPageRouter({ push: mocks.push, back: mocks.back })
})

afterEach(() => {
  unregister()
  vi.restoreAllMocks()
  delete (window as unknown as Record<string, unknown>).__CODEG_SHELL__
})

describe("手机布局下在当前页打开", () => {
  it.each([
    [
      "设置",
      () => openSettingsWindow("appearance"),
      "/settings/appearance?locale=en",
      "open_settings_window",
      { section: "appearance", agentType: null, focus: null },
    ],
    [
      "推送",
      () => openPushWindow(7, "dev"),
      "/push?folderId=7&branch=dev",
      "open_push_window",
      { folderId: 7, branch: "dev" },
    ],
    [
      "stash",
      () => openStashWindow(7),
      "/stash?folderId=7",
      "open_stash_window",
      { folderId: 7 },
    ],
    [
      "合并",
      () => openMergeWindow(7, "merge", "abc"),
      "/merge?folderId=7&operation=merge",
      "open_merge_window",
      { folderId: 7, operation: "merge", upstreamCommit: "abc" },
    ],
    [
      "导入会话",
      () => openImportSessionsWindow({ focusPath: "/tmp/demo" }),
      "/import-sessions?focusPath=%2Ftmp%2Fdemo",
      "open_import_sessions_window",
      { focusPath: "/tmp/demo" },
    ],
  ])(
    "%s：带着参数问后端要路径，导航过去，不开新窗口",
    async (_name, open, path, command, args) => {
      stubMatchMedia(true)
      const winOpen = vi.spyOn(window, "open")
      mocks.call.mockResolvedValue({ path })

      await open()

      // 参数漏传时后端给的路径不对，光看导航不够（#1354）
      expect(mocks.call).toHaveBeenCalledTimes(1)
      expect(mocks.call).toHaveBeenCalledWith(
        command,
        expect.objectContaining(args)
      )
      expect(mocks.push).toHaveBeenCalledWith(path)
      expect(winOpen).not.toHaveBeenCalled()
      expect(mocks.shellCall).not.toHaveBeenCalled()
    }
  )

  it("提交：带上勾选的路径参数", async () => {
    stubMatchMedia(true)
    const winOpen = vi.spyOn(window, "open")
    mocks.call.mockResolvedValue({ path: "/commit?folderId=7" })

    await openCommitWindow(7, { paths: ["src/a.ts"] })

    expect(mocks.call).toHaveBeenCalledWith(
      "open_commit_window",
      expect.objectContaining({ folderId: 7 })
    )
    expect(winOpen).not.toHaveBeenCalled()
    expect(mocks.push).toHaveBeenCalledTimes(1)
    const pushed = String(mocks.push.mock.calls[0][0])
    expect(pushed.startsWith("/commit?folderId=7")).toBe(true)
    expect(pushed).toContain("src%2Fa.ts")
  })

  it("新建项目：导航到 /project-boot", async () => {
    stubMatchMedia(true)
    const winOpen = vi.spyOn(window, "open")

    await openProjectBootWindow("sidebar")

    expect(mocks.push).toHaveBeenCalledWith("/project-boot")
    expect(winOpen).not.toHaveBeenCalled()
  })

  it("iOS 壳里即使宽屏也在当前页打开，不调桌面命令", async () => {
    stubMatchMedia(false)
    ;(window as unknown as Record<string, unknown>).__CODEG_SHELL__ = "ios"
    const winOpen = vi.spyOn(window, "open")
    mocks.call.mockResolvedValue({ path: "/settings/general" })

    await openSettingsWindow()

    expect(mocks.push).toHaveBeenCalledWith("/settings/general")
    expect(winOpen).not.toHaveBeenCalled()
    expect(mocks.shellCall).not.toHaveBeenCalled()
  })
})

describe("宽屏不变", () => {
  it("宽屏网页版仍另开窗口", async () => {
    stubMatchMedia(false)
    const popup = { location: { href: "about:blank" }, close: vi.fn() }
    const winOpen = vi
      .spyOn(window, "open")
      .mockReturnValue(popup as unknown as Window)
    mocks.call.mockResolvedValue({ path: "/settings/general" })

    await openSettingsWindow()

    expect(winOpen).toHaveBeenCalledWith("", "settings-general")
    expect(popup.location.href).toBe("/settings/general")
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("宽屏另开窗口时，新窗口复制不到「在当前页打开」的记录", async () => {
    // 先在当前页打开过设置（比如窄屏时），后来拉宽了再另开
    navigateInPage("/settings/general")
    stubMatchMedia(false)
    const seen: (string | null)[] = []
    const popup = { location: { href: "about:blank" }, close: vi.fn() }
    vi.spyOn(window, "open").mockImplementation(() => {
      seen.push(window.sessionStorage.getItem("codeg.inPage.openedRoot"))
      return popup as unknown as Window
    })
    mocks.call.mockResolvedValue({ path: "/settings/general" })

    await openSettingsWindow()
    await openProjectBootWindow()

    expect(seen).toEqual([null, null])
    expect(window.sessionStorage.getItem("codeg.inPage.openedRoot")).not.toBe(
      null
    )
    navigateInPage("/workspace")
  })

  it("宽屏网页版新建项目仍另开窗口", async () => {
    stubMatchMedia(false)
    const winOpen = vi.spyOn(window, "open").mockReturnValue(null)

    await openProjectBootWindow()

    expect(winOpen).toHaveBeenCalledWith("/project-boot", "project-boot")
    expect(mocks.push).not.toHaveBeenCalled()
  })

  it("桌面版即使窗口窄也走窗口命令", async () => {
    stubMatchMedia(true)
    mocks.isDesktop.mockReturnValue(true)
    mocks.shellCall.mockResolvedValue(undefined)

    await openStashWindow(7)

    expect(mocks.shellCall).toHaveBeenCalledWith(
      "open_stash_window",
      expect.objectContaining({ folderId: 7 })
    )
    expect(mocks.push).not.toHaveBeenCalled()
  })
})

// 返工（#1332）：新建项目页在当前页打开时，工作区没挂着、收不到广播，
// 建好的文件夹要记下来等工作区回来取
describe("openFolderInWorkspace", () => {
  const detail = { id: 7, path: "/tmp/demo-app", git_branch: null }

  afterEach(() => {
    navigateInPage("/workspace")
    takePendingWorkspaceFolder()
    window.history.replaceState({}, "", "/")
  })

  it("新建项目页是在当前页打开的：把文件夹记下来", async () => {
    stubMatchMedia(true)
    await openProjectBootWindow()
    window.history.replaceState({}, "", "/project-boot")
    mocks.call.mockResolvedValue(detail)
    await expect(openFolderInWorkspace("/tmp/demo-app")).resolves.toBe(detail)
    expect(mocks.call).toHaveBeenCalledWith("open_folder_in_workspace", {
      path: "/tmp/demo-app",
    })
    expect(takePendingWorkspaceFolder()).toEqual(detail)
  })

  it("手机上直接打开的新建项目页（没有当前页打开的记录）也记下来", async () => {
    stubMatchMedia(true)
    window.history.replaceState({}, "", "/project-boot")
    mocks.call.mockResolvedValue(detail)
    await openFolderInWorkspace("/tmp/demo-app")
    expect(takePendingWorkspaceFolder()).toEqual(detail)
  })

  it("手机上带 opener 的链接另开的新建项目页也记下来（建好会回到工作区）", async () => {
    stubMatchMedia(true)
    vi.stubGlobal("opener", {})
    window.history.replaceState({}, "", "/project-boot")
    mocks.call.mockResolvedValue(detail)
    await openFolderInWorkspace("/tmp/demo-app")
    vi.unstubAllGlobals()
    expect(takePendingWorkspaceFolder()).toEqual(detail)
  })

  it("桌面版窗口窄也不记（广播收得到）", async () => {
    stubMatchMedia(true)
    mocks.isDesktop.mockReturnValue(true)
    window.history.replaceState({}, "", "/project-boot")
    mocks.call.mockResolvedValue(detail)
    await openFolderInWorkspace("/tmp/demo-app")
    expect(takePendingWorkspaceFolder()).toBeNull()
  })

  it("另开窗口的新建项目页不记（工作区开着，收得到广播）", async () => {
    vi.stubGlobal("opener", {})
    window.history.replaceState({}, "", "/project-boot")
    mocks.call.mockResolvedValue(detail)
    await openFolderInWorkspace("/tmp/demo-app")
    vi.unstubAllGlobals()
    expect(takePendingWorkspaceFolder()).toBeNull()
  })

  // #1595：宽屏网页版直接打开的新建项目页，建好以后在这一页回到工作区，
  // 要把文件夹记下来给工作区接着打开
  it("宽屏网页版直接打开的新建项目页（没有 opener）也记下来", async () => {
    window.history.replaceState({}, "", "/project-boot")
    mocks.call.mockResolvedValue(detail)
    await openFolderInWorkspace("/tmp/demo-app")
    expect(takePendingWorkspaceFolder()).toEqual(detail)
  })
})
