import { beforeEach, describe, expect, it, vi } from "vitest"
import { createTranslator } from "next-intl"
import enMessages from "@/i18n/messages/en.json"

const toastMock = vi.hoisted(() => ({
  info: vi.fn(),
  success: vi.fn(),
  warning: vi.fn(),
}))
vi.mock("sonner", () => ({ toast: toastMock }))

import {
  notifyWorktreeCreated,
  notifyWorktreeSetupResult,
} from "./worktree-setup-toasts"

const t = createTranslator({
  locale: "en",
  messages: enMessages,
  namespace: "Folder.branchDropdown",
}) as unknown as Parameters<typeof notifyWorktreeCreated>[1]

const folder = { id: 7 } as never

beforeEach(() => {
  toastMock.info.mockClear()
  toastMock.success.mockClear()
  toastMock.warning.mockClear()
})

describe("notifyWorktreeCreated", () => {
  it("says the init command is running, with what was copied", () => {
    notifyWorktreeCreated(
      {
        folder,
        include: {
          copied: [".env", "config/db.local"],
          skipped: [],
          failed: [],
        },
        setup_command: "pnpm install",
      },
      t
    )
    expect(toastMock.info).toHaveBeenCalledTimes(1)
    const [title, opts] = toastMock.info.mock.calls[0]
    expect(title).toBe("Setting up the worktree: pnpm install")
    expect(opts.description).toContain(
      "Copied 2 ignored files listed in .worktreeinclude"
    )
    expect(toastMock.warning).not.toHaveBeenCalled()
  })

  it("warns about copies that failed", () => {
    notifyWorktreeCreated(
      {
        folder,
        include: { copied: [], skipped: [], failed: [".env: denied"] },
        setup_command: null,
      },
      t
    )
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    expect(toastMock.warning.mock.calls[0][1].description).toBe(".env: denied")
    expect(toastMock.info).not.toHaveBeenCalled()
  })

  it("stays quiet when nothing was copied and nothing runs", () => {
    notifyWorktreeCreated(
      {
        folder,
        include: { copied: [], skipped: [], failed: [] },
        setup_command: null,
      },
      t
    )
    expect(toastMock.info).not.toHaveBeenCalled()
    expect(toastMock.warning).not.toHaveBeenCalled()
  })
})

describe("notifyWorktreeSetupResult", () => {
  it("reports success", () => {
    notifyWorktreeSetupResult(
      {
        folder_id: 7,
        worktree_path: "/wt",
        command: "pnpm install",
        ok: true,
        exit_code: 0,
        output_tail: "",
      },
      t
    )
    expect(toastMock.success).toHaveBeenCalledWith(
      "Worktree setup finished: pnpm install"
    )
  })

  it("reports a failure as a warning with the exit code and output", () => {
    notifyWorktreeSetupResult(
      {
        folder_id: 7,
        worktree_path: "/wt",
        command: "pnpm install",
        ok: false,
        exit_code: 1,
        output_tail: "ERR_PNPM_NO_LOCKFILE",
      },
      t
    )
    expect(toastMock.warning).toHaveBeenCalledTimes(1)
    const [title, opts] = toastMock.warning.mock.calls[0]
    expect(title).toBe("Worktree setup failed (exit 1): pnpm install")
    expect(opts.description).toBe("ERR_PNPM_NO_LOCKFILE")
  })
})
