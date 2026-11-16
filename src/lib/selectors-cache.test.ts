import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  getSelectorsCacheVersion,
  resetSelectorsCacheForTests,
  selectorsCache,
  setCachedConfigValue,
  subscribeSelectorsCache,
} from "./selectors-cache"
import type { SessionConfigOptionInfo } from "./types"

// The saved connection behind this window: `null` for this machine (and the
// web build), a saved connection's id in a desktop window on a remote host.
const env = vi.hoisted(() => ({ remoteId: null as number | null }))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => env.remoteId,
}))

const STORAGE_KEY = "jenny:selectors-cache:v1"

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
    env.remoteId = null
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
    localStorage.setItem(STORAGE_KEY, "{not json")
    expect(selectorsCache.get("grok")).toBeUndefined()
  })

  it("keeps this machine and each remote host apart", () => {
    const listOf = (value: string): SessionConfigOptionInfo[] => [
      {
        ...options[0],
        kind: { ...options[0].kind, current_value: value },
      } as SessionConfigOptionInfo,
    ]
    const shown = () => {
      const kind = selectorsCache.get("codex")?.configOptions?.[0].kind
      return kind?.type === "select" ? kind.current_value : null
    }
    selectorsCache.set("codex", { modes: null, configOptions: listOf("a") })
    env.remoteId = 1
    selectorsCache.set("codex", { modes: null, configOptions: listOf("b") })
    env.remoteId = 2
    selectorsCache.set("codex", { modes: null, configOptions: null })

    // Apart in memory and again after a reload from storage.
    for (const reload of [false, true]) {
      if (reload) resetSelectorsCacheForTests()
      env.remoteId = null
      expect(shown()).toBe("a")
      env.remoteId = 1
      expect(shown()).toBe("b")
      env.remoteId = 2
      expect(selectorsCache.get("codex")?.configOptions).toBeNull()
    }

    // An offline pick in a remote window touches only that host's list.
    env.remoteId = 1
    setCachedConfigValue("codex", "model", "a")
    expect(shown()).toBe("a")
    env.remoteId = null
    setCachedConfigValue("codex", "model", "b")
    expect(shown()).toBe("b")
    env.remoteId = 1
    expect(shown()).toBe("a")
  })

  it("has nothing for a remote host it never saw, even with a local list", () => {
    selectorsCache.set("codex", { modes: null, configOptions: options })
    env.remoteId = 7
    expect(selectorsCache.get("codex")).toBeUndefined()
    expect(selectorsCache.has("codex")).toBe(false)
  })

  it("reads the cache saved before hosts were split as this machine's", () => {
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({ grok: { modes: null, configOptions: options } })
    )
    expect(selectorsCache.get("grok")?.configOptions?.[0].id).toBe("model")
    env.remoteId = 1
    expect(selectorsCache.get("grok")).toBeUndefined()
    selectorsCache.set("grok", { modes: null, configOptions: null })
    // The remote host writes its own key; the old one stays this machine's.
    expect(
      JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").grok.configOptions
    ).toHaveLength(1)
    expect(
      JSON.parse(localStorage.getItem(`${STORAGE_KEY}:remote-1`) ?? "{}")
    ).toEqual({ grok: { modes: null, configOptions: null } })
  })

  it("reads and writes only the original key without a remote host", () => {
    // The web build never has a remote connection, so this is its behavior
    // too: one key, the same one as before hosts were split.
    selectorsCache.set("grok", { modes: null, configOptions: options })
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe(STORAGE_KEY)
  })
})
