import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { ChromeSiteEdits, ChromeSites } from "@/lib/browser/chrome-sites"

const mocks = vi.hoisted(() => ({
  chromeSites: vi.fn(),
  chromeSetSites: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}))

vi.mock("@/lib/browser/chrome-sites", async (original) => ({
  ...(await original<typeof import("@/lib/browser/chrome-sites")>()),
  chromeSites: mocks.chromeSites,
  chromeSetSites: mocks.chromeSetSites,
}))
vi.mock("sonner", () => ({ toast: mocks.toast }))

import { ChromeSitesSettings } from "./chrome-sites-settings"
import { normalizeSite } from "@/lib/browser/chrome-sites"
import enMessages from "@/i18n/messages/en.json"

const DEFAULTS = ["mail.example-mail.test", "pay.example-pay.test"]

function sites(over: Partial<ChromeSites> = {}): ChromeSites {
  return { defaults: DEFAULTS, blocked: [], allowed: [], ...over }
}

/** The backend keeping what it was given, as it answers. */
function keepWhatIsSet() {
  mocks.chromeSetSites.mockImplementation((edits: ChromeSiteEdits) =>
    Promise.resolve(sites(edits))
  )
}

async function renderRow() {
  await act(async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChromeSitesSettings />
      </NextIntlClientProvider>
    )
  })
}

async function press(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name }))
  })
}

async function typeAndAdd(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Site to keep agents off"), {
      target: { value: text },
    })
  })
  await press("Add")
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.chromeSites.mockResolvedValue(sites())
  keepWhatIsSet()
})

describe("ChromeSitesSettings", () => {
  it("asks before letting agents onto a default site, and keeps it blocked on cancel", async () => {
    await renderRow()
    await press("Default list (2)")
    await press("Allow pay.example-pay.test")

    expect(mocks.chromeSetSites).not.toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toHaveTextContent(
      "Agents will open pay.example-pay.test signed in as you"
    )

    await press("Cancel")
    expect(mocks.chromeSetSites).not.toHaveBeenCalled()
    expect(screen.queryByRole("alertdialog")).toBeNull()
  })

  it("lets go of a default site once the person confirms", async () => {
    await renderRow()
    await press("Default list (2)")
    await press("Allow pay.example-pay.test")
    // The dialog's own button: the row's is "Allow <site>".
    await press("Allow")

    expect(mocks.chromeSetSites).toHaveBeenCalledWith({
      blocked: [],
      allowed: ["pay.example-pay.test"],
    })
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(screen.getByText("Allowed from the default list")).toBeVisible()
    expect(screen.getByText("Default list (1)")).toBeVisible()
  })

  it("blocks an allowed default again without asking", async () => {
    mocks.chromeSites.mockResolvedValue(
      sites({ allowed: ["pay.example-pay.test"] })
    )
    await renderRow()
    await press("Block pay.example-pay.test again")

    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.chromeSetSites).toHaveBeenCalledWith({
      blocked: [],
      allowed: [],
    })
  })

  it("adds a site as its bare host name, and removes it without asking", async () => {
    await renderRow()
    await typeAndAdd("https://Shop.Example.test/cart?x=1")

    expect(mocks.chromeSetSites).toHaveBeenCalledWith({
      blocked: ["shop.example.test"],
      allowed: [],
    })
    expect(screen.getByText("shop.example.test")).toBeVisible()

    await press("Remove shop.example.test")
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: [],
    })
  })

  it("says what is wrong with an entry instead of sending it", async () => {
    await renderRow()
    await typeAndAdd("not a host")
    expect(screen.getByText("Not a site address")).toBeVisible()

    await typeAndAdd("www.mail.example-mail.test")
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
    await typeAndAdd("mail.example-mail.test")
    expect(screen.getByText("Already on the list")).toBeVisible()
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
  })

  it("keeps the dialog open when the change fails", async () => {
    mocks.chromeSetSites.mockRejectedValue(new Error("disk full"))
    await renderRow()
    await press("Default list (2)")
    await press("Allow mail.example-mail.test")
    await press("Allow")

    expect(mocks.toast.error).toHaveBeenCalled()
    expect(screen.getByRole("alertdialog")).toBeVisible()
  })
})

describe("normalizeSite", () => {
  it("keeps only the host name, like the backend", () => {
    expect(normalizeSite("Mail.Example.COM")).toBe("mail.example.com")
    expect(normalizeSite("http://a.example:80/")).toBe("a.example")
    expect(normalizeSite("*.intranet.example")).toBe("intranet.example")
    expect(normalizeSite("user@admin.example:8443/x")).toBe("admin.example")
    expect(normalizeSite("example.com.")).toBe("example.com")
  })

  it("rejects what has no host name", () => {
    expect(normalizeSite("")).toBeNull()
    expect(normalizeSite("*.")).toBeNull()
    expect(normalizeSite("not a host")).toBeNull()
    expect(normalizeSite("file:///etc/hosts")).toBeNull()
    expect(normalizeSite("a".repeat(300))).toBeNull()
  })
})
