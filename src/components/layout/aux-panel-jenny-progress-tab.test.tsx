import { render, screen, waitFor, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import { getJennyProgress } from "@/lib/api"
import type { JennyProgressDetail } from "@/lib/types"

vi.mock("@/lib/api", () => ({ getJennyProgress: vi.fn() }))
vi.mock("@/components/loop/loop-progress-panel", () => ({
  LoopProgressPanel: ({ folderId }: { folderId: number }) => (
    <div data-testid="loop-panel">{folderId}</div>
  ),
}))
vi.mock("@/lib/platform", () => ({
  onTransportReconnect: vi.fn(() => () => {}),
}))
vi.mock("@/contexts/aux-panel-context", () => ({ useAuxPanelContext: vi.fn() }))
vi.mock("@/contexts/tab-context", () => ({ useTabStore: vi.fn() }))
vi.mock("@/stores/conversation-runtime-store", () => ({
  useConversationRuntimeStore: vi.fn(),
}))
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: vi.fn(),
}))

import { JennyProgressAuxTab } from "./aux-panel-jenny-progress-tab"
import { useAuxPanelContext } from "@/contexts/aux-panel-context"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

const mockGet = vi.mocked(getJennyProgress)

/** What the stores hold: the active tab and each conversation's session id. */
const scene = {
  activeConversationId: 7 as number | null,
  live: new Map<number, string | null>(),
  stored: new Map<number, string | null>(),
}

function detail(patch: Partial<JennyProgressDetail> = {}): JennyProgressDetail {
  const at = (hhmm: string) => `2026-11-02T${hhmm}:00+08:00`
  return {
    sessionId: "sess-7",
    taskStatus: "active",
    completionState: "open",
    registration: "current",
    updatedAt: at("11:45"),
    humanSummary: null,
    challengeSummary: null,
    metrics: [
      {
        id: "files",
        label: "Files processed",
        value: 400,
        unit: "files",
        target: 1000,
        history: [
          { at: at("10:00"), value: 100 },
          { at: at("11:00"), value: 400 },
        ],
      },
      {
        id: "errors",
        label: "Errors left",
        value: 3,
        unit: "errors",
        target: null,
        history: [
          { at: at("10:20"), value: 7 },
          { at: at("11:10"), value: 3 },
        ],
      },
    ],
    revision: 3,
    ...patch,
  }
}

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <JennyProgressAuxTab />
    </NextIntlClientProvider>
  )
}

describe("JennyProgressAuxTab", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    scene.activeConversationId = 7
    scene.live = new Map()
    scene.stored = new Map([[7, "sess-7"]])
    ;(useAuxPanelContext as Mock).mockReturnValue({
      isOpen: true,
      activeTab: "jenny_progress",
    })
    ;(useTabStore as unknown as Mock).mockImplementation((select) =>
      select({
        tabs:
          scene.activeConversationId == null
            ? []
            : [{ id: 1, conversationId: scene.activeConversationId }],
        activeTabId: 1,
      })
    )
    ;(useConversationRuntimeStore as unknown as Mock).mockImplementation(
      (select) =>
        select({
          byConversationId: new Map(
            [...scene.live].map(([id, external_id]) => [
              id,
              { detail: { summary: { external_id } } },
            ])
          ),
        })
    )
    ;(useAppWorkspaceStore as unknown as Mock).mockImplementation((select) =>
      select({
        conversations: [...scene.stored].map(([id, external_id]) => ({
          id,
          external_id,
          kind: id === 9 ? "loop" : "conversation",
          folder_id: 40 + id,
        })),
      })
    )
  })

  it("shows the run's registration for a Loop conversation, not a turn's", () => {
    scene.activeConversationId = 9
    scene.stored = new Map([[9, "jenny-loop:49"]])
    renderTab()

    expect(screen.getByTestId("loop-panel")).toHaveTextContent("49")
    expect(mockGet).not.toHaveBeenCalled()
  })

  it("shows the active conversation's own record, by its session id", async () => {
    mockGet.mockResolvedValue(detail())
    renderTab()

    expect(await screen.findByText("Files processed")).toBeVisible()
    expect(mockGet).toHaveBeenCalledWith("sess-7")
    expect(screen.getByText("In progress")).toBeVisible()
    // This IS the conversation: no button to open it again.
    expect(
      screen.queryByRole("button", { name: /open conversation/i })
    ).toBeNull()
  })

  it("draws the first number as the main chart and the others below it", async () => {
    mockGet.mockResolvedValue(detail())
    const { container } = renderTab()
    await screen.findByText("Files processed")

    const main = container.querySelector('[data-jenny-main-chart="files"]')!
    expect(within(main as HTMLElement).getByText("400")).toBeVisible()
    expect(within(main as HTMLElement).getByText(/\/ 1000 files/)).toBeVisible()
    expect(main.querySelector("[data-chart-line]")).not.toBeNull()
    expect(main.querySelector("[data-chart-target]")).not.toBeNull()

    const small = container.querySelector('[data-jenny-metric="errors"]')!
    expect(within(small as HTMLElement).getByText("Errors left")).toBeVisible()
    expect(small.querySelector("[data-chart-line]")).not.toBeNull()
    expect(small.querySelector("[data-chart-target]")).toBeNull()
    // The main chart is drawn taller than the small ones.
    const height = (el: Element) =>
      Number(el.querySelector("svg")!.getAttribute("viewBox")!.split(" ")[3])
    expect(height(main)).toBeGreaterThan(height(small))
  })

  it("shows what only the user can do above the charts", async () => {
    mockGet.mockResolvedValue(detail({ humanSummary: "Log in to the store" }))
    const { container } = renderTab()

    const need = await screen.findByText(/Log in to the store/)
    expect(need).toBeVisible()
    expect(need.textContent).toContain("Needs you")
    expect(container.querySelector("[data-jenny-need]")).toBe(need)
  })

  it("shows only the state when a task has no numbers", async () => {
    mockGet.mockResolvedValue(
      detail({ metrics: [], completionState: "completed" })
    )
    const { container } = renderTab()

    expect(await screen.findByText("Done")).toBeVisible()
    expect(screen.getByText(/No numbers to chart/)).toBeVisible()
    expect(container.querySelector("svg")).toBeNull()
  })

  it("shows a single point as a number once the task has ended", async () => {
    const [files] = detail().metrics
    mockGet.mockResolvedValue(
      detail({
        taskStatus: "completed",
        completionState: "completed",
        metrics: [{ ...files, value: 100, history: [files.history[0]] }],
      })
    )
    const { container } = renderTab()

    expect(await screen.findByText("100")).toBeVisible()
    expect(container.querySelector("svg")).toBeNull()
  })

  it("draws a number held since its first report as a flat line while the task runs", async () => {
    const [files] = detail().metrics
    mockGet.mockResolvedValue(
      detail({
        metrics: [{ ...files, value: 100, history: [files.history[0]] }],
      })
    )
    const { container } = renderTab()

    await screen.findByText("Files processed")
    expect(container.querySelector("[data-chart-hold]")).not.toBeNull()
    expect(container.querySelector("[data-chart-line]")).toBeNull()
  })

  it("keeps the leading digits of a small number", async () => {
    const [files] = detail().metrics
    mockGet.mockResolvedValue(
      detail({
        metrics: [
          {
            ...files,
            value: 0.0042,
            target: null,
            history: [
              { at: files.history[0].at, value: 0.0091 },
              { at: files.history[1].at, value: 0.0042 },
            ],
          },
        ],
      })
    )
    const { container } = renderTab()

    await screen.findByText("Files processed")
    const main = container.querySelector("[data-jenny-main-chart]")!
    expect(within(main as HTMLElement).getAllByText("0.0042")).toHaveLength(2)
    expect(within(main as HTMLElement).getByText("0.0091")).toBeVisible()
  })

  it("names a turn that ended without saying how", async () => {
    mockGet.mockResolvedValue(
      detail({ registration: "missed", completionState: "completed" })
    )
    renderTab()

    expect(await screen.findByText("Not registered")).toBeVisible()
    expect(screen.queryByText("Done")).toBeNull()
  })

  it("prefers the live session's id for a conversation that just started", async () => {
    scene.stored = new Map([[7, null]])
    scene.live = new Map([[7, "sess-live"]])
    mockGet.mockResolvedValue(detail({ sessionId: "sess-live" }))
    renderTab()

    await waitFor(() => expect(mockGet).toHaveBeenCalledWith("sess-live"))
  })

  it("says so when Jenny has no record for the conversation yet", async () => {
    mockGet.mockRejectedValue({ code: "not_found", message: "no record" })
    renderTab()

    expect(
      await screen.findByText("No Jenny record for this conversation yet")
    ).toBeVisible()
  })

  it("shows the read error with a retry", async () => {
    mockGet.mockRejectedValue({ code: "io_error", message: "disk gone" })
    renderTab()

    expect(await screen.findByText("disk gone")).toBeVisible()
    mockGet.mockResolvedValue(detail())
    screen.getByRole("button", { name: "Retry" }).click()
    expect(await screen.findByText("Files processed")).toBeVisible()
  })

  it("reads nothing without a conversation, or while the tab is hidden", () => {
    scene.activeConversationId = null
    const { unmount } = renderTab()
    expect(screen.getByText(/no active session/i)).toBeVisible()
    unmount()

    scene.activeConversationId = 7
    ;(useAuxPanelContext as Mock).mockReturnValue({
      isOpen: true,
      activeTab: "session_details",
    })
    renderTab()
    expect(mockGet).not.toHaveBeenCalled()
  })
})
