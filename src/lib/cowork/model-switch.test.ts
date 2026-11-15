import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  getConversationModelSwitches: vi.fn(),
}))
vi.mock("@/lib/api", () => api)

import { coworkText } from "@/lib/cowork/i18n"
import type { ModelSwitchInfo } from "@/lib/types"
import {
  appendModelSwitch,
  getModelSwitches,
  loadModelSwitches,
  modelSwitchChip,
  modelSwitchSentence,
  placeModelSwitches,
  resetModelSwitchesForTest,
} from "./model-switch"

const zh = (
  key: Parameters<typeof coworkText>[1],
  values?: Record<string, string>
) => coworkText("zh-CN", key, values)

function sw(over: Partial<ModelSwitchInfo> = {}): ModelSwitchInfo {
  return {
    id: "s1",
    config_id: "model",
    phase: "applied",
    from_value: "opus",
    from_name: "Opus",
    to_value: "fable",
    to_name: "Fable",
    at: "2026-11-15T06:30:00Z",
    ...over,
  }
}

afterEach(() => {
  resetModelSwitchesForTest()
  api.getConversationModelSwitches.mockReset()
})

describe("what a model switch says", () => {
  it("reads an applied switch as from → to, from the next message", () => {
    expect(modelSwitchSentence(zh, sw())).toBe(
      "已切换模型：Opus → Fable（从下一条消息起）"
    )
  })

  it("says why a failed one failed and which model is still in use", () => {
    const failed = sw({ phase: "failed", failure: "no_answer" })
    expect(modelSwitchSentence(zh, failed)).toBe(
      "切换到 Fable 失败：agent 10 秒内没有回应，仍在用 Opus"
    )
    const refused = sw({
      phase: "failed",
      failure: "agent_error",
      detail: "unknown model",
    })
    expect(modelSwitchSentence(zh, refused)).toBe(
      "切换到 Fable 失败：agent 报错（unknown model），仍在用 Opus"
    )
    // Not taken: the model the agent still reports is the one named.
    const kept = sw({
      phase: "failed",
      failure: "not_adopted",
      detail: "Sonnet",
    })
    expect(modelSwitchSentence(zh, kept)).toBe(
      "切换到 Fable 失败：agent 没有采用，仍在用 Sonnet"
    )
  })

  it("puts the switch under way on the picker's chip", () => {
    expect(modelSwitchChip(zh, sw({ phase: "pending" }))?.label).toBe(
      "正在切换到 Fable…"
    )
    expect(modelSwitchChip(zh, sw({ phase: "after_turn" }))).toEqual({
      label: "本轮 Opus · 下一条 Fable",
      hint: "这轮回复继续用 Opus，下一条消息起用 Fable",
    })
    expect(modelSwitchChip(zh, sw())).toBeNull()
    expect(modelSwitchChip(zh, null)).toBeNull()
  })
})

describe("where switches go in a thread", () => {
  const turns = [
    { id: "u1", timestamp: "2026-11-15T06:00:00Z" },
    { id: "u2", timestamp: "2026-11-15T07:00:00Z" },
  ]

  it("goes above the first message sent after it, or under everything", () => {
    const early = sw({ id: "a", at: "2026-11-15T05:59:00Z" })
    const between = sw({ id: "b", at: "2026-11-15T06:30:00Z" })
    const late = sw({ id: "c", at: "2026-11-15T07:01:00Z" })
    const placed = placeModelSwitches([early, between, late], turns, false)
    expect(placed.before.get("u1")).toEqual([early])
    expect(placed.before.get("u2")).toEqual([between])
    expect(placed.tail).toEqual([late])
  })

  it("leaves out a switch from history that is not loaded", () => {
    const early = sw({ id: "a", at: "2026-11-15T05:59:00Z" })
    const placed = placeModelSwitches([early], turns, true)
    expect(placed.before.size).toBe(0)
    expect(placed.tail).toEqual([])
  })
})

describe("the timeline store", () => {
  it("keeps the settled lines once each, in time order", async () => {
    const later = sw({ id: "b", at: "2026-11-15T06:40:00Z" })
    appendModelSwitch(7, later)
    appendModelSwitch(7, later)
    // A pick that was replaced, or one still under way, is no line.
    appendModelSwitch(7, sw({ id: "c", phase: "cancelled" }))
    appendModelSwitch(7, sw({ id: "d", phase: "pending" }))
    api.getConversationModelSwitches.mockResolvedValue([sw(), later])
    await loadModelSwitches(7)
    expect(getModelSwitches(7).map((s) => s.id)).toEqual(["s1", "b"])
    expect(getModelSwitches(8)).toEqual([])
    expect(getModelSwitches(null)).toEqual([])
  })

  it("shows nothing when the server cannot list them", async () => {
    api.getConversationModelSwitches.mockRejectedValue(new Error("404"))
    await loadModelSwitches(7)
    expect(getModelSwitches(7)).toEqual([])
  })
})
