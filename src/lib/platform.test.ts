import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * `openUrl` is the app's only sanctioned way to leave for the outside world
 * (see `@/components/ui/browser-link`, which routes every external link
 * through it), so both of its branches are load-bearing:
 *
 * - A Tauri webview opens nothing for `window.open` / `target="_blank"` — no
 *   new-window handler is registered — so ANY Tauri window, remote workspace
 *   included, has to reach the opener plugin.
 * - The web branch must pass `noreferrer`, or the page we open keeps a
 *   `window.opener` handle back into the app.
 */

const mocks = vi.hoisted(() => ({
  isDesktop: vi.fn(() => false),
  getActiveRemoteConnectionId: vi.fn<() => string | null>(() => null),
  tauriOpenUrl: vi.fn(async () => {}),
  tauriOpenPath: vi.fn(async () => {}),
  tauriReveal: vi.fn(async () => {}),
  tauriDialogOpen: vi.fn<(options: unknown) => Promise<unknown>>(
    async () => null
  ),
  tauriWindowClose: vi.fn<() => Promise<void>>(async () => {}),
}))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({}),
  isDesktop: mocks.isDesktop,
  getActiveRemoteConnectionId: mocks.getActiveRemoteConnectionId,
}))

vi.mock("@tauri-apps/plugin-opener", () => ({
  openUrl: mocks.tauriOpenUrl,
  openPath: mocks.tauriOpenPath,
  revealItemInDir: mocks.tauriReveal,
}))

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: mocks.tauriDialogOpen,
}))

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ close: mocks.tauriWindowClose }),
}))

import { navigateInPage, setInPageRouter } from "@/lib/in-page-navigation"
import {
  closeAppWindow,
  closeCurrentWindow,
  leaveProjectBoot,
  openFileDialog,
  openPath,
  openUrl,
  revealItemInDir,
} from "@/lib/platform"

const URL = "https://example.com/issues/1"

beforeEach(() => {
  mocks.isDesktop.mockReset()
  mocks.isDesktop.mockReturnValue(false)
  mocks.getActiveRemoteConnectionId.mockReset()
  mocks.getActiveRemoteConnectionId.mockReturnValue(null)
  mocks.tauriOpenUrl.mockClear()
  mocks.tauriOpenPath.mockClear()
})

describe("openUrl", () => {
  it("uses the opener plugin on a local desktop window", async () => {
    mocks.isDesktop.mockReturnValue(true)
    await openUrl(URL)
    expect(mocks.tauriOpenUrl).toHaveBeenCalledWith(URL)
  })

  it("uses the opener plugin in a remote-workspace window too", async () => {
    // A remote-desktop window is still a Tauri webview: falling through to
    // `window.open` here would leave every external link dead.
    mocks.isDesktop.mockReturnValue(true)
    mocks.getActiveRemoteConnectionId.mockReturnValue("conn-7")
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    await openUrl(URL)
    expect(mocks.tauriOpenUrl).toHaveBeenCalledWith(URL)
    expect(open).not.toHaveBeenCalled()
    open.mockRestore()
  })

  it("opens a web-mode tab with noreferrer, so the page gets no opener", async () => {
    mocks.isDesktop.mockReturnValue(false)
    const open = vi.spyOn(window, "open").mockReturnValue(null)
    await openUrl(URL)
    expect(open).toHaveBeenCalledWith(URL, "_blank", "noreferrer")
    expect(mocks.tauriOpenUrl).not.toHaveBeenCalled()
    open.mockRestore()
  })
})

describe("openPath", () => {
  it("keeps its remote guard — a path belongs to a specific host", async () => {
    // The contrast that explains why `openUrl` drops the guard: revealing a
    // remote workspace's path on the LOCAL filesystem would open the wrong
    // machine's file, or nothing at all.
    mocks.isDesktop.mockReturnValue(true)
    mocks.getActiveRemoteConnectionId.mockReturnValue("conn-7")
    await openPath("/repo/README.md")
    expect(mocks.tauriOpenPath).not.toHaveBeenCalled()

    mocks.getActiveRemoteConnectionId.mockReturnValue(null)
    await openPath("/repo/README.md")
    expect(mocks.tauriOpenPath).toHaveBeenCalledWith("/repo/README.md")
  })
})

describe("revealItemInDir", () => {
  beforeEach(() => {
    mocks.tauriReveal.mockReset()
    mocks.tauriReveal.mockResolvedValue(undefined)
  })

  it("reveals the item itself when the shell can take it", async () => {
    mocks.isDesktop.mockReturnValue(true)
    await revealItemInDir("C:\\Users\\a\\Downloads\\file.zip")
    expect(mocks.tauriReveal).toHaveBeenCalledWith(
      "C:\\Users\\a\\Downloads\\file.zip"
    )
    expect(mocks.tauriOpenPath).not.toHaveBeenCalled()
  })

  // A download that landed on a share: the plugin resolves the path to the
  // extended `\\?\UNC\…` form the Windows shell refuses, and "show in folder"
  // was simply dead. The folder without the selection still gets the user
  // there.
  it("opens the containing folder when the item cannot be revealed", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.tauriReveal.mockRejectedValue(new Error("to ITEMIDLIST"))
    await revealItemInDir("\\\\Mac\\Home\\Downloads\\file.zip")
    expect(mocks.tauriOpenPath).toHaveBeenCalledWith("\\\\Mac\\Home\\Downloads")
  })

  // A POSIX name may contain a backslash; the folder is the one before the
  // last slash, not the one before the backslash.
  it("does not cut a unix path at a backslash in the file name", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.tauriReveal.mockRejectedValue(new Error("nope"))
    await revealItemInDir("/Users/me/Downloads/report\\2026.pdf")
    expect(mocks.tauriOpenPath).toHaveBeenCalledWith("/Users/me/Downloads")
  })

  // Windows takes either separator, and a path may mix them.
  it("cuts a windows path at whichever separator comes last", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.tauriReveal.mockRejectedValue(new Error("nope"))
    await revealItemInDir("C:\\Users/me\\Downloads\\file.zip")
    expect(mocks.tauriOpenPath).toHaveBeenCalledWith("C:\\Users/me\\Downloads")
  })

  it("rethrows when there is no folder to fall back to", async () => {
    mocks.isDesktop.mockReturnValue(true)
    mocks.tauriReveal.mockRejectedValue(new Error("nope"))
    await expect(revealItemInDir("\\\\Mac")).rejects.toThrow("nope")
    expect(mocks.tauriOpenPath).not.toHaveBeenCalled()
  })
})

describe("openFileDialog", () => {
  beforeEach(() => {
    mocks.tauriDialogOpen.mockReset()
    mocks.tauriDialogOpen.mockResolvedValue(null)
  })

  // The macOS panel's "New Folder" button: a folder picker should be able to
  // make the folder it is about to pick, without leaving for Finder.
  it("asks the native folder picker for its New Folder button", async () => {
    mocks.isDesktop.mockReturnValue(true)
    await openFileDialog({ directory: true, multiple: false })
    expect(mocks.tauriDialogOpen).toHaveBeenCalledWith({
      directory: true,
      multiple: false,
      canCreateDirectories: true,
    })
  })

  it("leaves a file picker's options as they are", async () => {
    mocks.isDesktop.mockReturnValue(true)
    await openFileDialog({ title: "Pick" })
    expect(mocks.tauriDialogOpen).toHaveBeenCalledWith({ title: "Pick" })
  })
})

describe("closeAppWindow", () => {
  beforeEach(() => {
    mocks.tauriWindowClose.mockReset()
    mocks.tauriWindowClose.mockResolvedValue(undefined)
  })

  it("closes the browser window the app opened, not the Tauri one", async () => {
    let closed = false
    const close = vi.spyOn(window, "close").mockImplementation(() => {
      closed = true
    })
    // jsdom has no `window.closed`; a browser sets it as the close begins.
    Object.defineProperty(window, "closed", {
      configurable: true,
      get: () => closed,
    })
    try {
      await expect(closeAppWindow()).resolves.toBe(true)
      expect(close).toHaveBeenCalledTimes(1)
      expect(mocks.tauriWindowClose).not.toHaveBeenCalled()
    } finally {
      close.mockRestore()
      Reflect.deleteProperty(window, "closed")
    }
  })

  it("reports a browser tab that refuses to close", async () => {
    // A tab the user opened on the link: the browser ignores `close()`.
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    const back = vi.spyOn(window.history, "back")
    try {
      await expect(closeAppWindow()).resolves.toBe(false)
      // Never `history.back()`: that would land on the blank placeholder.
      expect(back).not.toHaveBeenCalled()
    } finally {
      close.mockRestore()
      back.mockRestore()
    }
  })

  it("closes the Tauri window on desktop, and reports a failure", async () => {
    mocks.isDesktop.mockReturnValue(true)
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      await expect(closeAppWindow()).resolves.toBe(true)
      expect(mocks.tauriWindowClose).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()

      mocks.tauriWindowClose.mockRejectedValueOnce(new Error("gone"))
      await expect(closeAppWindow()).resolves.toBe(false)
    } finally {
      close.mockRestore()
      error.mockRestore()
    }
  })
})

// #1332：手机布局下设置、提交这些页面是在当前页里打开的，「关掉」就是返回
describe("closeAppWindow 在手机布局下", () => {
  function stubMobile(matches: boolean) {
    return vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
  }

  it("在当前页打开的页面返回上一页，不关窗口", async () => {
    const media = stubMobile(true)
    window.history.pushState({}, "", "/commit?folderId=1")
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    try {
      await expect(closeAppWindow()).resolves.toBe(true)
      expect(back).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
    } finally {
      media.mockRestore()
      close.mockRestore()
      back.mockRestore()
    }
  })

  it("脚本另开的窗口（有 opener）照旧关掉", async () => {
    const media = stubMobile(true)
    // jsdom 的 opener 是普通属性，没法 spy：直接换成一个对象，用完删掉
    Object.defineProperty(window, "opener", {
      configurable: true,
      value: {},
    })
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    try {
      await closeAppWindow()
      expect(close).toHaveBeenCalledTimes(1)
      expect(back).not.toHaveBeenCalled()
    } finally {
      media.mockRestore()
      Reflect.deleteProperty(window, "opener")
      close.mockRestore()
      back.mockRestore()
    }
  })
})

// 返工（#1332）：在当前页打开的，看的是「打开时的记录」，不看现在的宽度和 opener
describe("closeAppWindow 在当前页打开以后", () => {
  const router = { push: vi.fn(), back: vi.fn() }
  let unregister: () => void = () => {}

  beforeEach(() => {
    router.push.mockReset()
    router.back.mockReset()
    unregister = setInPageRouter(router)
    navigateInPage("/commit?folderId=1&paths=a")
    window.history.pushState({}, "", "/commit?folderId=1&paths=a")
  })

  afterEach(() => {
    navigateInPage("/workspace")
    unregister()
    window.history.replaceState({}, "", "/")
    Reflect.deleteProperty(window, "opener")
    vi.restoreAllMocks()
  })

  it("工作区标签页本身带 opener，也返回而不是关掉整个标签页", async () => {
    Object.defineProperty(window, "opener", { configurable: true, value: {} })
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    await expect(closeAppWindow()).resolves.toBe(true)
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })

  it("打开以后把浏览器拉宽，也返回而不是关掉整个标签页", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: false,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
    const close = vi.spyOn(window, "close").mockImplementation(() => {})
    await expect(closeAppWindow()).resolves.toBe(true)
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(close).not.toHaveBeenCalled()
  })
})

// #1354：新建项目页直接用链接打开（没有当前页打开的记录）时，建好项目离开要
// 回到工作区，不能停在新建项目页，也不能退回到别的网站
describe("leaveProjectBoot 在手机布局下", () => {
  const router = { push: vi.fn(), back: vi.fn() }
  let unregister: () => void = () => {}

  beforeEach(() => {
    router.push.mockReset()
    router.back.mockReset()
    unregister = setInPageRouter(router)
    window.history.replaceState({}, "", "/project-boot")
  })

  afterEach(() => {
    navigateInPage("/workspace")
    unregister()
    window.history.replaceState({}, "", "/")
    vi.restoreAllMocks()
  })

  function stubMobile(matches: boolean) {
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

  it("没有历史记录：回到工作区", async () => {
    stubMobile(true)
    vi.spyOn(window.history, "length", "get").mockReturnValue(1)
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    await leaveProjectBoot()
    expect(router.push).toHaveBeenCalledWith("/workspace")
    expect(router.back).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
  })

  it("直接打开、标签页里有别的历史：也回到工作区，不后退", async () => {
    stubMobile(true)
    vi.spyOn(window.history, "length", "get").mockReturnValue(4)
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    await leaveProjectBoot()
    expect(router.push).toHaveBeenCalledWith("/workspace")
    expect(router.back).not.toHaveBeenCalled()
    expect(back).not.toHaveBeenCalled()
  })

  it("带 opener 的链接打开的：手机上也回到工作区", async () => {
    stubMobile(true)
    vi.stubGlobal("opener", {})
    vi.spyOn(window.history, "length", "get").mockReturnValue(1)
    await leaveProjectBoot()
    vi.unstubAllGlobals()
    expect(router.push).toHaveBeenCalledWith("/workspace")
  })

  it("从工作区在当前页打开的：后退回工作区", async () => {
    stubMobile(true)
    navigateInPage("/project-boot")
    router.push.mockReset()
    vi.spyOn(window.history, "length", "get").mockReturnValue(3)
    await leaveProjectBoot()
    expect(router.back).toHaveBeenCalledTimes(1)
    expect(router.push).not.toHaveBeenCalled()
  })

  it("宽屏网页版照旧后退", async () => {
    stubMobile(false)
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    await leaveProjectBoot()
    expect(back).toHaveBeenCalledTimes(1)
    expect(router.push).not.toHaveBeenCalled()
  })
})

// 工作区里关闭当前窗口的快捷键也走 closeCurrentWindow：宽窄都照旧后退，
// 不被新建项目页的离开方式带走
describe("closeCurrentWindow", () => {
  afterEach(() => vi.restoreAllMocks())

  it("手机布局下照旧后退", async () => {
    vi.spyOn(window, "matchMedia").mockImplementation(
      (query: string) =>
        ({
          matches: true,
          media: query,
          addEventListener: () => {},
          removeEventListener: () => {},
        }) as unknown as MediaQueryList
    )
    const back = vi.spyOn(window.history, "back").mockImplementation(() => {})
    await closeCurrentWindow()
    expect(back).toHaveBeenCalledTimes(1)
  })
})
