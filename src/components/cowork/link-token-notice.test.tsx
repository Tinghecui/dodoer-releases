import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const toast = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock("sonner", () => ({ toast }))

import { noteLinkTokenIgnored } from "@/lib/cowork/token-link"
import { LinkTokenNotice } from "./link-token-notice"

function renderNotice() {
  return render(
    <NextIntlClientProvider locale="en" messages={{}}>
      <LinkTokenNotice />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  sessionStorage.clear()
})

// #873: the login page hands the note over; the workspace raises it.
describe("LinkTokenNotice", () => {
  it("says once in the workspace that the link's token was not used", () => {
    noteLinkTokenIgnored()
    const first = renderNotice()
    expect(toast.info).toHaveBeenCalledTimes(1)
    expect(toast.info).toHaveBeenCalledWith(
      "Already signed in; the token in the link was not used."
    )
    first.unmount()
    // The note is used up: the next workspace load stays quiet.
    renderNotice()
    expect(toast.info).toHaveBeenCalledTimes(1)
  })

  it("stays quiet without a note", () => {
    renderNotice()
    expect(toast.info).not.toHaveBeenCalled()
  })
})
