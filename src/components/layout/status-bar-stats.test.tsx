import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (select: (s: unknown) => unknown) =>
    select({ stats: { total_conversations: 15 } }),
}))
vi.mock("@/contexts/remote-connection-context", () => ({
  useRemoteConnection: () => ({
    connection: { name: "演示服务器", base_url: "https://example.test" },
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ routeId: "conversations", setRoute: vi.fn() }),
}))

import { StatusBarStats } from "./status-bar-stats"

const messages = {
  Folder: {
    statusBar: {
      stats: {
        openUsage: "Open usage",
        conversations: "{count} conversations",
      },
    },
  },
}

describe("StatusBarStats", () => {
  // 侧栏底部放不下时（远端窗口 + 桌面版多出的图标），会话数要在自己的格子里
  // 截断，不能溢出去压到右边的图标上（#990）。
  it("narrow foot: the conversation count truncates instead of overflowing", () => {
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <StatusBarStats />
      </NextIntlClientProvider>
    )
    const outer = container.firstElementChild as HTMLElement
    expect(outer.className).toContain("min-w-0")
    expect(outer.className).toContain("overflow-hidden")

    const button = screen.getByRole("button")
    expect(button.className).toContain("min-w-0")
    expect(button.className).not.toContain("shrink-0")

    const label = screen.getByText("15 conversations")
    expect(label.className).toContain("truncate")
    expect(button.querySelector("svg")?.getAttribute("class")).toContain(
      "shrink-0"
    )
  })
})
