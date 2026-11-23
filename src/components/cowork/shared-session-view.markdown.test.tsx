import { act, render, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type {
  TeamCommentsPage,
  TeamEntriesPage,
  TeamEntry,
} from "@/lib/cowork/team"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import { SharedSessionHost } from "./shared-session-view"

// 这里不替换 MessageResponse：走真实的 Streamdown（含 rehype 净化），确认只读视图里
// 四种块的正文真的按 markdown 渲染、别人会话里的危险 HTML 被净化掉。
// 只读视图还会拉留言（teamComments / teamCommentsSeen），也换成假的，不走真的
// transport。
const api = vi.hoisted(() => ({
  teamEntries:
    vi.fn<
      (owner: string, id: string, after: number) => Promise<TeamEntriesPage>
    >(),
  teamComments:
    vi.fn<
      (owner: string, id: string, after: number) => Promise<TeamCommentsPage>
    >(),
  teamCommentsSeen: vi.fn<(owner: string, id: string) => Promise<void>>(),
}))
// 顶栏给窗口角上的浮层留位置要读侧栏、辅助面板这些布局状态，这里不测它。
vi.mock("@/components/layout/conversation-corner-reserve", () => ({
  ConversationCornerReserve: () => null,
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return {
    ...actual,
    teamEntries: api.teamEntries,
    teamComments: api.teamComments,
    teamCommentsSeen: api.teamCommentsSeen,
  }
})
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => null,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
}))
vi.mock("@/hooks/use-open-url-target", () => ({
  useOpenUrlTarget: () => () => ({ kind: "system", url: "" }),
  isPrimaryModifier: () => false,
}))
vi.mock("@/components/ai-elements/link-safety", () => ({
  useStreamdownLinkSafety: () => ({ enabled: false }),
}))

function entry(seq: number, kind: TeamEntry["kind"], text: string): TeamEntry {
  return { seq, kind, text, ts: "2026-11-23T09:50:00Z" }
}

beforeEach(() => {
  useCoworkTeamStore.getState().reset()
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "Chen" },
      leaderOf: [],
      portalUrl: "https://portal.example.com/",
    })
  })
  api.teamEntries.mockReset()
  api.teamComments.mockReset()
  api.teamComments.mockResolvedValue({ isOwner: false, ids: [], comments: [] })
  api.teamCommentsSeen.mockReset()
  api.teamCommentsSeen.mockResolvedValue(undefined)
})

afterEach(() => {
  useCoworkTeamStore.getState().reset()
})

describe("SharedSessionHost markdown (real renderer)", () => {
  it("renders every entry kind as sanitized markdown", async () => {
    const kinds: TeamEntry["kind"][] = ["user", "thought", "tool", "assistant"]
    api.teamEntries.mockResolvedValue({
      agent: {
        owner: "member-a",
        ownerLabel: "Wang",
        id: "42",
        title: "Fix login",
        state: "running",
        updatedAt: "2026-11-23T09:57:00Z",
      },
      entries: kinds.map((k, i) =>
        entry(
          i,
          k,
          `${k} says **bold-${k}** <script>window.__x_${k}=1</script><img src=x onerror="window.__y=1">`
        )
      ),
      total: kinds.length,
      reason: null,
    })
    const { container } = render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SharedSessionHost>
          <div>own conversation</div>
        </SharedSessionHost>
      </NextIntlClientProvider>
    )
    act(() => {
      useCoworkTeamStore.getState().openSharedSession({
        owner: "member-a",
        ownerLabel: "Wang",
        id: "42",
        title: "Fix login",
        via: { kind: "shared" },
      })
    })

    for (const k of kinds) {
      await waitFor(() => {
        const block = container.querySelector(`[data-shared-entry="${k}"]`)
        expect(
          block?.querySelector('[data-streamdown="strong"]')?.textContent
        ).toBe(`bold-${k}`)
      })
      const block = container.querySelector(`[data-shared-entry="${k}"]`)!
      // 星号被渲染掉了，不是原样显示。
      expect(block.textContent).not.toContain("**")
      // 净化：没有脚本、没有带事件处理的属性。
      expect(block.querySelector("script")).toBeNull()
      expect(block.querySelector("[onerror]")).toBeNull()
    }
    // 留言走的是上面的假函数，没有落到真的 transport 上。
    expect(api.teamComments).toHaveBeenCalledWith("member-a", "42", 0)
    await waitFor(() =>
      expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-a", "42")
    )
  })
})
