import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { RightEdgeChrome } from "./right-edge-chrome"
import enMessages from "@/i18n/messages/en.json"
import { useRightStatusCapsuleStore } from "@/stores/right-status-capsule-store"

const env = vi.hoisted(() => ({
  auxOpen: false,
  isConversations: true,
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ isOpen: env.auxOpen, toggle: () => {} }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ isConversations: env.isConversations }),
}))
vi.mock("@/contexts/terminal-context", () => ({
  useTerminalContext: () => ({ isOpen: false, toggle: () => {} }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: { id: 1 } }),
}))
vi.mock("@/hooks/use-is-active-chat-mode", () => ({
  useIsActiveChatMode: () => false,
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => true }))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({ shortcuts: {} }),
}))
vi.mock("@/lib/keyboard-shortcuts", () => ({ formatShortcutLabel: () => "" }))
vi.mock("@/lib/api", () => ({ openSettingsWindow: vi.fn() }))
vi.mock("@/components/files/file-panel-toggle", () => ({
  FilePanelToggle: () => null,
}))
vi.mock("@/components/workbench/workbench-content", () => ({
  WorkbenchRouteChromeActions: () => null,
}))
vi.mock("@/components/cowork/status-indicator", () => ({
  StatusIndicator: () => <button data-testid="status-indicator" />,
}))
vi.mock("@/components/cowork/account-menu", () => ({
  CoworkAccountMenu: () => <div data-testid="cowork-account" />,
}))

function renderChrome() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RightEdgeChrome />
    </NextIntlClientProvider>
  )
}

const topCapsule = () =>
  document.querySelector<HTMLElement>('[data-status-capsule="right"]')

describe("RightEdgeChrome status capsule", () => {
  beforeEach(() => {
    env.auxOpen = false
    env.isConversations = true
    useRightStatusCapsuleStore.setState({ width: 0 })
  })

  it("leads the one corner capsule while the aux panel is collapsed", () => {
    renderChrome()
    const capsule = topCapsule()
    expect(capsule).not.toBeNull()
    expect(
      capsule?.querySelector('[data-testid="status-indicator"]')
    ).toBeTruthy()
    const corner = document.querySelector("[data-right-chrome-capsule]")
    expect(corner?.firstElementChild).toBe(capsule)
    expect(corner?.className).toContain("lg-raised")
    expect(capsule?.querySelector("[data-right-chrome-slot]")).toBeTruthy()
  })

  it("is up there on a full-page route too", () => {
    env.auxOpen = true
    env.isConversations = false
    renderChrome()
    expect(topCapsule()).not.toBeNull()
  })

  it("leaves the top to the aux panel's foot while that panel is open", () => {
    env.auxOpen = true
    renderChrome()
    expect(topCapsule()).toBeNull()
  })

  it("reports its width for the strips' reserve, and 0 once it goes", () => {
    const rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({ width: 132.4 } as DOMRect)
    const view = renderChrome()
    expect(useRightStatusCapsuleStore.getState().width).toBe(132)
    view.unmount()
    expect(useRightStatusCapsuleStore.getState().width).toBe(0)
    rect.mockRestore()
  })
  it("leaves the account menu to the sidebar foot", () => {
    for (const auxOpen of [false, true]) {
      env.auxOpen = auxOpen
      const view = renderChrome()
      expect(view.queryByTestId("cowork-account")).toBeNull()
      view.unmount()
    }
  })
})
