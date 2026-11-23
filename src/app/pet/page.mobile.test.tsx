import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// #1335：宠物是桌面上的浮动小窗，手机上不做。手机布局下直接打开地址，
// 显示「请在电脑上使用」，不挂载宠物窗口

const state = vi.hoisted(() => ({ mobile: true }))

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams("petId=p1"),
}))
vi.mock("@/lib/transport", () => ({ isDesktop: () => false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("./_components/PetWindow", () => ({
  PetWindow: () => <div data-testid="pet-window" />,
}))

import PetPage from "./page"
import enMessages from "@/i18n/messages/en.json"

const renderPage = () =>
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PetPage />
    </NextIntlClientProvider>
  )

beforeEach(() => {
  state.mobile = true
})

describe("宠物页在手机布局下", () => {
  it("显示请在电脑上使用，不挂载宠物窗口", async () => {
    renderPage()
    expect(await screen.findByRole("status")).toHaveTextContent(
      enMessages.DesktopOnly.message
    )
    expect(screen.queryByTestId("pet-window")).toBeNull()
  })

  it("宽屏照常", async () => {
    state.mobile = false
    renderPage()
    expect(await screen.findByTestId("pet-window")).toBeInTheDocument()
  })
})
