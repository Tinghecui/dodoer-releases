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
}))

vi.mock("@/lib/api", () => ({
  gitAddFiles: vi.fn(),
  gitCommit: api.gitCommit,
  gitListRemotes: api.gitListRemotes,
  gitPush: api.gitPush,
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
vi.mock("@/components/diff/diff-viewer", () => ({ DiffViewer: () => null }))
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
