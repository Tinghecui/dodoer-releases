import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChromeStatus, ChromeTab } from "@/lib/browser/chrome-api"

const mocks = vi.hoisted(() => ({
  desktop: true,
  chromeStatus: vi.fn(),
  chromeTabs: vi.fn(),
  chromeConnect: vi.fn(),
  chromeDisconnect: vi.fn(),
  chromeShare: vi.fn(),
  chromeAgents: vi.fn(),
  chromeSetAgents: vi.fn(),
  chromeActivate: vi.fn(),
  windowLabel: "main",
  /** The backend's switch for the window's scope. */
  lent: false,
  /** Shared levels by the browser tab store's key, as `browser://state`
   *  would have left them. */
  grants: new Map<string, "read" | "control">(),
  /** Owners by the same key: a page an agent opened is `chrome@<scope>`. */
  owners: new Map<string, string>(),
  heardStatus: null as ((status: unknown) => void) | null,
  heardTabs: null as ((tabs: unknown) => void) | null,
  openSettingsWindow: vi.fn(async () => {}),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/browser/chrome-api", () => ({
  AGENT_OWNER_PREFIX: "chrome@",
  chromeAgentsScope: (label: string) =>
    label.startsWith("remote-workspace-") ? label : "local",
  chromeStatus: mocks.chromeStatus,
  chromeTabs: mocks.chromeTabs,
  chromeConnect: mocks.chromeConnect,
  chromeDisconnect: mocks.chromeDisconnect,
  chromeShare: mocks.chromeShare,
  chromeAgents: mocks.chromeAgents,
  chromeSetAgents: mocks.chromeSetAgents,
  chromeActivate: mocks.chromeActivate,
  subscribeChromeStatus: (handler: (status: unknown) => void) => {
    mocks.heardStatus = handler
    return Promise.resolve(() => {})
  },
  subscribeChromeTabs: (handler: (tabs: unknown) => void) => {
    mocks.heardTabs = handler
    return Promise.resolve(() => {})
  },
}))
vi.mock("@/lib/browser/browser-tab-store", () => ({
  browserWorkspaceTabId: (id: string) => `browser:${id}`,
  useBrowserTabState: (key: string | null) => {
    if (!key) return null
    const level = mocks.grants.get(key)
    const owner = mocks.owners.get(key)
    if (!level && !owner) return null
    return {
      ownerWindow: owner ?? "chrome",
      agentGrant: level ? { level } : null,
    }
  },
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => mocks.windowLabel,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => mocks.desktop }))
vi.mock("@/lib/api", () => ({ openSettingsWindow: mocks.openSettingsWindow }))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import {
  agentsKey,
  CONNECTED_BEFORE_KEY,
  StatusBarChrome,
} from "./status-bar-chrome"
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
  mocks.chromeShare.mockReset().mockResolvedValue(undefined)
  mocks.lent = false
  mocks.chromeAgents.mockReset().mockImplementation(async () => mocks.lent)
  mocks.chromeSetAgents.mockReset().mockImplementation(async (on: boolean) => {
    mocks.lent = on
    return on
  })
  mocks.chromeActivate.mockReset().mockResolvedValue(undefined)
  mocks.windowLabel = "main"
  mocks.grants.clear()
  mocks.owners.clear()
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
    expect(
      screen.getByText(/Agents see only the tabs you hand to them/)
    ).toBeInTheDocument()
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

  it("hands a tab to agents, and takes it back", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    await mount()
    await openPanel()

    await userEvent.click(
      screen.getByRole("button", { name: "Hand to agents · Inbox" })
    )
    // Nothing to take back from a tab nobody was given.
    expect(screen.queryByRole("menuitem", { name: "Take back" })).toBeNull()
    await userEvent.click(
      screen.getByRole("menuitem", { name: /Read and act/ })
    )
    expect(mocks.chromeShare).toHaveBeenCalledWith("1", "control")

    // The level comes back on the tab's state, under the same id.
    mocks.grants.set("browser:1", "read")
    await act(async () => {
      mocks.heardTabs?.([...TABS])
    })
    const shared = screen.getByRole("button", {
      name: "Hand to agents · Inbox",
    })
    expect(shared).toHaveTextContent("Read only")
    await userEvent.click(shared)
    expect(
      screen.getByRole("menuitem", { name: /Read only: agents can see/ })
    ).toHaveAttribute("data-disabled")
    await userEvent.click(screen.getByRole("menuitem", { name: "Take back" }))
    expect(mocks.chromeShare).toHaveBeenLastCalledWith("1", "none")
  })

  it("says so when a tab could not be handed over", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    mocks.chromeShare.mockRejectedValue(new Error("Chrome is not connected"))
    await mount()
    await openPanel()
    await userEvent.click(
      screen.getByRole("button", { name: "Hand to agents · Inbox" })
    )
    await userEvent.click(screen.getByRole("menuitem", { name: /Read only/ }))
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Could not hand the tab over: Chrome is not connected"
    )
  })

  it("lets this window's agents use Chrome, and remembers it", async () => {
    mocks.windowLabel = "remote-workspace-7"
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    await mount()
    await openPanel()
    const toggle = screen.getByRole("switch", {
      name: "Let agents use my Chrome",
    })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    await userEvent.click(toggle)
    expect(mocks.chromeSetAgents).toHaveBeenCalledWith(true)
    expect(toggle).toHaveAttribute("aria-checked", "true")
    // Per scope: this remote window's own.
    expect(localStorage.getItem(agentsKey("remote-workspace-7"))).toBe("1")
    expect(localStorage.getItem(agentsKey("local"))).toBeNull()

    await userEvent.click(toggle)
    expect(mocks.chromeSetAgents).toHaveBeenLastCalledWith(false)
    expect(localStorage.getItem(agentsKey("remote-workspace-7"))).toBe("0")
  })

  it("hands a remembered switch back to the backend when the app starts", async () => {
    localStorage.setItem(agentsKey("local"), "1")
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    await mount()
    expect(mocks.chromeSetAgents).toHaveBeenCalledWith(true)
    await openPanel()
    expect(
      screen.getByRole("switch", { name: "Let agents use my Chrome" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("says agents will fail while the switch is on and Chrome is not connected", async () => {
    localStorage.setItem(CONNECTED_BEFORE_KEY, "1")
    mocks.lent = true
    await mount()
    await openPanel()
    expect(
      screen.getByText(/On, but Chrome is not connected/)
    ).toBeInTheDocument()
  })

  it("marks the pages agents opened, and brings any tab to the front", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    mocks.owners.set("browser:1", "chrome@local")
    mocks.grants.set("browser:1", "control")
    await mount()
    await openPanel()
    expect(
      screen.getByText("Opened by an agent · mail.example.com")
    ).toBeInTheDocument()
    // Theirs: nothing to hand over.
    expect(
      screen.queryByRole("button", { name: "Hand to agents · Inbox" })
    ).toBeNull()
    expect(
      screen.getByRole("button", { name: "Hand to agents · localhost" })
    ).toBeInTheDocument()

    await userEvent.click(
      screen.getByRole("button", { name: "Show this tab · Inbox" })
    )
    expect(mocks.chromeActivate).toHaveBeenCalledWith("1")
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
