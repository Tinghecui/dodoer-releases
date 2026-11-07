import { describe, expect, it } from "vitest"
import { diffConfigPreferences } from "./selector-reconcile"
import type { SessionConfigOptionInfo } from "./types"

const model: SessionConfigOptionInfo = {
  id: "model",
  name: "Model",
  kind: {
    type: "select",
    current_value: "grok-4.7",
    options: [
      { value: "grok-4.7", name: "Grok 4.7" },
      { value: "grok-4.5", name: "Grok 4.5" },
    ],
    groups: [
      { group: "x", name: "X", options: [{ value: "mini", name: "Mini" }] },
    ],
  },
}

describe("diffConfigPreferences", () => {
  it("returns nothing when the session already uses the picks", () => {
    expect(diffConfigPreferences({ model: "grok-4.7" }, [model])).toEqual([])
    expect(diffConfigPreferences(null, [model])).toEqual([])
  })

  it("reports an available pick that has not reached the agent", () => {
    expect(diffConfigPreferences({ model: "mini" }, [model])).toEqual([
      {
        configId: "model",
        name: "Model",
        wanted: "mini",
        available: true,
        currentName: "Grok 4.7",
      },
    ])
  })

  it("reports a pick the agent no longer offers as unavailable", () => {
    const [m] = diffConfigPreferences({ model: "grok-3" }, [model])
    expect(m.available).toBe(false)
    expect(m.currentName).toBe("Grok 4.7")
  })

  it("ignores prefs for options the session does not have", () => {
    expect(diffConfigPreferences({ effort: "max" }, [model])).toEqual([])
  })
})
