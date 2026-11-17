import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The desktop app's answers for the "Automatic updates" setting.
let stored: unknown = { mode: "auto" }
let saveImpl: (mode: string) => unknown = (mode) => ({ mode })
const call = vi.fn(async (endpoint: string, args?: unknown) => {
  if (endpoint === "get_update_preferences") return stored
  if (endpoint === "update_update_preferences") {
    const mode = (args as { settings: { mode: string } }).settings.mode
    return saveImpl(mode)
  }
  throw new Error(`unexpected endpoint: ${endpoint}`)
})
const remoteCall = vi.fn()

let desktop = true
vi.mock("@/lib/transport", () => ({
  // A remote window's own transport goes to the server; the setting belongs
  // to the desktop app, so it must go through the shell transport.
  getTransport: () => ({ call: remoteCall }),
  getShellTransport: () => ({ call }),
  isDesktop: () => desktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

let mac = true
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => mac }))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { AutoUpdateModeSetting } from "./auto-update-mode"
import enMessages from "@/i18n/messages/en.json"

const renderIt = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AutoUpdateModeSetting />
    </NextIntlClientProvider>
  )

const radio = (name: RegExp) => screen.getByRole("radio", { name })

beforeEach(() => {
  call.mockClear()
  remoteCall.mockClear()
  stored = { mode: "auto" }
  saveImpl = (mode) => ({ mode })
  desktop = true
  mac = true
})

describe("AutoUpdateModeSetting", () => {
  it("shows the three choices with the stored one selected", async () => {
    stored = { mode: "download" }
    renderIt()
    expect(screen.getByText("Automatic updates")).toBeInTheDocument()
    await waitFor(() =>
      expect(radio(/Download only, I restart/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )
    expect(radio(/Install automatically/)).toHaveAttribute(
      "aria-checked",
      "false"
    )
    expect(radio(/^Off/)).toHaveAttribute("aria-checked", "false")
    expect(remoteCall).not.toHaveBeenCalled()
  })

  it("treats a value it does not know as automatic", async () => {
    stored = { mode: "sometimes" }
    renderIt()
    await waitFor(() =>
      expect(radio(/Install automatically/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )
  })

  it("saves a new choice and tells the window", async () => {
    const seen: unknown[] = []
    const onChanged = (e: Event) => seen.push((e as CustomEvent).detail)
    window.addEventListener("codeg:update-mode-changed", onChanged)
    renderIt()
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("get_update_preferences")
    )
    await act(async () => {
      fireEvent.click(radio(/^Off/))
    })
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("update_update_preferences", {
        settings: { mode: "off" },
      })
    )
    await waitFor(() => expect(seen).toEqual(["off"]))
    expect(radio(/^Off/)).toHaveAttribute("aria-checked", "true")
    window.removeEventListener("codeg:update-mode-changed", onChanged)
  })

  it("reports a failed save and goes back to the stored choice", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.error).mockClear()
    saveImpl = () => {
      throw new Error("disk full")
    }
    renderIt()
    await waitFor(() =>
      expect(radio(/Install automatically/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )
    await act(async () => {
      fireEvent.click(radio(/^Off/))
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not save the update setting"
      )
    )
    expect(radio(/Install automatically/)).toHaveAttribute(
      "aria-checked",
      "true"
    )
  })

  it("is not shown outside macOS", () => {
    mac = false
    const { container } = renderIt()
    expect(container).toBeEmptyDOMElement()
    expect(call).not.toHaveBeenCalled()
  })

  it("is not shown in a browser", () => {
    desktop = false
    const { container } = renderIt()
    expect(container).toBeEmptyDOMElement()
    expect(call).not.toHaveBeenCalled()
  })
})
