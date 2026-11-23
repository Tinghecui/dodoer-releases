import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

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
})
