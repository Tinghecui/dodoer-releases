/**
 * 新建 MCP 时 Server ID 要合法（#1248）：带空格、斜杠、中文的 ID 会原样写进所有
 * 勾选的智能体配置，所以就地提示、不让建。
 * 卸载要先确认：一点就从所有智能体的配置里删掉，没有撤销。
 */
import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  mcpListMarketplaces,
  mcpRemoveServer,
  mcpScanLocal,
  mcpUpsertLocalServer,
} from "@/lib/api"
import type { LocalMcpServer } from "@/lib/types"

import { McpSettings, isValidMcpServerId } from "./mcp-settings"

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return Object.fromEntries(
    Object.entries(actual).map(([name, value]) => [
      name,
      typeof value === "function" ? vi.fn(() => new Promise(() => {})) : value,
    ])
  )
})
vi.mock("sonner", () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
  },
}))

const existing: LocalMcpServer = {
  id: "demo-mcp",
  spec: { type: "stdio", command: "echo", env: { DEMO_TOKEN: "s3cret" } },
  apps: ["claude_code", "codex"],
}

function renderPanel(servers: LocalMcpServer[] = [existing]) {
  vi.mocked(mcpScanLocal).mockResolvedValue({ servers, warnings: [] })
  vi.mocked(mcpListMarketplaces).mockResolvedValue([])
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <McpSettings />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("isValidMcpServerId", () => {
  it("只收字母、数字、_ . -，长度 1–64", () => {
    expect(isValidMcpServerId("qa-mcp")).toBe(true)
    expect(isValidMcpServerId("a.b_c-1")).toBe(true)
    expect(isValidMcpServerId("x".repeat(64))).toBe(true)
    expect(isValidMcpServerId("x".repeat(65))).toBe(false)
    expect(isValidMcpServerId("")).toBe(false)
    expect(isValidMcpServerId("bad id!")).toBe(false)
    expect(isValidMcpServerId("a/b")).toBe(false)
    expect(isValidMcpServerId("中文")).toBe(false)
  })
})

describe("McpSettings 新建", () => {
  it("非法 Server ID 就地提示、创建按钮不可点，也不调后端", async () => {
    const user = userEvent.setup()
    renderPanel([])
    await user.click(await screen.findByRole("button", { name: "New MCP" }))
    const input = screen.getByPlaceholderText(
      enMessages.McpSettings.local.serverIdPlaceholder
    )
    await user.type(input, "bad id!/中文")

    expect(
      screen.getByText(enMessages.McpSettings.local.serverIdInvalid)
    ).toBeInTheDocument()
    const create = screen.getByRole("button", { name: "Create" })
    expect(create).toBeDisabled()
    await user.click(create)
    expect(mcpUpsertLocalServer).not.toHaveBeenCalled()
  })
})

describe("McpSettings 卸载", () => {
  it("先弹确认框，取消后不调 mcpRemoveServer", async () => {
    const user = userEvent.setup()
    renderPanel()
    await user.click(await screen.findByRole("button", { name: "Uninstall" }))

    const dialog = await screen.findByRole("alertdialog")
    expect(within(dialog).getByText(/Claude Code/)).toBeInTheDocument()
    expect(within(dialog).getByText(/Codex CLI/)).toBeInTheDocument()
    expect(mcpRemoveServer).not.toHaveBeenCalled()

    await user.click(within(dialog).getByRole("button", { name: "Cancel" }))
    await waitFor(() =>
      expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument()
    )
    expect(mcpRemoveServer).not.toHaveBeenCalled()
  })

  it("确认后才卸载", async () => {
    const user = userEvent.setup()
    vi.mocked(mcpRemoveServer).mockResolvedValue(true)
    renderPanel()
    await user.click(await screen.findByRole("button", { name: "Uninstall" }))
    const dialog = await screen.findByRole("alertdialog")
    await user.click(
      within(dialog).getByRole("button", {
        name: enMessages.McpSettings.uninstallDialog.confirm,
      })
    )
    await waitFor(() =>
      expect(mcpRemoveServer).toHaveBeenCalledWith("demo-mcp")
    )
  })

  it("列表摘要不露出 env 的值", async () => {
    renderPanel()
    await screen.findByRole("button", { name: "Uninstall" })
    const items = screen.getAllByText("echo")
    for (const item of items) expect(item.textContent).not.toMatch(/s3cret/)
  })
})
