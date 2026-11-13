import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TerminalProvider, useTerminalContext } from "./terminal-context"
import {
  commandLinkKey,
  useCommandTerminalLinkStore,
} from "@/stores/command-terminal-link-store"

const h = vi.hoisted(() => ({
  terminalKill: vi.fn(async () => {}),
  terminalSnapshot: vi.fn(),
  listeners: new Map<string, (payload?: unknown) => void>(),
  // While set, exit subscriptions wait to be granted (see `grant`).
  holdSubscribe: false,
  grants: [] as (() => void)[],
  ready: null as (() => void) | null,
  remoteId: null as number | null,
  windowLabel: "main",
  activeFolderId: 7 as number | null,
}))

vi.mock("@/lib/api", () => ({
  getSystemTerminalSettings: vi.fn(async () => ({ default_shell: null })),
  terminalKill: h.terminalKill,
  terminalSnapshot: h.terminalSnapshot,
}))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({
    subscribe: (event: string, handler: (payload?: unknown) => void) => {
      h.listeners.set(event, handler)
      const unlisten = () => {
        h.listeners.delete(event)
      }
      if (!h.holdSubscribe || !event.startsWith("terminal://exit/")) {
        return Promise.resolve(unlisten)
      }
      return new Promise<() => void>((resolve) => {
        h.grants.push(() => resolve(unlisten))
      })
    },
    onReady: (callback: () => void) => {
      h.ready = callback
      return () => {
        h.ready = null
      }
    },
  }),
  getActiveRemoteConnectionId: () => h.remoteId,
}))
vi.mock("@/lib/browser/window-label", () => ({
  getCurrentWindowLabel: () => h.windowLabel,
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder:
      h.activeFolderId == null
        ? null
        : { id: h.activeFolderId, path: "/tmp/codeg-749" },
    activeFolderId: h.activeFolderId,
  }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: {
      new_terminal_tab: null,
      close_current_terminal_tab: null,
    },
  }),
}))
vi.mock("@/lib/keyboard-shortcuts", () => ({
  matchShortcutEvent: () => false,
}))

function Probe() {
  const terminal = useTerminalContext()
  return (
    <div>
      <button
        onClick={() => {
          void terminal.createTerminalWithCommand("Long build", "sleep 120", 42)
        }}
      >
        Run
      </button>
      <button
        onClick={() =>
          terminal.activeTabId && terminal.closeTerminal(terminal.activeTabId)
        }
      >
        Close
      </button>
      <button
        onClick={() => {
          void terminal.createTerminalInDirectory("/tmp/codeg-749-other", "Dir")
        }}
      >
        Open dir
      </button>
      <button
        onClick={() => {
          void terminal.createTerminal()
        }}
      >
        New
      </button>
      <button
        onClick={() =>
          terminal.tabs[0] && terminal.closeTerminal(terminal.tabs[0].id)
        }
      >
        Close first
      </button>
      <button
        onClick={() =>
          terminal.activeTabId &&
          terminal.renameTerminal(terminal.activeTabId, "t".repeat(300))
        }
      >
        Rename long
      </button>
      <button
        onClick={() =>
          terminal.activeTabId &&
          terminal.renameTerminal(
            terminal.activeTabId,
            `Terminal ${Number.MAX_SAFE_INTEGER}`
          )
        }
      >
        Rename huge
      </button>
      <button
        onClick={() =>
          terminal.activeTabId &&
          terminal.renameTerminal(
            terminal.activeTabId,
            "Terminal 999999999999999"
          )
        }
      >
        Rename 15 digits
      </button>
      <button
        onClick={() =>
          terminal.activeTabId &&
          terminal.renameTerminal(
            terminal.activeTabId,
            "Terminal 9007199254740993"
          )
        }
      >
        Rename beyond
      </button>
      <span data-testid="tabs">{terminal.tabs.length}</span>
      <span data-testid="titles">
        {terminal.tabs.map((tab) => tab.title.length).join(",")}
      </span>
      <span data-testid="title-text">
        {terminal.tabs.map((tab) => tab.title).join("|")}
      </span>
      <span data-testid="active">{terminal.activeTabId ?? ""}</span>
      <span data-testid="command">
        {terminal.tabs[0]?.initialCommand ?? ""}
      </span>
      <span data-testid="exited">
        {[...terminal.exitedTerminals].join(",")}
      </span>
    </div>
  )
}

describe("TerminalProvider reload recovery", () => {
  beforeEach(() => {
    h.terminalKill.mockClear()
    h.terminalSnapshot.mockReset()
    h.terminalSnapshot.mockResolvedValue({
      exists: false,
      alive: false,
      data: "",
      seq: 0,
    })
    h.listeners.clear()
    h.holdSubscribe = false
    h.grants.length = 0
    h.ready = null
    h.remoteId = null
    h.windowLabel = "main"
    h.activeFolderId = 7
    sessionStorage.clear()
    window.name = ""
    useCommandTerminalLinkStore.setState({ links: {} })
  })

  it("keeps a running command owned by this page and restores its tab after reload", () => {
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    expect(screen.getByTestId("tabs")).toHaveTextContent("1")
    expect(screen.getByTestId("command")).toHaveTextContent("sleep 120")
    const originalId = screen.getByTestId("active").textContent

    expect(sessionStorage.getItem("codeg:terminal-session:v1")).not.toContain(
      "sleep 120"
    )
    first.unmount()
    expect(h.terminalKill).not.toHaveBeenCalled()

    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("1")
    expect(screen.getByTestId("active").textContent).toBe(originalId)
    expect(screen.getByTestId("command")).toBeEmptyDOMElement()
  })

  it("explicit close kills the terminal even before a view has started it", () => {
    // No view is mounted, so nothing has launched yet. The kill goes out
    // anyway: the backend turns it into a cancellation of the launch.
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    const id = screen.getByTestId("active").textContent
    fireEvent.click(screen.getByRole("button", { name: "Close" }))
    expect(h.terminalKill).toHaveBeenCalledWith(id)
    expect(screen.getByTestId("tabs")).toHaveTextContent("0")
    expect(sessionStorage.getItem("codeg:terminal-session:v1")).not.toContain(
      id
    )
  })

  it("restores nothing under a window name it did not give, and keeps that name", () => {
    // Everything else in the stored session is valid, so the window name is
    // the only thing that can be refusing it. A forged terminal ID under a
    // name of ours costs only that tab: "drops only the stored tab it cannot
    // validate" below.
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    window.name = "host-window"
    sessionStorage.setItem(
      "codeg:terminal-session:v1",
      JSON.stringify({
        version: 1,
        scope: JSON.stringify(["main", null]),
        pageId: "host-window",
        isOpen: true,
        activeTabId: id,
        tabs: [{ id, folderId: 7, title: "valid", workingDir: "/tmp" }],
      })
    )
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(window.name).toBe("host-window")
    expect(screen.getByTestId("tabs")).toHaveTextContent("0")
  })

  it("does not auto-attach a copied opener session in a new tab", () => {
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    const copiedStorage = sessionStorage.getItem("codeg:terminal-session:v1")
    expect(copiedStorage).toBeTruthy()
    first.unmount()

    // New browsing context: the opener's sessionStorage is cloned, but the
    // browser gives this tab its own window.name.
    window.name = ""
    sessionStorage.setItem("codeg:terminal-session:v1", copiedStorage!)
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("0")
    expect(h.terminalKill).not.toHaveBeenCalled()
  })

  it.each([
    ["another window", { windowLabel: "remote-workspace-4", remoteId: 3 }],
    [
      "another remote connection",
      { windowLabel: "remote-workspace-3", remoteId: 4 },
    ],
  ])("does not restore terminals saved for %s", (_, other) => {
    // Either half of the scope alone must keep the session out.
    h.windowLabel = "remote-workspace-3"
    h.remoteId = 3
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    expect(screen.getByTestId("tabs")).toHaveTextContent("1")
    first.unmount()

    h.windowLabel = other.windowLabel
    h.remoteId = other.remoteId
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("0")
  })

  it("restores a tab opened while no workspace tab is active, with the rest", () => {
    // With no active workspace tab the provider records folder 0 (the
    // sidebar's "open in terminal" does this). The reader must take back what
    // the writer wrote, or one such tab costs every tab its way back.
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    h.activeFolderId = null
    first.rerender(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Open dir" }))
    expect(screen.getByTestId("tabs")).toHaveTextContent("2")
    first.unmount()

    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("2")
  })

  it("stores an over-long title clamped rather than losing the session", () => {
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    fireEvent.click(screen.getByRole("button", { name: "Rename long" }))
    expect(screen.getByTestId("titles")).toHaveTextContent("300")
    // Clamped on the way in, not only on the way back out.
    const stored = JSON.parse(
      sessionStorage.getItem("codeg:terminal-session:v1") ?? "{}"
    )
    expect(stored.tabs[0].title).toHaveLength(256)
    first.unmount()

    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("1")
    expect(screen.getByTestId("titles")).toHaveTextContent("256")
  })

  it("drops only the stored tab it cannot validate, and clamps a long title", () => {
    const pageId = "0b6f3d7e-5a1c-4e2b-9f8a-1c2d3e4f5a6b"
    const goodId = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    window.name = `codeg-terminal-page:${pageId}`
    sessionStorage.setItem(
      "codeg:terminal-session:v1",
      JSON.stringify({
        version: 1,
        scope: JSON.stringify(["main", null]),
        pageId,
        isOpen: true,
        activeTabId: "not-a-terminal-id",
        tabs: [
          {
            id: "not-a-terminal-id",
            folderId: 7,
            title: "forged",
            workingDir: "/tmp",
          },
          {
            id: goodId,
            folderId: 7,
            title: "k".repeat(300),
            workingDir: "/tmp",
          },
        ],
      })
    )
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("1")
    expect(screen.getByTestId("active").textContent).toBe(goodId)
    expect(screen.getByTestId("titles")).toHaveTextContent("256")
  })

  it("restores every tab, however many there are", () => {
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    for (let n = 0; n < 40; n++) {
      fireEvent.click(screen.getByRole("button", { name: "Open dir" }))
    }
    expect(screen.getByTestId("tabs")).toHaveTextContent("40")
    first.unmount()

    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("40")
  })

  it("never repeats a default title a restored tab still shows", () => {
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    for (let n = 0; n < 3; n++) {
      fireEvent.click(screen.getByRole("button", { name: "New" }))
    }
    fireEvent.click(screen.getByRole("button", { name: "Close first" }))
    expect(screen.getByTestId("title-text")).toHaveTextContent(
      "Terminal 2|Terminal 3"
    )
    first.unmount()

    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    expect(screen.getByTestId("title-text")).toHaveTextContent(
      "Terminal 2|Terminal 3|Terminal 4"
    )
  })

  it("links the launcher back to a command tab after a reload", () => {
    // The launcher's links are in memory and a reload starts them empty.
    // Unless the tab brings its command's id back, the launcher offers to
    // run a second copy of a command that is still running in it.
    const first = render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    const id = screen.getByTestId("active").textContent
    first.unmount()
    useCommandTerminalLinkStore.setState({ links: {} })

    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(useCommandTerminalLinkStore.getState().links).toEqual({
      [commandLinkKey(7, 42)]: id,
    })
    expect(sessionStorage.getItem("codeg:terminal-session:v1")).not.toContain(
      "sleep 120"
    )
  })

  it("restores a tab whose stored command link is unusable, without the link", () => {
    const pageId = "0b6f3d7e-5a1c-4e2b-9f8a-1c2d3e4f5a6b"
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    window.name = `codeg-terminal-page:${pageId}`
    sessionStorage.setItem(
      "codeg:terminal-session:v1",
      JSON.stringify({
        version: 1,
        scope: JSON.stringify(["main", null]),
        pageId,
        isOpen: true,
        activeTabId: id,
        tabs: [
          {
            id,
            folderId: 7,
            title: "dev",
            workingDir: "/tmp",
            commandId: "rm -rf /",
          },
        ],
      })
    )
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("1")
    expect(useCommandTerminalLinkStore.getState().links).toEqual({})
  })

  it("links a global command's tab back to the folder it ran in", () => {
    // Global commands have negative ids, the same id in every folder.
    const pageId = "0b6f3d7e-5a1c-4e2b-9f8a-1c2d3e4f5a6b"
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    window.name = `codeg-terminal-page:${pageId}`
    sessionStorage.setItem(
      "codeg:terminal-session:v1",
      JSON.stringify({
        version: 1,
        scope: JSON.stringify(["main", null]),
        pageId,
        isOpen: true,
        activeTabId: id,
        tabs: [
          { id, folderId: 9, title: "dev", workingDir: "/tmp", commandId: -3 },
        ],
      })
    )
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(useCommandTerminalLinkStore.getState().links).toEqual({
      [commandLinkKey(9, -3)]: id,
    })
  })

  function storeCommandTab(id: string) {
    const pageId = "0b6f3d7e-5a1c-4e2b-9f8a-1c2d3e4f5a6b"
    window.name = `codeg-terminal-page:${pageId}`
    sessionStorage.setItem(
      "codeg:terminal-session:v1",
      JSON.stringify({
        version: 1,
        scope: JSON.stringify(["main", null]),
        pageId,
        isOpen: false,
        activeTabId: id,
        tabs: [
          { id, folderId: 7, title: "dev", workingDir: "/tmp", commandId: 42 },
        ],
      })
    )
  }

  it("marks a command tab that ended before the reload as exited, with no view", async () => {
    // The launcher reads `exitedTerminals`. A closed mobile drawer keeps the
    // tab's view unmounted, and the exit itself came before this page did.
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    storeCommandTab(id)
    h.terminalSnapshot.mockResolvedValue({
      exists: true,
      alive: false,
      data: "done",
      seq: 1,
    })
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    await waitFor(() =>
      expect(screen.getByTestId("exited")).toHaveTextContent(id)
    )
    expect(h.terminalSnapshot).toHaveBeenCalledWith(id)
  })

  it("leaves a restored command tab the backend has no record of to its view", async () => {
    // Missing can mean the reload overtook its launch. The view waits that
    // out before calling it gone; the provider must not decide sooner.
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    storeCommandTab(id)
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    await waitFor(() => expect(h.terminalSnapshot).toHaveBeenCalledWith(id))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByTestId("exited")).toBeEmptyDOMElement()
  })

  it("hears a command tab's exit with no view mounted", async () => {
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "Run" }))
    const id = screen.getByTestId("active").textContent
    await waitFor(() =>
      expect(h.listeners.has(`terminal://exit/${id}`)).toBe(true)
    )
    act(() => {
      h.listeners.get(`terminal://exit/${id}`)?.()
    })
    expect(screen.getByTestId("exited")).toHaveTextContent(id!)
    // Not asked about: it started in this page, which hears its exit.
    expect(h.terminalSnapshot).not.toHaveBeenCalled()
  })

  it("asks about a restored command tab only once it is listening for its exit", async () => {
    // Asked first, an exit between the answer and the listener would be
    // heard by nothing.
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    storeCommandTab(id)
    h.holdSubscribe = true
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    await waitFor(() => expect(h.grants).toHaveLength(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(h.terminalSnapshot).not.toHaveBeenCalled()
    await act(async () => {
      h.grants[0]()
    })
    await waitFor(() => expect(h.terminalSnapshot).toHaveBeenCalledWith(id))
  })

  it("restores tabs whatever their stored directory or shell", () => {
    // Neither ever launches anything for a restored tab, so no bound on them
    // protects a thing — while each one cost a tab its way back.
    const pageId = "0b6f3d7e-5a1c-4e2b-9f8a-1c2d3e4f5a6b"
    window.name = `codeg-terminal-page:${pageId}`
    const ids = [
      "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098",
      "4e3d2c1b-0a9f-4e8d-b7c6-d5e4f3a2b109",
      "5f4e3d2c-1b0a-4f9e-8d7c-b6a5f4e3d2c1",
    ]
    sessionStorage.setItem(
      "codeg:terminal-session:v1",
      JSON.stringify({
        version: 1,
        scope: JSON.stringify(["main", null]),
        pageId,
        isOpen: true,
        activeTabId: ids[0],
        tabs: [
          {
            id: ids[0],
            folderId: 7,
            title: "long shell",
            workingDir: "/tmp",
            shell: `/nix/store/${"a".repeat(600)}/bin/zsh`,
          },
          {
            id: ids[1],
            folderId: 7,
            title: "extended path",
            workingDir: `\\\\?\\C:\\${"d\\".repeat(2500)}`,
          },
          {
            id: ids[2],
            folderId: 7,
            title: "relative path",
            workingDir: "project",
          },
        ],
      })
    )
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("3")
  })

  it("counts on exactly from a restored number of any size", () => {
    const renderProvider = () =>
      render(
        <TerminalProvider>
          <Probe />
        </TerminalProvider>
      )
    const titles = () => screen.getByTestId("title-text").textContent
    // A long number restored, counted on from, and restored again.
    let view = renderProvider()
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    fireEvent.click(screen.getByRole("button", { name: "Rename 15 digits" }))
    view.unmount()
    view = renderProvider()
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    view.unmount()
    view = renderProvider()
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    expect(titles()).toBe(
      "Terminal 999999999999999|Terminal 1000000000000000|Terminal 1000000000000001"
    )

    // Around the largest exact double: one restored number just below it,
    // one past it.
    fireEvent.click(screen.getByRole("button", { name: "Rename huge" }))
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    fireEvent.click(screen.getByRole("button", { name: "Rename beyond" }))
    view.unmount()
    renderProvider()
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    expect(titles()).toBe(
      [
        "Terminal 999999999999999",
        "Terminal 1000000000000000",
        "Terminal 9007199254740991",
        "Terminal 9007199254740993",
        "Terminal 9007199254740994",
        "Terminal 9007199254740995",
      ].join("|")
    )
  })

  it("asks again after a reconnect when asking about a restored command tab failed", async () => {
    const id = "3f2c1b0a-9e8d-4c7b-a6f5-e4d3c2b1a098"
    storeCommandTab(id)
    h.terminalSnapshot.mockRejectedValueOnce(new Error("offline"))
    h.terminalSnapshot.mockResolvedValue({
      exists: true,
      alive: false,
      data: "done",
      seq: 1,
    })
    render(
      <TerminalProvider>
        <Probe />
      </TerminalProvider>
    )
    await waitFor(() => expect(h.terminalSnapshot).toHaveBeenCalledTimes(1))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    expect(screen.getByTestId("exited")).toBeEmptyDOMElement()

    act(() => {
      h.ready?.()
    })
    await waitFor(() =>
      expect(screen.getByTestId("exited")).toHaveTextContent(id)
    )
    expect(h.terminalSnapshot).toHaveBeenCalledTimes(2)
  })
})

// AI QA #176: removing a project closes "its tabs and terminals". Terminals
// are shared across projects, so only those opened for its folders go.
describe("TerminalProvider closeTerminalsByFolder", () => {
  function FolderProbe() {
    const terminal = useTerminalContext()
    return (
      <div>
        <button onClick={() => terminal.createTerminal()}>New</button>
        <button onClick={() => terminal.closeTerminalsByFolder([7])}>
          Close 7
        </button>
        <button onClick={() => terminal.closeTerminalsByFolder([8])}>
          Close 8
        </button>
        <button onClick={() => terminal.closeTerminalsByFolder([99])}>
          Close 99
        </button>
        <span data-testid="tabs">
          {terminal.tabs.map((tab) => `${tab.folderId}:${tab.id}`).join(",")}
        </span>
        <span data-testid="active">{terminal.activeTabId ?? ""}</span>
        <span data-testid="open">{String(terminal.isOpen)}</span>
      </div>
    )
  }

  beforeEach(() => {
    h.terminalKill.mockClear()
    h.listeners.clear()
    h.holdSubscribe = false
    h.remoteId = null
    h.windowLabel = "main"
    sessionStorage.clear()
    window.name = ""
  })

  // Folder 7 gets one terminal, folder 8 two; the last one opened is active.
  function openTwoProjects() {
    const view = render(
      <TerminalProvider>
        <FolderProbe />
      </TerminalProvider>
    )
    h.activeFolderId = 7
    view.rerender(
      <TerminalProvider>
        <FolderProbe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    h.activeFolderId = 8
    view.rerender(
      <TerminalProvider>
        <FolderProbe />
      </TerminalProvider>
    )
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    fireEvent.click(screen.getByRole("button", { name: "New" }))
    const tabs = (screen.getByTestId("tabs").textContent ?? "")
      .split(",")
      .map((entry) => {
        const [folderId, id] = entry.split(":")
        return { folderId: Number(folderId), id }
      })
    return { view, tabs }
  }

  it("closes only that folder's terminals and kills them", () => {
    const { tabs } = openTwoProjects()
    expect(tabs.map((t) => t.folderId)).toEqual([7, 8, 8])
    const active = screen.getByTestId("active").textContent

    fireEvent.click(screen.getByRole("button", { name: "Close 7" }))

    expect(h.terminalKill).toHaveBeenCalledTimes(1)
    expect(h.terminalKill).toHaveBeenCalledWith(tabs[0].id)
    expect(screen.getByTestId("tabs").textContent).toBe(
      `8:${tabs[1].id},8:${tabs[2].id}`
    )
    // The active terminal was another project's: it stays active.
    expect(screen.getByTestId("active").textContent).toBe(active)
    expect(screen.getByTestId("open").textContent).toBe("true")
  })

  it("moves the active terminal to the first left, and folds away when none is", () => {
    const { tabs } = openTwoProjects()
    fireEvent.click(screen.getByRole("button", { name: "Close 8" }))
    expect(h.terminalKill).toHaveBeenCalledWith(tabs[1].id)
    expect(h.terminalKill).toHaveBeenCalledWith(tabs[2].id)
    expect(screen.getByTestId("tabs").textContent).toBe(`7:${tabs[0].id}`)
    expect(screen.getByTestId("active").textContent).toBe(tabs[0].id)

    fireEvent.click(screen.getByRole("button", { name: "Close 7" }))
    expect(screen.getByTestId("tabs").textContent).toBe("")
    expect(screen.getByTestId("active").textContent).toBe("")
    expect(screen.getByTestId("open").textContent).toBe("false")
  })

  it("leaves everything alone for a folder with no terminals", () => {
    openTwoProjects()
    const before = screen.getByTestId("tabs").textContent
    fireEvent.click(screen.getByRole("button", { name: "Close 99" }))
    expect(h.terminalKill).not.toHaveBeenCalled()
    expect(screen.getByTestId("tabs").textContent).toBe(before)
  })

  it("closes a deleted folder's terminals when the backend announces it", async () => {
    const { tabs } = openTwoProjects()
    await waitFor(() => expect(h.listeners.has("folder://changed")).toBe(true))
    act(() => {
      h.listeners.get("folder://changed")?.({ kind: "deleted", id: 8 })
    })
    expect(screen.getByTestId("tabs").textContent).toBe(`7:${tabs[0].id}`)
    // An upsert is not a removal.
    act(() => {
      h.listeners.get("folder://changed")?.({
        kind: "upsert",
        folder: { id: 7 },
      })
    })
    expect(screen.getByTestId("tabs").textContent).toBe(`7:${tabs[0].id}`)
  })
})
