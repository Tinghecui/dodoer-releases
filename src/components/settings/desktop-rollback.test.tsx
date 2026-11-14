import { render, screen, fireEvent } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { UpdateContextValue } from "@/components/providers/update-provider"
import type { AppRollbackTarget, AppUpdateState } from "@/lib/updater"

// Drive the row straight off the context value; the provider is tested on its
// own.
let ctx: Partial<UpdateContextValue> | null = null
vi.mock("@/components/providers/update-provider", () => ({
  useAppUpdate: () => ctx,
}))

let tauriUpdater = true
const getAppRollbackTarget = vi.fn<() => Promise<AppRollbackTarget | null>>()
vi.mock("@/lib/updater", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/updater")>()),
  usesTauriUpdater: () => tauriUpdater,
  getAppRollbackTarget: () => getAppRollbackTarget(),
}))

import { DesktopRollback } from "./desktop-rollback"
import enMessages from "@/i18n/messages/en.json"

const startRollback = vi.fn<(version: string) => Promise<void>>(async () => {})

function setCtx(
  state: AppUpdateState,
  overrides?: Partial<UpdateContextValue>
) {
  ctx = {
    state,
    hydrated: true,
    isBusy: false,
    currentVersion: "1.6.1",
    startRollback,
    ...overrides,
  }
}

function renderRow() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <DesktopRollback />
    </NextIntlClientProvider>
  )
}

const target = (unknownMigrations: string[] = []): AppRollbackTarget => ({
  version: "1.6.0",
  tag: "v1.6.0",
  date: "2026-11-14T14:10:43Z",
  unknownMigrations,
})

beforeEach(() => {
  tauriUpdater = true
  getAppRollbackTarget.mockReset()
  startRollback.mockClear()
  setCtx({ seq: 1, status: "idle" })
})

describe("DesktopRollback", () => {
  it("is not shown outside the desktop app", () => {
    tauriUpdater = false
    renderRow()
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull()
  })

  it("is not shown while an update is under way", () => {
    setCtx({ seq: 2, status: "downloading", downloaded: 10 })
    renderRow()
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull()
  })

  it("is not shown on a prerelease build", () => {
    setCtx({ seq: 1, status: "idle" }, { currentVersion: "1.6.1-jenny.2" })
    renderRow()
    expect(screen.queryByRole("button", { name: "Roll back" })).toBeNull()
  })

  it("looks the previous release up and rolls back to it", async () => {
    let resolve: (t: AppRollbackTarget | null) => void = () => {}
    getAppRollbackTarget.mockReturnValue(
      new Promise((r) => {
        resolve = r
      })
    )
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }))
    expect(
      await screen.findByText("Looking up the previous version…")
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Roll back to v/ })).toBeNull()

    resolve(target())
    expect(await screen.findByText("Roll back to v1.6.0?")).toBeTruthy()
    fireEvent.click(screen.getByRole("button", { name: "Roll back to v1.6.0" }))
    expect(startRollback).toHaveBeenCalledWith("1.6.0")
  })

  it("does not offer a release that cannot open the database", async () => {
    getAppRollbackTarget.mockResolvedValue(
      target(["m20261114_000001_something_new"])
    )
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }))
    expect(
      await screen.findByText(/v1\.6\.1 changed this app's database/)
    ).toBeTruthy()
    expect(screen.queryByRole("button", { name: /Roll back to v/ })).toBeNull()
    expect(startRollback).not.toHaveBeenCalled()
  })

  it("says so when there is no older release", async () => {
    getAppRollbackTarget.mockResolvedValue(null)
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }))
    expect(
      await screen.findByText(
        "There is no release older than v1.6.1 to roll back to."
      )
    ).toBeTruthy()
  })

  it("shows why the lookup failed", async () => {
    getAppRollbackTarget.mockRejectedValue(
      new Error("GitHub returned status 403 Forbidden")
    )
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Roll back" }))
    expect(
      await screen.findByText(
        "Could not look up the previous version: GitHub returned status 403 Forbidden"
      )
    ).toBeTruthy()
  })
})
