import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { automationComputeNextRun } from "@/lib/api"

vi.mock("@/lib/api", () => ({
  automationComputeNextRun: vi.fn(),
}))

import { CronBuilderDialog } from "./cron-builder-dialog"

const mockNextRun = vi.mocked(automationComputeNextRun)

// 每个表达式对应的「下次运行」，时间是编的。
const NEXT: Record<string, string> = {
  "0 9 * * 1": "2026-11-23T09:00:00Z",
  "0 9 * * 3": "2026-11-25T09:00:00Z",
  "0 14 * * 3": "2026-11-25T14:00:00Z",
}
const shown = (iso: string) => new Date(iso).toLocaleString()

function renderBuilder() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CronBuilderDialog
        open
        onOpenChange={() => {}}
        cron="0 9 * * 1"
        timezone="Asia/Tokyo"
        onApply={() => {}}
      />
    </NextIntlClientProvider>
  )
}

describe("CronBuilderDialog — 下次运行预览", () => {
  beforeEach(() => {
    mockNextRun.mockReset()
  })

  it("改星期、改小时后按新表达式重算，结果回来前不挂着旧时间", async () => {
    // 每次调用都留一个手动放行的 promise，好看清结果回来之前界面显示什么。
    const pending = new Map<string, (v: string) => void>()
    mockNextRun.mockImplementation(
      (cron: string) =>
        new Promise<string | null>((resolve) => {
          pending.set(cron, resolve)
        })
    )
    const release = async (cron: string) => {
      await waitFor(() => expect(pending.has(cron)).toBe(true))
      await act(async () => {
        pending.get(cron)!(NEXT[cron])
      })
    }

    renderBuilder()
    await release("0 9 * * 1")
    expect(
      await screen.findByText(shown(NEXT["0 9 * * 1"]), { exact: false })
    ).toBeInTheDocument()

    // 点周三：表达式变了，旧的周一时间立刻不能再显示。
    fireEvent.click(screen.getByRole("button", { name: "Wednesday" }))
    expect(
      screen.queryByText(shown(NEXT["0 9 * * 1"]), { exact: false })
    ).toBeNull()
    expect(
      screen.getByText(enMessages.Automations.cronNextRunComputing, {
        exact: false,
      })
    ).toBeInTheDocument()
    await release("0 9 * * 3")
    expect(mockNextRun).toHaveBeenLastCalledWith("0 9 * * 3", "Asia/Tokyo")
    expect(
      await screen.findByText(shown(NEXT["0 9 * * 3"]), { exact: false })
    ).toBeInTheDocument()

    // 小时改成 14。
    fireEvent.change(screen.getByLabelText("Hour"), { target: { value: "14" } })
    expect(
      screen.queryByText(shown(NEXT["0 9 * * 3"]), { exact: false })
    ).toBeNull()
    await release("0 14 * * 3")
    expect(mockNextRun).toHaveBeenLastCalledWith("0 14 * * 3", "Asia/Tokyo")
    expect(
      await screen.findByText(shown(NEXT["0 14 * * 3"]), { exact: false })
    ).toBeInTheDocument()
  })

  it("预览里写明时区", async () => {
    mockNextRun.mockResolvedValue(NEXT["0 9 * * 1"])
    renderBuilder()
    expect(await screen.findByText("Asia/Tokyo")).toBeInTheDocument()
  })
})
