import { act, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { SearchCommandDialog } from "./search-command-dialog"
import enMessages from "@/i18n/messages/en.json"
import { listAllConversations, searchConversationMessages } from "@/lib/api"
import type {
  ConversationSearchResponse,
  DbConversationSummary,
} from "@/lib/types"
import { useTurnRevealStore } from "@/stores/turn-reveal-store"

// The active folder and its conversations, per test: the agent filter chips
// only render once the folder holds more than one agent type.
const workspace = vi.hoisted(() => ({
  activeFolderId: null as number | null,
  activeFolder: null as { id: number; name: string; path: string } | null,
  conversations: [] as { folder_id: number; agent_type: string }[],
}))

vi.mock("@/components/agent-icon", () => ({ AgentIcon: () => null }))

vi.mock("@/lib/api", () => ({
  listAllConversations: vi.fn(async () => []),
  searchConversationMessages: vi.fn(async () => ({
    results: [],
    candidate_count: 0,
    scanned_count: 0,
    stopped: null,
  })),
}))

const tabs = vi.hoisted(() => ({ openTab: vi.fn() }))

vi.mock("@/contexts/tab-context", () => ({
  useTabActions: () => ({ openTab: tabs.openTab }),
}))

vi.mock("@/contexts/workbench-route-context", () => ({
  useWorkbenchRoute: () => ({ openConversations: vi.fn() }),
}))

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () => ({ openFilePreview: vi.fn() }),
}))

vi.mock("@/contexts/aux-panel-context", () => ({
  useAuxPanelContext: () => ({ revealInFileTree: vi.fn() }),
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolder: workspace.activeFolder,
    activeFolderId: workspace.activeFolderId,
  }),
}))

vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (s: unknown) => unknown) =>
    selector({ conversations: workspace.conversations }),
}))

const fileTree = vi.hoisted(() => ({ reset: vi.fn() }))

vi.mock("@/hooks/use-file-tree", () => ({
  useFileTree: () => ({ allFiles: [], loading: false, reset: fileTree.reset }),
}))

function dialog(open: boolean) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <SearchCommandDialog open={open} onOpenChange={() => {}} />
    </NextIntlClientProvider>
  )
}

function renderDialog() {
  return render(dialog(true))
}

describe("SearchCommandDialog focus", () => {
  beforeEach(() => {
    workspace.activeFolderId = null
    workspace.conversations = []
    fileTree.reset.mockReset()
  })

  it("opens with the cursor in the search box, so typing searches", async () => {
    const user = userEvent.setup()
    renderDialog()

    const input = await screen.findByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    expect(input).toHaveFocus()

    await user.keyboard("auth")
    expect(input).toHaveValue("auth")
  })

  it("keeps the cursor in the search box when switching tabs", async () => {
    const user = userEvent.setup()
    renderDialog()

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.tabFiles })
    )

    expect(
      await screen.findByPlaceholderText(
        enMessages.Folder.search.filePlaceholder
      )
    ).toHaveFocus()
  })

  it("keeps the cursor in the search box when picking an agent filter", async () => {
    workspace.activeFolderId = 1
    workspace.conversations = [
      { folder_id: 1, agent_type: "claude_code" },
      { folder_id: 1, agent_type: "codex" },
    ]
    const user = userEvent.setup()
    renderDialog()

    const input = await screen.findByPlaceholderText(
      enMessages.Folder.search.placeholder
    )
    await user.click(screen.getByRole("button", { name: "Codex" }))
    expect(input).toHaveFocus()

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.allAgents })
    )
    expect(input).toHaveFocus()
  })

  it("pulls the cursor back when the chat composer behind it takes focus", async () => {
    // The composer refocuses itself when an agent turn ends, whether or not
    // the dialog is open over it. The dialog's focus trap must bring the
    // cursor back, or the rest of the query is typed into the composer.
    const composer = document.createElement("textarea")
    document.body.appendChild(composer)
    try {
      const user = userEvent.setup()
      renderDialog()

      const input = await screen.findByPlaceholderText(
        enMessages.Folder.search.placeholder
      )
      act(() => composer.focus())
      expect(input).toHaveFocus()

      await user.keyboard("auth")
      expect(input).toHaveValue("auth")
      expect(composer).toHaveValue("")
    } finally {
      composer.remove()
    }
  })

  it("asks for a native snapshot newer than each opening once it closes", () => {
    const { rerender } = render(dialog(false))
    expect(fileTree.reset).toHaveBeenLastCalledWith(true)
    rerender(dialog(true))
    fileTree.reset.mockClear()
    rerender(dialog(false))
    expect(fileTree.reset).toHaveBeenCalledExactlyOnceWith(true)
  })
})

function summary(
  id: number,
  title: string,
  folderId = 1
): DbConversationSummary {
  return {
    id,
    folder_id: folderId,
    title,
    agent_type: "claude_code",
    status: "completed",
    created_at: "2026-11-12T10:00:00Z",
    updated_at: "2026-11-12T10:00:00Z",
  } as unknown as DbConversationSummary
}

function response(
  partial: Partial<ConversationSearchResponse>
): ConversationSearchResponse {
  return {
    results: [],
    candidate_count: 1,
    scanned_count: 1,
    stopped: null,
    ...partial,
  }
}

const bodyHit = response({
  results: [
    {
      conversation: summary(5, "mango-import-1"),
      title_match: false,
      hits: [
        {
          turn_id: "turn-2",
          turn_index: 2,
          role: "assistant",
          snippet: "It is pineapple-answer-0, as asked.",
        },
      ],
    },
  ],
})

describe("SearchCommandDialog message search (#101)", () => {
  const search = vi.mocked(searchConversationMessages)

  beforeEach(() => {
    workspace.activeFolderId = 1
    workspace.activeFolder = { id: 1, name: "docs-site", path: "/p/docs" }
    workspace.conversations = []
    search.mockReset()
    vi.mocked(listAllConversations).mockClear()
    tabs.openTab.mockReset()
    useTurnRevealStore.setState({ pending: null })
  })

  it("shows a backend hit whose title lacks the query, with its snippet", async () => {
    search.mockResolvedValue(bodyHit)
    const user = userEvent.setup()
    renderDialog()
    await user.keyboard("pineapple-answer-0")

    // Not filtered away by cmdk for missing the query in its title.
    expect(await screen.findByText("mango-import-1")).toBeInTheDocument()
    expect(
      screen.getByText(
        (_, el) => el?.textContent === bodyHit.results[0].hits[0].snippet
      )
    ).toBeInTheDocument()
    expect(search).toHaveBeenLastCalledWith({
      folder_ids: [1],
      agent_type: null,
      query: "pineapple-answer-0",
    })
    expect(listAllConversations).not.toHaveBeenCalled()
  })

  it("opens the conversation at the matching round", async () => {
    search.mockResolvedValue(bodyHit)
    const user = userEvent.setup()
    renderDialog()
    await user.keyboard("pineapple")
    await user.click(await screen.findByText("mango-import-1"))

    expect(tabs.openTab).toHaveBeenCalledWith(1, 5, "claude_code", true)
    expect(useTurnRevealStore.getState().pending).toEqual({
      conversationId: 5,
      turnId: "turn-2",
      turnIndex: 2,
    })
  })

  it("searches every project once switched to all projects", async () => {
    search.mockResolvedValue(response({}))
    const user = userEvent.setup()
    renderDialog()
    await user.keyboard("kiwi")
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ folder_ids: [1], query: "kiwi" })
      )
    )

    await user.click(
      screen.getByRole("button", { name: enMessages.Folder.search.scopeAll })
    )
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(
        expect.objectContaining({ folder_ids: null, query: "kiwi" })
      )
    )
    // The cursor stays in the search box.
    expect(
      screen.getByPlaceholderText(enMessages.Folder.search.placeholder)
    ).toHaveFocus()
  })

  it("says so when only the most recent conversations were searched", async () => {
    search.mockResolvedValue(
      response({
        ...bodyHit,
        candidate_count: 450,
        scanned_count: 200,
        stopped: "conversations",
      })
    )
    const user = userEvent.setup()
    renderDialog()
    await user.keyboard("pineapple")

    const notice = await screen.findByTestId("search-limit-notice")
    expect(notice).toHaveTextContent("200")
    expect(notice).toHaveTextContent("450")
  })

  it("never lets an earlier, slower search replace a newer one's results", async () => {
    let resolveFirst: (value: ConversationSearchResponse) => void = () => {}
    search
      .mockImplementationOnce(
        () =>
          new Promise<ConversationSearchResponse>((resolve) => {
            resolveFirst = resolve
          })
      )
      .mockResolvedValueOnce(
        response({
          results: [
            {
              conversation: summary(8, "newer result"),
              title_match: true,
              hits: [],
            },
          ],
        })
      )
    const user = userEvent.setup()
    renderDialog()
    await user.keyboard("ki")
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1))
    await user.keyboard("wi")
    expect(await screen.findByText("newer result")).toBeInTheDocument()

    await act(async () =>
      resolveFirst(
        response({
          results: [
            {
              conversation: summary(9, "stale result"),
              title_match: true,
              hits: [],
            },
          ],
        })
      )
    )
    expect(screen.queryByText("stale result")).not.toBeInTheDocument()
    expect(screen.getByText("newer result")).toBeInTheDocument()
  })
})
