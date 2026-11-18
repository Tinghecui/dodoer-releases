import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The desktop app's answers for the update preferences (issue #413).
let stored: unknown = {
  mode: "auto",
  update_channel: "stable",
  channels_available: true,
}
let saveImpl: (channel: string) => unknown = (channel) => ({
  mode: "auto",
  update_channel: channel,
  channels_available: true,
})
const call = vi.fn(async (endpoint: string, args?: unknown) => {
  if (endpoint === "get_update_preferences") return stored
  if (endpoint === "update_update_preferences") {
    const settings = (args as { settings: { update_channel: string } }).settings
    return saveImpl(settings.update_channel)
  }
  throw new Error(`unexpected endpoint: ${endpoint}`)
})
const remoteCall = vi.fn()

let desktop = true
vi.mock("@/lib/transport", () => ({
  // The setting belongs to the desktop app: a remote window must still go
  // through the shell transport.
  getTransport: () => ({ call: remoteCall }),
  getShellTransport: () => ({ call }),
  isDesktop: () => desktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { UpdateChannelBadge, UpdateChannelSetting } from "./update-channel"
import enMessages from "@/i18n/messages/en.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"

const onChanged = vi.fn()

const renderIt = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UpdateChannelSetting onChanged={onChanged} />
    </NextIntlClientProvider>
  )

const radio = (name: RegExp) => screen.getByRole("radio", { name })

beforeEach(() => {
  call.mockClear()
  remoteCall.mockClear()
  onChanged.mockClear()
  stored = {
    mode: "auto",
    update_channel: "stable",
    channels_available: true,
  }
  saveImpl = (channel) => ({
    mode: "auto",
    update_channel: channel,
    channels_available: true,
  })
  desktop = true
})

describe("UpdateChannelSetting", () => {
  it("shows the two channels with the stored one selected", async () => {
    stored = {
      mode: "auto",
      update_channel: "early",
      channels_available: true,
    }
    renderIt()
    await waitFor(() =>
      expect(screen.getByText("Update channel")).toBeInTheDocument()
    )
    expect(radio(/^Early/)).toHaveAttribute("aria-checked", "true")
    expect(radio(/Stable \(recommended\)/)).toHaveAttribute(
      "aria-checked",
      "false"
    )
    expect(
      screen.getByText("Versions that ran for a day without problems")
    ).toBeInTheDocument()
    expect(remoteCall).not.toHaveBeenCalled()
  })

  it("is not shown when this build has no channels", async () => {
    stored = {
      mode: "auto",
      update_channel: "stable",
      channels_available: false,
    }
    const { container } = renderIt()
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("get_update_preferences")
    )
    // Give the read a turn to land; still nothing rendered.
    await act(async () => {})
    expect(container).toBeEmptyDOMElement()
  })

  it("is not shown in a browser", () => {
    desktop = false
    const { container } = renderIt()
    expect(container).toBeEmptyDOMElement()
    expect(call).not.toHaveBeenCalled()
  })

  it("saves Early and then asks for a check", async () => {
    renderIt()
    await waitFor(() =>
      expect(radio(/Stable \(recommended\)/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )
    expect(onChanged).not.toHaveBeenCalled()
    await act(async () => {
      fireEvent.click(radio(/^Early/))
    })
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("update_update_preferences", {
        settings: { update_channel: "early" },
      })
    )
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1))
    expect(onChanged).toHaveBeenCalledWith("early")
    expect(radio(/^Early/)).toHaveAttribute("aria-checked", "true")
  })

  it("reports a failed save, goes back and does not check", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.error).mockClear()
    saveImpl = () => {
      throw new Error("disk full")
    }
    renderIt()
    await waitFor(() =>
      expect(radio(/Stable \(recommended\)/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )
    await act(async () => {
      fireEvent.click(radio(/^Early/))
    })
    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Could not save the update channel"
      )
    )
    expect(radio(/Stable \(recommended\)/)).toHaveAttribute(
      "aria-checked",
      "true"
    )
    expect(onChanged).not.toHaveBeenCalled()
  })

  it("follows a change made in another settings window when it comes back to the front", async () => {
    renderIt()
    await waitFor(() =>
      expect(radio(/Stable \(recommended\)/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )

    // Another window switched to Early; this one is focused again.
    stored = {
      mode: "auto",
      update_channel: "early",
      channels_available: true,
    }
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })

    await waitFor(() =>
      expect(radio(/^Early/)).toHaveAttribute("aria-checked", "true")
    )
    // The offer on screen was for Stable: check again on Early.
    expect(onChanged).toHaveBeenCalledWith("early")

    // Picking Stable here now really saves it.
    await act(async () => {
      fireEvent.click(radio(/Stable \(recommended\)/))
    })
    await waitFor(() =>
      expect(call).toHaveBeenCalledWith("update_update_preferences", {
        settings: { update_channel: "stable" },
      })
    )
  })

  it("does not check again when coming back to the front with the channel unchanged", async () => {
    renderIt()
    await waitFor(() =>
      expect(radio(/Stable \(recommended\)/)).toHaveAttribute(
        "aria-checked",
        "true"
      )
    )
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() =>
      expect(
        call.mock.calls.filter(([e]) => e === "get_update_preferences")
      ).toHaveLength(2)
    )
    expect(onChanged).not.toHaveBeenCalled()
  })
})

describe("UpdateChannelBadge", () => {
  it("marks the version when the check was on Early", () => {
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhCNMessages}>
        <UpdateChannelBadge channel="early" />
      </NextIntlClientProvider>
    )
    expect(screen.getByText("· 抢先版")).toBeInTheDocument()
  })

  it("adds nothing on Stable or before a check", () => {
    const stable = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <UpdateChannelBadge channel="stable" />
      </NextIntlClientProvider>
    )
    expect(stable.container).toBeEmptyDOMElement()
    stable.unmount()
    const unknown = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <UpdateChannelBadge channel={null} />
      </NextIntlClientProvider>
    )
    expect(unknown.container).toBeEmptyDOMElement()
  })
})
