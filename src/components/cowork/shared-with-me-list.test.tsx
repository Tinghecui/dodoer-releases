import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { TeamSharedItem } from "@/lib/cowork/team"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import { SharedWithMeList, ownerInitial } from "./shared-with-me-list"

const api = vi.hoisted(() => ({
  teamShared: vi.fn<() => Promise<TeamSharedItem[]>>(),
  teamSharedSeen: vi.fn(),
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return {
    ...actual,
    teamShared: api.teamShared,
    teamSharedSeen: api.teamSharedSeen,
  }
})

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

const ITEMS: TeamSharedItem[] = [
  item({ id: "10", title: "Old fix", sharedAt: "2026-11-20T08:00:00Z" }),
  item({
    owner: "member-b",
    ownerLabel: "Lee",
    id: "11",
    title: "Newest refactor",
    sharedAt: "2026-11-22T09:00:00Z",
    isNew: true,
    state: "running",
  }),
  item({ id: "12", title: "Middle task", sharedAt: "2026-11-21T08:00:00Z" }),
]

function makeAvailable(sharedNew: number) {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "丙" },
      leaderOf: [],
      portalUrl: null,
    })
    useCoworkTeamStore.getState().setSummary({
      sharedNew,
      commentUnread: { total: 0, sessions: [] },
      groupNotices: [],
    })
  })
}

function renderList(onOpen?: (item: TeamSharedItem) => void) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SharedWithMeList onOpen={onOpen} />
    </NextIntlClientProvider>
  )
}

function rowKeys(): string[] {
  return Array.from(document.querySelectorAll("[data-shared-session]")).map(
    (el) => el.getAttribute("data-shared-session") ?? ""
  )
}

function row(key: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(
    `[data-shared-session="${key}"]`
  )
  if (!el) throw new Error(`no row ${key}`)
  return el
}

beforeEach(() => {
  useCoworkTeamStore.getState().reset()
  api.teamShared.mockReset().mockResolvedValue(ITEMS)
  api.teamSharedSeen
    .mockReset()
    .mockResolvedValue({ owner: "member-b", id: "11", seenAt: "x" })
})

afterEach(() => {
  useCoworkTeamStore.getState().reset()
})

describe("SharedWithMeList", () => {
  it("按 shared 的返回画行，分享时间新的在前", async () => {
    makeAvailable(1)
    renderList()
    await waitFor(() => expect(rowKeys()).toHaveLength(3))
    expect(rowKeys()).toEqual(["member-b/11", "member-a/12", "member-a/10"])
    expect(row("member-b/11").textContent).toContain("Newest refactor")
    // 主人头像是名字首字。
    expect(row("member-a/12").textContent).toContain("小")
    expect(api.teamShared).toHaveBeenCalledTimes(1)
  })

  it("isNew 的行有「新」点，点开后调 shared_seen，点和数字随之减少", async () => {
    makeAvailable(1)
    const onOpen = vi.fn()
    renderList(onOpen)
    await waitFor(() => expect(rowKeys()).toHaveLength(3))
    expect(row("member-b/11").querySelector("[data-shared-new]")).toBeTruthy()
    expect(row("member-a/10").querySelector("[data-shared-new]")).toBeNull()

    fireEvent.click(row("member-b/11"))
    expect(api.teamSharedSeen).toHaveBeenCalledWith("member-b", "11")
    expect(onOpen).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "member-b", id: "11" })
    )
    expect(row("member-b/11").querySelector("[data-shared-new]")).toBeNull()
    expect(useCoworkTeamStore.getState().summary?.sharedNew).toBe(0)

    // 再点一次不再调 shared_seen，数字也不会减成负数。
    fireEvent.click(row("member-b/11"))
    expect(api.teamSharedSeen).toHaveBeenCalledTimes(1)
    expect(useCoworkTeamStore.getState().summary?.sharedNew).toBe(0)
    // 数字变少不重拉列表。
    expect(api.teamShared).toHaveBeenCalledTimes(1)
  })

  it("标题筛选只在本地过滤", async () => {
    makeAvailable(0)
    renderList()
    await waitFor(() => expect(rowKeys()).toHaveLength(3))
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Filter by title" }),
      {
        target: { value: "REFACTOR" },
      }
    )
    expect(rowKeys()).toEqual(["member-b/11"])
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Filter by title" }),
      {
        target: { value: "nothing like this" },
      }
    )
    expect(rowKeys()).toEqual([])
    expect(screen.getByText("No titles match")).toBeTruthy()
    expect(api.teamShared).toHaveBeenCalledTimes(1)
  })

  it("summary 的新分享数变多时重拉列表", async () => {
    makeAvailable(0)
    renderList()
    await waitFor(() => expect(api.teamShared).toHaveBeenCalledTimes(1))
    act(() =>
      useCoworkTeamStore.getState().setSummary({
        sharedNew: 2,
        commentUnread: { total: 0, sessions: [] },
        groupNotices: [],
      })
    )
    await waitFor(() => expect(api.teamShared).toHaveBeenCalledTimes(2))
  })

  it("新分享数没变的 summary 也重拉列表（同事取消分享、增减抵消）", async () => {
    makeAvailable(1)
    renderList()
    await waitFor(() => expect(rowKeys()).toHaveLength(3))
    // 小王取消了一条分享，同时又来了一条新的：新分享数还是 1。
    api.teamShared.mockResolvedValue([
      item({
        owner: "member-b",
        ownerLabel: "Lee",
        id: "11",
        title: "Newest refactor",
        sharedAt: "2026-11-22T09:00:00Z",
        isNew: true,
      }),
      item({ id: "13", title: "Fresh one", sharedAt: "2026-11-22T10:00:00Z" }),
    ])
    act(() =>
      useCoworkTeamStore.getState().setSummary({
        sharedNew: 1,
        commentUnread: { total: 0, sessions: [] },
        groupNotices: [],
      })
    )
    await waitFor(() => expect(api.teamShared).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(rowKeys()).toEqual(["member-a/13", "member-b/11"])
    )
  })

  it("正在记已读的行，重拉回来也不再显示「新」点", async () => {
    makeAvailable(1)
    let finishSeen: (v: unknown) => void = () => {}
    api.teamSharedSeen.mockReturnValue(
      new Promise((resolve) => {
        finishSeen = resolve
      })
    )
    renderList()
    await waitFor(() => expect(rowKeys()).toHaveLength(3))
    fireEvent.click(row("member-b/11"))
    // shared_seen 还没回来时到了一次 summary：服务端还说它是新的。
    act(() =>
      useCoworkTeamStore.getState().setSummary({
        sharedNew: 1,
        commentUnread: { total: 0, sessions: [] },
        groupNotices: [],
      })
    )
    await waitFor(() => expect(api.teamShared).toHaveBeenCalledTimes(2))
    await act(async () => {})
    expect(row("member-b/11").querySelector("[data-shared-new]")).toBeNull()
    await act(async () => finishSeen({}))
  })

  it("停在列表上时「几分钟前」跟着时间走", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] })
    try {
      vi.setSystemTime(new Date("2026-11-22T09:05:00Z"))
      api.teamShared.mockResolvedValue([
        item({ id: "5", title: "Clock", updatedAt: "2026-11-22T09:00:00Z" }),
      ])
      makeAvailable(0)
      renderList()
      await waitFor(() => expect(rowKeys()).toHaveLength(1))
      const before = row("member-a/5").textContent
      expect(before).toMatch(/5/)
      act(() => {
        vi.setSystemTime(new Date("2026-11-22T12:00:00Z"))
        vi.advanceTimersByTime(60_000)
      })
      const after = row("member-a/5").textContent
      expect(after).not.toBe(before)
      expect(after).toMatch(/3/)
    } finally {
      vi.useRealTimers()
    }
  })

  it("标题和说明按纯文字显示", async () => {
    api.teamShared.mockResolvedValue([
      item({ id: "7", title: "<b>*bold*</b>", note: "<i>note</i>" }),
    ])
    makeAvailable(0)
    renderList()
    await waitFor(() => expect(rowKeys()).toHaveLength(1))
    expect(row("member-a/7").textContent).toContain("<b>*bold*</b>")
    expect(row("member-a/7").querySelector("b")).toBeNull()
    expect(row("member-a/7").getAttribute("title")).toContain("<i>note</i>")
  })

  it("拉取失败时显示错误原文", async () => {
    api.teamShared.mockRejectedValue({
      error: { code: "rate_limited", message: "Too many requests" },
    })
    makeAvailable(0)
    renderList()
    await waitFor(() =>
      expect(document.querySelector("[data-shared-error]")?.textContent).toBe(
        "Couldn't load: Too many requests"
      )
    )
  })
})

describe("ownerInitial", () => {
  it("取名字的第一个字", () => {
    expect(ownerInitial("小王")).toBe("小")
    expect(ownerInitial("lee")).toBe("L")
    expect(ownerInitial("  ")).toBe("?")
  })
})
