import { cleanup, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it } from "vitest"

import type { ModelSwitchInfo } from "@/lib/types"
import { ModelSwitchLines } from "./model-switch-lines"

afterEach(() => cleanup())

const APPLIED: ModelSwitchInfo = {
  id: "s1",
  config_id: "model",
  phase: "applied",
  from_value: "opus",
  from_name: "Opus",
  to_value: "fable",
  to_name: "Fable",
  at: "2026-11-15T06:30:00Z",
}

function renderLines(switches: ModelSwitchInfo[]) {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={{}}>
      <ModelSwitchLines switches={switches} />
    </NextIntlClientProvider>
  )
}

describe("ModelSwitchLines", () => {
  it("reads each switch with its time, a failure in the error color", () => {
    const failed: ModelSwitchInfo = {
      ...APPLIED,
      id: "s2",
      phase: "failed",
      failure: "no_answer",
    }
    renderLines([APPLIED, failed])
    const [applied, failure] = screen.getAllByRole("note")
    expect(applied).toHaveTextContent(
      /^已切换模型：Opus → Fable（从下一条消息起）· \d{2}:\d{2}$/
    )
    expect(applied).toHaveAttribute("data-phase", "applied")
    expect(failure).toHaveTextContent(
      "切换到 Fable 失败：agent 10 秒内没有回应，仍在用 Opus"
    )
    expect(failure.querySelector(".text-destructive")).not.toBeNull()
  })

  it("draws nothing without a switch", () => {
    const { container } = renderLines([])
    expect(container).toBeEmptyDOMElement()
  })
})
