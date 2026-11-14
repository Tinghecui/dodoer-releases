import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChromeStatus, ChromeTab } from "@/lib/browser/chrome-api"

const mocks = vi.hoisted(() => ({
  desktop: true,
  chromeStatus: vi.fn(),
  chromeTabs: vi.fn(),
  chromeConnect: vi.fn(),
  chromeDisconnect: vi.fn(),
  heardStatus: null as ((status: unknown) => void) | null,
  heardTabs: null as ((tabs: unknown) => void) | null,
  openSettingsWindow: vi.fn(async () => {}),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/browser/chrome-api", () => ({
  chromeStatus: mocks.chromeStatus,
  chromeTabs: mocks.chromeTabs,
  chromeConnect: mocks.chromeConnect,
  chromeDisconnect: mocks.chromeDisconnect,
  subscribeChromeStatus: (handler: (status: unknown) => void) => {
    mocks.heardStatus = handler
    return Promise.resolve(() => {})
  },
  subscribeChromeTabs: (handler: (tabs: unknown) => void) => {
    mocks.heardTabs = handler
    return Promise.resolve(() => {})
  },
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => mocks.desktop }))
vi.mock("@/lib/api", () => ({ openSettingsWindow: mocks.openSettingsWindow }))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { CONNECTED_BEFORE_KEY, StatusBarChrome } from "./status-bar-chrome"
import enMessages from "@/i18n/messages/en.json"

function status(over: Partial<ChromeStatus> = {}): ChromeStatus {
  return {
    state: "disconnected",
    problem: null,
    detail: null,
    product: null,
    portFileUrl: null,
    ...over,
  }
}

const CONNECTED = status({
  state: "connected",
  product: "Chrome/154.0.8037.98",
})

const TABS: ChromeTab[] = [
  { id: "1", title: "Inbox", host: "mail.example.com" },
  { id: "2", title: "", host: "localhost" },
]

async function mount() {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <StatusBarChrome />
      </NextIntlClientProvider>
    )
  })
  return result
}

async function openPanel() {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Your own Chrome" }))
  })
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
  })
}

beforeEach(() => {
  localStorage.clear()
  mocks.desktop = true
  mocks.heardStatus = null
  mocks.heardTabs = null
  mocks.chromeStatus.mockReset().mockResolvedValue(status())
  mocks.chromeTabs.mockReset().mockResolvedValue([])
  mocks.chromeConnect.mockReset().mockResolvedValue(CONNECTED)
  mocks.chromeDisconnect.mockReset().mockResolvedValue(status())
  mocks.openSettingsWindow.mockClear()
  mocks.toast.error.mockReset()
})

describe("StatusBarChrome", () => {
  it("is not there outside the desktop app", async () => {
    mocks.desktop = false
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    const { container } = await mount()
    expect(container).toBeEmptyDOMElement()
    expect(mocks.chromeStatus).not.toHaveBeenCalled()
  })

  it("stays out of the way until this computer has connected once", async () => {
    const { container } = await mount()
    expect(container).toBeEmptyDOMElement()

    await act(async () => {
      mocks.heardStatus?.(status({ state: "waiting" }))
    })
    expect(
      screen.getByRole("button", { name: "Your own Chrome" })
    ).toBeInTheDocument()
    await act(async () => {
      mocks.heardStatus?.(CONNECTED)
    })
    expect(localStorage.getItem(CONNECTED_BEFORE_KEY)).toBe("1")

    // From now on it shows while disconnected too, to connect again from.
    await act(async () => {
      mocks.heardStatus?.(status({ problem: "lost" }))
    })
    expect(
      screen.getByRole("button", { name: "Your own Chrome" })
    ).toBeInTheDocument()
  })

  it("lists Chrome's open pages by title and host, for the person only", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    await mount()
    expect(
      screen.getByRole("button", { name: "Your own Chrome" })
    ).toHaveAttribute(
      "title",
      "Your own Chrome · Connected to Chrome/154.0.8037.98"
    )

    await openPanel()
    expect(screen.getByText("Open in Chrome: 2")).toBeInTheDocument()
    expect(screen.getByText(/agents cannot see these tabs/)).toBeInTheDocument()
    expect(screen.getByText("Inbox")).toBeInTheDocument()
    expect(screen.getByText("mail.example.com")).toBeInTheDocument()
    // A page without a title goes by its host.
    expect(screen.getAllByText("localhost")).toHaveLength(2)

    await act(async () => {
      mocks.heardTabs?.([TABS[0]])
    })
    expect(screen.getByText("Open in Chrome: 1")).toBeInTheDocument()
    expect(screen.queryByText("localhost")).toBeNull()

    await act(async () => {
      mocks.heardTabs?.([])
    })
    expect(
      screen.getByText("No web pages are open in Chrome.")
    ).toBeInTheDocument()
  })

  it("disconnects, and connects again, from the panel", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    await mount()
    await openPanel()

    await press("Disconnect")
    expect(mocks.chromeDisconnect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status")).toHaveTextContent("Not connected")
    expect(screen.queryByText("Inbox")).toBeNull()

    await press("Connect to Chrome")
    expect(mocks.chromeConnect).toHaveBeenCalledWith()
    expect(screen.getByRole("status")).toHaveTextContent("Connected to")
  })

  it("sends problems the settings page explains to the settings page", async () => {
    localStorage.setItem(CONNECTED_BEFORE_KEY, "1")
    mocks.chromeStatus.mockResolvedValue(status({ problem: "file-denied" }))
    await mount()
    await openPanel()
    expect(
      screen.getByText(/could not find where to connect to Chrome/)
    ).toBeInTheDocument()
    expect(screen.queryByText(/paste the address below/)).toBeNull()

    await act(async () => {
      mocks.heardStatus?.(status({ problem: "lost" }))
    })
    expect(screen.getByText(/The connection ended/)).toBeInTheDocument()

    await press("Chrome settings")
    expect(mocks.openSettingsWindow).toHaveBeenCalledWith("browser")
  })

  it("reports a command that failed outright", async () => {
    localStorage.setItem(CONNECTED_BEFORE_KEY, "1")
    mocks.chromeConnect.mockRejectedValue(new Error("no such command"))
    await mount()
    await openPanel()
    await press("Connect to Chrome")
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Chrome connection failed: no such command"
    )
  })
})
