/**
 * 智能体列表一个都没加载出来时，要显示「加载失败 + 原因 + 重试」（#542），
 * 不能显示空列表和「暂无可用 Agent」，看着像服务器上一个都没有。
 */
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { acpListAgents, listModelProviders } from "@/lib/api"
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
vi.mock("next/navigation", () => {
  const params = new URLSearchParams()
  return { useSearchParams: () => params }
})
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

const GEMINI: AcpAgentInfo = {
  agent_type: "gemini",
  skills_capable: true,
  registry_id: "gemini",
  registry_version: "0.60.0",
  supports_custom_version: true,
  name: "Gemini CLI",
  description: "",
  available: true,
  distribution_type: "npx",
  is_acp_adapter: false,
  custom_source: null,
  enabled: true,
  sort_order: 0,
  installed_version: "0.60.0",
  host_tools_agent_mode: false,
  env: {},
  config_json: null,
  config_file_path: null,
  codex_auth_json: null,
  cline_secrets_json: null,
  codex_config_toml: null,
  codex_model_catalog: null,
  codex_sandbox_settings: null,
  grok_config_toml: null,
  grok_settings: null,
  hermes_config_yaml: null,
  cursor_cli_config_json: null,
  cursor_settings: null,
  model_provider_id: null,
  icon_url: null,
}

function renderPanel() {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AcpAgentSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => {})
  vi.mocked(listModelProviders).mockResolvedValue([])
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("AcpAgentSettings — 列表加载失败", () => {
  it("一个都没加载出来时显示加载失败和重试，不显示空列表", async () => {
    vi.mocked(acpListAgents).mockRejectedValueOnce(new Error("agents-boom"))
    renderPanel()

    expect(await screen.findByText("Failed to load")).toBeInTheDocument()
    expect(screen.getByText("agents-boom")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument()
    expect(screen.queryByText("No available agent.")).not.toBeInTheDocument()
    expect(screen.queryByText("Agent List")).not.toBeInTheDocument()

    // 撤掉故障后点重试，列表回来
    vi.mocked(acpListAgents).mockResolvedValueOnce([GEMINI])
    await userEvent.setup().click(screen.getByRole("button", { name: "Retry" }))

    await screen.findByText("Agent List")
    await waitFor(() =>
      expect(
        document.querySelector('[data-agent-type="gemini"]')
      ).not.toBeNull()
    )
    expect(screen.queryByText("Failed to load")).not.toBeInTheDocument()
    expect(acpListAgents).toHaveBeenCalledTimes(2)
  })
})
