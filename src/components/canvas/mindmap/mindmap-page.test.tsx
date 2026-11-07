import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import { getConversationTaxonomy, listUnopenableConversations } from "@/lib/api"
import type { ConversationTaxonomy } from "@/lib/conversation-taxonomy"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationTaxonomyStore } from "@/stores/conversation-taxonomy-store"
import { useMindMapViewStore } from "@/stores/mindmap-view-store"
import { useTabStore } from "@/stores/tab-store"
import { MindMapPage } from "./mindmap-page"

vi.mock("@/lib/api", () => ({
  getConversationTaxonomy: vi.fn(),
  assignConversationCategory: vi.fn(),
  listUnopenableConversations: vi.fn(async () => []),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))
// React Flow is not what these tests are about: a marker carrying what the
// page handed the view is enough.
vi.mock("./mindmap-view", () => ({
  default: (props: {
    projectKey: number
    projectLabel: string
    conversations: DbConversationSummary[]
    taxonomy: ConversationTaxonomy | null
    unopenable: ReadonlySet<number>
    query: string
  }) => (
    <div
      data-testid="mindmap-view"
      data-project={props.projectKey}
      data-label={props.projectLabel}
      data-conversations={props.conversations.map((c) => c.id).join(",")}
      data-revision={props.taxonomy?.revision ?? "none"}
      data-query={props.query}
      data-unopenable={[...props.unopenable].join(",")}
    />
  ),
}))

const mockGet = vi.mocked(getConversationTaxonomy)

function folder(id: number, extra: Partial<FolderDetail> = {}): FolderDetail {
  return {
    id,
    name: `project-${id}`,
    path: `/p/project-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-10-01T00:00:00Z",
    sort_order: 0,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    group_id: null,
    ...extra,
  }
}

function conv(
  id: number,
  folder_id: number,
  extra: Partial<DbConversationSummary> = {}
): DbConversationSummary {
  return {
    id,
    folder_id,
    title: `Conversation ${id}`,
    title_locked: false,
    agent_type: "codex",
    status: "completed",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-01T00:00:00Z",
    pinned_at: null,
    ...extra,
  }
}

function taxonomy(
  folder_id: number,
  extra: Partial<ConversationTaxonomy> = {}
): ConversationTaxonomy {
  return {
    folder_id,
    revision: 1,
    categories: [],
    assignments: {},
    reorganized_at: null,
    reorganize_summary: null,
    ...extra,
  }
}

const one = folder(1)
const two = folder(2, { alias: "Jenny" })
const twoWorktree = folder(3, { parent_id: 2 })
const chat = folder(4, { kind: "chat" })
const closed = folder(5)

/** The tab in front of the user: a conversation, or a draft (no id yet). */
function setActiveTab(folderId: number | null, conversationId: number | null) {
  useTabStore.setState({
    rawTabs:
      folderId == null
        ? []
        : [
            {
              id: "tab-1",
              kind: "conversation",
              folderId,
              conversationId,
              agentType: "codex",
              title: "",
              isPinned: false,
            },
          ],
    activeTabId: folderId == null ? null : "tab-1",
  })
}

function setWorkspace(over: {
  folders?: FolderDetail[]
  activeFolderId?: number | null
  conversations?: DbConversationSummary[]
}) {
  // The active folder is the active tab's: a saved conversation in it.
  setActiveTab(over.activeFolderId ?? null, over.activeFolderId ? 999 : null)
  useAppWorkspaceStore.setState({
    folders: over.folders ?? [one, two, chat],
    allFolders: [one, two, twoWorktree, chat, closed],
    conversations: over.conversations ?? [
      conv(10, 1),
      conv(20, 2),
      conv(21, 3),
      // Not on a map: a delegated child and a loop run.
      conv(22, 2, { parent_id: 20 }),
      conv(23, 2, { kind: "loop" }),
      conv(40, 4),
      conv(50, 5),
    ],
  })
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <MindMapPage />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  window.localStorage.clear()
  useMindMapViewStore.setState({
    mode: "mindmap",
    projectId: null,
    collapsed: new Set(),
    leafLimits: new Map(),
  })
  useConversationTaxonomyStore.getState().reset()
  mockGet.mockReset()
  mockGet.mockImplementation(async (folderId) => taxonomy(folderId))
})

describe("MindMapPage", () => {
  it("opens on the project of the conversation in front of the user", async () => {
    setWorkspace({ activeFolderId: 3 })
    renderPage()
    const view = await screen.findByTestId("mindmap-view")
    expect(view.dataset.project).toBe("2")
    expect(view.dataset.label).toBe("Jenny [ project-2 ]")
    // The worktree's conversation belongs to its project; children and loops
    // are not drawn.
    expect(view.dataset.conversations?.split(",").sort()).toEqual(["20", "21"])
    expect(mockGet).toHaveBeenCalledWith(2)
    expect(useMindMapViewStore.getState().projectId).toBe(2)
  })

  it("is not pulled away by a draft tab", async () => {
    setWorkspace({})
    setActiveTab(1, null)
    useMindMapViewStore.setState({ projectId: 2 })
    renderPage()
    expect((await screen.findByTestId("mindmap-view")).dataset.project).toBe(
      "2"
    )
  })

  it("falls back to the project picked last, then to the first one", async () => {
    setWorkspace({})
    useMindMapViewStore.setState({ projectId: 5 })
    const { unmount } = renderPage()
    // A closed project picked earlier still opens.
    expect((await screen.findByTestId("mindmap-view")).dataset.project).toBe(
      "5"
    )
    unmount()

    useMindMapViewStore.setState({ projectId: 999 })
    renderPage()
    expect((await screen.findByTestId("mindmap-view")).dataset.project).toBe(
      "1"
    )
  })

  it("switches project from the list, which counts each project's conversations", async () => {
    setWorkspace({ activeFolderId: 1 })
    renderPage()
    await screen.findByTestId("mindmap-view")
    await userEvent.click(screen.getByRole("combobox", { name: "Project" }))
    const options = await screen.findAllByRole("option")
    expect(options.map((o) => o.textContent)).toEqual([
      "project-11",
      "Jenny [ project-2 ]2",
    ])
    await userEvent.click(options[1])
    await waitFor(() =>
      expect(screen.getByTestId("mindmap-view").dataset.project).toBe("2")
    )
    expect(useMindMapViewStore.getState().projectId).toBe(2)
  })

  it("says when a project has never been organized", async () => {
    setWorkspace({ activeFolderId: 1 })
    renderPage()
    // The status sits in the help card, out of the crowded top strip.
    await userEvent.click(
      await screen.findByRole("button", {
        name: "How conversations are sorted",
      })
    )
    expect(await screen.findByText("Not organized yet")).toBeTruthy()
    expect(
      await screen.findByText(/This project has no categories yet/)
    ).toBeTruthy()
  })

  it("says when the map was last organized", async () => {
    setWorkspace({ activeFolderId: 1 })
    mockGet.mockImplementation(async (folderId) =>
      taxonomy(folderId, {
        revision: 3,
        categories: [
          { id: "ui", parent_id: null, name: "UI", rule: "Screens." },
        ],
        reorganized_at: new Date(Date.now() - 3 * 3600_000).toISOString(),
        reorganize_summary: "Split UI out of misc.",
      })
    )
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("mindmap-view").dataset.revision).toBe("3")
    )
    await userEvent.click(
      screen.getByRole("button", { name: "How conversations are sorted" })
    )
    expect(await screen.findByText("Organized about 3 hours ago")).toBeTruthy()
    expect(screen.queryByText(/This project has no categories yet/)).toBeNull()
    await waitFor(() =>
      expect(screen.getByTestId("mindmap-view").dataset.revision).toBe("3")
    )
  })

  it("waits for the map's categories before drawing it", async () => {
    setWorkspace({ activeFolderId: 1 })
    let answer!: (t: ConversationTaxonomy) => void
    mockGet.mockImplementation(
      () => new Promise((resolve) => (answer = resolve))
    )
    const { container } = renderPage()
    await waitFor(() => expect(mockGet).toHaveBeenCalledWith(1))
    expect(container.querySelector("[data-mindmap-loading]")).not.toBeNull()
    expect(screen.queryByTestId("mindmap-view")).toBeNull()
    expect(screen.queryByText("Not organized yet")).toBeNull()

    answer(taxonomy(1, { revision: 4 }))
    expect((await screen.findByTestId("mindmap-view")).dataset.revision).toBe(
      "4"
    )
    expect(container.querySelector("[data-mindmap-loading]")).toBeNull()
  })

  it("shows a failed load and retries it", async () => {
    setWorkspace({ activeFolderId: 1 })
    mockGet.mockRejectedValueOnce(new Error("database is locked"))
    renderPage()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Could not load the mind map: database is locked"
    )
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull())
    expect(mockGet).toHaveBeenCalledTimes(2)
  })

  it("has a word for an empty project and for no project at all", async () => {
    setWorkspace({ activeFolderId: 1, conversations: [] })
    const { unmount } = renderPage()
    expect(
      await screen.findByText("This project has no conversations yet.")
    ).toBeTruthy()
    unmount()

    setWorkspace({ folders: [chat], conversations: [] })
    useAppWorkspaceStore.setState({ allFolders: [chat] })
    useMindMapViewStore.setState({ projectId: null })
    renderPage()
    expect(
      await screen.findByText(
        "Open a project folder to see its conversations as a mind map."
      )
    ).toBeTruthy()
  })

  it("hands the search to the map", async () => {
    setWorkspace({ activeFolderId: 1 })
    renderPage()
    await screen.findByTestId("mindmap-view")
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search titles or categories…" }),
      "nothing like this"
    )
    expect(screen.getByTestId("mindmap-view").dataset.query).toBe(
      "nothing like this"
    )
    expect(screen.getByText("Nothing matches “nothing like this”")).toBeTruthy()
  })

  it("collapses and expands every category", async () => {
    setWorkspace({ activeFolderId: 1 })
    mockGet.mockImplementation(async (folderId) =>
      taxonomy(folderId, {
        categories: [
          { id: "ui", parent_id: null, name: "UI", rule: "Screens." },
          { id: "forms", parent_id: "ui", name: "Forms", rule: "Inputs." },
        ],
        assignments: {
          "10": {
            category_id: "forms",
            source: "nightly",
            confidence: null,
            assigned_at: "2026-10-01T00:00:00Z",
          },
        },
      })
    )
    renderPage()
    await screen.findByTestId("mindmap-view")
    await waitFor(() =>
      expect(
        useConversationTaxonomyStore.getState().byFolder[1]?.taxonomy
      ).toBeTruthy()
    )
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }))
    expect([...useMindMapViewStore.getState().collapsed].sort()).toEqual([
      "forms",
      "ui",
    ])
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }))
    expect(useMindMapViewStore.getState().collapsed.size).toBe(0)
  })

  it("hands the map the conversations that would open empty", async () => {
    setWorkspace({
      activeFolderId: 1,
      conversations: [conv(10, 1), conv(11, 1)],
    })
    mockGet.mockImplementation(async (folderId) => taxonomy(folderId))
    vi.mocked(listUnopenableConversations).mockResolvedValue([11])
    renderPage()
    await waitFor(() =>
      expect(screen.getByTestId("mindmap-view")).toHaveAttribute(
        "data-unopenable",
        "11"
      )
    )
    expect(listUnopenableConversations).toHaveBeenCalledWith(1)
    // The folded-by-default branch is opened by "Expand all" and folded by
    // "Collapse all", through the inverted entry in the fold set.
    await userEvent.click(screen.getByRole("button", { name: "Expand all" }))
    expect([...useMindMapViewStore.getState().collapsed]).toEqual([
      "__unopenable__",
    ])
    await userEvent.click(screen.getByRole("button", { name: "Collapse all" }))
    expect([...useMindMapViewStore.getState().collapsed]).toEqual([
      "__unclassified__",
    ])
  })
})
