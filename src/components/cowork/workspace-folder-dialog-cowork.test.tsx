import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { CoworkInfo } from "@/lib/cowork/info"
import type { FolderDetail } from "@/lib/types"
import { WorkspaceFolderDialog } from "@/components/layout/workspace-folder-dialog"

const api = vi.hoisted(() => ({
  getHomeDirectory: vi.fn(),
  listDirectoryEntries: vi.fn(),
  createDirectory: vi.fn(),
  listFolderLinks: vi.fn(),
  previewFolderLinks: vi.fn(),
  createFolderLinks: vi.fn(),
  renameFolderLink: vi.fn(),
  repairFolderLink: vi.fn(),
  removeFolderLink: vi.fn(),
}))
vi.mock("@/lib/api", () => api)
vi.mock("@/lib/platform", () => ({
  isDesktop: () => false,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => null,
}))

const openFolder = vi.hoisted(() => vi.fn())
vi.mock("@/stores/app-workspace-store", () => ({
  useAppWorkspaceStore: (selector: (state: unknown) => unknown) =>
    selector({ openFolder }),
}))
const openNewConversationTab = vi.hoisted(() => vi.fn())
vi.mock("@/stores/tab-store", () => ({
  useTabStore: (selector: (state: unknown) => unknown) =>
    selector({ openNewConversationTab }),
}))
vi.mock("sonner", () => ({
  toast: { error: vi.fn(), warning: vi.fn(), success: vi.fn() },
}))

const cowork = vi.hoisted(() => ({
  info: null as CoworkInfo | null,
  coworkCreateProject: vi.fn(),
}))
vi.mock("@/lib/cowork/info", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/info")>()
  return {
    ...actual,
    useCoworkInfo: () => cowork.info,
    coworkCreateProject: cowork.coworkCreateProject,
  }
})

const ROOT = "/home/cw-a/work"

const folder = (overrides: Partial<FolderDetail> = {}): FolderDetail => ({
  id: 9,
  name: "demo",
  path: `${ROOT}/demo`,
  git_branch: null,
  default_agent_type: null,
  last_opened_at: "2026-10-16T00:00:00Z",
  sort_order: 1,
  color: "inherit",
  parent_id: null,
  kind: "regular",
  alias: null,
  group_id: null,
  ...overrides,
})

function renderDialog(onOpenChange: (open: boolean) => void = () => {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkspaceFolderDialog open onOpenChange={onOpenChange} />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  cowork.info = null
  api.getHomeDirectory.mockResolvedValue("/home/cw-a")
  api.listDirectoryEntries.mockResolvedValue([])
  api.listFolderLinks.mockResolvedValue([])
  openFolder.mockResolvedValue(folder())
  cowork.coworkCreateProject.mockResolvedValue(folder())
})

describe("WorkspaceFolderDialog in Cowork mode", () => {
  it("keeps the upstream flow without Cowork info", async () => {
    renderDialog()
    await waitFor(() =>
      expect(api.listDirectoryEntries).toHaveBeenCalledWith("/home/cw-a")
    )
    expect(screen.queryByTestId("cowork-new-project")).toBeNull()
  })

  it("starts browsing at the projects root", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    renderDialog()
    await waitFor(() =>
      expect(api.listDirectoryEntries).toHaveBeenCalledWith(ROOT)
    )
    expect(api.getHomeDirectory).not.toHaveBeenCalled()
    expect(screen.getByTestId("cowork-new-project")).toBeInTheDocument()
  })

  it("creates a project by name and opens it", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    renderDialog()
    const input = screen.getByRole("textbox", { name: "Project name" })
    await userEvent.type(input, "demo")
    await userEvent.click(screen.getByRole("button", { name: "Create" }))
    await waitFor(() =>
      expect(cowork.coworkCreateProject).toHaveBeenCalledWith("demo")
    )
    await waitFor(() => expect(openFolder).toHaveBeenCalledWith(`${ROOT}/demo`))
    // Moves on to the links step like any opened root.
    await waitFor(() =>
      expect(screen.queryByTestId("cowork-new-project")).toBeNull()
    )
    // Not before the dialog is done with.
    expect(openNewConversationTab).not.toHaveBeenCalled()
  })

  it("switches to the created project when the dialog is closed with Done", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)
    await userEvent.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "demo"
    )
    await userEvent.click(screen.getByRole("button", { name: "Create" }))
    await userEvent.click(await screen.findByRole("button", { name: "Done" }))
    expect(openNewConversationTab).toHaveBeenCalledTimes(1)
    expect(openNewConversationTab).toHaveBeenCalledWith(9, `${ROOT}/demo`)
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  // AI QA #177: opening an existing folder lands in it too, like a new project.
  it("switches to an existing folder opened from the list on Done", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    api.listDirectoryEntries.mockResolvedValue([
      { name: "demo", path: `${ROOT}/demo`, hasChildren: false },
    ])
    const onOpenChange = vi.fn()
    renderDialog(onOpenChange)
    await userEvent.click(await screen.findByRole("button", { name: "demo" }))
    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    await waitFor(() => expect(openFolder).toHaveBeenCalledWith(`${ROOT}/demo`))
    // Not before the dialog is done with: step 2 still links folders.
    expect(openNewConversationTab).not.toHaveBeenCalled()
    await userEvent.click(await screen.findByRole("button", { name: "Done" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(cowork.coworkCreateProject).not.toHaveBeenCalled()
    expect(openNewConversationTab).toHaveBeenCalledTimes(1)
    expect(openNewConversationTab).toHaveBeenCalledWith(9, `${ROOT}/demo`)
  })

  it("switches the same way outside Cowork", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      { name: "demo", path: `${ROOT}/demo`, hasChildren: false },
    ])
    renderDialog()
    await userEvent.click(await screen.findByRole("button", { name: "demo" }))
    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    await userEvent.click(await screen.findByRole("button", { name: "Done" }))
    expect(openNewConversationTab).toHaveBeenCalledTimes(1)
    expect(openNewConversationTab).toHaveBeenCalledWith(9, `${ROOT}/demo`)
  })

  it("moves nothing when the dialog only managed a folder's links", async () => {
    const onOpenChange = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WorkspaceFolderDialog
          open
          onOpenChange={onOpenChange}
          folder={folder()}
        />
      </NextIntlClientProvider>
    )
    await userEvent.click(await screen.findByRole("button", { name: "Done" }))
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(openFolder).not.toHaveBeenCalled()
    expect(openNewConversationTab).not.toHaveBeenCalled()
  })

  it("does not switch when the dialog is closed without Done", async () => {
    api.listDirectoryEntries.mockResolvedValue([
      { name: "demo", path: `${ROOT}/demo`, hasChildren: false },
    ])
    const view = renderDialog()
    await userEvent.click(await screen.findByRole("button", { name: "demo" }))
    await userEvent.click(screen.getByRole("button", { name: "Next" }))
    await screen.findByRole("button", { name: "Done" })
    // Closed some other way (Esc, the corner ×): only "Done" switches.
    view.rerender(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <WorkspaceFolderDialog open={false} onOpenChange={() => {}} />
      </NextIntlClientProvider>
    )
    expect(openNewConversationTab).not.toHaveBeenCalled()
  })

  it("says so when the name is taken, and opens nothing", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    // What the server answers with 409 (see `prepare_project_dir`).
    cowork.coworkCreateProject.mockRejectedValue({
      code: "already_exists",
      message: 'A project named "demo" already exists',
      i18n_key: "cowork.projectExists",
      i18n_params: { name: "demo" },
    })
    renderDialog()
    await userEvent.type(
      screen.getByRole("textbox", { name: "Project name" }),
      " demo "
    )
    await userEvent.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      'There is already a project named demo. Pick another name; to open the existing one, select it in the list below and click "Next".'
    )
    expect(openFolder).not.toHaveBeenCalled()
    expect(openNewConversationTab).not.toHaveBeenCalled()
    // Still on the first step, with the name kept for editing.
    expect(screen.getByTestId("cowork-new-project")).toBeInTheDocument()
    expect(screen.getByRole("textbox", { name: "Project name" })).toHaveValue(
      " demo "
    )
  })

  it("keeps the server's own words for any other failure", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    cowork.coworkCreateProject.mockRejectedValue({
      code: "already_exists",
      message: `${ROOT}/afile already exists and is not a directory`,
    })
    renderDialog()
    await userEvent.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "afile"
    )
    await userEvent.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      `Couldn't create the project: ${ROOT}/afile already exists and is not a directory`
    )
    expect(openFolder).not.toHaveBeenCalled()
  })

  it("rejects names with separators without calling the server", async () => {
    cowork.info = {
      product: "Cowork",
      projectsRoot: ROOT,
      portal: true,
      updateDisabled: true,
    }
    renderDialog()
    await userEvent.type(
      screen.getByRole("textbox", { name: "Project name" }),
      "a/b"
    )
    await userEvent.click(screen.getByRole("button", { name: "Create" }))
    expect(await screen.findByRole("alert")).toHaveTextContent("can't contain")
    expect(cowork.coworkCreateProject).not.toHaveBeenCalled()
  })
})
