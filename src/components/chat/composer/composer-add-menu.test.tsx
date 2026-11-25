import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const h = vi.hoisted(() => ({ isMobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => h.isMobile }))

import { ComposerAddMenu } from "./composer-add-menu"
import type { ComposerShortcuts } from "./use-composer-shortcuts"

const shortcuts = {
  quickMessages: [],
  quickMessagesLoading: false,
  refreshQuickMessages: vi.fn(),
  insertQuickMessage: vi.fn(),
  insertSlashCommand: vi.fn(),
  experts: [],
  science: [],
  officeActions: [],
  skillManagementSupported: false,
  isSkillLocked: () => false,
  expertLabel: () => "",
  scienceLabel: () => "",
  officeLabel: () => "",
  getExpertIcon: (() => null) as unknown as ComposerShortcuts["getExpertIcon"],
  getScienceIcon: (() =>
    null) as unknown as ComposerShortcuts["getScienceIcon"],
  insertExpert: vi.fn(),
  insertScience: vi.fn(),
  insertOffice: vi.fn(),
} satisfies ComposerShortcuts

describe("ComposerAddMenu", () => {
  // 加号菜单从输入框往上弹：手机上键盘弹起时不超出键盘以上的可见区域。
  it("caps the menu by the visible area above the keyboard", async () => {
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposerAddMenu shortcuts={shortcuts} slashCommands={[]} />
      </NextIntlClientProvider>
    )
    await user.click(
      screen.getByLabelText(enMessages.Folder.chat.messageInput.addActions)
    )
    const menu = await screen.findByRole("menu")
    expect(menu.className).toContain(
      "max-h-[min(var(--radix-dropdown-menu-content-available-height),var(--app-vvh,100dvh))]"
    )
  })

  describe("submenus", () => {
    const m = enMessages.Folder.chat.messageInput
    const commands = [
      { name: "review", description: "Review the current diff" },
      { name: "deploy", description: "Ship it" },
    ]

    beforeEach(() => {
      h.isMobile = false
    })

    async function openMenu() {
      const user = userEvent.setup()
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <ComposerAddMenu shortcuts={shortcuts} slashCommands={commands} />
        </NextIntlClientProvider>
      )
      await user.click(screen.getByLabelText(m.addActions))
      await screen.findByRole("menu")
      return user
    }

    // 手机屏幕太窄，侧弹的子菜单会超出屏幕（#1351）：手机上主菜单原地换成
    // 子菜单的列表，顶上带「返回」。
    it("on mobile swaps the menu to the submenu list in place, with Back", async () => {
      h.isMobile = true
      const user = await openMenu()
      await user.click(screen.getByRole("menuitem", { name: m.slashCommands }))

      expect(
        document.querySelector('[data-slot="dropdown-menu-sub-content"]')
      ).toBeNull()
      expect(screen.getAllByRole("menu")).toHaveLength(1)
      expect(screen.getByRole("searchbox")).toBeTruthy()
      expect(screen.getByText("/review")).toBeTruthy()
      // 主列表的其他项不在了。
      expect(
        screen.queryByRole("menuitem", { name: m.quickMessages })
      ).toBeNull()

      await user.click(screen.getByRole("menuitem", { name: /Back/ }))
      expect(screen.getByRole("menu")).toBeTruthy()
      expect(screen.queryByRole("searchbox")).toBeNull()
      expect(
        screen.getByRole("menuitem", { name: m.quickMessages })
      ).toBeTruthy()
    })

    it("on desktop keeps the side-popping submenu", async () => {
      const user = await openMenu()
      await user.click(screen.getByRole("menuitem", { name: m.slashCommands }))
      expect(await screen.findByRole("searchbox")).toBeTruthy()
      expect(
        document.querySelector('[data-slot="dropdown-menu-sub-content"]')
      ).not.toBeNull()
      expect(screen.queryByRole("menuitem", { name: /Back/ })).toBeNull()
    })
  })
})
