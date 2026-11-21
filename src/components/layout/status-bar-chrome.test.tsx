import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChromeSiteEdits, ChromeSites } from "@/lib/browser/chrome-sites"
import type {
  ChromeActivityEntry,
  ChromeStatus,
  ChromeTab,
} from "@/lib/browser/chrome-api"

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
  chromeActivity: vi.fn(),
  heardActivity: null as (() => void) | null,
  lendBrowserSwitch: vi.fn<(key: string) => Promise<void>>(async () => {}),
  /** 远端窗口里服务器上的智能体够不够得着这台电脑的 Chrome。 */
  reach: { browserTools: true, devices: 1 } as {
    browserTools: boolean
    devices: number
  } | null,
  remoteBrowserReach: vi.fn(),
  /** 当前对话：标签 id 和数据库里的对话编号。 */
  activeTab: null as { id: string; conversationId: number | null } | null,
  /** 当前对话选的设备，`null` 是服务器还没回答（或本地窗口）。 */
  deviceState: null as {
    answer: {
      device: { id: string } | null
      browserDevice?: { id: string } | null
    }
    canPick: boolean
    canSplit: boolean
  } | null,
  devicePick: vi.fn<(id: string | null, part?: string) => Promise<void>>(
    async () => {}
  ),
  /** 问 `useConversationDeviceState` 时给的对话编号。 */
  askedConversation: [] as (number | null)[],
  thisDeviceId: "dev-here" as string | null,
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
  chromeSites: vi.fn(),
  chromeSetSites: vi.fn(),
  heardSites: null as ((sites: ChromeSites) => void) | null,
  openSettingsWindow: vi.fn(async () => {}),
  setCodegMcpToolGroup: vi.fn<(key: string, enabled: boolean) => Promise<void>>(
    async () => {}
  ),
  /** Whether this window works on a server. */
  remote: false,
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
  chromeActivity: mocks.chromeActivity,
  subscribeAgentActivity: (handler: () => void) => {
    mocks.heardActivity = handler
    return Promise.resolve(() => {})
  },
  subscribeChromeStatus: (handler: (status: unknown) => void) => {
    mocks.heardStatus = handler
    return Promise.resolve(() => {})
  },
  subscribeChromeTabs: (handler: (tabs: unknown) => void) => {
    mocks.heardTabs = handler
    return Promise.resolve(() => {})
  },
}))
vi.mock("@/lib/browser/chrome-sites", () => ({
  chromeSites: mocks.chromeSites,
  chromeSetSites: mocks.chromeSetSites,
  subscribeChromeSites: (handler: (sites: ChromeSites) => void) => {
    mocks.heardSites = handler
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
vi.mock("@/lib/cowork/remote-browser", () => ({
  lendBrowserSwitch: mocks.lendBrowserSwitch,
  remoteBrowserReach: mocks.remoteBrowserReach,
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabStore: <T,>(
    selector: (s: {
      tabs: { id: string; kind: string; conversationId: number | null }[]
      activeTabId: string | null
    }) => T
  ) =>
    selector({
      tabs: mocks.activeTab
        ? [{ ...mocks.activeTab, kind: "conversation" }]
        : [],
      activeTabId: mocks.activeTab?.id ?? null,
    }),
}))
vi.mock("@/lib/cowork/conversation-device", () => ({
  useConversationDeviceState: (conversationId: number | null) => {
    mocks.askedConversation.push(conversationId)
    if (conversationId == null || !mocks.deviceState) return null
    return { ...mocks.deviceState, pick: mocks.devicePick }
  },
}))
vi.mock("@/lib/cowork/host-devices", () => ({
  getThisDevice: async () =>
    mocks.thisDeviceId ? { id: mocks.thisDeviceId, name: "here" } : null,
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => mocks.desktop }))
// Its own test: `chrome-eval-switch.test.tsx`.
vi.mock("@/components/settings/chrome-eval-switch", () => ({
  ChromeEvalPanelSwitch: () => null,
}))
vi.mock("@/lib/api", () => ({
  openSettingsWindow: mocks.openSettingsWindow,
  setCodegMcpToolGroup: mocks.setCodegMcpToolGroup,
}))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  isRemoteDesktopMode: () => mocks.remote,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { agentsKey, StatusBarChrome } from "./status-bar-chrome"
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

function sites(over: Partial<ChromeSites> = {}): ChromeSites {
  return {
    defaults: ["mail.example-mail.test"],
    blocked: ["shop.example.test"],
    allowed: [],
    paused: false,
    groups: [{ id: "mail", sites: ["mail.example-mail.test"] }],
    ...over,
  }
}

const TABS: ChromeTab[] = [
  {
    id: "1",
    title: "Inbox",
    host: "mail.example.com",
    level: "none",
    openedByAgent: false,
  },
  {
    id: "2",
    title: "",
    host: "localhost",
    level: "none",
    openedByAgent: false,
  },
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
  mocks.chromeActivity.mockReset().mockResolvedValue({})
  mocks.heardActivity = null
  mocks.lendBrowserSwitch.mockReset().mockResolvedValue(undefined)
  mocks.reach = { browserTools: true, devices: 1 }
  mocks.remoteBrowserReach
    .mockReset()
    .mockImplementation(async () => mocks.reach)
  mocks.activeTab = null
  mocks.deviceState = null
  mocks.devicePick.mockReset().mockResolvedValue(undefined)
  mocks.askedConversation = []
  mocks.thisDeviceId = "dev-here"
  mocks.windowLabel = "main"
  mocks.grants.clear()
  mocks.owners.clear()
  mocks.openSettingsWindow.mockClear()
  mocks.setCodegMcpToolGroup.mockReset().mockResolvedValue(undefined)
  mocks.remote = false
  mocks.toast.error.mockReset()
  mocks.heardSites = null
  mocks.chromeSites.mockReset().mockResolvedValue(sites())
  mocks.chromeSetSites
    .mockReset()
    .mockImplementation(async (edits: ChromeSiteEdits) =>
      sites({ ...edits, paused: edits.paused ?? false })
    )
})

describe("StatusBarChrome and the sensitive sites", () => {
  const glyph = () => screen.getByRole("button", { name: "Your own Chrome" })
  const dot = () => glyph().querySelector("[data-sites-paused]")

  it("has no dot while the list is in force", async () => {
    await mount()
    expect(dot()).toBeNull()
    expect(glyph()).toHaveAttribute("title", "Your own Chrome · Not connected")
  })

  it("marks the glyph while the list is paused, connected or not", async () => {
    mocks.chromeSites.mockResolvedValue(sites({ paused: true }))
    await mount()
    expect(dot()).not.toBeNull()
    expect(dot()?.getAttribute("class")).toContain("bg-amber-500")
    expect(glyph()).toHaveAttribute(
      "title",
      "Your own Chrome · Not connected · Not blocking sensitive sites"
    )

    await act(async () => {
      mocks.heardStatus?.(CONNECTED)
    })
    expect(dot()).not.toBeNull()
    expect(glyph()).toHaveAttribute(
      "title",
      "Your own Chrome · Connected to Chrome/154.0.8037.98 · Not blocking sensitive sites"
    )
  })

  it("pauses the list from the panel, and turns it back on, never asking", async () => {
    await mount()
    await openPanel()
    const toggle = screen.getByRole("switch", {
      name: "Block sensitive sites",
    })
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(screen.queryByText("Paused: agents can use every site")).toBeNull()

    await act(async () => {
      fireEvent.click(toggle)
    })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: ["shop.example.test"],
      allowed: [],
      paused: true,
    })
    expect(
      screen.getByRole("switch", { name: "Block sensitive sites" })
    ).toHaveAttribute("aria-checked", "false")
    const notice = screen.getByText("Paused: agents can use every site")
    expect(notice).toBeVisible()
    expect(notice.closest("[data-sites-row]")?.className).toContain(
      "border-amber"
    )
    expect(dot()).not.toBeNull()

    await act(async () => {
      fireEvent.click(
        screen.getByRole("switch", { name: "Block sensitive sites" })
      )
    })
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: ["shop.example.test"],
      allowed: [],
      paused: false,
    })
    expect(screen.queryByText("Paused: agents can use every site")).toBeNull()
    expect(dot()).toBeNull()
  })

  it("follows a pause made on the settings page without being reopened", async () => {
    await mount()
    await openPanel()
    expect(dot()).toBeNull()

    await act(async () => {
      mocks.heardSites?.(sites({ paused: true }))
    })
    expect(dot()).not.toBeNull()
    expect(
      screen.getByRole("switch", { name: "Block sensitive sites" })
    ).toHaveAttribute("aria-checked", "false")

    await act(async () => {
      mocks.heardSites?.(sites({ paused: false }))
    })
    expect(dot()).toBeNull()
    expect(
      screen.getByRole("switch", { name: "Block sensitive sites" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("says so when the pause could not be changed", async () => {
    mocks.chromeSetSites.mockRejectedValue(new Error("disk full"))
    await mount()
    await openPanel()
    await act(async () => {
      fireEvent.click(
        screen.getByRole("switch", { name: "Block sensitive sites" })
      )
    })
    expect(mocks.toast.error).toHaveBeenCalled()
    expect(
      screen.getByRole("switch", { name: "Block sensitive sites" })
    ).toHaveAttribute("aria-checked", "true")
  })
})

describe("StatusBarChrome", () => {
  it("is not there outside the desktop app", async () => {
    mocks.desktop = false
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    const { container } = await mount()
    expect(container).toBeEmptyDOMElement()
    expect(mocks.chromeStatus).not.toHaveBeenCalled()
  })

  it("is there before this computer has ever connected, to connect from", async () => {
    await mount()
    expect(
      screen.getByRole("button", { name: "Your own Chrome" })
    ).toHaveAttribute("title", "Your own Chrome · Not connected")

    await openPanel()
    expect(
      screen.getByRole("switch", { name: "Let agents use my Chrome" })
    ).toBeInTheDocument()
    await press("Connect to Chrome")
    expect(mocks.chromeConnect).toHaveBeenCalled()
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

  it("shows the level the tab list carries when this window never heard the tab's state", async () => {
    // 远端窗口在本机窗口交出标签以后才打开：存储里没有这个标签的状态，
    // 级别只能从后端的标签列表里来。
    mocks.windowLabel = "remote-workspace-7"
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue([
      { ...TABS[0], level: "control", openedByAgent: false },
      {
        id: "3",
        title: "Found",
        host: "wiki.example.org",
        level: "control",
        openedByAgent: true,
      },
    ])
    await mount()
    await openPanel()
    expect(
      screen.getByRole("button", { name: "Hand to agents · Inbox" })
    ).toHaveTextContent("Can act")
    expect(
      screen.getByText("Opened by an agent · wiki.example.org")
    ).toBeInTheDocument()

    // 之后听到的状态比列表新：收回以后按状态显示。
    mocks.owners.set("browser:1", "chrome")
    await act(async () => {
      mocks.heardTabs?.([
        { ...TABS[0], level: "control", openedByAgent: false },
      ])
    })
    expect(
      screen.getByRole("button", { name: "Hand to agents · Inbox" })
    ).not.toHaveTextContent("Can act")
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
    // The server's agents get there through the tabs this app lends.
    expect(mocks.lendBrowserSwitch).toHaveBeenCalledTimes(1)
    expect(mocks.lendBrowserSwitch).toHaveBeenCalledWith("browser")

    await userEvent.click(toggle)
    expect(mocks.chromeSetAgents).toHaveBeenLastCalledWith(false)
    expect(localStorage.getItem(agentsKey("remote-workspace-7"))).toBe("0")
    // Turning it off leaves the app's own browser tools as they are.
    expect(mocks.lendBrowserSwitch).toHaveBeenCalledTimes(1)
  })

  it("in a remote window, also turns the server's browser tools on, and leaves them on when turned off", async () => {
    mocks.windowLabel = "remote-workspace-7"
    mocks.remote = true
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    await mount()
    await openPanel()
    const toggle = screen.getByRole("switch", {
      name: "Let agents use my Chrome",
    })
    await userEvent.click(toggle)
    // 一个开关就够：服务器上的智能体靠服务器那边的浏览器工具组拿到工具。
    expect(mocks.setCodegMcpToolGroup).toHaveBeenCalledTimes(1)
    expect(mocks.setCodegMcpToolGroup).toHaveBeenCalledWith("browser", true)
    expect(mocks.lendBrowserSwitch).toHaveBeenCalledWith("browser")

    await userEvent.click(toggle)
    expect(mocks.chromeSetAgents).toHaveBeenLastCalledWith(false)
    // 关的时候不动服务器那边。
    expect(mocks.setCodegMcpToolGroup).toHaveBeenCalledTimes(1)
  })

  it("does not touch the server's tools in a local window", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    await mount()
    await openPanel()
    await userEvent.click(
      screen.getByRole("switch", { name: "Let agents use my Chrome" })
    )
    expect(mocks.chromeSetAgents).toHaveBeenCalledWith(true)
    expect(mocks.setCodegMcpToolGroup).not.toHaveBeenCalled()
  })

  it("says so when the server's browser tools could not be turned on", async () => {
    mocks.windowLabel = "remote-workspace-7"
    mocks.remote = true
    mocks.setCodegMcpToolGroup.mockRejectedValue(new Error("offline"))
    await mount()
    await openPanel()
    const toggle = screen.getByRole("switch", {
      name: "Let agents use my Chrome",
    })
    await userEvent.click(toggle)
    // 自己这边的开关照样开着；只提示服务器那边没开成。
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("Settings → Collaboration")
    )
  })

  it("does not write the server's settings when a remembered switch is handed back", async () => {
    mocks.windowLabel = "remote-workspace-7"
    mocks.remote = true
    localStorage.setItem(agentsKey("remote-workspace-7"), "1")
    await mount()
    expect(mocks.chromeSetAgents).toHaveBeenCalledWith(true)
    expect(mocks.setCodegMcpToolGroup).not.toHaveBeenCalled()
  })

  it("hands a remembered switch back to the backend when the app starts", async () => {
    localStorage.setItem(agentsKey("local"), "1")
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    await mount()
    expect(mocks.chromeSetAgents).toHaveBeenCalledWith(true)
    expect(mocks.lendBrowserSwitch).toHaveBeenCalledWith("browser")
    await openPanel()
    expect(
      screen.getByRole("switch", { name: "Let agents use my Chrome" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("says agents will fail while the switch is on and Chrome is not connected", async () => {
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
    // 直接落到页里「你自己的 Chrome」那张卡片，不停在内置浏览器的最上面（#983）
    expect(mocks.openSettingsWindow).toHaveBeenCalledWith("browser", {
      focus: "chrome",
    })
  })

  it("shows what agents did on a tab, newest first, never what was typed", async () => {
    const now = Date.now()
    const line = (over: Partial<ChromeActivityEntry>): ChromeActivityEntry => ({
      at: now - 150_000,
      action: "read",
      outcome: "done",
      host: "mail.example.com",
      scope: "local",
      target: null,
      ...over,
    })
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    mocks.grants.set("browser:1", "control")
    mocks.chromeActivity.mockResolvedValue({
      "1": [
        line({ at: now - 330_000 }),
        line({
          at: now - 270_000,
          action: "type",
          target: { kind: "named", name: "Email" },
        }),
        line({
          at: now - 210_000,
          action: "type",
          target: { kind: "password" },
          scope: "remote-workspace-7",
        }),
        line({ action: "click", target: { kind: "named", name: "Submit" } }),
      ],
    })
    await mount()
    await openPanel()
    expect(mocks.chromeActivity).toHaveBeenCalledTimes(1)
    const latest = screen.getByRole("button", {
      name: "Last: 2 minutes ago · clicked “Submit”",
    })
    expect(latest).toHaveAttribute("aria-expanded", "false")
    // A tab nobody touched has no record line.
    expect(screen.queryAllByRole("button", { name: /^Last:/ })).toHaveLength(1)

    await userEvent.click(latest)
    const record = screen.getByRole("list", {
      name: "What agents did on this tab",
    })
    const lines = Array.from(record.querySelectorAll("li")).map(
      (li) => li.textContent
    )
    expect(lines).toEqual([
      "2 minutes ago · This computer's agent · clicked “Submit”",
      "3 minutes ago · Another window's server · typed into the password field",
      "4 minutes ago · This computer's agent · typed into “Email”",
      "5 minutes ago · This computer's agent · read the page",
    ])
  })

  it("shows the code an agent ran, a click away", async () => {
    const now = Date.now()
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    mocks.grants.set("browser:1", "control")
    mocks.chromeActivity.mockResolvedValue({
      "1": [
        {
          at: now - 150_000,
          action: "eval",
          outcome: "refused",
          host: "mail.example.com",
          scope: "local",
          target: { kind: "code", code: "return document.title" },
        },
      ],
    })
    await mount()
    await openPanel()
    await userEvent.click(
      screen.getByRole("button", {
        name: "Last: 2 minutes ago · ran code on the page (refused)",
      })
    )
    expect(screen.queryByText("return document.title")).toBeNull()
    const show = screen.getByRole("button", { name: "Show the code" })
    expect(show).toHaveAttribute("aria-expanded", "false")
    await userEvent.click(show)
    expect(screen.getByText("return document.title").tagName).toBe("PRE")
    await userEvent.click(screen.getByRole("button", { name: "Hide the code" }))
    expect(screen.queryByText("return document.title")).toBeNull()
  })

  it("names the files agents uploaded to and downloaded", async () => {
    const now = Date.now()
    const line = (over: Partial<ChromeActivityEntry>): ChromeActivityEntry => ({
      at: now - 150_000,
      action: "upload",
      outcome: "done",
      host: "mail.example.com",
      scope: "local",
      target: null,
      ...over,
    })
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    mocks.grants.set("browser:1", "control")
    mocks.chromeActivity.mockResolvedValue({
      "1": [
        line({ at: now - 330_000, target: { kind: "named", name: "Resume" } }),
        line({ at: now - 270_000 }),
        line({
          at: now - 210_000,
          action: "download",
          outcome: "failed",
          target: { kind: "named", name: "big.iso" },
        }),
        line({ action: "download", target: { kind: "named", name: "a.pdf" } }),
      ],
    })
    await mount()
    await openPanel()
    await userEvent.click(
      screen.getByRole("button", {
        name: "Last: 2 minutes ago · downloaded “a.pdf”",
      })
    )
    const record = screen.getByRole("list", {
      name: "What agents did on this tab",
    })
    const lines = Array.from(record.querySelectorAll("li")).map(
      (li) => li.textContent
    )
    expect(lines[1]).toMatch(/downloaded “big\.iso”/)
    expect(lines.slice(2)).toEqual([
      "4 minutes ago · This computer's agent · uploaded a file",
      "5 minutes ago · This computer's agent · uploaded a file to “Resume”",
    ])
  })

  it("asks again when an agent does something, and marks what did not go through", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(TABS)
    await mount()
    await openPanel()
    expect(screen.queryByRole("button", { name: /^Last:/ })).toBeNull()

    mocks.chromeActivity.mockResolvedValue({
      "2": [
        {
          at: Date.now(),
          action: "navigate",
          outcome: "refused",
          host: "localhost",
          scope: "local",
          target: null,
        },
      ],
    })
    await act(async () => {
      mocks.heardActivity?.()
    })
    expect(mocks.chromeActivity).toHaveBeenCalledTimes(2)
    expect(
      screen.getByRole("button", {
        name: "Last: now · went to another page (refused)",
      })
    ).toBeInTheDocument()
  })

  it("reports a command that failed outright", async () => {
    mocks.chromeConnect.mockRejectedValue(new Error("no such command"))
    await mount()
    await openPanel()
    await press("Connect to Chrome")
    expect(mocks.toast.error).toHaveBeenCalledWith(
      "Chrome connection failed: no such command"
    )
  })
})

describe("StatusBarChrome and what the server's agents still need (#1060)", () => {
  const SHARED: ChromeTab[] = [{ ...TABS[0], level: "control" }, TABS[1]]

  function remoteWindow() {
    mocks.windowLabel = "remote-workspace-7"
    mocks.remote = true
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
  }

  const checklist = () => document.querySelector("[data-server-reach]")

  it("lists this computer's browser tools and the agents switch when a tab is handed over", async () => {
    remoteWindow()
    mocks.chromeTabs.mockResolvedValue(SHARED)
    mocks.reach = { browserTools: false, devices: 1 }
    await mount()
    await openPanel()
    expect(checklist()).not.toBeNull()
    expect(
      screen.getByText(/This computer's browser tools are off/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(
        /Tabs you hand over are seen only by agents on this computer/
      )
    ).toBeInTheDocument()
    // 一台电脑：不用选
    expect(screen.queryByText(/Pick a computer/)).toBeNull()

    mocks.reach = { browserTools: true, devices: 1 }
    await press("Turn on this computer's browser tools")
    expect(mocks.lendBrowserSwitch).toHaveBeenCalledWith("browser")
    expect(
      screen.queryByText(/This computer's browser tools are off/)
    ).toBeNull()

    await press("Turn on Let agents use my Chrome")
    expect(mocks.chromeSetAgents).toHaveBeenLastCalledWith(true)
    expect(mocks.setCodegMcpToolGroup).toHaveBeenCalledWith("browser", true)
    expect(checklist()).toBeNull()
  })

  it("tells to pick this computer when the server knows several", async () => {
    remoteWindow()
    mocks.lent = true
    mocks.reach = { browserTools: true, devices: 2 }
    await mount()
    await openPanel()
    expect(checklist()).not.toBeNull()
    expect(screen.getByText(/Pick a computer/)).toBeInTheDocument()
  })

  it("picks this computer for the open conversation from the checklist", async () => {
    remoteWindow()
    mocks.lent = true
    mocks.reach = { browserTools: true, devices: 2 }
    mocks.activeTab = { id: "conv-a", conversationId: 41 }
    mocks.deviceState = {
      answer: {
        device: { id: "dev-other" },
        browserDevice: { id: "dev-other" },
      },
      canPick: true,
      canSplit: true,
    }
    await mount()
    await openPanel()
    expect(checklist()).not.toBeNull()
    expect(
      screen.getByText(/this conversation's agent uses another computer/)
    ).toBeInTheDocument()
    mocks.devicePick.mockImplementation(async () => {
      mocks.deviceState = {
        answer: {
          device: { id: "dev-other" },
          browserDevice: { id: "dev-here" },
        },
        canPick: true,
        canSplit: true,
      }
    })
    await press("Pick this computer for this conversation's browser")
    // 能分开选时只改浏览器那一样，命令行那台不动
    expect(mocks.devicePick).toHaveBeenCalledWith("dev-here", "browser")
    expect(mocks.askedConversation).toContain(41)
  })

  it("says nothing about picking once the conversation uses this computer", async () => {
    remoteWindow()
    mocks.lent = true
    mocks.reach = { browserTools: true, devices: 2 }
    mocks.activeTab = { id: "conv-a", conversationId: 41 }
    mocks.deviceState = {
      answer: {
        device: { id: "dev-other" },
        browserDevice: { id: "dev-here" },
      },
      canPick: true,
      canSplit: true,
    }
    await mount()
    await openPanel()
    expect(checklist()).toBeNull()
  })

  it("picks the one device of a server that cannot split", async () => {
    remoteWindow()
    mocks.lent = true
    mocks.reach = { browserTools: true, devices: 3 }
    mocks.activeTab = { id: "conv-a", conversationId: 41 }
    mocks.deviceState = {
      answer: { device: null },
      canPick: true,
      canSplit: false,
    }
    await mount()
    await openPanel()
    await press("Pick this computer for this conversation's browser")
    expect(mocks.devicePick).toHaveBeenCalledWith("dev-here", undefined)
  })

  it("says so when this computer could not be picked", async () => {
    remoteWindow()
    mocks.lent = true
    mocks.reach = { browserTools: true, devices: 2 }
    mocks.activeTab = { id: "conv-a", conversationId: 41 }
    mocks.deviceState = {
      answer: { device: null, browserDevice: null },
      canPick: true,
      canSplit: true,
    }
    mocks.devicePick.mockRejectedValue(new Error("offline"))
    await mount()
    await openPanel()
    await press("Pick this computer for this conversation's browser")
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("offline")
    )
  })

  it("says nothing while nothing is handed over and the switch is off", async () => {
    remoteWindow()
    mocks.chromeTabs.mockResolvedValue(TABS)
    mocks.reach = { browserTools: false, devices: 2 }
    await mount()
    await openPanel()
    expect(checklist()).toBeNull()
  })

  it("has no checklist in a local window", async () => {
    mocks.chromeStatus.mockResolvedValue(CONNECTED)
    mocks.chromeTabs.mockResolvedValue(SHARED)
    mocks.reach = null
    await mount()
    await openPanel()
    expect(checklist()).toBeNull()
  })

  it("says so when this computer's browser tools could not be turned on", async () => {
    remoteWindow()
    mocks.lendBrowserSwitch.mockRejectedValue(new Error("denied"))
    await mount()
    await openPanel()
    await userEvent.click(
      screen.getByRole("switch", { name: "Let agents use my Chrome" })
    )
    expect(mocks.toast.error).toHaveBeenCalledWith(
      expect.stringContaining("denied")
    )
  })
})
