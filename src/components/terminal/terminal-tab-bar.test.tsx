import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import { TerminalTabBar } from "./terminal-tab-bar"

const terminal = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  closeTerminal: vi.fn(),
  closeOtherTerminals: vi.fn(),
  closeAllTerminals: vi.fn(),
}))
const busy = vi.hoisted(() => ({
  terminalIsBusy: vi.fn<(id: string) => Promise<boolean | null>>(),
}))
const folder = vi.hoisted(() => ({ activeFolderId: 1 as number | null }))
const shown = vi.hoisted(() => ({
  visibleTabs: null as null | { id: string; title: string; folderId: number }[],
}))

const allTabs = [
  { id: "t1", title: "Terminal 1", folderId: 1 },
  { id: "t2", title: "Terminal 2", folderId: 1 },
]

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    tabs: allTabs,
    visibleTabs: shown.visibleTabs ?? allTabs,
    activeTabId: "t1",
    switchTerminal: () => {},
    closeTerminal: terminal.closeTerminal,
    closeOtherTerminals: terminal.closeOtherTerminals,
    closeAllTerminals: terminal.closeAllTerminals,
    renameTerminal: () => {},
    createTerminal: terminal.createTerminal,
    toggle: () => {},
  }),
}))
vi.mock("@/lib/api", () => ({ terminalIsBusy: busy.terminalIsBusy }))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolderId: folder.activeFolderId }),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (select: (s: { folders: unknown[] }) => unknown) =>
    select({ folders: [{ id: 1, name: "demo" }] }),
}))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: { toggle_terminal: "mod+j" } }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
// The folder's command menu is its own component with its own data.
vi.mock("@/components/layout/command-dropdown", () => ({
  CommandDropdown: () => null,
}))

function renderBar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TerminalTabBar />
    </NextIntlClientProvider>
  )
}

// Cowork: the tab bar's icon-only buttons had no accessible name, so a reader
// heard "button" and the AI QA tester could only click them by position.
describe("TerminalTabBar accessible names", () => {
  beforeEach(() => {
    terminal.createTerminal.mockClear()
    terminal.closeTerminal.mockClear()
    busy.terminalIsBusy.mockReset()
    busy.terminalIsBusy.mockResolvedValue(false)
    folder.activeFolderId = 1
    shown.visibleTabs = null
  })

  it("names the new-terminal button", () => {
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "New Terminal" }))
    expect(terminal.createTerminal).toHaveBeenCalledTimes(1)
  })

  it("keeps the name while the button is disabled without a folder", () => {
    folder.activeFolderId = null
    renderBar()
    expect(screen.getByRole("button", { name: "New Terminal" })).toBeDisabled()
  })

  it("names each tab's close button after its tab", async () => {
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }))
    await waitFor(() =>
      expect(terminal.closeTerminal).toHaveBeenCalledWith("t2")
    )
    expect(
      screen.getByRole("button", { name: "Close Terminal 1" })
    ).toBeInTheDocument()
  })
})

// #787：跟随开着时只列当前项目的（和全局的）终端，别的项目的不进标签栏。
describe("TerminalTabBar per-project tabs", () => {
  beforeEach(() => {
    shown.visibleTabs = null
  })

  it("renders only the visible tabs", () => {
    shown.visibleTabs = [{ id: "t2", title: "Terminal 2", folderId: 1 }]
    renderBar()
    expect(
      screen.getByRole("button", { name: "Close Terminal 2" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Close Terminal 1" })
    ).not.toBeInTheDocument()
  })
})

// #1136：终端里还有程序在跑时，关闭前先确认；空闲的照旧一点就关。
describe("TerminalTabBar close confirmation", () => {
  beforeEach(() => {
    shown.visibleTabs = null
    terminal.closeTerminal.mockClear()
    terminal.closeOtherTerminals.mockClear()
    terminal.closeAllTerminals.mockClear()
    busy.terminalIsBusy.mockReset()
  })

  it("asks before closing a terminal with a running program", async () => {
    busy.terminalIsBusy.mockImplementation(async (id) => id === "t2")
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent(
      "A program is still running in the terminal. Closing it will end it."
    )
    expect(busy.terminalIsBusy).toHaveBeenCalledWith("t2")
    expect(terminal.closeTerminal).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    expect(terminal.closeTerminal).not.toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "Close Terminal 2" })
    ).toBeInTheDocument()
  })

  it("closes it once the user confirms", async () => {
    busy.terminalIsBusy.mockResolvedValue(true)
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }))
    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(terminal.closeTerminal).toHaveBeenCalledWith("t2")
    )
    expect(terminal.closeTerminal).toHaveBeenCalledTimes(1)
  })

  it("closes an idle terminal without asking", async () => {
    busy.terminalIsBusy.mockResolvedValue(false)
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }))
    await waitFor(() =>
      expect(terminal.closeTerminal).toHaveBeenCalledWith("t1")
    )
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("closes without asking when the check can't tell or fails", async () => {
    busy.terminalIsBusy.mockResolvedValueOnce(null)
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 1" }))
    await waitFor(() =>
      expect(terminal.closeTerminal).toHaveBeenCalledWith("t1")
    )

    busy.terminalIsBusy.mockRejectedValueOnce(new Error("offline"))
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }))
    await waitFor(() =>
      expect(terminal.closeTerminal).toHaveBeenCalledWith("t2")
    )
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  it("asks once for Close Others, naming the busy terminals", async () => {
    busy.terminalIsBusy.mockImplementation(async (id) => id === "t2")
    renderBar()
    fireEvent.contextMenu(screen.getByText("Terminal 1"))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Close Others" })
    )

    const dialog = await screen.findByRole("alertdialog")
    expect(dialog).toHaveTextContent("Terminal 2")
    expect(busy.terminalIsBusy).toHaveBeenCalledWith("t2")
    expect(busy.terminalIsBusy).not.toHaveBeenCalledWith("t1")
    expect(terminal.closeOtherTerminals).not.toHaveBeenCalled()

    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() =>
      expect(terminal.closeOtherTerminals).toHaveBeenCalledWith("t1")
    )
  })

  it("closes all without asking when nothing is running", async () => {
    busy.terminalIsBusy.mockResolvedValue(false)
    renderBar()
    fireEvent.contextMenu(screen.getByText("Terminal 1"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close All" }))
    await waitFor(() =>
      expect(terminal.closeAllTerminals).toHaveBeenCalledTimes(1)
    )
    expect(busy.terminalIsBusy).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
  })

  // 审查员指出：查询还没回来时新建了终端，「关闭所有」不能把这个没查过、
  // 没列进确认的终端也关掉。
  it("Close All leaves a terminal opened while the check was pending", async () => {
    let settle: (busy: boolean) => void = () => {}
    busy.terminalIsBusy.mockImplementation(
      (id) =>
        new Promise((resolve) => {
          if (id === "t2") settle = resolve
          else resolve(false)
        })
    )
    const view = renderBar()
    fireEvent.contextMenu(screen.getByText("Terminal 1"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Close All" }))
    await waitFor(() => expect(busy.terminalIsBusy).toHaveBeenCalledTimes(2))

    shown.visibleTabs = [
      ...allTabs,
      { id: "t3", title: "Terminal 3", folderId: 1 },
    ]
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TerminalTabBar />
      </NextIntlClientProvider>
    )
    settle(true)

    const dialog = await screen.findByRole("alertdialog")
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }))
    await waitFor(() => expect(terminal.closeTerminal).toHaveBeenCalledTimes(2))
    expect(terminal.closeTerminal).toHaveBeenCalledWith("t1")
    expect(terminal.closeTerminal).toHaveBeenCalledWith("t2")
    expect(terminal.closeTerminal).not.toHaveBeenCalledWith("t3")
    expect(terminal.closeAllTerminals).not.toHaveBeenCalled()
  })

  it("Close Others leaves a terminal opened while the check was pending", async () => {
    let settle: (busy: boolean) => void = () => {}
    busy.terminalIsBusy.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve
        })
    )
    const view = renderBar()
    fireEvent.contextMenu(screen.getByText("Terminal 1"))
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Close Others" })
    )
    await waitFor(() => expect(busy.terminalIsBusy).toHaveBeenCalledTimes(1))

    shown.visibleTabs = [
      ...allTabs,
      { id: "t3", title: "Terminal 3", folderId: 1 },
    ]
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <TerminalTabBar />
      </NextIntlClientProvider>
    )
    settle(false)

    await waitFor(() =>
      expect(terminal.closeTerminal).toHaveBeenCalledWith("t2")
    )
    expect(terminal.closeTerminal).toHaveBeenCalledTimes(1)
    expect(terminal.closeOtherTerminals).not.toHaveBeenCalled()
  })
})
