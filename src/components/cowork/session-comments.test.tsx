import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { useCallback } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import {
  type CoworkTeamSummary,
  type TeamComment,
  type TeamCommentsPage,
  type TeamEntriesPage,
} from "@/lib/cowork/team"
import {
  messageQueueStorageKey,
  useMessageQueue,
} from "@/hooks/use-message-queue"
import { readStoredQueue } from "@/lib/cowork/message-queue-storage"
import { clearMessageInputDraft } from "@/lib/message-input-draft"
import {
  useCoworkTeamStore,
  type SharedSessionTarget,
} from "@/stores/cowork-team-store"
import { SharedSessionHost } from "./shared-session-view"
import {
  OwnSessionComments,
  SessionCommentsButton,
  forwardedCommentText,
  commentDraftKey,
  useOwnCommentsStore,
} from "./session-comments"

const api = vi.hoisted(() => ({
  teamEntries:
    vi.fn<
      (owner: string, id: string, after: number) => Promise<TeamEntriesPage>
    >(),
  teamComments:
    vi.fn<
      (owner: string, id: string, after: number) => Promise<TeamCommentsPage>
    >(),
  teamCommentAdd:
    vi.fn<
      (
        owner: string,
        id: string,
        body: string,
        options?: { seq?: number; replyTo?: string }
      ) => Promise<TeamComment>
    >(),
  teamCommentDelete:
    vi.fn<
      (
        owner: string,
        id: string,
        commentId: string
      ) => Promise<{ id: string; replies: number }>
    >(),
  teamCommentsSeen: vi.fn(),
  teamCommentForwarded:
    vi.fn<(id: string, commentId: string) => Promise<void>>(),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => null,
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => null,
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return {
    ...actual,
    teamEntries: api.teamEntries,
    teamComments: api.teamComments,
    teamCommentAdd: api.teamCommentAdd,
    teamCommentDelete: api.teamCommentDelete,
    teamCommentsSeen: api.teamCommentsSeen,
    teamCommentForwarded: api.teamCommentForwarded,
  }
})
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-md="">{children}</div>
  ),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
// 顶栏给窗口角上的浮层留位置要读侧栏、辅助面板这些布局状态，这里不测它。
vi.mock("@/components/layout/conversation-corner-reserve", () => ({
  ConversationCornerReserve: () => null,
}))

const TARGET: SharedSessionTarget = {
  owner: "member-a",
  ownerLabel: "Wang",
  id: "42",
  title: "Fix login",
  via: { kind: "shared" },
}

function comment(over: Partial<TeamComment>): TeamComment {
  return {
    id: "c1",
    seq: null,
    parentId: null,
    author: "member-b",
    authorLabel: "Li",
    former: false,
    body: "hello",
    createdAt: "2026-11-23T09:00:00Z",
    mine: false,
    canDelete: false,
    anchor: null,
    forwardedAt: null,
    ...over,
  }
}

function commentsPage(
  comments: TeamComment[],
  isOwner = false
): TeamCommentsPage {
  return { isOwner, ids: comments.map((c) => c.id), comments }
}

function entriesPage(): TeamEntriesPage {
  return {
    agent: {
      owner: "member-a",
      ownerLabel: "Wang",
      id: "42",
      title: "Fix login",
      state: "running",
      updatedAt: "2026-11-23T09:57:00Z",
    },
    entries: [
      { seq: 3, kind: "assistant", text: "changed the cookie", ts: "" },
    ],
    total: 1,
    reason: null,
  }
}

function makeAvailable() {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "Chen" },
      leaderOf: [],
      portalUrl: "https://portal.example.com",
    })
  })
}

function setSummary(unread: { id: string; count: number; mine: boolean }[]) {
  const summary: CoworkTeamSummary = {
    sharedNew: 0,
    commentUnread: {
      total: unread.reduce((n, u) => n + u.count, 0),
      sessions: unread.map((u) => ({
        owner: u.mine ? "member-c" : "member-a",
        ownerLabel: u.mine ? "Chen" : "Wang",
        id: u.id,
        title: "t",
        mine: u.mine,
        count: u.count,
      })),
    },
    groupNotices: [],
  }
  act(() => {
    useCoworkTeamStore.getState().setSummary(summary)
  })
}

function wrap(ui: React.ReactNode) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

beforeEach(() => {
  useCoworkTeamStore.getState().reset()
  useOwnCommentsStore.getState().reset()
  for (const fn of Object.values(api)) fn.mockReset()
  api.teamEntries.mockResolvedValue(entriesPage())
  api.teamComments.mockResolvedValue(commentsPage([]))
  api.teamCommentsSeen.mockResolvedValue({
    owner: "",
    id: "",
    seenId: null,
  })
  api.teamCommentForwarded.mockResolvedValue(undefined)
  window.localStorage.clear()
  // 留言草稿还有一层内存缓存，localStorage.clear() 清不到。
  for (const viewer of ["member-c", "member-d"]) {
    for (const id of ["42", "43"]) {
      clearMessageInputDraft(
        commentDraftKey(
          { name: viewer, portalUrl: "https://portal.example.com" },
          "member-a",
          id
        )
      )
    }
  }
})

afterEach(() => {
  useCoworkTeamStore.getState().reset()
  useOwnCommentsStore.getState().reset()
})

// ─── 完成标准 6：只读视图的留言 ─────────────────────────────────────────────

describe("comments in the read-only view", () => {
  async function openView() {
    makeAvailable()
    wrap(
      <SharedSessionHost>
        <div>own conversation</div>
      </SharedSessionHost>
    )
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
  }

  function composer(): HTMLTextAreaElement {
    return screen.getByPlaceholderText(
      "Leave a comment for Wang — it won't be sent to their agent"
    )
  }

  it("the composer in place of the input sends comment_add, then reloads the thread", async () => {
    api.teamCommentAdd.mockResolvedValue(comment({ id: "c9", body: "nice" }))
    await openView()
    expect(api.teamComments).toHaveBeenCalledWith("member-a", "42", 0)
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-a", "42")

    fireEvent.change(composer(), { target: { value: "  nice  " } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await flush()

    expect(api.teamCommentAdd).toHaveBeenCalledWith(
      "member-a",
      "42",
      "nice",
      {}
    )
    expect(api.teamComments).toHaveBeenCalledTimes(2)
    expect(composer().value).toBe("")
  })

  it("draws the thread in the right column as plain text, replies under their parent", async () => {
    api.teamComments.mockResolvedValue(
      commentsPage([
        comment({
          id: "c1",
          body: "<b>*hi*</b> <img src=x>",
          anchor: "changed the <i>cookie</i>",
          seq: 3,
        }),
        comment({
          id: "c2",
          parentId: "c1",
          authorLabel: "<Wang>",
          body: "**ok**",
        }),
      ])
    )
    await openView()
    const sidebar = document.querySelector("[data-comments-sidebar]")!
    expect(sidebar).not.toBeNull()
    const bodies = Array.from(
      sidebar.querySelectorAll("[data-comment-body]")
    ).map((el) => el.textContent)
    expect(bodies).toEqual(["<b>*hi*</b> <img src=x>", "**ok**"])
    expect(sidebar.querySelector("b, img, i, strong")).toBeNull()
    expect(sidebar.querySelector("[data-comment-anchor]")?.textContent).toBe(
      "On: changed the <i>cookie</i>"
    )
    expect(sidebar.textContent).toContain("<Wang>")
    // 回复挂在顶层留言下面，没有自己的「回复」。
    const reply = sidebar.querySelector('[data-comment-id="c2"]')!
    expect(reply.className).toContain("ms-4")
    expect(
      Array.from(reply.querySelectorAll("button")).map((b) => b.textContent)
    ).not.toContain("Reply")
  })

  it("comments on one entry with its seq", async () => {
    api.teamCommentAdd.mockResolvedValue(comment({ id: "c9" }))
    await openView()
    fireEvent.click(
      screen.getByRole("button", { name: "Comment on this entry" })
    )
    expect(document.querySelector("[data-comment-target]")?.textContent).toBe(
      "Commenting on: changed the cookie"
    )
    fireEvent.change(composer(), { target: { value: "why?" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await flush()
    expect(api.teamCommentAdd).toHaveBeenCalledWith("member-a", "42", "why?", {
      seq: 3,
    })
    expect(document.querySelector("[data-comment-target]")).toBeNull()
  })

  it("replies to a top-level comment", async () => {
    api.teamComments.mockResolvedValue(commentsPage([comment({ id: "c1" })]))
    api.teamCommentAdd.mockResolvedValue(comment({ id: "c9" }))
    await openView()
    fireEvent.click(screen.getByRole("button", { name: "Reply" }))
    expect(document.querySelector("[data-comment-target]")?.textContent).toBe(
      "Replying to Li"
    )
    fireEvent.change(composer(), { target: { value: "thanks" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await flush()
    expect(api.teamCommentAdd).toHaveBeenCalledWith(
      "member-a",
      "42",
      "thanks",
      { replyTo: "c1" }
    )
  })

  it("only comments with canDelete have Delete, and it sends comment_delete", async () => {
    api.teamComments.mockResolvedValue(
      commentsPage([
        comment({ id: "c1", canDelete: true, mine: true }),
        comment({ id: "c2", canDelete: false }),
      ])
    )
    api.teamCommentDelete.mockResolvedValue({ id: "c1", replies: 0 })
    await openView()
    const deletes = screen.getAllByRole("button", { name: "Delete" })
    expect(deletes).toHaveLength(1)
    expect(
      deletes[0].closest("[data-comment-id]")?.getAttribute("data-comment-id")
    ).toBe("c1")
    fireEvent.click(deletes[0])
    await flush()
    expect(api.teamCommentDelete).toHaveBeenCalledWith("member-a", "42", "c1")
    expect(api.teamComments).toHaveBeenCalledTimes(2)
  })

  it("keeps the text and says what went wrong in plain words when sending fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { CoworkTeamError } = await import("@/lib/cowork/team")
    api.teamCommentAdd.mockRejectedValue(
      new CoworkTeamError("rate_limited", "Slow down")
    )
    await openView()
    fireEvent.change(composer(), { target: { value: "hey" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await flush()
    expect(composer().value).toBe("hey")
    expect(
      screen.getByText(
        "Couldn't send: Too many actions — try again in a moment"
      )
    ).toBeTruthy()
    expect(screen.queryByText(/Slow down/)).toBeNull()
    warn.mockRestore()
  })

  async function openViewZh() {
    makeAvailable()
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <SharedSessionHost>
          <div>own conversation</div>
        </SharedSessionHost>
      </NextIntlClientProvider>
    )
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
  }

  it("中文界面：发送失败写「没发出去：」加人话，查不到服务端原文", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { CoworkTeamError } = await import("@/lib/cowork/team")
    api.teamCommentAdd.mockRejectedValue(
      new CoworkTeamError("invalid", "replyTo 要是整数")
    )
    await openViewZh()
    const box = screen.getByPlaceholderText("留言给Wang，不会发给Wang的智能体")
    fireEvent.change(box, { target: { value: "hey" } })
    fireEvent.click(screen.getByRole("button", { name: "发送" }))
    await flush()
    expect(screen.getByText("没发出去：出了点问题，稍后再试")).toBeTruthy()
    expect(screen.queryByText(/要是整数/)).toBeNull()
    warn.mockRestore()
  })

  it("中文界面：删除失败写「没删掉：」，不写「没发出去」", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { CoworkTeamError } = await import("@/lib/cowork/team")
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "9", canDelete: true, mine: true })])
    )
    api.teamCommentDelete.mockRejectedValue(
      new CoworkTeamError("invalid", "commentId 要是整数")
    )
    await openViewZh()
    fireEvent.click(screen.getByRole("button", { name: "删除" }))
    await flush()
    expect(screen.getByText("没删掉：出了点问题，稍后再试")).toBeTruthy()
    expect(screen.queryByText(/没发出去/)).toBeNull()
    expect(screen.queryByText(/要是整数/)).toBeNull()
    warn.mockRestore()
  })

  it("中文界面：读取留言失败只说人话", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const { CoworkTeamError } = await import("@/lib/cowork/team")
    api.teamComments.mockRejectedValue(
      new CoworkTeamError("invalid", "after 要是整数")
    )
    await openViewZh()
    expect(
      document.querySelector("[data-comments-sidebar]")?.textContent
    ).toContain("读取失败：出了点问题，稍后再试")
    expect(screen.queryByText(/要是整数/)).toBeNull()
    warn.mockRestore()
  })

  it("keeps what was typed while the comment was being sent", async () => {
    let resolveAdd: (c: TeamComment) => void = () => {}
    api.teamCommentAdd.mockImplementation(
      () =>
        new Promise<TeamComment>((resolve) => {
          resolveAdd = resolve
        })
    )
    await openView()
    fireEvent.change(composer(), { target: { value: "first" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    // 请求还没回来时接着写：先在原文后面接着打，再整段换成下一条。
    fireEvent.change(composer(), { target: { value: "first and more" } })
    await act(async () => {
      resolveAdd(comment({ id: "c9", body: "first" }))
    })
    await flush()
    expect(composer().value).toBe("and more")

    api.teamCommentAdd.mockImplementation(
      () =>
        new Promise<TeamComment>((resolve) => {
          resolveAdd = resolve
        })
    )
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.change(composer(), { target: { value: "next one" } })
    await act(async () => {
      resolveAdd(comment({ id: "c10", body: "and more" }))
    })
    await flush()
    expect(composer().value).toBe("next one")
  })

  it("keeps an unsent comment draft after switching away and back", async () => {
    await openView()
    fireEvent.change(composer(), { target: { value: "QA draft" } })
    // 切到自己的会话：只读视图卸载；再从「分享给我」点开同一条。
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await flush()
    expect(
      screen.queryByPlaceholderText(
        "Leave a comment for Wang — it won't be sent to their agent"
      )
    ).toBeNull()
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    expect(composer().value).toBe("QA draft")

    // 换一条分享：是它自己的（空的）草稿，不串。
    act(() => {
      useCoworkTeamStore.getState().openSharedSession({ ...TARGET, id: "43" })
    })
    await flush()
    expect(composer().value).toBe("")
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    expect(composer().value).toBe("QA draft")
  })

  it("does not show another team account's comment draft", async () => {
    await openView()
    fireEvent.change(composer(), { target: { value: "old account" } })
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await flush()
    // 换了团队账号：同一个 owner/id 的会话，看到的不能是上一个账号的草稿。
    act(() => {
      useCoworkTeamStore.getState().setStatus({
        applicable: true,
        enabled: true,
        me: { name: "member-d", label: "Du" },
        leaderOf: [],
        portalUrl: "https://portal.example.com",
      })
    })
    await flush()
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    expect(composer().value).toBe("")
    fireEvent.change(composer(), { target: { value: "new account" } })

    // 换回原来的账号：它自己的草稿还在。
    makeAvailable()
    await flush()
    expect(composer().value).toBe("old account")
  })

  it("drops the draft once it is sent, keeping only what was typed after", async () => {
    let resolveAdd: (c: TeamComment) => void = () => {}
    api.teamCommentAdd.mockImplementation(
      () =>
        new Promise<TeamComment>((resolve) => {
          resolveAdd = resolve
        })
    )
    await openView()
    fireEvent.change(composer(), { target: { value: "first" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    fireEvent.change(composer(), { target: { value: "first and more" } })
    await act(async () => {
      resolveAdd(comment({ id: "c9", body: "first" }))
    })
    await flush()
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await flush()
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    expect(composer().value).toBe("and more")

    api.teamCommentAdd.mockResolvedValue(comment({ id: "c10" }))
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await flush()
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await flush()
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    expect(composer().value).toBe("")
  })

  it("clears the sent text from a reopened view when the send finishes", async () => {
    let resolveAdd: (c: TeamComment) => void = () => {}
    api.teamCommentAdd.mockImplementation(
      () =>
        new Promise<TeamComment>((resolve) => {
          resolveAdd = resolve
        })
    )
    await openView()
    fireEvent.change(composer(), { target: { value: "first" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    // 还没发完就切走、再打开同一条：新留言框先读到的是旧草稿。
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await flush()
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    expect(composer().value).toBe("first")
    // 上一次还没发完：新留言框不能再把同一段发一次。
    const sendButton = screen.getByRole("button", { name: "Send" })
    expect((sendButton as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(sendButton)
    fireEvent.keyDown(composer(), { key: "Enter", ctrlKey: true })
    await flush()
    expect(api.teamCommentAdd).toHaveBeenCalledTimes(1)
    await act(async () => {
      resolveAdd(comment({ id: "c9", body: "first" }))
    })
    await flush()
    // 发出去的字不能还留在新留言框里，不然再点发送就重复了。
    expect(composer().value).toBe("")
  })

  it("lets a reopened view resend once the earlier send failed", async () => {
    let rejectAdd: (e: unknown) => void = () => {}
    api.teamCommentAdd.mockImplementation(
      () =>
        new Promise<TeamComment>((_resolve, reject) => {
          rejectAdd = reject
        })
    )
    await openView()
    fireEvent.change(composer(), { target: { value: "first" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await flush()
    act(() => {
      useCoworkTeamStore.getState().openSharedSession(TARGET)
    })
    await flush()
    const button = () =>
      screen.getByRole("button", { name: "Send" }) as HTMLButtonElement
    expect(button().disabled).toBe(true)
    await act(async () => {
      rejectAdd(new Error("offline"))
    })
    await flush()
    // 没发出去：字留着，按钮恢复能点。
    expect(composer().value).toBe("first")
    expect(button().disabled).toBe(false)
  })

  it("keeps a target picked while the previous comment was being sent", async () => {
    api.teamComments.mockResolvedValue(commentsPage([comment({ id: "c1" })]))
    let resolveAdd: (c: TeamComment) => void = () => {}
    api.teamCommentAdd.mockImplementation(
      () =>
        new Promise<TeamComment>((resolve) => {
          resolveAdd = resolve
        })
    )
    await openView()
    fireEvent.change(composer(), { target: { value: "first" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    // 请求还没回来时，选了下一条要回复的留言。
    fireEvent.click(screen.getByRole("button", { name: "Reply" }))
    await act(async () => {
      resolveAdd(comment({ id: "c9", body: "first" }))
    })
    await flush()
    expect(document.querySelector("[data-comment-target]")?.textContent).toBe(
      "Replying to Li"
    )

    api.teamCommentAdd.mockResolvedValue(comment({ id: "c10" }))
    fireEvent.change(composer(), { target: { value: "second" } })
    fireEvent.click(screen.getByRole("button", { name: "Send" }))
    await flush()
    expect(api.teamCommentAdd).toHaveBeenLastCalledWith(
      "member-a",
      "42",
      "second",
      { replyTo: "c1" }
    )
  })

  it("reloads when a later summary still has unread comments, even with the same count", async () => {
    makeAvailable()
    setSummary([{ id: "42", count: 1, mine: false }])
    await openView()
    expect(api.teamComments).toHaveBeenCalledTimes(1)

    // 拉过、标过已读以后，下一次轮询又说有一条未读：是新来的，条数虽然一样。
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c7", body: "new one" })])
    )
    setSummary([{ id: "42", count: 1, mine: false }])
    await flush()
    expect(api.teamComments).toHaveBeenCalledTimes(2)
    expect(screen.getByText("new one")).toBeTruthy()
  })
})

// ─── 完成标准 10：自己会话的留言栏和「交给我的智能体」 ──────────────────────

/**
 * 一个会话面板的替身：真的排队区，和会话面板一样按会话号存进这台机器，
 * `onForward` 和面板里一样只入队（把入队的结果交回去）。
 */
function OwnConversation({ conversationId }: { conversationId: number }) {
  const { queue, enqueue, moveToFront, dequeue, settle } = useMessageQueue(
    messageQueueStorageKey(conversationId)
  )
  const onForward = useCallback(
    (text: string) =>
      enqueue({ blocks: [{ type: "text", text }], displayText: text }, null),
    [enqueue]
  )
  return (
    <div>
      <SessionCommentsButton conversationId={conversationId} />
      <OwnSessionComments
        conversationId={conversationId}
        isActive
        onForward={onForward}
      />
      <ul data-testid="queue">
        {queue.map((item) => (
          <li key={item.id}>{item.draft.displayText}</li>
        ))}
      </ul>
      {/* 排队区里把最后一条拖到最前面（和排队区的拖动排序一样） */}
      <button
        type="button"
        data-testid="last-to-front"
        onClick={() => {
          const last = queue[queue.length - 1]
          if (last) moveToFront(last.id)
        }}
      />
      {/* 用户自己在输入框里排进一条普通消息 */}
      <button
        type="button"
        data-testid="enqueue-plain"
        onClick={() =>
          enqueue(
            { blocks: [{ type: "text", text: "plain" }], displayText: "plain" },
            null
          )
        }
      />
      {/* 发出排队区最前面那条：出队、送达 */}
      <button
        type="button"
        data-testid="send-head"
        onClick={() => {
          const head = dequeue()
          if (head) settle(head.id)
        }}
      />
    </div>
  )
}

function queueItems(): string[] {
  return Array.from(screen.getByTestId("queue").querySelectorAll("li")).map(
    (li) => li.textContent ?? ""
  )
}

describe("own conversation comments", () => {
  it("unavailable: no Comments entry, no panel, no request", async () => {
    wrap(<OwnConversation conversationId={7} />)
    act(() => {
      useOwnCommentsStore.getState().open("7")
    })
    await flush()
    expect(document.querySelector("[data-session-comments-button]")).toBeNull()
    expect(document.querySelector("[data-comments-sidebar]")).toBeNull()
    expect(api.teamComments).not.toHaveBeenCalled()
  })

  it("the header entry reads Comments (N new) from summary and opens the panel", async () => {
    makeAvailable()
    setSummary([{ id: "7", count: 2, mine: true }])
    wrap(<OwnConversation conversationId={7} />)
    const button = document.querySelector<HTMLButtonElement>(
      "[data-session-comments-button]"
    )!
    expect(button.textContent).toBe("Comments (2 new)")
    expect(api.teamComments).not.toHaveBeenCalled()
    fireEvent.click(button)
    await flush()
    expect(document.querySelector("[data-comments-sidebar]")).not.toBeNull()
    expect(api.teamComments).toHaveBeenCalledWith("member-c", "7", 0)
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-c", "7")
  })

  it("no Give-to-my-agent when isOwner is false", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(commentsPage([comment({})], false))
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    expect(document.querySelector("[data-comment-id]")).not.toBeNull()
    expect(document.querySelector("[data-comment-forward]")).toBeNull()
  })

  it("Give to my agent queues the comment once with the source line, then comment_forwarded", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage(
        [comment({ id: "c5", authorLabel: "Li", body: "try <b>*x*</b>" })],
        true
      )
    )
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    expect(queueItems()).toEqual([])

    const button = screen.getByRole("button", { name: "Give to my agent" })
    fireEvent.click(button)
    fireEvent.click(button)
    await flush()

    const expected =
      "以下是同事 Li 在这个会话上的留言，由我转给你：\n\ntry <b>*x*</b>"
    expect(forwardedCommentText("Li", "try <b>*x*</b>")).toBe(expected)
    expect(queueItems()).toEqual([expected])
    expect(api.teamCommentForwarded).toHaveBeenCalledTimes(1)
    expect(api.teamCommentForwarded).toHaveBeenCalledWith("7", "c5")
    const done = screen.getByRole("button", { name: "Given to agent" })
    expect((done as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(done)
    expect(queueItems()).toHaveLength(1)
  })

  it("a polled new comment only updates the hint and thread; the queue stays as it was", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c5" })], true)
    )
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Give to my agent" }))
    await flush()
    expect(queueItems()).toHaveLength(1)

    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c5" }), comment({ id: "c6" })], true)
    )
    setSummary([{ id: "7", count: 1, mine: true }])
    await flush()

    expect(
      document.querySelector<HTMLButtonElement>(
        "[data-session-comments-button]"
      )!.textContent
    ).toBe("Comments (1 new)")
    expect(document.querySelectorAll("[data-comment-id]")).toHaveLength(2)
    expect(queueItems()).toHaveLength(1)
    expect(api.teamCommentForwarded).toHaveBeenCalledTimes(1)
  })

  it("after a reload a forwarded comment still reads Given to agent and cannot be forwarded again (#1512)", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c5" })], true)
    )
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Give to my agent" }))
    await flush()
    expect(api.teamCommentForwarded).toHaveBeenCalledTimes(1)
    first.unmount()

    // 刷新：内存里的记号没了，留言栏重新打开。
    act(() => useOwnCommentsStore.getState().reset())
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    expect(
      screen.queryByRole("button", { name: "Give to my agent" })
    ).toBeNull()
    const done = screen.getByRole("button", { name: "Given to agent" })
    expect((done as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(done)
    await flush()
    expect(queueItems()).toEqual([])
    expect(api.teamCommentForwarded).toHaveBeenCalledTimes(1)
  })

  it("a comment the server marks forwardedAt reads Given to agent and is not queued (#1512)", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage(
        [comment({ id: "c5", forwardedAt: "2026-11-24T08:00:00Z" })],
        true
      )
    )
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    const done = screen.getByRole("button", { name: "Given to agent" })
    expect((done as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(done)
    await flush()
    expect(queueItems()).toEqual([])
    expect(api.teamCommentForwarded).not.toHaveBeenCalled()
  })

  it("the forwarded mark belongs to the team account: another account on this machine can still forward (#1512)", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c5" })], true)
    )
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    fireEvent.click(screen.getByRole("button", { name: "Give to my agent" }))
    await flush()
    first.unmount()

    act(() => {
      useOwnCommentsStore.getState().reset()
      useCoworkTeamStore.getState().setStatus({
        applicable: true,
        enabled: true,
        me: { name: "member-d", label: "Du" },
        leaderOf: [],
        portalUrl: "https://portal.example.com",
      })
    })
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    expect(
      screen.getByRole("button", { name: "Give to my agent" })
    ).not.toBeNull()
  })
})

describe("forwarded marks survive a reload (#1512 rework)", () => {
  it("forwarding many other comments does not push out an earlier mark", async () => {
    makeAvailable()
    const many = Array.from({ length: 510 }, (_, i) => comment({ id: `c${i}` }))
    api.teamComments.mockResolvedValue(commentsPage(many, true))
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    const forwardOf = (id: string) =>
      document.querySelector<HTMLButtonElement>(
        `[data-comment-id="${id}"] [data-comment-forward]`
      )!
    // 一次 act 里点一批，只重画一次（一条条点要几十秒）。排队区存得下 50 条，
    // 每交一批就把它们发出去，再交下一批（#1512 第 4 次返工：存不下的不交）。
    const buttons = many.map((c) => forwardOf(c.id))
    const sendHead = screen.getByTestId("send-head")
    for (let i = 0; i < buttons.length; i += 50) {
      act(() => {
        for (const b of buttons.slice(i, i + 50)) b.click()
      })
      await flush()
      act(() => {
        for (let j = 0; j < 50; j++) sendHead.click()
      })
      await flush()
    }
    expect(api.teamCommentForwarded).toHaveBeenCalledTimes(510)
    first.unmount()

    act(() => useOwnCommentsStore.getState().reset())
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    expect(forwardOf("c0").textContent).toBe("Given to agent")
    expect(forwardOf("c0").disabled).toBe(true)
  })

  it("when the mark cannot be saved, the comment is not queued and the user is told", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c5" })], true)
    )
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    const setItem = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("QuotaExceededError")
      })
    try {
      fireEvent.click(screen.getByRole("button", { name: "Give to my agent" }))
      await flush()
    } finally {
      setItem.mockRestore()
    }
    expect(queueItems()).toEqual([])
    expect(api.teamCommentForwarded).not.toHaveBeenCalled()
    expect(screen.getByRole("alert").textContent).toBe(
      "This browser could not save that the comment was given, so it was not given to your agent. Free up browser storage and try again."
    )
    // 存得下了就能接着交。
    fireEvent.click(screen.getByRole("button", { name: "Give to my agent" }))
    await flush()
    expect(queueItems()).toHaveLength(1)
    expect(screen.queryByRole("alert")).toBeNull()
  })
})

describe("the forwarded mark follows the queued message (#1512 rework 2)", () => {
  const forwardOf = (id: string) =>
    document.querySelector<HTMLButtonElement>(
      `[data-comment-id="${id}"] [data-comment-forward]`
    )!

  it("the forwarded comment is in the saved queue, and after a reload still reads Given to agent", async () => {
    makeAvailable()
    api.teamComments.mockResolvedValue(
      commentsPage([comment({ id: "c5", authorLabel: "Li", body: "hi" })], true)
    )
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    fireEvent.click(forwardOf("c5"))
    await flush()
    expect(
      readStoredQueue(messageQueueStorageKey(7)).map((i) => i.draft.displayText)
    ).toEqual([forwardedCommentText("Li", "hi")])
    first.unmount()

    act(() => useOwnCommentsStore.getState().reset())
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    expect(forwardOf("c5").textContent).toBe("Given to agent")
    expect(forwardOf("c5").disabled).toBe(true)
  })

  it("when the queue cannot keep the message (already 50 waiting), the comment is not given and stays not given after a reload (#1512 rework 4)", async () => {
    makeAvailable()
    const many = Array.from({ length: 51 }, (_, i) =>
      comment({ id: `c${i}`, body: `note ${i}` })
    )
    api.teamComments.mockResolvedValue(commentsPage(many, true))
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    const buttons = many.map((c) => forwardOf(c.id))
    act(() => {
      for (const b of buttons) b.click()
    })
    await flush()
    // 排队区只存得下 50 条：第 51 条不交，说一声为什么
    expect(readStoredQueue(messageQueueStorageKey(7))).toHaveLength(50)
    expect(queueItems()).toHaveLength(50)
    expect(queueItems()).not.toContain(
      forwardedCommentText(many[50].authorLabel, "note 50")
    )
    expect(forwardOf("c50").textContent).toBe("Give to my agent")
    expect(screen.getByRole("alert").textContent).toContain("queue")
    first.unmount()

    act(() => useOwnCommentsStore.getState().reset())
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    // 交出去的 50 条刷新后都算交过，不能再交；没交的那条照旧能交
    for (let i = 0; i < 50; i++) {
      expect(forwardOf(`c${i}`).textContent).toBe("Given to agent")
      expect(forwardOf(`c${i}`).disabled).toBe(true)
    }
    expect(forwardOf("c50").textContent).toBe("Give to my agent")
  })

  it("a later reorder that pushes a forwarded message out of the saved queue lets that comment be given again after a reload (#1512 rework 3)", async () => {
    makeAvailable()
    const many = Array.from({ length: 50 }, (_, i) =>
      comment({ id: `c${i}`, body: `note ${i}` })
    )
    api.teamComments.mockResolvedValue(commentsPage(many, true))
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    const buttons = many.map((c) => forwardOf(c.id))
    act(() => {
      for (const b of buttons) b.click()
    })
    await flush()
    // c0..c49 都存下了。用户再排一条普通消息（只在内存里），把它拖到最前面：
    // 它存下了，c49 被挤出存下的那 50 条。
    fireEvent.click(screen.getByTestId("enqueue-plain"))
    await flush()
    fireEvent.click(screen.getByTestId("last-to-front"))
    await flush()
    const storedTexts = readStoredQueue(messageQueueStorageKey(7)).map(
      (i) => i.draft.displayText
    )
    expect(storedTexts).toHaveLength(50)
    expect(storedTexts[0]).toBe("plain")
    expect(storedTexts).not.toContain(
      forwardedCommentText(many[49].authorLabel, "note 49")
    )
    first.unmount()

    act(() => useOwnCommentsStore.getState().reset())
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    // 被挤出去的那条刷新后消息没了，留言要能再交（不算重复）；别的算交过
    expect(forwardOf("c49").textContent).toBe("Give to my agent")
    expect(forwardOf("c49").disabled).toBe(false)
    expect(forwardOf("c48").textContent).toBe("Given to agent")
    expect(forwardOf("c0").textContent).toBe("Given to agent")
  })

  it("a forwarded message that was sent stays Given to agent after a reload, even if it was only in memory (#1512 rework 3)", async () => {
    makeAvailable()
    const many = Array.from({ length: 50 }, (_, i) =>
      comment({ id: `c${i}`, body: `note ${i}` })
    )
    api.teamComments.mockResolvedValue(commentsPage(many, true))
    const first = wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    const buttons = many.map((c) => forwardOf(c.id))
    act(() => {
      for (const b of buttons) b.click()
    })
    await flush()
    // 普通消息拖到最前面，c49 被挤出存储、只在内存里；再把 c49 拖到最前面
    // 发出去（出队、送达）
    fireEvent.click(screen.getByTestId("enqueue-plain"))
    await flush()
    fireEvent.click(screen.getByTestId("last-to-front"))
    await flush()
    fireEvent.click(screen.getByTestId("last-to-front"))
    await flush()
    expect(queueItems()[0]).toBe(
      forwardedCommentText(many[49].authorLabel, "note 49")
    )
    fireEvent.click(screen.getByTestId("send-head"))
    await flush()
    expect(
      readStoredQueue(messageQueueStorageKey(7)).map((i) => i.draft.displayText)
    ).not.toContain(forwardedCommentText(many[49].authorLabel, "note 49"))
    first.unmount()

    act(() => useOwnCommentsStore.getState().reset())
    wrap(<OwnConversation conversationId={7} />)
    act(() => useOwnCommentsStore.getState().open("7"))
    await flush()
    // 发出去了的不能再交第二次
    expect(forwardOf("c49").textContent).toBe("Given to agent")
  })
})
