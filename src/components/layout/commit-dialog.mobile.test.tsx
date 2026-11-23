import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { GitStatusEntry } from "@/lib/types"

// #1335：提交页在手机布局下不用左右分栏，先看文件列表（和提交说明），点文件
// 进详情（差异），详情里返回回到列表；标题栏的返回这时也先回到列表。打了一半
// 的提交说明来回切换不丢。宽屏照旧左右分栏。

const state = vi.hoisted(() => ({ mobile: true }))
vi.mock("@/hooks/use-mobile", () => ({ useIsMobile: () => state.mobile }))
vi.mock("@/lib/transport", () => ({ isDesktop: () => false }))

const api = vi.hoisted(() => ({
  gitStatus: vi.fn<(path: string) => Promise<GitStatusEntry[]>>(),
}))
vi.mock("@/lib/api", () => ({
  gitAddFiles: vi.fn(),
  gitCommit: vi.fn(),
  gitListRemotes: vi.fn(async () => []),
  gitPush: vi.fn(),
  gitRollbackFile: vi.fn(),
  gitShowFile: vi.fn(async () => ""),
  gitStatus: api.gitStatus,
  deleteFileTreeEntry: vi.fn(),
  readFilePreview: vi.fn(async () => ({ content: "" })),
}))
vi.mock("@/contexts/git-credential-context", () => ({
  useGitCredential: () => ({
    withCredentialRetry: (fn: (creds: null) => Promise<unknown>) => fn(null),
  }),
}))
vi.mock("@/components/diff/diff-viewer", () => ({
  DiffViewer: () => <div data-testid="text-diff" />,
}))
vi.mock("@/components/layout/commit-message-generate-button", () => ({
  CommitMessageGenerateButton: () => null,
}))
vi.mock("@/components/layout/commit-message-settings-dialog", () => ({
  CommitMessageSettingsDialog: () => null,
}))
vi.mock("@/hooks/use-commit-message-generation", () => ({
  sameFiles: () => true,
  useCommitMessageGeneration: () => ({
    generating: false,
    elapsedSeconds: 0,
    stop: () => {},
    generate: async () => null,
    settingsOpen: false,
    setSettingsOpen: () => {},
  }),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))

import enMessages from "@/i18n/messages/en.json"
import { setInPageRouter } from "@/lib/in-page-navigation"
import { CommitWorkspace } from "./commit-dialog"
import { MobileBackButton } from "./mobile-back-button"

const router = { push: vi.fn(), back: vi.fn() }
let unregister: () => void = () => {}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div data-testid="title-bar">
        <MobileBackButton />
      </div>
      <CommitWorkspace folderPath="/repo" folderId={1} />
    </NextIntlClientProvider>
  )
}

function pane(kind: "list" | "detail"): HTMLElement {
  const el = document.querySelector(`[data-list-detail-pane="${kind}"]`)
  if (!el) throw new Error(`no ${kind} pane`)
  return el as HTMLElement
}

function tapFile(path: string) {
  const row = document.querySelector(`[data-tree-row-path="${path}"]`)
  if (!row) throw new Error(`no file row for ${path}`)
  fireEvent.click(row)
}

beforeEach(() => {
  state.mobile = true
  router.push.mockReset()
  router.back.mockReset()
  vi.spyOn(window.history, "length", "get").mockReturnValue(3)
  unregister = setInPageRouter(router)
  api.gitStatus.mockResolvedValue([
    { status: "M", file: "notes.txt" },
    { status: "M", file: "other.txt" },
  ])
})

afterEach(() => {
  unregister()
  vi.restoreAllMocks()
})

describe("CommitWorkspace 手机布局（#1335）", () => {
  it("先显示文件列表（第一个文件的差异已经载入也不跳过去），点文件进详情，返回回到列表", async () => {
    renderPage()
    await act(async () => {})
    // 手机上仍是同一个分栏（宽度来回切换不卸掉里面的东西），只是拖动条藏起来
    expect(document.querySelector("[data-panel-resize-handle-id]")).toHaveClass(
      "hidden"
    )
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")
    expect(
      within(pane("list")).getByPlaceholderText("Enter commit message...")
    ).toBeInTheDocument()

    // 点的是自动载入差异的那个文件：也要进详情
    tapFile("notes.txt")
    await act(async () => {})
    expect(pane("list")).toHaveClass("hidden")
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(within(pane("detail")).getByTestId("text-diff")).toBeInTheDocument()
    expect(within(pane("detail")).getByText("notes.txt")).toBeInTheDocument()

    fireEvent.click(
      within(pane("detail")).getByRole("button", { name: "Back" })
    )
    expect(pane("list")).not.toHaveClass("hidden")
    expect(pane("detail")).toHaveClass("hidden")

    tapFile("other.txt")
    await act(async () => {})
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(within(pane("detail")).getByText("other.txt")).toBeInTheDocument()
    expect(router.back).not.toHaveBeenCalled()

    // 点文件名（文件名是单独的按钮，不走整行的选择）也进详情
    fireEvent.click(
      within(pane("detail")).getByRole("button", { name: "Back" })
    )
    fireEvent.click(
      within(pane("list")).getByRole("button", { name: "notes.txt" })
    )
    await act(async () => {})
    expect(pane("detail")).not.toHaveClass("hidden")
    expect(within(pane("detail")).getByText("notes.txt")).toBeInTheDocument()
  })

  it("打了一半的提交说明进出详情不丢；标题栏返回在详情里回到列表，在列表里离开", async () => {
    renderPage()
    await act(async () => {})
    fireEvent.change(screen.getByPlaceholderText("Enter commit message..."), {
      target: { value: "half typed" },
    })

    tapFile("other.txt")
    await act(async () => {})
    const titleBack = within(screen.getByTestId("title-bar")).getByRole(
      "button",
      { name: "Back" }
    )
    fireEvent.click(titleBack)
    expect(pane("list")).not.toHaveClass("hidden")
    expect(router.back).not.toHaveBeenCalled()
    expect(screen.getByPlaceholderText("Enter commit message...")).toHaveValue(
      "half typed"
    )

    fireEvent.click(titleBack)
    expect(router.back).toHaveBeenCalledTimes(1)
  })

  it("窗口宽度跨过手机布局的临界值，打了一半的提交说明还在输入框里", async () => {
    const view = renderPage()
    await act(async () => {})
    const box = screen.getByPlaceholderText("Enter commit message...")
    fireEvent.change(box, { target: { value: "half typed" } })

    const rerender = () =>
      view.rerender(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <div data-testid="title-bar">
            <MobileBackButton />
          </div>
          <CommitWorkspace folderPath="/repo" folderId={1} />
        </NextIntlClientProvider>
      )

    // 手机 → 宽屏 → 手机：输入框不被卸掉重挂，说明一直显示着
    state.mobile = false
    rerender()
    await act(async () => {})
    expect(screen.getByPlaceholderText("Enter commit message...")).toBe(box)
    expect(box).toHaveValue("half typed")

    state.mobile = true
    rerender()
    await act(async () => {})
    expect(screen.getByPlaceholderText("Enter commit message...")).toBe(box)
    expect(box).toHaveValue("half typed")
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
