/**
 * #1555：一轮中途连接断了（智能体被杀），reducer 把这一轮没跑完的命令标成
 * `cancelled`。实时画面要把它画成「已中断」，和刷新后后端补的一样
 * （turn_failure.rs 的 mark_cut_off_calls），不能还当它在跑，也不能当它跑完了。
 */

import { describe, expect, it, vi } from "vitest"

import { buildStreamingTurnsFromLiveMessage } from "@/stores/conversation-runtime-store"
import type { LiveMessage } from "@/contexts/acp-connections-context"
import {
  adaptMessageTurn,
  type AdaptedToolCallPart,
} from "@/lib/adapters/ai-elements-adapter"
import { toolCallStatus } from "@/lib/activity/status"

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

function live(status: string, content: string | null): LiveMessage {
  return {
    id: "lm-1",
    role: "assistant",
    startedAt: 0,
    content: [
      {
        type: "tool_call",
        info: {
          tool_call_id: "call-dd",
          title: "Terminal",
          kind: "execute",
          status,
          content,
          raw_input: JSON.stringify({
            command: "dd if=/dev/zero of=/dev/null",
          }),
          raw_output_chunks: [],
          raw_output_total_bytes: 0,
          locations: null,
          meta: null,
          images: [],
        },
      },
    ],
  }
}

describe("buildStreamingTurnsFromLiveMessage — 被打断的命令", () => {
  it.each([
    ["没有输出、还在流式", null, true],
    ["已经有一段输出、还在流式", "1024+0 records in", true],
    ["已经有一段输出、提升到历史以后", "1024+0 records in", false],
  ])("%s的命令画成已中断", (_label, content, streaming) => {
    const built = buildStreamingTurnsFromLiveMessage(
      1,
      live("cancelled", content)
    )
    expect(built.inProgressToolCallIds.has("call-dd")).toBe(false)
    const parts = built.turns.flatMap(
      (turn) =>
        adaptMessageTurn(
          turn,
          {
            attachedResources: "Attached resources",
            toolCallFailed: "Tool failed",
            pageHandoffName: () => "page",
          },
          streaming,
          built.inProgressToolCallIds
        ).content
    )
    const call = parts.find(
      (part): part is AdaptedToolCallPart => part.type === "tool-call"
    )
    expect(call).toBeDefined()
    expect(toolCallStatus(call!)).toBe("cancelled")
  })
})

function callBlock(
  id: string,
  title: string,
  status: string,
  content: string | null = null,
  meta: Record<string, unknown> | null = null
): LiveMessage["content"][number] {
  return {
    type: "tool_call",
    info: {
      tool_call_id: id,
      title,
      kind: "other",
      status,
      content,
      raw_input: "{}",
      raw_output_chunks: [],
      raw_output_total_bytes: 0,
      locations: null,
      meta,
      images: [],
    },
  }
}

describe("buildStreamingTurnsFromLiveMessage — 被打断的图片和子智能体", () => {
  it("还没出图就被打断的图片生成画成失败，不一直转圈", () => {
    const built = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-img",
      role: "assistant",
      startedAt: 0,
      content: [callBlock("call-img", "Image generation", "cancelled")],
    })
    const image = built.turns
      .flatMap((turn) => turn.blocks)
      .find((block) => block.type === "image_generation")
    expect(image).toBeDefined()
    expect(image?.type === "image_generation" && image.status).toBe("failed")
  })

  it("被打断的子智能体算结束了，后面的调用不再归到它下面", () => {
    const built = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-agent",
      role: "assistant",
      startedAt: 0,
      content: [
        callBlock("agent-1", "Agent", "cancelled"),
        callBlock("call-after", "Read file '/w/b.txt'", "completed", "ok"),
      ],
    })
    const blocks = built.turns.flatMap((turn) => turn.blocks)
    // 没被吞进子智能体的调用会作为顶层的 tool_use 出现
    expect(
      blocks.some(
        (block) =>
          block.type === "tool_use" && block.tool_use_id === "call-after"
      )
    ).toBe(true)
    const agentResult = blocks.find(
      (block) => block.type === "tool_result" && block.tool_use_id === "agent-1"
    )
    expect(agentResult?.type === "tool_result" && agentResult.agent_stats).toBe(
      undefined
    )
  })

  it("子智能体里被打断的调用留下它的半截输出", () => {
    const built = buildStreamingTurnsFromLiveMessage(1, {
      id: "lm-agent-child",
      role: "assistant",
      startedAt: 0,
      content: [
        callBlock("agent-1", "Agent", "cancelled"),
        callBlock("child-1", "Read file '/w/a.txt'", "cancelled", "half", {
          claudeCode: { parentToolUseId: "agent-1" },
        }),
      ],
    })
    const agentResult = built.turns
      .flatMap((turn) => turn.blocks)
      .find(
        (block) =>
          block.type === "tool_result" && block.tool_use_id === "agent-1"
      )
    expect(
      agentResult?.type === "tool_result" &&
        agentResult.agent_stats?.tool_calls?.[0]?.output_preview
    ).toBe("half")
  })
})
