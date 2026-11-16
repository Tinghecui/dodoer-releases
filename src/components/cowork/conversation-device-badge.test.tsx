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

/** A server that takes one part at a time (`conversation_device_split`). */
function mountSplit(
  answer: ConversationDeviceAnswer,
  locale: "en" | "zh-CN" = "en"
) {
  mockState.mockReturnValue({ answer, canPick: true, canSplit: true, pick })
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <ConversationDeviceBadge tabId="tab-1" />
    </NextIntlClientProvider>
  )
}

const half = (part: "shell" | "browser") =>
  document.querySelector<HTMLElement>(`[data-device-part="${part}"]`)

const cell = (part: "shell" | "browser", deviceId: string) =>
  document.querySelector<HTMLElement>(
    `[data-pick-cell="${part}"][data-pick-device="${deviceId}"]`
  )

/** Lends both, its Chrome too. */
const MINI: HostDevice = {
  ...DESKTOP,
  id: "mini-0123456789",
  name: "mini",
  computerName: "Den Mac mini",
  model: "Mac mini",
  chrome: true,
}

/** Online, lends only its command line. */
const AIR: HostDevice = {
  ...LAPTOP,
  id: "air-0123456789",
  name: "air",
  online: true,
  shell: true,
  browser: false,
}

describe("ConversationDeviceBadge, command line and browser apart", () => {
  beforeEach(() => {
    mockBook.mockReturnValue({
      list: { devices: [AIR, MINI, LAPTOP], unnamedHosts: 0 },
      thisDeviceId: "mini-0123456789",
      adopt: vi.fn(),
      canStop: true,
    })
  })

  it("names one device once with both icons when both are on it", () => {
    mountSplit({ device: MINI, browserDevice: MINI, deviceCount: 2 })
    expect(badge()?.textContent).toBe("mini")
    expect(badge()?.querySelectorAll("[data-part-icon]").length).toBe(2)
    expect(half("shell")).toBeNull()
    expect(badge()?.className).not.toContain("amber")
  })

  it("names each device with its part when they are apart", () => {
    mountSplit({ device: AIR, browserDevice: MINI, deviceCount: 2 })
    expect(half("shell")?.textContent).toBe("air")
    expect(half("browser")?.textContent).toBe("mini")
    expect(half("shell")?.dataset.trouble).toBeUndefined()
    expect(half("browser")?.dataset.trouble).toBeUndefined()
    expect(badge()?.title).toContain("Command line: air")
    expect(badge()?.title).toContain("Browser: mini")
  })

  it("says the part not picked, amber while the agent waits for it", () => {
    mountSplit(
      {
        device: AIR,
        browserDevice: null,
        needsBrowserPick: true,
        deviceCount: 2,
      },
      "zh-CN"
    )
    expect(half("shell")?.textContent).toBe("air")
    expect(half("shell")?.className).not.toContain("amber")
    expect(half("browser")?.textContent).toBe("没选")
    expect(half("browser")?.dataset.needsPick).toBe("true")
    expect(half("browser")?.className).toContain("amber")
    expect(badge()?.title).toContain("智能体在等你给浏览器选一台电脑")
  })

  it("says not picked quietly while nothing waits for it", () => {
    mountSplit({ device: AIR, browserDevice: null, deviceCount: 2 })
    expect(half("browser")?.textContent).toBe("Not picked")
    expect(half("browser")?.dataset.needsPick).toBeUndefined()
    expect(half("browser")?.className).not.toContain("amber")
  })

  it("turns only the browser half amber when its device does not lend it", () => {
    mountSplit({ device: AIR, browserDevice: AIR, deviceCount: 2 })
    expect(half("shell")?.textContent).toBe("air")
    expect(half("shell")?.dataset.trouble).toBeUndefined()
    expect(half("shell")?.className).not.toContain("amber")
    expect(half("browser")?.textContent).toBe("Not lent")
    expect(half("browser")?.dataset.trouble).toBe("notLent")
    expect(half("browser")?.className).toContain("amber")
    expect(badge()?.title).toContain("air does not lend its browser")
  })

  it("lists the devices with a command line and a browser column", async () => {
    mountSplit({ device: AIR, browserDevice: MINI, deviceCount: 3 }, "zh-CN")
    await userEvent.click(badge()!)
    expect(
      screen.getByText("命令行和浏览器可以选不同的电脑。")
    ).toBeInTheDocument()
    expect(
      cell("shell", AIR.id)?.querySelector("[role=radio]")
    ).toHaveAttribute("aria-checked", "true")
    expect(
      cell("shell", MINI.id)?.querySelector("[role=radio]")
    ).toHaveAttribute("aria-checked", "false")
    expect(
      cell("browser", MINI.id)?.querySelector("[role=radio]")
    ).toHaveAttribute("aria-checked", "true")
    expect(cell("browser", MINI.id)).toHaveTextContent("Chrome")
    // 没借出浏览器的那一格只有原因，点不了
    expect(cell("browser", AIR.id)?.querySelector("[role=radio]")).toBeNull()
    expect(cell("browser", AIR.id)).toHaveTextContent("没借出")
    // 不在线的那台两格都没有圈
    expect(cell("shell", LAPTOP.id)?.querySelector("[role=radio]")).toBeNull()
    expect(cell("shell", LAPTOP.id)).toHaveTextContent("不在线")
  })

  it("keeps the chosen circle on a cell that cannot be used, with the reason in amber", async () => {
    mountSplit({ device: AIR, browserDevice: AIR, deviceCount: 3 })
    await userEvent.click(badge()!)
    const radio = cell("browser", AIR.id)?.querySelector("[role=radio]")
    expect(radio).toHaveAttribute("aria-checked", "true")
    const reason = cell("browser", AIR.id)?.querySelector("[data-cell-trouble]")
    expect(reason).toHaveTextContent("Not lent")
    expect(reason?.className).toContain("amber")
  })

  it("picks one part per click and stays open", async () => {
    mountSplit({ device: AIR, browserDevice: AIR, deviceCount: 3 })
    await userEvent.click(badge()!)
    await userEvent.click(
      cell("browser", MINI.id)!.querySelector<HTMLElement>("[role=radio]")!
    )
    expect(pick).toHaveBeenLastCalledWith(MINI.id, "browser")
    await userEvent.click(
      cell("shell", MINI.id)!.querySelector<HTMLElement>("[role=radio]")!
    )
    expect(pick).toHaveBeenLastCalledWith(MINI.id, "shell")
    // 菜单还开着，好接着选另一列
    expect(cell("shell", AIR.id)).not.toBeNull()
  })

  it("clears both parts with Use no computer", async () => {
    mountSplit({ device: AIR, browserDevice: MINI, deviceCount: 3 })
    await userEvent.click(badge()!)
    await userEvent.click(
      screen.getByRole("button", { name: "Use no computer" })
    )
    expect(pick).toHaveBeenLastCalledWith(null)
  })

  it("stays as before on a server that cannot split", async () => {
    mockState.mockReturnValue({
      answer: { device: AIR, browserDevice: MINI, deviceCount: 3 },
      canPick: true,
      canSplit: false,
      pick,
    })
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <ConversationDeviceBadge tabId="tab-1" />
      </NextIntlClientProvider>
    )
    expect(badge()?.textContent).toBe("air")
    expect(half("shell")).toBeNull()
    await userEvent.click(badge()!)
    expect(cell("shell", AIR.id)).toBeNull()
    expect(
      document.querySelector('[data-pick-device="air-0123456789"]')
    ).toHaveAttribute("aria-pressed", "true")
  })
})
