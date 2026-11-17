import { describe, expect, it } from "vitest"

import { draftAgentSettled } from "./draft-auto-connect"

// AI QA #436：新员工首屏的草稿标签页冷启动时猜成 Codex（provisional），
// 列表回来、纠正改成 Claude Code 之前不能先用 Codex 连。
describe("draftAgentSettled", () => {
  it("holds a draft whose agent is still the cold-start guess", () => {
    expect(
      draftAgentSettled({
        provisional: true,
        tabAgent: "codex",
        selectedAgent: "codex",
        connectAgent: "codex",
      })
    ).toBe(false)
  })

  it("holds while the panel or the debounce still lags behind the tab", () => {
    // 纠正刚把标签页改成 claude_code，面板的本地状态还是 codex
    expect(
      draftAgentSettled({
        provisional: false,
        tabAgent: "claude_code",
        selectedAgent: "codex",
        connectAgent: "codex",
      })
    ).toBe(false)
    // 本地状态跟上了，防抖还没到
    expect(
      draftAgentSettled({
        provisional: false,
        tabAgent: "claude_code",
        selectedAgent: "claude_code",
        connectAgent: "codex",
      })
    ).toBe(false)
  })

  it("lets a settled draft connect", () => {
    expect(
      draftAgentSettled({
        provisional: false,
        tabAgent: "claude_code",
        selectedAgent: "claude_code",
        connectAgent: "claude_code",
      })
    ).toBe(true)
    expect(
      draftAgentSettled({
        provisional: undefined,
        tabAgent: "claude_code",
        selectedAgent: "claude_code",
        connectAgent: "claude_code",
      })
    ).toBe(true)
  })
})
