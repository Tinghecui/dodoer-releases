import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  AgentType,
  DbConversationSummary,
  FolderDetail,
} from "@/lib/types"
import {
  DRAFT_CREATE_TICKET_MAX_AGE_MS,
  clearDraftCreateTicket,
  createOrAdoptDraftConversation,
  noteDraftCreateIntent,
  queuedDraftNeedsEarlyCreate,
  readDraftCreateTicket,
  recoverDraftConversation,
  sessionIdForBoundDraft,
  writeDraftCreateTicket,
  shouldCreateDraftEarly,
  startDraftCreateEarly,
} from "./draft-early-create"

// AI QA #650：智能体还没连上时，新草稿按回车就把会话建出来，
// 排队的消息才有会话号可存，刷新不丢。
describe("shouldCreateDraftEarly", () => {
  const base = {
    persisted: false,
    createPending: false,
    isChat: false,
    chatDir: null,
  }

  it("creates for an unsaved draft with nothing in flight", () => {
    expect(shouldCreateDraftEarly(base)).toBe(true)
  })

  it("skips a conversation that already has its row", () => {
    expect(shouldCreateDraftEarly({ ...base, persisted: true })).toBe(false)
  })

  it("skips while another create is in flight", () => {
    expect(shouldCreateDraftEarly({ ...base, createPending: true })).toBe(false)
  })

  it("waits for a chat draft's scratch dir", () => {
    expect(shouldCreateDraftEarly({ ...base, isChat: true })).toBe(false)
    expect(
      shouldCreateDraftEarly({ ...base, isChat: true, chatDir: "/tmp/chat-1" })
    ).toBe(true)
  })
})

describe("startDraftCreateEarly", () => {
  const gate = {
    persisted: false,
    isChat: false,
    chatDir: null,
  }

  it("runs the create once for two sends in a row", async () => {
    const pendingRef = { current: false }
    let resolve!: () => void
    const task = vi.fn(
      () =>
        new Promise<void>((r) => {
          resolve = r
        })
    )
    const onError = vi.fn()
    const first = startDraftCreateEarly(pendingRef, gate, task, onError)
    const second = startDraftCreateEarly(pendingRef, gate, task, onError)
    expect(first).not.toBeNull()
    expect(second).toBeNull()
    expect(task).toHaveBeenCalledTimes(1)
    expect(pendingRef.current).toBe(true)
    resolve()
    await first
    expect(pendingRef.current).toBe(false)
    expect(onError).not.toHaveBeenCalled()
  })

  it("does nothing for a saved conversation", () => {
    const pendingRef = { current: false }
    const task = vi.fn(() => Promise.resolve())
    expect(
      startDraftCreateEarly(
        pendingRef,
        { ...gate, persisted: true },
        task,
        vi.fn()
      )
    ).toBeNull()
    expect(task).not.toHaveBeenCalled()
    expect(pendingRef.current).toBe(false)
  })

  it("releases the guard and reports a failed create", async () => {
    const pendingRef = { current: false }
    const error = new Error("boom")
    const onError = vi.fn()
    const run = startDraftCreateEarly(
      pendingRef,
      gate,
      () => Promise.reject(error),
      onError
    )
    await run
    expect(onError).toHaveBeenCalledWith(error)
    expect(pendingRef.current).toBe(false)
  })
})

// 回车时 chat 草稿的临时目录还没好，没能当场建会话：目录好了、消息还在
// 排队等连接时补建一次（#650 返工）。
describe("queuedDraftNeedsEarlyCreate", () => {
  const base = {
    connectionReady: false,
    persisted: false,
    queueLength: 1,
    headFailed: false,
    pendingWorktree: false,
  }

  it("creates for a message waiting on the connection", () => {
    expect(queuedDraftNeedsEarlyCreate(base)).toBe(true)
  })

  it("leaves it to the send once the agent is ready", () => {
    expect(
      queuedDraftNeedsEarlyCreate({ ...base, connectionReady: true })
    ).toBe(false)
  })

  it("skips a saved conversation and an empty queue", () => {
    expect(queuedDraftNeedsEarlyCreate({ ...base, persisted: true })).toBe(
      false
    )
    expect(queuedDraftNeedsEarlyCreate({ ...base, queueLength: 0 })).toBe(false)
  })

  it("does not create for a message read back after a reload", () => {
    // 刷新前那次建会话可能已经成功了，等用户点重试再建，免得建两个。
    expect(queuedDraftNeedsEarlyCreate({ ...base, headFailed: true })).toBe(
      false
    )
  })

  it("leaves a worktree draft to its own branch", () => {
    expect(
      queuedDraftNeedsEarlyCreate({ ...base, pendingWorktree: true })
    ).toBe(false)
  })
})

// #650 第 2 次返工：按回车后马上刷新，建会话的请求可能已经在后端成功了、
// 浏览器却没收到会话号。刷新回来点重试，要找回那一行，不能再建一个。
describe("createOrAdoptDraftConversation", () => {
  const T0 = Date.parse("2026-11-18T08:00:00Z")

  function row(
    over: Partial<DbConversationSummary> = {}
  ): DbConversationSummary {
    return {
      id: 41,
      folder_id: 7,
      title: "修一下登录页",
      title_locked: false,
      agent_type: "claude_code",
      status: "in_progress",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: new Date(T0 + 300).toISOString(),
      updated_at: new Date(T0 + 300).toISOString(),
      pinned_at: null,
      ...over,
    } as DbConversationSummary
  }

  const folder: FolderDetail = {
    id: 90,
    name: "chat-1",
    path: "/data/chats/chat-1",
  } as FolderDetail

  function deps(rows: DbConversationSummary[] = []) {
    return {
      listAllConversations: vi.fn(async () => rows),
      getFolder: vi.fn(async () => folder),
      createConversation: vi.fn(async () => 55),
      createChatConversation: vi.fn(async () => ({
        conversationId: 66,
        folderId: 90,
        folder,
      })),
      markConversationNotRunning: vi.fn(async () => {}),
    }
  }

  const spec = {
    tabId: "tab-a",
    chat: false,
    agent: "claude_code" as AgentType,
    title: "修一下登录页",
    folderId: 7,
    chatDir: null,
  }

  beforeEach(() => window.sessionStorage.clear())

  it("reuses the row the interrupted create already made", async () => {
    // 刷新前：票据记下了，请求发出去了（后端建了 41），响应没回来。
    const before = deps()
    before.createConversation.mockImplementation(() => new Promise(() => {}))
    void createOrAdoptDraftConversation(spec, before, T0)
    await vi.waitFor(() =>
      expect(before.createConversation).toHaveBeenCalledTimes(1)
    )

    // 刷新回来点重试：
    const after = deps([row()])
    const res = await createOrAdoptDraftConversation(spec, after, T0 + 20_000)
    expect(res).toMatchObject({ conversationId: 41, adopted: true })
    expect(after.createConversation).not.toHaveBeenCalled()
  })

  it("reuses an interrupted chat create in the same scratch dir", async () => {
    const chatSpec = { ...spec, chat: true, chatDir: folder.path }
    const before = deps()
    before.createChatConversation.mockImplementation(
      () => new Promise(() => {})
    )
    void createOrAdoptDraftConversation(chatSpec, before, T0)
    await vi.waitFor(() =>
      expect(before.createChatConversation).toHaveBeenCalledTimes(1)
    )

    const after = deps([row({ kind: "chat", folder_id: 90 })])
    const res = await createOrAdoptDraftConversation(
      chatSpec,
      after,
      T0 + 20_000
    )
    expect(res).toMatchObject({
      conversationId: 41,
      folderId: 90,
      folder,
      adopted: true,
    })
    expect(after.createChatConversation).not.toHaveBeenCalled()
  })

  it("creates when the interrupted request never made a row", async () => {
    writeDraftCreateTicket("tab-a", {
      startedAt: T0,
      agent: "claude_code",
      title: spec.title,
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: [],
    })
    const d = deps([
      row({ message_count: 3 }),
      row({ id: 42, title: "别的会话" }),
      row({ id: 43, folder_id: 8 }),
      row({ id: 44, created_at: new Date(T0 - 3_600_000).toISOString() }),
    ])
    const res = await createOrAdoptDraftConversation(spec, d, T0 + 20_000)
    expect(res).toMatchObject({ conversationId: 55, adopted: false })
  })

  it("without a ticket, notes the rows already there and creates", async () => {
    const d = deps([row(), row({ id: 42, title: "别的会话" })])
    const res = await createOrAdoptDraftConversation(spec, d, T0)
    expect(d.listAllConversations).toHaveBeenCalledTimes(1)
    expect(res).toMatchObject({ conversationId: 55, adopted: false })
    expect(readDraftCreateTicket("tab-a", T0 + 1000)?.knownIds).toEqual([41])
  })

  it("never adopts a matching empty row that existed before the create", async () => {
    // 同文件夹里本来就有一条同标题的空会话 41；这次请求没建成就刷新了。
    const before = deps([row()])
    before.createConversation.mockImplementation(() => new Promise(() => {}))
    void createOrAdoptDraftConversation(spec, before, T0)
    await vi.waitFor(() =>
      expect(before.createConversation).toHaveBeenCalledTimes(1)
    )

    const after = deps([row()])
    const res = await createOrAdoptDraftConversation(spec, after, T0 + 20_000)
    expect(res).toMatchObject({ conversationId: 55, adopted: false })
    expect(after.createConversation).toHaveBeenCalledTimes(1)
  })

  it("does not guess when more than one new row matches", async () => {
    writeDraftCreateTicket("tab-a", {
      startedAt: T0,
      agent: "claude_code",
      title: spec.title,
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: [],
    })
    const d = deps([row(), row({ id: 42 })])
    const res = await createOrAdoptDraftConversation(spec, d, T0 + 20_000)
    expect(res).toMatchObject({ conversationId: 55, adopted: false })
  })

  // 第 8 次返工：不知道发请求前有哪些行，建了以后刷新就认不回来、消息会挂在
  // 新会话页上。这时不建，当建会话失败处理；「要建」的票据留着，刷新回来照样建。
  it("does not create when the rows before the create are unknown", async () => {
    const d = deps()
    d.listAllConversations.mockRejectedValue(new Error("offline"))
    await expect(createOrAdoptDraftConversation(spec, d, T0)).rejects.toThrow(
      "offline"
    )
    expect(d.createConversation).not.toHaveBeenCalled()
    expect(d.createChatConversation).not.toHaveBeenCalled()
    expect(readDraftCreateTicket("tab-a", T0 + 1000)).toMatchObject({
      knownIds: null,
      title: spec.title,
    })
  })

  it("does not create when the lookup fails", async () => {
    writeDraftCreateTicket("tab-a", {
      startedAt: T0,
      agent: "claude_code",
      title: spec.title,
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: [],
    })
    const d = deps()
    d.listAllConversations.mockRejectedValue(new Error("offline"))
    await expect(
      createOrAdoptDraftConversation(spec, d, T0 + 1000)
    ).rejects.toThrow("offline")
    expect(d.createConversation).not.toHaveBeenCalled()
  })

  it("forgets a ticket once cleared or expired", () => {
    const ticket = {
      startedAt: T0,
      agent: "claude_code" as AgentType,
      title: spec.title,
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: [],
    }
    writeDraftCreateTicket("tab-a", ticket)
    expect(readDraftCreateTicket("tab-a", T0 + 1000)).toEqual(ticket)
    expect(readDraftCreateTicket("tab-b", T0 + 1000)).toBeNull()
    expect(
      readDraftCreateTicket("tab-a", T0 + DRAFT_CREATE_TICKET_MAX_AGE_MS + 1)
    ).toBeNull()
    clearDraftCreateTicket("tab-a")
    expect(readDraftCreateTicket("tab-a", T0 + 1000)).toBeNull()
  })

  // #650 第 5 次返工（P1-2）：会话建出来、第一条消息还没发出去时，侧栏不能
  // 一直转圈。建好或找回的行在交给调用方之前先标成不在运行。
  it("marks a created row as not running before handing it over", async () => {
    const d = deps()
    const res = await createOrAdoptDraftConversation(spec, d, T0)
    expect(res.conversationId).toBe(55)
    expect(d.markConversationNotRunning).toHaveBeenCalledWith(55)
  })

  it("marks an adopted row as not running too", async () => {
    writeDraftCreateTicket("tab-a", {
      startedAt: T0,
      agent: "claude_code",
      title: spec.title,
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: [],
    })
    const d = deps([row()])
    const res = await createOrAdoptDraftConversation(spec, d, T0 + 20_000)
    expect(res).toMatchObject({ conversationId: 41, adopted: true })
    expect(d.markConversationNotRunning).toHaveBeenCalledWith(41)
  })

  it("still hands the row over when marking it fails", async () => {
    const d = deps()
    d.markConversationNotRunning.mockRejectedValue(new Error("offline"))
    const res = await createOrAdoptDraftConversation(spec, d, T0)
    expect(res.conversationId).toBe(55)
  })
})

// #650 第 5 次返工（P1-1）：按回车后马上刷新，刷新回来就要停在那次建出来的
// 会话上，不等用户点重试。挂载时只找、不建。
describe("recoverDraftConversation", () => {
  const T0 = Date.parse("2026-11-18T08:00:00Z")
  const folder: FolderDetail = {
    id: 90,
    name: "chat-1",
    path: "/data/chats/chat-1",
  } as FolderDetail

  function row(
    over: Partial<DbConversationSummary> = {}
  ): DbConversationSummary {
    return {
      id: 41,
      folder_id: 90,
      title: "问个问题",
      title_locked: false,
      agent_type: "claude_code",
      status: "in_progress",
      kind: "chat",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: new Date(T0 + 300).toISOString(),
      updated_at: new Date(T0 + 300).toISOString(),
      pinned_at: null,
      ...over,
    } as DbConversationSummary
  }

  function deps(rows: DbConversationSummary[] = []) {
    return {
      listAllConversations: vi.fn(async () => rows),
      getFolder: vi.fn(async () => folder),
      createConversation: vi.fn(async () => 55),
      createChatConversation: vi.fn(async () => ({
        conversationId: 66,
        folderId: 90,
        folder,
      })),
      markConversationNotRunning: vi.fn(async () => {}),
    }
  }

  const chatTicket = {
    startedAt: T0,
    agent: "claude_code" as AgentType,
    title: "问个问题",
    chat: true,
    folderId: null,
    chatDir: folder.path,
    knownIds: [],
  }

  beforeEach(() => window.sessionStorage.clear())

  // 第 7 次返工：找回加了重试、找不到时当场建，等待由测试换成立即返回。
  function recover(
    d: ReturnType<typeof deps>,
    opts: { queued?: boolean; wait?: (ms: number) => Promise<void> } = {}
  ) {
    return recoverDraftConversation("tab-a", d, {
      hasQueued: () => opts.queued ?? true,
      now: T0 + 5000,
      wait: opts.wait ?? (async () => {}),
    })
  }

  it("does nothing for a draft that never started a create", async () => {
    const d = deps([row()])
    expect(await recover(d)).toBeNull()
    expect(d.listAllConversations).not.toHaveBeenCalled()
    expect(d.createChatConversation).not.toHaveBeenCalled()
  })

  it("finds the chat row the interrupted create made, never creating", async () => {
    // 刷新后草稿标签换了一个新的临时目录；找的是票据里那次的目录。
    writeDraftCreateTicket("tab-a", chatTicket)
    const d = deps([row()])
    const res = await recover(d)
    expect(res).toMatchObject({
      conversationId: 41,
      folderId: 90,
      folder,
      adopted: true,
      agent: "claude_code",
      title: "问个问题",
    })
    expect(d.listAllConversations).toHaveBeenCalledWith({
      agent_type: "claude_code",
      folder_ids: null,
    })
    expect(d.markConversationNotRunning).toHaveBeenCalledWith(41)
    expect(d.createChatConversation).not.toHaveBeenCalled()
    expect(d.createConversation).not.toHaveBeenCalled()
  })

  it("finds a project row in the ticket's folder", async () => {
    writeDraftCreateTicket("tab-a", {
      ...chatTicket,
      chat: false,
      folderId: 7,
      chatDir: null,
    })
    const d = deps([row({ kind: "regular", folder_id: 7 })])
    const res = await recover(d)
    expect(res).toMatchObject({ conversationId: 41, folderId: null })
    expect(d.listAllConversations).toHaveBeenCalledWith({
      agent_type: "claude_code",
      folder_ids: [7],
    })
  })

  it("never adopts nor creates when more than one row matches", async () => {
    writeDraftCreateTicket("tab-a", chatTicket)
    const d = deps([row(), row({ id: 42 })])
    expect(await recover(d)).toBeNull()
    expect(d.createChatConversation).not.toHaveBeenCalled()
    expect(d.markConversationNotRunning).not.toHaveBeenCalled()
  })

  // 第 7 次返工（P1）：刷新时建会话的请求还在路上，后端晚一点才建出行。
  it("looks again for a row the create was still making", async () => {
    writeDraftCreateTicket("tab-a", chatTicket)
    const d = deps()
    d.listAllConversations
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row()])
    const wait = vi.fn(async () => {})
    const res = await recover(d, { wait })
    expect(res).toMatchObject({ conversationId: 41, adopted: true })
    expect(wait).toHaveBeenCalledTimes(1)
    expect(d.createChatConversation).not.toHaveBeenCalled()
  })

  // 第 7 次返工（P1）：都找过了还是没有，消息还在排队，就当场建，
  // 消息落到这条会话里，新会话页不再带着它。
  it("creates the conversation when the row never came", async () => {
    writeDraftCreateTicket("tab-a", chatTicket)
    const d = deps([])
    const wait = vi.fn(async () => {})
    const res = await recover(d, { wait })
    expect(wait).toHaveBeenCalledTimes(2)
    expect(d.createChatConversation).toHaveBeenCalledTimes(1)
    expect(d.createChatConversation).toHaveBeenCalledWith(
      "claude_code",
      "问个问题",
      folder.path
    )
    expect(res).toMatchObject({
      conversationId: 66,
      folderId: 90,
      folder,
      adopted: false,
      agent: "claude_code",
      title: "问个问题",
    })
    expect(d.markConversationNotRunning).toHaveBeenCalledWith(66)
  })

  it("creates at once when the create request never went out", async () => {
    writeDraftCreateTicket("tab-a", {
      ...chatTicket,
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: null,
    })
    const d = deps([row({ kind: "regular", folder_id: 7 })])
    const wait = vi.fn(async () => {})
    const res = await recover(d, { wait })
    // 请求没发出去过，同条件的那条老会话不是它建的，不认
    expect(res).toMatchObject({ conversationId: 55, adopted: false })
    expect(d.createConversation).toHaveBeenCalledWith(
      7,
      "claude_code",
      "问个问题"
    )
    expect(wait).not.toHaveBeenCalled()
  })

  it("creates nothing when no message is waiting", async () => {
    writeDraftCreateTicket("tab-a", { ...chatTicket, knownIds: [41] })
    const d = deps([row()])
    expect(await recover(d, { queued: false })).toBeNull()
    expect(d.createChatConversation).not.toHaveBeenCalled()
    writeDraftCreateTicket("tab-a", { ...chatTicket, knownIds: null })
    expect(await recover(d, { queued: false })).toBeNull()
    expect(d.createChatConversation).not.toHaveBeenCalled()
  })
})

// 第 7 次返工（P1）：按回车那一刻就记下要建，查列表、建会话的请求还没发出去
// 就刷新，刷新回来也知道这条消息要落到一条新会话里。
describe("noteDraftCreateIntent", () => {
  const T0 = Date.parse("2026-11-18T08:00:00Z")
  const spec = {
    tabId: "tab-a",
    chat: false,
    agent: "claude_code" as AgentType,
    title: "问个问题",
    folderId: 7,
    chatDir: null,
  }

  beforeEach(() => window.sessionStorage.clear())

  it("notes the create before anything is sent", () => {
    noteDraftCreateIntent(spec, T0)
    expect(readDraftCreateTicket("tab-a", T0 + 10)).toMatchObject({
      agent: "claude_code",
      title: "问个问题",
      chat: false,
      folderId: 7,
      knownIds: null,
    })
  })

  it("keeps an earlier ticket that may have gone out", () => {
    writeDraftCreateTicket("tab-a", {
      startedAt: T0,
      agent: "claude_code",
      title: "早一点的",
      chat: false,
      folderId: 7,
      chatDir: null,
      knownIds: [3],
    })
    noteDraftCreateIntent(spec, T0 + 10)
    expect(readDraftCreateTicket("tab-a", T0 + 20)?.knownIds).toEqual([3])
  })

  it("replaces an earlier note that never went out", () => {
    noteDraftCreateIntent({ ...spec, title: "上一句" }, T0)
    noteDraftCreateIntent(spec, T0 + 10)
    expect(readDraftCreateTicket("tab-a", T0 + 20)?.title).toBe("问个问题")
  })

  it("is noted by the create itself before its first request", () => {
    const listAllConversations = vi.fn(
      () => new Promise<DbConversationSummary[]>(() => {})
    )
    void createOrAdoptDraftConversation(
      spec,
      {
        listAllConversations,
        getFolder: vi.fn(),
        createConversation: vi.fn(),
        createChatConversation: vi.fn(),
        markConversationNotRunning: vi.fn(),
      },
      T0
    )
    expect(listAllConversations).toHaveBeenCalledTimes(1)
    expect(readDraftCreateTicket("tab-a", T0 + 10)?.knownIds).toBeNull()
  })
})

// 第 11 次返工（收件箱 #716 的 P1）：聊天模式回车后 0.3～0.8 秒刷新，刷新回来
// 草稿新建了一个临时目录、连上了一个新会话；找回或补建的那条会话却在刷新前的
// 临时目录里。绑上以后连接换到那个目录，不能再拿新目录里的会话号去续，不然
// 重试发出去以后一直「进行中」、没有回复。
describe("sessionIdForBoundDraft", () => {
  const oldDir = "/scratch/chat-before-reload"
  const newDir = "/scratch/chat-after-reload"

  it("keeps the live session when the row is in the connection's dir", () => {
    expect(
      sessionIdForBoundDraft({
        boundDir: newDir,
        connectionDir: newDir,
        liveSessionId: "sess-live",
      })
    ).toBe("sess-live")
  })

  it("drops the live session when the row is in another dir", () => {
    expect(
      sessionIdForBoundDraft({
        boundDir: oldDir,
        connectionDir: newDir,
        liveSessionId: "sess-live",
      })
    ).toBeNull()
  })

  it("keeps the session for a project row (no dir of its own)", () => {
    expect(
      sessionIdForBoundDraft({
        boundDir: null,
        connectionDir: newDir,
        liveSessionId: "sess-live",
      })
    ).toBe("sess-live")
  })

  it("has nothing to keep without a live session", () => {
    expect(
      sessionIdForBoundDraft({
        boundDir: newDir,
        connectionDir: newDir,
        liveSessionId: null,
      })
    ).toBeNull()
  })

  // 回车后 0.3～0.8 秒刷新的几种落点：建会话的请求还没发出去（只记了「要建」）、
  // 后端已经建出行但浏览器没拿到会话号。两种刷新回来绑上的都是刷新前的目录，
  // 刷新后新连上的会话都不能留。
  it.each([
    ["the create was only noted", false],
    ["the row was made before the reload", true],
  ])(
    "a chat draft reloaded after Enter (%s) reconnects without the new session",
    async (_label, rowMade) => {
      localStorage.clear()
      const tabId = "tab-chat-reload"
      const folder = {
        id: 900,
        path: oldDir,
      } as unknown as FolderDetail
      const rows: DbConversationSummary[] = []
      const deps = {
        listAllConversations: vi.fn(async () => rows),
        getFolder: vi.fn(async () => folder),
        createConversation: vi.fn(async () => 1),
        createChatConversation: vi.fn(async () => ({
          conversationId: 77,
          folderId: 900,
          folder,
        })),
        markConversationNotRunning: vi.fn(async () => {}),
      }
      const spec = {
        tabId,
        chat: true,
        agent: "claude_code" as AgentType,
        title: "你好",
        folderId: 0,
        chatDir: oldDir,
      }
      if (rowMade) {
        await createOrAdoptDraftConversation(spec, deps)
        rows.push({
          id: 77,
          folder_id: 900,
          agent_type: "claude_code",
          title: "你好",
          kind: "chat",
          message_count: 0,
          external_id: null,
          parent_id: null,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        } as unknown as DbConversationSummary)
      } else {
        noteDraftCreateIntent(spec)
      }
      const res = await recoverDraftConversation(tabId, deps, {
        hasQueued: () => true,
        retryDelaysMs: [],
      })
      expect(res).toMatchObject({
        conversationId: 77,
        folder: { path: oldDir },
      })
      expect(
        sessionIdForBoundDraft({
          boundDir: res?.folder?.path,
          connectionDir: newDir,
          liveSessionId: "sess-after-reload",
        })
      ).toBeNull()
    }
  )
})
