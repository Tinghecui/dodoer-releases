import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { Ref } from "react"

import { Sidebar } from "./sidebar"
// Type-only (erased at runtime, so it does not defeat the mock below): pins the
// stub's imperative handle to the real component's contract.
import type { SidebarConversationListHandle } from "@/components/conversations/sidebar-conversation-list"
import enMessages from "@/i18n/messages/en.json"
import type { TagFilter } from "@/lib/conversation-tags"
import {
  resetConversationTagsStore,
  useConversationTagsStore,
} from "@/stores/conversation-tags-store"
import { resetFolderTabsStore } from "@/stores/folder-tabs-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  useAwaitingUserStore,
  type AwaitingUserKind,
} from "@/stores/awaiting-user-store"
import { useConversationSeenStore } from "@/stores/conversation-seen-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"

// Stable spies + mutable active-folder, referenced from the hoisted mock
// factories below (vi.mock is hoisted above imports).
const spies = vi.hoisted(() => ({
  openUrl: vi.fn<() => Promise<void>>(),
  openNewConversationTab: vi.fn(),
  openChatModeTab: vi.fn(),
  setRoute: vi.fn(),
  openConversations: vi.fn(),
  // The list's imperative handle, driven by the header buttons.
  scrollToActive: vi.fn(),
  expandAll: vi.fn(),
  collapseAll: vi.fn(),
  // The tag manager the tag filter's footer leads to.
  openConversationTagsManager: vi.fn(),
  // Latest props the (stubbed) conversation list was rendered with, so tests can
  // assert what the sidebar threads down (e.g. showWorktrees / showCompleted).
  listProps: null as {
    sessionActivity?: boolean
    showWorktrees?: boolean
    showCompleted?: boolean
    showRecent?: boolean
    sectionOrder?: readonly string[]
    tagFilter?: TagFilter
  } | null,
}))
const mockState = vi.hoisted(() => ({
  isOpen: true,
  activeFolder: { id: 7, path: "/x" } as { id: number; path: string } | null,
  // The counts the Automations / To-dos rows badge.
  unseenFailures: 0,
  attentionCount: 0,
}))

vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openUrl: spies.openUrl,
}))

beforeEach(() => {
  mockState.isOpen = true
  mockState.unseenFailures = 0
  mockState.attentionCount = 0
  spies.openUrl.mockReset().mockResolvedValue(undefined)
})

// The conversation list is irrelevant here — stub it so the test exercises only
// the sidebar's header + fixed nav region. The stub still fulfils the imperative
// handle (React 19 hands `ref` to a function component as a plain prop, which is
// how the real component takes it), so the header buttons that drive the list
// are asserted against real calls instead of clicking into a null ref.
vi.mock("@/components/conversations/sidebar-conversation-list", async () => {
  const { useImperativeHandle } = await import("react")
  return {
    SidebarConversationList: ({
      ref,
      ...props
    }: {
      ref?: Ref<SidebarConversationListHandle>
      showWorktrees?: boolean
      showCompleted?: boolean
      showRecent?: boolean
      sectionOrder?: readonly string[]
      tagFilter?: TagFilter
    }) => {
      spies.listProps = props
      useImperativeHandle(ref, () => ({
        scrollToActive: spies.scrollToActive,
        expandAll: spies.expandAll,
        collapseAll: spies.collapseAll,
      }))
      return null
    },
  }
})
// Polls the backend and subscribes to its pushes; this file is about the
// sidebar's own controls, and its `@/lib/platform` mock has no transport.
vi.mock("@/components/conversations/pr-status-poller", () => ({
  PrStatusPoller: () => null,
}))
vi.mock("@/components/conversations/conversation-tags-manager", () => ({
  openConversationTagsManager: spies.openConversationTagsManager,
}))
vi.mock("@/contexts/sidebar-context", () => ({
  useSidebarContext: () => ({ isOpen: mockState.isOpen, toggle: vi.fn() }),
}))
vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({ activeFolder: mockState.activeFolder }),
}))
vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({
    openNewConversationTab: spies.openNewConversationTab,
    openChatModeTab: spies.openChatModeTab,
  }),
}))
vi.mock("@/contexts/automations-view-context", () => ({
  useAutomationsView: () => ({
    automations: [],
    unseenFailures: mockState.unseenFailures,
    refetch: async () => {},
  }),
}))
vi.mock("@/contexts/tasks-view-context", () => ({
  useTasksView: () => ({
    tasks: [],
    attentionCount: mockState.attentionCount,
    refetch: async () => {},
  }),
}))
vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({
    routeId: "conversations",
    isConversations: true,
    setRoute: spies.setRoute,
    openConversations: spies.openConversations,
  }),
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))
vi.mock("@/hooks/use-shortcut-settings", () => ({
  useShortcutSettings: () => ({
    shortcuts: { toggle_search: "mod+k", new_conversation: "mod+t" },
  }),
}))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => false }))
vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100, setZoomLevel: () => {} }),
}))

function renderSidebar() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <Sidebar />
    </NextIntlClientProvider>
  )
}

/**
 * Walk into one of the view-options menu's two visibility inventories, which
 * live behind submenus. Clicking a sub-trigger opens it synchronously; opening
 * it by HOVER runs on a 100ms Radix timer and is asserted separately below.
 *
 * This — and every click on a row inside the submenu — deliberately uses the
 * module-level `userEvent` instead of a `setup()` instance, matching the
 * quick-actions submenu tests. A shared instance remembers where the pointer
 * was, so the next click drags it off the sub-trigger first; Radix answers a
 * trigger-leave with its grace-area check, which needs real element geometry,
 * and jsdom reports every rect as 0×0. The check fails, the root menu takes
 * focus back, and the submenu closes out from under the click. A fresh
 * instance has no previous position, so nothing ever leaves the trigger.
 */
async function openViewOptionsGroup(
  group: "Filter by tags" | "Conversation list" | "Navigation items"
) {
  await userEvent.click(screen.getByRole("button", { name: "View options" }))
  await userEvent.click(screen.getByRole("menuitem", { name: group }))
}

describe("Sidebar — fixed nav region", () => {
  beforeEach(() => {
    spies.openNewConversationTab.mockClear()
    spies.openChatModeTab.mockClear()
    spies.setRoute.mockClear()
    spies.openConversations.mockClear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("toggles the session activity list with the bell", () => {
    const { container } = renderSidebar()
    const bell = container.querySelector("[data-sidebar-bell]")!
    expect(bell).toHaveAttribute("aria-pressed", "false")
    fireEvent.click(bell)
    expect(bell).toHaveAttribute("aria-pressed", "true")
    expect(spies.listProps?.sessionActivity).toBe(true)
    fireEvent.click(bell)
    expect(bell).toHaveAttribute("aria-pressed", "false")
    expect(spies.listProps?.sessionActivity).toBe(false)
  })

  it("counts all projects and chats and reacts to read/status changes", () => {
    const summaries: Partial<DbConversationSummary>[] = [
      { id: 1, folder_id: 10, status: "in_progress" },
      { id: 2, folder_id: 20, status: "in_progress", pinned_at: "2026-01-01" },
      { id: 3, folder_id: 30, status: "pending_review", kind: "chat" },
      { id: 4, folder_id: 40, status: "cancelled" },
      { id: 5, folder_id: 40, status: "completed" },
      { id: 6, folder_id: 40, status: "pending_review", parent_id: 4 },
      // A folder closed from the workspace: no row shows it, so it is not
      // counted (jenny fork).
      { id: 7, folder_id: 50, status: "in_progress" },
      { id: 8, folder_id: 50, status: "pending_review" },
    ]
    const conversations: DbConversationSummary[] = summaries.map((c) => ({
      id: 0,
      folder_id: 0,
      title: "session",
      title_locked: false,
      agent_type: "claude_code",
      status: "pending",
      kind: "regular",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: "2026-01-01",
      pinned_at: null,
      updated_at: "2026-01-02",
      ...c,
    }))
    useAppWorkspaceStore.setState({
      conversations,
      folders: [{ id: 10 }, { id: 40 }] as FolderDetail[],
    })
    useConversationSeenStore.setState({
      baselineAt: 0,
      seen: { "4": Date.parse("2026-01-03") },
      markedUnread: { "5": 1 },
    })
    const { container, unmount } = renderSidebar()
    const bell = container.querySelector("[data-sidebar-bell]")!
    expect(bell.querySelector('[data-global-running-count="2"]')).not.toBeNull()
    expect(bell.querySelector('[data-global-unread-count="2"]')).not.toBeNull()
    act(() => {
      useConversationSeenStore.setState({
        seen: { "3": Date.parse("2026-01-03"), "4": Date.parse("2026-01-03") },
        markedUnread: {},
      })
      useAppWorkspaceStore.setState({
        conversations: conversations.map((c) => ({
          ...c,
          status: "completed",
        })),
      })
    })
    expect(bell.querySelector("[data-global-running-count]")).toBeNull()
    expect(bell.querySelector("[data-global-unread-count]")).toBeNull()
    unmount()
    useAppWorkspaceStore.setState({ conversations: [], folders: [] })
  })

  it("counts the sessions waiting on the user, a sub-agent under its parent", () => {
    const row = (c: Partial<DbConversationSummary>) =>
      ({
        id: 0,
        folder_id: 10,
        title: "session",
        title_locked: false,
        agent_type: "claude_code",
        status: "in_progress",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: null,
        message_count: 0,
        child_count: 0,
        created_at: "2026-01-01",
        pinned_at: null,
        updated_at: "2026-01-02",
        ...c,
      }) as DbConversationSummary
    useAppWorkspaceStore.setState({
      conversations: [
        row({ id: 1, external_id: "a" }),
        row({ id: 2, external_id: "b" }),
        // The sub-agent that asks: its parent (id 1) already stands for it.
        row({ id: 3, external_id: "a-child", parent_id: 1 }),
        // A closed folder has no row to answer from.
        row({ id: 4, external_id: "c", folder_id: 50 }),
      ],
      folders: [{ id: 10 }] as FolderDetail[],
    })
    const { container, unmount } = renderSidebar()
    const bell = container.querySelector("[data-sidebar-bell]")!
    expect(bell.querySelector("[data-global-awaiting-count]")).toBeNull()
    act(() => {
      useAwaitingUserStore.setState({
        bySession: new Map<string, AwaitingUserKind>([
          ["a", "question"],
          ["a-child", "question"],
          ["c", "permission"],
        ]),
      })
    })
    expect(
      bell.querySelector('[data-global-awaiting-count="1"]')
    ).not.toBeNull()
    act(() => {
      useAwaitingUserStore.setState({ bySession: new Map() })
    })
    expect(bell.querySelector("[data-global-awaiting-count]")).toBeNull()
    unmount()
    useAppWorkspaceStore.setState({ conversations: [], folders: [] })
  })

  it("counts a headless merge waiting on approval once, whatever says so", () => {
    // #167: the task engine's merge session has no connection here until it
    // is opened; the task list marks it by conversation id instead.
    const row = (c: Partial<DbConversationSummary>) =>
      ({
        id: 0,
        folder_id: 10,
        title: "session",
        title_locked: false,
        agent_type: "claude_code",
        status: "in_progress",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: null,
        message_count: 0,
        child_count: 0,
        created_at: "2026-01-01",
        pinned_at: null,
        updated_at: "2026-01-02",
        ...c,
      }) as DbConversationSummary
    useAppWorkspaceStore.setState({
      conversations: [
        row({ id: 1, external_id: "merge" }),
        row({ id: 2, external_id: "other" }),
        // A closed folder has no row to answer from.
        row({ id: 4, external_id: "c", folder_id: 50 }),
      ],
      folders: [{ id: 10 }] as FolderDetail[],
    })
    const { container, unmount } = renderSidebar()
    const bell = container.querySelector("[data-sidebar-bell]")!
    act(() => {
      useAwaitingUserStore.setState({ byTaskConversation: new Set([1, 4]) })
    })
    expect(
      bell.querySelector('[data-global-awaiting-count="1"]')
    ).not.toBeNull()
    // Opened: its connection reports the same wait — still one session.
    act(() => {
      useAwaitingUserStore.setState({
        bySession: new Map<string, AwaitingUserKind>([["merge", "permission"]]),
      })
    })
    expect(
      bell.querySelector('[data-global-awaiting-count="1"]')
    ).not.toBeNull()
    act(() => {
      useAwaitingUserStore.setState({
        bySession: new Map(),
        byTaskConversation: new Set(),
      })
    })
    expect(bell.querySelector("[data-global-awaiting-count]")).toBeNull()
    unmount()
    useAppWorkspaceStore.setState({ conversations: [], folders: [] })
  })

  it("is a card lifted on a bottom shadow, with no frame", () => {
    const { container } = renderSidebar()
    const pane = container.querySelector("aside")!
    expect(pane.className).toContain("lg-card")
    expect(pane.className).toContain("lg-raised")
    expect(pane.className).not.toContain("ring-[3px]")
  })

  // Cowork: the workspace's two <aside> landmarks (this and the aux panel)
  // carry names, so assistive tech — and role lookups — can tell them apart.
  it("names its landmark", () => {
    renderSidebar()
    expect(
      screen.getByRole("complementary", { name: "Conversations" })
    ).toBeInTheDocument()
  })

  it("has no Active loops row and no conversation-list fold", () => {
    renderSidebar()
    expect(screen.queryByRole("button", { name: "Active loops" })).toBeNull()
    expect(document.querySelector('[data-sidebar-nav="loops"]')).toBeNull()
    expect(document.querySelector("[data-sidebar-fold-toggle]")).toBeNull()
    expect(spies.listProps).not.toBeNull()
  })

  it("puts the bell right after the window chrome, apart from the list tools", () => {
    const { container } = renderSidebar()
    const bell = container.querySelector("[data-sidebar-bell]")!
    const tools = container.querySelector<HTMLElement>(
      "[data-sidebar-header-controls]"
    )!
    // The counts continue the toggle + search row instead of sitting with the
    // list tools on the far side of the header.
    expect(tools.contains(bell)).toBe(false)
    // The reserve in front of it ends where the overlay's buttons end (66px
    // in the browser), less the 8px the glass pane sits in from the window.
    expect((bell.previousElementSibling as HTMLElement).style.width).toBe(
      "58px"
    )
    expect(
      within(tools)
        .getAllByRole("button")
        .map((button) => button.getAttribute("aria-label"))
    ).toEqual([
      "Locate Active Conversation",
      "Collapse All Groups",
      "View options",
    ])
  })

  it("shows 99+ past 99 while the chip label keeps the exact count", () => {
    const conversations = Array.from(
      { length: 199 },
      (_, i): DbConversationSummary => ({
        id: i + 1,
        folder_id: 10,
        title: "session",
        title_locked: false,
        agent_type: "claude_code",
        // 99 running (the last count shown as is), 100 unread (the first one
        // that is not).
        status: i < 99 ? "in_progress" : "pending_review",
        kind: "regular",
        model: null,
        git_branch: null,
        external_id: null,
        message_count: 0,
        child_count: 0,
        created_at: "2026-01-01",
        pinned_at: null,
        updated_at: "2026-01-02",
      })
    )
    useAppWorkspaceStore.setState({
      conversations,
      folders: [{ id: 10 }] as FolderDetail[],
    })
    useConversationSeenStore.setState({
      baselineAt: 0,
      seen: {},
      markedUnread: {},
    })
    const { container, unmount } = renderSidebar()
    const bell = container.querySelector("[data-sidebar-bell]")!
    const running = bell.querySelector('[data-global-running-count="99"]')!
    const unread = bell.querySelector('[data-global-unread-count="100"]')!
    expect(running.querySelector("[aria-hidden]")).toHaveTextContent(/^99$/)
    expect(unread.querySelector("[aria-hidden]")).toHaveTextContent(/^99\+$/)
    expect(unread).toHaveAttribute("title", "100 unread sessions")
    expect(
      within(unread as HTMLElement).getByText("100 unread sessions")
    ).toBeInTheDocument()
    unmount()
    useAppWorkspaceStore.setState({ conversations: [] })
  })

  it("Automations navigates to the automations route", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("Automations"))
    expect(spies.setRoute).toHaveBeenCalledWith("automations")
  })

  it("Apps navigates to the apps route", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("Apps"))
    expect(spies.setRoute).toHaveBeenCalledWith("apps")
  })

  it("New chat returns to the conversation workspace", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("New chat"))
    expect(spies.openConversations).toHaveBeenCalled()
  })

  it("New chat opens a conversation tab in the active folder", () => {
    const { getByText } = renderSidebar()
    fireEvent.click(getByText("New chat"))
    expect(spies.openNewConversationTab).toHaveBeenCalledWith(7, "/x")
  })

  it("renders the New chat shortcut hint", () => {
    const { getByText } = renderSidebar()
    // isMac=false → "mod" formats as "Ctrl". The badge is opacity-0 until the
    // row is hovered/focused but stays in the DOM, so getByText resolves it.
    expect(getByText("Ctrl+T")).toBeTruthy()
  })

  it("no longer carries a Search row — it moved to the window chrome", () => {
    const { queryByText } = renderSidebar()
    // The sidebar unmounts when collapsed, which left ⌘K as the only path to
    // search; the button now lives in LeftEdgeChrome / FolderTitleBar instead.
    expect(queryByText("Search")).toBeNull()
    expect(queryByText("Ctrl+K")).toBeNull()
  })

  it("falls back to chat mode (never disabled) when no folder is active", () => {
    mockState.activeFolder = null
    const { getByText } = renderSidebar()
    const btn = getByText("New chat").closest("button") as HTMLButtonElement
    // Defense-in-depth: the button stays clickable so a workspace that recovered
    // to no active folder is never a dead end — it opens folderless chat mode.
    expect(btn.disabled).toBe(false)
    fireEvent.click(btn)
    expect(spies.openChatModeTab).toHaveBeenCalled()
    expect(spies.openNewConversationTab).not.toHaveBeenCalled()
  })
})

describe("Sidebar — View options grouping", () => {
  beforeEach(() => {
    localStorage.clear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("keeps both visibility inventories out of the root menu", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // Six checkboxes inline turned the root into a wall; they now sit one hop
    // in, behind their group. Sort by / Section order stay inline — the
    // control on the right is the proof this is about the two inventories and
    // not the menu failing to render.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Show worktree branches" })
    ).toBeNull()
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeNull()
    expect(
      screen.getByRole("menuitemradio", { name: "Created time" })
    ).toBeTruthy()

    expect(
      screen.getByRole("menuitem", { name: "Conversation list" })
    ).toBeTruthy()
    expect(
      screen.getByRole("menuitem", { name: "Navigation items" })
    ).toBeTruthy()
    await user.keyboard("{Escape}")
  })

  it("opens a group on hover alone, with no click", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // Load-bearing: without this the assertion below would also pass on a menu
    // that never nested the toggles in the first place.
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeNull()

    // Pointing at the row is the whole interaction — Radix opens the submenu on
    // a short pointer-move timer, so this resolves without a second click.
    await user.hover(screen.getByRole("menuitem", { name: "Navigation items" }))

    expect(
      await screen.findByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeTruthy()
    // Escape inside a submenu closes the whole stack, root included.
    await user.keyboard("{Escape}")
  })
})

describe("Sidebar — Tag filter inside View options", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    spies.openConversationTagsManager.mockClear()
    mockState.activeFolder = { id: 7, path: "/x" }
    resetConversationTagsStore()
    useConversationTagsStore.getState().applyChange({
      kind: "upsert",
      tag: {
        id: 1,
        folder_id: null,
        name: "bug",
        color: "#0969da",
        sort_order: 1,
      },
    })
  })

  it("has no header button of its own any more", () => {
    renderSidebar()
    expect(screen.queryByRole("button", { name: "Filter by tags" })).toBeNull()
    // Control: the header cluster itself rendered.
    expect(screen.getByRole("button", { name: "View options" })).toBeTruthy()
  })

  it("leads the View options menu", async () => {
    renderSidebar()
    await userEvent.click(screen.getByRole("button", { name: "View options" }))

    const rows = screen.getAllByRole("menuitem")
    expect(rows[0].textContent).toBe("Filter by tags")
    expect(rows[1].textContent).toBe("Conversation list")
  })

  it("narrows the list to a picked tag, persists it and stays open", async () => {
    renderSidebar()
    expect(spies.listProps?.tagFilter).toEqual({ tagIds: [], mode: "any" })

    await openViewOptionsGroup("Filter by tags")
    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    await userEvent.click(within(panel).getByText("bug"))

    expect(spies.listProps?.tagFilter).toEqual({ tagIds: [1], mode: "any" })
    expect(
      JSON.parse(localStorage.getItem("workspace:sidebar-tag-filter") ?? "")
    ).toEqual({ tagIds: [1], mode: "any" })
    // Picking is iterative, like every option here: the panel stays up, and
    // the row now counts the pick.
    expect(screen.getByRole("dialog", { name: "Filter by tags" })).toBe(panel)
    expect(
      within(
        screen.getByRole("menuitem", { name: "Filter by tags" })
      ).getByText("1")
    ).toBeTruthy()
  })

  it("closes the whole menu on the way to the tag manager", async () => {
    renderSidebar()
    await openViewOptionsGroup("Filter by tags")
    const panel = await screen.findByRole("dialog", { name: "Filter by tags" })
    await userEvent.click(within(panel).getByText("Manage tags…"))

    expect(spies.openConversationTagsManager).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull())
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("Sidebar — Show worktree branches toggle", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("defaults Show worktree branches on and threads it to the conversation list", () => {
    renderSidebar()
    expect(spies.listProps?.showWorktrees).toBe(true)
  })

  it("respects an explicitly-stored 'false' from localStorage", () => {
    localStorage.setItem("workspace:sidebar-show-worktrees", "false")
    renderSidebar()
    // Hydration runs in a mount effect (flushed by render's act): a user who
    // unchecked it keeps it off despite the default-on.
    expect(spies.listProps?.showWorktrees).toBe(false)
  })

  it("toggling the view-options item off persists the choice and threads it down", async () => {
    renderSidebar()
    // Default on with a cleared store.
    expect(spies.listProps?.showWorktrees).toBe(true)

    await openViewOptionsGroup("Conversation list")
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Show worktree branches" })
    )

    expect(localStorage.getItem("workspace:sidebar-show-worktrees")).toBe(
      "false"
    )
    expect(spies.listProps?.showWorktrees).toBe(false)
  })
})

describe("Sidebar — Show completed default", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("defaults Show completed off and threads it to the conversation list", () => {
    renderSidebar()
    expect(spies.listProps?.showCompleted).toBe(false)
  })

  it("respects an explicitly-stored 'true' from localStorage", () => {
    localStorage.setItem("workspace:sidebar-show-completed", "true")
    renderSidebar()
    expect(spies.listProps?.showCompleted).toBe(true)
  })
})

describe("Sidebar — Show Recent group toggle", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("defaults Show Recent on and threads it to the conversation list", () => {
    renderSidebar()
    expect(spies.listProps?.showRecent).toBe(true)
  })

  it("respects an explicitly-stored 'false' from localStorage", () => {
    localStorage.setItem("workspace:sidebar-show-recent", "false")
    renderSidebar()
    expect(spies.listProps?.showRecent).toBe(false)
  })

  it("toggling the view-options item off persists the choice and keeps the menu open", async () => {
    renderSidebar()

    await openViewOptionsGroup("Conversation list")
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Show Recent group" })
    )

    expect(localStorage.getItem("workspace:sidebar-show-recent")).toBe("false")
    expect(spies.listProps?.showRecent).toBe(false)
    // The view-options menu is a settings panel: flipping one option must not
    // dismiss it — nor the submenu it lives in — or changing two costs two
    // trips back through the trigger.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Show Recent group" })
    ).toBeTruthy()
  })
})

describe("Sidebar — Tabs follow folder", () => {
  beforeEach(() => {
    localStorage.clear()
    resetFolderTabsStore()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  // jenny fork: without the conversation tab bar the mode has nothing to act
  // on, so View options does not offer it.
  it("is not offered in View options", async () => {
    renderSidebar()
    await userEvent.click(screen.getByRole("button", { name: "View options" }))
    expect(
      screen.queryByRole("menuitemcheckbox", { name: "Tabs follow folder" })
    ).toBeNull()
    // Control: the menu is open, so the row above is absent, not unrendered.
    expect(
      screen.getByRole("menuitemradio", { name: "Created time" })
    ).toBeTruthy()
  })
})

describe("Sidebar — Navigation item visibility", () => {
  beforeEach(() => {
    localStorage.clear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  // The nav rows are `button`s; the menu's toggles are `menuitemcheckbox`es, so
  // the two never collide even while the menu is open.
  const navRow = (name: string | RegExp) =>
    screen.queryByRole("button", { name })
  const FORGE_ROW = "Repository panel"

  it("shows every route row by default", () => {
    renderSidebar()
    expect(navRow("Automations")).toBeTruthy()
    expect(navRow("To-dos")).toBeTruthy()
    expect(navRow(FORGE_ROW)).toBeTruthy()
    expect(navRow("Apps")).toBeTruthy()
  })

  it("hides a row when its menu toggle is switched off, and persists it", async () => {
    renderSidebar()

    await openViewOptionsGroup("Navigation items")
    await userEvent.click(
      screen.getByRole("menuitemcheckbox", { name: "Automations" })
    )
    // Like every other option here, flipping one must not dismiss the menu —
    // and the submenu it lives in has to survive too.
    expect(
      screen.getByRole("menuitemcheckbox", { name: "Automations" })
    ).toBeTruthy()
    // Close it before looking at the rows: an open Radix menu is modal and
    // aria-hides the sidebar behind it, which would make "the row is gone" true
    // for the wrong reason. Escape inside a submenu closes the whole stack.
    await userEvent.keyboard("{Escape}")

    expect(navRow("Automations")).toBeNull()
    // Control: the other rows are still there, so the assertion above is about
    // this one row rather than a hidden subtree.
    expect(navRow("To-dos")).toBeTruthy()
    expect(
      JSON.parse(localStorage.getItem("workspace:sidebar-nav-items") ?? "{}")
    ).toEqual({ automations: false })
  })

  it("respects an explicitly-stored hidden row from localStorage", () => {
    localStorage.setItem(
      "workspace:sidebar-nav-items",
      JSON.stringify({ forge: false })
    )
    renderSidebar()
    expect(navRow(FORGE_ROW)).toBeNull()
    expect(navRow("Automations")).toBeTruthy()
  })

  it("ignores a stored entry for a route that no longer exists", () => {
    localStorage.setItem(
      "workspace:sidebar-nav-items",
      JSON.stringify({ retired: false, tasks: false })
    )
    renderSidebar()
    expect(navRow("To-dos")).toBeNull()
    expect(navRow("Automations")).toBeTruthy()
  })
})

describe("Sidebar — Expand / collapse all groups", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.collapseAll.mockClear()
    spies.expandAll.mockClear()
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  it("is an icon-only header button on desktop, no longer a menu row", async () => {
    const user = userEvent.setup()
    renderSidebar()

    // Icon-only, so the accessible name comes from aria-label and names the
    // action the click performs.
    const toggle = screen.getByRole("button", { name: "Collapse All Groups" })
    expect(toggle.textContent).toBe("")

    await user.click(screen.getByRole("button", { name: "View options" }))
    expect(
      screen.queryByRole("menuitem", { name: "Collapse All Groups" })
    ).toBeNull()
    await user.keyboard("{Escape}")
  })

  it("drives the list from the header in one click, and flips direction", async () => {
    const user = userEvent.setup()
    renderSidebar()

    // One click, from the header — it used to cost a trip through the menu.
    await user.click(
      screen.getByRole("button", { name: "Collapse All Groups" })
    )
    expect(spies.collapseAll).toHaveBeenCalledTimes(1)
    expect(spies.expandAll).not.toHaveBeenCalled()

    // The button now offers the opposite action, and performs it.
    await user.click(screen.getByRole("button", { name: "Expand All Groups" }))
    expect(spies.expandAll).toHaveBeenCalledTimes(1)
    expect(
      screen.getByRole("button", { name: "Collapse All Groups" })
    ).toBeTruthy()
  })
})

describe("Sidebar — Section order control", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })

  // The order rows are `menuitem`s labelled "<name> — position N of 3"; the
  // move buttons inside them are labelled "<name> — Move up/down".
  const orderRowNames = () =>
    screen
      .getAllByRole("menuitem")
      .map((el) => el.getAttribute("aria-label") ?? "")
      .filter((label) => label.includes("position"))

  it("defaults to Folders → Chat → Recent", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    expect(orderRowNames()).toEqual([
      "Folders — position 1 of 3",
      "Chat — position 2 of 3",
      "Recent — position 3 of 3",
    ])
    expect(spies.listProps?.sectionOrder).toEqual([
      "folders",
      "chats",
      "recent",
    ])
  })

  it("moves a section up, persists the new order and threads it down", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))
    await user.click(screen.getByRole("button", { name: "Recent — Move up" }))

    expect(orderRowNames()).toEqual([
      "Folders — position 1 of 3",
      "Recent — position 2 of 3",
      "Chat — position 3 of 3",
    ])
    expect(spies.listProps?.sectionOrder).toEqual([
      "folders",
      "recent",
      "chats",
    ])
    expect(
      JSON.parse(localStorage.getItem("workspace:sidebar-section-order") ?? "")
    ).toEqual(["folders", "recent", "chats"])
  })

  it("disables the move buttons that would fall off an end", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    expect(
      screen.getByRole("button", { name: "Folders — Move up" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Recent — Move down" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Folders — Move down" })
    ).not.toBeDisabled()
  })

  it("reorders from the keyboard with Alt+Arrow on the focused row", async () => {
    const user = userEvent.setup()
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // The nested move buttons are unreachable by Tab (Radix's menu swallows it)
    // and by the roving focus, so Alt+Arrow on the row is the ONLY keyboard
    // path — if this regresses, the control becomes mouse-only.
    const foldersRow = screen.getByRole("menuitem", {
      name: "Folders — position 1 of 3",
    })
    // Focusing a menu item updates Radix's roving-focus state, so it has to run
    // inside act().
    act(() => foldersRow.focus())
    await user.keyboard("{Alt>}{ArrowDown}{/Alt}")

    expect(orderRowNames()).toEqual([
      "Chat — position 1 of 3",
      "Folders — position 2 of 3",
      "Recent — position 3 of 3",
    ])
    // Focus follows the row it moved, so a second press keeps going.
    expect(document.activeElement?.getAttribute("aria-label")).toBe(
      "Folders — position 2 of 3"
    )
  })

  it("restores a legacy 'chats-first' preference from an older build", async () => {
    const user = userEvent.setup()
    localStorage.setItem("workspace:sidebar-section-order", "chats-first")
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    expect(orderRowNames()).toEqual([
      "Chat — position 1 of 3",
      "Folders — position 2 of 3",
      "Recent — position 3 of 3",
    ])
  })

  it("keeps a hidden Recent section listed and reorderable", async () => {
    const user = userEvent.setup()
    localStorage.setItem("workspace:sidebar-show-recent", "false")
    renderSidebar()
    await user.click(screen.getByRole("button", { name: "View options" }))

    // Hiding is a separate preference from position: the row stays so the user
    // can park it where it will reappear.
    await user.click(screen.getByRole("button", { name: "Recent — Move up" }))
    expect(spies.listProps?.sectionOrder).toEqual([
      "folders",
      "recent",
      "chats",
    ])
    expect(spies.listProps?.showRecent).toBe(false)
  })
})

describe("Sidebar — quick links fold", () => {
  beforeEach(() => {
    localStorage.clear()
    spies.listProps = null
    mockState.activeFolder = { id: 7, path: "/x" }
  })
  afterEach(() => vi.useRealTimers())

  const QUICK_LINKS = [
    "Automations",
    "To-dos",
    "Repository panel",
    "Infinite Canvas",
    "Apps",
  ]
  const NAV_FOLDED_KEY = "workspace:sidebar-nav-folded"

  const navFoldToggle = () =>
    document.querySelector(
      "[data-sidebar-nav-fold-toggle]"
    ) as HTMLButtonElement
  const shownQuickLinks = () =>
    QUICK_LINKS.filter((name) => screen.queryByRole("button", { name }))
  // [row id, what the chip shows, the name it reads out] for each count chip
  // the toggle carries.
  const foldCounts = () =>
    [...navFoldToggle().querySelectorAll("[data-nav-fold-count]")].map(
      (chip) => [
        chip.getAttribute("data-nav-fold-count"),
        chip.querySelector('span[aria-hidden="true"]')?.textContent,
        chip.querySelector(".sr-only")?.textContent,
      ]
    )
  const foldChip = (id: string) =>
    navFoldToggle().querySelector(`[data-nav-fold-count="${id}"]`)!
  // A badged row's own count chip: the last child of its button.
  const rowBadge = (name: string) =>
    screen
      .getByRole("button", { name: new RegExp(`^${name}`) })
      .querySelector(":scope > span:last-child")!
  const tone = (chip: Element) =>
    chip.className.includes("text-destructive")
      ? "failure"
      : chip.className.includes("text-primary")
        ? "attention"
        : "none"

  it("sits right under New chat, unfolded by default with every quick link shown", () => {
    renderSidebar()
    const toggle = navFoldToggle()
    expect(
      screen.getByText("New chat").closest("button")?.nextElementSibling
    ).toBe(toggle)
    expect(toggle).toHaveAttribute("aria-expanded", "true")
    expect(toggle).toHaveTextContent("Hide quick links")
    expect(shownQuickLinks()).toEqual(QUICK_LINKS)
    // The toggle stays put under the pointer only because every row it folds
    // sits below it.
    for (const name of QUICK_LINKS) {
      const position = toggle.compareDocumentPosition(
        screen.getByRole("button", { name })
      )
      expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    }
  })

  it("folds every quick link away in one click, keeps New chat and the list, and persists", () => {
    renderSidebar()
    fireEvent.click(navFoldToggle())

    expect(navFoldToggle()).toHaveAttribute("aria-expanded", "false")
    expect(navFoldToggle()).toHaveTextContent("Show quick links")
    expect(shownQuickLinks()).toEqual([])
    expect(screen.getByRole("button", { name: /New chat/ })).toBeTruthy()
    // The conversation list stays mounted.
    expect(spies.listProps).not.toBeNull()
    expect(localStorage.getItem(NAV_FOLDED_KEY)).toBe("true")

    fireEvent.click(navFoldToggle())
    expect(navFoldToggle()).toHaveAttribute("aria-expanded", "true")
    expect(shownQuickLinks()).toEqual(QUICK_LINKS)
    expect(localStorage.getItem(NAV_FOLDED_KEY)).toBe("false")
  })

  it("restores a persisted fold on mount", () => {
    localStorage.setItem(NAV_FOLDED_KEY, "true")
    renderSidebar()
    expect(navFoldToggle()).toHaveAttribute("aria-expanded", "false")
    expect(shownQuickLinks()).toEqual([])
  })

  it("folds and unfolds from the keyboard", async () => {
    const user = userEvent.setup()
    renderSidebar()
    act(() => navFoldToggle().focus())
    await user.keyboard("{Enter}")
    expect(navFoldToggle()).toHaveAttribute("aria-expanded", "false")
    await user.keyboard(" ")
    expect(navFoldToggle()).toHaveAttribute("aria-expanded", "true")
    expect(shownQuickLinks()).toEqual(QUICK_LINKS)
  })

  it("carries the hidden rows' counts while folded, tinted like their rows", async () => {
    mockState.unseenFailures = 2
    mockState.attentionCount = 4
    renderSidebar()
    await act(async () => {})
    // Unfolded, the counts sit on their own rows and the toggle carries none.
    expect(rowBadge("Automations")).toHaveTextContent(/^2$/)
    expect(rowBadge("To-dos")).toHaveTextContent(/^4$/)
    const rowTones = {
      automations: tone(rowBadge("Automations")),
      tasks: tone(rowBadge("To-dos")),
    }
    expect(rowTones).toEqual({
      automations: "failure",
      tasks: "attention",
    })
    expect(foldCounts()).toEqual([])

    fireEvent.click(navFoldToggle())
    expect(foldCounts()).toEqual([
      ["automations", "2", "Automations 2"],
      ["tasks", "4", "To-dos 4"],
    ])
    // Each chip wears its row's tint — a failure stays destructive — and its
    // row's icon, so two same-tinted numbers never read alike.
    for (const [id, rowTone] of Object.entries(rowTones)) {
      expect(tone(foldChip(id))).toBe(rowTone)
      expect(foldChip(id).querySelector("svg")).not.toBeNull()
    }
    expect(foldChip("automations")).toHaveAttribute("title", "Automations 2")

    // Unfolded again, the counts move back onto their rows.
    fireEvent.click(navFoldToggle())
    expect(foldCounts()).toEqual([])
    expect(rowBadge("Automations")).toHaveTextContent(/^2$/)
  })

  it("shows 99+ past 99 like the rows, while tooltip and name keep the exact count", async () => {
    mockState.unseenFailures = 100
    mockState.attentionCount = 99
    localStorage.setItem(NAV_FOLDED_KEY, "true")
    renderSidebar()
    await act(async () => {})
    expect(foldCounts()).toEqual([
      ["automations", "99+", "Automations 100"],
      ["tasks", "99", "To-dos 99"],
    ])
    expect(foldChip("automations")).toHaveAttribute("title", "Automations 100")
  })

  it("carries no chip when nothing needs attention", async () => {
    localStorage.setItem(NAV_FOLDED_KEY, "true")
    renderSidebar()
    await act(async () => {})
    expect(foldCounts()).toEqual([])
    expect(navFoldToggle().textContent).toBe("Show quick links")
  })

  it("keeps a row switched off in View options silent while folded", async () => {
    mockState.unseenFailures = 2
    mockState.attentionCount = 3
    localStorage.setItem(
      "workspace:sidebar-nav-items",
      JSON.stringify({ automations: false })
    )
    localStorage.setItem(NAV_FOLDED_KEY, "true")
    renderSidebar()
    await act(async () => {})
    expect(foldCounts().map(([id]) => id)).toEqual(["tasks"])
  })

  it("brings back only the rows View options shows when unfolding", () => {
    localStorage.setItem(
      "workspace:sidebar-nav-items",
      JSON.stringify({ forge: false })
    )
    renderSidebar()
    fireEvent.click(navFoldToggle())
    fireEvent.click(navFoldToggle())
    expect(shownQuickLinks()).toEqual([
      "Automations",
      "To-dos",
      "Infinite Canvas",
      "Apps",
    ])
  })

  it("still opens a route after unfolding", () => {
    localStorage.setItem(NAV_FOLDED_KEY, "true")
    renderSidebar()
    fireEvent.click(navFoldToggle())
    spies.setRoute.mockClear()
    fireEvent.click(screen.getByRole("button", { name: "To-dos" }))
    expect(spies.setRoute).toHaveBeenCalledWith("tasks")
  })
})
