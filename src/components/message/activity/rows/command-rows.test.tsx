import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { AdaptedToolCallPart } from "@/lib/adapters/ai-elements-adapter"
import { ContentPartsRenderer } from "../../content-parts-renderer"

function renderParts(parts: AdaptedToolCallPart[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ContentPartsRenderer parts={parts} role="assistant" />
    </NextIntlClientProvider>
  )
}

function bash(
  id: string,
  command: string,
  over: Partial<AdaptedToolCallPart> = {}
): AdaptedToolCallPart {
  return {
    type: "tool-call",
    toolCallId: id,
    toolName: "Bash",
    input: JSON.stringify({ command }),
    output: "ok",
    state: "output-available",
    ...over,
  }
}

describe("command group trailing", () => {
  it("says all passed when every command succeeded", () => {
    renderParts([bash("c1", "ls"), bash("c2", "pwd")])
    expect(screen.getByText("all passed")).toBeInTheDocument()
  })

  // #1454：智能体被杀后刷新，被打断的命令没有结果、被标成中断，不能写「全部通过」。
  it("does not say all passed when a command was cut off", () => {
    renderParts([
      bash("c1", "sleep 600"),
      bash("c2", "dd if=/dev/zero bs=1M count=200000 | sha256sum", {
        output: undefined,
        toolStatus: "cancelled",
      }),
    ])
    expect(screen.queryByText("all passed")).toBeNull()
    // 被打断是终态：这组命令不能一直显示还在跑。
    expect(screen.queryByLabelText(/running/i)).toBeNull()
  })
})
