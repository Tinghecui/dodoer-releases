import { act, fireEvent, render, screen, within } from "@testing-library/react"
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

const GROUPS = [
  { id: "mail", sites: ["mail.example-mail.test", "inbox.example-mail.test"] },
  { id: "accounts", sites: ["vault.example-pw.test"] },
  { id: "payments", sites: ["pay.example-pay.test"] },
  { id: "banks", sites: ["one.example-bank.test", "two.example-bank.test"] },
  { id: "exchanges", sites: ["coins.example-coin.test"] },
]
const DEFAULTS = GROUPS.flatMap((group) => group.sites)

function sites(over: Partial<ChromeSites> = {}): ChromeSites {
  return {
    defaults: DEFAULTS,
    blocked: [],
    allowed: [],
    paused: false,
    groups: GROUPS,
    ...over,
  }
}

/** The backend keeping what it was given, as it answers: the pause stays as
 *  it was when the call leaves it out. */
function keepWhatIsSet(start: ChromeSites = sites()) {
  let kept = start
  mocks.chromeSites.mockResolvedValue(kept)
  mocks.chromeSetSites.mockImplementation((edits: ChromeSiteEdits) => {
    kept = {
      ...kept,
      blocked: edits.blocked,
      allowed: edits.allowed,
      paused: edits.paused ?? kept.paused,
    }
    return Promise.resolve(kept)
  })
}

async function renderRow() {
  let view: ReturnType<typeof render> | undefined
  await act(async () => {
    view = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChromeSitesSettings />
      </NextIntlClientProvider>
    )
  })
  return view!
}

async function click(element: HTMLElement) {
  await act(async () => {
    fireEvent.click(element)
  })
}

function group(name: string) {
  return within(screen.getByRole("region", { name }))
}

async function typeAndAdd(text: string) {
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Site to keep agents off"), {
      target: { value: text },
    })
  })
  await click(screen.getByRole("button", { name: "Add" }))
}

beforeEach(() => {
  vi.clearAllMocks()
  keepWhatIsSet()
})

describe("ChromeSitesSettings", () => {
  it("shows the default list in its five groups, mail and accounts open", async () => {
    await renderRow()

    expect(group("Mail").getByText("2 sites")).toBeVisible()
    expect(group("Passwords and accounts").getByText("1 site")).toBeVisible()
    expect(group("Payments").getByText("1 site")).toBeVisible()
    expect(group("Banks").getByText("2 sites")).toBeVisible()
    expect(group("Exchanges").getByText("1 site")).toBeVisible()
    expect(group("Added by you").getByText("0 sites")).toBeVisible()

    expect(
      screen.getByRole("button", { name: "mail.example-mail.test" })
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "vault.example-pw.test" })
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "one.example-bank.test" })
    ).toBeNull()
    expect(screen.queryByLabelText("Site to keep agents off")).toBeNull()

    const banks = group("Banks").getByRole("button", { expanded: false })
    await click(banks)
    expect(
      screen.getByRole("button", { name: "one.example-bank.test" })
    ).toBeVisible()
    await click(banks)
    expect(
      screen.queryByRole("button", { name: "one.example-bank.test" })
    ).toBeNull()

    // The old three blocks are gone.
    expect(screen.queryByText("Also keep agents off")).toBeNull()
    expect(screen.queryByText("Allowed from the default list")).toBeNull()
    expect(screen.queryByText(/^Default list/)).toBeNull()
  })

  it("lets a site go with one click and blocks it again with the next, never asking", async () => {
    await renderRow()
    const chip = screen.getByRole("button", { name: "inbox.example-mail.test" })
    expect(chip).toHaveAttribute("aria-pressed", "true")

    await click(chip)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: ["inbox.example-mail.test"],
    })
    const allowed = screen.getByRole("button", {
      name: "inbox.example-mail.test",
    })
    expect(allowed).toHaveAttribute("aria-pressed", "false")
    expect(allowed.className).toContain("border-dashed")
    expect(allowed.className).toContain("line-through")
    expect(group("Mail").getByText("1 allowed")).toBeVisible()

    await click(allowed)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: [],
    })
    expect(
      screen.getByRole("button", { name: "inbox.example-mail.test" })
    ).toHaveAttribute("aria-pressed", "true")
  })

  it("lets a whole group go, and blocks it all again, with one call each", async () => {
    keepWhatIsSet(sites({ allowed: ["one.example-bank.test"] }))
    await renderRow()
    const banks = group("Banks")
    expect(banks.getByText("1 allowed")).toBeVisible()
    // Only part of the group let go: still blocking.
    const toggle = banks.getByRole("switch", { name: "Block Banks" })
    expect(toggle).toHaveAttribute("aria-checked", "true")

    await click(toggle)
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: ["one.example-bank.test", "two.example-bank.test"],
    })
    expect(group("Banks").getByText("All allowed")).toBeVisible()
    expect(
      group("Banks").getByRole("switch", { name: "Block Banks" })
    ).toHaveAttribute("aria-checked", "false")

    await click(group("Banks").getByRole("switch", { name: "Block Banks" }))
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(2)
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: [],
    })
    expect(
      group("Banks").getByRole("switch", { name: "Block Banks" })
    ).toHaveAttribute("aria-checked", "true")
  })

  it("adds a site to the person's own group as its bare host name, and removes it", async () => {
    await renderRow()
    await click(group("Added by you").getByRole("button", { expanded: false }))
    await typeAndAdd("https://Shop.Example.test/cart?x=1")

    expect(mocks.chromeSetSites).toHaveBeenCalledWith({
      blocked: ["shop.example.test"],
      allowed: [],
    })
    expect(group("Added by you").getByText("1 site")).toBeVisible()
    expect(screen.getByText("shop.example.test")).toBeVisible()

    await click(
      screen.getByRole("button", { name: "Remove shop.example.test" })
    )
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: [],
    })
    expect(screen.queryByText("shop.example.test")).toBeNull()
  })

  it("says what is wrong with an entry instead of sending it", async () => {
    await renderRow()
    await click(group("Added by you").getByRole("button", { expanded: false }))
    await typeAndAdd("not a host")
    expect(screen.getByText("Not a site address")).toBeVisible()

    await typeAndAdd("www.mail.example-mail.test")
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
    await typeAndAdd("mail.example-mail.test")
    expect(screen.getByText("Already on the list")).toBeVisible()
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
  })

  it("pauses the list with the switch, greys it out, and brings it back as it was", async () => {
    keepWhatIsSet(sites({ allowed: ["pay.example-pay.test"] }))
    await renderRow()
    const master = screen.getByRole("switch", { name: "Block sensitive sites" })
    expect(master).toHaveAttribute("aria-checked", "true")
    expect(screen.getByText("Blocking")).toBeVisible()
    expect(screen.queryByText(/^Blocking paused/)).toBeNull()

    await click(master)
    expect(screen.queryByRole("alertdialog")).toBeNull()
    expect(mocks.chromeSetSites).toHaveBeenCalledTimes(1)
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: ["pay.example-pay.test"],
      paused: true,
    })
    expect(screen.getByText("Paused")).toBeVisible()
    expect(screen.getByText(/^Blocking paused/)).toBeVisible()
    expect(
      screen.getByRole("button", { name: "mail.example-mail.test" })
    ).toBeDisabled()
    expect(
      group("Mail").getByRole("switch", { name: "Block Mail" })
    ).toBeDisabled()

    await click(screen.getByRole("switch", { name: "Block sensitive sites" }))
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: ["pay.example-pay.test"],
      paused: false,
    })
    expect(screen.queryByText(/^Blocking paused/)).toBeNull()
    expect(screen.getByText("Blocking")).toBeVisible()
    expect(
      screen.getByRole("button", { name: "mail.example-mail.test" })
    ).toBeEnabled()
    expect(group("Payments").getByText("All allowed")).toBeVisible()
  })

  it("shows an older app's list as one default group, with no pause switch", async () => {
    keepWhatIsSet({
      defaults: ["mail.example-mail.test", "pay.example-pay.test"],
      blocked: [],
      allowed: ["pay.example-pay.test"],
    })
    await renderRow()

    expect(
      screen.queryByRole("switch", { name: "Block sensitive sites" })
    ).toBeNull()
    expect(screen.queryByRole("region", { name: "Mail" })).toBeNull()
    const defaults = group("Default list")
    expect(defaults.getByText("2 sites")).toBeVisible()
    await click(defaults.getByRole("button", { expanded: false }))
    expect(
      screen.getByRole("button", { name: "pay.example-pay.test" })
    ).toHaveAttribute("aria-pressed", "false")

    await click(screen.getByRole("button", { name: "mail.example-mail.test" }))
    // No pause sent to an app that knows nothing of it.
    expect(mocks.chromeSetSites).toHaveBeenLastCalledWith({
      blocked: [],
      allowed: ["pay.example-pay.test", "mail.example-mail.test"],
    })
    expect(mocks.chromeSetSites.mock.lastCall?.[0]).not.toHaveProperty("paused")
  })

  it("keeps the row to a fixed width", async () => {
    const view = await renderRow()
    expect(view.container.querySelector(".max-w-2xl")).not.toBeNull()
  })

  it("tells the person when a change fails", async () => {
    mocks.chromeSetSites.mockRejectedValue(new Error("disk full"))
    await renderRow()
    await click(screen.getByRole("button", { name: "mail.example-mail.test" }))

    expect(mocks.toast.error).toHaveBeenCalled()
    expect(
      screen.getByRole("button", { name: "mail.example-mail.test" })
    ).toHaveAttribute("aria-pressed", "true")
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
