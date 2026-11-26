import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import {
  CoworkTeamError,
  type TeamGroupRef,
  type TeamMember,
  type TeamView,
} from "@/lib/cowork/team"
import {
  useCoworkTeamStore,
  type SharedSessionTarget,
} from "@/stores/cowork-team-store"
import { TeamMembersList, teamSinceFor } from "./team-members-list"

const api = vi.hoisted(() => ({
  teamView: vi.fn<(group: string, since?: string) => Promise<TeamView>>(),
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return { ...actual, teamView: api.teamView }
})

const NOW = Date.parse("2026-11-22T12:00:00Z")

const MEMBERS: TeamMember[] = [
  {
    name: "member-a",
    label: "小王",
    running: 2,
    waiting: 1,
    sessions: [
      {
        owner: "member-a",
        id: "41",
        title: "Fix login",
        state: "running",
        updatedAt: "2026-11-22T11:57:00Z",
        summary: null,
      },
      {
        owner: "member-a",
        id: "42",
        title: "Ask about schema",
        state: "waiting",
        updatedAt: "2026-11-22T11:50:00Z",
        summary: null,
      },
      {
        owner: "member-a",
        id: "43",
        title: "Old cleanup",
        state: "done",
        updatedAt: "2026-11-22T09:00:00Z",
        summary: null,
      },
    ],
  },
  {
    name: "member-b",
    label: "Lee",
    running: 0,
    waiting: 3,
    sessions: [],
  },
]

function teamOf(name: string, id = "g1"): TeamView {
  return { id, name, since: "2026-11-22T00:00:00Z", members: MEMBERS }
}

function makeAvailable(leaderOf: TeamGroupRef[]) {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "leader-c", label: "老陈" },
      leaderOf,
      portalUrl: null,
    })
    useCoworkTeamStore.getState().setSummary({
      sharedNew: 0,
      commentUnread: { total: 0, sessions: [] },
      groupNotices: [],
    })
  })
}

function renderList(onOpen?: (target: SharedSessionTarget) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <TeamMembersList onOpen={onOpen} />
    </NextIntlClientProvider>
  )
}

const memberRow = (name: string) =>
  document.querySelector<HTMLButtonElement>(
    `[data-team-member="${name}"] [data-team-member-row]`
  )!
const sessionKeys = () =>
  Array.from(document.querySelectorAll("[data-team-session]")).map((el) =>
    el.getAttribute("data-team-session")
  )

describe("TeamMembersList", () => {
  beforeEach(() => {
    useCoworkTeamStore.getState().reset()
    api.teamView.mockReset().mockResolvedValue(teamOf("Backend"))
    vi.spyOn(Date, "now").mockReturnValue(NOW)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    useCoworkTeamStore.getState().reset()
  })

  it("draws one row per member with the counts from `team`", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    renderList()
    await act(async () => {})
    expect(api.teamView).toHaveBeenCalledTimes(1)
    expect(api.teamView).toHaveBeenCalledWith("g1", undefined)
    const rows = document.querySelectorAll("[data-team-member]")
    expect(
      Array.from(rows).map((r) => r.getAttribute("data-team-member"))
    ).toEqual(["member-a", "member-b"])
    // 数字原样用 `team` 给的，不从会话自己数（小王只有 1 个进行中的会话行）。
    expect(memberRow("member-a").textContent).toContain("小王")
    expect(
      memberRow("member-a").querySelector("[data-team-member-counts]")
        ?.textContent
    ).toBe("2 running · 1 to review")
    expect(
      memberRow("member-b").querySelector("[data-team-member-counts]")
        ?.textContent
    ).toBe("0 running · 3 to review")
  })

  it("folds sessions under each member and expands on click", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    renderList()
    await act(async () => {})
    expect(sessionKeys()).toEqual([])
    expect(memberRow("member-a").getAttribute("aria-expanded")).toBe("false")
    fireEvent.click(memberRow("member-a"))
    expect(memberRow("member-a").getAttribute("aria-expanded")).toBe("true")
    expect(sessionKeys()).toEqual(["member-a/41", "member-a/42", "member-a/43"])
    fireEvent.click(memberRow("member-a"))
    expect(sessionKeys()).toEqual([])
  })

  it("filters sessions by state only, locally", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    renderList()
    await act(async () => {})
    fireEvent.click(memberRow("member-a"))
    fireEvent.click(
      document.querySelector('[data-team-state-filter="running"]')!
    )
    expect(sessionKeys()).toEqual(["member-a/41"])
    fireEvent.click(
      document.querySelector('[data-team-state-filter="waiting"]')!
    )
    expect(sessionKeys()).toEqual(["member-a/42"])
    fireEvent.click(document.querySelector('[data-team-state-filter="all"]')!)
    expect(sessionKeys()).toEqual(["member-a/41", "member-a/42", "member-a/43"])
    // 状态筛选不重新请求，成员行和数字都不变。
    expect(api.teamView).toHaveBeenCalledTimes(1)
    expect(
      memberRow("member-a").querySelector("[data-team-member-counts]")
        ?.textContent
    ).toBe("2 running · 1 to review")
  })

  it("labels finished sessions as ready for review, and says what a blocked one waits for (#1513)", async () => {
    const sessions = MEMBERS[0].sessions
    api.teamView.mockReset().mockResolvedValue({
      ...teamOf("Backend"),
      members: [
        {
          ...MEMBERS[0],
          sessions: [
            ...sessions,
            {
              owner: "member-a",
              id: "44",
              title: "Run migration",
              state: "waiting",
              awaiting: { reason: "permission", title: "Run the script" },
              updatedAt: "2026-11-22T11:40:00Z",
              summary: null,
            },
          ],
        },
      ],
    })
    makeAvailable([{ id: "g1", name: "Backend" }])
    renderList()
    await act(async () => {})
    fireEvent.click(memberRow("member-a"))
    const stateOf = (key: string) =>
      document.querySelector(
        `[data-team-session="${key}"] [data-team-session-state]`
      )
    expect(stateOf("member-a/42")?.textContent).toBe("Ready for review")
    expect(
      stateOf("member-a/42")?.hasAttribute("data-team-session-awaiting")
    ).toBe(false)
    expect(stateOf("member-a/44")?.textContent).toBe("Waiting for approval")
    expect(
      stateOf("member-a/44")?.getAttribute("data-team-session-awaiting")
    ).toBe("permission")
    expect(document.body.textContent).not.toContain("Waiting for an answer")
    // 筛选项也不再写「等人回答」。
    expect(
      document.querySelector('[data-team-state-filter="waiting"]')?.textContent
    ).toBe("Ready for review")
  })

  it("asks without `since` for today and with 7 days ago for the week", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    renderList()
    await act(async () => {})
    expect(api.teamView).toHaveBeenLastCalledWith("g1", undefined)
    fireEvent.click(document.querySelector('[data-team-range="week"]')!)
    await act(async () => {})
    expect(api.teamView).toHaveBeenCalledTimes(2)
    expect(api.teamView).toHaveBeenLastCalledWith(
      "g1",
      "2026-11-15T12:00:00.000Z"
    )
    fireEvent.click(document.querySelector('[data-team-range="today"]')!)
    await act(async () => {})
    expect(api.teamView).toHaveBeenLastCalledWith("g1", undefined)
    expect(teamSinceFor("today", NOW)).toBeUndefined()
    expect(teamSinceFor("week", NOW)).toBe("2026-11-15T12:00:00.000Z")
  })

  it("hides the group picker when leading only one group", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    renderList()
    await act(async () => {})
    expect(document.querySelector("[data-team-group-select]")).toBeNull()
    expect(screen.queryByRole("combobox", { name: "Group" })).toBeNull()
  })

  it("offers a group picker when leading several groups", async () => {
    makeAvailable([
      { id: "g1", name: "Backend" },
      { id: "g2", name: "Frontend" },
    ])
    api.teamView.mockImplementation(async (group) =>
      group === "g2" ? teamOf("Frontend", "g2") : teamOf("Backend")
    )
    renderList()
    await act(async () => {})
    const picker = screen.getByRole("combobox", { name: "Group" })
    expect(api.teamView).toHaveBeenLastCalledWith("g1", undefined)
    fireEvent.change(picker, { target: { value: "g2" } })
    await act(async () => {})
    expect(api.teamView).toHaveBeenLastCalledWith("g2", undefined)
  })

  it.each(["not_found", "forbidden"])(
    "collapses the content and says so when `team` answers %s",
    async (code) => {
      makeAvailable([{ id: "g1", name: "Backend" }])
      renderList()
      await act(async () => {})
      expect(document.querySelectorAll("[data-team-member]").length).toBe(2)
      api.teamView.mockRejectedValue(new CoworkTeamError(code, "nope"))
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
      // 下一次 summary 来了重拉，这次回 not_found / forbidden。
      act(() => {
        useCoworkTeamStore.getState().setSummary({
          sharedNew: 1,
          commentUnread: { total: 0, sessions: [] },
          groupNotices: [],
        })
      })
      await act(async () => {})
      expect(api.teamView).toHaveBeenCalledTimes(2)
      expect(document.querySelectorAll("[data-team-member]").length).toBe(0)
      expect(
        screen.getByText("You are no longer a leader of this group")
      ).toBeTruthy()
      // 专门提示照旧，但服务端原文也记一行，方便排查。
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
        `${code} nope`
      )
      warn.mockRestore()
    }
  )

  it("shows other errors with a retry and keeps nothing stale", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    api.teamView.mockRejectedValueOnce(
      new CoworkTeamError("rate_limited", "Slow down")
    )
    renderList()
    await act(async () => {})
    expect(document.querySelector("[data-team-error]")?.textContent).toContain(
      "Too many actions — try again in a moment"
    )
    expect(
      document.querySelector("[data-team-error]")?.textContent
    ).not.toContain("Slow down")
    fireEvent.click(screen.getByRole("button", { name: "Retry" }))
    await act(async () => {})
    expect(document.querySelector("[data-team-error]")).toBeNull()
    expect(document.querySelectorAll("[data-team-member]").length).toBe(2)
  })

  it("中文界面：读取失败只说「出了点问题，稍后再试」，查不到服务端原文", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {})
    makeAvailable([{ id: "1", name: "预发测试组" }])
    api.teamView.mockRejectedValue(
      new CoworkTeamError("invalid", "group 要是整数")
    )
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <TeamMembersList />
      </NextIntlClientProvider>
    )
    await act(async () => {})
    expect(document.querySelector("[data-team-error]")?.textContent).toContain(
      "读取失败：出了点问题，稍后再试"
    )
    expect(screen.queryByText(/要是整数/)).toBeNull()
  })

  it("opens a session row as the leader's read-only view", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    const onOpen = vi.fn()
    renderList(onOpen)
    await act(async () => {})
    fireEvent.click(memberRow("member-a"))
    fireEvent.click(
      document.querySelector('[data-team-session="member-a/42"]')!
    )
    expect(onOpen).toHaveBeenCalledWith({
      owner: "member-a",
      ownerLabel: "小王",
      id: "42",
      title: "Ask about schema",
      via: { kind: "leader", groupName: "Backend" },
    })
  })

  it("shows member names and titles as plain text", async () => {
    makeAvailable([{ id: "g1", name: "Backend" }])
    api.teamView.mockResolvedValue({
      id: "g1",
      name: "Backend",
      since: "",
      members: [
        {
          name: "member-x",
          label: "<b>X</b>",
          running: 1,
          waiting: 0,
          sessions: [
            {
              owner: "member-x",
              id: "7",
              title: "**bold** <i>t</i>",
              state: "running",
              updatedAt: "",
              summary: null,
            },
          ],
        },
      ],
    })
    renderList()
    await act(async () => {})
    fireEvent.click(memberRow("member-x"))
    expect(screen.getByText("<b>X</b>")).toBeTruthy()
    expect(screen.getByText("**bold** <i>t</i>")).toBeTruthy()
    expect(document.querySelector("[data-team-members-list] b")).toBeNull()
    expect(document.querySelector("[data-team-members-list] i")).toBeNull()
  })
})
