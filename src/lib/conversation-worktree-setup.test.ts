import { beforeEach, describe, expect, it, vi } from "vitest"
import type {
  ConversationWorktreeCreated,
  ConversationWorktreeSetupResult,
  FolderDetail,
} from "@/lib/types"

const createMock = vi.fn()
const unsubscribeMock = vi.fn()
let handler: ((payload: ConversationWorktreeSetupResult) => void) | null = null
const subscribeMock = vi.fn(
  async (
    _event: string,
    h: (payload: ConversationWorktreeSetupResult) => void
  ) => {
    handler = h
    return unsubscribeMock
  }
)

vi.mock("@/lib/api", () => ({
  createConversationWorktree: (...args: unknown[]) => createMock(...args),
}))
vi.mock("@/lib/platform", () => ({
  subscribe: (event: string, h: never) => subscribeMock(event, h),
}))

import {
  CONVERSATION_WORKTREE_SETUP_EVENT,
  createConversationWorktreeWatchingSetup,
} from "./conversation-worktree-setup"

function created(
  folderId: number,
  setupCommand: string | null
): ConversationWorktreeCreated {
  return {
    folder: { id: folderId, path: `/wt/${folderId}` } as FolderDetail,
    include: { copied: [".env"], skipped: [], failed: [] },
    setup_command: setupCommand,
  }
}

function result(folderId: number, ok = true): ConversationWorktreeSetupResult {
  return {
    folder_id: folderId,
    worktree_path: `/wt/${folderId}`,
    command: "pnpm install",
    ok,
    exit_code: ok ? 0 : 1,
    output_tail: ok ? "" : "ERR_PNPM",
  }
}

const spec = { kind: "branch_off", branch: "cv/tidy-fox", base: null } as const

beforeEach(() => {
  handler = null
  createMock.mockReset()
  unsubscribeMock.mockReset()
  subscribeMock.mockClear()
})

describe("createConversationWorktreeWatchingSetup", () => {
  it("subscribes before creating, so a setup that ends first is still seen", async () => {
    const onDone = vi.fn()
    createMock.mockImplementation(async () => {
      // The command finished before the create response got back.
      expect(subscribeMock).toHaveBeenCalledWith(
        CONVERSATION_WORKTREE_SETUP_EVENT,
        expect.any(Function)
      )
      handler?.(result(99))
      handler?.(result(7, false))
      return created(7, "pnpm install")
    })

    const out = await createConversationWorktreeWatchingSetup(3, spec, onDone)

    expect(createMock).toHaveBeenCalledWith(3, spec)
    expect(out.folder.id).toBe(7)
    // Not before the caller got `created` back to announce the setup.
    expect(onDone).not.toHaveBeenCalled()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(result(7, false))
    expect(unsubscribeMock).toHaveBeenCalled()
  })

  it("reports a later result for its own folder only, once", async () => {
    const onDone = vi.fn()
    createMock.mockResolvedValue(created(7, "pnpm install"))

    await createConversationWorktreeWatchingSetup(3, spec, onDone)
    expect(onDone).not.toHaveBeenCalled()
    expect(unsubscribeMock).not.toHaveBeenCalled()

    handler?.(result(8))
    expect(onDone).not.toHaveBeenCalled()
    handler?.(result(7))
    handler?.(result(7))
    expect(onDone).toHaveBeenCalledTimes(1)
    expect(onDone).toHaveBeenCalledWith(result(7))
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("stops listening at once when there is no setup command", async () => {
    const onDone = vi.fn()
    createMock.mockResolvedValue(created(7, null))

    const out = await createConversationWorktreeWatchingSetup(3, spec, onDone)

    expect(out.setup_command).toBeNull()
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
    handler?.(result(7))
    expect(onDone).not.toHaveBeenCalled()
  })

  it("stops listening and rethrows when the create fails", async () => {
    createMock.mockRejectedValue(new Error("Branch already exists"))
    await expect(
      createConversationWorktreeWatchingSetup(3, spec, vi.fn())
    ).rejects.toThrow("Branch already exists")
    expect(unsubscribeMock).toHaveBeenCalledTimes(1)
  })

  it("still creates the worktree when the subscription cannot be opened", async () => {
    subscribeMock.mockRejectedValueOnce(new Error("no transport"))
    createMock.mockResolvedValue(created(7, "pnpm install"))
    const out = await createConversationWorktreeWatchingSetup(3, spec, vi.fn())
    expect(out.folder.id).toBe(7)
  })
})
