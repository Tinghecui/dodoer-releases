import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// #1335：stash 页在手机布局下不用左右分栏，先看列表，点文件进详情（差异），
// 详情里返回回到列表；标题栏的返回这时也先回到列表。宽屏照旧左右分栏。

const state = vi.hoisted(() => ({ mobile: true }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/lib/transport", () => ({ isDesktop: () => false }))

const api = vi.hoisted(() => ({
  gitStashList: vi.fn(),
  gitStashShow: vi.fn(),
  gitStashApply: vi.fn(),
  gitStashDrop: vi.fn(),
  gitShowFile: vi.fn(async () => ""),
}))
vi.mock("@/lib/api", () => api)
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
}))
vi.mock("@/components/diff/diff-viewer", () => ({
  DiffViewer: () => <div data-testid="text-diff" />,
}))

import enMessages from "@/i18n/messages/en.json"
import { setInPageRouter } from "@/lib/in-page-navigation"
import { MobileBackButton } from "./mobile-back-button"
import { StashWorkspace } from "./unstash-dialog"

const router = { push: vi.fn(), back: vi.fn() }
let unregister: () => void = () => {}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div data-testid="title-bar">
        <MobileBackButton />
      </div>
      <StashWorkspace folderPath="/repo" />
    </NextIntlClientProvider>
  )
}

function pane(kind: "list" | "detail"): HTMLElement {
  const el = document.querySelector(`[data-list-detail-pane="${kind}"]`)
  if (!el) throw new Error(`no ${kind} pane`)
  return el as HTMLElement
}

async function openFile() {
  await act(async () => {})
  fireEvent.click(screen.getByRole("button", { name: /wip/ }))
  await act(async () => {})
  const row = document.querySelector('[data-tree-row-path="notes.txt"]')
  if (!row) throw new Error("no file row")
  fireEvent.click(row)
  await act(async () => {})
}

beforeEach(() => {
  state.mobile = true
  router.push.mockReset()
  router.back.mockReset()
  vi.spyOn(window.history, "length", "get").mockReturnValue(3)
  unregister = setInPageRouter(router)
  api.gitStashList.mockResolvedValue([
    { ref_name: "stash@{0}", message: "wip", branch: "main", date: "today" },
  ])
  api.gitStashShow.mockResolvedValue([{ status: "M", file: "notes.txt" }])
})

afterEach(() => {
  unregister()
  vi.restoreAllMocks()
})

describe("StashWorkspace 手机布局（#1335）", () => {
  it("先显示列表，点文件进详情，详情里返回回到列表", async () => {
    renderPage()
    await act(async () => {})
    // 手机上仍是同一个分栏（宽度来回切换不卸掉里面的东西），只是拖动条藏起来
    expect(document.querySelector("[data-panel-resize-handle-id]")).toHaveClass(
      "hidden"
    )
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")

    await openFile()
    expect(pane("list")).toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(within(pane("detail")).getByTestId("text-diff")).toBeInTheDocument()
    expect(within(pane("detail")).getByText("notes.txt")).toBeInTheDocument()

    fireEvent.click(
      within(pane("detail")).getByRole("button", { name: "Back" })
    )
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")
    expect(router.back).not.toHaveBeenCalled()
  })

  it("标题栏的返回：在详情里回到列表，在列表里离开这页", async () => {
    renderPage()
    await openFile()
    const titleBack = within(screen.getByTestId("title-bar")).getByRole(
      "button",
      { name: "Back" }
    )

    fireEvent.click(titleBack)
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")
    expect(router.back).not.toHaveBeenCalled()

    fireEvent.click(titleBack)
    expect(router.back).toHaveBeenCalledTimes(1)
  })

  it("宽屏保持左右分栏", async () => {
    state.mobile = false
    renderPage()
    await act(async () => {})
    expect(document.querySelector("[data-panel-group]")).not.toBeNull()
    expect(
      document.querySelector("[data-panel-resize-handle-id]")
    ).not.toHaveClass("hidden")
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
  })
})
