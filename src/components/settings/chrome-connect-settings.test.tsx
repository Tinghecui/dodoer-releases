import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChromeStatus } from "@/lib/browser/chrome-api"

const mocks = vi.hoisted(() => ({
  chromeStatus: vi.fn(),
  chromeConnect: vi.fn(),
  chromeDisconnect: vi.fn(),
  chromeOpenPrivacySettings: vi.fn(),
  /** The page's subscription to the backend's state changes. */
  heard: { handler: null as ((status: unknown) => void) | null },
  unsubscribe: vi.fn(),
  copy: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/browser/chrome-api", () => ({
  CHROME_SWITCH_URL: "chrome://inspect/#remote-debugging",
  chromeStatus: mocks.chromeStatus,
  chromeConnect: mocks.chromeConnect,
  chromeDisconnect: mocks.chromeDisconnect,
  chromeOpenPrivacySettings: mocks.chromeOpenPrivacySettings,
  subscribeChromeStatus: (handler: (status: unknown) => void) => {
    mocks.heard.handler = handler
    return Promise.resolve(mocks.unsubscribe)
  },
}))
vi.mock("@/lib/utils", async (original) => ({
  ...(await original<typeof import("@/lib/utils")>()),
  copyTextToClipboard: mocks.copy,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { ChromeConnectSettings } from "./chrome-connect-settings"
import enMessages from "@/i18n/messages/en.json"

const FILE_URL =
  "file:///Users/dev/Library/Application%20Support/Google/Chrome/DevToolsActivePort"

function status(over: Partial<ChromeStatus> = {}): ChromeStatus {
  return {
    state: "disconnected",
    problem: null,
    detail: null,
    product: null,
    portFileUrl: FILE_URL,
    ...over,
  }
}

const CONNECTED = status({
  state: "connected",
  product: "Chrome/154.0.8037.98",
})

/** Awaited: the card asks for the current state on mount. */
async function renderCard() {
  let result!: ReturnType<typeof render>
  await act(async () => {
    result = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChromeConnectSettings />
      </NextIntlClientProvider>
    )
  })
  return result
}

/** The backend announcing a state nobody on this page asked for. */
async function announce(next: ChromeStatus) {
  await act(async () => {
    mocks.heard.handler?.(next)
  })
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
  })
}

beforeEach(() => {
  mocks.heard.handler = null
  mocks.unsubscribe.mockReset()
  mocks.chromeStatus.mockReset().mockResolvedValue(status())
  mocks.chromeConnect.mockReset().mockResolvedValue(CONNECTED)
  mocks.chromeDisconnect.mockReset().mockResolvedValue(status())
  mocks.chromeOpenPrivacySettings.mockReset().mockResolvedValue(undefined)
  mocks.copy.mockReset().mockResolvedValue(true)
  mocks.toast.success.mockReset()
  mocks.toast.error.mockReset()
})

describe("ChromeConnectSettings", () => {
  it("says what to do in Chrome before there is a connection", async () => {
    await renderCard()
    expect(screen.getByRole("status")).toHaveTextContent("Not connected")
    expect(
      screen.getByText(/chrome:\/\/inspect\/#remote-debugging/)
    ).toBeInTheDocument()
    expect(screen.getByText(/refuse it/)).toBeInTheDocument()
    // Nothing has failed, so there is nothing to paste yet.
    expect(screen.queryByRole("textbox")).toBeNull()

    await press("Copy address")
    expect(mocks.copy).toHaveBeenCalledWith(
      "chrome://inspect/#remote-debugging"
    )
    expect(mocks.toast.success).toHaveBeenCalledWith("Copied")
  })

  it("connects, waits on Chrome's dialog, and can be disconnected", async () => {
    let allow!: (status: ChromeStatus) => void
    mocks.chromeConnect.mockReturnValue(
      new Promise<ChromeStatus>((resolve) => {
        allow = resolve
      })
    )
    await renderCard()

    await press("Connect to Chrome")
    expect(mocks.chromeConnect).toHaveBeenCalledWith()
    await announce(status({ state: "waiting" }))
    expect(screen.getByRole("status")).toHaveTextContent(
      "Waiting for you to click Allow in Chrome"
    )
    expect(screen.getByRole("button", { name: "Cancel" })).toBeInTheDocument()

    await act(async () => {
      allow(CONNECTED)
    })
    expect(screen.getByRole("status")).toHaveTextContent(
      "Connected to Chrome/154.0.8037.98"
    )
    // Connected: the instructions have done their job.
    expect(screen.queryByText(/refuse it/)).toBeNull()

    await press("Disconnect")
    expect(mocks.chromeDisconnect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status")).toHaveTextContent("Not connected")
  })

  it("cancels an attempt Chrome is still asking about", async () => {
    mocks.chromeStatus.mockResolvedValue(status({ state: "waiting" }))
    await renderCard()
    await press("Cancel")
    expect(mocks.chromeDisconnect).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("status")).toHaveTextContent("Not connected")
  })

  it("tells a read macOS refused apart from a switch that is off", async () => {
    mocks.chromeConnect.mockResolvedValue(status({ problem: "switch-off" }))
    await renderCard()
    await press("Connect to Chrome")
    expect(
      screen.getByText(/has not turned remote debugging on/)
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Open System Settings" })
    ).toBeNull()
    expect(screen.queryByRole("textbox")).toBeNull()

    mocks.chromeConnect.mockResolvedValue(status({ problem: "file-denied" }))
    await press("Connect to Chrome")
    expect(
      screen.getByText(/macOS does not let dodoer read/)
    ).toBeInTheDocument()
    await press("Open System Settings")
    expect(mocks.chromeOpenPrivacySettings).toHaveBeenCalledTimes(1)
  })

  it("takes a pasted address when the file is out of reach", async () => {
    mocks.chromeConnect.mockResolvedValue(status({ problem: "file-denied" }))
    await renderCard()
    await press("Connect to Chrome")

    // The address Chrome itself can open, to copy the endpoint out of.
    expect(screen.getByText(FILE_URL)).toBeInTheDocument()
    const paste = screen.getByRole("button", { name: "Connect" })
    expect(paste).toBeDisabled()

    mocks.chromeConnect.mockResolvedValue(status({ problem: "not-running" }))
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "9222 /devtools/browser/abc" },
    })
    await press("Connect")
    expect(mocks.chromeConnect).toHaveBeenLastCalledWith(
      "9222 /devtools/browser/abc"
    )
    expect(screen.getByText(/Chrome is not running/)).toBeInTheDocument()
    // Still there: the next thing the person does is paste again.
    expect(screen.getByRole("textbox")).toBeInTheDocument()

    mocks.chromeConnect.mockResolvedValue(CONNECTED)
    await press("Connect")
    expect(screen.getByRole("status")).toHaveTextContent("Connected to")
    expect(screen.queryByRole("textbox")).toBeNull()
  })

  it("hears of a connection Chrome ended", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    await renderCard()
    expect(screen.getByRole("status")).toHaveTextContent("Connected to")

    await announce(status({ problem: "lost" }))
    expect(screen.getByRole("status")).toHaveTextContent("Not connected")
    expect(screen.getByText(/The connection ended/)).toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Connect to Chrome" })
    ).toBeInTheDocument()
  })

  it("does not let a late first answer undo a newer announcement", async () => {
    let answer!: (status: ChromeStatus) => void
    mocks.chromeStatus.mockReturnValue(
      new Promise<ChromeStatus>((resolve) => {
        answer = resolve
      })
    )
    await renderCard()
    await announce(CONNECTED)
    await act(async () => {
      answer(status())
    })
    expect(screen.getByRole("status")).toHaveTextContent("Connected to")
  })

  it("stops listening when the page closes", async () => {
    const { unmount } = await renderCard()
    unmount()
    expect(mocks.unsubscribe).toHaveBeenCalledTimes(1)
  })

  it("reports a command that failed outright", async () => {
    mocks.chromeConnect.mockRejectedValue(new Error("no such command"))
    await renderCard()
    await press("Connect to Chrome")
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Chrome connection failed: no such command"
    )
  })
})
