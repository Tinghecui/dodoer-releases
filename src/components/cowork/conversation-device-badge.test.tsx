import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import type { HostDevice } from "@/lib/cowork/host-devices"

vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/lib/cowork/conversation-device", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/cowork/conversation-device")
  >()),
  useConversationDevice: vi.fn(),
}))

import { ConversationDeviceBadge } from "./conversation-device-badge"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationDevice } from "@/lib/cowork/conversation-device"

const mockTabs = useTabStore as unknown as Mock
const mockDevice = useConversationDevice as unknown as Mock

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

function mount(device: HostDevice | null, locale: "en" | "zh-CN" = "en") {
  mockDevice.mockReturnValue(device)
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
  mockDevice.mockReset()
})

describe("ConversationDeviceBadge", () => {
  it("is not there while the conversation has no device", () => {
    mount(null)
    expect(badge()).toBeNull()
  })

  it("asks for the tab's own conversation", () => {
    mount(null)
    expect(mockDevice).toHaveBeenCalledWith(9)
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
