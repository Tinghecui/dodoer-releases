import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { RightEdgeChrome } from "./right-edge-chrome"
import enMessages from "@/i18n/messages/en.json"
import { useRightStatusCapsuleStore } from "@/stores/right-status-capsule-store"

const env = vi.hoisted(() => ({
  auxOpen: false,
  isConversations: true,
  compact: false,
}))
vi.mock("@/hooks/use-media-query", () => ({
  useMediaQuery: () => env.compact,
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
vi.mock("@/components/layout/status-bar", () => ({
  StatusBarRight: () => <div data-testid="status-right" />,
}))
vi.mock("@/components/cowork/account-menu", () => ({
  CoworkAccountMenu: ({ side }: { side?: string }) => (
    <div data-testid="cowork-account" data-side={side} />
  ),
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
    env.compact = false
    useRightStatusCapsuleStore.setState({ width: 0 })
  })

  it("leads the one corner capsule while the aux panel is collapsed", () => {
    renderChrome()
    const capsule = topCapsule()
    expect(capsule).not.toBeNull()
    expect(capsule?.querySelector('[data-testid="status-right"]')).toBeTruthy()
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
  it("ends with the Cowork account menu whether the aux panel is open or not", () => {
    for (const auxOpen of [false, true]) {
      env.auxOpen = auxOpen
      const view = renderChrome()
      const menu = view.getByTestId("cowork-account")
      expect(menu.parentElement?.lastElementChild).toBe(menu)
      expect(menu).toHaveAttribute("data-side", "bottom")
      // Not inside the status items (they move to the aux panel's foot).
      expect(topCapsule()?.contains(menu) ?? false).toBe(false)
      view.unmount()
    }
  })
  it("folds the status items behind one button in a narrow window", async () => {
    env.compact = true
    renderChrome()
    const capsule = topCapsule()
    expect(capsule?.querySelector('[data-testid="status-right"]')).toBeNull()
    expect(capsule?.querySelector("[data-right-chrome-slot]")).toBeTruthy()
    await userEvent.click(
      screen.getByRole("button", { name: "Commands and status" })
    )
    expect(await screen.findByTestId("status-right")).toBeInTheDocument()
  })
})
