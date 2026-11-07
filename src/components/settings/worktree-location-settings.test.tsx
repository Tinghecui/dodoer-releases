import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"
import enMessages from "@/i18n/messages/en.json"
import type { WorkTaskFolderSettings } from "@/lib/types"

const getMock = vi.fn()
const getOwnMock = vi.fn()
const setMock = vi.fn().mockResolvedValue(undefined)
const foldersMock = vi.fn()

vi.mock("@/lib/api", () => ({
  listOpenFolderDetails: (...args: unknown[]) => foldersMock(...args),
  workTaskSettingsGet: (...args: unknown[]) => getMock(...args),
  workTaskSettingsGetOwn: (...args: unknown[]) => getOwnMock(...args),
  workTaskSettingsSet: (...args: unknown[]) => setMock(...args),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))
// The searchable popover picker is not under test; a plain select stands in
// with the same contract (folder id, or the pinned "all folders" entry).
vi.mock("@/components/shared/folder-select", () => ({
  FolderSelect: ({
    folders,
    value,
    onChange,
    onSelectAll,
    allLabel,
    title,
  }: {
    folders: { id: number; name: string }[]
    value: number | null
    onChange: (id: number) => void
    onSelectAll: () => void
    allLabel: string
    title: string
  }) => (
    <select
      aria-label={title}
      value={value ?? ""}
      onChange={(e) =>
        e.target.value === "" ? onSelectAll() : onChange(Number(e.target.value))
      }
    >
      <option value="">{allLabel}</option>
      {folders.map((f) => (
        <option key={f.id} value={f.id}>
          {f.name}
        </option>
      ))}
    </select>
  ),
}))

import { WorktreeLocationSettings } from "./worktree-location-settings"

function settings(
  overrides?: Partial<WorkTaskFolderSettings>
): WorkTaskFolderSettings {
  return {
    default_agent_type: null,
    mode_id: null,
    config_values: {},
    auto_process: false,
    max_concurrent: 2,
    merge_strategy: "squash",
    auto_merge: false,
    delete_worktree_default: true,
    auto_compact_percent: 0,
    ...overrides,
  }
}

function renderSection() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorktreeLocationSettings />
    </NextIntlClientProvider>
  )
}

async function box() {
  const input = await screen.findByRole("textbox", {
    name: "Worktree location",
  })
  await waitFor(() => expect(input).toBeEnabled())
  return input
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue(settings({ init_command: "pnpm i" }))
  getOwnMock.mockReset().mockResolvedValue(null)
  setMock.mockClear()
  foldersMock.mockReset().mockResolvedValue([
    { id: 1, name: "proj", parent_id: null, kind: "regular", path: "/p" },
    { id: 2, name: "proj-wt", parent_id: 1, kind: "regular", path: "/w" },
  ])
})

describe("WorktreeLocationSettings", () => {
  it("edits the global row's worktree_root and keeps the rest of it", async () => {
    getMock.mockResolvedValue(
      settings({ init_command: "pnpm i", worktree_root: "~/trees" })
    )
    const user = userEvent.setup()
    renderSection()
    const input = await box()
    expect(input).toHaveValue("~/trees")

    await user.clear(input)
    await user.type(input, "  /srv/trees  ")
    await user.click(screen.getByRole("button", { name: "Save" }))

    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [scope, saved] = setMock.mock.calls[0] as [
      number,
      WorkTaskFolderSettings,
    ]
    expect(scope).toBe(0)
    expect(saved.worktree_root).toBe("/srv/trees")
    // Only the location changes; the task settings ride along untouched.
    expect(saved.init_command).toBe("pnpm i")
  })

  it("stores a cleared box as null — the default layout", async () => {
    getMock.mockResolvedValue(settings({ worktree_root: "~/trees" }))
    const user = userEvent.setup()
    renderSection()
    await user.clear(await box())
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [, saved] = setMock.mock.calls[0] as [number, WorkTaskFolderSettings]
    expect(saved.worktree_root).toBeNull()
  })

  it("lists only project roots, and edits a project's own row", async () => {
    getOwnMock.mockImplementation(async (id: number) =>
      id === 1 ? settings({ worktree_root: "/own", auto_merge: true }) : null
    )
    const user = userEvent.setup()
    renderSection()
    await box()

    const scope = screen.getByRole("combobox", { name: "Scope" })
    expect(
      screen.queryByRole("option", { name: "proj-wt" })
    ).not.toBeInTheDocument()
    await user.selectOptions(scope, "1")
    await waitFor(async () => expect(await box()).toHaveValue("/own"))
    expect(
      screen.queryByText(/follows the global task settings/)
    ).not.toBeInTheDocument()

    const input = await box()
    await user.clear(input)
    await user.type(input, "/elsewhere")
    await user.click(screen.getByRole("button", { name: "Save" }))
    await waitFor(() => expect(setMock).toHaveBeenCalled())
    const [id, saved] = setMock.mock.calls[0] as [
      number,
      WorkTaskFolderSettings,
    ]
    expect(id).toBe(1)
    expect(saved.worktree_root).toBe("/elsewhere")
    expect(saved.auto_merge).toBe(true)
  })

  it("says so when a project follows the global defaults, and seeds from them", async () => {
    getMock.mockResolvedValue(settings({ worktree_root: "~/global" }))
    const user = userEvent.setup()
    renderSection()
    await box()
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Scope" }),
      "1"
    )
    await waitFor(() =>
      expect(
        screen.getByText(/follows the global task settings/)
      ).toBeInTheDocument()
    )
    expect(await box()).toHaveValue("~/global")
  })

  it("keeps Save disabled until the value changes", async () => {
    renderSection()
    await box()
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled()
  })
})
