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

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkspaceFolderDialog open onOpenChange={() => {}} />
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
