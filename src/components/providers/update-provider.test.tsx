import { useEffect } from "react"
import { render, screen, act, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { AppUpdateState } from "@/lib/updater"

// The provider's snapshot/subscribe helpers go through getTransport(), so
// mocking the transport drives the whole provider without stubbing updater.ts.
let snapshot: AppUpdateState = { seq: 0, status: "idle" }
// Per-call overrides for the app_update_state fetch (e.g. a hanging promise so
// a test can interleave events/reconnects before it resolves). Falls back to
// `snapshot` when empty.
let callQueue: Array<AppUpdateState | Promise<AppUpdateState>> = []
// Both real transports keep a Set of reconnect callbacks (see
// web-transport.ts / remote-desktop-transport.ts), and the provider registers
// two — mirror that here so a second registration can't shadow the first.
const reconnectCbs = new Set<() => void>()
const fireReconnect = () => {
  for (const cb of [...reconnectCbs]) cb()
}
let liveHandler: ((s: AppUpdateState) => void) | null = null

// What `check_app_update` answers. A function so a test can hang it, throw, or
// vary the reply per call.
let checkResult: () => unknown = () => ({
  currentVersion: "0.21.7",
  update: null,
  selfUpdateSupported: true,
  liveProgress: true,
  runtime: "standalone",
  rollbackAvailable: false,
})

// Full override, for tests that need to shape several endpoints at once (e.g.
// an older server whose app_update_status 404s).
let callImpl: ((endpoint: string) => Promise<unknown>) | null = null

// What `cowork_info` answers. Defaults to an upstream (non-Cowork) server's
// 501, which settles the info as "not Cowork" so background checks run.
let coworkInfoResult: () => unknown = () => {
  throw { code: "not_implemented", message: "not implemented" }
}

// What `perform_app_update` answers: the backend moves to `downloading` with
// the next seq. A function so a test can make the kickoff throw.
let performResult: () => unknown = () => ({
  seq: snapshot.seq + 1,
  status: "downloading",
  downloaded: 0,
})

// Desktop mode (`usesTauriUpdater()`): off everywhere except the tests that
// turn it on, so the other describes keep driving the server path.
let desktop = false
// What the desktop app reports as its own version, and the release its
// `check_app_update` finds (null = up to date).
let desktopVersion = "1.1.23"
// The update channel the desktop check reports (issue #413).
let desktopChannel: "stable" | "early" = "stable"
// Holds a desktop check after it has read the channel, so a test can change
// channel while that check is still in flight; and makes it fail.
let desktopCheckGate: Promise<void> | null = null
let desktopCheckFails = false
// Whether the desktop check says the release found is one that did not start
// on this computer last time (issue #413, row 3).
let desktopBlocked = false
let desktopRelease: {
  version: string
  body: string
  date: string | null
} | null = null

// Cowork fork: the "Automatic updates" setting and the "Updated to …"
// announcement the desktop app answers.
let updateModeResult: () => unknown = () => ({ mode: "auto" })
let announcementResult: () => unknown = () => null
let confirmationResult: () => unknown = () => null
let restartsWhenIdleResult: () => unknown = () => true

const call = vi.fn(async (endpoint: string) => {
  if (endpoint === "cowork_info") return coworkInfoResult()
  if (endpoint === "get_update_preferences") return updateModeResult()
  if (endpoint === "await_update_confirmation") return confirmationResult()
  if (endpoint === "take_update_announcement") return announcementResult()
  if (endpoint === "update_restarts_when_idle") return restartsWhenIdleResult()
  if (callImpl) return callImpl(endpoint)
  if (endpoint === "perform_app_update") return performResult()
  if (endpoint === "restart_app") return undefined
  if (endpoint === "app_update_state") {
    return callQueue.length ? callQueue.shift()! : snapshot
  }
  if (endpoint === "check_app_update") {
    // Desktop: the app's own channel check (Cowork fork, issue #413).
    if (desktop) {
      const answer = {
        currentVersion: desktopVersion,
        channel: desktopChannel,
        update: desktopRelease && {
          version: desktopRelease.version,
          notes: desktopRelease.body,
          date: desktopRelease.date,
        },
        blocked: desktopBlocked,
      }
      const fails = desktopCheckFails
      if (desktopCheckGate) await desktopCheckGate
      if (fails) throw new Error("manifest unreachable")
      return answer
    }
    return checkResult()
  }
  if (endpoint === "app_update_status") {
    return {
      currentVersion: "0.21.7",
      selfUpdateSupported: true,
      capability: "supervised",
      runtime: "standalone",
      restartDelayMs: 2000,
      rollbackAvailable: false,
      liveProgress: true,
    }
  }
  throw new Error(`unexpected endpoint: ${endpoint}`)
})
const subscribe = vi.fn(
  async (_event: string, handler: (s: AppUpdateState) => void) => {
    liveHandler = handler
    return () => {}
  }
)
const onReconnect = vi.fn((cb: () => void) => {
  reconnectCbs.add(cb)
  return () => {
    reconnectCbs.delete(cb)
  }
})

vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call, subscribe, onReconnect }),
  // Desktop windows send update commands to the local shell; same mock.
  getShellTransport: () => ({ call, subscribe, onReconnect }),
  isDesktop: () => desktop,
  isRemoteDesktopMode: () => false,
  getActiveRemoteConnectionId: () => null,
}))

vi.mock("@tauri-apps/api/app", () => ({
  getVersion: async () => desktopVersion,
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}))

import { UpdateProvider, useAppUpdate } from "./update-provider"
import { resetCoworkInfoForTests } from "@/lib/cowork/info"
import enMessages from "@/i18n/messages/en.json"

function Probe() {
  const u = useAppUpdate()
  return (
    <div data-testid="status">
      {u?.state.status} #{u?.state.seq}
    </div>
  )
}

const makeTree = () => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <UpdateProvider>
      <Probe />
    </UpdateProvider>
  </NextIntlClientProvider>
)

const text = () => screen.getByTestId("status").textContent

beforeEach(() => {
  call.mockClear()
  subscribe.mockClear()
  onReconnect.mockClear()
  reconnectCbs.clear()
  liveHandler = null
  callQueue = []
  callImpl = null
  coworkInfoResult = () => {
    throw { code: "not_implemented", message: "not implemented" }
  }
  resetCoworkInfoForTests(undefined)
  snapshot = { seq: 0, status: "idle" }
  performResult = () => ({
    seq: snapshot.seq + 1,
    status: "downloading",
    downloaded: 0,
  })
  desktop = false
  desktopVersion = "1.1.23"
  desktopRelease = null
  desktopChannel = "stable"
  desktopCheckGate = null
  desktopCheckFails = false
  desktopBlocked = false
  checkResult = () => ({
    currentVersion: "0.21.7",
    update: null,
    selfUpdateSupported: true,
    liveProgress: true,
    runtime: "standalone",
    rollbackAvailable: false,
  })
  updateModeResult = () => ({ mode: "auto" })
  announcementResult = () => null
  confirmationResult = () => null
  restartsWhenIdleResult = () => true
  availableIdentities = 0
  offers = []
  // The availability cache lives in localStorage, which jsdom keeps across
  // tests in a file — clear it so each case starts cold.
  localStorage.clear()
})

describe("UpdateProvider", () => {
  it("seeds current state from the snapshot on mount", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))
  })

  it("accepts a lower-seq snapshot after a reconnect (backend restarted)", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // The server self-updated and relaunched: the NEW process restarts its seq
    // counter at 0 and is idle. Without resetting the high-water on reconnect,
    // the seq guard would discard this and leave the UI stuck on "downloading".
    snapshot = { seq: 0, status: "idle" }
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("idle #0"))
  })

  it("keeps a higher-seq live event that arrives during the reconnect fetch", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // Reconnect with a snapshot fetch that hangs, so we can interleave a live
    // event from the new process before it resolves.
    let resolveSnap!: (s: AppUpdateState) => void
    callQueue = [
      new Promise<AppUpdateState>((r) => {
        resolveSnap = r
      }),
    ]
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })

    // New process delivers a fresh, higher-seq event while the snapshot is in
    // flight — it must be applied (the high-water was reset before the fetch).
    await act(async () => {
      liveHandler?.({ seq: 3, status: "installing" })
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("installing #3"))

    // The in-flight snapshot now resolves with an OLDER seq — it must NOT
    // clobber the newer live event.
    await act(async () => {
      resolveSnap({ seq: 1, status: "downloading", downloaded: 5, total: 100 })
      await Promise.resolve()
    })
    expect(text()).toBe("installing #3")
  })

  it("discards a pre-reconnect snapshot that resolves after the reset", async () => {
    // The mount snapshot fetch hangs; a reconnect happens before it resolves.
    let resolveMount!: (s: AppUpdateState) => void
    callQueue = [
      new Promise<AppUpdateState>((r) => {
        resolveMount = r
      }),
    ]
    render(makeTree())
    // Let the mount resync start and claim the hanging fetch (epoch 1) before
    // the reconnect, so the hang belongs to the pre-reconnect fetch.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })

    // Reconnect to the new (idle) process while the mount fetch is still in
    // flight.
    snapshot = { seq: 0, status: "idle" }
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("idle #0"))

    // The original mount fetch finally resolves with the OLD process's high
    // seq — the epoch guard must discard it rather than resurrect the old
    // "downloading" state.
    await act(async () => {
      resolveMount({ seq: 50, status: "downloading", downloaded: 1, total: 2 })
      await Promise.resolve()
    })
    expect(text()).toBe("idle #0")
  })

  it("ignores a malformed payload (legacy server) without poisoning the guard", async () => {
    snapshot = { seq: 50, status: "downloading", downloaded: 10, total: 100 }
    render(makeTree())
    await waitFor(() => expect(text()).toBe("downloading #50"))

    // An older remote server's perform answers with the legacy
    // `{ version, needRestart }` shape (no seq/status) — it must be ignored.
    await act(async () => {
      liveHandler?.({
        version: "9.9.9",
        needRestart: true,
      } as unknown as AppUpdateState)
      await Promise.resolve()
    })
    expect(text()).toBe("downloading #50")

    // A subsequent valid event still applies — the guard wasn't poisoned by an
    // undefined seq.
    await act(async () => {
      liveHandler?.({ seq: 51, status: "installing" })
      await Promise.resolve()
    })
    await waitFor(() => expect(text()).toBe("installing #51"))
  })
})

// ─── Availability ──────────────────────────────────────────────────────────

const LAST_CHECK_KEY = "codeg.updateCheck.last"
const CHANNEL_CHANGED_KEY = "codeg.updateCheck.channelChangedAt"
const DISMISSED_KEY = "codeg.updateCheck.dismissedVersion"

let ctx: ReturnType<typeof useAppUpdate> = null
let availableIdentities = 0
// Every release offer consumers were handed, with whether it came with the
// in-place install enabled — so a test can assert on transient states too.
let offers: Array<{ version: string; inPlace: boolean }> = []

function AvailabilityProbe() {
  const u = useAppUpdate()
  // Captured in an effect, not during render: assigning to an outer binding
  // mid-render is a side effect React makes no ordering promises about.
  useEffect(() => {
    ctx = u
  }, [u])
  // Bumped for every distinct `available` object handed to consumers — each one
  // is a re-render for everything downstream, so a test can assert that
  // re-reading an unchanged cache entry stays free. A module binding rather
  // than state: setState in an effect is a lint error here, and would itself
  // add renders to the thing being measured.
  useEffect(() => {
    availableIdentities += 1
  }, [u?.available])
  useEffect(() => {
    if (u?.available) {
      offers.push({
        version: u.available.version,
        inPlace: u.canInstallInPlace,
      })
    }
  }, [u?.available, u?.canInstallInPlace])
  return (
    <div>
      <div data-testid="available">{u?.available?.version ?? "none"}</div>
      <div data-testid="lifecycle">{u?.state.status}</div>
      <div data-testid="checking">{String(u?.checking)}</div>
      <div data-testid="dismissed">{u?.dismissedVersion ?? "none"}</div>
      <div data-testid="current">{u?.currentVersion || "none"}</div>
      <div data-testid="in-place">{String(u?.canInstallInPlace)}</div>
      <div data-testid="blocked">{String(u?.blocked)}</div>
    </div>
  )
}

const availabilityTree = () => (
  <NextIntlClientProvider locale="en" messages={enMessages}>
    <UpdateProvider>
      <AvailabilityProbe />
    </UpdateProvider>
  </NextIntlClientProvider>
)

const checkCalls = () =>
  call.mock.calls.filter(([e]) => e === "check_app_update").length

describe("UpdateProvider — availability", () => {
  it("restores the last result from storage so a reload isn't briefly blind", async () => {
    // Only the timestamp used to be cached, which made a throttled reload claim
    // "you're up to date" for an update the previous check had already found.
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.21.9", body: "notes", date: null },
      })
    )

    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    // Restored from cache, not re-fetched.
    expect(checkCalls()).toBe(0)
  })

  it("ignores a cache entry with a nonsense timestamp", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({ at: "soon", info: { version: "9.9.9", body: "" } })
    )

    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(screen.getByTestId("available").textContent).toBe("none")
  })

  it("persists a check result so the next mount can restore it", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "notes", date: "2026-07-24" },
      selfUpdateSupported: true,
      liveProgress: true,
      runtime: "standalone",
      rollbackAvailable: false,
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())

    await act(async () => {
      await ctx!.checkNow()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    expect(screen.getByTestId("in-place").textContent).toBe("true")
    const cached = JSON.parse(localStorage.getItem(LAST_CHECK_KEY)!)
    expect(cached.info.version).toBe("0.21.9")
    expect(typeof cached.at).toBe("number")
  })

  it("offers no in-place install until the status probe finds the way clear", async () => {
    // The local status probe finds the install unwritable: an upgrade would
    // fail at its first step, so the UI must fall back to the release page.
    let blocked = true
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.21.7",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
          ...(blocked && {
            selfUpdateBlocker: {
              code: "permission_denied",
              message: "Update target is not writable: /usr/local/bin",
              i18n_key: "SystemSettings.updateErrors.permissionDenied",
              i18n_params: { path: "/usr/local/bin" },
            },
          }),
        }
      }
      if (endpoint === "check_app_update") return checkResult()
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }
    render(availabilityTree())

    await waitFor(() => expect(ctx?.selfUpdateBlocker).toBeTruthy())
    expect(ctx!.selfUpdateBlocker!.i18n_params).toEqual({
      path: "/usr/local/bin",
    })
    expect(screen.getByTestId("in-place").textContent).toBe("false")

    // The check carries no blocker: it is not a source, so it must not clear
    // what the status probe found.
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(ctx!.selfUpdateBlocker).toBeTruthy()
    expect(screen.getByTestId("in-place").textContent).toBe("false")

    // Fixed from another window; coming back to this one looks again.
    blocked = false
    await act(async () => {
      window.dispatchEvent(new Event("focus"))
    })
    await waitFor(() => expect(ctx!.selfUpdateBlocker).toBeNull())
    expect(screen.getByTestId("in-place").textContent).toBe("true")
  })

  it("offers a release only once the blocker verdict is as fresh as the check", async () => {
    // Nothing blocks at mount; the install turns unwritable later, and the next
    // check surfaces an update. Offering it before the status is read again
    // would offer an upgrade certain to fail.
    let blocked = false
    // Holds the status reply back, to catch the offer arriving ahead of it.
    let statusGate: Promise<void> | null = null
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        if (statusGate) await statusGate
        return {
          currentVersion: "0.21.7",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
          ...(blocked && {
            selfUpdateBlocker: {
              code: "permission_denied",
              message: "Update target is not writable: /usr/local/bin",
              i18n_key: "SystemSettings.updateErrors.permissionDenied",
              i18n_params: { path: "/usr/local/bin" },
            },
          }),
        }
      }
      if (endpoint === "check_app_update") return checkResult()
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }
    const statusCalls = () =>
      call.mock.calls.filter(([e]) => e === "app_update_status").length
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    )
    expect(screen.getByTestId("in-place").textContent).toBe("true")

    blocked = true
    let releaseStatus!: () => void
    statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
      selfUpdateSupported: true,
      liveProgress: true,
      runtime: "standalone",
      rollbackAvailable: false,
    })
    const before = statusCalls()
    let checking!: Promise<void>
    act(() => {
      checking = ctx!.checkNow()
    })
    // The check has its answer and is re-reading the status…
    await waitFor(() => expect(statusCalls()).toBe(before + 1))
    // …and offers nothing until that verdict is in.
    expect(screen.getByTestId("available").textContent).toBe("none")

    await act(async () => {
      releaseStatus()
      await checking
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(screen.getByTestId("in-place").textContent).toBe("false")
    expect(offers).toEqual([{ version: "0.21.9", inPlace: false }])
  })

  it("never publishes an answer from a process that restarted while the verdict was read", async () => {
    // Another window upgrades the server to the offered release while this
    // check is reading the blocker verdict. The answer must come from the
    // process now running, not re-offer what it already runs.
    let restarted = false
    let statusGate: Promise<void> | null = null
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        if (statusGate) await statusGate
        return {
          currentVersion: restarted ? "0.21.9" : "0.21.7",
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: false,
          liveProgress: true,
        }
      }
      if (endpoint === "check_app_update") {
        return {
          currentVersion: restarted ? "0.21.9" : "0.21.7",
          update: restarted
            ? null
            : { version: "0.21.9", body: "", date: null },
          selfUpdateSupported: true,
          liveProgress: true,
          runtime: "standalone",
          rollbackAvailable: false,
        }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }
    const statusCalls = () =>
      call.mock.calls.filter(([e]) => e === "app_update_status").length
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    )

    let releaseStatus!: () => void
    statusGate = new Promise<void>((resolve) => {
      releaseStatus = resolve
    })
    const before = statusCalls()
    let checking!: Promise<void>
    act(() => {
      checking = ctx!.checkNow()
    })
    await waitFor(() => expect(statusCalls()).toBe(before + 1))
    restarted = true
    await act(async () => {
      releaseStatus()
      await checking
    })

    expect(screen.getByTestId("available").textContent).toBe("none")
    expect(screen.getByTestId("current").textContent).toBe("0.21.9")
  })

  it("de-duplicates concurrent checks into a single manifest fetch", async () => {
    // The settings page's button and the scheduler can fire together; two
    // manifest requests for one answer would be pure waste.
    let release!: (v: unknown) => void
    checkResult = () =>
      new Promise((r) => {
        release = r
      })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())

    let both!: Promise<unknown>
    await act(async () => {
      both = Promise.all([ctx!.checkNow(), ctx!.checkNow({ silent: false })])
      await Promise.resolve()
    })
    expect(checkCalls()).toBe(1)
    expect(screen.getByTestId("checking").textContent).toBe("true")

    await act(async () => {
      release({ currentVersion: "0.21.7", update: null })
      await both
    })
    expect(screen.getByTestId("checking").textContent).toBe("false")

    // Settled: a later check starts a new request rather than reusing the old.
    await act(async () => {
      release = () => {}
      checkResult = () => ({ currentVersion: "0.21.7", update: null })
      await ctx!.checkNow()
    })
    expect(checkCalls()).toBe(2)
  })

  it("records a failed check without persisting it as a completed one", async () => {
    checkResult = () => {
      throw new Error("error sending request for url")
    }
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())

    await act(async () => {
      await ctx!.checkNow()
    })

    expect(ctx!.checkError).toContain("error sending request")
    // A failure must not look like "checked, nothing new" — otherwise the 6h
    // throttle would suppress recovery attempts.
    expect(localStorage.getItem(LAST_CHECK_KEY)).toBeNull()
  })

  it("silences the dismissed release only, and re-surfaces the next one", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })

    await act(async () => {
      ctx!.dismissAvailable()
    })
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("0.21.9")

    // A newer release lands: the stale dismissal must be dropped so the badge
    // comes back.
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.22.0", body: "", date: null },
    })
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("dismissed").textContent).toBe("none")
    expect(localStorage.getItem(DISMISSED_KEY)).toBeNull()
  })

  it("keeps the dismissal while that release is still the newest", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    await act(async () => {
      ctx!.dismissAvailable()
    })

    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })
})

describe("UpdateProvider — check scheduling", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("runs the first check only after the startup delay", async () => {
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    // Still inside the delay: workspace boot isn't competing with a manifest
    // fetch.
    expect(checkCalls()).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(checkCalls()).toBe(1)
  })

  it("skips the scheduled check while an update is already downloading", async () => {
    snapshot = { seq: 3, status: "downloading", downloaded: 10, total: 100 }
    render(availabilityTree())
    // Let the mount snapshot land (and its effects flush) before the startup
    // timer fires, so the guard sees the real lifecycle rather than the
    // placeholder `idle`.
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId("lifecycle").textContent).toBe("downloading")

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    // Nothing to discover: the status bar is already showing this update's
    // progress.
    expect(checkCalls()).toBe(0)
  })

  it("honours a recent check recorded by another window", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({ at: Date.now(), currentVersion: "0.21.7", info: null })
    )
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(checkCalls()).toBe(0)
  })

  it("re-checks once the cached answer has gone stale", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() - 7 * 60 * 60 * 1000,
        currentVersion: "0.21.7",
        info: null,
      })
    )
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(checkCalls()).toBe(1)
  })

  const coworkInfoCalls = () =>
    call.mock.calls.filter(([e]) => e === "cowork_info").length

  it("asks Cowork first and never checks when it disables updates", async () => {
    // No page has loaded the Cowork info yet (the account menu and system
    // settings do; appearance / MCP / agents settings don't).
    coworkInfoResult = () => ({ product: "Cowork", updateDisabled: true })
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(coworkInfoCalls()).toBe(1)
    expect(checkCalls()).toBe(0)

    // Nor on a later tab focus.
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(checkCalls()).toBe(0)
  })

  it("checks as usual on a Cowork server that allows updates", async () => {
    coworkInfoResult = () => ({ product: "Cowork", updateDisabled: false })
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(coworkInfoCalls()).toBe(1)
    expect(checkCalls()).toBe(1)
  })

  it("skips the round while the Cowork info cannot be loaded, and retries", async () => {
    coworkInfoResult = () => {
      throw new Error("network down")
    }
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(coworkInfoCalls()).toBe(1)
    expect(checkCalls()).toBe(0)

    // The server is back with updates disabled: the next try asks again and
    // still doesn't check.
    coworkInfoResult = () => ({ product: "Cowork", updateDisabled: true })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(coworkInfoCalls()).toBe(2)
    expect(checkCalls()).toBe(0)
  })
})

describe("UpdateProvider — stale cache after an upgrade", () => {
  it("drops a cached release once the app is running a different version", async () => {
    // The relaunch right after an update lands: the cache still advertises the
    // release, but it is now the version we are running. Left alone, the 6h
    // freshness guard would keep re-offering the just-installed update all day.
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.21.9", body: "", date: null },
      })
    )
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return {
          currentVersion: "0.21.9", // the upgrade landed
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: true,
          liveProgress: true,
        }
      }
      if (endpoint === "check_app_update") {
        return { currentVersion: "0.21.9", update: null }
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.9")
    )
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("none")
    )
    // Re-asked immediately rather than waiting out the interval, so the UI
    // isn't left blank for 6h.
    await waitFor(() => expect(checkCalls()).toBe(1))
  })

  it("keeps a cached release that still applies to the running version", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.21.9", body: "", date: null },
      })
    )
    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.7")
    )
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(checkCalls()).toBe(0)
    expect(localStorage.getItem(LAST_CHECK_KEY)).not.toBeNull()
  })

  it("falls back to /health when the status route 404s (older server)", async () => {
    // A newer client against an older server: the rejected status call must not
    // abort the whole refresh, or the version goes blank during an outage.
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") throw new Error("not implemented")
      if (endpoint === "health") return { version: "0.14.11" }
      if (endpoint === "check_app_update") throw new Error("manifest down")
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.14.11")
    )
    expect(call).toHaveBeenCalledWith("health", {}, { timeoutMs: 4000 })
  })
})

describe("UpdateProvider — cross-window cache", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it("adopts a result a sibling window recorded while we were idle", async () => {
    // Sibling writes a result AFTER we mounted. Our scheduler sees a fresh
    // timestamp and skips its own fetch — so it must take the sibling's answer,
    // otherwise this window shows no badge for the whole interval.
    render(availabilityTree())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("none")

    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "0.21.7",
        info: { version: "0.22.0", body: "sibling", date: null },
      })
    )
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    // Adopted, not re-fetched.
    expect(checkCalls()).toBe(0)
  })

  it("does not let an older cached result clobber a fresher one in memory", async () => {
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.22.0", body: "", date: null },
    })
    render(availabilityTree())
    await act(async () => {
      await Promise.resolve()
      await Promise.resolve()
    })
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.22.0")

    // A stale entry (e.g. a sibling window that has been offline) must lose to
    // the answer we already applied.
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() - 60_000,
        currentVersion: "0.21.7",
        info: null,
      })
    )
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
  })
})

describe("UpdateProvider — sibling window survives a backend restart", () => {
  it("stops advertising a release the backend is now running, without reloading", async () => {
    // Two windows on one server. The OTHER window drove the upgrade: it reloads
    // itself and clears the shared cache. THIS window never reloads — its
    // WebSocket just drops and reconnects — so the stale release lives only in
    // its memory, and the manifest is down so no check can correct it.
    let backendVersion = "0.21.7"
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return {
          currentVersion: backendVersion,
          selfUpdateSupported: true,
          capability: "supervised",
          runtime: "standalone",
          restartDelayMs: 2000,
          rollbackAvailable: true,
          liveProgress: true,
        }
      }
      if (endpoint === "check_app_update") {
        if (backendVersion === "0.21.7") {
          return {
            currentVersion: "0.21.7",
            update: { version: "0.21.9", body: "", date: null },
          }
        }
        throw new Error("manifest unreachable")
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")

    // The other window installs it: the server restarts on 0.21.9 and clears
    // the shared cache entry.
    backendVersion = "0.21.9"
    localStorage.removeItem(LAST_CHECK_KEY)

    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })

    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.9")
    )
    // Must clear from the in-memory baseline alone — there is no cache entry
    // left to compare against, and the recovery check fails.
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("none")
    )
  })

  it("keeps the release when a reconnect finds the same version (plain drop)", async () => {
    // An ordinary connection blip must not wipe a valid release.
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
    })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")

    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
  })
})

describe("UpdateProvider — reconnect during an in-flight status refresh", () => {
  it("re-queries after the old process answers instead of folding into its request", async () => {
    // The mount refresh is still in flight when the server self-updates and the
    // socket reconnects. Coalescing the reconnect into that request would pin
    // the version and capabilities to a process that no longer exists — and
    // nothing would ask again until the next reconnect, a manual check, or the
    // six-hour poll.
    let backendVersion = "0.21.7"
    const answer: Array<() => void> = []
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        // Captured per call, so the first round-trip still reports the version
        // that was current when it was issued.
        const version = backendVersion
        // The test decides when each answers, so the reconnect lands strictly
        // inside the first one.
        return new Promise((resolve) => {
          answer.push(() =>
            resolve({
              currentVersion: version,
              selfUpdateSupported: true,
              capability: "supervised",
              runtime: "standalone",
              restartDelayMs: 2000,
              rollbackAvailable: false,
              liveProgress: true,
            })
          )
        })
      }
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())
    await waitFor(() => expect(answer.length).toBe(1))

    // The backend restarts onto a new version while we're still waiting.
    backendVersion = "0.21.9"
    await act(async () => {
      fireReconnect()
      await Promise.resolve()
    })
    // Nothing new can be asked yet — the follow-up is owed, not issued.
    expect(answer.length).toBe(1)

    // The old process finally replies, with its own now-obsolete version.
    await act(async () => {
      answer[0]()
      await Promise.resolve()
    })

    await waitFor(() => expect(answer.length).toBe(2))
    await act(async () => {
      answer[1]()
      await Promise.resolve()
    })
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("0.21.9")
    )
  })

  it("owes only one follow-up however many reconnects land mid-flight", async () => {
    // A flapping link is the reason this coalesces at all — the follow-up must
    // not become one round-trip per blip.
    const answer: Array<() => void> = []
    callImpl = async (endpoint: string) => {
      if (endpoint === "app_update_state") return snapshot
      if (endpoint === "app_update_status") {
        return new Promise((resolve) => {
          answer.push(() =>
            resolve({
              currentVersion: "0.21.7",
              selfUpdateSupported: true,
              capability: "supervised",
              runtime: "standalone",
              restartDelayMs: 2000,
              rollbackAvailable: false,
              liveProgress: true,
            })
          )
        })
      }
      if (endpoint === "check_app_update") {
        throw new Error("manifest unreachable")
      }
      throw new Error(`unexpected endpoint: ${endpoint}`)
    }

    render(availabilityTree())
    await waitFor(() => expect(answer.length).toBe(1))

    await act(async () => {
      fireReconnect()
      fireReconnect()
      fireReconnect()
      await Promise.resolve()
    })
    await act(async () => {
      answer[0]()
      await Promise.resolve()
    })

    await waitFor(() => expect(answer.length).toBe(2))
    await act(async () => {
      answer[1]()
      await Promise.resolve()
    })
    // Three blips, one follow-up.
    await act(async () => {
      await Promise.resolve()
    })
    expect(answer.length).toBe(2)
  })
})

describe("UpdateProvider — cross-window dismissal", () => {
  const cachedOffer = (at: number, version = "0.21.9") =>
    JSON.stringify({
      at,
      currentVersion: "0.21.7",
      info: { version, body: "notes", date: null },
    })

  it("adopts a sibling's dismissal even though the check cache is unchanged", async () => {
    // Both windows already hold the same answer, so "Later" next door writes
    // ONLY the dismissal key. Gating that read on a fresher cache timestamp
    // would leave this window showing the full accented badge for a release the
    // user already waved away.
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    expect(screen.getByTestId("dismissed").textContent).toBe("none")

    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })

  it("picks the dismissal up immediately from the storage event", async () => {
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )

    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: DISMISSED_KEY,
          newValue: "0.21.9",
        })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })

  it("ignores storage writes that are not the dismissal", async () => {
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    )

    // An unrelated key — including another backend's scoped dismissal, which
    // shares this origin — must not disturb what we hold.
    localStorage.removeItem(DISMISSED_KEY)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: `${DISMISSED_KEY}:remote-other`,
          newValue: "9.9.9",
        })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })

  it("follows a sibling onto the new release from storage events alone", async () => {
    // The two keys move together but NOT atomically: a window that finds a
    // newer release writes the cache first, then drops the now-stale
    // dismissal. Reacting only to the dismissal would un-mute this window
    // while it still held the OLD offer — a loud badge advertising the
    // previous version number and release notes. No visibilitychange here on
    // purpose: that is the escape hatch that hides this path.
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    )
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")

    // Sibling finds 0.22.0 — in the order the provider actually writes them.
    const fresh = cachedOffer(Date.now() + 1, "0.22.0")
    localStorage.setItem(LAST_CHECK_KEY, fresh)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_CHECK_KEY, newValue: fresh })
      )
      await Promise.resolve()
    })
    localStorage.removeItem(DISMISSED_KEY)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: DISMISSED_KEY, newValue: null })
      )
      await Promise.resolve()
    })

    // The badge is loud, and loud about the RIGHT release.
    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    expect(screen.getByTestId("dismissed").textContent).toBe("none")
  })

  it("adopts a sibling's fresh result from the cache event alone", async () => {
    // Nothing was ever dismissed here, so the cache write is the ONLY event.
    // Watching just the dismissal key would leave this window badge-less until
    // its next visibility change or the six-hour poll.
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(screen.getByTestId("available").textContent).toBe("none")

    const fresh = cachedOffer(Date.now())
    localStorage.setItem(LAST_CHECK_KEY, fresh)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_CHECK_KEY, newValue: fresh })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    // Adopted from the sibling, not re-fetched.
    expect(checkCalls()).toBe(0)
  })

  it("takes a sibling's different answer stamped in the same millisecond", async () => {
    // Two windows can complete checks a fraction of a millisecond apart and
    // still land on the same `at` — with different answers, if a release was
    // published between the two requests. A `<=` watermark would drop the
    // sibling's, while the dismissal read still un-muted us: a loud badge for
    // the older release and its stale notes.
    const at = Date.now()
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(at))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")

    const sameMs = cachedOffer(at, "0.22.0")
    localStorage.setItem(LAST_CHECK_KEY, sameMs)
    localStorage.removeItem(DISMISSED_KEY)
    await act(async () => {
      window.dispatchEvent(
        new StorageEvent("storage", { key: LAST_CHECK_KEY, newValue: sameMs })
      )
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    expect(screen.getByTestId("dismissed").textContent).toBe("none")
  })

  it("does not re-apply an identical entry stamped in the same millisecond", async () => {
    // The common case for an equal stamp is re-reading our OWN entry. Adopting
    // it again would hand consumers a fresh `available` object to re-render
    // against on every visibility change, so content — not the clock — has to
    // break the tie.
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    )
    const before = availableIdentities

    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(availableIdentities).toBe(before)
  })

  it("goes loud again for the next release a sibling finds", async () => {
    // A dismissal silences exactly one version. Adopting a sibling's newer
    // offer must leave the badge un-muted, or waving one release away would
    // silence every release after it.
    localStorage.setItem(DISMISSED_KEY, "0.21.9")
    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now()))
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
    )

    localStorage.setItem(LAST_CHECK_KEY, cachedOffer(Date.now() + 1, "0.22.0"))
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })

    expect(screen.getByTestId("available").textContent).toBe("0.22.0")
    // Still the old version, which no longer matches the offer — so the badge
    // is loud again (status-bar-update.tsx compares the two).
    expect(screen.getByTestId("dismissed").textContent).toBe("0.21.9")
  })
})

// ─── Automatic download (desktop) ─────────────────────────────────────────

describe("UpdateProvider — update channel (desktop)", () => {
  beforeEach(() => {
    desktop = true
  })

  it("passes on the channel the last check was on", async () => {
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(ctx!.channel).toBeNull()

    desktopChannel = "early"
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(ctx!.channel).toBe("early")

    desktopChannel = "stable"
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(ctx!.channel).toBe("stable")
  })

  it("checks again after a channel change instead of reusing a check on the old channel", async () => {
    updateModeResult = () => ({ mode: "off" })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    const before = checkCalls()

    // A check on Stable is still running when the user picks Early.
    let open!: () => void
    desktopCheckGate = new Promise<void>((r) => {
      open = r
    })
    desktopRelease = { version: "1.1.24", body: "stable", date: null }
    let oldCheck!: Promise<void>
    act(() => {
      oldCheck = ctx!.checkNow()
    })
    await waitFor(() => expect(checkCalls()).toBe(before + 1))

    desktopChannel = "early"
    desktopRelease = { version: "1.2.0", body: "early", date: null }
    let channelCheck!: Promise<void>
    act(() => {
      channelCheck = ctx!.checkNow({ silent: true, fresh: true })
    })
    await act(async () => {
      open()
      await oldCheck
      await channelCheck
    })

    expect(checkCalls()).toBe(before + 2)
    expect(ctx!.channel).toBe("early")
    expect(screen.getByTestId("available").textContent).toBe("1.2.0")
  })

  it("drops the old channel's offer when the check after a channel change fails", async () => {
    updateModeResult = () => ({ mode: "off" })
    desktopRelease = { version: "1.1.24", body: "stable", date: null }
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")

    desktopChannel = "early"
    desktopCheckFails = true
    await act(async () => {
      await ctx!.checkNow({ silent: true, fresh: true })
    })

    expect(screen.getByTestId("available").textContent).toBe("none")
    expect(ctx!.channel).toBeNull()
    expect(ctx!.checkError).toContain("manifest unreachable")
  })

  it("does not bring the old channel's offer back from the cache after a reload", async () => {
    updateModeResult = () => ({ mode: "off" })
    desktopRelease = { version: "1.1.24", body: "stable", date: null }
    const first = render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(localStorage.getItem(LAST_CHECK_KEY)).not.toBeNull()

    desktopChannel = "early"
    desktopCheckFails = true
    await act(async () => {
      await ctx!.checkNow({ silent: true, fresh: true })
    })
    // 存着的是旧通道查到的，换了通道就不能再拿来用
    expect(localStorage.getItem(LAST_CHECK_KEY)).toBeNull()

    first.unmount()
    ctx = null
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(screen.getByTestId("available").textContent).toBe("none")
    expect(ctx!.lastCheckedAt).toBeNull()
  })

  it("drops the old channel's offer when another window changes the channel", async () => {
    updateModeResult = () => ({ mode: "off" })
    desktopRelease = { version: "1.1.24", body: "stable", date: null }
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")

    // 另一个窗口换了通道：它把存着的结果删掉，这个窗口收到 storage 事件
    const oldValue = localStorage.getItem(LAST_CHECK_KEY)
    localStorage.removeItem(LAST_CHECK_KEY)
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: LAST_CHECK_KEY,
          oldValue,
          newValue: null,
        })
      )
    })

    expect(screen.getByTestId("available").textContent).toBe("none")
    expect(ctx!.channel).toBeNull()
  })

  it("discards its own check on the old channel when another window changes the channel", async () => {
    updateModeResult = () => ({ mode: "off" })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    const before = checkCalls()

    // 这个窗口正在查稳定版（答案已经是旧通道的了）
    let open!: () => void
    desktopCheckGate = new Promise<void>((r) => {
      open = r
    })
    desktopRelease = { version: "1.1.24", body: "stable", date: null }
    let oldCheck!: Promise<void>
    act(() => {
      oldCheck = ctx!.checkNow()
    })
    await waitFor(() => expect(checkCalls()).toBe(before + 1))

    // 另一个窗口这时换到抢先版：把存着的结果删了，再发换通道的信号
    desktopChannel = "early"
    desktopRelease = { version: "1.2.0", body: "early", date: null }
    const oldValue = localStorage.getItem(LAST_CHECK_KEY)
    localStorage.removeItem(LAST_CHECK_KEY)
    localStorage.setItem(CHANNEL_CHANGED_KEY, "1-a")
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: LAST_CHECK_KEY,
          oldValue,
          newValue: null,
        })
      )
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: CHANNEL_CHANGED_KEY,
          oldValue: null,
          newValue: "1-a",
        })
      )
    })
    await act(async () => {
      open()
      await oldCheck
    })
    await waitFor(() => expect(checkCalls()).toBe(before + 2))
    await waitFor(() => expect(ctx!.checking).toBe(false))

    // 旧通道的 1.1.24 没有写回缓存，也没有显示出来
    const stored = localStorage.getItem(LAST_CHECK_KEY)
    expect(stored === null || !stored.includes("1.1.24")).toBe(true)
    expect(screen.getByTestId("available").textContent).toBe("1.2.0")
    expect(ctx!.channel).toBe("early")
  })

  it("tells the other windows about a channel change even with nothing cached", async () => {
    updateModeResult = () => ({ mode: "off" })
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    expect(localStorage.getItem(LAST_CHECK_KEY)).toBeNull()
    expect(localStorage.getItem(CHANNEL_CHANGED_KEY)).toBeNull()

    await act(async () => {
      await ctx!.checkNow({ silent: true, fresh: true })
    })
    const first = localStorage.getItem(CHANNEL_CHANGED_KEY)
    expect(first).not.toBeNull()

    // 再换一次也要换一个值，不然别的窗口收不到 storage 事件
    await act(async () => {
      await ctx!.checkNow({ silent: true, fresh: true })
    })
    const second = localStorage.getItem(CHANNEL_CHANGED_KEY)
    expect(second).not.toBeNull()
    expect(second).not.toBe(first)
  })

  it("discards its first check when another window changes the channel before anything was cached", async () => {
    updateModeResult = () => ({ mode: "off" })
    let open!: () => void
    desktopCheckGate = new Promise<void>((r) => {
      open = r
    })
    desktopRelease = { version: "1.1.24", body: "stable", date: null }
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    const before = checkCalls()
    let firstCheck!: Promise<void>
    act(() => {
      firstCheck = ctx!.checkNow()
    })
    await waitFor(() => expect(checkCalls()).toBe(before + 1))
    // 这个窗口的第一次检查还没回来，缓存里什么都没有
    expect(localStorage.getItem(LAST_CHECK_KEY)).toBeNull()

    // 另一个窗口换到抢先版：删一个本来就没有的缓存不发事件，只有换通道的信号
    desktopChannel = "early"
    desktopRelease = { version: "1.2.0", body: "early", date: null }
    localStorage.setItem(CHANNEL_CHANGED_KEY, "1-a")
    act(() => {
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: CHANNEL_CHANGED_KEY,
          oldValue: null,
          newValue: "1-a",
        })
      )
    })
    await act(async () => {
      open()
      await firstCheck
    })
    await waitFor(() => expect(checkCalls()).toBe(before + 2))
    await waitFor(() => expect(ctx!.checking).toBe(false))

    const stored = localStorage.getItem(LAST_CHECK_KEY)
    expect(stored === null || !stored.includes("1.1.24")).toBe(true)
    expect(screen.getByTestId("available").textContent).toBe("1.2.0")
    expect(ctx!.channel).toBe("early")
  })

  it("has no channel on a server", async () => {
    desktop = false
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(ctx!.channel).toBeNull()
  })
})

describe("UpdateProvider — automatic download (desktop)", () => {
  const release = (version: string) => ({ version, body: "notes", date: null })
  const performCalls = () =>
    call.mock.calls.filter(([e]) => e === "perform_app_update").length

  beforeEach(() => {
    desktop = true
    desktopVersion = "1.1.23"
    desktopRelease = release("1.1.24")
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("starts the download once the first scheduled check finds a release", async () => {
    vi.useFakeTimers()
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    expect(performCalls()).toBe(0)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(performCalls()).toBe(1)
    // Cowork fork: marked as started on its own, for the update journal.
    const perform = call.mock.calls.find(
      ([e]) => e === "perform_app_update"
    ) as unknown[] | undefined
    expect(perform?.[1]).toEqual({ trigger: "auto" })
    expect(screen.getByTestId("lifecycle").textContent).toBe("downloading")
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
  })

  it("does not download the release the user put off", async () => {
    localStorage.setItem(DISMISSED_KEY, "1.1.24")
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe("idle")
    )
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(performCalls()).toBe(0)
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
  })

  it("does not download again the release a rollback just left", async () => {
    // Staged rollback to 1.1.22 while 1.1.23 runs.
    snapshot = { seq: 4, status: "ready_to_restart", version: "1.1.22" }
    const first = render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("1.1.23")
    )
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe(
        "ready_to_restart"
      )
    )
    await act(async () => {
      await ctx!.restart()
    })
    expect(localStorage.getItem(DISMISSED_KEY)).toBe("1.1.23")
    first.unmount()

    // Relaunched into 1.1.22; the check offers the release just left.
    ctx = null
    desktopVersion = "1.1.22"
    desktopRelease = release("1.1.23")
    snapshot = { seq: 0, status: "idle" }
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await waitFor(() =>
      expect(screen.getByTestId("current").textContent).toBe("1.1.22")
    )
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.23")
    expect(performCalls()).toBe(0)
  })

  it("does not start while an update is already staged", async () => {
    snapshot = { seq: 7, status: "ready_to_restart", version: "1.1.24" }
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe(
        "ready_to_restart"
      )
    )
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(performCalls()).toBe(0)
  })

  it("does not start before the backend state has been read", async () => {
    // The snapshot never answers: `idle` is only the placeholder.
    callQueue = [new Promise<AppUpdateState>(() => {})]
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
    expect(performCalls()).toBe(0)
  })

  it("does not download in a browser (server in-place update)", async () => {
    desktop = false
    checkResult = () => ({
      currentVersion: "0.21.7",
      update: { version: "0.21.9", body: "", date: null },
      selfUpdateSupported: true,
      liveProgress: true,
      runtime: "standalone",
      rollbackAvailable: false,
    })
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe("idle")
    )
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("0.21.9")
    expect(performCalls()).toBe(0)
  })

  it("does nothing when already up to date", async () => {
    desktopRelease = null
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe("idle")
    )
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("none")
    expect(performCalls()).toBe(0)
  })

  it("stays quiet when the download cannot start", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.error).mockClear()
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {})
    const failure = new Error("backend unreachable")
    performResult = () => {
      throw failure
    }
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe("idle")
    )
    await act(async () => {
      await ctx!.checkNow()
    })
    await waitFor(() =>
      expect(debug).toHaveBeenCalledWith(
        "[Update] background download did not start:",
        failure
      )
    )
    expect(performCalls()).toBe(1)
    expect(toast.error).not.toHaveBeenCalled()
    expect(screen.getByTestId("lifecycle").textContent).toBe("idle")
  })

  it("does not download on an answer restored from storage", async () => {
    vi.useFakeTimers()
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() - 60 * 60 * 1000,
        currentVersion: "1.1.23",
        info: release("1.1.24"),
      })
    )
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000)
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
    expect(checkCalls()).toBe(0)
    expect(performCalls()).toBe(0)
  })
})

describe("UpdateProvider — automatic download limits (desktop)", () => {
  const release = (version: string) => ({ version, body: "notes", date: null })
  const performCalls = () =>
    call.mock.calls.filter(([e]) => e === "perform_app_update").length
  const AUTO_KEY = "codeg.updateCheck.lastAutoDownloadAt"
  const HOUR = 60 * 60 * 1000
  const onPlatform = (platform: string) =>
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)

  beforeEach(() => {
    desktop = true
    desktopVersion = "1.1.23"
    desktopRelease = release("1.1.24")
    // 这两条限制只在 macOS 桌面版上算。
    onPlatform("MacIntel")
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const settle = async () => {
    render(availabilityTree())
    await waitFor(() => expect(ctx).not.toBeNull())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe("idle")
    )
  }

  it("does not download when automatic updates are off", async () => {
    updateModeResult = () => ({ mode: "off" })
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
    expect(performCalls()).toBe(0)
  })

  it("stops downloading once the settings page switches to off", async () => {
    await settle()
    await waitFor(() => expect(ctx?.updateMode).toBe("auto"))
    // The page saved "off"; the re-read before the download cannot get
    // through, so the event's value is what holds.
    updateModeResult = () => {
      throw new Error("shell unreachable")
    }
    await act(async () => {
      window.dispatchEvent(
        new CustomEvent("codeg:update-mode-changed", { detail: "off" })
      )
    })
    expect(ctx?.updateMode).toBe("off")
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(performCalls()).toBe(0)
  })

  it("downloads as automatic when the setting cannot be read", async () => {
    updateModeResult = () => {
      throw new Error("shell unreachable")
    }
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    await waitFor(() => expect(performCalls()).toBe(1))
  })

  it("does not download again within 6 hours of the last automatic one", async () => {
    localStorage.setItem(AUTO_KEY, String(Date.now() - 5 * HOUR))
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(performCalls()).toBe(0)
  })

  it("downloads again after 6 hours and records the time", async () => {
    const before = Date.now() - 7 * HOUR
    localStorage.setItem(AUTO_KEY, String(before))
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    await waitFor(() => expect(performCalls()).toBe(1))
    expect(Number(localStorage.getItem(AUTO_KEY))).toBeGreaterThan(before)
  })

  it("records the time of the first automatic download", async () => {
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    await waitFor(() => expect(performCalls()).toBe(1))
    expect(Number(localStorage.getItem(AUTO_KEY))).toBeGreaterThan(0)
  })

  it("a click on upgrade ignores both limits", async () => {
    updateModeResult = () => ({ mode: "off" })
    localStorage.setItem(AUTO_KEY, String(Date.now() - HOUR))
    await settle()
    await act(async () => {
      await ctx!.startUpdate()
    })
    expect(performCalls()).toBe(1)
    const perform = call.mock.calls.find(
      ([e]) => e === "perform_app_update"
    ) as unknown[] | undefined
    expect(perform?.[1]).toBeUndefined()
    expect(Number(localStorage.getItem(AUTO_KEY))).toBeLessThan(
      Date.now() - HOUR / 2
    )
  })

  it.each(["Win32", "Linux x86_64"])(
    "leaves %s downloading as before",
    async (platform) => {
      onPlatform(platform)
      updateModeResult = () => ({ mode: "off" })
      localStorage.setItem(AUTO_KEY, String(Date.now() - HOUR))
      await settle()
      await act(async () => {
        await ctx!.checkNow()
      })
      await waitFor(() => expect(performCalls()).toBe(1))
    }
  )

  // issue #413 第 4 行：这一版上次在这台电脑上没能启动、被自动退回了。
  it("does not download a release that did not start here last time", async () => {
    desktopBlocked = true
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
    expect(screen.getByTestId("blocked").textContent).toBe("true")
    expect(performCalls()).toBe(0)
    // 不记自动下载的时间：下一个更新的版本不该被 6 小时限频挡住。
    expect(localStorage.getItem(AUTO_KEY)).toBeNull()
  })

  it.each(["Win32", "Linux x86_64"])(
    "does not download a blocked release on %s either",
    async (platform) => {
      onPlatform(platform)
      desktopBlocked = true
      await settle()
      await act(async () => {
        await ctx!.checkNow()
      })
      expect(performCalls()).toBe(0)
    }
  )

  it("still installs a blocked release on a click", async () => {
    desktopBlocked = true
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(performCalls()).toBe(0)
    await act(async () => {
      await ctx!.startUpdate()
    })
    expect(performCalls()).toBe(1)
  })

  it("downloads a newer release that is not blocked", async () => {
    desktopBlocked = true
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(performCalls()).toBe(0)
    desktopBlocked = false
    desktopRelease = release("1.1.25")
    await act(async () => {
      await ctx!.checkNow()
    })
    expect(screen.getByTestId("blocked").textContent).toBe("false")
    await waitFor(() => expect(performCalls()).toBe(1))
  })

  // 返工：被拦的标记要跟着检查缓存走，刷新窗口、别的窗口带来的结果都认得。
  it("keeps the blocked mark in the shared check cache", async () => {
    desktopBlocked = true
    await settle()
    await act(async () => {
      await ctx!.checkNow()
    })
    const cached = JSON.parse(localStorage.getItem(LAST_CHECK_KEY) ?? "{}")
    expect(cached.info?.version).toBe("1.1.24")
    expect(cached.blocked).toBe(true)
  })

  it("still says blocked after a reload with a fresh cache", async () => {
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now(),
        currentVersion: "1.1.23",
        info: { version: "1.1.24", body: "notes", date: null },
        blocked: true,
      })
    )
    // 缓存还新鲜，不该再查；万一查了，查到的也不是被拦的，测试就会红。
    desktopRelease = null
    await settle()
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
    expect(screen.getByTestId("blocked").textContent).toBe("true")
    expect(checkCalls()).toBe(0)
    expect(performCalls()).toBe(0)
  })

  it("takes the blocked mark from a sibling window's check", async () => {
    desktopRelease = null
    await settle()
    expect(screen.getByTestId("blocked").textContent).toBe("false")
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() + 1,
        currentVersion: "1.1.23",
        info: { version: "1.1.24", body: "notes", date: null },
        blocked: true,
      })
    )
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.24")
    expect(screen.getByTestId("blocked").textContent).toBe("true")
    expect(performCalls()).toBe(0)
    // 别的窗口后来查到的是没被拦的另一版：提示跟着撤掉。
    localStorage.setItem(
      LAST_CHECK_KEY,
      JSON.stringify({
        at: Date.now() + 2,
        currentVersion: "1.1.23",
        info: { version: "1.1.25", body: "notes", date: null },
      })
    )
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"))
      await Promise.resolve()
    })
    expect(screen.getByTestId("available").textContent).toBe("1.1.25")
    expect(screen.getByTestId("blocked").textContent).toBe("false")
  })

  it("exposes the setting to the status bar", async () => {
    updateModeResult = () => ({ mode: "download" })
    render(availabilityTree())
    await waitFor(() => expect(ctx?.updateMode).toBe("download"))
  })
})

describe("UpdateProvider — idle restart still to come (desktop)", () => {
  const restartsCalls = () =>
    call.mock.calls.filter(([e]) => e === "update_restarts_when_idle").length
  const onPlatform = (platform: string) =>
    vi.spyOn(navigator, "platform", "get").mockReturnValue(platform)

  beforeEach(() => {
    desktop = true
    desktopVersion = "1.1.23"
    desktopRelease = null
    snapshot = { seq: 3, status: "ready_to_restart", version: "1.1.24" }
    onPlatform("MacIntel")
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("asks the desktop app once the update is ready", async () => {
    render(availabilityTree())
    await waitFor(() => expect(ctx?.restartsWhenIdle).toBe(true))
    expect(restartsCalls()).toBeGreaterThan(0)
  })

  it("passes on that it will not, after the tries ran out", async () => {
    restartsWhenIdleResult = () => false
    render(availabilityTree())
    await waitFor(() => expect(restartsCalls()).toBeGreaterThan(0))
    await waitFor(() => expect(ctx?.restartsWhenIdle).toBe(false))
  })

  it("asks again when the same version is ready once more", async () => {
    render(availabilityTree())
    await waitFor(() => expect(ctx?.restartsWhenIdle).toBe(true))
    // 自动重启装失败了，人又下了一次同一版：试满了，后端回 false。
    restartsWhenIdleResult = () => false
    await act(async () => {
      liveHandler?.({ seq: 4, status: "error", error: "install failed" })
      await Promise.resolve()
    })
    await waitFor(() => expect(ctx?.restartsWhenIdle).toBeNull())
    await act(async () => {
      liveHandler?.({ seq: 5, status: "ready_to_restart", version: "1.1.24" })
      await Promise.resolve()
    })
    await waitFor(() => expect(ctx?.restartsWhenIdle).toBe(false))
  })

  it("does not ask off macOS", async () => {
    vi.restoreAllMocks()
    onPlatform("Win32")
    render(availabilityTree())
    await waitFor(() =>
      expect(screen.getByTestId("lifecycle").textContent).toBe(
        "ready_to_restart"
      )
    )
    expect(restartsCalls()).toBe(0)
    expect(ctx?.restartsWhenIdle).toBeNull()
  })
})

describe("UpdateProvider — updated-to announcement (desktop)", () => {
  const announcementCalls = () =>
    call.mock.calls.filter(([e]) => e === "take_update_announcement").length

  beforeEach(() => {
    desktop = true
    desktopVersion = "1.1.24"
    desktopRelease = null
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it("shows one lasting toast for the version just put in place", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.success).mockClear()
    vi.useFakeTimers()
    announcementResult = () => ({ version: "1.1.24" })
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    expect(announcementCalls()).toBe(0)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1500)
    })
    expect(announcementCalls()).toBe(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
    const [title, opts] = vi.mocked(toast.success).mock.calls[0] as [
      string,
      { duration?: number; action?: { label: string } },
    ]
    expect(title).toBe("Updated to 1.1.24")
    expect(opts.duration).toBe(Infinity)
    expect(opts.action?.label).toBe("Release notes")
  })

  it("takes the announcement only once the wait for the confirmation is over", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.success).mockClear()
    vi.useFakeTimers()
    let confirmed: () => void = () => {}
    confirmationResult = () =>
      new Promise<null>((resolve) => {
        confirmed = () => resolve(null)
      })
    announcementResult = () => ({ version: "1.1.24" })
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500)
    })
    // 还在等确认：这时窗口关了，提示没被拿走，留给别的窗口。
    expect(announcementCalls()).toBe(0)
    await act(async () => {
      confirmed()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(announcementCalls()).toBe(1)
    expect(toast.success).toHaveBeenCalledTimes(1)
  })

  it("does not take the announcement when the window closes while waiting", async () => {
    vi.useFakeTimers()
    let confirmed: () => void = () => {}
    confirmationResult = () =>
      new Promise<null>((resolve) => {
        confirmed = () => resolve(null)
      })
    announcementResult = () => ({ version: "1.1.24" })
    const { unmount } = render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500)
    })
    unmount()
    await act(async () => {
      confirmed()
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(announcementCalls()).toBe(0)
  })

  it("shows one lasting warning when the new version was rolled back", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.warning).mockClear()
    vi.useFakeTimers()
    announcementResult = () => ({
      version: "1.1.23",
      result: "rolled_back",
      failed: "1.1.24",
    })
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500)
    })
    expect(announcementCalls()).toBe(1)
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledTimes(1)
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0] as [
      string,
      { duration?: number; action?: { label: string } },
    ]
    expect(title).toBe("1.1.24 did not start; went back to 1.1.23")
    expect(opts.duration).toBe(Infinity)
    expect(opts.action?.label).toBe("Release notes")
  })

  it("says updated for an applied result", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.success).mockClear()
    vi.mocked(toast.warning).mockClear()
    vi.useFakeTimers()
    announcementResult = () => ({ version: "1.1.24", result: "applied" })
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500)
    })
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(vi.mocked(toast.success).mock.calls[0][0]).toBe("Updated to 1.1.24")
    expect(toast.warning).not.toHaveBeenCalled()
  })

  it("shows nothing when there is nothing to announce", async () => {
    const { toast } = await import("sonner")
    vi.mocked(toast.success).mockClear()
    vi.useFakeTimers()
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(announcementCalls()).toBe(1)
    expect(toast.success).not.toHaveBeenCalled()
  })

  it("does not ask in a browser", async () => {
    desktop = false
    vi.useFakeTimers()
    render(availabilityTree())
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    expect(announcementCalls()).toBe(0)
  })
})
