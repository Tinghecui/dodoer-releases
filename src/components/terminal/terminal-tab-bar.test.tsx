import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

import { TerminalTabBar } from "./terminal-tab-bar"

const terminal = vi.hoisted(() => ({
  createTerminal: vi.fn(),
  closeTerminal: vi.fn(),
}))
const folder = vi.hoisted(() => ({ activeFolderId: 1 as number | null }))

vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({
    tabs: [
      { id: "t1", title: "Terminal 1", folderId: 1 },
      { id: "t2", title: "Terminal 2", folderId: 1 },
    ],
    activeTabId: "t1",
    switchTerminal: () => {},
    closeTerminal: terminal.closeTerminal,
    closeOtherTerminals: () => {},
    closeAllTerminals: () => {},
    renameTerminal: () => {},
    createTerminal: terminal.createTerminal,
    toggle: () => {},
  }),
}))
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
    folder.activeFolderId = 1
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

  it("names each tab's close button after its tab", () => {
    renderBar()
    fireEvent.click(screen.getByRole("button", { name: "Close Terminal 2" }))
    expect(terminal.closeTerminal).toHaveBeenCalledWith("t2")
    expect(
      screen.getByRole("button", { name: "Close Terminal 1" })
    ).toBeInTheDocument()
  })
})
