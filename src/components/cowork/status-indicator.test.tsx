import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({
  alerts: [] as { level: "error" | "warning" }[],
  tasks: [] as { status: string }[],
  update: null as null | Record<string, unknown>,
}))
vi.mock("@/contexts/alert-context", () => ({
  useAlertContext: () => ({ alerts: env.alerts }),
}))
vi.mock("@/contexts/task-context", () => ({
  useTaskContext: () => ({ tasks: env.tasks }),
}))
vi.mock("@/components/providers/update-provider", () => ({
  useAppUpdate: () => env.update,
}))
vi.mock("@/components/layout/status-bar", () => ({
  StatusBarRight: () => <div data-testid="status-right" />,
}))

import { StatusIndicator } from "./status-indicator"

function renderIndicator(locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <StatusIndicator className="chrome-btn" />
    </NextIntlClientProvider>
  )
}

const settled = {
  state: { status: "idle" },
  isUpdating: false,
  restartCountdown: null,
  isRestarting: false,
  available: null,
  dismissedVersion: null,
}

const q = (sel: string) => document.querySelector(sel)

describe("StatusIndicator", () => {
  beforeEach(() => {
    env.alerts = []
    env.tasks = []
    env.update = null
  })

  it("is one quiet button that opens the status items", async () => {
    renderIndicator()
    const button = screen.getByRole("button", { name: "Status" })
    expect(button.className).toContain("chrome-btn")
    expect(q("[data-status-alerts]")).toBeNull()
    expect(q("[data-status-update]")).toBeNull()
    expect(q("[data-status-busy]")).toBeNull()
    expect(screen.queryByTestId("status-right")).toBeNull()
    await userEvent.click(button)
    expect(await screen.findByTestId("status-right")).toBeInTheDocument()
  })

  it("counts alerts in the worst one's colour", () => {
    env.alerts = [{ level: "warning" }, { level: "warning" }]
    const view = renderIndicator()
    expect(q("[data-status-alerts]")).toHaveTextContent("2")
    expect(q("[data-status-alerts]")?.className).toContain("bg-amber-500")
    env.alerts = [{ level: "warning" }, { level: "error" }]
    view.rerender(
      <NextIntlClientProvider locale="en" messages={{}}>
        <StatusIndicator />
      </NextIntlClientProvider>
    )
    expect(q("[data-status-alerts]")?.className).toContain("bg-red-500")
    expect(
      screen.getByRole("button", { name: "Status · 2 alerts" })
    ).toBeInTheDocument()
  })

  it("dots an update to act on, but not a dismissed one", () => {
    env.update = { ...settled, available: { version: "1.4.0" } }
    const view = renderIndicator()
    expect(q("[data-status-update]")).not.toBeNull()
    view.unmount()

    env.update = {
      ...settled,
      available: { version: "1.4.0" },
      dismissedVersion: "1.4.0",
    }
    renderIndicator()
    expect(q("[data-status-update]")).toBeNull()
  })

  it("dots an update that is ready to restart", () => {
    env.update = { ...settled, state: { status: "ready_to_restart" } }
    renderIndicator()
    expect(q("[data-status-update]")).not.toBeNull()
  })

  it("lets the alert count take the dot's place", () => {
    env.alerts = [{ level: "error" }]
    env.update = { ...settled, available: { version: "1.4.0" } }
    renderIndicator()
    expect(q("[data-status-alerts]")).not.toBeNull()
    expect(q("[data-status-update]")).toBeNull()
  })

  it("spins while a task or an update is in flight", () => {
    env.tasks = [{ status: "completed" }, { status: "running" }]
    const view = renderIndicator()
    expect(q("[data-status-busy]")).not.toBeNull()
    view.unmount()

    env.tasks = []
    env.update = { ...settled, isUpdating: true }
    renderIndicator("zh-CN")
    expect(q("[data-status-busy]")).not.toBeNull()
    expect(
      screen.getByRole("button", { name: "状态 · 后台任务进行中" })
    ).toBeInTheDocument()
  })
})
