import { render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  remote: true,
  health: {} as unknown,
  version: "1.2.0",
  call: vi.fn(),
  // The transport's WS `server_info` listeners (`server-info.ts`).
  serverInfo: new Set<(info: unknown) => void>(),
}))
vi.mock("@/lib/transport", () => ({
  isRemoteDesktopMode: () => env.remote,
  getTransport: () => ({
    call: env.call,
    onServerInfo: (cb: (info: unknown) => void) => {
      env.serverInfo.add(cb)
      return () => env.serverInfo.delete(cb)
    },
  }),
}))
vi.mock("@tauri-apps/api/app", () => ({ getVersion: async () => env.version }))

const toast = vi.hoisted(() => ({ warning: vi.fn(), dismiss: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const update = vi.hoisted(() => ({ checkNow: vi.fn() }))
vi.mock("@/components/providers/update-provider", () => ({
  useAppUpdate: () => update,
}))

import { RemoteCompatNotice } from "./remote-compat-notice"

function renderNotice() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <RemoteCompatNotice />
    </NextIntlClientProvider>
  )
}

describe("RemoteCompatNotice", () => {
  beforeEach(() => {
    env.remote = true
    env.version = "1.2.0"
    env.call.mockReset()
    env.call.mockImplementation(async () => env.health)
    toast.warning.mockReset()
    toast.dismiss.mockReset()
    update.checkNow.mockReset()
    env.serverInfo.clear()
  })

  it("stays quiet when the app and the server match", async () => {
    env.health = { api_version: 2, min_desktop_version: "1.2.0" }
    renderNotice()
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalled())
    expect(env.call).toHaveBeenCalledWith("health", {}, { timeoutMs: 8000 })
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("asks to update an app older than the server's minimum", async () => {
    env.health = { api_version: 2, min_desktop_version: "1.3.0" }
    renderNotice()
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    const [title, opts] = toast.warning.mock.calls[0]
    expect(title).toMatch(/too old/)
    expect(opts.description).toContain("1.3.0")
    expect(opts.duration).toBe(Infinity)
    opts.action.onClick()
    expect(update.checkNow).toHaveBeenCalledWith({ silent: false })
  })

  it("asks for a server upgrade when the server is from before the 0.43 base", async () => {
    env.health = { api_version: 1, min_desktop_version: "1.2.0" }
    renderNotice()
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    const [, opts] = toast.warning.mock.calls[0]
    expect(opts.duration).toBe(Infinity)
    // Updating the app would not help, so there is no update button.
    expect(opts.action).toBeUndefined()
  })

  it("does nothing outside a remote-desktop window", async () => {
    env.remote = false
    env.health = { min_desktop_version: "9.0.0" }
    renderNotice()
    await new Promise((r) => setTimeout(r, 20))
    expect(env.call).not.toHaveBeenCalled()
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("says nothing when the server can't be reached", async () => {
    env.call.mockRejectedValue(new Error("offline"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    renderNotice()
    await waitFor(() => expect(warn).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()
    warn.mockRestore()
  })

  it("judges again on the server_info a reconnect brings", async () => {
    env.health = { api_version: 2, min_desktop_version: "1.2.0" }
    const { unmount } = renderNotice()
    await waitFor(() => expect(toast.dismiss).toHaveBeenCalled())
    expect(toast.warning).not.toHaveBeenCalled()

    // Cowork upgraded the server; the socket came back with a new minimum.
    for (const cb of env.serverInfo) {
      cb({ apiVersion: 2, minDesktopVersion: "1.3.0", features: [] })
    }
    await waitFor(() => expect(toast.warning).toHaveBeenCalled())
    expect(toast.warning.mock.calls[0][1].description).toContain("1.3.0")

    unmount()
    expect(env.serverInfo.size).toBe(0)
  })
})
