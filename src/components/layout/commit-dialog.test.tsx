import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { GitStatusEntry } from "@/lib/types"

const api = vi.hoisted(() => ({
  gitStatus: vi.fn<(path: string) => Promise<GitStatusEntry[]>>(),
  gitCommit: vi.fn(async () => ({ committed_files: 1 })),
  gitPush: vi.fn(async () => {}),
}))

vi.mock("@/lib/api", () => ({
  gitAddFiles: vi.fn(),
  gitCommit: api.gitCommit,
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
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { CommitWorkspace } from "./commit-dialog"
import enMessages from "@/i18n/messages/en.json"

beforeEach(() => {
  api.gitStatus.mockReset()
  api.gitCommit.mockClear()
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
