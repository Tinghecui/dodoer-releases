import { type ReactElement } from "react"
import { render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, describe, expect, it, vi } from "vitest"

import {
  SessionDetailsCard,
  SessionDetailsContent,
} from "./session-details-content"
import { conversationStatusLabelKey } from "./conversation-status-label"
import type { DbConversationSummary, SessionStats } from "@/lib/types"
import { useCanceledTaskStore } from "@/stores/canceled-task-store"
import zhMessages from "@/i18n/messages/zh-CN.json"

vi.mock("@/components/agent-icon", () => ({
  AgentIcon: () => null,
}))

vi.mock("@/lib/api", () => ({
  getFolderConversation: vi.fn(),
}))

function summary(
  over: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id: 7,
    folder_id: 1,
    title: "我的会话",
    title_locked: false,
    agent_type: "claude_code",
    status: "cancelled",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 2,
    child_count: 0,
    created_at: "2026-06-10T10:00:00.000Z",
    updated_at: "2026-06-12T12:00:00.000Z",
    pinned_at: null,
    ...over,
  }
}

const stats: SessionStats = {
  total_usage: null,
  total_tokens: null,
  total_duration_ms: 0,
  context_window_used_tokens: null,
  context_window_max_tokens: null,
  context_window_usage_percent: null,
}

function renderZh(ui: ReactElement) {
  return render(
    <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

afterEach(() => {
  useCanceledTaskStore.setState({ conversationIds: new Set() })
})

describe("conversationStatusLabelKey", () => {
  it("非 cancelled 的状态照旧用 statusLabels", () => {
    expect(
      conversationStatusLabelKey({
        status: "completed",
        interrupted: false,
        taskCanceled: false,
      })
    ).toEqual({ scope: "statusLabels", key: "completed" })
  })

  it("cancelled 按被打断、取消了的任务、其他分开", () => {
    expect(
      conversationStatusLabelKey({
        status: "cancelled",
        interrupted: true,
        taskCanceled: true,
      })
    ).toEqual({ scope: "sidebar", key: "statusInterruptedBadge" })
    expect(
      conversationStatusLabelKey({
        status: "cancelled",
        interrupted: false,
        taskCanceled: true,
      })
    ).toEqual({ scope: "statusLabels", key: "cancelled" })
    expect(
      conversationStatusLabelKey({
        status: "cancelled",
        interrupted: false,
        taskCanceled: false,
      })
    ).toEqual({ scope: "sidebar", key: "statusCancelledBadge" })
  })
})

describe("会话详情的状态文字（#652）", () => {
  it("本轮失败（cancelled、没有 interrupted_at）写本轮未完成，不写已取消", () => {
    const { getByTestId } = renderZh(
      <SessionDetailsCard summary={summary()} model={null} />
    )
    const line = getByTestId("session-agent-line").textContent ?? ""
    expect(line).toContain("本轮未完成")
    expect(line).not.toContain("已取消")
  })

  it("被打断的写被打断", () => {
    const { getByTestId } = renderZh(
      <SessionDetailsCard
        summary={summary({ interrupted_at: "2026-06-12T12:00:00.000Z" })}
        model={null}
      />
    )
    expect(getByTestId("session-agent-line").textContent).toContain(
      "被打断：这一轮没跑完"
    )
  })

  it("取消了的工作任务会话写已取消", () => {
    useCanceledTaskStore.setState({ conversationIds: new Set([7]) })
    const { getByTestId } = renderZh(
      <SessionDetailsCard summary={summary()} model={null} />
    )
    expect(getByTestId("session-agent-line").textContent).toContain("已取消")
  })

  it("已完成的还是已完成", () => {
    const { getByTestId } = renderZh(
      <SessionDetailsCard
        summary={summary({ status: "completed" })}
        model={null}
      />
    )
    expect(getByTestId("session-agent-line").textContent).toContain("已完成")
  })

  it("会话详情对话框的状态标签也写本轮未完成", () => {
    const { getByText, queryByText } = renderZh(
      <SessionDetailsContent summary={summary()} stats={stats} />
    )
    expect(getByText("本轮未完成")).toBeTruthy()
    expect(queryByText("已取消")).toBeNull()
  })
})
