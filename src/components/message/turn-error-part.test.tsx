import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
} from "@/lib/adapters/ai-elements-adapter"

import { ContentPartsRenderer } from "./content-parts-renderer"
import {
  isTurnErrorGroup,
  type ResolvedMessageGroup,
} from "./message-list-view"
import {
  TurnErrorAgentProvider,
  TurnErrorLineProvider,
  TurnErrorRetryProvider,
} from "./turn-error-part"

/**
 * A failed turn closes on one muted line in the agent's own words — the
 * `turn_error` block a parser reads from the agent's record of the failure,
 * and the live stream appends when the adapter reports it. It must read as the
 * failure, never as a reply or as the yellow "System message" box.
 */

function group(parts: AdaptedContentPart[]): ResolvedMessageGroup {
  return { id: "g", role: "system", parts, resources: [], images: [] }
}

describe("a failed turn's line", () => {
  it("adapts a turn_error block into a turn-error part", () => {
    const adapted = adaptMessageTurn(
      {
        id: "turn-3",
        role: "system",
        blocks: [{ type: "turn_error", message: "API Error: 503" }],
        timestamp: "2026-10-10T00:00:00Z",
      },
      {
        attachedResources: "Attached resources",
        toolCallFailed: "Tool failed",
        pageHandoffName: () => "",
      }
    )
    expect(adapted.content).toEqual([
      { type: "turn-error", message: "API Error: 503" },
    ])
  })

  it("renders as a note carrying the agent's words", () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ContentPartsRenderer
          parts={[
            {
              type: "turn-error",
              message: "stream disconnected before completion",
            },
          ]}
          role="system"
        />
      </NextIntlClientProvider>
    )
    expect(screen.getByRole("note")).toHaveTextContent(
      "Turn failed: stream disconnected before completion"
    )
  })

  it("is a system group of its own only when nothing else is in it", () => {
    const line: AdaptedContentPart = { type: "turn-error", message: "x" }
    expect(isTurnErrorGroup(group([line]))).toBe(true)
    expect(isTurnErrorGroup(group([line, { type: "text", text: "y" }]))).toBe(
      false
    )
    expect(isTurnErrorGroup(group([]))).toBe(false)
  })
})

// #1120：底下的 Claude CLI 被杀、连接断了的失败，不再原样显示适配器的英文，
// 换成中文说明（原话放进悬停提示），旁边一个「重试」：重新连接，再把这一轮的
// 消息发一次。刷新后补回来的那一行（带同样的 kind）也一样。
describe("a lost connection's failure line", () => {
  const lost: AdaptedContentPart = {
    type: "turn-error",
    message: "The connection to Claude was lost.",
    kind: "connection_lost",
  }

  // 面板给的「重试」只对对话最后那一行（`lineId`）；每一行自己是哪一轮由
  // 消息列表给（`TurnErrorLineProvider`）。
  function renderLine(
    onRetry: (() => void) | null,
    lineId: string | null = "f1"
  ) {
    return render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <TurnErrorAgentProvider value="claude_code">
          <TurnErrorRetryProvider
            value={onRetry ? { lineId: "f1", retry: onRetry } : null}
          >
            <TurnErrorLineProvider value={lineId}>
              <ContentPartsRenderer parts={[lost]} role="system" />
            </TurnErrorLineProvider>
          </TurnErrorRetryProvider>
        </TurnErrorAgentProvider>
      </NextIntlClientProvider>
    )
  }

  it("keeps the kind through the adapter", () => {
    const adapted = adaptMessageTurn(
      {
        id: "cowork-turn-failure",
        role: "system",
        blocks: [
          {
            type: "turn_error",
            message: "The connection to Claude was lost.",
            kind: "connection_lost",
          },
        ],
        timestamp: "2026-11-21T00:00:00Z",
      },
      {
        attachedResources: "Attached resources",
        toolCallFailed: "Tool failed",
        pageHandoffName: () => "",
      }
    )
    expect(adapted.content).toEqual([lost])
  })

  it("explains it in Chinese, keeps the agent's words in the tooltip, and retries", () => {
    const onRetry = vi.fn()
    renderLine(onRetry)
    const note = screen.getByRole("note")
    expect(note).toHaveTextContent("与 Claude Code 的连接断了")
    expect(note).not.toHaveTextContent("The connection to Claude was lost.")
    expect(note.querySelector("[title]")?.getAttribute("title")).toBe(
      "The connection to Claude was lost."
    )
    fireEvent.click(screen.getByRole("button", { name: "重试" }))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it("has no retry where nothing can retry it", () => {
    renderLine(null)
    expect(screen.getByRole("note")).toHaveTextContent(
      "与 Claude Code 的连接断了"
    )
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull()
  })

  it("has no retry on an earlier failure line of the same kind", () => {
    // 更早那一轮的失败行：点了重发的会是最后那一轮的消息，不能给按钮。
    renderLine(vi.fn(), "f0")
    expect(screen.getByRole("note")).toHaveTextContent(
      "与 Claude Code 的连接断了"
    )
    expect(screen.queryByRole("button", { name: "重试" })).toBeNull()
    // 没在消息列表里（不知道是哪一轮）的也不给。
    renderLine(vi.fn(), null)
    expect(screen.queryAllByRole("button", { name: "重试" })).toHaveLength(0)
  })
})
