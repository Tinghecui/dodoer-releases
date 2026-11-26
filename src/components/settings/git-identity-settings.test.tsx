import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  getGitIdentity: vi.fn(),
  setGitIdentity: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

import { GitIdentitySettings } from "./git-identity-settings"
import enMessages from "@/i18n/messages/en.json"
import { getGitIdentity, setGitIdentity } from "@/lib/api"
import { toast } from "sonner"

const mockGet = vi.mocked(getGitIdentity)
const mockSet = vi.mocked(setGitIdentity)
const tIdentity = enMessages.VersionControlSettings.identity

function renderCard() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <GitIdentitySettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

// #1419：没配 Git 姓名和邮箱的机器上，在设置里填好就能提交。
describe("GitIdentitySettings", () => {
  it("saves the name and email typed in when none is set yet", async () => {
    mockGet.mockResolvedValue({ name: null, email: null })
    mockSet.mockResolvedValue({
      name: "Test Person",
      email: "person@example.com",
    })
    renderCard()

    expect(await screen.findByText(tIdentity.notSet)).toBeInTheDocument()
    const save = screen.getByRole("button", { name: "Save" })
    expect(save).toBeDisabled()

    fireEvent.change(screen.getByLabelText(tIdentity.name), {
      target: { value: " Test Person " },
    })
    fireEvent.change(screen.getByLabelText(tIdentity.email), {
      target: { value: "person@example.com" },
    })
    expect(save).toBeEnabled()
    fireEvent.click(save)

    await waitFor(() =>
      expect(mockSet).toHaveBeenCalledWith("Test Person", "person@example.com")
    )
    await waitFor(() => expect(toast.success).toHaveBeenCalled())
    expect(screen.queryByText(tIdentity.notSet)).toBeNull()
    expect(screen.getByLabelText(tIdentity.name)).toHaveValue("Test Person")
  })

  it("shows the identity git already has and keeps save off until it changes", async () => {
    mockGet.mockResolvedValue({
      name: "Test Person",
      email: "person@example.com",
    })
    renderCard()

    await waitFor(() =>
      expect(screen.getByLabelText(tIdentity.name)).toHaveValue("Test Person")
    )
    expect(screen.getByLabelText(tIdentity.email)).toHaveValue(
      "person@example.com"
    )
    expect(screen.queryByText(tIdentity.notSet)).toBeNull()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })

  it("does not save with only one of the two filled in", async () => {
    mockGet.mockResolvedValue({ name: null, email: null })
    renderCard()
    await screen.findByText(tIdentity.notSet)

    fireEvent.change(screen.getByLabelText(tIdentity.name), {
      target: { value: "Test Person" },
    })
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
    expect(mockSet).not.toHaveBeenCalled()
  })

  it("says why when the save fails and keeps what was typed", async () => {
    mockGet.mockResolvedValue({ name: null, email: null })
    mockSet.mockRejectedValue({
      code: "invalid_input",
      message: "Git email contains characters git does not allow",
    })
    renderCard()
    await screen.findByText(tIdentity.notSet)

    fireEvent.change(screen.getByLabelText(tIdentity.name), {
      target: { value: "Test Person" },
    })
    fireEvent.change(screen.getByLabelText(tIdentity.email), {
      target: { value: "<x>" },
    })
    fireEvent.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith(
        "Failed to save: Git email contains characters git does not allow"
      )
    )
    expect(screen.getByLabelText(tIdentity.email)).toHaveValue("<x>")
  })
})
