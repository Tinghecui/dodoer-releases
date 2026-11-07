import { beforeEach, describe, expect, it, vi } from "vitest"

import { buildFileTabId } from "@/lib/file-tab-id"
import type { WorkbenchApp } from "@/lib/types"
import { appSurfaceId } from "@/lib/workbench-apps"
import { useWorkbenchAppsStore } from "@/stores/workbench-apps-store"

import { applyAppsSnapshot, movedApp, withApp, withoutApp } from "./app-actions"

const mocks = vi.hoisted(() => ({
  open: new Set<string>(),
  release: vi.fn(),
}))

vi.mock("@/lib/api", () => ({}))
vi.mock("@/lib/browser/browser-tab-store", () => ({
  getBrowserTabState: (key: string) => (mocks.open.has(key) ? {} : null),
  releaseBrowserTab: mocks.release,
}))

const app = (id: string, url = `http://127.0.0.1/${id}`): WorkbenchApp => ({
  id,
  name: id,
  url,
  launch: "manual",
})

const storeKey = (a: WorkbenchApp) =>
  buildFileTabId({ kind: "browser", id: appSurfaceId(a) })

beforeEach(() => {
  mocks.open.clear()
  mocks.release.mockClear()
  useWorkbenchAppsStore.getState().reset()
})

describe("list edits", () => {
  const list = [app("a"), app("b"), app("c")]

  it("replaces an app in place, or adds it at the end", () => {
    const renamed = { ...app("b"), name: "B" }
    expect(withApp(list, renamed)).toEqual([list[0], renamed, list[2]])
    expect(withApp(list, app("d")).map((x) => x.id)).toEqual([
      "a",
      "b",
      "c",
      "d",
    ])
  })

  it("removes an app", () => {
    expect(withoutApp(list, "b").map((x) => x.id)).toEqual(["a", "c"])
  })

  it("moves an app, and leaves the list alone at either end", () => {
    expect(movedApp(list, "a", 1).map((x) => x.id)).toEqual(["b", "a", "c"])
    expect(movedApp(list, "c", -2).map((x) => x.id)).toEqual(["c", "a", "b"])
    expect(movedApp(list, "a", -1)).toBe(list)
    expect(movedApp(list, "c", 1)).toBe(list)
    expect(movedApp(list, "nope", 1)).toBe(list)
  })
})

describe("applyAppsSnapshot", () => {
  it("closes the pages of apps removed or moved to another address", () => {
    const kept = app("kept")
    const removed = app("removed")
    const moved = app("moved")
    useWorkbenchAppsStore
      .getState()
      .applySnapshot({ apps: [kept, removed, moved], statuses: [] })
    for (const a of [kept, removed, moved]) mocks.open.add(storeKey(a))

    applyAppsSnapshot({
      apps: [kept, { ...moved, url: "http://127.0.0.1:1/" }],
      statuses: [],
    })

    expect(mocks.release.mock.calls.map(([key]) => key)).toEqual([
      storeKey(removed),
      storeKey(moved),
    ])
    expect(useWorkbenchAppsStore.getState().apps.map((a) => a.id)).toEqual([
      "kept",
      "moved",
    ])
  })

  it("leaves alone a page that was never opened", () => {
    useWorkbenchAppsStore
      .getState()
      .applySnapshot({ apps: [app("a")], statuses: [] })
    applyAppsSnapshot({ apps: [], statuses: [] })
    expect(mocks.release).not.toHaveBeenCalled()
  })
})
