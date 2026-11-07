import { beforeEach, describe, expect, it, vi } from "vitest"
import { getConversationTaxonomy } from "@/lib/api"
import type { ConversationTaxonomy } from "@/lib/conversation-taxonomy"
import { useConversationTaxonomyStore } from "./conversation-taxonomy-store"

vi.mock("@/lib/api", () => ({ getConversationTaxonomy: vi.fn() }))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))

const mockGet = vi.mocked(getConversationTaxonomy)

function taxonomy(folder_id: number, revision: number): ConversationTaxonomy {
  return {
    folder_id,
    revision,
    categories: [],
    assignments: {},
    reorganized_at: null,
    reorganize_summary: null,
  }
}

const store = () => useConversationTaxonomyStore.getState()

beforeEach(() => {
  store().reset()
  mockGet.mockReset()
})

describe("conversation taxonomy store", () => {
  it("keeps the newer revision when answers arrive out of order", () => {
    store().accept(taxonomy(1, 5))
    store().accept(taxonomy(1, 4))
    expect(store().byFolder[1].taxonomy?.revision).toBe(5)
    store().accept(taxonomy(1, 6))
    expect(store().byFolder[1].taxonomy?.revision).toBe(6)
  })

  it("loads, and reports a failure without losing what it holds", async () => {
    mockGet.mockResolvedValueOnce(taxonomy(1, 2))
    await store().fetch(1)
    expect(store().byFolder[1]).toMatchObject({
      loading: false,
      error: null,
      taxonomy: { revision: 2 },
    })

    mockGet.mockRejectedValueOnce(new Error("socket closed"))
    await store().fetch(1)
    expect(store().byFolder[1].error).toContain("socket closed")
    expect(store().byFolder[1].taxonomy?.revision).toBe(2)
    expect(store().byFolder[1].loading).toBe(false)
  })

  it("refetches on a broadcast only when it is ahead, for maps it holds", async () => {
    mockGet.mockResolvedValue(taxonomy(1, 3))
    await store().fetch(1)
    mockGet.mockClear()

    store().handleChanged({ folder_id: 1, revision: 3 })
    store().handleChanged({ folder_id: 9, revision: 1 })
    expect(mockGet).not.toHaveBeenCalled()

    mockGet.mockResolvedValue(taxonomy(1, 4))
    store().handleChanged({ folder_id: 1, revision: 4 })
    expect(mockGet).toHaveBeenCalledWith(1)
    await vi.waitFor(() =>
      expect(store().byFolder[1].taxonomy?.revision).toBe(4)
    )
  })

  it("drops an answer to a request made before a reset", async () => {
    let answer!: (t: ConversationTaxonomy) => void
    mockGet.mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
    const pending = store().fetch(1)
    store().reset()
    answer(taxonomy(1, 7))
    await pending
    expect(store().byFolder[1]).toBeUndefined()
  })
})
