import { act, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import type { CoworkTeamSummary } from "@/lib/cowork/team"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"

import { SessionCommentUnreadMark } from "./session-comment-unread-mark"

const mobile = vi.hoisted(() => ({ value: false }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => mobile.value }))

function makeAvailable() {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "Chen" },
      leaderOf: [],
      portalUrl: null,
    })
  })
}

function setSummary(
  sessions: { id: string; count: number; mine: boolean }[]
): void {
  const summary: CoworkTeamSummary = {
    sharedNew: 0,
    commentUnread: {
      total: sessions.reduce((n, s) => n + s.count, 0),
      sessions: sessions.map((s) => ({
        owner: s.mine ? "member-c" : "member-a",
        ownerLabel: s.mine ? "Chen" : "Wang",
        id: s.id,
        title: "t",
        mine: s.mine,
        count: s.count,
      })),
    },
    groupNotices: [],
  }
  act(() => {
    useCoworkTeamStore.getState().setSummary(summary)
  })
}

function mount(conversationId: number | null, locale: "en" | "zh-CN" = "en") {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "en" ? enMessages : zhMessages}
    >
      <SessionCommentUnreadMark conversationId={conversationId} />
    </NextIntlClientProvider>
  )
}

const mark = () =>
  document.querySelector<HTMLElement>("[data-session-comment-unread]")

beforeEach(() => {
  mobile.value = false
  useCoworkTeamStore.getState().reset()
})

describe("SessionCommentUnreadMark", () => {
  it("中文：自己的会话有未读留言时画图标和条数，悬停和读屏是「N 条新留言」", () => {
    makeAvailable()
    setSummary([{ id: "7", count: 3, mine: true }])
    mount(7, "zh-CN")
    expect(mark()).not.toBeNull()
    expect(mark()?.textContent).toBe("3")
    expect(mark()?.title).toBe("3 条新留言")
    expect(mark()?.getAttribute("aria-label")).toBe("3 条新留言")
    expect(mark()?.querySelector("svg")).not.toBeNull()
  })

  it("English plural", () => {
    makeAvailable()
    setSummary([{ id: "7", count: 1, mine: true }])
    mount(7)
    expect(mark()?.title).toBe("1 new comment")
  })

  it("没有这个会话的那一项、条数为 0、只有别人会话的同号项时不画", () => {
    makeAvailable()
    setSummary([
      { id: "8", count: 2, mine: true },
      { id: "7", count: 0, mine: true },
      { id: "9", count: 4, mine: false },
    ])
    const { unmount } = mount(7)
    expect(mark()).toBeNull()
    unmount()
    mount(9)
    expect(mark()).toBeNull()
  })

  it("团队功能不可用时不画", () => {
    makeAvailable()
    setSummary([{ id: "7", count: 3, mine: true }])
    act(() => useCoworkTeamStore.getState().markUnavailable())
    mount(7)
    expect(mark()).toBeNull()
  })

  it("手机端不画", () => {
    mobile.value = true
    makeAvailable()
    setSummary([{ id: "7", count: 3, mine: true }])
    mount(7)
    expect(mark()).toBeNull()
  })

  it("跟着 summary 变：清零后消失", () => {
    makeAvailable()
    setSummary([{ id: "7", count: 2, mine: true }])
    mount(7)
    expect(mark()).not.toBeNull()
    setSummary([])
    expect(mark()).toBeNull()
  })
})
