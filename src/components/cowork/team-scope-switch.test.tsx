import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CoworkTeamStatus, CoworkTeamSummary } from "@/lib/cowork/team"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import {
  TEAM_SCOPE_STORAGE_KEY,
  TeamScopeSwitch,
  resolveTeamScope,
  useTeamScope,
} from "./team-scope-switch"

const transportCall = vi.hoisted(() => vi.fn())
vi.mock("@/lib/transport", () => ({
  getTransport: () => ({ call: transportCall }),
}))

function status(leaderOf: CoworkTeamStatus["leaderOf"] = []): CoworkTeamStatus {
  return {
    applicable: true,
    enabled: true,
    me: { name: "member-a", label: "甲" },
    leaderOf,
    portalUrl: "https://portal.example.com",
  }
}

function summary(sharedNew: number): CoworkTeamSummary {
  return {
    sharedNew,
    commentUnread: { total: 0, sessions: [] },
    groupNotices: [],
  }
}

function makeAvailable(
  leaderOf: CoworkTeamStatus["leaderOf"] = [],
  sharedNew = 0
) {
  act(() => {
    useCoworkTeamStore.getState().setStatus(status(leaderOf))
    useCoworkTeamStore.getState().setSummary(summary(sharedNew))
  })
}

/** 和侧栏一样：useTeamScope 接 TeamScopeSwitch，再把实际的一档写出来。 */
function Harness() {
  const { scope, setScope } = useTeamScope()
  return (
    <>
      <TeamScopeSwitch scope={scope} onChange={setScope} />
      <output data-testid="scope">{scope}</output>
    </>
  )
}

function renderHarness() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Harness />
    </NextIntlClientProvider>
  )
}

function scopeButton(scope: string): HTMLElement | null {
  return document.querySelector(`[data-team-scope="${scope}"]`)
}

beforeEach(() => {
  useCoworkTeamStore.getState().reset()
  window.localStorage.clear()
  transportCall.mockReset()
})

afterEach(() => {
  useCoworkTeamStore.getState().reset()
})

describe("TeamScopeSwitch", () => {
  it("团队功能不可用时什么都不画，也不发请求", () => {
    window.localStorage.setItem(TEAM_SCOPE_STORAGE_KEY, "shared")
    renderHarness()
    expect(document.querySelector("[data-team-scope-switch]")).toBeNull()
    expect(screen.queryByRole("group", { name: "Conversation scope" })).toBe(
      null
    )
    // 记着「分享给我」也按「我的」显示。
    expect(screen.getByTestId("scope").textContent).toBe("mine")
    expect(transportCall).not.toHaveBeenCalled()
  })

  it("可用、不是组长：有「我的 / 分享给我」，没有「团队」", () => {
    makeAvailable([])
    renderHarness()
    expect(
      screen.getByRole("group", { name: "Conversation scope" })
    ).toBeTruthy()
    expect(scopeButton("mine")?.textContent).toBe("Mine")
    // 英文档位写短，三档同时出现时窄侧栏里不被截断。
    expect(scopeButton("shared")?.textContent).toBe("Shared")
    expect(scopeButton("team")).toBeNull()
    expect(scopeButton("mine")?.getAttribute("aria-pressed")).toBe("true")
  })

  it("当组长时有「团队」", () => {
    makeAvailable([{ id: "g1", name: "后端组" }])
    renderHarness()
    expect(scopeButton("team")?.textContent).toBe("Team")
  })

  it("「分享给我」的数字等于 summary.sharedNew，0 时不显示", () => {
    makeAvailable([], 3)
    renderHarness()
    const count = scopeButton("shared")?.querySelector(
      "[data-team-scope-count]"
    )
    expect(count?.querySelector("[aria-hidden]")?.textContent).toBe("3")
    act(() => useCoworkTeamStore.getState().setSummary(summary(0)))
    expect(
      scopeButton("shared")?.querySelector("[data-team-scope-count]")
    ).toBeNull()
  })

  it("新分享超过 99 条时显示实际数量", () => {
    makeAvailable([], 120)
    renderHarness()
    const count = scopeButton("shared")?.querySelector(
      "[data-team-scope-count]"
    )
    expect(count?.querySelector("[aria-hidden]")?.textContent).toBe("120")
  })

  it("选中的一档记在本机，重新挂载后还在", () => {
    makeAvailable([])
    const { unmount } = renderHarness()
    fireEvent.click(scopeButton("shared")!)
    expect(screen.getByTestId("scope").textContent).toBe("shared")
    expect(window.localStorage.getItem(TEAM_SCOPE_STORAGE_KEY)).toBe("shared")
    unmount()
    renderHarness()
    expect(screen.getByTestId("scope").textContent).toBe("shared")
    expect(scopeButton("shared")?.getAttribute("aria-pressed")).toBe("true")
  })

  it("记着「团队」但不是组长时按「我的」显示", () => {
    window.localStorage.setItem(TEAM_SCOPE_STORAGE_KEY, "team")
    makeAvailable([])
    renderHarness()
    expect(screen.getByTestId("scope").textContent).toBe("mine")
  })
})

describe("resolveTeamScope", () => {
  it("不可用一律「我的」，不是组长的「团队」回「我的」", () => {
    expect(resolveTeamScope("shared", false, true)).toBe("mine")
    expect(resolveTeamScope("team", true, false)).toBe("mine")
    expect(resolveTeamScope("team", true, true)).toBe("team")
    expect(resolveTeamScope("shared", true, false)).toBe("shared")
  })
})
