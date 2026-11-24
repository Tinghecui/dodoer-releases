import {
  render,
  screen,
  act,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const call = vi.fn()
// Capture the provider's app_update_state handler so tests can push live
// lifecycle transitions.
//
// Route by event name, exactly as the real transport does. A double that
// captured every subscription into this one slot would hand `liveHandler` to
// whichever descendant of this page happened to subscribe LAST — the page
// embeds other sections, and one of them listening for its own events would
// silently take over the lifecycle handle. The push below would then land on
// a stranger, the update state would never advance, and the failure would
// surface as an unrelated assertion about the UI.
let liveHandler: ((s: unknown) => void) | null = null
const subscribe = vi.fn(
  async (event: string, handler: (s: unknown) => void) => {
    if (event === "app_update_state") liveHandler = handler
    return () => {}
  }
)

// The doubles below are plain codeg servers: `cowork_info` gets the upstream
// 501, so the page knows updates are not Cowork's to manage. An unread
// `cowork_info` would keep the update section hidden (managed-updates.tsx).
const callServer = (endpoint: string, args?: unknown) =>
  endpoint === "cowork_info"
    ? Promise.reject({ code: "not_implemented", message: "Not implemented" })
    : call(endpoint, args)

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: callServer, subscribe }),
  isDesktop: () => false,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

vi.mock("@/lib/api", () => ({
  getSystemProxySettings: vi.fn(),
  updateSystemProxySettings: vi.fn(),
  updateSystemLanguageSettings: vi.fn(),
  getSystemAutostartSettings: vi.fn(),
  updateSystemAutostartSettings: vi.fn(),
  // <CliAccessSettings/> reads the command-line access switch on mount.
  getCliAccessStatus: vi.fn(async () => ({
    enabled: true,
    running: true,
    endpointFile: "/data/cli/endpoint-1.json",
  })),
  setCliAccessEnabled: vi.fn(),
  // The System page now embeds <BackupSettings/>, which subscribes to backup
  // progress on mount and imports the backup API surface; stub it all.
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

// Launch at login is gated on a LOCAL desktop shell. Model the two axes
// separately rather than as one "is desktop" flag, so a case can pin the gate
// itself: a remote-workspace window IS a desktop shell, and asking it about
// login items would ask the wrong machine — the regression a single flag
// cannot catch. Both default to the web build (section hidden).
//
// The transport double above deliberately keeps its own `isDesktop` at false
// whatever these say: `usesTauriUpdater()` reads it from there, and a true
// would send the update provider into the Tauri updater plugin, which does not
// exist under jsdom. Nothing in the section under test consults it.
let desktopShell = false
let remoteWorkspace = false
vi.mock("@/lib/platform", () => ({
  openUrl: vi.fn(),
  isDesktop: () => desktopShell,
  isLocalDesktop: () => desktopShell && !remoteWorkspace,
}))

// #1335：手机布局（只看宽度，桌面版窗口不算）
const phone = vi.hoisted(() => ({ mobile: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => phone.mobile }))

vi.mock("@/components/i18n-provider", () => ({
  useAppI18n: () => ({
    languageSettings: { mode: "system", language: "en" },
    languageSettingsLoaded: true,
    setLanguageSettings: vi.fn(),
  }),
}))

// Keep the test hermetic from the markdown ESM stack (only rendered when an
// update is available, which it isn't here).
vi.mock("react-markdown", () => ({
  default: ({ children }: { children?: string }) => children ?? null,
}))
vi.mock("remark-gfm", () => ({ default: () => undefined }))

// The System page embeds the config-sync panel (data & sync card), which reads
// its own settings over the transport on mount. These tests answer none of
// those routes, and since that panel reports a failed read ("Load failed: …")
// instead of swallowing it, its banner landed whenever the rejection beat an
// assertion here — the `/Load failed/` checks are about the proxy card. The
// panel is pinned by `config-sync-settings.test.tsx`.
vi.mock("./config-sync-settings", () => ({
  ConfigSyncSettings: () => null,
}))

import { SystemNetworkSettings } from "./system-network-settings"
import { UpdateProvider } from "@/components/providers/update-provider"
import arMessages from "@/i18n/messages/ar.json"
import deMessages from "@/i18n/messages/de.json"
import enMessages from "@/i18n/messages/en.json"
import esMessages from "@/i18n/messages/es.json"
import frMessages from "@/i18n/messages/fr.json"
import jaMessages from "@/i18n/messages/ja.json"
import koMessages from "@/i18n/messages/ko.json"
import ptMessages from "@/i18n/messages/pt.json"
import zhCNMessages from "@/i18n/messages/zh-CN.json"
import zhTWMessages from "@/i18n/messages/zh-TW.json"
import {
  getSystemAutostartSettings,
  getSystemProxySettings,
  updateSystemAutostartSettings,
  updateSystemProxySettings,
} from "@/lib/api"
import { loadCoworkInfo } from "@/lib/cowork/info"
import { writeLastCheck } from "@/lib/update-check-storage"

const mockGetProxy = vi.mocked(getSystemProxySettings)
const mockSetProxy = vi.mocked(updateSystemProxySettings)
const mockGetAutostart = vi.mocked(getSystemAutostartSettings)
const mockSetAutostart = vi.mocked(updateSystemAutostartSettings)

// The settings page reads the update lifecycle from the app-wide UpdateProvider
// (settings/layout.tsx wraps it in production), so the test must too.
function renderWithIntl() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <UpdateProvider>
        <SystemNetworkSettings />
      </UpdateProvider>
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  call.mockReset()
  subscribe.mockClear()
  mockGetProxy.mockReset()
  mockSetProxy.mockReset()
  mockGetAutostart.mockReset()
  mockSetAutostart.mockReset()
  desktopShell = false
  remoteWorkspace = false
  phone.mobile = false
  liveHandler = null
  // The provider caches the last availability check in localStorage, which
  // jsdom keeps across tests in a file — clear it so each case starts from a
  // cold "never checked" state rather than inheriting the previous one's
  // release.
  localStorage.clear()
})

// A new server reporting rollback + the live-progress protocol, parameterized
// by the app_update_state snapshot the provider sees and, optionally, a release
// on offer and what its status says stands in the way of installing it (the
// check never reports that).
function liveServerCalls(
  snapshot: unknown,
  server: {
    update?: unknown
    selfUpdateBlocker?: unknown
    blocked?: boolean
  } = {}
) {
  return async (endpoint: string) => {
    if (endpoint === "check_app_update") {
      return {
        currentVersion: "0.16.0",
        update: server.update ?? null,
        selfUpdateSupported: true,
        capability: "supervised",
        runtime: "standalone",
        restartDelayMs: 2000,
        rollbackAvailable: true,
        liveProgress: true,
        ...(server.blocked === undefined ? {} : { blocked: server.blocked }),
      }
    }
    if (endpoint === "app_update_status") {
      return {
        currentVersion: "0.16.0",
        selfUpdateSupported: true,
        capability: "supervised",
        runtime: "standalone",
        restartDelayMs: 2000,
        rollbackAvailable: true,
        liveProgress: true,
        selfUpdateBlocker: server.selfUpdateBlocker,
      }
    }
    if (endpoint === "health") return { version: "0.16.0" }
    if (endpoint === "app_update_state") return snapshot
    throw new Error(`unexpected endpoint: ${endpoint}`)
  }
}

// What the server reports for an install directory it can't write.
const UNWRITABLE_BIN = {
  code: "permission_denied",
  message: "Update target is not writable: /usr/local/bin",
  detail: "Permission denied (os error 13)",
  i18n_key: "SystemSettings.updateErrors.permissionDenied",
  i18n_params: { path: "/usr/local/bin" },
}
const UNWRITABLE_BIN_TEXT =
  "Cannot write to /usr/local/bin, so updates can't be installed in place. Update manually with administrator privileges or check installation permissions."
// The same probe failing for want of space rather than permission.
const FULL_DISK = {
  code: "io_error",
  message: "Update target is not writable: /usr/local/bin",
  detail: "No space left on device (os error 28)",
  i18n_key: "SystemSettings.updateErrors.targetWriteFailed",
  i18n_params: {
    path: "/usr/local/bin",
    reason: "No space left on device (os error 28)",
  },
}

describe("SystemNetworkSettings — install the server can't write", () => {
  it("offers the release page and says why before anyone clicks", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        { seq: 1, status: "idle" },
        {
          update: { version: "0.17.0", body: "", date: null },
          selfUpdateBlocker: UNWRITABLE_BIN,
        }
      )
    )

    renderWithIntl()

    expect(await screen.findByText(UNWRITABLE_BIN_TEXT)).toBeVisible()
    expect(
      await screen.findByRole("button", { name: "View v0.17.0 release" })
    ).toBeVisible()
    expect(
      screen.queryByRole("button", { name: "Upgrade to v0.17.0" })
    ).not.toBeInTheDocument()
    // A rollback writes to the same directories, so it can't work either.
    expect(
      screen.queryByRole("button", { name: "Roll back" })
    ).not.toBeInTheDocument()
  })

  it("reports a failed update by the directory the server named, once", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        {
          seq: 2,
          status: "error",
          error: UNWRITABLE_BIN.message,
          errorInfo: UNWRITABLE_BIN,
        },
        { selfUpdateBlocker: UNWRITABLE_BIN }
      )
    )

    renderWithIntl()

    expect(
      await screen.findByText(`Update error: ${UNWRITABLE_BIN_TEXT}`)
    ).toBeVisible()
    expect(
      screen.getAllByText(/Cannot write to \/usr\/local\/bin/)
    ).toHaveLength(1)
    expect(screen.queryByText(/close the app and try again/)).toBeNull()
  })

  it("still says what blocks the update when a failed check takes the banner", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    const server = liveServerCalls(
      {
        seq: 2,
        status: "error",
        error: UNWRITABLE_BIN.message,
        errorInfo: UNWRITABLE_BIN,
      },
      { selfUpdateBlocker: UNWRITABLE_BIN }
    )
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        throw new Error("error sending request for url")
      }
      return server(endpoint)
    })

    renderWithIntl()

    expect(
      await screen.findByText(
        "Update error: Network connection failed. Check your network or proxy and try again."
      )
    ).toBeVisible()
    expect(await screen.findByText(UNWRITABLE_BIN_TEXT)).toBeVisible()
  })

  it("keeps the rollback when the probe only ran out of space", async () => {
    // A rollback renames what is already there, which a full disk doesn't
    // stop — only a refused write does.
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        { seq: 1, status: "idle" },
        {
          update: { version: "0.17.0", body: "", date: null },
          selfUpdateBlocker: FULL_DISK,
        }
      )
    )

    renderWithIntl()

    expect(
      await screen.findByText(
        "Cannot write to /usr/local/bin, so updates can't be installed in place: No space left on device (os error 28)"
      )
    ).toBeVisible()
    expect(
      await screen.findByRole("button", { name: "Roll back" })
    ).toBeVisible()
    expect(
      screen.getByRole("button", { name: "View v0.17.0 release" })
    ).toBeVisible()
  })

  it("looks again when the operator checks for updates after fixing it", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    let blocked = true
    const server = liveServerCalls({ seq: 1, status: "idle" })
    call.mockImplementation(async (endpoint: string) => {
      const reply = await server(endpoint)
      return endpoint === "app_update_status" && blocked
        ? { ...(reply as object), selfUpdateBlocker: UNWRITABLE_BIN }
        : reply
    })

    renderWithIntl()

    expect(await screen.findByText(UNWRITABLE_BIN_TEXT)).toBeVisible()
    blocked = false
    fireEvent.click(
      await screen.findByRole("button", { name: "Check for updates" })
    )
    await waitFor(() =>
      expect(screen.queryByText(UNWRITABLE_BIN_TEXT)).not.toBeInTheDocument()
    )
  })
})

describe("SystemNetworkSettings — update source outage", () => {
  it("loads proxy settings and exposes rollback when the manifest is unreachable", async () => {
    // The release source is down: the update CHECK fails, but the version read
    // and rollback availability come from the local `app_update_status`
    // endpoint, so neither the settings load nor the rollback action breaks.
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://proxy.local:8080",
    })
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.14.11",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: true,
        }
      }
      if (endpoint === "health") return { version: "0.14.11" }
      if (endpoint === "app_update_state") return { seq: 0, status: "idle" }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })

    renderWithIntl()

    // Rollback action is exposed despite the failed update check.
    expect(
      await screen.findByRole("button", { name: "Roll back" })
    ).toBeInTheDocument()

    // Unrelated local settings still loaded (not defaulted), and the settings
    // load itself did not error out.
    expect(
      screen.getByDisplayValue("http://proxy.local:8080")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument()
  })

  it("loads proxy settings even when the status route is also unavailable (older server)", async () => {
    // Newer desktop, older remote server: both the update check and the new
    // /app_update_status route fail; the version still resolves via /health and
    // the settings load must not break.
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://proxy.local:8080",
    })
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      if (endpoint === "app_update_status") {
        throw new Error("not implemented")
      }
      if (endpoint === "health") return { version: "0.14.11" }
      if (endpoint === "app_update_state") return { seq: 0, status: "idle" }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })

    renderWithIntl()

    // Settings load completed (spinner gone) and proxy is loaded, not defaulted.
    expect(
      await screen.findByDisplayValue("http://proxy.local:8080")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument()
  })

  it("says the download source is unreachable when it has no release JSON", async () => {
    // A 404 / 5xx from the release host: the updater plugin reports that it
    // could not fetch a valid release JSON. That is the source being down,
    // not a generic failure.
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        throw new Error("Could not fetch a valid release JSON from the remote")
      }
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.14.11",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
        }
      }
      if (endpoint === "health") return { version: "0.14.11" }
      if (endpoint === "app_update_state") return { seq: 0, status: "idle" }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })

    renderWithIntl()

    expect(
      await screen.findByText(/Cannot reach the update download source/)
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/Update failed\. Please try again/)
    ).not.toBeInTheDocument()
  })

  it("falls back to 'view release' for a legacy server lacking live_progress", async () => {
    // Newer client, older remote server: it reports an available update and
    // self-update capability, but NOT the `liveProgress` protocol flag. The
    // client must not drive the new detached flow against its old blocking
    // endpoint — it shows the release link instead and never calls perform.
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(async (endpoint: string) => {
      if (endpoint === "check_app_update") {
        return {
          currentVersion: "0.14.0",
          update: { version: "0.16.0", body: "", date: null },
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          // liveProgress intentionally absent (older server).
        }
      }
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.14.0",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
        }
      }
      if (endpoint === "health") return { version: "0.14.0" }
      if (endpoint === "app_update_state") return { seq: 0, status: "idle" }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    })

    renderWithIntl()

    // The release-link affordance is shown, not the in-place upgrade button.
    expect(
      await screen.findByRole("button", { name: "View v0.16.0 release" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Upgrade to v0.16.0" })
    ).not.toBeInTheDocument()
    // The new detached flow was never started against the legacy server.
    expect(call).not.toHaveBeenCalledWith(
      "perform_app_update",
      expect.anything(),
      expect.anything()
    )
  })

  it("suppresses rollback while an upgrade is staged (ready_to_restart)", async () => {
    // A downloaded upgrade is staged AND a previous version is rollbackable.
    // Offering both "Restart to update" and "Roll back" would conflict (and let
    // another window restart into the staged build mid-rollback), so rollback
    // must be hidden until the lifecycle returns to idle.
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls({
        seq: 5,
        status: "ready_to_restart",
        version: "0.17.0",
        restartDelayMs: 2000,
        trialSeconds: 30,
        capability: "supervised",
      })
    )

    renderWithIntl()

    // The staged-update restart prompt is shown…
    expect(
      await screen.findByRole("button", { name: "Restart to update" })
    ).toBeInTheDocument()
    // …and the conflicting rollback action is suppressed despite being
    // available.
    expect(
      screen.queryByRole("button", { name: "Roll back" })
    ).not.toBeInTheDocument()
  })

  it("names the staged version, not a newer release found since", async () => {
    // 重启后用的是存着的 0.17.0，之后又查到了 0.17.1：点「重启以更新」装的
    // 是 0.17.0，所以页面上不该出现 0.17.1 的版本号和更新说明。
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        { seq: 5, status: "ready_to_restart", version: "0.17.0" },
        {
          update: {
            version: "0.17.1",
            body: "Fixes in 0.17.1",
            date: "2026-07-24",
          },
        }
      )
    )

    renderWithIntl()

    expect(
      await screen.findByRole("button", { name: "Restart to update" })
    ).toBeInTheDocument()
    await waitFor(() =>
      expect(
        call.mock.calls.some(([endpoint]) => endpoint === "check_app_update")
      ).toBe(true)
    )
    await act(async () => {})
    expect(screen.queryByText(/v0\.17\.1/)).not.toBeInTheDocument()
    expect(screen.queryByText("Fixes in 0.17.1")).not.toBeInTheDocument()
  })

  it("keeps the notes when the staged version is the one on offer", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        { seq: 5, status: "ready_to_restart", version: "0.17.0" },
        { update: { version: "0.17.0", body: "Fixes in 0.17.0", date: null } }
      )
    )

    renderWithIntl()

    expect(await screen.findByText("Fixes in 0.17.0")).toBeInTheDocument()
    expect(screen.getByText(/v0\.17\.0/)).toBeInTheDocument()
  })

  it("closes a stale rollback dialog when an upgrade becomes staged", async () => {
    // Idle to begin with, so rollback is offered and its confirm dialog opens.
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(liveServerCalls({ seq: 1, status: "idle" }))

    renderWithIntl()

    const rollbackBtn = await screen.findByRole("button", { name: "Roll back" })
    fireEvent.click(rollbackBtn)
    expect(
      await screen.findByText("Roll back to the previous version?")
    ).toBeInTheDocument()

    // Another window stages an update: the shared state advances to
    // ready_to_restart. The now-conflicting dialog must close on its own.
    await act(async () => {
      liveHandler?.({ seq: 9, status: "ready_to_restart", version: "0.17.0" })
      await Promise.resolve()
    })
    expect(
      screen.queryByText("Roll back to the previous version?")
    ).not.toBeInTheDocument()
  })

  it("does not flicker rollback before the live-progress snapshot hydrates", async () => {
    // A live-progress server reports rollback availability immediately, but the
    // authoritative app_update_state snapshot is slow. Rollback must stay hidden
    // until it hydrates (the provider's default `idle` is only a placeholder),
    // then appear if the real state is idle.
    let resolveSnapshot!: (s: unknown) => void
    const pending = new Promise<unknown>((r) => {
      resolveSnapshot = r
    })
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(liveServerCalls(pending))

    renderWithIntl()

    // Status/check have resolved (rollbackAvailable + liveProgress true), but
    // the snapshot is still in flight — rollback must NOT show yet.
    expect(
      await screen.findByRole("button", { name: "Check for updates" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("button", { name: "Roll back" })
    ).not.toBeInTheDocument()

    // The snapshot hydrates to a real idle state — rollback may now appear.
    await act(async () => {
      resolveSnapshot({ seq: 1, status: "idle" })
      await Promise.resolve()
    })
    expect(
      await screen.findByRole("button", { name: "Roll back" })
    ).toBeInTheDocument()
  })
})

// Cowork: releases ship several times a day, so a release on offer can be an
// old answer by the time the page is open.
describe("SystemNetworkSettings — an offer that may be out of date", () => {
  const offer = (version: string) => ({ version, body: "", date: null })
  const checks = () =>
    call.mock.calls.filter(([endpoint]) => endpoint === "check_app_update")

  it("checks again beside the release on offer", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    let newest = "0.17.0"
    call.mockImplementation(async (endpoint: string) =>
      liveServerCalls(
        { seq: 1, status: "idle" },
        { update: offer(newest) }
      )(endpoint)
    )

    renderWithIntl()

    expect(
      await screen.findByRole("button", { name: "Upgrade to v0.17.0" })
    ).toBeVisible()
    newest = "0.17.1"
    fireEvent.click(screen.getByRole("button", { name: "Check for updates" }))
    expect(
      await screen.findByRole("button", { name: "Upgrade to v0.17.1" })
    ).toBeVisible()
  })

  it("looks again on opening when the answer it holds is old", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    writeLastCheck({
      at: Date.now() - 10 * 60 * 1000,
      currentVersion: "0.16.0",
      info: offer("0.17.0"),
    })
    call.mockImplementation(
      liveServerCalls({ seq: 1, status: "idle" }, { update: offer("0.17.1") })
    )

    renderWithIntl()

    expect(
      await screen.findByRole("button", { name: "Upgrade to v0.17.1" })
    ).toBeVisible()
    expect(screen.getByText(/^Last checked: /)).toBeVisible()
  })

  it("does not look again for an answer a minute old", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    writeLastCheck({
      at: Date.now() - 60 * 1000,
      currentVersion: "0.16.0",
      info: offer("0.17.0"),
    })
    call.mockImplementation(
      liveServerCalls({ seq: 1, status: "idle" }, { update: offer("0.17.1") })
    )

    renderWithIntl()

    expect(
      await screen.findByRole("button", { name: "Upgrade to v0.17.0" })
    ).toBeVisible()
    // The page decides once `cowork_info` has answered; wait that out.
    await act(async () => {
      await loadCoworkInfo()
    })
    expect(checks()).toHaveLength(0)
  })
})

// issue #413 第 4 行：查到的这一版上次在这台电脑上没能启动、被自动退回了。
// 桌面主程序的检查才会带 `blocked`；这里用服务端那条检查的答复驱动页面。
describe("SystemNetworkSettings — a release that did not start here", () => {
  const offer = (version: string) => ({ version, body: "", date: null })
  const HINT =
    "This version did not start on this computer last time and was rolled back automatically. You can try it again by hand."

  it("keeps the upgrade button and says why it was not installed", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        { seq: 1, status: "idle" },
        { update: offer("0.17.0"), blocked: true }
      )
    )

    renderWithIntl()

    const button = await screen.findByRole("button", {
      name: "Upgrade to v0.17.0",
    })
    expect(button).toBeEnabled()
    expect(await screen.findByText(HINT)).toBeVisible()
  })

  it("says nothing for a release that is not blocked", async () => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(
      liveServerCalls(
        { seq: 1, status: "idle" },
        { update: offer("0.17.0"), blocked: false }
      )
    )

    renderWithIntl()

    expect(
      await screen.findByRole("button", { name: "Upgrade to v0.17.0" })
    ).toBeVisible()
    expect(screen.queryByText(HINT)).toBeNull()
  })
})

describe("SystemNetworkSettings — 手机布局（#1335）", () => {
  beforeEach(() => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(liveServerCalls({ seq: 1, status: "idle" }))
  })

  it("手机上不显示软件更新和代理，语言照旧", async () => {
    phone.mobile = true
    renderWithIntl()

    expect(
      await screen.findByRole("heading", { name: "Language" })
    ).toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Network Proxy" })
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole("heading", { name: "Software Update" })
    ).not.toBeInTheDocument()
    expect(screen.queryByLabelText("Launch at login")).not.toBeInTheDocument()
  })

  it("宽屏照旧显示", async () => {
    renderWithIntl()

    expect(
      await screen.findByRole("heading", { name: "Network Proxy" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("heading", { name: "Software Update" })
    ).toBeInTheDocument()
  })
})

describe("SystemNetworkSettings — launch at login", () => {
  beforeEach(() => {
    mockGetProxy.mockResolvedValue({ enabled: false, proxy_url: null })
    call.mockImplementation(liveServerCalls({ seq: 1, status: "idle" }))
  })

  it("hides the section on a web build", async () => {
    // No login items to register from a browser, so the row must not render —
    // and the machine must not be asked about them either.
    mockGetAutostart.mockResolvedValue({ enabled: false })

    renderWithIntl()

    await screen.findByRole("heading", { name: "Network Proxy" })
    expect(screen.queryByLabelText("Launch at login")).not.toBeInTheDocument()
    expect(mockGetAutostart).not.toHaveBeenCalled()
  })

  it("hides the section in a remote-workspace window", async () => {
    // A desktop shell, but every call lands on someone else's machine — whose
    // login items are not the ones the user is looking at. Gating on "is a
    // desktop app" instead of "is a LOCAL desktop app" fails right here.
    desktopShell = true
    remoteWorkspace = true
    mockGetAutostart.mockResolvedValue({ enabled: false })

    renderWithIntl()

    await screen.findByRole("heading", { name: "Network Proxy" })
    expect(screen.queryByLabelText("Launch at login")).not.toBeInTheDocument()
    expect(mockGetAutostart).not.toHaveBeenCalled()
  })

  it("follows the OS's answer rather than the optimistic value", async () => {
    // Windows can veto a Run entry through Task Manager, so a backend that
    // reports "still off" has to win over the click that turned it on.
    desktopShell = true
    mockGetAutostart.mockResolvedValue({ enabled: false })
    mockSetAutostart.mockResolvedValue({ enabled: false })

    renderWithIntl()

    const autostart = await screen.findByLabelText("Launch at login")
    expect(autostart).toHaveAttribute("role", "switch")
    expect(autostart).toHaveAttribute("data-state", "unchecked")

    // The switch is inert for the duration of the write, so waiting for it to
    // come back is waiting for the reply to have been applied — asserting on
    // the value alone would pass against the pre-click state.
    fireEvent.click(autostart)
    await waitFor(() => expect(autostart).not.toBeDisabled())
    expect(mockSetAutostart).toHaveBeenCalledWith({ enabled: true })
    expect(autostart).toHaveAttribute("data-state", "unchecked")

    // …and it does flip once the OS actually accepts the registration.
    mockSetAutostart.mockResolvedValue({ enabled: true })
    fireEvent.click(autostart)
    await waitFor(() =>
      expect(autostart).toHaveAttribute("data-state", "checked")
    )
  })

  it("keeps the rest of the page alive when the OS won't report login items", async () => {
    // A locked-down registry / missing home dir fails only this one read: the
    // switch goes inert and explains itself, the proxy card still loads.
    desktopShell = true
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://proxy.local:8080",
    })
    mockGetAutostart.mockRejectedValue(new Error("registry locked"))

    renderWithIntl()

    const autostart = await screen.findByLabelText("Launch at login")
    expect(autostart).toBeDisabled()
    expect(screen.getByText(/registry locked/)).toBeInTheDocument()
    expect(
      screen.getByDisplayValue("http://proxy.local:8080")
    ).toBeInTheDocument()
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument()
  })
})

describe("SystemNetworkSettings — proxy bypass list", () => {
  beforeEach(() => {
    call.mockImplementation(liveServerCalls({ seq: 1, status: "idle" }))
  })

  it("saves the list with the proxy and shows what the backend stored", async () => {
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com",
    })
    // The backend canonicalizes the list; the field follows its answer.
    mockSetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com,192.168.1.10",
    })

    renderWithIntl()

    const bypass = await screen.findByLabelText("Bypass proxy for")
    expect(bypass).toHaveValue("corp.example.com")

    fireEvent.change(bypass, {
      target: { value: " corp.example.com;192.168.1.10 " },
    })
    fireEvent.blur(bypass)

    await waitFor(() =>
      expect(bypass).toHaveValue("corp.example.com,192.168.1.10")
    )
    expect(mockSetProxy).toHaveBeenCalledWith({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com;192.168.1.10",
    })
  })

  it("keeps the list when the proxy address or switch is saved", async () => {
    // Every save sends the whole settings row, so saving one field must not
    // wipe the bypass list the backend already has.
    mockGetProxy.mockResolvedValue({
      enabled: false,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com",
    })
    mockSetProxy.mockImplementation(async (settings) => settings)

    renderWithIntl()

    const address = await screen.findByDisplayValue("http://10.0.0.2:3128")
    fireEvent.blur(address)
    await waitFor(() => expect(mockSetProxy).toHaveBeenCalledTimes(1))
    expect(mockSetProxy).toHaveBeenLastCalledWith({
      enabled: false,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com",
    })

    fireEvent.click(screen.getByLabelText("Enable system proxy"))
    await waitFor(() => expect(mockSetProxy).toHaveBeenCalledTimes(2))
    expect(mockSetProxy).toHaveBeenLastCalledWith({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com",
    })
  })

  it("一个非法地址存不进去时就地提示，勾选框退回没勾（#1420）", async () => {
    mockGetProxy.mockResolvedValue({
      enabled: false,
      proxy_url: null,
      no_proxy: null,
    })
    const invalid = {
      code: "configuration_invalid",
      message: "Invalid proxy URL",
      detail: "invalid international domain name",
      i18n_key: "systemProxy.error.invalidUrl",
    }
    mockSetProxy.mockRejectedValue(invalid)

    renderWithIntl()

    const address = await screen.findByPlaceholderText("http://127.0.0.1:7890")
    fireEvent.change(address, { target: { value: "not a url!!" } })
    fireEvent.blur(address)
    await waitFor(() => expect(mockSetProxy).toHaveBeenCalledTimes(1))
    const hint = enMessages.systemProxy.error.invalidUrl
    expect(await screen.findByText(hint)).toBeInTheDocument()
    expect(address).toHaveAttribute("aria-invalid", "true")

    const checkbox = screen.getByLabelText("Enable system proxy")
    fireEvent.click(checkbox)
    await waitFor(() => expect(mockSetProxy).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(checkbox).not.toBeChecked())
    expect(screen.getByText(hint)).toBeInTheDocument()
    // toast 也用本地化的文案，不出 url 库的英文原文。
    const { toast } = await import("sonner")
    for (const [message] of vi.mocked(toast.error).mock.calls) {
      expect(String(message)).not.toContain("invalid international domain")
    }
  })

  it("clears the list with an empty field", async () => {
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com",
    })
    mockSetProxy.mockImplementation(async (settings) => settings)

    renderWithIntl()

    const bypass = await screen.findByLabelText("Bypass proxy for")
    fireEvent.change(bypass, { target: { value: "   " } })
    fireEvent.blur(bypass)

    await waitFor(() => expect(mockSetProxy).toHaveBeenCalledTimes(1))
    expect(mockSetProxy).toHaveBeenCalledWith({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: null,
    })
    await waitFor(() => expect(bypass).toHaveValue(""))
  })

  it("states the list format with the same literals as the placeholder", async () => {
    mockGetProxy.mockResolvedValue({
      enabled: false,
      proxy_url: null,
      no_proxy: null,
    })

    renderWithIntl()

    const bypass = await screen.findByLabelText("Bypass proxy for")
    const example = bypass.getAttribute("placeholder") ?? ""
    // The form the backend stores and shows back: commas, no spaces.
    expect(example).toMatch(/^[^\s,]+(,[^\s,]+)+$/)
    // Hosts read left to right even in Arabic.
    expect(bypass).toHaveAttribute("dir", "ltr")

    const hint = screen.getByText(/Separate entries with commas and no spaces/)
    for (const literal of [
      example,
      "example.com",
      ".example.com",
      "localhost,127.0.0.1,::1",
    ]) {
      const node = within(hint).getByText(literal)
      expect(node.tagName).toBe("CODE")
      // Kept whole in Arabic, where a leading `.` would otherwise move.
      expect(node).toHaveAttribute("dir", "ltr")
    }
  })

  it("shows an empty list for a server that predates the setting", async () => {
    // A remote workspace on an older server never sends `no_proxy`.
    mockGetProxy.mockResolvedValue({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
    })

    renderWithIntl()

    expect(await screen.findByLabelText("Bypass proxy for")).toHaveValue("")
    expect(screen.queryByText(/Load failed/)).not.toBeInTheDocument()
  })
})

describe("SystemNetworkSettings — proxy read failure", () => {
  beforeEach(() => {
    call.mockImplementation(liveServerCalls({ seq: 1, status: "idle" }))
  })

  /// Regression (#628): after a failed read the card held `enabled: false`
  /// and empty fields but stayed editable, and the switch and both fields
  /// save the whole card on change or blur — one stray click overwrote the
  /// real proxy.
  it("locks the proxy card after a failed read until a retry succeeds", async () => {
    const T = enMessages.SystemSettings
    mockGetProxy.mockRejectedValueOnce(new Error("backend down"))
    mockSetProxy.mockImplementation(async (settings) => settings)

    renderWithIntl()

    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Load failed: backend down")
    const toggle = screen.getByLabelText("Enable system proxy")
    const address = screen.getByPlaceholderText("http://127.0.0.1:7890")
    const bypass = screen.getByLabelText("Bypass proxy for")
    expect(toggle).toBeDisabled()
    expect(address).toBeDisabled()
    expect(bypass).toBeDisabled()
    fireEvent.click(toggle)
    fireEvent.blur(address)
    fireEvent.blur(bypass)
    expect(mockSetProxy).not.toHaveBeenCalled()

    mockGetProxy.mockResolvedValueOnce({
      enabled: true,
      proxy_url: "http://10.0.0.2:3128",
      no_proxy: "corp.example.com",
    })
    fireEvent.click(within(alert).getByRole("button", { name: T.retry }))

    const restored = await screen.findByDisplayValue("http://10.0.0.2:3128")
    expect(screen.queryByRole("alert")).not.toBeInTheDocument()
    expect(restored).toBeEnabled()
    expect(screen.getByLabelText("Bypass proxy for")).toHaveValue(
      "corp.example.com"
    )
    expect(screen.getByLabelText("Enable system proxy")).toBeChecked()
    expect(mockSetProxy).not.toHaveBeenCalled()

    fireEvent.blur(restored)
    await waitFor(() =>
      expect(mockSetProxy).toHaveBeenCalledWith({
        enabled: true,
        proxy_url: "http://10.0.0.2:3128",
        no_proxy: "corp.example.com",
      })
    )
  })
})

describe("SystemNetworkSettings — proxy bypass hint in every locale", () => {
  it.each([
    ["ar", arMessages],
    ["de", deMessages],
    ["en", enMessages],
    ["es", esMessages],
    ["fr", frMessages],
    ["ja", jaMessages],
    ["ko", koMessages],
    ["pt", ptMessages],
    ["zh-CN", zhCNMessages],
    ["zh-TW", zhTWMessages],
  ] as const)(
    "%s writes every value the way the field takes it",
    (_, messages) => {
      const hint = messages.SystemSettings.proxyBypassHint
      for (const literal of [
        "{example}",
        "example.com",
        ".example.com",
        "localhost,127.0.0.1,::1",
      ]) {
        expect(hint).toContain(`<code>${literal}</code>`)
      }
      // The local hosts appear once, as that literal — never listed with the
      // locale's own punctuation (、 ، or ", "), which reads as a separator.
      expect(hint.split("localhost")).toHaveLength(2)
    }
  )
})
