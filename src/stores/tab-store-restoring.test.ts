import { beforeEach, describe, expect, it, vi } from "vitest"

import { listOpenedTabs } from "@/lib/api"
import { resetTabStore, useTabStore } from "./tab-store"

vi.mock("@/lib/api", () => ({
  listOpenedTabs: vi.fn(),
  saveOpenedTabs: vi.fn(),
  getFolderConversation: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(),
  onTransportReconnect: vi.fn(),
}))

const listMock = vi.mocked(listOpenedTabs)

beforeEach(() => {
  localStorage.clear()
  listMock.mockReset()
  resetTabStore()
})

// 工作区重新挂上时 tabsHydrated 已经是 true，要靠 tabsRestoring 知道又在读
// 标签，读完之前开的标签会被盖掉（#1332）。
describe("tabsRestoring", () => {
  it("每次读标签都先变 true，读完变回 false（第二次挂上也一样）", async () => {
    let release: (v: { version: number; items: [] }) => void = () => {}
    listMock.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    expect(useTabStore.getState().tabsRestoring).toBe(false)
    useTabStore.getState().hydrate()
    expect(useTabStore.getState().tabsRestoring).toBe(true)
    release({ version: 1, items: [] })
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsHydrated).toBe(true)
    )
    expect(useTabStore.getState().tabsRestoring).toBe(false)

    // 第二次挂上：tabsHydrated 一直是 true，tabsRestoring 照样标出来
    useTabStore.getState().hydrate()
    expect(useTabStore.getState().tabsHydrated).toBe(true)
    expect(useTabStore.getState().tabsRestoring).toBe(true)
    release({ version: 1, items: [] })
    await vi.waitFor(() =>
      expect(useTabStore.getState().tabsRestoring).toBe(false)
    )
  })

  it("读到一半卸下也不会一直停在 true", () => {
    listMock.mockImplementation(() => new Promise(() => {}))
    const cancel = useTabStore.getState().hydrate()
    expect(useTabStore.getState().tabsRestoring).toBe(true)
    cancel()
    expect(useTabStore.getState().tabsRestoring).toBe(false)
  })
})
