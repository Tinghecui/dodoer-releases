import { act, fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import {
  CoworkTeamError,
  type TeamEntriesPage,
  type TeamEntry,
} from "@/lib/cowork/team"
import {
  useCoworkTeamStore,
  type SharedSessionTarget,
} from "@/stores/cowork-team-store"
import { useTabStore } from "@/stores/tab-store"
import { useOverlayHostHidden } from "@/components/ui/overlay-host-hidden"
import {
  SharedSessionHost,
  sharedSessionPortalLink,
} from "./shared-session-view"

const api = vi.hoisted(() => ({
  teamEntries:
    vi.fn<
      (owner: string, id: string, after: number) => Promise<TeamEntriesPage>
    >(),
  copy: vi.fn<(text: string) => Promise<boolean>>(),
  openConversations: vi.fn(),
  activateConversationPane: vi.fn(),
}))
// 打开只读视图时要切回会话工作区、放下铺满的文件区：换成能看到调用的替身。
vi.mock("@/contexts/workbench-route-context", () => ({
  useOptionalWorkbenchRoute: () => ({
    routeId: "conversations",
    isConversations: true,
    setRoute: vi.fn(),
    openConversations: api.openConversations,
  }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useOptionalWorkspaceActions: () => ({
    activateConversationPane: api.activateConversationPane,
  }),
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return { ...actual, teamEntries: api.teamEntries }
})
vi.mock("@/lib/utils", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/utils")>()
  return { ...actual, copyTextToClipboard: api.copy }
})
// MessageResponse（Streamdown）在 jsdom 里太重：换成一个能看出「走了 markdown
// 渲染」的替身。
vi.mock("@/components/ai-elements/message", () => ({
  MessageResponse: ({ children }: { children: string }) => (
    <div data-md="">{children}</div>
  ),
}))

const NOW = Date.parse("2026-11-23T10:00:00Z")

const TARGET: SharedSessionTarget = {
  owner: "member-a",
  ownerLabel: "Wang",
  id: "42",
  title: "Fix login",
  via: { kind: "shared" },
}

function entry(seq: number, kind: TeamEntry["kind"], text: string): TeamEntry {
  return { seq, kind, text, ts: "2026-11-23T09:50:00Z" }
}

function page(
  entries: TeamEntry[],
  agent: Partial<TeamEntriesPage["agent"]> = {}
): TeamEntriesPage {
  return {
    agent: {
      owner: "member-a",
      ownerLabel: "Wang",
      id: "42",
      title: "Fix login",
      state: "running",
      updatedAt: "2026-11-23T09:57:00Z",
      ...agent,
    },
    entries,
    total: entries.length,
    reason: null,
  }
}

function makeAvailable(
  portalUrl: string | null = "https://portal.example.com/"
) {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "Chen" },
      leaderOf: [],
      portalUrl,
    })
  })
}

function renderHost() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SharedSessionHost>
        <div data-testid="conversation-below">own conversation</div>
      </SharedSessionHost>
    </NextIntlClientProvider>
  )
}

async function flush() {
  await act(async () => {
    await Promise.resolve()
  })
}

async function open(target: SharedSessionTarget = TARGET) {
  act(() => {
    useCoworkTeamStore.getState().openSharedSession(target)
  })
  await flush()
}

function view(): HTMLElement | null {
  return document.querySelector("[data-shared-session-view]")
}

let hidden = false

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: false })
  vi.setSystemTime(NOW)
  hidden = false
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  })
  useCoworkTeamStore.getState().reset()
  api.teamEntries.mockReset()
  api.copy.mockReset()
  api.copy.mockResolvedValue(true)
  api.openConversations.mockReset()
  api.activateConversationPane.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  useCoworkTeamStore.getState().reset()
})

describe("sharedSessionPortalLink", () => {
  it("joins the portal address with /s/<owner>/<id>", () => {
    expect(
      sharedSessionPortalLink("https://portal.example.com/", "member-a", "42")
    ).toBe("https://portal.example.com/s/member-a/42")
    expect(
      sharedSessionPortalLink("https://portal.example.com", "member-a", "42")
    ).toBe("https://portal.example.com/s/member-a/42")
    expect(sharedSessionPortalLink(null, "member-a", "42")).toBeNull()
  })
})

describe("SharedSessionHost", () => {
  it("covers the conversation pane without adding a tab or unmounting what is below", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([]))
    renderHost()
    const below = screen.getByTestId("conversation-below")
    expect(view()).toBeNull()
    const tabsBefore = useTabStore.getState().rawTabs

    await open()

    expect(view()).not.toBeNull()
    expect(useTabStore.getState().rawTabs).toBe(tabsBefore)
    // 下面的会话还挂着，是同一个节点。
    expect(screen.getByTestId("conversation-below")).toBe(below)

    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    expect(view()).toBeNull()
    expect(screen.getByTestId("conversation-below")).toBe(below)
  })

  it("renders the four entry kinds, all through the shared markdown renderer", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(
      page([
        entry(0, "user", "please fix <b>login</b>"),
        entry(1, "thought", "thinking about **cookies**"),
        entry(2, "tool", "ran tests"),
        entry(3, "assistant", "Done, see **notes**"),
      ])
    )
    renderHost()
    await open()

    const kinds = Array.from(
      document.querySelectorAll("[data-shared-entry]")
    ).map((el) => el.getAttribute("data-shared-entry"))
    expect(kinds).toEqual(["user", "thought", "tool", "assistant"])
    const md = Array.from(document.querySelectorAll("[data-md]")).map(
      (el) => el.textContent
    )
    // 四种块的正文都走现成的 markdown 渲染和净化（完成标准 5）。
    expect(md).toEqual([
      "please fix <b>login</b>",
      "thinking about **cookies**",
      "ran tests",
      "Done, see **notes**",
    ])
  })

  it("polls every 3 seconds after the last seq, and not while the page is hidden", async () => {
    makeAvailable()
    api.teamEntries
      .mockResolvedValueOnce(
        page([entry(0, "user", "a"), entry(1, "assistant", "b")])
      )
      .mockResolvedValueOnce(page([entry(2, "assistant", "c")]))
      .mockResolvedValue(page([]))
    renderHost()
    await open()

    expect(api.teamEntries).toHaveBeenCalledTimes(1)
    expect(api.teamEntries).toHaveBeenLastCalledWith("member-a", "42", -1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(api.teamEntries).toHaveBeenCalledTimes(2)
    expect(api.teamEntries).toHaveBeenLastCalledWith("member-a", "42", 1)
    expect(document.querySelectorAll("[data-shared-entry]")).toHaveLength(3)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(api.teamEntries).toHaveBeenCalledTimes(3)
    expect(api.teamEntries).toHaveBeenLastCalledWith("member-a", "42", 2)

    hidden = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(api.teamEntries).toHaveBeenCalledTimes(3)

    // 关掉以后不再拉。
    hidden = false
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(api.teamEntries).toHaveBeenCalledTimes(3)
  })

  it("shows the read-only bar, last update and copies the portal link", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([entry(0, "user", "a")]))
    renderHost()
    await open()

    const bar = document.querySelector("[data-shared-session-bar]")
    expect(bar?.textContent).toContain(
      "Read-only · Wang's conversation · Shared by Wang"
    )
    expect(bar?.textContent).toContain(
      "Wang only allows viewing; you can't message their agent from here"
    )
    expect(bar?.textContent).toContain("Last updated: 3 minutes ago")
    expect(screen.getByText("Fix login")).toBeTruthy()

    fireEvent.click(screen.getByRole("button", { name: "Copy link" }))
    await flush()
    expect(api.copy).toHaveBeenCalledWith(
      "https://portal.example.com/s/member-a/42"
    )
  })

  it("names the group for a leader and has no copy link without a portal address", async () => {
    makeAvailable(null)
    api.teamEntries.mockResolvedValue(page([]))
    renderHost()
    await open({ ...TARGET, via: { kind: "leader", groupName: "Backend" } })

    const bar = document.querySelector("[data-shared-session-bar]")
    expect(bar?.textContent).toContain(
      "Read-only · Wang's conversation · You lead Backend"
    )
    expect(screen.queryByRole("button", { name: "Copy link" })).toBeNull()
  })

  it("says the agent is waiting when the session waits for its owner", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([], { state: "waiting" }))
    renderHost()
    await open()
    expect(
      screen.getByText("Wang's agent is waiting for their answer")
    ).toBeTruthy()
  })

  it("clears the content when the share is gone", async () => {
    makeAvailable()
    api.teamEntries
      .mockResolvedValueOnce(page([entry(0, "assistant", "secret plan")]))
      .mockRejectedValueOnce(new CoworkTeamError("not_found", "not found"))
    renderHost()
    await open()
    expect(document.querySelectorAll("[data-shared-entry]")).toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(document.querySelectorAll("[data-shared-entry]")).toHaveLength(0)
    expect(
      screen.getByText(
        "The share was withdrawn, or you're no longer in this group"
      )
    ).toBeTruthy()
    // 不再接着拉。
    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000)
    })
    expect(api.teamEntries).toHaveBeenCalledTimes(2)
  })

  it("loads again when the same share is opened after it was withdrawn", async () => {
    makeAvailable()
    api.teamEntries
      .mockRejectedValueOnce(new CoworkTeamError("not_found", "not found"))
      .mockResolvedValue(page([entry(0, "assistant", "shared again")]))
    renderHost()
    await open()
    expect(document.querySelector("[data-shared-session-gone]")).not.toBeNull()

    // 对方又分享了同一个会话，用户在列表里再点它：要重新拉、恢复轮询。
    await open()
    expect(document.querySelector("[data-shared-session-gone]")).toBeNull()
    expect(document.querySelectorAll("[data-shared-entry]")).toHaveLength(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(api.teamEntries).toHaveBeenCalledTimes(3)
    expect(api.teamEntries).toHaveBeenLastCalledWith("member-a", "42", 0)
  })

  it("has no control that could message, stop or approve the other agent", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(
      page([entry(0, "assistant", "need approval")], { state: "waiting" })
    )
    renderHost()
    await open()
    const root = view()!
    expect(
      root.querySelectorAll("textarea, input, [contenteditable]")
    ).toHaveLength(0)
    const buttons = Array.from(root.querySelectorAll("button")).map(
      (b) => b.getAttribute("aria-label") || b.textContent
    )
    expect(buttons.sort()).toEqual(["Close", "Copy link"])
  })

  it("folds away when one of my conversations or a tab is clicked", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([]))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div>
          <button data-conversation-id="7">mine</button>
          <button data-tab-id="tab-1">tab</button>
        </div>
        <SharedSessionHost>
          <div />
        </SharedSessionHost>
      </NextIntlClientProvider>
    )
    await open()
    expect(view()).not.toBeNull()
    fireEvent.pointerDown(screen.getByText("mine"))
    expect(view()).toBeNull()

    await open()
    expect(view()).not.toBeNull()
    fireEvent.pointerDown(screen.getByText("tab"))
    expect(view()).toBeNull()
  })

  it("folds away when an already selected conversation or tab is activated from the keyboard", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([]))
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <div>
          <button data-conversation-id="7">mine</button>
          <button data-tab-id="tab-1">tab</button>
        </div>
        <SharedSessionHost>
          <div />
        </SharedSessionHost>
      </NextIntlClientProvider>
    )
    // 键盘回车、空格激活按钮只发 click，不发 pointerdown；活动标签也不变。
    await open()
    fireEvent.click(screen.getByText("mine"))
    expect(view()).toBeNull()

    await open()
    fireEvent.click(screen.getByText("tab"))
    expect(view()).toBeNull()
  })

  it("brings the conversation workspace forward when it opens", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([]))
    renderHost()
    expect(api.openConversations).not.toHaveBeenCalled()
    expect(api.activateConversationPane).not.toHaveBeenCalled()
    await open()
    // 停在自动化这类整页功能上、或者文件区铺满时，都要先回到会话区域。
    expect(api.openConversations).toHaveBeenCalledTimes(1)
    expect(api.activateConversationPane).toHaveBeenCalledTimes(1)
    // 换看另一个会话也一样。
    await open({ ...TARGET, id: "43" })
    expect(api.openConversations).toHaveBeenCalledTimes(2)
    expect(api.activateConversationPane).toHaveBeenCalledTimes(2)
    // 开着时切到整页功能或铺满文件区，再点同一条分享：也要再回到会话区域，
    // 不然视图还被盖着，像点了没反应。
    await open({ ...TARGET, id: "43" })
    expect(api.openConversations).toHaveBeenCalledTimes(3)
    expect(api.activateConversationPane).toHaveBeenCalledTimes(3)
  })

  it("tells drawers portaled out of the covered conversation to hide", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([]))
    function Probe() {
      return (
        <output data-testid="probe">{String(useOverlayHostHidden())}</output>
      )
    }
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <SharedSessionHost>
          <Probe />
        </SharedSessionHost>
      </NextIntlClientProvider>
    )
    expect(screen.getByTestId("probe").textContent).toBe("false")
    await open()
    expect(screen.getByTestId("probe").textContent).toBe("true")
    act(() => {
      useCoworkTeamStore.getState().closeSharedSession()
    })
    expect(screen.getByTestId("probe").textContent).toBe("false")
  })

  it("folds away when the team feature becomes unavailable", async () => {
    makeAvailable()
    api.teamEntries.mockResolvedValue(page([]))
    renderHost()
    await open()
    act(() => {
      useCoworkTeamStore.getState().markUnavailable()
    })
    expect(view()).toBeNull()
  })
})
