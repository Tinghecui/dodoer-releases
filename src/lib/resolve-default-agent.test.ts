import { describe, expect, it } from "vitest"

import {
  firstUsableAgent,
  installedFirst,
  resolveDefaultAgent,
} from "./resolve-default-agent"
import type { AgentType } from "./types"

// Cowork fork (AI QA #129): a new conversation must not default to an agent
// whose ACP adapter is not installed while another agent is ready.
const row = (
  agent_type: AgentType,
  installed_version: string | null,
  available = true
) => ({ agent_type, installed_version, available })

describe("installedFirst", () => {
  it("moves the installed agents ahead, keeping the user's order in each group", () => {
    expect(
      installedFirst([
        row("codex", null),
        row("gemini", "0.60.0"),
        row("grok", null),
        row("claude_code", "0.106.0"),
      ])
    ).toEqual(["gemini", "claude_code", "codex", "grok"])
  })

  it("keeps the order when nothing (or everything) is installed", () => {
    expect(
      installedFirst([row("codex", null), row("claude_code", null)])
    ).toEqual(["codex", "claude_code"])
    expect(
      installedFirst([row("codex", "2.6.0"), row("claude_code", "0.106.0")])
    ).toEqual(["codex", "claude_code"])
  })
})

describe("resolveDefaultAgent with the default order", () => {
  it("picks the installed Claude Code over an uninstalled Codex dragged first", () => {
    const sortedTypes = installedFirst([
      row("codex", null),
      row("claude_code", "0.106.0"),
    ])
    expect(
      resolveDefaultAgent({
        folderDefault: null,
        inherit: null,
        sortedTypes,
        fresh: true,
      })
    ).toEqual({ agentType: "claude_code", provisional: false })
  })

  it("falls back to the first agent when none is installed", () => {
    const sortedTypes = installedFirst([
      row("codex", null),
      row("claude_code", null),
    ])
    expect(
      resolveDefaultAgent({
        folderDefault: null,
        inherit: null,
        sortedTypes,
        fresh: true,
      }).agentType
    ).toBe("codex")
  })

  it("still honours an explicit folder default that is not installed", () => {
    expect(
      resolveDefaultAgent({
        folderDefault: "codex",
        inherit: null,
        sortedTypes: ["claude_code", "codex"],
        fresh: true,
      })
    ).toEqual({ agentType: "codex", provisional: false })
  })
})

describe("firstUsableAgent", () => {
  it("prefers an available installed agent, then any available one", () => {
    expect(
      firstUsableAgent([
        row("gemini", "0.60.0", false),
        row("codex", null),
        row("claude_code", "0.106.0"),
      ])?.agent_type
    ).toBe("claude_code")
    expect(
      firstUsableAgent([row("gemini", "0.60.0", false), row("codex", null)])
        ?.agent_type
    ).toBe("codex")
    expect(firstUsableAgent([row("codex", null, false)])).toBeUndefined()
  })
})
