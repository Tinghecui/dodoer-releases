import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  listWorkbenchApps,
  saveWorkbenchApps,
  startWorkbenchApp,
} from "@/lib/api"
import { subscribe } from "@/lib/platform"
import type {
  WorkbenchApp,
  WorkbenchAppStatus,
  WorkbenchAppsSnapshot,
} from "@/lib/types"
import { WORKBENCH_APPS_STATUS_EVENT } from "@/lib/workbench-apps"
import { useWorkbenchAppsStore } from "@/stores/workbench-apps-store"

import { AppsChromeActions, AppsPageTitle, AppsRouteLayer } from "./apps-page"

const route = vi.hoisted(() => ({ routeId: "apps" }))

vi.mock("@/lib/api", () => ({
  listWorkbenchApps: vi.fn(),
  saveWorkbenchApps: vi.fn(),
  startWorkbenchApp: vi.fn(),
  stopWorkbenchApp: vi.fn(),
  restartWorkbenchApp: vi.fn(),
  readWorkbenchAppLog: vi.fn().mockResolvedValue({ lines: [] }),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
  openUrl: vi.fn(),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ routeId: route.routeId }),
}))
vi.mock("sonner", () => ({
  toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() },
}))
vi.mock("@/lib/browser/use-browser-capabilities", () => ({
  useBrowserCapabilities: () => ({ available: true }),
}))
// The built-in browser itself is not what these tests are about: a marker
// naming the page it was given is enough.
vi.mock("@/components/browser/browser-tab-view", () => ({
  BrowserTabView: ({
    tab,
  }: {
    tab: { id: string; browser: { initialUrl: string } }
  }) => (
    <div
      data-testid="browser-view"
      data-tab-id={tab.id}
      data-url={tab.browser.initialUrl}
    />
  ),
}))

const mockList = vi.mocked(listWorkbenchApps)
const mockSave = vi.mocked(saveWorkbenchApps)
const mockStart = vi.mocked(startWorkbenchApp)

const JENNY: WorkbenchApp = {
  id: "jenny-loop",
  name: "Jenny board",
  url: "http://127.0.0.1:7500/",
  launch: "auto",
}
const BENCH: WorkbenchApp = {
  id: "benchself",
  name: "Bench board",
  url: "http://127.0.0.1:8377/",
  startCommand: "node bin/bench.mjs dashboard --port 8377",
  workingDir: "~/Projects/example-benchmark",
  launch: "manual",
}

const status = (
  id: string,
  patch: Partial<WorkbenchAppStatus> = {}
): WorkbenchAppStatus => ({
  id,
  reachable: false,
  process: "idle",
  managed: false,
  ...patch,
})

const snapshot = (
  apps: WorkbenchApp[],
  statuses: WorkbenchAppStatus[]
): WorkbenchAppsSnapshot => ({ apps, statuses })

function renderLayer() {
  const ui = () => (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AppsPageTitle />
      <AppsRouteLayer />
    </NextIntlClientProvider>
  )
  const result = render(ui())
  return { ...result, rerenderLayer: () => result.rerender(ui()) }
}

const item = (id: string) =>
  document.querySelector<HTMLElement>(`[data-app-item="${id}"]`)

async function openMenu(id: string) {
  const trigger = document.querySelector<HTMLElement>(`[data-app-menu="${id}"]`)
  if (!trigger) throw new Error(`no menu for ${id}`)
  await userEvent.click(trigger)
}

beforeEach(() => {
  vi.clearAllMocks()
  route.routeId = "apps"
  useWorkbenchAppsStore.getState().reset()
  useWorkbenchAppsStore.setState({ listOpen: true })
  localStorage.clear()
  mockList.mockResolvedValue(
    snapshot(
      [JENNY, BENCH],
      [status(JENNY.id, { reachable: true }), status(BENCH.id)]
    )
  )
})

describe("AppsRouteLayer", () => {
  it("lists the saved apps with their states and opens the first one", async () => {
    renderLayer()
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
    const jenny = item(JENNY.id)!
    expect(within(jenny).getByText("Jenny board")).toBeTruthy()
    expect(within(jenny).getByText(/127\.0\.0\.1:7500/)).toBeTruthy()
    expect(within(jenny).getByRole("img", { name: "Running" })).toBeTruthy()
    const bench = item(BENCH.id)!
    expect(within(bench).getByRole("img", { name: "Not running" })).toBeTruthy()
    expect(within(bench).getByText(/Manual start/)).toBeTruthy()

    // The first app answers, so its page is shown in the built-in browser.
    const view = await screen.findByTestId("browser-view")
    expect(view.dataset.url).toBe("http://127.0.0.1:7500/")
  })

  it("names the app on screen in the route's strip", async () => {
    renderLayer()
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
    expect(screen.getByText("Apps")).toBeTruthy()
    expect(screen.getAllByText("Jenny board").length).toBeGreaterThan(1)
  })

  it("offers Start for a manual app, and asks the backend to start it", async () => {
    mockStart.mockResolvedValue(
      status(BENCH.id, { process: "starting", managed: true })
    )
    renderLayer()
    await waitFor(() => expect(item(BENCH.id)).not.toBeNull())
    await userEvent.click(within(item(BENCH.id)!).getAllByRole("button")[0])

    expect(await screen.findByText("Bench board is not started")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Start" }))
    expect(mockStart).toHaveBeenCalledWith(BENCH.id)
    expect(await screen.findByText("Starting Bench board…")).toBeTruthy()
  })

  it("shows the page once a status event says the app answers", async () => {
    let onStatus: ((list: WorkbenchAppStatus[]) => void) | undefined
    vi.mocked(subscribe).mockImplementation(async (event, handler) => {
      if (event === WORKBENCH_APPS_STATUS_EVENT) {
        onStatus = handler as (list: WorkbenchAppStatus[]) => void
      }
      return () => {}
    })
    mockList.mockResolvedValue(snapshot([BENCH], [status(BENCH.id)]))
    renderLayer()
    expect(await screen.findByText("Bench board is not started")).toBeTruthy()
    expect(screen.queryByTestId("browser-view")).toBeNull()

    act(() => onStatus?.([status(BENCH.id, { reachable: true })]))
    const view = await screen.findByTestId("browser-view")
    expect(view.dataset.url).toBe("http://127.0.0.1:8377/")
  })

  it("says an app without a command is started elsewhere", async () => {
    mockList.mockResolvedValue(snapshot([JENNY], [status(JENNY.id)]))
    renderLayer()
    expect(await screen.findByText("Jenny board is not running")).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull()
  })

  it("explains a service that keeps failing", async () => {
    mockList.mockResolvedValue(
      snapshot(
        [BENCH],
        [
          status(BENCH.id, {
            process: "failed",
            problem: { kind: "gaveUp", attempts: 5 },
          }),
        ]
      )
    )
    renderLayer()
    expect(
      await screen.findByText("Bench board keeps failing to start")
    ).toBeTruthy()
    expect(screen.getByText(/5 times in a row/)).toBeTruthy()
  })

  it("adds an app through the form and selects it", async () => {
    mockSave.mockImplementation(async (apps) =>
      snapshot(
        apps,
        apps.map((app) => status(app.id))
      )
    )
    renderLayer()
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())

    await userEvent.click(screen.getByRole("button", { name: "Add app" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "Signals")
    await userEvent.type(
      within(dialog).getByLabelText("Address"),
      "127.0.0.1:8787"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    await waitFor(() => expect(mockSave).toHaveBeenCalledTimes(1))
    const saved = mockSave.mock.calls[0][0]
    expect(saved.slice(0, 2)).toEqual([JENNY, BENCH])
    expect(saved[2]).toMatchObject({
      name: "Signals",
      url: "http://127.0.0.1:8787",
      startCommand: null,
      launch: "auto",
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    expect(useWorkbenchAppsStore.getState().selectedId).toBe(saved[2].id)
  })

  it("refuses an address that is not http and saves nothing", async () => {
    renderLayer()
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
    await userEvent.click(screen.getByRole("button", { name: "Add app" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "Files")
    await userEvent.type(
      within(dialog).getByLabelText("Address"),
      "file:///etc/hosts"
    )
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    expect(within(dialog).getByRole("alert").textContent).toMatch(
      /http or https/
    )
    expect(mockSave).not.toHaveBeenCalled()
  })

  it("keeps the form open with what was typed when the save fails", async () => {
    mockSave.mockRejectedValue(new Error("disk full"))
    renderLayer()
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
    await userEvent.click(screen.getByRole("button", { name: "Add app" }))
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "Signals")
    await userEvent.type(within(dialog).getByLabelText("Address"), "x:1")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))
    await waitFor(() => expect(mockSave).toHaveBeenCalled())
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(
      (within(dialog).getByLabelText("Name") as HTMLInputElement).value
    ).toBe("Signals")
  })

  it("deletes an app after confirming", async () => {
    mockSave.mockImplementation(async (apps) =>
      snapshot(
        apps,
        apps.map((app) => status(app.id))
      )
    )
    renderLayer()
    await waitFor(() => expect(item(BENCH.id)).not.toBeNull())
    await openMenu(BENCH.id)
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete" })
    )
    const confirm = await screen.findByRole("alertdialog")
    expect(within(confirm).getByText("Delete Bench board?")).toBeTruthy()
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete" })
    )
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith([JENNY]))
    await waitFor(() => expect(item(BENCH.id)).toBeNull())
  })

  it("moves an app down the list", async () => {
    mockSave.mockImplementation(async (apps) =>
      snapshot(
        apps,
        apps.map((app) => status(app.id))
      )
    )
    renderLayer()
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
    await openMenu(JENNY.id)
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Move down" })
    )
    await waitFor(() => expect(mockSave).toHaveBeenCalledWith([BENCH, JENNY]))
  })

  it("is not drawn before the first visit, but keeps the statuses current", async () => {
    route.routeId = "tasks"
    renderLayer()
    await waitFor(() => expect(mockList).toHaveBeenCalled())
    expect(document.querySelector("[data-apps-route-layer]")).toBeNull()
    await waitFor(() =>
      expect(useWorkbenchAppsStore.getState().statuses[JENNY.id]).toBeTruthy()
    )
  })

  it("stays mounted, hidden and inert, while another route is up", async () => {
    const { rerenderLayer } = renderLayer()
    const view = await screen.findByTestId("browser-view")
    const layer = document.querySelector<HTMLElement>(
      "[data-apps-route-layer]"
    )!
    expect(layer.hasAttribute("inert")).toBe(false)

    route.routeId = "tasks"
    rerenderLayer()
    expect(layer.isConnected).toBe(true)
    expect(layer.hasAttribute("inert")).toBe(true)
    expect(layer.className).toMatch(/invisible/)
    // The page itself was not torn down: the same element is still there.
    expect(screen.getByTestId("browser-view")).toBe(view)

    route.routeId = "apps"
    rerenderLayer()
    expect(layer.hasAttribute("inert")).toBe(false)
    expect(screen.getByTestId("browser-view")).toBe(view)
  })

  it("keeps an opened page loaded while another app is on screen", async () => {
    mockList.mockResolvedValue(
      snapshot(
        [JENNY, BENCH],
        [
          status(JENNY.id, { reachable: true }),
          status(BENCH.id, { reachable: true }),
        ]
      )
    )
    renderLayer()
    const first = await screen.findByTestId("browser-view")
    await userEvent.click(within(item(BENCH.id)!).getAllByRole("button")[0])
    await waitFor(() =>
      expect(screen.getAllByTestId("browser-view")).toHaveLength(2)
    )
    expect(first.isConnected).toBe(true)
    const pane = document.querySelector<HTMLElement>(
      `[data-app-pane="${JENNY.id}"]`
    )!
    expect(pane.className).toMatch(/\bhidden\b/)
    // Nothing but the panes themselves in the page's slot: a positioned box
    // around a hidden pane would sit over the shown one and take its clicks.
    const slot = pane.closest("section")!
    expect(
      [...slot.children].every((el) => el.hasAttribute("data-app-pane"))
    ).toBe(true)
  })

  it("offers a retry when the list cannot be read", async () => {
    mockList.mockRejectedValueOnce(new Error("server down"))
    renderLayer()
    expect(await screen.findByText("Couldn't load the apps")).toBeTruthy()
    expect(screen.getByText("server down")).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
  })

  it("shows the empty state with an add button when there are no apps", async () => {
    mockList.mockResolvedValue(snapshot([], []))
    renderLayer()
    expect(await screen.findByText("No apps yet")).toBeTruthy()
    expect(screen.getAllByRole("button", { name: "Add app" }).length).toBe(2)
  })

  it("draws the list as a card on the page's right that the corner button folds", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AppsChromeActions buttonClassName="" iconClassName="" />
        <AppsRouteLayer />
      </NextIntlClientProvider>
    )
    await waitFor(() => expect(item(JENNY.id)).not.toBeNull())
    const page = document.querySelector("[data-apps-page]")!
    const list = document.querySelector("[data-apps-list]")!
    // After the page's own pane: the list sits on the right.
    expect(page.lastElementChild).toBe(list)
    expect(list.querySelector("nav")?.className).toContain("lg-card")

    const toggle = screen.getByRole("button", {
      name: "Show or hide the app list",
    })
    expect(toggle.getAttribute("aria-pressed")).toBe("true")
    await userEvent.click(toggle)
    expect(document.querySelector("[data-apps-list]")).toBeNull()
    expect(toggle.getAttribute("aria-pressed")).toBe("false")
    expect(localStorage.getItem("jenny:apps-list-open")).toBe("0")
    // The app's page stays on screen while the list is folded.
    expect(screen.getByTestId("browser-view")).toBeTruthy()

    await userEvent.click(toggle)
    expect(item(JENNY.id)).not.toBeNull()
  })
})
