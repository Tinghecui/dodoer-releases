import { render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The server double: every call the System page and the update provider make
// in a browser goes through here, `cowork_info` included.
const call = vi.fn()
const desktop = vi.hoisted(() => ({ value: false }))

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call, subscribe: vi.fn(async () => () => {}) }),
  // `usesTauriUpdater()` reads this one. Only the rule itself is asked with it
  // set: a rendered provider would reach for the Tauri updater plugin.
  isDesktop: () => desktop.value,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

vi.mock("@/lib/api", () => ({
  getSystemProxySettings: vi.fn(async () => ({
    enabled: false,
    proxy_url: null,
  })),
  updateSystemProxySettings: vi.fn(),
  updateSystemLanguageSettings: vi.fn(),
  getSystemAutostartSettings: vi.fn(),
  updateSystemAutostartSettings: vi.fn(),
  getCliAccessStatus: vi.fn(async () => ({
    enabled: true,
    running: true,
    endpointFile: "/data/cli/endpoint-1.json",
  })),
  setCliAccessEnabled: vi.fn(),
  listenBackupProgress: vi.fn(async () => () => {}),
  listSafetySnapshots: vi.fn(async () => []),
  exportBackupDesktop: vi.fn(),
  exportBackupWeb: vi.fn(),
  prepareBackupSourceDesktop: vi.fn(),
  prepareBackupSourceWeb: vi.fn(),
  releaseBackupSource: vi.fn(),
  scanExternalConflicts: vi.fn(),
  backupActiveAgents: vi.fn(async () => []),
  cancelBackup: vi.fn(),
  discardPendingRestore: vi.fn(),
  rollbackToSnapshot: vi.fn(),
  stageRestoreDesktop: vi.fn(),
  stageRestoreWeb: vi.fn(),
  uploadBackupWeb: vi.fn(),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), message: vi.fn() },
}))

vi.mock("@/lib/platform", () => ({
  openUrl: vi.fn(),
  isDesktop: () => false,
  isLocalDesktop: () => false,
}))

vi.mock("@/components/i18n-provider", () => ({
  useAppI18n: () => ({
    languageSettings: { mode: "system", language: "en" },
    languageSettingsLoaded: true,
    setLanguageSettings: vi.fn(),
  }),
}))

vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => children ?? null,
}))
vi.mock("remark-gfm", () => ({ default: () => undefined }))

import { updatesAreManaged } from "@/components/cowork/managed-updates"
import { UpdateProvider } from "@/components/providers/update-provider"
import { SystemNetworkSettings } from "@/components/settings/system-network-settings"
import enMessages from "@/i18n/messages/en.json"
import { resetCoworkInfoForTests, type CoworkInfo } from "@/lib/cowork/info"

const VERSION = "0.16.0"

const cowork = (updateDisabled: boolean): CoworkInfo => ({
  product: "Cowork",
  projectsRoot: null,
  portal: true,
  updateDisabled,
})

// A server on `VERSION` with nothing newer out. `coworkInfo` is what it says
// to `cowork_info`; an upstream server has no such route (501).
function server(coworkInfo: CoworkInfo | "upstream") {
  return async (endpoint: string) => {
    if (endpoint === "cowork_info") {
      if (coworkInfo === "upstream") {
        throw { code: "not_implemented", message: "Not implemented" }
      }
      return coworkInfo
    }
    if (endpoint === "check_app_update") {
      // What `CODEG_UPDATE_DISABLED` answers; never reached when the page
      // behaves, and visible as an error banner when it does not.
      if (coworkInfo !== "upstream" && coworkInfo.updateDisabled) {
        throw { code: "permission_denied", message: "Updates are disabled" }
      }
      return {
        currentVersion: VERSION,
        update: null,
        selfUpdateSupported: true,
        capability: "supervised",
        runtime: "standalone",
        restartDelayMs: 2000,
        rollbackAvailable: false,
        liveProgress: true,
      }
    }
    if (endpoint === "app_update_status") {
      return {
        currentVersion: VERSION,
        selfUpdateSupported: coworkInfo === "upstream",
        capability: "supervised",
        runtime: "standalone",
        restartDelayMs: 2000,
        rollbackAvailable: false,
        liveProgress: true,
      }
    }
    if (endpoint === "health") return { version: VERSION }
    if (endpoint === "app_update_state") return { seq: 1, status: "idle" }
    throw new Error(`unexpected endpoint: ${endpoint}`)
  }
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UpdateProvider>
        <SystemNetworkSettings />
      </UpdateProvider>
    </NextIntlClientProvider>
  )
}

const asked = (endpoint: string) =>
  call.mock.calls.some(([name]) => name === endpoint)

beforeEach(() => {
  call.mockReset()
  desktop.value = false
  // Not asked yet: each case starts like a page opened by its address.
  resetCoworkInfoForTests(undefined)
  localStorage.clear()
})

describe("System settings on a server whose updates Cowork manages", () => {
  it("leaves out the update section, version included, and never checks", async () => {
    call.mockImplementation(server(cowork(true)))

    renderPage()

    // The rest of the page is there.
    expect(
      await screen.findByRole("heading", { name: "Network Proxy" })
    ).toBeVisible()
    expect(screen.getByRole("heading", { name: "Language" })).toBeVisible()

    expect(
      screen.queryByRole("heading", { name: "Software Update" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Check for updates" })
    ).not.toBeInTheDocument()
    expect(screen.queryByText(/Current version/)).not.toBeInTheDocument()
    expect(screen.queryByText(new RegExp(VERSION))).not.toBeInTheDocument()

    // The provider has read the local status by now; give a stray check on
    // load the same chance to have gone out.
    await waitFor(() => expect(asked("app_update_status")).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(asked("check_app_update")).toBe(false)
    expect(
      screen.queryByRole("heading", { name: "Software Update" })
    ).not.toBeInTheDocument()
  })

  it("keeps the section and the check on load when Cowork leaves updates on", async () => {
    call.mockImplementation(server(cowork(false)))

    renderPage()

    expect(
      await screen.findByRole("heading", { name: "Software Update" })
    ).toBeVisible()
    expect(await screen.findByText(new RegExp(`v${VERSION}`))).toBeVisible()
    await waitFor(() => expect(asked("check_app_update")).toBe(true))
    expect(
      await screen.findByRole("button", { name: "Check for updates" })
    ).toBeVisible()
  })

  it("keeps the section and the check on load on an upstream server", async () => {
    call.mockImplementation(server("upstream"))

    renderPage()

    expect(
      await screen.findByRole("heading", { name: "Software Update" })
    ).toBeVisible()
    await waitFor(() => expect(asked("check_app_update")).toBe(true))
    expect(
      await screen.findByRole("button", { name: "Check for updates" })
    ).toBeVisible()
  })
})

describe("updatesAreManaged", () => {
  it("is only ever true in a browser on a server with updates disabled", () => {
    expect(updatesAreManaged(cowork(true))).toBe(true)
    expect(updatesAreManaged(cowork(false))).toBe(false)
    expect(updatesAreManaged(null)).toBe(false)
  })

  it("never applies to a desktop window, which updates the app itself", () => {
    desktop.value = true
    expect(updatesAreManaged(cowork(true))).toBe(false)
  })
})
