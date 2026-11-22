import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => {
  let state: "connected" | "reconnecting" | "unauthorized" = "connected"
  const listeners = new Set<() => void>()
  return {
    getState: () => state,
    setState: (s: "connected" | "reconnecting" | "unauthorized") => {
      state = s
      for (const l of listeners) l()
    },
    subscribe: (cb: () => void) => {
      listeners.add(cb)
      return () => {
        listeners.delete(cb)
      }
    },
    reset: () => {
      state = "connected"
      listeners.clear()
    },
    usesWebTransport: vi.fn(() => true),
    token: vi.fn(() => "tok"),
    serverVersion: vi.fn<() => Promise<string | null>>(),
    ownRestart: { running: false, listeners: new Set<() => void>() },
    toast: Object.assign(vi.fn(), { dismiss: vi.fn() }),
    events: new Map<string, Set<(payload: unknown) => void>>(),
  }
})

vi.mock("@/lib/platform", () => ({
  subscribe: async (event: string, handler: (payload: unknown) => void) => {
    let handlers = mocks.events.get(event)
    if (!handlers) {
      handlers = new Set()
      mocks.events.set(event, handlers)
    }
    handlers.add(handler)
    return () => {
      handlers.delete(handler)
    }
  },
}))

vi.mock("@/lib/transport/web-connection-store", () => ({
  subscribeWebConnection: mocks.subscribe,
  getWebConnectionSnapshot: mocks.getState,
  getWebConnectionServerSnapshot: () => "connected",
  usesWebTransport: mocks.usesWebTransport,
}))
vi.mock("@/lib/transport/web-auth", () => ({
  getCodegToken: mocks.token,
  // The component asks for credentials (token or proxy sign-in); here the
  // token stands for them.
  hasCodegCredentials: () => Boolean(mocks.token()),
}))
vi.mock("@/lib/updater", () => ({
  getRunningServerVersion: mocks.serverVersion,
  isOwnServerRestartRunning: () => mocks.ownRestart.running,
  subscribeOwnServerRestart: (listener: () => void) => {
    mocks.ownRestart.listeners.add(listener)
    return () => {
      mocks.ownRestart.listeners.delete(listener)
    }
  },
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import {
  WEB_VERSION_TOAST_ID,
  WebVersionNotice,
  resetWebVersionNoticeForTests,
} from "./web-version-notice"
import enMessages from "@/i18n/messages/en.json"

function renderNotice() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WebVersionNotice />
    </NextIntlClientProvider>
  )
}

/** Let the version request settle. */
async function settle() {
  await act(async () => {})
}

beforeEach(() => {
  mocks.reset()
  mocks.usesWebTransport.mockReset().mockReturnValue(true)
  mocks.token.mockReset().mockReturnValue("tok")
  mocks.serverVersion.mockReset().mockResolvedValue("0.37.0")
  mocks.toast.mockReset()
  mocks.toast.dismiss.mockReset()
  mocks.ownRestart.running = false
  mocks.ownRestart.listeners.clear()
  mocks.events.clear()
  resetWebVersionNoticeForTests()
  vi.stubEnv("NODE_ENV", "production")
  vi.stubEnv("CODEG_APP_VERSION", "0.37.0")
  vi.stubEnv("CODEG_RELEASE_VERSION", "cowork-codeg-v0.6.39")
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe("WebVersionNotice", () => {
  it("offers a reload when the server runs another release than the page", async () => {
    mocks.serverVersion.mockResolvedValue("0.38.0")
    renderNotice()
    await settle()

    expect(mocks.toast).toHaveBeenCalledTimes(1)
    const [title, options] = mocks.toast.mock.calls[0]
    expect(title).toBe("The server is now running dodoer 0.38.0")
    expect(options).toMatchObject({
      id: WEB_VERSION_TOAST_ID,
      description:
        "This page is still on 0.37.0. Reload it to use the server's version.",
      duration: Infinity,
      action: { label: "Reload" },
    })
    const reload = vi.fn()
    const location = window.location
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...location, reload },
    })
    try {
      options.action.onClick()
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: location,
      })
    }
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it("asks again each time the connection comes back", async () => {
    renderNotice()
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(WEB_VERSION_TOAST_ID)

    // The server was upgraded while the tab stayed open.
    mocks.serverVersion.mockResolvedValue("0.38.0")
    act(() => mocks.setState("reconnecting"))
    await settle()
    expect(mocks.serverVersion).toHaveBeenCalledTimes(1)
    act(() => mocks.setState("connected"))
    await settle()

    expect(mocks.serverVersion).toHaveBeenCalledTimes(2)
    expect(mocks.toast).toHaveBeenCalledWith(
      "The server is now running dodoer 0.38.0",
      expect.objectContaining({ id: WEB_VERSION_TOAST_ID })
    )
  })

  it("leaves the page's own upgrade to report itself", async () => {
    // The in-app upgrade restarts the server under this page, watches the
    // new release prove itself and reloads; a second offer to reload would
    // cut that watch short.
    const setOwnRestart = (running: boolean) =>
      act(() => {
        mocks.ownRestart.running = running
        for (const listener of mocks.ownRestart.listeners) listener()
      })
    mocks.serverVersion.mockResolvedValue("0.38.0")
    renderNotice()
    await settle()
    expect(mocks.toast).toHaveBeenCalledTimes(1)

    setOwnRestart(true)
    expect(mocks.toast.dismiss).toHaveBeenCalledWith(WEB_VERSION_TOAST_ID)
    act(() => mocks.setState("reconnecting"))
    act(() => mocks.setState("connected"))
    await settle()
    expect(mocks.serverVersion).toHaveBeenCalledTimes(1)

    // It gave up without reloading: the page is still the old one.
    setOwnRestart(false)
    await settle()
    expect(mocks.serverVersion).toHaveBeenCalledTimes(2)
    expect(mocks.toast).toHaveBeenCalledTimes(2)
  })

  it("stays quiet for a server that does not report its version", async () => {
    mocks.serverVersion.mockResolvedValue(null)
    renderNotice()
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  it.each([
    ["the page ships with the app (desktop, remote desktop)", "shell"],
    ["there is no token to ask with", "token"],
    ["this is a development build", "dev"],
  ])("does not ask when %s", async (_, gate) => {
    if (gate === "shell") mocks.usesWebTransport.mockReturnValue(false)
    if (gate === "token") mocks.token.mockReturnValue("")
    if (gate === "dev") vi.stubEnv("NODE_ENV", "development")
    mocks.serverVersion.mockResolvedValue("0.38.0")
    renderNotice()
    await settle()
    expect(mocks.serverVersion).not.toHaveBeenCalled()
    expect(mocks.toast).not.toHaveBeenCalled()
  })

  describe("when the server switches to new web files", () => {
    function emitAssetsChanged(release: string | null) {
      act(() => {
        for (const handler of mocks.events.get("web_assets_changed") ?? []) {
          handler({ release })
        }
      })
    }

    it("offers a reload when the files are another release than the page", async () => {
      renderNotice()
      await settle()
      mocks.toast.mockClear()

      emitAssetsChanged("cowork-codeg-v0.6.40")

      expect(mocks.toast).toHaveBeenCalledTimes(1)
      const [title, options] = mocks.toast.mock.calls[0]
      expect(title).toBe(
        "A new version of the interface is ready (cowork-codeg-v0.6.40)"
      )
      expect(options).toMatchObject({
        id: WEB_VERSION_TOAST_ID,
        description:
          "Reload the page to use it. You can also keep working without reloading.",
        duration: Infinity,
        action: { label: "Reload" },
      })
    })

    it("stays quiet when the files are this page's release", async () => {
      renderNotice()
      await settle()
      emitAssetsChanged("cowork-codeg-v0.6.39")
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it("stays quiet when the event names no release", async () => {
      renderNotice()
      await settle()
      emitAssetsChanged(null)
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it("stays quiet when the page does not know its own release", async () => {
      vi.stubEnv("CODEG_RELEASE_VERSION", "")
      renderNotice()
      await settle()
      emitAssetsChanged("cowork-codeg-v0.6.40")
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it("does not listen in a desktop window", async () => {
      mocks.usesWebTransport.mockReturnValue(false)
      renderNotice()
      await settle()
      expect(mocks.events.get("web_assets_changed")?.size ?? 0).toBe(0)
      emitAssetsChanged("cowork-codeg-v0.6.40")
      expect(mocks.toast).not.toHaveBeenCalled()
    })

    it("leaves the page's own upgrade to report itself", async () => {
      mocks.ownRestart.running = true
      renderNotice()
      await settle()
      emitAssetsChanged("cowork-codeg-v0.6.40")
      expect(mocks.toast).not.toHaveBeenCalled()
    })
  })
})

describe("WebVersionNotice when the page's files are gone", () => {
  const fetchMock = vi.fn<typeof fetch>()

  beforeEach(() => {
    resetWebVersionNoticeForTests()
    fetchMock.mockReset().mockResolvedValue(new Response(null, { status: 404 }))
    vi.stubGlobal("fetch", fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    document.head.innerHTML = ""
  })

  /** A script tag whose file did not load, as the bundler's loader sees it. */
  function failScript(src: string) {
    const script = document.createElement("script")
    script.src = src
    document.head.appendChild(script)
    script.dispatchEvent(new Event("error"))
  }

  /** A chunk import nobody caught, as Turbopack and webpack reject it. */
  function rejectChunk(message: string) {
    const reason = Object.assign(new Error(message), { name: "ChunkLoadError" })
    const event = Object.assign(new Event("unhandledrejection"), { reason })
    window.dispatchEvent(event)
  }

  const filesToast = () =>
    mocks.toast.mock.calls.filter(
      ([title]) => title === "This page's files have been updated"
    )

  it("offers a reload once when a build file failed to load and is gone", async () => {
    renderNotice()
    await settle()

    act(() => failScript("/_next/static/chunks/gone.js"))
    await settle()
    expect(fetchMock).toHaveBeenCalledWith(
      "/_next/static/chunks/gone.js",
      expect.objectContaining({ method: "HEAD", cache: "no-store" })
    )
    expect(filesToast()).toHaveLength(1)
    expect(filesToast()[0][1]).toMatchObject({
      id: WEB_VERSION_TOAST_ID,
      description:
        "The server was updated and no longer has some of this page's files. Reload the page to continue.",
      duration: Infinity,
      action: { label: "Reload" },
    })

    act(() => failScript("/_next/static/chunks/also-gone.js"))
    act(() => rejectChunk("Failed to load chunk /_next/static/chunks/x.js"))
    await settle()
    expect(filesToast()).toHaveLength(1)
  })

  it.each([
    [
      "Turbopack",
      "Failed to load chunk /_next/static/chunks/0a1b.js from module 123",
    ],
    [
      "webpack",
      "Loading chunk 12 failed.\n(error: http://localhost:3000/_next/static/chunks/0a1b.js)",
    ],
  ])("hears a chunk load %s rejected", async (_, message) => {
    renderNotice()
    await settle()
    act(() => rejectChunk(message))
    await settle()
    expect(fetchMock).toHaveBeenCalledWith(
      "/_next/static/chunks/0a1b.js",
      expect.objectContaining({ method: "HEAD" })
    )
    expect(filesToast()).toHaveLength(1)
  })

  it.each([
    ["the server is away", () => fetchMock.mockRejectedValue(new TypeError())],
    [
      "the file is still there",
      () => fetchMock.mockResolvedValue(new Response(null, { status: 200 })),
    ],
  ])("stays quiet when %s", async (_, arrange) => {
    arrange()
    renderNotice()
    await settle()
    act(() => failScript("/_next/static/chunks/gone.js"))
    await settle()
    expect(filesToast()).toHaveLength(0)
  })

  it("ignores files that are not this build's", async () => {
    renderNotice()
    await settle()
    act(() => failScript("https://cdn.example.com/_next/static/x.js"))
    act(() => failScript("/vs/loader.js"))
    act(() => rejectChunk("Loading chunk 12 failed."))
    act(() => {
      window.dispatchEvent(
        Object.assign(new Event("unhandledrejection"), {
          reason: new Error("Failed to load chunk /_next/static/x.js"),
        })
      )
    })
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(filesToast()).toHaveLength(0)
  })

  it("does not listen in the desktop app or its remote windows", async () => {
    mocks.usesWebTransport.mockReturnValue(false)
    renderNotice()
    await settle()
    act(() => failScript("/_next/static/chunks/gone.js"))
    await settle()
    expect(fetchMock).not.toHaveBeenCalled()
    expect(filesToast()).toHaveLength(0)
  })

  it("keeps the notice up when the release check finds the same release", async () => {
    renderNotice()
    await settle()
    act(() => failScript("/_next/static/chunks/gone.js"))
    await settle()
    expect(filesToast()).toHaveLength(1)
    mocks.toast.dismiss.mockClear()

    act(() => mocks.setState("reconnecting"))
    act(() => mocks.setState("connected"))
    await settle()
    expect(mocks.toast.dismiss).not.toHaveBeenCalled()
  })

  it("keeps the notice up when the server then switches web files", async () => {
    renderNotice()
    await settle()
    act(() => failScript("/_next/static/chunks/gone.js"))
    await settle()
    expect(filesToast()).toHaveLength(1)
    mocks.toast.mockClear()

    act(() => {
      for (const handler of mocks.events.get("web_assets_changed") ?? []) {
        handler({ release: "cowork-codeg-v0.6.40" })
      }
    })
    await settle()
    expect(mocks.toast).not.toHaveBeenCalled()
  })
})
