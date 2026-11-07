import { beforeEach, describe, expect, it } from "vitest"

import type { WorkbenchApp, WorkbenchAppStatus } from "@/lib/types"

import { markAppOpened, useWorkbenchAppsStore } from "./workbench-apps-store"

const app = (id: string): WorkbenchApp => ({
  id,
  name: id,
  url: `http://127.0.0.1/${id}`,
  launch: "manual",
})

const status = (id: string, reachable = false): WorkbenchAppStatus => ({
  id,
  reachable,
  process: "idle",
  managed: false,
})

const store = () => useWorkbenchAppsStore.getState()

beforeEach(() => store().reset())

describe("useWorkbenchAppsStore", () => {
  it("starts empty and not hydrated", () => {
    expect(store().hydrated).toBe(false)
    expect(store().apps).toEqual([])
    expect(store().selectedId).toBeNull()
  })

  it("takes a snapshot whole and selects the first app", () => {
    store().setLoadError("down")
    store().applySnapshot({
      apps: [app("a"), app("b")],
      statuses: [status("a", true), status("b")],
    })
    expect(store().hydrated).toBe(true)
    expect(store().loadError).toBeNull()
    expect(store().selectedId).toBe("a")
    expect(store().statuses.a.reachable).toBe(true)
  })

  it("keeps the selection while its app exists, else falls back to the first", () => {
    store().applySnapshot({ apps: [app("a"), app("b")], statuses: [] })
    store().select("b")
    store().applySnapshot({ apps: [app("b"), app("c")], statuses: [] })
    expect(store().selectedId).toBe("b")
    store().applySnapshot({ apps: [app("c")], statuses: [] })
    expect(store().selectedId).toBe("c")
    store().applySnapshot({ apps: [], statuses: [] })
    expect(store().selectedId).toBeNull()
  })

  it("ignores a selection of an app it does not have", () => {
    store().applySnapshot({ apps: [app("a")], statuses: [] })
    store().select("nope")
    expect(store().selectedId).toBe("a")
  })

  it("drops opened pages of apps that are gone", () => {
    store().applySnapshot({ apps: [app("a"), app("b")], statuses: [] })
    markAppOpened("a")
    markAppOpened("b")
    markAppOpened("a")
    expect(store().openedIds).toEqual(["a", "b"])
    store().applySnapshot({ apps: [app("b")], statuses: [] })
    expect(store().openedIds).toEqual(["b"])
  })

  it("replaces every status at once, or one at a time", () => {
    store().applySnapshot({
      apps: [app("a"), app("b")],
      statuses: [status("a"), status("b")],
    })
    store().applyStatuses([status("a", true)])
    expect(Object.keys(store().statuses)).toEqual(["a"])
    store().applyStatus(status("b", true))
    expect(store().statuses.b.reachable).toBe(true)
    expect(store().statuses.a.reachable).toBe(true)
  })
})
