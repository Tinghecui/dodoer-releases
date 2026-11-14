import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { CoworkInfo } from "@/lib/cowork/info"

const state = vi.hoisted(() => ({ info: null as CoworkInfo | null }))
vi.mock("@/lib/cowork/info", () => ({ useCoworkInfo: () => state.info }))

const account = vi.hoisted(() => ({
  openCoworkAccount: vi.fn(),
  coworkSignOut: vi.fn(),
  canSignOut: true,
  coworkCanSignOut: () => account.canSignOut,
  canOpenInDesktop: true,
  coworkCanOpenInDesktop: () => account.canOpenInDesktop,
  openCoworkInDesktop: vi.fn(),
}))
vi.mock("@/lib/cowork/account", () => account)

const toast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

const telemetry = vi.hoisted(() => ({
  on: false,
  isTelemetryOn: () => telemetry.on,
  subscribeTelemetry: () => () => {},
  sendFeedback: vi.fn(() => true),
}))
vi.mock("@/lib/telemetry", () => telemetry)

const tabs = vi.hoisted(() => ({
  state: {
    activeTabId: "t2",
    rawTabs: [
      { id: "t1", conversationId: 5, agentType: "codex" },
      { id: "t2", conversationId: 42, agentType: "claude_code" },
    ],
  },
}))
vi.mock("@/stores/tab-store", () => ({
  useTabStore: { getState: () => tabs.state },
}))

const upgrade = vi.hoisted(() => ({
  hint: null as null | { current: string; latest: string; url: string | null },
  enabledWith: [] as boolean[],
  openCoworkUpgrade: vi.fn(),
}))
vi.mock("@/lib/cowork/upgrade", () => ({
  useCoworkUpgradeHint: (enabled: boolean) => {
    upgrade.enabledWith.push(enabled)
    return enabled ? upgrade.hint : null
  },
  openCoworkUpgrade: upgrade.openCoworkUpgrade,
}))

import { CoworkAccountMenu } from "./account-menu"

function renderMenu(locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <CoworkAccountMenu />
    </NextIntlClientProvider>
  )
}

const portalInfo: CoworkInfo = {
  product: "Cowork",
  projectsRoot: "/home/cw-a/work",
  portal: true,
  updateDisabled: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  state.info = null
  upgrade.hint = null
  upgrade.enabledWith = []
  account.canSignOut = true
  account.canOpenInDesktop = true
  account.openCoworkInDesktop.mockResolvedValue(undefined)
  telemetry.on = false
  telemetry.sendFeedback.mockReturnValue(true)
})

describe("CoworkAccountMenu", () => {
  it("renders nothing outside the portal", () => {
    const { container } = renderMenu()
    expect(container).toBeEmptyDOMElement()
    state.info = { ...portalInfo, portal: false }
    const again = renderMenu()
    expect(again.container).toBeEmptyDOMElement()
  })

  it("links to the account page and signs out", async () => {
    state.info = portalInfo
    renderMenu()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "My account" })
    )
    expect(account.openCoworkAccount).toHaveBeenCalledTimes(1)

    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Sign out / switch account" })
    )
    expect(account.coworkSignOut).toHaveBeenCalledTimes(1)
  })

  it("only asks for the upgrade hint behind the portal", () => {
    renderMenu()
    expect(upgrade.enabledWith).toEqual([false])
    state.info = portalInfo
    renderMenu()
    expect(upgrade.enabledWith[upgrade.enabledWith.length - 1]).toBe(true)
  })

  it("shows nothing about upgrades without a hint", async () => {
    state.info = portalInfo
    renderMenu()
    expect(screen.queryByTestId("cowork-upgrade-dot")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    expect(await screen.findAllByRole("menuitem")).toHaveLength(3)
  })

  it("offers the portal's upgrade page when a newer cowork is out", async () => {
    state.info = portalInfo
    upgrade.hint = {
      current: "0.8.2",
      latest: "0.9.0",
      url: "https://portal.example.com/admin/upgrade",
    }
    renderMenu()
    expect(screen.getByTestId("cowork-upgrade-dot")).toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    await userEvent.click(
      await screen.findByRole("menuitem", {
        name: "Cowork 0.9.0 is available — upgrade in the portal",
      })
    )
    expect(upgrade.openCoworkUpgrade).toHaveBeenCalledWith(upgrade.hint)
  })

  it("keeps only My account in a remote desktop window", async () => {
    state.info = portalInfo
    account.canSignOut = false
    upgrade.hint = {
      current: "0.8.2",
      latest: "0.9.0",
      url: "https://portal.example.com/admin/upgrade",
    }
    account.canOpenInDesktop = false
    renderMenu()
    // No portal cookie there: the upgrade hint is not even asked for.
    expect(upgrade.enabledWith[upgrade.enabledWith.length - 1]).toBe(false)
    expect(screen.queryByTestId("cowork-upgrade-dot")).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual(["My account"])
  })

  it("opens the workspace in the desktop app from the browser", async () => {
    state.info = portalInfo
    renderMenu()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      "Open in desktop app",
      "My account",
      "Sign out / switch account",
    ])
    await userEvent.click(items[0])
    expect(account.openCoworkInDesktop).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
  })

  it("says why when the desktop link can't be had", async () => {
    state.info = portalInfo
    account.openCoworkInDesktop.mockRejectedValue(new Error("请先登录门户"))
    renderMenu("zh-CN")
    await userEvent.click(screen.getByRole("button", { name: "账户" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "在桌面 app 里打开" })
    )
    await vi.waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith("没能打开桌面 app：请先登录门户")
    )
  })

  it("takes the corner chrome's button look and opens downward from there", async () => {
    state.info = portalInfo
    render(
      <NextIntlClientProvider locale="en" messages={{}}>
        <CoworkAccountMenu className="chrome-btn" side="bottom" />
      </NextIntlClientProvider>
    )
    const trigger = screen.getByRole("button", { name: "Account" })
    expect(trigger.className).toContain("chrome-btn")
    await userEvent.click(trigger)
    const menu = await screen.findByRole("menu")
    expect(menu).toHaveAttribute("data-side", "bottom")
  })

  it("takes a problem report while telemetry is on", async () => {
    state.info = portalInfo
    telemetry.on = true
    renderMenu()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      "Open in desktop app",
      "Report a problem",
      "My account",
      "Sign out / switch account",
    ])
    await userEvent.click(items[1])
    const dialog = await screen.findByRole("dialog")
    expect(dialog).toHaveTextContent("never what the conversation says")
    const send = screen.getByRole("button", { name: "Send" })
    expect(send).toBeDisabled()
    await userEvent.type(
      screen.getByRole("textbox", { name: "Report a problem" }),
      "stuck in progress"
    )
    await userEvent.click(send)
    expect(telemetry.sendFeedback).toHaveBeenCalledWith("stuck in progress", {
      conversationId: 42,
      agent: "claude_code",
    })
    expect(toast.success).toHaveBeenCalledWith("Sent. Thank you!")
    await vi.waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    )
  })

  it("keeps the report when it could not be sent", async () => {
    state.info = portalInfo
    telemetry.on = true
    telemetry.sendFeedback.mockReturnValue(false)
    renderMenu("zh-CN")
    await userEvent.click(screen.getByRole("button", { name: "账户" }))
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "反馈问题" })
    )
    const box = await screen.findByRole("textbox", { name: "反馈问题" })
    await userEvent.type(box, "卡住了")
    await userEvent.click(screen.getByRole("button", { name: "发送" }))
    expect(toast.error).toHaveBeenCalledWith(
      "没发出去：这台服务器没有开诊断数据上报。"
    )
    expect(box).toHaveValue("卡住了")
  })

  it("offers the problem report in a remote desktop window too", async () => {
    state.info = portalInfo
    telemetry.on = true
    account.canSignOut = false
    account.canOpenInDesktop = false
    renderMenu()
    await userEvent.click(screen.getByRole("button", { name: "Account" }))
    const items = await screen.findAllByRole("menuitem")
    expect(items.map((i) => i.textContent)).toEqual([
      "Report a problem",
      "My account",
    ])
  })

  it("is translated", async () => {
    state.info = portalInfo
    renderMenu("zh-CN")
    await userEvent.click(screen.getByRole("button", { name: "账户" }))
    expect(
      await screen.findByRole("menuitem", { name: "退出 / 切换账户" })
    ).toBeInTheDocument()
  })

  it("translates the upgrade entry; without a portal url it is disabled", async () => {
    state.info = portalInfo
    upgrade.hint = { current: "0.8.2", latest: "0.9.0", url: null }
    renderMenu("zh-CN")
    await userEvent.click(screen.getByRole("button", { name: "账户" }))
    expect(
      await screen.findByRole("menuitem", {
        name: "Cowork 0.9.0 可以升级，去门户升级",
      })
    ).toHaveAttribute("aria-disabled", "true")
  })
})
