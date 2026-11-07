import { describe, expect, it } from "vitest"

import type { WorkbenchApp, WorkbenchAppStatus } from "@/lib/types"

import {
  appAddressLabel,
  appBrowserTab,
  appDisplayState,
  appFromForm,
  appStartable,
  appSurfaceId,
  newAppId,
  normalizeAppUrl,
  staleAppSurfaces,
  validateAppForm,
  type AppFormValues,
} from "./workbench-apps"

const app = (patch: Partial<WorkbenchApp> = {}): WorkbenchApp => ({
  id: "jenny-loop",
  name: "Jenny",
  url: "http://127.0.0.1:7500/",
  launch: "auto",
  ...patch,
})

const status = (patch: Partial<WorkbenchAppStatus>): WorkbenchAppStatus => ({
  id: "jenny-loop",
  reachable: false,
  process: "idle",
  managed: false,
  ...patch,
})

const form = (patch: Partial<AppFormValues> = {}): AppFormValues => ({
  name: "Jenny",
  url: "http://127.0.0.1:7500/",
  startCommand: "",
  workingDir: "",
  launch: "auto",
  ...patch,
})

describe("appDisplayState", () => {
  it("is unknown until a status arrives", () => {
    expect(appDisplayState(undefined)).toBe("unknown")
  })

  it("is running whenever the address answers, whoever serves it", () => {
    expect(appDisplayState(status({ reachable: true }))).toBe("running")
    expect(
      appDisplayState(status({ reachable: true, process: "failed" }))
    ).toBe("running")
  })

  it("reads codeg's own process when nothing answers", () => {
    expect(appDisplayState(status({ process: "starting" }))).toBe("starting")
    expect(appDisplayState(status({ process: "running" }))).toBe("notAnswering")
    expect(appDisplayState(status({ process: "exited" }))).toBe("exited")
    expect(appDisplayState(status({ process: "failed" }))).toBe("failed")
    expect(appDisplayState(status({ process: "idle" }))).toBe("stopped")
  })
})

describe("appStartable", () => {
  it("needs a command with something in it", () => {
    expect(appStartable({ startCommand: "npm start" })).toBe(true)
    expect(appStartable({ startCommand: "   " })).toBe(false)
    expect(appStartable({ startCommand: null })).toBe(false)
    expect(appStartable({})).toBe(false)
  })
})

describe("appSurfaceId", () => {
  it("is stable for an app and fits the backend's tab id rule", () => {
    const id = appSurfaceId(app())
    expect(id).toBe(appSurfaceId(app({ name: "renamed" })))
    expect(id).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
  })

  it("stays within 64 characters for the longest app id", () => {
    expect(appSurfaceId(app({ id: "a".repeat(40) })).length).toBeLessThan(65)
  })

  it("changes with the address, so a new address gets a new surface", () => {
    expect(appSurfaceId(app())).not.toBe(
      appSurfaceId(app({ url: "http://127.0.0.1:7501/" }))
    )
  })
})

describe("appBrowserTab", () => {
  it("opens the app's address in a browser tab of its own", () => {
    const tab = appBrowserTab(app())
    expect(tab.kind).toBe("browser")
    expect(tab.id).toBe(`browser:${appSurfaceId(app())}`)
    expect(tab.title).toBe("Jenny")
    expect(tab.browser.initialUrl).toBe("http://127.0.0.1:7500/")
    expect(tab.folderId).toBeNull()
  })
})

describe("staleAppSurfaces", () => {
  it("names the surfaces of removed apps and of apps given another address", () => {
    const kept = app({ id: "kept" })
    const removed = app({ id: "removed" })
    const moved = app({ id: "moved" })
    const after = [kept, { ...moved, url: "http://127.0.0.1:9999/" }]
    expect(staleAppSurfaces([kept, removed, moved], after)).toEqual([
      appSurfaceId(removed),
      appSurfaceId(moved),
    ])
  })

  it("is empty when only names or commands changed", () => {
    const before = [app()]
    const after = [app({ name: "Other", startCommand: "x" })]
    expect(staleAppSurfaces(before, after)).toEqual([])
  })
})

describe("newAppId", () => {
  it("fits the backend's id rule and does not repeat", () => {
    const a = newAppId()
    expect(a).toMatch(/^[a-z0-9-]{1,40}$/)
    expect(newAppId()).not.toBe(a)
  })
})

describe("appAddressLabel", () => {
  it("shows host and port, and a path when there is one", () => {
    expect(appAddressLabel("http://127.0.0.1:7500/")).toBe("127.0.0.1:7500")
    expect(appAddressLabel("http://localhost:3000/board")).toBe(
      "localhost:3000/board"
    )
  })

  it("falls back to the text it was given", () => {
    expect(appAddressLabel("not a url")).toBe("not a url")
  })
})

describe("normalizeAppUrl", () => {
  it("reads a bare host:port as http", () => {
    expect(normalizeAppUrl(" 127.0.0.1:7500 ")).toBe("http://127.0.0.1:7500")
  })

  it("keeps an address that has a scheme", () => {
    expect(normalizeAppUrl("https://example.com/x")).toBe(
      "https://example.com/x"
    )
  })
})

describe("validateAppForm", () => {
  it("accepts a named http address", () => {
    expect(validateAppForm(form())).toBeNull()
    expect(validateAppForm(form({ url: "localhost:5600" }))).toBeNull()
  })

  it("names the first problem", () => {
    expect(validateAppForm(form({ name: "  " }))).toBe("nameRequired")
    expect(validateAppForm(form({ url: " " }))).toBe("urlRequired")
    expect(validateAppForm(form({ url: "ftp://host/" }))).toBe("urlInvalid")
    expect(validateAppForm(form({ url: "http://" }))).toBe("urlInvalid")
    expect(validateAppForm(form({ url: "file:///etc/hosts" }))).toBe(
      "urlInvalid"
    )
  })
})

describe("appFromForm", () => {
  it("trims the text and drops empty optional fields", () => {
    expect(
      appFromForm(
        "app-1",
        form({
          name: " Board ",
          url: "127.0.0.1:8000",
          startCommand: "  ",
          workingDir: "",
          launch: "manual",
        })
      )
    ).toEqual({
      id: "app-1",
      name: "Board",
      url: "http://127.0.0.1:8000",
      startCommand: null,
      workingDir: null,
      launch: "manual",
    })
  })

  it("keeps a command and its directory", () => {
    const made = appFromForm(
      "app-2",
      form({ startCommand: " npm start ", workingDir: " ~/x " })
    )
    expect(made.startCommand).toBe("npm start")
    expect(made.workingDir).toBe("~/x")
  })
})
