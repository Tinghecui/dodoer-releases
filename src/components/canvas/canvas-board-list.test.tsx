import { act, render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import {
  canvasCreateBoard,
  canvasDeleteBoard,
  canvasListBoards,
  canvasUpdateBoard,
} from "@/lib/api"
import type { CanvasBoard, CanvasBoardSummary, FolderDetail } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useCanvasBoardsStore } from "@/stores/canvas-boards-store"
import { CanvasBoardList } from "./canvas-board-list"

vi.mock("@/lib/api", () => ({
  canvasListBoards: vi.fn(),
  canvasCreateBoard: vi.fn(),
  canvasUpdateBoard: vi.fn(),
  canvasDeleteBoard: vi.fn(),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn().mockResolvedValue(() => {}),
  onTransportReconnect: vi.fn(() => () => {}),
}))

const mockList = vi.mocked(canvasListBoards)
const mockCreate = vi.mocked(canvasCreateBoard)
const mockUpdate = vi.mocked(canvasUpdateBoard)
const mockDelete = vi.mocked(canvasDeleteBoard)

function board(id: number, over: Partial<CanvasBoard> = {}): CanvasBoard {
  return {
    id,
    name: `Board ${id}`,
    description: null,
    color: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  }
}

function summary(
  b: CanvasBoard,
  over: Partial<CanvasBoardSummary> = {}
): CanvasBoardSummary {
  return { board: b, node_count: 0, terminal_count: 0, preview: [], ...over }
}

const SPRINT = summary(
  board(1, { name: "Sprint", description: "Where the sprint lives" }),
  {
    node_count: 3,
    terminal_count: 1,
    preview: [
      {
        kind: "custom",
        x: 0,
        y: 0,
        width: 600,
        height: 400,
        color: "blue",
      },
    ],
  }
)
const UNNAMED = summary(board(2, { name: null }))

function renderList() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <CanvasBoardList />
    </NextIntlClientProvider>
  )
}

/** The options menu of the card named `name`. */
async function openCardMenu(name: string) {
  const card = (await screen.findByRole("button", { name })).parentElement
  if (!card) throw new Error("card not found")
  await userEvent.click(
    within(card).getByRole("button", { name: "Canvas options" })
  )
}

beforeEach(() => {
  useAppWorkspaceStore.setState({ activeFolderId: null, allFolders: [] })
  useCanvasBoardsStore.getState().reset()
  localStorage.clear()
  mockList.mockReset()
  mockCreate.mockReset()
  mockUpdate.mockReset()
  mockDelete.mockReset()
  mockList.mockResolvedValue([SPRINT, UNNAMED])
})

describe("CanvasBoardList", () => {
  it("shows a card per canvas, with what is on it", async () => {
    renderList()
    expect(await screen.findByRole("button", { name: "Sprint" })).toBeTruthy()
    // Unnamed boards go by the localized placeholder, never an empty title.
    expect(screen.getByRole("button", { name: "Untitled canvas" })).toBeTruthy()
    expect(screen.getByText("Where the sprint lives")).toBeTruthy()
    expect(screen.getByText(/^3 items/)).toBeTruthy()
    expect(screen.getByText(/^Empty/)).toBeTruthy()
    expect(screen.getByText("2 canvases")).toBeTruthy()
  })

  it("opens a canvas when its card is clicked", async () => {
    renderList()
    await userEvent.click(await screen.findByRole("button", { name: "Sprint" }))
    expect(useCanvasBoardsStore.getState().activeBoardId).toBe(1)
  })

  it("creates a canvas and opens it", async () => {
    mockCreate.mockResolvedValue(board(7, { name: "Roadmap" }))
    renderList()
    await screen.findByRole("button", { name: "Sprint" })
    // The toolbar's button (the trailing tile carries the same label).
    await userEvent.click(
      screen.getAllByRole("button", { name: "New canvas" })[0]
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "Roadmap")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" })
    )

    expect(mockCreate).toHaveBeenCalledWith({
      name: "Roadmap",
      description: "",
      color: "",
      // 没有当前项目：不属于哪个项目。
      folderId: null,
    })
    await waitFor(() =>
      expect(useCanvasBoardsStore.getState().activeBoardId).toBe(7)
    )
  })

  it("keeps the dialog open when creating fails", async () => {
    mockCreate.mockRejectedValue(new Error("disk full"))
    renderList()
    await screen.findByRole("button", { name: "Sprint" })
    await userEvent.click(
      screen.getAllByRole("button", { name: "New canvas" })[0]
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "Roadmap")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" })
    )
    await waitFor(() => expect(mockCreate).toHaveBeenCalled())
    // What the user typed is still there to retry with.
    expect(screen.getByRole("dialog")).toBeTruthy()
    expect(
      (
        within(screen.getByRole("dialog")).getByLabelText(
          "Name"
        ) as HTMLInputElement
      ).value
    ).toBe("Roadmap")
    expect(useCanvasBoardsStore.getState().activeBoardId).toBeNull()
  })

  it("cannot be dismissed while a save is in flight", async () => {
    let fail: (e: unknown) => void = () => {}
    mockCreate.mockImplementation(
      () => new Promise((_resolve, reject) => (fail = reject))
    )
    renderList()
    await screen.findByRole("button", { name: "Sprint" })
    await userEvent.click(
      screen.getAllByRole("button", { name: "New canvas" })[0]
    )
    const dialog = await screen.findByRole("dialog")
    await userEvent.type(within(dialog).getByLabelText("Name"), "Roadmap")
    await userEvent.click(
      within(dialog).getByRole("button", { name: "Create" })
    )
    // Escape while the write is out: dismissing now would lose the text if
    // the write then fails.
    await userEvent.keyboard("{Escape}")
    expect(screen.getByRole("dialog")).toBeTruthy()

    fail(new Error("disk full"))
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("button", {
          name: "Create",
        })
      ).not.toBeDisabled()
    )
    expect(
      (
        within(screen.getByRole("dialog")).getByLabelText(
          "Name"
        ) as HTMLInputElement
      ).value
    ).toBe("Roadmap")
    // Once nothing is in flight, Escape closes it as usual.
    await userEvent.keyboard("{Escape}")
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
  })

  it("edits a canvas from its menu", async () => {
    mockUpdate.mockResolvedValue(
      board(1, {
        name: "Sprint 2",
        description: "Where the sprint lives",
        updated_at: "2026-09-02T00:00:00Z",
      })
    )
    renderList()
    await openCardMenu("Sprint")
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Edit canvas…" })
    )
    const dialog = await screen.findByRole("dialog")
    const name = within(dialog).getByLabelText("Name") as HTMLInputElement
    // Starts from the board as it is.
    expect(name.value).toBe("Sprint")
    expect(
      (within(dialog).getByLabelText("Description") as HTMLTextAreaElement)
        .value
    ).toBe("Where the sprint lives")
    await userEvent.clear(name)
    await userEvent.type(name, "Sprint 2")
    await userEvent.click(within(dialog).getByRole("button", { name: "Save" }))

    expect(mockUpdate).toHaveBeenCalledWith(1, {
      name: "Sprint 2",
      description: "Where the sprint lives",
      color: "",
    })
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull())
    // The row changes when the edit's own event arrives — the answer alone is
    // not applied (it can't be ordered against other clients' edits).
    expect(screen.getByRole("button", { name: "Sprint" })).toBeTruthy()
    act(() => {
      useCanvasBoardsStore.getState().handleBoardChanged({
        kind: "upsert",
        board: board(1, {
          name: "Sprint 2",
          description: "Where the sprint lives",
          updated_at: "2026-09-02T00:00:00Z",
        }),
      })
    })
    expect(await screen.findByRole("button", { name: "Sprint 2" })).toBeTruthy()
    // Counts and thumbnail survive an edit of the row.
    expect(screen.getByText(/^3 items/)).toBeTruthy()
  })

  it("deletes a canvas after confirming, and forgets what this device kept for it", async () => {
    mockDelete.mockResolvedValue({ value: [11, 12, 13], revision: 9 })
    localStorage.setItem(
      "workspace:canvas-viewport:1",
      JSON.stringify({ x: 1, y: 2, zoom: 1 })
    )
    localStorage.setItem(
      "workspace:canvas-viewport:2",
      JSON.stringify({ x: 3, y: 4, zoom: 1 })
    )
    renderList()
    await openCardMenu("Sprint")
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete canvas…" })
    )
    const confirm = await screen.findByRole("alertdialog")
    // Says what goes with it before asking.
    expect(within(confirm).getByText("It holds 3 items.")).toBeTruthy()
    expect(
      within(confirm).getByText(
        "1 terminal on it will be closed and its process stopped."
      )
    ).toBeTruthy()
    expect(mockDelete).not.toHaveBeenCalled()
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Delete canvas" })
    )

    expect(mockDelete).toHaveBeenCalledWith(1)
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Sprint" })).toBeNull()
    )
    expect(localStorage.getItem("workspace:canvas-viewport:1")).toBeNull()
    expect(localStorage.getItem("workspace:canvas-viewport:2")).not.toBeNull()
  })

  it("cancelling the delete keeps the canvas", async () => {
    renderList()
    await openCardMenu("Sprint")
    await userEvent.click(
      await screen.findByRole("menuitem", { name: "Delete canvas…" })
    )
    const confirm = await screen.findByRole("alertdialog")
    await userEvent.click(
      within(confirm).getByRole("button", { name: "Cancel" })
    )
    expect(mockDelete).not.toHaveBeenCalled()
    expect(screen.getByRole("button", { name: "Sprint" })).toBeTruthy()
  })

  it("narrows the cards by name or description", async () => {
    renderList()
    await screen.findByRole("button", { name: "Sprint" })
    const search = screen.getByRole("searchbox", { name: "Search canvases…" })
    // Case-insensitive, and the description counts too.
    await userEvent.type(search, "LIVES")
    expect(screen.getByRole("button", { name: "Sprint" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Untitled canvas" })).toBeNull()
    await userEvent.clear(search)
    await userEvent.type(search, "nothing like it")
    expect(screen.getByText("No canvases match “nothing like it”")).toBeTruthy()
  })

  it("offers to create the first canvas when there are none", async () => {
    mockList.mockResolvedValue([])
    renderList()
    expect(await screen.findByText("No canvases yet")).toBeTruthy()
    expect(screen.getByRole("button", { name: "New canvas" })).toBeTruthy()
  })

  it("offers a retry when the list cannot be read", async () => {
    mockList.mockRejectedValueOnce(new Error("offline"))
    renderList()
    expect(
      await screen.findByText("Couldn't load canvases: offline")
    ).toBeTruthy()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("button", { name: "Sprint" })).toBeTruthy()
  })

  it("a failed re-read of an empty list shows the failure, not the empty state", async () => {
    mockList.mockResolvedValueOnce([])
    const view = renderList()
    expect(await screen.findByText("No canvases yet")).toBeTruthy()
    view.unmount()

    // 切走再切回：重新挂载时会再读一次列表
    mockList.mockRejectedValueOnce(new Error("offline"))
    renderList()
    expect(
      await screen.findByText("Couldn't load canvases: offline")
    ).toBeTruthy()
    expect(screen.queryByText("No canvases yet")).toBeNull()
    expect(screen.queryByRole("button", { name: "New canvas" })).toBeNull()
    await userEvent.click(screen.getByRole("button", { name: "Retry" }))
    expect(await screen.findByRole("button", { name: "Sprint" })).toBeTruthy()
  })

  it("a slow re-read of an empty list shows a spinner, not the empty state", async () => {
    mockList.mockResolvedValueOnce([])
    const view = renderList()
    expect(await screen.findByText("No canvases yet")).toBeTruthy()
    view.unmount()

    let resolve: (list: CanvasBoardSummary[]) => void = () => {}
    mockList.mockImplementationOnce(() => new Promise((r) => (resolve = r)))
    const { container } = renderList()
    expect(screen.queryByText("No canvases yet")).toBeNull()
    expect(container.querySelector(".animate-spin")).toBeTruthy()
    await act(async () => resolve([]))
    expect(await screen.findByText("No canvases yet")).toBeTruthy()
  })

  describe("per project (#1193)", () => {
    function folder(
      id: number,
      over: Partial<FolderDetail> = {}
    ): FolderDetail {
      return {
        id,
        name: `project-${id}`,
        path: `/tmp/project-${id}`,
        parent_id: null,
        kind: "regular",
        ...over,
      } as FolderDetail
    }
    const DEMO = summary(board(11, { name: "Demo canvas", folder_id: 1 }))
    const DOCS = summary(board(12, { name: "Docs canvas", folder_id: 2 }))
    const SHARED = summary(
      board(13, { name: "Shared canvas", folder_id: null })
    )

    beforeEach(() => {
      // 后端只回这个项目的画布和不属于任何项目的画布。
      mockList.mockImplementation(async (folderId?: number | null) =>
        [DEMO, DOCS, SHARED].filter(
          (s) =>
            folderId == null ||
            s.board.folder_id == null ||
            s.board.folder_id === folderId
        )
      )
      useAppWorkspaceStore.setState({
        activeFolderId: 1,
        allFolders: [folder(1), folder(2), folder(3, { parent_id: 1 })],
      })
    })

    it("lists the current project's canvases and re-reads when the project changes", async () => {
      renderList()
      expect(
        await screen.findByRole("button", { name: "Demo canvas" })
      ).toBeTruthy()
      expect(screen.getByRole("button", { name: "Shared canvas" })).toBeTruthy()
      expect(screen.queryByRole("button", { name: "Docs canvas" })).toBeNull()
      expect(mockList).toHaveBeenLastCalledWith(1)

      act(() => useAppWorkspaceStore.setState({ activeFolderId: 2 }))
      expect(
        await screen.findByRole("button", { name: "Docs canvas" })
      ).toBeTruthy()
      expect(screen.queryByRole("button", { name: "Demo canvas" })).toBeNull()
      expect(screen.getByRole("button", { name: "Shared canvas" })).toBeTruthy()
      expect(mockList).toHaveBeenLastCalledWith(2)
      // 每次读都带着项目。
      expect(mockList.mock.calls.every(([id]) => id === 1 || id === 2)).toBe(
        true
      )
    })

    it("a worktree shows its repository's canvases", async () => {
      useAppWorkspaceStore.setState({ activeFolderId: 3 })
      renderList()
      expect(
        await screen.findByRole("button", { name: "Demo canvas" })
      ).toBeTruthy()
      expect(mockList).toHaveBeenLastCalledWith(1)
    })

    it("creates the canvas in the current project", async () => {
      mockCreate.mockResolvedValue(board(20, { name: "New", folder_id: 2 }))
      useAppWorkspaceStore.setState({ activeFolderId: 2 })
      renderList()
      await screen.findByRole("button", { name: "Docs canvas" })
      await userEvent.click(
        screen.getAllByRole("button", { name: "New canvas" })[0]
      )
      const dialog = await screen.findByRole("dialog")
      await userEvent.type(within(dialog).getByLabelText("Name"), "New")
      await userEvent.click(
        within(dialog).getByRole("button", { name: "Create" })
      )
      await waitFor(() =>
        expect(mockCreate).toHaveBeenCalledWith(
          expect.objectContaining({ folderId: 2 })
        )
      )
      expect(useCanvasBoardsStore.getState().activeBoardId).toBe(20)
    })
  })
})
