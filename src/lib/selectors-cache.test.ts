import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getSelectorsCacheVersion,
  resetSelectorsCacheForTests,
  selectorsCache,
  setCachedConfigValue,
  subscribeSelectorsCache,
} from "./selectors-cache"
import type { SessionConfigOptionInfo } from "./types"

const options: SessionConfigOptionInfo[] = [
  {
    id: "model",
    name: "Model",
    kind: {
      type: "select",
      current_value: "a",
      options: [
        { value: "a", name: "A" },
        { value: "b", name: "B" },
      ],
      groups: [],
    },
  },
]

describe("selectorsCache", () => {
  beforeEach(() => {
    localStorage.clear()
    resetSelectorsCacheForTests()
  })

  it("persists entries across a reload of the module state", () => {
    selectorsCache.set("grok", { modes: null, configOptions: options })
    resetSelectorsCacheForTests()
    expect(selectorsCache.has("grok")).toBe(true)
    expect(selectorsCache.get("grok")?.configOptions?.[0].id).toBe("model")
  })

  it("notifies subscribers on change", () => {
    const listener = vi.fn()
    subscribeSelectorsCache(listener)
    const before = getSelectorsCacheVersion()
    selectorsCache.set("codex", { modes: null, configOptions: null })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(getSelectorsCacheVersion()).toBe(before + 1)
  })

  it("stores a copy, not the caller's object", () => {
    const entry = { modes: null, configOptions: options }
    selectorsCache.set("grok", entry)
    entry.configOptions = null as unknown as SessionConfigOptionInfo[]
    expect(selectorsCache.get("grok")?.configOptions).not.toBeNull()
  })

  it("applies an offline pick only when the value exists", () => {
    selectorsCache.set("grok", { modes: null, configOptions: options })
    setCachedConfigValue("grok", "model", "b")
    const kind = selectorsCache.get("grok")?.configOptions?.[0].kind
    expect(kind?.type === "select" && kind.current_value).toBe("b")
    setCachedConfigValue("grok", "model", "zzz")
    const kind2 = selectorsCache.get("grok")?.configOptions?.[0].kind
    expect(kind2?.type === "select" && kind2.current_value).toBe("b")
  })

  it("survives corrupt storage", () => {
    localStorage.setItem("jenny:selectors-cache:v1", "{not json")
    expect(selectorsCache.get("grok")).toBeUndefined()
  })
})
