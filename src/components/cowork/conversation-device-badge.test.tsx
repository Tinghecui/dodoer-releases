import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { HostDevice } from "@/lib/cowork/host-devices"

vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/lib/cowork/conversation-device", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/cowork/conversation-device")
  >()),
  useConversationDeviceState: vi.fn(),
}))
vi.mock("@/lib/cowork/host-devices", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cowork/host-devices")>()),
  useHostDevices: vi.fn(),
}))

import { ConversationDeviceBadge } from "./conversation-device-badge"
import { useTabStore } from "@/contexts/tab-context"
import {
  useConversationDeviceState,
  type ConversationDeviceAnswer,
} from "@/lib/cowork/conversation-device"
import { useHostDevices } from "@/lib/cowork/host-devices"

const mockTabs = useTabStore as unknown as Mock
const mockState = useConversationDeviceState as unknown as Mock
const mockBook = useHostDevices as unknown as Mock
const pick = vi.fn()

const DESKTOP: HostDevice = {
  id: "imac-0123456789",
  name: "desktop",
  named: true,
  computerName: "Study iMac",
  model: "iMac",
  kind: "desktop",
  platform: "macos",
  appVersion: "1.7.0",
  firstSeen: 1,
  lastSeen: Date.now() - 5 * 60_000,
  online: true,
  shell: true,
  browser: true,
  chrome: false,
}

const LAPTOP: HostDevice = {
  ...DESKTOP,
  id: "book-0123456789",
  name: "laptop",
  computerName: "Travel MacBook",
  model: "MacBook Air",
  kind: "laptop",
  online: false,
  shell: false,
  browser: false,
}

/** A server from before the picker: the mark only shows. */
function mount(device: HostDevice | null, locale: "en" | "zh-CN" = "en") {
  mockState.mockReturnValue({
    answer: { device },
    canPick: false,
    pick,
  })
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <ConversationDeviceBadge tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

/** A server that takes a pick. */
function mountPicker(
  answer: ConversationDeviceAnswer,
  locale: "en" | "zh-CN" = "en"
) {
  mockState.mockReturnValue({ answer, canPick: true, pick })
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <ConversationDeviceBadge tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

const badge = () =>
  document.querySelector<HTMLElement>("[data-conversation-device]")

beforeEach(() => {
  const tabs = {
    tabs: [
      {
        id: "tab-1",
        kind: "conversation",
        conversationId: 7,
        runtimeConversationId: 9,
      },
    ],
  }
  mockTabs.mockImplementation((select: (s: typeof tabs) => unknown) =>
    select(tabs)
  )
  mockState.mockReset()
  pick.mockReset().mockResolvedValue(undefined)
  mockBook.mockReset().mockReturnValue({
    list: { devices: [DESKTOP, LAPTOP], unnamedHosts: 0 },
    thisDeviceId: "book-0123456789",
    adopt: vi.fn(),
    canStop: true,
  })
})

describe("ConversationDeviceBadge", () => {
  it("is not there while the conversation has no device", () => {
    mount(null)
    expect(badge()).toBeNull()
  })

  it("asks for the tab's stored conversation, not its runtime id", () => {
    // #332：新对话的 runtimeConversationId 是虚拟的负数，服务器只认数据库里的编号
    const tabs = {
      tabs: [
        {
          id: "tab-1",
          kind: "conversation",
          conversationId: 113,
          runtimeConversationId: -384636256,
        },
      ],
    }
    mockTabs.mockImplementation((select: (s: typeof tabs) => unknown) =>
      select(tabs)
    )
    mount(null)
    expect(mockState).toHaveBeenCalledWith(113)
    expect(mockState).not.toHaveBeenCalledWith(-384636256)
  })

  it("asks for nothing while the conversation is not stored yet", () => {
    const tabs = {
      tabs: [
        {
          id: "tab-1",
          kind: "conversation",
          conversationId: null,
          runtimeConversationId: -384636256,
        },
      ],
    }
    mockTabs.mockImplementation((select: (s: typeof tabs) => unknown) =>
      select(tabs)
    )
    mount(DESKTOP)
    expect(mockState).toHaveBeenCalledWith(null)
    expect(mockState).not.toHaveBeenCalledWith(-384636256)
  })

  it("names the device and says how to switch", () => {
    mount(DESKTOP)
    expect(badge()?.textContent).toBe("desktop")
    expect(badge()?.dataset.trouble).toBeUndefined()
    expect(badge()?.title).toContain("works on desktop")
    expect(badge()?.className).not.toContain("amber")
  })

  it("turns amber and says since when for a device that is offline", () => {
    mount({ ...DESKTOP, online: false, shell: false, browser: false })
    expect(badge()?.dataset.trouble).toBe("offline")
    expect(badge()?.className).toContain("amber")
    expect(badge()?.title).toContain(
      "desktop is offline (last online 5 minutes ago)"
    )
  })

  it("turns amber when it lends nothing, in the window's language", () => {
    mount({ ...DESKTOP, shell: false, browser: false }, "zh-CN")
    expect(badge()?.dataset.trouble).toBe("lendsNothing")
    expect(badge()?.title).toContain("命令行和浏览器都没借出")
  })
})

describe("ConversationDeviceBadge, picking", () => {
  it("is not offered with only one device and nothing waiting", () => {
    mountPicker({ device: null, deviceCount: 1 })
    expect(badge()).toBeNull()
  })

  it("offers a pick with two devices, quietly", () => {
    mountPicker({ device: null, deviceCount: 2 })
    expect(badge()?.textContent).toBe("Pick a computer")
    expect(badge()?.dataset.needsPick).toBeUndefined()
    expect(badge()?.className).not.toContain("amber")
  })

  it("turns amber while the agent waits for a pick, in the window's language", () => {
    mountPicker({ device: null, deviceCount: 2, needsPick: true }, "zh-CN")
    expect(badge()?.textContent).toBe("选电脑")
    expect(badge()?.dataset.needsPick).toBe("true")
    expect(badge()?.className).toContain("amber")
    expect(badge()?.title).toContain("智能体在等你给这个对话选一台电脑")
  })

  it("lists the devices with where they are and what they lend", async () => {
    mountPicker({ device: DESKTOP, deviceCount: 2 })
    expect(badge()?.title).toContain("Click to pick another")
    await userEvent.click(badge()!)
    const desktop = document.querySelector<HTMLElement>(
      '[data-pick-device="imac-0123456789"]'
    )!
    const laptop = document.querySelector<HTMLElement>(
      '[data-pick-device="book-0123456789"]'
    )!
    expect(desktop).toHaveAttribute("aria-pressed", "true")
    expect(desktop).toHaveTextContent("Study iMac")
    expect(desktop).toHaveTextContent("Online · Command line · Browser")
    expect(laptop).toHaveAttribute("aria-pressed", "false")
    expect(laptop).toHaveTextContent("This computer")
    expect(laptop).toHaveTextContent("Last online")
    expect(mockBook).toHaveBeenCalledWith(true)
  })

  it("picks the device clicked, and none", async () => {
    mountPicker({ device: DESKTOP, deviceCount: 2 })
    await userEvent.click(badge()!)
    await userEvent.click(
      document.querySelector<HTMLElement>(
        '[data-pick-device="book-0123456789"]'
      )!
    )
    expect(pick).toHaveBeenCalledWith("book-0123456789")

    await userEvent.click(badge()!)
    await userEvent.click(
      screen.getByRole("button", { name: "Use no computer" })
    )
    expect(pick).toHaveBeenLastCalledWith(null)
  })

  it("says so when the pick fails", async () => {
    pick.mockRejectedValue(new Error("No such device"))
    mountPicker({ device: null, deviceCount: 2, needsPick: true })
    await userEvent.click(badge()!)
    await userEvent.click(
      document.querySelector<HTMLElement>(
        '[data-pick-device="imac-0123456789"]'
      )!
    )
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not pick it: No such device"
    )
  })
})
