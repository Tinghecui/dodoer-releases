import { act, renderHook } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  consumeContinuePrompt,
  continueSessionRef,
  parkContinuePrompt,
  resetContinuePromptsForTests,
  useContinuePromptDrain,
} from "./continue-handoff"

afterEach(() => {
  resetContinuePromptsForTests()
})

describe("continue handoff", () => {
  it("writes the session reference as login/id", () => {
    expect(continueSessionRef("member-a", "42")).toBe("member-a/42")
  })

  it("hands the prompt only to the tab and identity it was parked for, once", () => {
    parkContinuePrompt("tab-1", {
      prompt: "hello",
      agentType: "claude_code",
      folderId: 7,
    })
    // 别的标签拿不到。
    expect(
      consumeContinuePrompt("tab-2", { agentType: "claude_code", folderId: 7 })
    ).toBeNull()
    // 改挂还没落地（项目或智能体还是旧的）时不取。
    expect(
      consumeContinuePrompt("tab-1", { agentType: "claude_code", folderId: 3 })
    ).toBeNull()
    expect(
      consumeContinuePrompt("tab-1", { agentType: "codex", folderId: 7 })
    ).toBeNull()
    expect(
      consumeContinuePrompt("tab-1", { agentType: "claude_code", folderId: 7 })
    ).toBe("hello")
    expect(
      consumeContinuePrompt("tab-1", { agentType: "claude_code", folderId: 7 })
    ).toBeNull()
  })

  it("keeps only the last prompt parked for the same draft", () => {
    const id = { agentType: "claude_code" as const, folderId: 7 }
    parkContinuePrompt("tab-1", { prompt: "first", ...id })
    parkContinuePrompt("tab-1", { prompt: "second", ...id })
    expect(consumeContinuePrompt("tab-1", id)).toBe("second")
    expect(consumeContinuePrompt("tab-1", id)).toBeNull()
  })

  it("drains on mount, on the parked event, and when the retarget lands", () => {
    const onPrompt = vi.fn()
    // 挂上之前就存好的（新开的草稿）。
    parkContinuePrompt("tab-1", {
      prompt: "before mount",
      agentType: "claude_code",
      folderId: 7,
    })
    const { rerender } = renderHook(
      ({ folderId }: { folderId: number }) =>
        useContinuePromptDrain(
          "tab-1",
          { agentType: "claude_code", folderId },
          onPrompt
        ),
      { initialProps: { folderId: 7 } }
    )
    expect(onPrompt).toHaveBeenCalledTimes(1)
    expect(onPrompt).toHaveBeenLastCalledWith("before mount")

    // 已经挂着的草稿：靠事件来取；给别的标签的不理。
    act(() => {
      parkContinuePrompt("tab-9", {
        prompt: "other tab",
        agentType: "claude_code",
        folderId: 7,
      })
    })
    expect(onPrompt).toHaveBeenCalledTimes(1)
    act(() => {
      parkContinuePrompt("tab-1", {
        prompt: "while mounted",
        agentType: "claude_code",
        folderId: 7,
      })
    })
    expect(onPrompt).toHaveBeenCalledTimes(2)
    expect(onPrompt).toHaveBeenLastCalledWith("while mounted")

    // 复用的草稿要换到项目 8：换完之前不取，换完再取。
    act(() => {
      parkContinuePrompt("tab-1", {
        prompt: "after retarget",
        agentType: "claude_code",
        folderId: 8,
      })
    })
    expect(onPrompt).toHaveBeenCalledTimes(2)
    rerender({ folderId: 8 })
    expect(onPrompt).toHaveBeenCalledTimes(3)
    expect(onPrompt).toHaveBeenLastCalledWith("after retarget")
  })
})
