import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpListAgents, listModelProviders } from "@/lib/api"
import { SYSTEM_INSTRUCTIONS_EDITOR_OFFERED } from "@/lib/cowork/features"
import type { AcpAgentInfo } from "@/lib/types"
import { AcpAgentSettings } from "./acp-agent-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
}))
// vitest runs as the source-named build (vitest.config.ts), where the editor
// is offered; this file is the Cowork build.
vi.mock("@/lib/cowork/brand", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  COWORK_BUILD: true,
}))

const claude = {
  agent_type: "claude_code",
  name: "Claude Code",
  registry_id: "claude-acp",
  registry_version: "0.1.0",
  installed_version: "0.1.0",
  description: "Claude Code",
  skills_capable: true,
  supports_custom_version: false,
  available: true,
  distribution_type: "npm",
  is_acp_adapter: false,
  enabled: true,
  sort_order: 0,
  env: {},
  config_json: null,
  config_file_path: null,
  system_instructions_file_path: "/home/test/.claude/CLAUDE.md",
  system_instructions_content: "# Be brief",
  model_provider_id: null,
  host_tools_agent_mode: false,
  custom_source: null,
  icon_url: null,
} as unknown as AcpAgentInfo

describe("System instructions in a Cowork build", () => {
  it("switches the editor off", () => {
    expect(SYSTEM_INSTRUCTIONS_EDITOR_OFFERED).toBe(false)
  })

  it("does not offer the editor, even when the server names the file", async () => {
    vi.mocked(acpListAgents).mockResolvedValue([claude])
    vi.mocked(listModelProviders).mockResolvedValue([])

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AcpAgentSettings />
      </NextIntlClientProvider>
    )

    await screen.findByRole("heading", { name: "Claude Code" })
    expect(screen.queryByText("System Instructions")).toBeNull()
    expect(screen.queryByText("CLAUDE.md")).toBeNull()
    expect(
      screen.queryByPlaceholderText(
        enMessages.AcpAgentSettings.systemInstructions.placeholder
      )
    ).toBeNull()
  })
})
