import { renderHook } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/hooks/use-acp-agents", () => ({
  useAcpAgents: vi.fn(),
}))

import { useAcpAgents } from "@/hooks/use-acp-agents"
import type { AcpAgentInfo, AgentType } from "@/lib/types"
import { useSortedAvailableAgents } from "./use-sorted-available-agents"

const mockUseAcpAgents = vi.mocked(useAcpAgents)

const agent = (
  agent_type: AgentType,
  overrides: Partial<AcpAgentInfo> = {}
): AcpAgentInfo =>
  ({
    agent_type,
    enabled: true,
    available: true,
    installed_version: null,
    ...overrides,
  }) as AcpAgentInfo

beforeEach(() => {
  mockUseAcpAgents.mockReset()
  window.localStorage.clear()
})

// Cowork fork (AI QA #129).
describe("useSortedAvailableAgents", () => {
  it("ranks installed agents first for defaults but keeps the display order", () => {
    mockUseAcpAgents.mockReturnValue({
      agents: [
        agent("codex"),
        agent("gemini", { enabled: false, installed_version: "0.60.0" }),
        agent("grok"),
        agent("claude_code", { installed_version: "0.106.0" }),
      ],
      fresh: true,
      refresh: async () => {},
    })
    const { result } = renderHook(() => useSortedAvailableAgents())
    expect(result.current.sortedTypes).toEqual(["codex", "grok", "claude_code"])
    expect(result.current.defaultOrder).toEqual([
      "claude_code",
      "codex",
      "grok",
    ])
    // The cold-start seed is stored in the default order.
    expect(
      JSON.parse(
        window.localStorage.getItem("workspace:sorted-available-agents") ?? ""
      )
    ).toEqual(["claude_code", "codex", "grok"])
  })

  it("keeps the user's order when nothing is installed", () => {
    mockUseAcpAgents.mockReturnValue({
      agents: [agent("codex"), agent("claude_code")],
      fresh: true,
      refresh: async () => {},
    })
    const { result } = renderHook(() => useSortedAvailableAgents())
    expect(result.current.defaultOrder).toEqual(["codex", "claude_code"])
  })
})
