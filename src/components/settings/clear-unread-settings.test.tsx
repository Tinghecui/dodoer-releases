import { cleanup, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const clearAll = vi.fn()
const toastSuccess = vi.fn()

vi.mock("@/stores/conversation-seen-store", () => ({
  markAllConversationsAccepted: () => clearAll(),
}))
vi.mock("sonner", () => ({
  toast: { success: (m: string) => toastSuccess(m) },
}))

import { ClearUnreadSettingsSection } from "./clear-unread-settings"

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ClearUnreadSettingsSection />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  clearAll.mockReset()
  toastSuccess.mockReset()
})
afterEach(() => cleanup())

describe("ClearUnreadSettingsSection", () => {
  it("asks first and keeps unread when cancelled", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getByRole("button", { name: "Clear unread" }))
    expect(await screen.findByText("Clear all unread?")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByText("Clear all unread?")).not.toBeInTheDocument()
    )
    expect(clearAll).not.toHaveBeenCalled()
    expect(toastSuccess).not.toHaveBeenCalled()
  })

  it("clears every unread conversation after confirming", async () => {
    const user = userEvent.setup()
    renderSection()
    await user.click(screen.getByRole("button", { name: "Clear unread" }))
    await user.click(await screen.findByRole("button", { name: "Clear" }))
    expect(clearAll).toHaveBeenCalledTimes(1)
    expect(toastSuccess).toHaveBeenCalledWith(
      "All unread conversations are now marked as read"
    )
  })
})
