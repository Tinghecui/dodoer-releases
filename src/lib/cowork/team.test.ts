import { renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const env = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: env.call }),
}))

import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import {
  COWORK_TEAM_COMMAND,
  CoworkTeamError,
  TEAM_PROBE_MS,
  TEAM_SUMMARY_MS,
  normalizeTeamComments,
  normalizeTeamEntries,
  normalizeTeamShared,
  normalizeTeamSummary,
  normalizeTeamView,
  probeCoworkTeam,
  resetCoworkTeamForTests,
  startCoworkTeamPolling,
  normalizeTeamShares,
  normalizeTeamStatus,
  normalizeTeamTargets,
  teamCommentAdd,
  teamCommentDelete,
  teamCommentForwarded,
  teamEntries,
  teamGroupNoticeDismiss,
  teamSearch,
  teamSessionId,
  teamShare,
  teamShares,
  teamTargets,
  teamUnshare,
  teamView,
  toCoworkTeamError,
  useCoworkTeamPolling,
} from "./team"
import { TEAM_CONTRACT_FIXTURE } from "./team-contract.fixture"

const STATUS = {
  applicable: true,
  enabled: true,
  me: { name: "alice", label: "爱丽丝" },
  leaderOf: [{ id: "1", name: "前端组" }],
  portalUrl: "https://portal.example.com",
}

const SUMMARY = {
  sharedNew: 2,
  commentUnread: {
    total: 3,
    sessions: [
      {
        owner: "alice",
        ownerLabel: "爱丽丝",
        id: "12",
        title: "修登录",
        mine: true,
        count: 3,
      },
    ],
  },
  groupNotices: [{ id: "3", groupName: "前端组", leaders: ["鲍勃"] }],
}

/** 假的命令层：按 op 回答。 */
function answer(byOp: Record<string, unknown | (() => unknown)>) {
  env.call.mockImplementation(
    async (command: string, args: Record<string, unknown>) => {
      expect(command).toBe(COWORK_TEAM_COMMAND)
      const reply = byOp[String(args.op)]
      if (reply === undefined)
        throw { error: { code: "invalid", message: "no op" } }
      return typeof reply === "function" ? (reply as () => unknown)() : reply
    }
  )
}

const ops = () =>
  env.call.mock.calls.map(([, args]) => (args as { op: string }).op)

function setVisibility(state: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  })
  document.dispatchEvent(new Event("visibilitychange"))
}

beforeEach(() => {
  env.call.mockReset()
  resetCoworkTeamForTests()
  setVisibility("visible")
})

afterEach(() => {
  resetCoworkTeamForTests()
  vi.useRealTimers()
})

describe("团队功能可不可用（status）", () => {
  it("命令不存在：服务器回 501", async () => {
    env.call.mockRejectedValue({
      code: "not_implemented",
      message: "API endpoint 'cowork_team' is not available in web mode",
    })
    expect(await probeCoworkTeam()).toBe(false)
    expect(useCoworkTeamStore.getState().available).toBe(false)
    expect(useCoworkTeamStore.getState().probed).toBe(true)
  })

  it("命令不存在：本机桌面调用失败", async () => {
    env.call.mockRejectedValue("Command cowork_team not found")
    expect(await probeCoworkTeam()).toBe(false)
    expect(useCoworkTeamStore.getState().available).toBe(false)
  })

  it("signedOut", async () => {
    answer({ status: { signedOut: true } })
    expect(await probeCoworkTeam()).toBe(false)
    expect(useCoworkTeamStore.getState().available).toBe(false)
  })

  it("applicable 为 false", async () => {
    answer({ status: { ...STATUS, applicable: false } })
    expect(await probeCoworkTeam()).toBe(false)
    expect(useCoworkTeamStore.getState().available).toBe(false)
  })

  it("enabled 为 false", async () => {
    answer({ status: { ...STATUS, enabled: false } })
    expect(await probeCoworkTeam()).toBe(false)
    expect(useCoworkTeamStore.getState().available).toBe(false)
  })

  it("可用时把 status 的结果存进全局 store", async () => {
    answer({ status: { ...STATUS, extra: "忽略" } })
    expect(await probeCoworkTeam()).toBe(true)
    const state = useCoworkTeamStore.getState()
    expect(state.available).toBe(true)
    expect(state.status).toEqual(STATUS)
    expect(env.call).toHaveBeenCalledWith(COWORK_TEAM_COMMAND, { op: "status" })
  })

  it("可用之后再变成不可用：清掉 status 和 summary", async () => {
    answer({ status: STATUS })
    await probeCoworkTeam()
    useCoworkTeamStore.getState().setSummary(normalizeTeamSummary(SUMMARY))
    answer({ status: { signedOut: true } })
    await probeCoworkTeam()
    const state = useCoworkTeamStore.getState()
    expect(state.status).toBeNull()
    expect(state.summary).toBeNull()
  })
})

describe("探测和 summary 轮询", () => {
  it("不可用时不发 summary，每 10 分钟再探一次 status", async () => {
    vi.useFakeTimers()
    env.call.mockRejectedValue({ code: "not_implemented", message: "" })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status"])
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops()).toEqual(["status"])
    await vi.advanceTimersByTimeAsync(1)
    expect(ops()).toEqual(["status", "status"])
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS * 3)
    expect(ops().every((op) => op === "status")).toBe(true)
  })

  it("hook 关着（enabled 为假）什么都不发", async () => {
    vi.useFakeTimers()
    answer({ status: STATUS, summary: SUMMARY })
    renderHook(() => useCoworkTeamPolling(false))
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS * 2)
    expect(env.call).not.toHaveBeenCalled()
  })

  it("可用时马上拉 summary 存进 store，之后每 60 秒一次", async () => {
    vi.useFakeTimers()
    answer({ status: STATUS, summary: SUMMARY })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary"])
    expect(useCoworkTeamStore.getState().summary).toEqual(SUMMARY)
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS - 1)
    expect(ops()).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(ops()).toEqual(["status", "summary", "summary"])
  })

  it("页面不可见时不调 summary，回到前台补一次", async () => {
    vi.useFakeTimers()
    answer({ status: STATUS, summary: SUMMARY })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary"])
    setVisibility("hidden")
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS * 5)
    expect(ops()).toEqual(["status", "summary"])
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary", "summary"])
    // 回到前台后照常每 60 秒一次，不因为切换多发。
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    expect(ops()).toHaveLength(4)
  })

  it("summary 收到 signedOut：立刻停掉轮询、收起入口，10 分钟后才再探", async () => {
    vi.useFakeTimers()
    let signedOut = false
    answer({
      status: () => (signedOut ? { signedOut: true } : STATUS),
      summary: () => (signedOut ? { signedOut: true } : SUMMARY),
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    signedOut = true
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    expect(ops()).toEqual(["status", "summary", "summary"])
    expect(useCoworkTeamStore.getState().available).toBe(false)
    expect(useCoworkTeamStore.getState().summary).toBeNull()
    // 切到前台也不补发。
    setVisibility("hidden")
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1)
    expect(ops()).toEqual(["status", "summary", "summary", "status"])
    // 还是 signedOut：不拉 summary，接着等 10 分钟。
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops()).toHaveLength(4)
  })

  it("summary 回 sharing_disabled：收起入口，回到每 10 分钟探测", async () => {
    vi.useFakeTimers()
    let off = false
    answer({
      status: STATUS,
      summary: () => {
        if (off)
          throw { error: { code: "sharing_disabled", message: "已关闭" } }
        return SUMMARY
      },
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    off = true
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    expect(useCoworkTeamStore.getState().available).toBe(false)
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops()).toEqual(["status", "summary", "summary"])
  })

  it("summary 偶尔失败（网络）：保留旧数据，下次照常", async () => {
    vi.useFakeTimers()
    let fail = false
    answer({
      status: STATUS,
      summary: () => {
        if (fail) throw new Error("Request timed out")
        return SUMMARY
      },
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    fail = true
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    expect(useCoworkTeamStore.getState().available).toBe(true)
    expect(useCoworkTeamStore.getState().summary).toEqual(SUMMARY)
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    expect(ops()).toEqual(["status", "summary", "summary", "summary"])
  })

  it("可用期间也每 10 分钟重新探一次 status，变了就更新 store", async () => {
    vi.useFakeTimers()
    let status: unknown = STATUS
    answer({ status: () => status, summary: SUMMARY })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary"])
    // 期间不再是组长了。
    status = { ...STATUS, leaderOf: [] }
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops().filter((op) => op === "status")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(ops().filter((op) => op === "status")).toHaveLength(2)
    expect(useCoworkTeamStore.getState().status?.leaderOf).toEqual([])
    expect(useCoworkTeamStore.getState().available).toBe(true)
    // 再过 10 分钟，探到 signedOut：收起入口，不再拉 summary。
    status = { signedOut: true }
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS)
    expect(ops().filter((op) => op === "status")).toHaveLength(3)
    expect(useCoworkTeamStore.getState().available).toBe(false)
    const n = ops().length
    expect(ops()[n - 1]).toBe("status")
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops()).toHaveLength(n)
  })

  it("summary 每次要 10 秒才回来：重新探 status 仍在 10 分钟整到点，不被推迟", async () => {
    vi.useFakeTimers()
    answer({
      status: STATUS,
      summary: () =>
        new Promise((resolve) => setTimeout(() => resolve(SUMMARY), 10_000)),
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary"])
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops().filter((op) => op === "status")).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(ops().filter((op) => op === "status")).toHaveLength(2)
    // 两次探测之间 summary 照旧每 60 秒一次，不因为探测多拉。
    expect(ops().filter((op) => op === "summary").length).toBeLessThanOrEqual(
      TEAM_PROBE_MS / TEAM_SUMMARY_MS
    )
  })

  it("回到前台补取时取消原来到期的定时器，不重复拉", async () => {
    vi.useFakeTimers()
    // summary 要 10 毫秒才回来，好让原来的定时器在请求途中到点。
    answer({
      status: STATUS,
      summary: () =>
        new Promise((resolve) => setTimeout(() => resolve(SUMMARY), 10)),
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(10)
    expect(ops()).toEqual(["status", "summary"])
    // 下一次 summary 已经到期、定时器还差 1 毫秒没跑时切回前台。
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS - 1)
    vi.setSystemTime(Date.now() + 2)
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(10)
    expect(ops()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS - 20)
    expect(ops()).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(20)
    expect(ops()).toHaveLength(4)
  })

  it("别的命令收到 signedOut：报错、收起入口、停掉 summary，10 分钟后才再探", async () => {
    vi.useFakeTimers()
    let signedOut = false
    answer({
      status: () => (signedOut ? { signedOut: true } : STATUS),
      summary: () => (signedOut ? { signedOut: true } : SUMMARY),
      shares: () =>
        signedOut ? { signedOut: true } : { id: "12", shares: [] },
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary"])
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS / 2)
    signedOut = true
    const err = await teamShares("12").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CoworkTeamError)
    expect((err as CoworkTeamError).code).toBe("signed_out")
    expect(useCoworkTeamStore.getState().available).toBe(false)
    expect(useCoworkTeamStore.getState().summary).toBeNull()
    // 原来排着的 summary 不再发；切回前台也不补。
    setVisibility("hidden")
    setVisibility("visible")
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 1)
    expect(ops()).toEqual(["status", "summary", "shares"])
    await vi.advanceTimersByTimeAsync(1)
    expect(ops()).toEqual(["status", "summary", "shares", "status"])
  })

  it("别的命令收到 signedOut 时 summary 正在途中：回来以后也不再接着拉", async () => {
    vi.useFakeTimers()
    let signedOut = false
    answer({
      status: STATUS,
      summary: () =>
        new Promise((resolve) => setTimeout(() => resolve(SUMMARY), 10)),
      targets: () => (signedOut ? { signedOut: true } : { users: [] }),
    })
    startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(10)
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    // 第二次 summary 在途中，这时别的命令发现登录过期。
    expect(ops()).toEqual(["status", "summary", "summary"])
    signedOut = true
    await expect(teamTargets()).rejects.toMatchObject({ code: "signed_out" })
    await vi.advanceTimersByTimeAsync(10)
    expect(useCoworkTeamStore.getState().available).toBe(false)
    expect(useCoworkTeamStore.getState().summary).toBeNull()
    await vi.advanceTimersByTimeAsync(TEAM_PROBE_MS - 20)
    expect(ops()).toEqual(["status", "summary", "summary", "targets"])
  })

  it("几处同时挂着只跑一份；全部退订后停下", async () => {
    vi.useFakeTimers()
    answer({ status: STATUS, summary: SUMMARY })
    const a = startCoworkTeamPolling()
    const b = startCoworkTeamPolling()
    await vi.advanceTimersByTimeAsync(0)
    expect(ops()).toEqual(["status", "summary"])
    a()
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS)
    expect(ops()).toHaveLength(3)
    b()
    await vi.advanceTimersByTimeAsync(TEAM_SUMMARY_MS * 3)
    expect(ops()).toHaveLength(3)
  })
})

describe("宽容地读返回值", () => {
  it("summary 缺字段当空", () => {
    expect(normalizeTeamSummary({})).toEqual({
      sharedNew: 0,
      commentUnread: { total: 0, sessions: [] },
      groupNotices: [],
    })
    expect(normalizeTeamSummary(null).sharedNew).toBe(0)
  })

  it("shared：state 只认三种，缺 owner/id 的行丢掉", () => {
    const list = normalizeTeamShared([
      { owner: "bob", id: "7", state: "waiting", isNew: true, summary: null },
      { owner: "bob", id: 8, state: "weird", summary: { text: "摘要" } },
      { id: "9" },
      "垃圾",
    ])
    expect(list.map((s) => [s.id, s.state, s.isNew, s.summary])).toEqual([
      ["7", "waiting", true, null],
      ["8", "done", false, { text: "摘要" }],
    ])
    expect(list[0].ownerLabel).toBe("bob")
    expect(normalizeTeamShared({ not: "an array" })).toEqual([])
  })

  it("entries：不认识的种类丢掉", () => {
    const page = normalizeTeamEntries({
      agent: { owner: "bob", id: "7", state: "running" },
      entries: [
        { seq: 0, kind: "user", text: "问", ts: "t" },
        { seq: 1, kind: "image", text: "?" },
        { seq: 2, kind: "tool", text: "ls" },
      ],
      total: 3,
    })
    expect(page.entries.map((e) => e.seq)).toEqual([0, 2])
    expect(page.agent.state).toBe("running")
    expect(page.reason).toBeNull()
  })

  it("comments：seq、parentId、anchor 可为 null", () => {
    const page = normalizeTeamComments({
      isOwner: true,
      ids: ["5", 6],
      comments: [{ id: 5, body: "<b>*hi*</b>", seq: null, canDelete: 1 }],
    })
    expect(page.isOwner).toBe(true)
    expect(page.ids).toEqual(["5", "6"])
    expect(page.comments[0]).toMatchObject({
      id: "5",
      body: "<b>*hi*</b>",
      seq: null,
      parentId: null,
      anchor: null,
      canDelete: false,
      forwardedAt: null,
    })
  })

  it("comments：forwardedAt 有就带上，缺了是 null", () => {
    const page = normalizeTeamComments({
      isOwner: true,
      comments: [
        { id: 5, body: "a", forwardedAt: "2026-11-24T08:00:00Z" },
        { id: 6, body: "b", forwardedAt: null },
      ],
    })
    expect(page.comments.map((c) => c.forwardedAt)).toEqual([
      "2026-11-24T08:00:00Z",
      null,
    ])
  })

  it("team：会话缺 owner 时用成员名", () => {
    const view = normalizeTeamView({
      id: 1,
      members: [
        { name: "bob", running: 1, sessions: [{ id: "3", state: "running" }] },
        { label: "没名字" },
      ],
    })
    expect(view.members).toHaveLength(1)
    expect(view.members[0]).toMatchObject({ running: 1, waiting: 0 })
    expect(view.members[0].sessions[0].owner).toBe("bob")
  })
})

describe("命令和错误", () => {
  it("share 按契约发 op、id、targets、note", async () => {
    answer({ share: { id: "12", shares: [] } })
    await teamShare("12", [{ type: "user", name: "bob" }], "看看")
    expect(env.call).toHaveBeenCalledWith(COWORK_TEAM_COMMAND, {
      op: "share",
      id: "12",
      targets: [{ type: "user", name: "bob" }],
      note: "看看",
    })
  })

  it("unshare 不给 target = 全部取消（不带 target 字段）", async () => {
    answer({ unshare: { id: "12", shares: [] } })
    await teamUnshare("12")
    expect(env.call).toHaveBeenLastCalledWith(COWORK_TEAM_COMMAND, {
      op: "unshare",
      id: "12",
    })
    await teamUnshare("12", { type: "group", id: "1" })
    expect(env.call).toHaveBeenLastCalledWith(COWORK_TEAM_COMMAND, {
      op: "unshare",
      id: "12",
      target: { type: "group", id: 1 },
    })
  })

  it("entries、comment_add、team 按契约发参数", async () => {
    answer({
      entries: { entries: [] },
      comment_add: { id: 9, body: "好" },
      team: { id: 1, members: [] },
    })
    await teamEntries("bob", "7", -1)
    expect(env.call).toHaveBeenLastCalledWith(COWORK_TEAM_COMMAND, {
      op: "entries",
      owner: "bob",
      id: "7",
      after: -1,
    })
    await teamCommentAdd("bob", "7", "好", { seq: 3 })
    expect(env.call).toHaveBeenLastCalledWith(COWORK_TEAM_COMMAND, {
      op: "comment_add",
      owner: "bob",
      id: "7",
      body: "好",
      seq: 3,
    })
    await teamView("1")
    expect(env.call).toHaveBeenLastCalledWith(COWORK_TEAM_COMMAND, {
      op: "team",
      group: 1,
    })
  })

  it("服务端错误原文保留成 CoworkTeamError", async () => {
    env.call.mockRejectedValue({
      error: { code: "not_found", message: "没有这个会话" },
    })
    const err = await teamShares("12").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CoworkTeamError)
    expect(err).toMatchObject({ code: "not_found", message: "没有这个会话" })
  })

  it("桌面远程窗口：Rust 把响应体放进 detail", () => {
    const err = toCoworkTeamError({
      code: "network_error",
      message: "Remote returned HTTP 403 Forbidden",
      detail: JSON.stringify({
        error: { code: "forbidden", message: "你已不是组长" },
      }),
    })
    expect(err).toMatchObject({ code: "forbidden", message: "你已不是组长" })
  })

  it("别的失败：code 为 unknown，留着原文", () => {
    expect(toCoworkTeamError(new Error("Request timed out"))).toMatchObject({
      code: "unknown",
      message: "Request timed out",
    })
  })

  it("会话号：只有正整数才有", () => {
    expect(teamSessionId(42)).toBe("42")
    expect(teamSessionId(0)).toBeNull()
    expect(teamSessionId(-3)).toBeNull()
    expect(teamSessionId("42")).toBeNull()
    expect(teamSessionId(undefined)).toBeNull()
  })
})

/** 最后一次发出去的参数。 */
function lastArgs(): Record<string, unknown> {
  const calls = env.call.mock.calls
  return calls[calls.length - 1][1] as Record<string, unknown>
}

/** 什么 op 都回一个空对象，只看发出去的参数。 */
function answerAnything() {
  env.call.mockImplementation(async () => ({}))
}

describe("编号按契约发成数字（#1390）", () => {
  beforeEach(answerAnything)

  it("team、search 的 group 是数字", async () => {
    await teamView("1")
    expect(typeof lastArgs().group).toBe("number")
    expect(lastArgs().group).toBe(1)
    await teamSearch("q", { group: "1" })
    expect(typeof lastArgs().group).toBe("number")
    expect(lastArgs()).toEqual({ op: "search", q: "q", group: 1 })
  })

  it("group_notice_dismiss 的 noticeId 是数字", async () => {
    await teamGroupNoticeDismiss("3")
    expect(typeof lastArgs().noticeId).toBe("number")
    expect(lastArgs().noticeId).toBe(3)
  })

  it("comment_delete、comment_forwarded 的 commentId 是数字，会话号仍是文字", async () => {
    await teamCommentDelete("alice", "75", "9")
    expect(typeof lastArgs().commentId).toBe("number")
    expect(lastArgs().commentId).toBe(9)
    expect(typeof lastArgs().id).toBe("string")
    expect(lastArgs().id).toBe("75")
    expect(typeof lastArgs().owner).toBe("string")
    await teamCommentForwarded("75", "9")
    expect(typeof lastArgs().commentId).toBe("number")
    expect(lastArgs().commentId).toBe(9)
    expect(typeof lastArgs().id).toBe("string")
  })

  it("comment_add 的 replyTo 是数字", async () => {
    env.call.mockImplementation(async () => ({ id: 10, body: "好" }))
    await teamCommentAdd("alice", "75", "好", { replyTo: "9" })
    expect(typeof lastArgs().replyTo).toBe("number")
    expect(lastArgs().replyTo).toBe(9)
    expect(typeof lastArgs().id).toBe("string")
    expect(typeof lastArgs().owner).toBe("string")
  })

  it("share、unshare 里组对象的 id 是数字，个人对象原样", async () => {
    await teamShare("75", [
      { type: "group", id: "1" },
      { type: "user", name: "bob" },
    ])
    const targets = lastArgs().targets as Record<string, unknown>[]
    expect(typeof targets[0].id).toBe("number")
    expect(targets[0]).toEqual({ type: "group", id: 1 })
    expect(targets[1]).toEqual({ type: "user", name: "bob" })
    expect(typeof lastArgs().id).toBe("string")
    await teamUnshare("75", { type: "group", id: "1" })
    const target = lastArgs().target as Record<string, unknown>
    expect(typeof target.id).toBe("number")
    expect(target).toEqual({ type: "group", id: 1 })
    await teamUnshare("75", { type: "user", name: "bob" })
    expect(lastArgs().target).toEqual({ type: "user", name: "bob" })
  })
})

describe("坏编号不发请求（#1390）", () => {
  beforeEach(answerAnything)

  const BAD = ["", "g1", "1.5", "-1", "0", " 1", "9007199254740992"]

  async function expectInvalid(run: () => Promise<unknown>) {
    const err = await run().then(
      () => null,
      (e: unknown) => e
    )
    expect(err).toBeInstanceOf(CoworkTeamError)
    expect((err as CoworkTeamError).code).toBe("invalid")
  }

  it.each(BAD)("编号 %j：各个包装函数都抛 invalid、不调命令层", async (bad) => {
    await expectInvalid(() => teamView(bad))
    await expectInvalid(() => teamSearch("q", { group: bad }))
    await expectInvalid(() => teamGroupNoticeDismiss(bad))
    await expectInvalid(() => teamCommentDelete("alice", "75", bad))
    await expectInvalid(() => teamCommentForwarded("75", bad))
    await expectInvalid(() =>
      teamCommentAdd("alice", "75", "好", { replyTo: bad })
    )
    await expectInvalid(() => teamShare("75", [{ type: "group", id: bad }]))
    await expectInvalid(() => teamUnshare("75", { type: "group", id: bad }))
    expect(env.call).not.toHaveBeenCalled()
  })
})

describe("契约样例：读进来的编号原样发回去还是同一个数字（#1390）", () => {
  const F = TEAM_CONTRACT_FIXTURE

  beforeEach(answerAnything)

  it("status.leaderOf 的组号 → team", async () => {
    const [g] = normalizeTeamStatus(F.status).leaderOf
    await teamView(g.id)
    expect(lastArgs().group).toBe(F.status.leaderOf[0].id)
    expect(typeof lastArgs().group).toBe("number")
  })

  it("summary.groupNotices 的编号 → group_notice_dismiss", async () => {
    const [n] = normalizeTeamSummary(F.summary).groupNotices
    await teamGroupNoticeDismiss(n.id)
    expect(lastArgs().noticeId).toBe(F.summary.groupNotices[0].id)
    expect(typeof lastArgs().noticeId).toBe("number")
  })

  it("targets.groups 的组号 → share、search", async () => {
    const [g] = normalizeTeamTargets(F.targets).groups
    await teamShare("75", [{ type: "group", id: g.id }])
    const targets = lastArgs().targets as Record<string, unknown>[]
    expect(targets[0].id).toBe(F.targets.groups[0].id)
    expect(typeof targets[0].id).toBe("number")
    await teamSearch("q", { group: g.id })
    expect(lastArgs().group).toBe(F.targets.groups[0].id)
  })

  it("shares 里的组对象 → unshare", async () => {
    const share = normalizeTeamShares(F.shares).shares.find(
      (s) => s.type === "group"
    )
    if (share?.type !== "group") throw new Error("样例里要有组对象")
    await teamUnshare("75", { type: "group", id: share.id })
    const target = lastArgs().target as Record<string, unknown>
    expect(target.id).toBe(F.shares.shares[1].id)
    expect(typeof target.id).toBe("number")
  })

  it("comments 的 id、parentId → comment_delete、comment_forwarded、comment_add", async () => {
    const [first, reply] = normalizeTeamComments(F.comments).comments
    await teamCommentDelete("alice", "75", first.id)
    expect(lastArgs().commentId).toBe(F.comments.comments[0].id)
    expect(typeof lastArgs().commentId).toBe("number")
    await teamCommentForwarded("75", first.id)
    expect(lastArgs().commentId).toBe(F.comments.comments[0].id)
    env.call.mockImplementation(async () => ({ id: 11, body: "好" }))
    await teamCommentAdd("alice", "75", "好", { replyTo: reply.parentId! })
    expect(lastArgs().replyTo).toBe(F.comments.comments[1].parentId)
    expect(typeof lastArgs().replyTo).toBe("number")
  })

  it("shared[].via 的组号、team.id → team", async () => {
    const [item] = normalizeTeamShared(F.shared)
    const via = item.via.find((v) => v.type === "group")
    await teamView(via!.id!)
    expect(lastArgs().group).toBe(F.shared[0].via[1].id)
    const view = normalizeTeamView(F.team)
    await teamView(view.id)
    expect(lastArgs().group).toBe(F.team.id)
    expect(typeof lastArgs().group).toBe("number")
  })
})
