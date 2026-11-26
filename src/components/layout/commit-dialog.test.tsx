import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitRemote, GitStatusEntry } from "@/lib/types"

const api = vi.hoisted(() => ({
  gitStatus: vi.fn<(path: string) => Promise<GitStatusEntry[]>>(),
  gitCommit: vi.fn(async () => ({ committed_files: 1 })),
  gitPush: vi.fn(async () => {}),
  gitListRemotes: vi.fn<(path: string) => Promise<GitRemote[]>>(),
  readFilePreview: vi.fn<
    (path: string, file: string) => Promise<{ content: string }>
  >(async () => ({ content: "" })),
  gitShowFile: vi.fn<(path: string, file: string) => Promise<string>>(
    async () => ""
  ),
  gitRollbackFile: vi.fn<(path: string, file: string) => Promise<void>>(
    async () => {}
  ),
  openSettingsWindow: vi.fn(async () => {}),
}))

vi.mock("@/lib/api", () => ({
  gitAddFiles: vi.fn(),
  gitCommit: api.gitCommit,
  gitListRemotes: api.gitListRemotes,
  gitPush: api.gitPush,
  gitRollbackFile: api.gitRollbackFile,
  gitShowFile: api.gitShowFile,
  gitStatus: api.gitStatus,
  deleteFileTreeEntry: vi.fn(),
  readFilePreview: api.readFilePreview,
  openSettingsWindow: api.openSettingsWindow,
}))
vi.mock("@/contexts/git-credential-context", () => ({
  useGitCredential: () => ({
    withCredentialRetry: (fn: (creds: null) => Promise<unknown>) => fn(null),
  }),
}))
vi.mock("@/components/diff/diff-viewer", () => ({ DiffViewer: () => null }))
// 图片预览走 image-diff，单独 mock 掉，好断言它收到的新旧两个名字（#527）。
const imageDiff = vi.hoisted(() => ({
  loadImageDiffSides: vi.fn(async () => ({
    original: { kind: "absent" as const },
    modified: { kind: "absent" as const },
  })),
}))
vi.mock("@/lib/image-diff", () => imageDiff)
vi.mock("@/components/diff/image-diff-view", () => ({
  ImageDiffView: () => null,
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
const toast = vi.hoisted(() => ({
  success: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}))
vi.mock("sonner", () => ({ toast }))

import { CommitWorkspace } from "./commit-dialog"
import enMessages from "@/i18n/messages/en.json"

beforeEach(() => {
  api.gitStatus.mockReset()
  api.gitCommit.mockClear()
  api.gitPush.mockClear()
  api.gitListRemotes.mockReset()
  api.readFilePreview.mockClear()
  api.gitShowFile.mockClear()
  api.gitRollbackFile.mockClear()
  api.openSettingsWindow.mockClear()
  imageDiff.loadImageDiffSides.mockClear()
  toast.warning.mockClear()
  toast.error.mockClear()
})

describe("CommitWorkspace after a commit", () => {
  it("re-reads the status and drops the committed files and message", async () => {
    // Before the commit: one changed file; after it: a clean tree.
    api.gitStatus
      .mockResolvedValueOnce([{ status: "M", file: "notes.md" }])
      .mockResolvedValue([])
    const onCommitted = vi.fn()

    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          onCommitted={onCommitted}
        />
      </NextIntlClientProvider>
    )

    const commit = await screen.findByRole("button", { name: "Commit (1)" })
    const box = screen.getByPlaceholderText("Enter commit message...")
    fireEvent.change(box, { target: { value: "notes" } })
    expect(commit).toBeEnabled()

    fireEvent.click(commit)

    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1))
    expect(api.gitCommit).toHaveBeenCalledWith(
      "/repo",
      "notes",
      ["notes.md"],
      1
    )
    // A window that stays open (a browser tab that won't close) shows the tree
    // as it is now: nothing left to commit, the button off, the box empty.
    expect(api.gitStatus).toHaveBeenCalledTimes(2)
    const after = await screen.findByRole("button", { name: "Commit (0)" })
    expect(after).toBeDisabled()
    expect(screen.getByPlaceholderText("Enter commit message...")).toHaveValue(
      ""
    )
  })
})

// #1419：服务器上没配 Git 姓名和邮箱时提交。
describe("CommitWorkspace without a git identity", () => {
  const GIT_STDERR =
    "Author identity unknown\n\n*** Please tell me who you are.\n\nfatal: empty ident name (for <>) not allowed"

  async function commitAndFail(error: unknown) {
    api.gitStatus.mockResolvedValue([{ status: "M", file: "notes.md" }])
    api.gitCommit.mockRejectedValueOnce(error)
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace folderPath="/repo" folderId={1} />
      </NextIntlClientProvider>
    )
    const commit = await screen.findByRole("button", { name: "Commit (1)" })
    fireEvent.change(screen.getByPlaceholderText("Enter commit message..."), {
      target: { value: "notes" },
    })
    fireEvent.click(commit)
  }

  it("says the name and email are missing and offers the settings page", async () => {
    await commitAndFail({
      code: "configuration_missing",
      message: "git identity is not configured",
      detail: GIT_STDERR,
      i18n_key: "errors.gitIdentityMissing",
    })

    expect(
      await screen.findByText(
        enMessages.Folder.commitDialog.errors.gitIdentityMissing
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/Please tell me who you are/)).toBeNull()

    fireEvent.click(screen.getByRole("button", { name: "Open settings" }))
    expect(api.openSettingsWindow).toHaveBeenCalledWith("version-control")
  })

  it("shows other commit failures as before, without the settings button", async () => {
    await commitAndFail({
      code: "external_command_failed",
      message: "git commit failed",
      detail: "refused by a hook",
    })

    expect(await screen.findByText("refused by a hook")).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull()
  })
})

// #202: "Commit and Push" in a repository without a remote.
describe("CommitWorkspace commit and push", () => {
  const NO_REMOTE =
    "Committed, but no Git remote is configured, so nothing was pushed. Add a remote in Manage Remotes"

  async function commitAndPush(onCommitted: () => void) {
    api.gitStatus
      .mockResolvedValueOnce([{ status: "M", file: "notes.md" }])
      .mockResolvedValue([])
    const user = userEvent.setup()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          onCommitted={onCommitted}
        />
      </NextIntlClientProvider>
    )
    await screen.findByRole("button", { name: "Commit (1)" })
    fireEvent.change(screen.getByPlaceholderText("Enter commit message..."), {
      target: { value: "notes" },
    })
    // The arrow beside Commit has a name of its own. Opened from the
    // keyboard: Radix's pointer path does not fire in jsdom here.
    const more = screen.getByRole("button", { name: "More commit options" })
    expect(more).toBeEnabled()
    more.focus()
    await user.keyboard("{Enter}")
    await user.click(
      await screen.findByRole("menuitem", { name: "Commit and Push (1)" })
    )
  }

  it("commits, skips the push and says so in the window when there is no remote", async () => {
    api.gitListRemotes.mockResolvedValue([])
    const onCommitted = vi.fn()

    await commitAndPush(onCommitted)

    expect(await screen.findByText(NO_REMOTE)).toBeInTheDocument()
    expect(api.gitCommit).toHaveBeenCalledWith(
      "/repo",
      "notes",
      ["notes.md"],
      1
    )
    expect(api.gitListRemotes).toHaveBeenCalledWith("/repo")
    expect(api.gitPush).not.toHaveBeenCalled()
    expect(toast.warning).toHaveBeenCalledWith(NO_REMOTE)
    // The window stays open, with the notice in it.
    expect(onCommitted).not.toHaveBeenCalled()
    // Still there once the status re-read after the commit has landed.
    await waitFor(() => expect(api.gitStatus).toHaveBeenCalledTimes(2))
    expect(screen.getByText(NO_REMOTE)).toBeInTheDocument()
  })

  it("pushes and closes as before when there is a remote", async () => {
    api.gitListRemotes.mockResolvedValue([
      { name: "origin", url: "https://example.com/repo.git" },
    ])
    const onCommitted = vi.fn()

    await commitAndPush(onCommitted)

    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1))
    expect(api.gitPush).toHaveBeenCalledWith("/repo", null, null, 1)
    expect(toast.warning).not.toHaveBeenCalled()
    expect(screen.queryByText(NO_REMOTE)).toBeNull()
  })

  it("still tries the push when the remotes cannot be read", async () => {
    api.gitListRemotes.mockRejectedValue(new Error("boom"))
    const onCommitted = vi.fn()

    await commitAndPush(onCommitted)

    await waitFor(() => expect(onCommitted).toHaveBeenCalledTimes(1))
    expect(api.gitPush).toHaveBeenCalledTimes(1)
    expect(toast.warning).not.toHaveBeenCalled()
  })
})

// #427: right-clicking one file and choosing "Commit" opens the window with
// just that file ticked and previewed, not every tracked change.
describe("CommitWorkspace opened for some paths", () => {
  const STATUS: GitStatusEntry[] = [
    { status: "M", file: "docs/notes.md" },
    { status: "M", file: "README.md" },
    { status: "??", file: "draft.txt" },
    { status: "??", file: "src/new.ts" },
  ]

  function renderWorkspace(initialPaths?: string[]) {
    api.gitStatus.mockResolvedValue(STATUS)
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={initialPaths}
        />
      </NextIntlClientProvider>
    )
  }

  function lastPreviewedFile() {
    const calls = api.readFilePreview.mock.calls
    return calls[calls.length - 1]?.[1]
  }

  it("ticks and previews only the tracked file it was opened for", async () => {
    renderWorkspace(["README.md"])

    await screen.findByRole("button", { name: "Commit (1)" })
    await waitFor(() => expect(lastPreviewedFile()).toBe("README.md"))
  })

  it("ticks an untracked file it was opened for", async () => {
    renderWorkspace(["draft.txt"])

    await screen.findByRole("button", { name: "Commit (1)" })
    await waitFor(() => expect(lastPreviewedFile()).toBe("draft.txt"))
    // The untracked group is open, so the ticked file is in sight.
    expect(screen.getByText("draft.txt")).toBeInTheDocument()
  })

  it("ticks every change under a directory it was opened for", async () => {
    renderWorkspace(["src"])

    await screen.findByRole("button", { name: "Commit (1)" })
    await waitFor(() => expect(lastPreviewedFile()).toBe("src/new.ts"))
  })

  // #442: right-clicking a file that has no changes must not tick (and offer
  // to commit) some other file instead.
  it("ticks and previews nothing when none of the paths changed", async () => {
    renderWorkspace(["gone.md"])

    expect(
      await screen.findByText("gone.md has no changes")
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Commit (0)" })).toBeDisabled()
    expect(screen.getByText("0 / 4 files")).toBeInTheDocument()
    expect(api.readFilePreview).not.toHaveBeenCalled()
  })

  it("names only the paths that matched nothing", async () => {
    renderWorkspace(["README.md", "gone.md", "old/a.md"])

    await screen.findByRole("button", { name: "Commit (1)" })
    expect(
      screen.getByText("gone.md, old/a.md have no changes")
    ).toBeInTheDocument()
  })

  it("ticks nothing when the paths in the link were unreadable", async () => {
    renderWorkspace([])

    expect(
      await screen.findByText(
        "The files in this link could not be read, so nothing was selected"
      )
    ).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Commit (0)" })).toBeDisabled()
    expect(api.readFilePreview).not.toHaveBeenCalled()
  })

  it("ticks every tracked change when opened without paths", async () => {
    renderWorkspace()

    await screen.findByRole("button", { name: "Commit (2)" })
    await waitFor(() => expect(lastPreviewedFile()).toBe("docs/notes.md"))
    expect(screen.queryByText(/have no changes|has no changes/)).toBeNull()
  })
})

// #528: a directory travels as itself (not every file under it), and the
// untracked group's root as a scope flag, so the address stays short.
describe("CommitWorkspace opened for a directory or a scope", () => {
  const STATUS: GitStatusEntry[] = [
    { status: "M", file: "docs/a.md" },
    { status: "M", file: "docs/b.md" },
    { status: "??", file: "docs/c.md" },
    { status: "M", file: "README.md" },
    { status: "??", file: "notes.txt" },
  ]

  function renderWorkspace(
    initialPaths: string[] | null,
    initialScope: "tracked" | "untracked" | null,
    status: GitStatusEntry[] = STATUS
  ) {
    api.gitStatus.mockResolvedValue(status)
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={initialPaths}
          initialScope={initialScope}
        />
      </NextIntlClientProvider>
    )
  }

  it("ticks every change under the directory, tracked and untracked", async () => {
    renderWorkspace(["docs"], null)

    await screen.findByRole("button", { name: "Commit (3)" })
    expect(screen.getByText("3 / 5 files")).toBeInTheDocument()
  })

  it("ticks only the tracked changes under a tracked-group directory", async () => {
    renderWorkspace(["docs/"], "tracked")

    await screen.findByRole("button", { name: "Commit (2)" })
    expect(screen.queryByText(/have no changes|has no changes/)).toBeNull()
  })

  it("ticks only the untracked files under an untracked-group directory", async () => {
    renderWorkspace(["docs"], "untracked")

    await screen.findByRole("button", { name: "Commit (1)" })
    // The untracked group opens so the ticked file is in sight.
    expect(screen.getByText("c.md")).toBeInTheDocument()
  })

  it("ticks every untracked file and nothing else for the untracked scope", async () => {
    renderWorkspace(null, "untracked")

    await screen.findByRole("button", { name: "Commit (2)" })
    expect(screen.getByText("2 / 5 files")).toBeInTheDocument()
    expect(screen.queryByText(/have no changes|has no changes/)).toBeNull()
  })

  it("ticks hundreds of new files under one directory", async () => {
    const many: GitStatusEntry[] = Array.from({ length: 200 }, (_, i) => ({
      status: "??",
      file: `gen/out-${i}.json`,
    }))
    renderWorkspace(["gen"], "untracked", [
      ...many,
      { status: "M", file: "README.md" },
    ])

    await screen.findByRole("button", { name: "Commit (200)" })
  })
})

// #527: git reports a staged rename as one "old -> new" line. The window lists,
// ticks and commits the new name, and previews the old side under the old name.
describe("CommitWorkspace with a renamed file", () => {
  const STATUS: GitStatusEntry[] = [
    { status: "R", file: "docs/old name.md -> docs/新 name.md" },
    { status: "M", file: "notes.md" },
  ]

  function renderWorkspace(initialPaths?: string[]) {
    api.gitStatus.mockResolvedValueOnce(STATUS).mockResolvedValue([])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={initialPaths}
        />
      </NextIntlClientProvider>
    )
  }

  it("ticks the renamed file it was opened for by its new name", async () => {
    renderWorkspace(["docs/新 name.md"])

    await screen.findByRole("button", { name: "Commit (1)" })
    expect(screen.queryByText(/have no changes|has no changes/)).toBeNull()
    expect(screen.getByText("新 name.md")).toBeInTheDocument()
    expect(screen.queryByText(/ -> /)).toBeNull()
  })

  it("commits the new name, not the whole rename line", async () => {
    renderWorkspace(["docs/新 name.md"])

    const commit = await screen.findByRole("button", { name: "Commit (1)" })
    fireEvent.change(screen.getByPlaceholderText("Enter commit message..."), {
      target: { value: "rename" },
    })
    fireEvent.click(commit)

    await waitFor(() => expect(api.gitCommit).toHaveBeenCalledTimes(1))
    expect(api.gitCommit).toHaveBeenCalledWith(
      "/repo",
      "rename",
      ["docs/新 name.md"],
      1
    )
  })

  it("reads the old side under the old name and the new side under the new name", async () => {
    renderWorkspace(["docs/新 name.md"])

    await screen.findByRole("button", { name: "Commit (1)" })
    await waitFor(() =>
      expect(api.gitShowFile).toHaveBeenCalledWith("/repo", "docs/old name.md")
    )
    expect(api.readFilePreview).toHaveBeenCalledWith("/repo", "docs/新 name.md")
    expect(api.gitShowFile).not.toHaveBeenCalledWith("/repo", "docs/新 name.md")
  })

  it("ticks the renamed file by its new name when opened without paths", async () => {
    renderWorkspace()

    const commit = await screen.findByRole("button", { name: "Commit (2)" })
    fireEvent.change(screen.getByPlaceholderText("Enter commit message..."), {
      target: { value: "all" },
    })
    fireEvent.click(commit)

    await waitFor(() => expect(api.gitCommit).toHaveBeenCalledTimes(1))
    expect(api.gitCommit).toHaveBeenCalledWith(
      "/repo",
      "all",
      expect.arrayContaining(["docs/新 name.md", "notes.md"]),
      1
    )
    const calls = api.gitCommit.mock.calls as unknown as [
      string,
      string,
      string[],
      number,
    ][]
    expect(calls[0][2]).toHaveLength(2)
  })

  it("reads the old side of a renamed image under the old name", async () => {
    api.gitStatus
      .mockResolvedValueOnce([
        { status: "R", file: "img/old logo.png -> img/新 logo.png" },
      ])
      .mockResolvedValue([])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={["img/新 logo.png"]}
        />
      </NextIntlClientProvider>
    )

    await screen.findByRole("button", { name: "Commit (1)" })
    await waitFor(() =>
      expect(imageDiff.loadImageDiffSides).toHaveBeenCalledWith(
        "/repo",
        "img/新 logo.png",
        expect.objectContaining({ kind: "ref", ref: "HEAD" }),
        { kind: "worktree" },
        "img/old logo.png"
      )
    )
  })

  it("keeps a plain file whose name contains the separator whole", async () => {
    api.gitStatus
      .mockResolvedValueOnce([{ status: "M", file: "docs/a -> b.md" }])
      .mockResolvedValue([])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={["docs/a -> b.md"]}
        />
      </NextIntlClientProvider>
    )

    const commit = await screen.findByRole("button", { name: "Commit (1)" })
    expect(screen.queryByText(/have no changes|has no changes/)).toBeNull()
    await waitFor(() =>
      expect(api.gitShowFile).toHaveBeenCalledWith("/repo", "docs/a -> b.md")
    )
    expect(api.readFilePreview).toHaveBeenCalledWith("/repo", "docs/a -> b.md")
    fireEvent.change(screen.getByPlaceholderText("Enter commit message..."), {
      target: { value: "edit" },
    })
    fireEvent.click(commit)

    await waitFor(() => expect(api.gitCommit).toHaveBeenCalledTimes(1))
    expect(api.gitCommit).toHaveBeenCalledWith(
      "/repo",
      "edit",
      ["docs/a -> b.md"],
      1
    )
  })

  it("rolls back the old name too when rolling back a renamed file", async () => {
    renderWorkspace(["docs/新 name.md"])

    await screen.findByRole("button", { name: "Commit (1)" })
    fireEvent.contextMenu(screen.getByText("新 name.md"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rollback" }))
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(api.gitRollbackFile).toHaveBeenCalledTimes(2))
    expect(api.gitRollbackFile.mock.calls).toEqual([
      ["/repo", "docs/old name.md"],
      ["/repo", "docs/新 name.md"],
    ])
  })

  it("does not restore an old name that a new untracked file occupies", async () => {
    api.gitStatus
      .mockResolvedValueOnce([
        { status: "R", file: "a.md -> b.md" },
        { status: "??", file: "a.md" },
      ])
      .mockResolvedValue([])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={["b.md"]}
        />
      </NextIntlClientProvider>
    )

    await screen.findByRole("button", { name: "Commit (1)" })
    fireEvent.contextMenu(screen.getByText("b.md"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rollback" }))
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(api.gitRollbackFile).toHaveBeenCalled())
    expect(api.gitRollbackFile.mock.calls).toEqual([["/repo", "b.md"]])
  })

  it("keeps a leading space in the new name of a rename", async () => {
    api.gitStatus
      .mockResolvedValueOnce([{ status: "R", file: "a.md ->  b.md" }])
      .mockResolvedValue([])
    api.gitCommit.mockResolvedValue({ committed_files: 1 })
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace
          folderPath="/repo"
          folderId={1}
          initialPaths={[" b.md"]}
        />
      </NextIntlClientProvider>
    )

    await screen.findByRole("button", { name: "Commit (1)" })
  })

  it("rolls back the old name outside a directory that holds the new name", async () => {
    api.gitStatus
      .mockResolvedValueOnce([{ status: "R", file: "src/a.md -> dst/b.md" }])
      .mockResolvedValue([])
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <CommitWorkspace folderPath="/repo" folderId={1} />
      </NextIntlClientProvider>
    )

    await screen.findByRole("button", { name: "Commit (1)" })
    fireEvent.contextMenu(screen.getByText("dst"))
    fireEvent.click(await screen.findByRole("menuitem", { name: "Rollback" }))
    fireEvent.click(await screen.findByRole("button", { name: "Confirm" }))

    await waitFor(() => expect(api.gitRollbackFile).toHaveBeenCalledTimes(2))
    expect(api.gitRollbackFile.mock.calls).toEqual([
      ["/repo", "src/a.md"],
      ["/repo", "dst"],
    ])
  })
})
