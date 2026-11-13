import { act, fireEvent, render } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import { GettingStartedCard } from "./getting-started-card"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import type { FolderDetail } from "@/lib/types"

const env = vi.hoisted(() => ({
  cowork: true,
  projectsRoot: "/home/bob/projects" as string | null,
  dialog: [] as boolean[],
}))

vi.mock("@/lib/cowork/brand", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/brand")>()
  return {
    ...actual,
    get COWORK_BUILD() {
      return env.cowork
    },
  }
})
vi.mock("@/lib/cowork/info", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/cowork/info")>()),
  useCoworkInfo: () =>
    env.projectsRoot ? { projectsRoot: env.projectsRoot } : null,
}))
vi.mock("@/components/layout/workspace-folder-dialog", () => ({
  WorkspaceFolderDialog: ({ open }: { open: boolean }) => {
    env.dialog.push(open)
    return open ? <div data-testid="folder-dialog" /> : null
  },
}))
vi.mock("@/hooks/use-is-mac", () => ({ useIsMac: () => false }))

function folder(id: number): FolderDetail {
  return { id, name: `p${id}`, path: `/p/${id}` } as unknown as FolderDetail
}

function renderCard(locale: "en" | "zh-CN" = "zh-CN") {
  return render(
    <NextIntlClientProvider locale={locale} messages={{}}>
      <GettingStartedCard />
    </NextIntlClientProvider>
  )
}

describe("GettingStartedCard (AI QA #93)", () => {
  beforeEach(() => {
    resetAppWorkspaceStore()
    useAppWorkspaceStore.setState({ folders: [], foldersHydrated: true })
    env.cowork = true
    env.projectsRoot = "/home/bob/projects"
    env.dialog = []
  })

  it("shows the three first steps while there is no project", () => {
    const view = renderCard()
    const card = view.getByTestId("cowork-getting-started")
    const steps = card.querySelectorAll("li")
    expect(steps).toHaveLength(3)
    expect(steps[0].textContent).toContain("新建或打开一个项目")
    expect(steps[0].textContent).toContain("/home/bob/projects")
    expect(steps[1].textContent).toContain("选一个 agent")
    expect(steps[2].textContent).toContain("发出第一条消息")
    // The send key comes from the shortcut settings (Enter by default).
    expect(steps[2].textContent).toContain("Enter")
  })

  it("opens the new / open project dialog from the first step", () => {
    const view = renderCard()
    expect(view.queryByTestId("folder-dialog")).toBeNull()
    fireEvent.click(view.getByRole("button", { name: "新建或打开项目" }))
    expect(view.getByTestId("folder-dialog")).not.toBeNull()
  })

  it("says to open a folder when the server has no projects root", () => {
    env.projectsRoot = null
    const view = renderCard("en")
    expect(view.getByTestId("cowork-getting-started").textContent).toContain(
      "A project is a folder"
    )
  })

  it("goes away once the first project is open, keeping an open dialog", () => {
    const view = renderCard()
    fireEvent.click(view.getByRole("button", { name: "新建或打开项目" }))
    act(() => useAppWorkspaceStore.setState({ folders: [folder(1)] }))
    expect(view.queryByTestId("cowork-getting-started")).toBeNull()
    // The dialog is still on its second page; its "Done" lands the user in
    // the new project, so it must not unmount with the steps.
    expect(view.getByTestId("folder-dialog")).not.toBeNull()
  })

  it("renders nothing with a project, before folders load, or outside Cowork", () => {
    useAppWorkspaceStore.setState({ folders: [folder(1)] })
    expect(renderCard().container.innerHTML).toBe("")

    useAppWorkspaceStore.setState({ folders: [], foldersHydrated: false })
    expect(renderCard().container.innerHTML).toBe("")

    useAppWorkspaceStore.setState({ foldersHydrated: true })
    env.cowork = false
    expect(renderCard().container.innerHTML).toBe("")
  })
})
