import { beforeEach, describe, expect, it } from "vitest"
import {
  applyPrStatuses,
  loadPrStatusEnabled,
  setPrStatusEnabled,
  usePrStatusStore,
} from "./pr-status-store"

beforeEach(() => {
  usePrStatusStore.setState({ byFolder: new Map(), enabled: true })
  localStorage.clear()
})

describe("applyPrStatuses", () => {
  it("keeps the map (and each entry) when nothing changed", () => {
    applyPrStatuses([
      { folder_id: 1, status: { kind: "no_pr", branch: "feat" } },
      { folder_id: 2, status: { kind: "unavailable" } },
    ])
    const before = usePrStatusStore.getState().byFolder
    const entry = before.get(1)
    applyPrStatuses([
      { folder_id: 1, status: { kind: "no_pr", branch: "feat" } },
    ])
    expect(usePrStatusStore.getState().byFolder).toBe(before)

    applyPrStatuses([{ folder_id: 2, status: { kind: "no_pr", branch: "x" } }])
    const after = usePrStatusStore.getState().byFolder
    expect(after).not.toBe(before)
    expect(after.get(1)).toBe(entry)
    expect(after.get(2)).toEqual({ kind: "no_pr", branch: "x" })
  })
})

describe("the sidebar toggle", () => {
  it("defaults on and persists off", () => {
    expect(loadPrStatusEnabled()).toBe(true)
    setPrStatusEnabled(false)
    expect(usePrStatusStore.getState().enabled).toBe(false)
    expect(loadPrStatusEnabled()).toBe(false)
    setPrStatusEnabled(true)
    expect(loadPrStatusEnabled()).toBe(true)
  })
})
