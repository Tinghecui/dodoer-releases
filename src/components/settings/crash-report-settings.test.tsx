import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CrashReportSettings } from "@/lib/cowork/crash-reports"

const getSettings = vi.fn<() => Promise<CrashReportSettings>>()
const updateSettings =
  vi.fn<(s: CrashReportSettings) => Promise<CrashReportSettings>>()
const toastError = vi.fn()
let desktop = true

vi.mock("@/lib/cowork/crash-reports", () => ({
  getCrashReportSettings: () => getSettings(),
  updateCrashReportSettings: (s: CrashReportSettings) => updateSettings(s),
}))
vi.mock("@/lib/platform", () => ({ isDesktop: () => desktop }))
vi.mock("sonner", () => ({ toast: { error: (m: string) => toastError(m) } }))

import { CrashReportSettingsSection } from "./crash-report-settings"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CrashReportSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  desktop = true
  toastError.mockClear()
  getSettings.mockReset()
  updateSettings.mockReset()
  getSettings.mockResolvedValue({ enabled: false })
})
afterEach(() => cleanup())

describe("CrashReportSettingsSection", () => {
  it("is off until turned on, and says what is and is not sent", async () => {
    renderSection()
    const toggle = await screen.findByRole("switch", {
      name: "Send desktop crash and hang reports",
    })
    expect(toggle).toHaveAttribute("aria-checked", "false")
    expect(screen.getByText(/^Sent:/)).toBeInTheDocument()
    expect(
      screen.getByText(
        "Not sent: conversation content, file paths, web addresses."
      )
    ).toBeInTheDocument()
  })

  it("saves the consent", async () => {
    const user = userEvent.setup()
    updateSettings.mockResolvedValue({ enabled: true })
    renderSection()

    await user.click(await screen.findByRole("switch"))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: true })
    )
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  })

  it("puts the switch back when the save fails", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("disk full"))
    renderSection()

    await user.click(await screen.findByRole("switch"))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  })

  it("is not shown outside the desktop app", async () => {
    desktop = false
    renderSection()
    await Promise.resolve()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
    expect(getSettings).not.toHaveBeenCalled()
  })
})
