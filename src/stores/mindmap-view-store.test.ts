import { beforeEach, describe, expect, it, vi } from "vitest"

/** A fresh store, as a new window would read it from storage. */
async function freshStore() {
  vi.resetModules()
  const { useMindMapViewStore } = await import("./mindmap-view-store")
  return useMindMapViewStore
}

beforeEach(() => {
  window.localStorage.clear()
})

describe("mind map view store", () => {
  it("opens on the mind map and remembers the canvases view", async () => {
    let store = await freshStore()
    expect(store.getState().mode).toBe("mindmap")
    store.getState().setMode("boards")
    store = await freshStore()
    expect(store.getState().mode).toBe("boards")
  })

  it("remembers the project and each project's folds", async () => {
    let store = await freshStore()
    store.getState().setProject(4)
    store.getState().toggleCollapsed("frontend")
    store.getState().toggleCollapsed("docs")
    store.getState().setProject(7)
    expect([...store.getState().collapsed]).toEqual([])
    store.getState().toggleCollapsed("backend")

    store = await freshStore()
    expect(store.getState().projectId).toBe(7)
    expect([...store.getState().collapsed]).toEqual(["backend"])
    store.getState().setProject(4)
    expect([...store.getState().collapsed].sort()).toEqual(["docs", "frontend"])
  })

  it("forgets a project's folds once all are open", async () => {
    const store = await freshStore()
    store.getState().setProject(4)
    store.getState().toggleCollapsed("frontend")
    store.getState().toggleCollapsed("frontend")
    expect(window.localStorage.getItem("jenny:mindmap-collapsed:v1:4")).toBe(
      null
    )
  })

  it("starts each project with the default number of leaves", async () => {
    const store = await freshStore()
    store.getState().setProject(4)
    store.getState().showMore("frontend", 24, 8)
    expect(store.getState().leafLimits.get("frontend")).toBe(32)
    store.getState().setProject(5)
    expect(store.getState().leafLimits.size).toBe(0)
  })

  it("opens a breadcrumb's category: map mode, its project, path unfolded", async () => {
    const store = await freshStore()
    store.getState().setMode("boards")
    store.getState().setProject(4)
    store.getState().setCollapsed(["ui", "css", "api"])
    store.getState().focusCategory(4, ["ui", "css"])
    const state = store.getState()
    expect(state.mode).toBe("mindmap")
    expect(state.projectId).toBe(4)
    expect([...state.collapsed]).toEqual(["api"])
    expect(state.focus?.categoryId).toBe("css")
    state.clearFocus()
    expect(store.getState().focus).toBeNull()
  })

  it("ignores storage it cannot read", async () => {
    window.localStorage.setItem("jenny:canvas-mode:v1", "spaceship")
    window.localStorage.setItem("jenny:mindmap-project:v1", "-3")
    window.localStorage.setItem("jenny:mindmap-collapsed:v1:4", "{not json")
    let store = await freshStore()
    expect(store.getState().mode).toBe("mindmap")
    expect(store.getState().projectId).toBe(null)

    window.localStorage.setItem("jenny:mindmap-project:v1", "4")
    store = await freshStore()
    expect(store.getState().projectId).toBe(4)
    expect(store.getState().collapsed.size).toBe(0)
  })
})
