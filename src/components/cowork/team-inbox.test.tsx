import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CoworkTeamSummary, TeamSharedItem } from "@/lib/cowork/team"
import type { DbConversationSummary } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import { useTabStore } from "@/stores/tab-store"
import { useOwnCommentsStore } from "./session-comments"
import {
  resolveReplyVia,
  TeamInbox,
  teamInboxUnread,
  waitForOwnConversation,
} from "./team-inbox"

const api = vi.hoisted(() => ({
  teamShared: vi.fn<() => Promise<TeamSharedItem[]>>(),
  teamSharedSeen: vi.fn(),
  teamCommentsSeen: vi.fn(),
  teamGroupNoticeDismiss: vi.fn(),
  teamView: vi.fn(),
  call: vi.fn(),
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return {
    ...actual,
    teamShared: api.teamShared,
    teamSharedSeen: api.teamSharedSeen,
    teamCommentsSeen: api.teamCommentsSeen,
    teamGroupNoticeDismiss: api.teamGroupNoticeDismiss,
    teamView: api.teamView,
  }
})
// 团队功能不可用时一个请求都不能发：命令层也盯着。
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: api.call }),
}))

function item(partial: Partial<TeamSharedItem>): TeamSharedItem {
  return {
    owner: "member-a",
    ownerLabel: "小王",
    id: "1",
    title: "",
    state: "done",
    updatedAt: "2026-11-22T08:00:00Z",
    note: "",
    sharedAt: "2026-11-22T08:00:00Z",
    isNew: false,
    summary: null,
    via: [{ type: "user" }],
    ...partial,
  }
}

const SHARED: TeamSharedItem[] = [
  item({ id: "10", title: "Old fix", isNew: false }),
  item({
    owner: "member-b",
    ownerLabel: "Lee",
    id: "11",
    title: "Newest <b>refactor</b> **bold**",
    note: "please look",
    isNew: true,
  }),
]

const SUMMARY: CoworkTeamSummary = {
  sharedNew: 1,
  commentUnread: {
    total: 5,
    sessions: [
      {
        owner: "member-c",
        ownerLabel: "丙",
        id: "42",
        title: "My session",
        mine: true,
        count: 3,
      },
      {
        owner: "member-a",
        ownerLabel: "小王",
        id: "7",
        title: "Their session",
        mine: false,
        count: 2,
      },
    ],
  },
  groupNotices: [{ id: "n1", groupName: "Backend", leaders: ["Chen"] }],
}

function makeAvailable(
  summary: CoworkTeamSummary = SUMMARY,
  leaderOf: { id: string; name: string }[] = []
) {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "丙" },
      leaderOf,
      portalUrl: null,
    })
    useCoworkTeamStore.getState().setSummary(summary)
  })
}

function renderInbox(onOpenOwnSession?: (id: number) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TeamInbox onOpenOwnSession={onOpenOwnSession} />
    </NextIntlClientProvider>
  )
}

function inboxButton(): HTMLElement {
  const el = document.querySelector<HTMLElement>("[data-team-inbox-button]")
  if (!el) throw new Error("no inbox button")
  return el
}

function itemKeys(): string[] {
  return Array.from(document.querySelectorAll("[data-inbox-item]")).map(
    (el) => el.getAttribute("data-inbox-item") ?? ""
  )
}

function inboxItem(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(`[data-inbox-item="${key}"]`)
  if (!el) throw new Error(`no item ${key}`)
  return el
}

async function openInbox() {
  fireEvent.click(inboxButton())
  await waitFor(() => expect(itemKeys()).toContain("share:member-b/11"))
}

beforeEach(() => {
  useCoworkTeamStore.getState().reset()
  useOwnCommentsStore.getState().reset()
  api.teamShared.mockReset().mockResolvedValue(SHARED)
  api.teamSharedSeen.mockReset().mockResolvedValue({})
  api.teamCommentsSeen.mockReset().mockResolvedValue({})
  api.teamGroupNoticeDismiss.mockReset().mockResolvedValue(undefined)
  api.teamView.mockReset().mockRejectedValue(new Error("not called"))
  api.call.mockReset().mockResolvedValue({})
})

afterEach(() => {
  useCoworkTeamStore.getState().reset()
  useOwnCommentsStore.getState().reset()
})

describe("teamInboxUnread", () => {
  it("未读数 = 新分享数 + 未读留言数 + 未处理的进组提示数", () => {
    expect(teamInboxUnread(SUMMARY)).toBe(1 + 5 + 1)
    expect(teamInboxUnread(null)).toBe(0)
  })
})

describe("TeamInbox", () => {
  it("团队功能不可用时没有收件箱按钮，也不发请求", () => {
    renderInbox()
    expect(document.querySelector("[data-team-inbox-button]")).toBeNull()
    expect(api.teamShared).not.toHaveBeenCalled()
    expect(api.call).not.toHaveBeenCalled()
  })

  it("按钮带未读数，0 时不显示数字", () => {
    makeAvailable()
    renderInbox()
    expect(
      inboxButton().querySelector("[data-team-inbox-count]")?.textContent
    ).toBe("7")
    act(() =>
      useCoworkTeamStore.getState().setSummary({
        sharedNew: 0,
        commentUnread: { total: 0, sessions: [] },
        groupNotices: [],
      })
    )
    expect(inboxButton().querySelector("[data-team-inbox-count]")).toBeNull()
    // 没打开不拉分享列表。
    expect(api.teamShared).not.toHaveBeenCalled()
  })

  it("四类条目都能画出来，别人写的字按纯文字显示", async () => {
    makeAvailable()
    renderInbox()
    await openInbox()
    expect(itemKeys().sort()).toEqual(
      [
        "share:member-b/11",
        "comment:member-c/42",
        "reply:member-a/7",
        "group:n1",
      ].sort()
    )
    // 看过的分享不进收件箱。
    expect(itemKeys()).not.toContain("share:member-a/10")
    const share = inboxItem("share:member-b/11")
    expect(share.textContent).toContain("Lee")
    expect(share.textContent).toContain("Newest <b>refactor</b> **bold**")
    expect(share.textContent).toContain("please look")
    expect(share.querySelector("b")).toBeNull()
    expect(inboxItem("comment:member-c/42").textContent).toContain("My session")
    expect(inboxItem("reply:member-a/7").textContent).toContain("Their session")
    expect(inboxItem("group:n1").textContent).toContain("Backend")
    expect(inboxItem("group:n1").textContent).toContain("Chen")
  })

  it("筛选只看对应类型", async () => {
    makeAvailable()
    renderInbox()
    await openInbox()
    fireEvent.click(screen.getByRole("button", { name: "Shares" }))
    expect(itemKeys()).toEqual(["share:member-b/11"])
    fireEvent.click(screen.getByRole("button", { name: "Comments" }))
    expect(itemKeys().sort()).toEqual(
      ["comment:member-c/42", "reply:member-a/7"].sort()
    )
    fireEvent.click(screen.getByRole("button", { name: "Groups" }))
    expect(itemKeys()).toEqual(["group:n1"])
    fireEvent.click(screen.getByRole("button", { name: "All" }))
    expect(itemKeys()).toHaveLength(4)
  })

  it("点分享条目打开只读视图并调 shared_seen", async () => {
    makeAvailable()
    renderInbox()
    await openInbox()
    fireEvent.click(
      inboxItem("share:member-b/11").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
    expect(api.teamSharedSeen).toHaveBeenCalledWith("member-b", "11")
    expect(useCoworkTeamStore.getState().viewing).toEqual(
      expect.objectContaining({
        owner: "member-b",
        id: "11",
        via: { kind: "shared" },
      })
    )
    expect(useCoworkTeamStore.getState().summary?.sharedNew).toBe(0)
  })

  it("点自己会话的留言条目：切到那个会话、打开留言栏并调 comments_seen", async () => {
    makeAvailable()
    const onOpenOwn = vi.fn()
    renderInbox(onOpenOwn)
    await openInbox()
    fireEvent.click(
      inboxItem("comment:member-c/42").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
    expect(onOpenOwn).toHaveBeenCalledWith(42)
    expect(useOwnCommentsStore.getState().openFor).toBe("42")
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-c", "42")
    expect(useCoworkTeamStore.getState().viewing).toBeNull()
    expect(useCoworkTeamStore.getState().summary?.commentUnread.total).toBe(2)
  })

  it("点回复条目：只读打开对方的会话并调 comments_seen", async () => {
    makeAvailable()
    const onOpenOwn = vi.fn()
    renderInbox(onOpenOwn)
    await openInbox()
    fireEvent.click(
      inboxItem("reply:member-a/7").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
    expect(onOpenOwn).not.toHaveBeenCalled()
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-a", "7")
    await waitFor(() =>
      expect(useCoworkTeamStore.getState().viewing).toEqual(
        expect.objectContaining({
          owner: "member-a",
          id: "7",
          via: { kind: "shared" },
        })
      )
    )
    expect(useCoworkTeamStore.getState().summary?.commentUnread.total).toBe(3)
  })

  function clickReply() {
    fireEvent.click(
      inboxItem("reply:member-a/7").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
  }

  it("回复条目：会话分享给了我（已看过也算）时按「由对方分享」打开", async () => {
    api.teamShared.mockResolvedValue([
      ...SHARED,
      item({ id: "7", title: "Their session", isNew: false }),
    ])
    makeAvailable(SUMMARY, [{ id: "g1", name: "Backend" }])
    renderInbox()
    await openInbox()
    clickReply()
    await waitFor(() =>
      expect(useCoworkTeamStore.getState().viewing?.via).toEqual({
        kind: "shared",
      })
    )
    expect(api.teamView).not.toHaveBeenCalled()
  })

  it("回复条目：没分享给我、我是对方的组长时按组长身份打开", async () => {
    makeAvailable(SUMMARY, [{ id: "g1", name: "Backend" }])
    renderInbox()
    await openInbox()
    clickReply()
    await waitFor(() =>
      expect(useCoworkTeamStore.getState().viewing).toEqual(
        expect.objectContaining({
          owner: "member-a",
          id: "7",
          via: { kind: "leader", groupName: "Backend" },
        })
      )
    )
  })

  it("回复条目：当好几个组的组长时，查出对方在哪个组", async () => {
    api.teamView.mockImplementation(async (groupId: string) => ({
      id: groupId,
      name: groupId === "g1" ? "Backend" : "Frontend",
      since: "",
      members:
        groupId === "g2"
          ? [
              {
                name: "member-a",
                label: "小王",
                running: 0,
                waiting: 0,
                sessions: [],
              },
            ]
          : [],
    }))
    makeAvailable(SUMMARY, [
      { id: "g1", name: "Backend" },
      { id: "g2", name: "Frontend" },
    ])
    renderInbox()
    await openInbox()
    clickReply()
    await waitFor(() =>
      expect(useCoworkTeamStore.getState().viewing?.via).toEqual({
        kind: "leader",
        groupName: "Frontend",
      })
    )
  })

  it("进组提示的「知道了」调 group_notice_dismiss", async () => {
    makeAvailable()
    renderInbox()
    await openInbox()
    fireEvent.click(screen.getByRole("button", { name: "Got it" }))
    expect(api.teamGroupNoticeDismiss).toHaveBeenCalledWith("n1")
    await waitFor(() => expect(itemKeys()).not.toContain("group:n1"))
    expect(useCoworkTeamStore.getState().summary?.groupNotices).toEqual([])
  })

  it("一条条标已读，也能全部标已读", async () => {
    makeAvailable()
    renderInbox()
    await openInbox()
    fireEvent.click(
      inboxItem("reply:member-a/7").querySelector<HTMLElement>(
        "[data-inbox-mark-read]"
      )!
    )
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-a", "7")
    expect(itemKeys()).not.toContain("reply:member-a/7")
    // 标已读不打开会话。
    expect(useCoworkTeamStore.getState().viewing).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(api.teamSharedSeen).toHaveBeenCalledWith("member-b", "11")
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-c", "42")
    expect(api.teamGroupNoticeDismiss).toHaveBeenCalledWith("n1")
    await waitFor(() => expect(itemKeys()).toEqual([]))
    expect(teamInboxUnread(useCoworkTeamStore.getState().summary)).toBe(0)
    expect(useOwnCommentsStore.getState().openFor).toBeNull()
  })

  it("分享列表还在加载时，全部标已读也把新分享标掉", async () => {
    makeAvailable({
      sharedNew: 1,
      commentUnread: { total: 0, sessions: [] },
      groupNotices: [],
    })
    // 打开时那一次一直不回来；全部标已读时现拉的那一次才回来。
    api.teamShared
      .mockReset()
      .mockReturnValueOnce(new Promise<TeamSharedItem[]>(() => {}))
      .mockResolvedValue(SHARED)
    renderInbox()
    fireEvent.click(inboxButton())
    const markAll = screen.getByRole("button", { name: "Mark all read" })
    expect(markAll).not.toBeDisabled()
    fireEvent.click(markAll)
    await waitFor(() =>
      expect(api.teamSharedSeen).toHaveBeenCalledWith("member-b", "11")
    )
    expect(api.teamSharedSeen).toHaveBeenCalledTimes(1)
    expect(useCoworkTeamStore.getState().summary?.sharedNew).toBe(0)
    expect(itemKeys()).toEqual([])
  })

  it("分享列表加载失败时，全部标已读重新拉一次再把新分享标掉", async () => {
    makeAvailable()
    api.teamShared
      .mockReset()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValue(SHARED)
    renderInbox()
    fireEvent.click(inboxButton())
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy()
    )
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    expect(api.teamCommentsSeen).toHaveBeenCalledWith("member-c", "42")
    expect(api.teamGroupNoticeDismiss).toHaveBeenCalledWith("n1")
    await waitFor(() =>
      expect(api.teamSharedSeen).toHaveBeenCalledWith("member-b", "11")
    )
    await waitFor(() => expect(itemKeys()).toEqual([]))
    expect(teamInboxUnread(useCoworkTeamStore.getState().summary)).toBe(0)
  })
})

describe("回复条目和访问来源（第 3 次返工）", () => {
  it("查访问来源期间切到了自己的会话：回来后不再盖上只读视图", async () => {
    const resolvers: ((v: unknown) => void)[] = []
    const resolveView = (v: unknown) => resolvers.forEach((r) => r(v))
    api.teamView.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve))
    )
    makeAvailable(SUMMARY, [
      { id: "g1", name: "Backend" },
      { id: "g2", name: "Frontend" },
    ])
    renderInbox()
    await openInbox()
    fireEvent.click(
      inboxItem("reply:member-a/7").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
    // 查各组成员还没回来，用户在侧栏点了自己的会话。
    const own = document.createElement("div")
    own.setAttribute("data-conversation-id", "42")
    document.body.appendChild(own)
    fireEvent.pointerDown(own)
    own.remove()
    await act(async () => {
      resolveView({ id: "g", name: "x", since: "", members: [] })
      await Promise.resolve()
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(useCoworkTeamStore.getState().viewing).toBeNull()
  })

  it("查访问来源期间切了标签：回来后不再盖上只读视图", async () => {
    const resolvers: ((v: unknown) => void)[] = []
    const resolveView = (v: unknown) => resolvers.forEach((r) => r(v))
    api.teamView.mockImplementation(
      () => new Promise((resolve) => resolvers.push(resolve))
    )
    makeAvailable(SUMMARY, [
      { id: "g1", name: "Backend" },
      { id: "g2", name: "Frontend" },
    ])
    renderInbox()
    await openInbox()
    fireEvent.click(
      inboxItem("reply:member-a/7").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
    act(() => {
      useTabStore.setState({ activeTabId: "some-other-tab" })
    })
    await act(async () => {
      resolveView({ id: "g", name: "x", since: "", members: [] })
      await Promise.resolve()
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(useCoworkTeamStore.getState().viewing).toBeNull()
  })

  it("分享列表查不到、我又是组长：不确定对方在我组里时按分享来的写", async () => {
    api.teamShared.mockReset().mockRejectedValue(new Error("boom"))
    const via = await resolveReplyVia({ owner: "member-a", id: "7" }, null, [
      { id: "g1", name: "Backend" },
    ])
    expect(via).toEqual({ kind: "shared" })
  })

  it("分享列表查不到、查得到对方在我当组长的组里：按组长身份写", async () => {
    api.teamShared.mockReset().mockRejectedValue(new Error("boom"))
    api.teamView.mockResolvedValue({
      id: "g1",
      name: "Backend",
      since: "",
      members: [
        {
          name: "member-a",
          label: "小王",
          running: 0,
          waiting: 0,
          sessions: [],
        },
      ],
    })
    const via = await resolveReplyVia({ owner: "member-a", id: "7" }, null, [
      { id: "g1", name: "Backend" },
    ])
    expect(via).toEqual({ kind: "leader", groupName: "Backend" })
  })
})

describe("重新打开收件箱时的旧分享列表（第 4 次返工）", () => {
  const NO_SHARES: CoworkTeamSummary = {
    sharedNew: 0,
    commentUnread: { total: 0, sessions: [] },
    groupNotices: [],
  }

  async function openThenClose() {
    fireEvent.click(inboxButton())
    await waitFor(() => expect(api.teamShared).toHaveBeenCalledTimes(1))
    await act(async () => {
      await Promise.resolve()
    })
    fireEvent.click(inboxButton())
    await waitFor(() =>
      expect(document.querySelector("[data-team-inbox]")).toBeNull()
    )
  }

  it("关着期间来了新分享，重新打开、新列表回来前全部标已读：也把新分享标掉", async () => {
    makeAvailable(NO_SHARES)
    api.teamShared.mockReset().mockResolvedValueOnce([SHARED[0]])
    renderInbox()
    await openThenClose()
    // 关着期间来了一条新分享。
    act(() => {
      useCoworkTeamStore.getState().setSummary({ ...NO_SHARES, sharedNew: 1 })
    })
    // 重新打开时那一次一直不回来；全部标已读时现拉的那一次才回来。
    api.teamShared
      .mockReturnValueOnce(new Promise<TeamSharedItem[]>(() => {}))
      .mockResolvedValue(SHARED)
    fireEvent.click(inboxButton())
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    await waitFor(() =>
      expect(api.teamSharedSeen).toHaveBeenCalledWith("member-b", "11")
    )
    expect(useCoworkTeamStore.getState().summary?.sharedNew).toBe(0)
  })

  it("旧列表里的分享已在别处看过、关着期间又来一条新分享：全部标已读也把新的标掉", async () => {
    makeAvailable({ ...NO_SHARES, sharedNew: 1 })
    // 第一次打开时 11 还是新的。
    api.teamShared.mockReset().mockResolvedValueOnce(SHARED)
    renderInbox()
    await openThenClose()
    // 关着期间 11 在别处看过了，又来了一条新分享 12：数字还是 1。
    act(() => {
      useCoworkTeamStore.getState().setSummary({ ...NO_SHARES, sharedNew: 1 })
    })
    const fresh = item({ owner: "member-d", id: "12", isNew: true })
    api.teamShared
      .mockReturnValueOnce(new Promise<TeamSharedItem[]>(() => {}))
      .mockResolvedValue([{ ...SHARED[1], isNew: false }, fresh])
    fireEvent.click(inboxButton())
    // 新列表回来前手上还是旧的，里面有已经看过的 11。
    await waitFor(() => expect(itemKeys()).toContain("share:member-b/11"))
    fireEvent.click(screen.getByRole("button", { name: "Mark all read" }))
    await waitFor(() =>
      expect(api.teamSharedSeen).toHaveBeenCalledWith("member-d", "12")
    )
    expect(useCoworkTeamStore.getState().summary?.sharedNew).toBe(0)
  })

  it("关着期间同事分享了会话又回复，重新打开、新列表回来前点回复：按分享来的写", async () => {
    makeAvailable(NO_SHARES, [{ id: "g1", name: "Backend" }])
    api.teamShared.mockReset().mockResolvedValueOnce([])
    renderInbox()
    await openThenClose()
    act(() => {
      useCoworkTeamStore.getState().setSummary(SUMMARY)
    })
    api.teamShared
      .mockReturnValueOnce(new Promise<TeamSharedItem[]>(() => {}))
      .mockResolvedValue([
        ...SHARED,
        item({ id: "7", title: "Their session", isNew: false }),
      ])
    fireEvent.click(inboxButton())
    fireEvent.click(
      inboxItem("reply:member-a/7").querySelector<HTMLElement>(
        "[data-inbox-open]"
      )!
    )
    await waitFor(() =>
      expect(useCoworkTeamStore.getState().viewing?.via).toEqual({
        kind: "shared",
      })
    )
  })
})

describe("waitForOwnConversation", () => {
  const conv = {
    id: 42,
    folder_id: 3,
    agent_type: "claude_code",
  } as unknown as DbConversationSummary
  const initial = useAppWorkspaceStore.getState()

  afterEach(() => {
    useAppWorkspaceStore.setState({
      conversations: initial.conversations,
      conversationsLoaded: initial.conversationsLoaded,
      conversationsLoading: initial.conversationsLoading,
      refreshConversations: initial.refreshConversations,
    })
  })

  it("会话列表还在首次加载：等列表回来再给出那个会话", async () => {
    useAppWorkspaceStore.setState({
      conversations: [],
      conversationsLoaded: false,
      conversationsLoading: true,
    })
    const pending = waitForOwnConversation(42)
    act(() => {
      useAppWorkspaceStore.setState({
        conversations: [conv],
        conversationsLoaded: true,
        conversationsLoading: false,
      })
    })
    await expect(pending).resolves.toBe(conv)
  })

  it("列表已加载但没有这个会话：刷新一次再找", async () => {
    const refresh = vi.fn(async () => {
      useAppWorkspaceStore.setState({ conversationsLoading: true })
      await Promise.resolve()
      useAppWorkspaceStore.setState({
        conversations: [conv],
        conversationsLoading: false,
      })
    })
    useAppWorkspaceStore.setState({
      conversations: [],
      conversationsLoaded: true,
      conversationsLoading: false,
      refreshConversations: refresh,
    })
    await expect(waitForOwnConversation(42)).resolves.toBe(conv)
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it("刷新后还是没有：给 null，不一直等", async () => {
    const refresh = vi.fn(async () => {
      useAppWorkspaceStore.setState({ conversationsLoading: true })
      await Promise.resolve()
      useAppWorkspaceStore.setState({ conversationsLoading: false })
    })
    useAppWorkspaceStore.setState({
      conversations: [],
      conversationsLoaded: true,
      conversationsLoading: false,
      refreshConversations: refresh,
    })
    await expect(waitForOwnConversation(42)).resolves.toBeNull()
  })

  it("等的时候用户切到了别的标签：给 null，不再抢着切过去", async () => {
    useAppWorkspaceStore.setState({
      conversations: [],
      conversationsLoaded: false,
      conversationsLoading: true,
    })
    const pending = waitForOwnConversation(42)
    act(() => {
      useTabStore.setState({ activeTabId: "elsewhere" })
      useAppWorkspaceStore.setState({
        conversations: [conv],
        conversationsLoaded: true,
        conversationsLoading: false,
      })
    })
    await expect(pending).resolves.toBeNull()
  })
})
