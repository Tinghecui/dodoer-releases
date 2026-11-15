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
  getSettings.mockResolvedValue({ enabled: true })
})
afterEach(() => cleanup())

describe("CrashReportSettingsSection", () => {
  it("shows the app's value, and says what is and is not sent", async () => {
    renderSection()
    const toggle = await screen.findByRole("switch", {
      name: "Send diagnostics (crashes, hangs, errors)",
    })
    expect(toggle).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText(/^On by default/)).toBeInTheDocument()
    expect(screen.getByText(/^Sent:.*install id/)).toBeInTheDocument()
    expect(
      screen.getByText(/^Not sent:.*your user name\.$/)
    ).toBeInTheDocument()
    expect(screen.getByText(/next time dodoer starts/)).toBeInTheDocument()
  })

  it("shows a switch the person turned off as off", async () => {
    getSettings.mockResolvedValue({ enabled: false })
    renderSection()
    const toggle = await screen.findByRole("switch")
    expect(toggle).toHaveAttribute("aria-checked", "false")
  })

  it("saves the choice", async () => {
    const user = userEvent.setup()
    updateSettings.mockResolvedValue({ enabled: false })
    renderSection()

    await user.click(await screen.findByRole("switch"))

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({ enabled: false })
    )
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "false")
  })

  it("puts the switch back when the save fails", async () => {
    const user = userEvent.setup()
    updateSettings.mockRejectedValue(new Error("disk full"))
    renderSection()

    await user.click(await screen.findByRole("switch"))

    await waitFor(() => expect(toastError).toHaveBeenCalled())
    expect(screen.getByRole("switch")).toHaveAttribute("aria-checked", "true")
  })

  it("is not shown outside the desktop app", async () => {
    desktop = false
    renderSection()
    await Promise.resolve()
    expect(screen.queryByRole("switch")).not.toBeInTheDocument()
    expect(getSettings).not.toHaveBeenCalled()
  })
})
