import { act, renderHook } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import type { ReactNode } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  generate: vi.fn(),
  cancel: vi.fn(async () => {}),
  listAgents: vi.fn(),
}))
const toastError = vi.hoisted(() => vi.fn())
const agents = vi.hoisted(() => ({
  defaultOrder: [] as string[],
  fresh: true,
}))

vi.mock("@/lib/api", () => ({
  gitGenerateCommitMessage: api.generate,
  gitGenerateCommitMessageCancel: api.cancel,
  acpListAgents: api.listAgents,
}))
vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: agents.defaultOrder,
    defaultOrder: agents.defaultOrder,
    fresh: agents.fresh,
    refresh: async () => {},
  }),
}))
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: toastError },
}))

import {
  sameFiles,
  useCommitMessageGeneration,
  type GeneratedMessage,
} from "./use-commit-message-generation"
import enMessages from "@/i18n/messages/en.json"

function wrapper({ children }: { children: ReactNode }) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {children}
    </NextIntlClientProvider>
  )
}

/** A generation the test settles by hand. */
function pending() {
  let resolve!: (value: Generated) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Generated>((res, rej) => {
    resolve = res
    reject = rej
  })
  api.generate.mockReturnValueOnce(promise)
  return { resolve, reject }
}

function agent(
  agent_type: string,
  {
    enabled = true,
    installed = true,
  }: { enabled?: boolean; installed?: boolean } = {}
) {
  return {
    agent_type,
    enabled,
    available: true,
    installed_version: installed ? "1.0.0" : null,
    sort_order: 0,
    name: agent_type,
  }
}

type Generated = { message: string; agent_type: string; auto_commit: boolean }

const input = { files: ["a.ts"], draft: "fix it", fallbackAgent: null }

describe("useCommitMessageGeneration", () => {
  beforeEach(() => {
    api.generate.mockReset()
    api.cancel.mockClear()
    toastError.mockClear()
    agents.defaultOrder = []
    agents.fresh = true
    api.listAgents.mockReset()
  })

  it("hands back the message and asks for exactly the commit's files", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    expect(result.current.generating).toBe(true)
    expect(api.generate).toHaveBeenCalledWith({
      requestId: expect.any(String),
      path: "/repo",
      folderId: 7,
      files: ["a.ts"],
      draft: "fix it",
      fallbackAgent: null,
      lastResortAgent: null,
    })
    await act(async () => {
      run.resolve({
        message: "fix: it",
        agent_type: "claude_code",
        auto_commit: false,
      })
      expect(await message).toEqual({ message: "fix: it", autoCommit: false })
    })
    expect(result.current.generating).toBe(false)
  })

  it("passes on that the settings want the message committed", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    await act(async () => {
      run.resolve({
        message: "fix: it",
        agent_type: "claude_code",
        auto_commit: true,
      })
      expect(await message).toEqual({ message: "fix: it", autoCommit: true })
    })
  })

  it("offers the first usable agent for when no session or folder names one", () => {
    // #798：没开会话、提交窗口里，文件夹没设默认时也要有 agent 可用。
    agents.defaultOrder = ["claude_code", "codex"]
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    act(() => {
      void result.current.generate(input)
    })
    const sent = api.generate.mock.calls[0][0]
    expect(sent.fallbackAgent).toBeNull()
    expect(sent.lastResortAgent).toBe("claude_code")
  })

  it("reads the agent list itself when it has not arrived yet", async () => {
    // #798 返工：列表还在加载、或者上次读取失败（没有缓存）时点生成，当场读一次。
    agents.fresh = false
    api.listAgents.mockResolvedValueOnce([
      agent("codex", { installed: false }),
      agent("claude_code"),
      agent("gemini", { enabled: false }),
    ])
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    await act(async () => {
      void result.current.generate(input)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listAgents).toHaveBeenCalledTimes(1)
    expect(api.generate.mock.calls[0][0].lastResortAgent).toBe("claude_code")
  })

  it("still asks when the list cannot be read, so the backend names the error", async () => {
    agents.fresh = false
    api.listAgents.mockRejectedValueOnce(new Error("offline"))
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    await act(async () => {
      void result.current.generate(input)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.generate.mock.calls[0][0].lastResortAgent).toBeNull()
  })

  it("reads the list afresh rather than trust an old cache", async () => {
    // #798 返工 2：本地缓存里的 agent 可能早就被停用或卸载了，列表没刷新到时不照它。
    agents.fresh = false
    agents.defaultOrder = ["codex"]
    api.listAgents.mockResolvedValueOnce([
      agent("codex", { enabled: false }),
      agent("claude_code"),
    ])
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    await act(async () => {
      void result.current.generate(input)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.listAgents).toHaveBeenCalledTimes(1)
    expect(api.generate.mock.calls[0][0].lastResortAgent).toBe("claude_code")
  })

  it("falls back to the cache when the list cannot be read afresh", async () => {
    agents.fresh = false
    agents.defaultOrder = ["codex"]
    api.listAgents.mockRejectedValueOnce(new Error("offline"))
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    await act(async () => {
      void result.current.generate(input)
      await Promise.resolve()
      await Promise.resolve()
    })
    expect(api.generate.mock.calls[0][0].lastResortAgent).toBe("codex")
  })

  it("does not read the list when the session names an agent", () => {
    agents.fresh = false
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    act(() => {
      void result.current.generate({ ...input, fallbackAgent: "codex" })
    })
    expect(api.listAgents).not.toHaveBeenCalled()
    expect(api.generate.mock.calls[0][0].fallbackAgent).toBe("codex")
  })

  it("sends no draft for a box holding only whitespace", () => {
    pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    act(() => {
      void result.current.generate({ ...input, draft: "  \n " })
    })
    expect(api.generate.mock.calls[0][0].draft).toBeNull()
  })

  it("stops the run on the backend and drops an answer that still comes", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    const requestId = api.generate.mock.calls[0][0].requestId
    act(() => result.current.stop())
    expect(api.cancel).toHaveBeenCalledWith(requestId)
    expect(result.current.generating).toBe(false)
    await act(async () => {
      run.resolve({
        message: "too late",
        agent_type: "claude_code",
        auto_commit: false,
      })
      expect(await message).toBeNull()
    })
  })

  it("stops when the folder changes under it", async () => {
    const run = pending()
    const { result, rerender } = renderHook(
      ({ path }) => useCommitMessageGeneration({ path, folderId: 7 }),
      { wrapper, initialProps: { path: "/a" } }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    rerender({ path: "/b" })
    expect(api.cancel).toHaveBeenCalledTimes(1)
    expect(result.current.generating).toBe(false)
    await act(async () => {
      run.resolve({
        message: "for /a",
        agent_type: "claude_code",
        auto_commit: false,
      })
      expect(await message).toBeNull()
    })
  })

  it("stops when the box goes away", () => {
    pending()
    const { result, unmount } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    act(() => {
      void result.current.generate(input)
    })
    unmount()
    expect(api.cancel).toHaveBeenCalledTimes(1)
  })

  it("reports a failure in the user's language, with a way to the settings", async () => {
    const run = pending()
    const { result } = renderHook(
      () => useCommitMessageGeneration({ path: "/repo", folderId: 7 }),
      { wrapper }
    )
    let message: Promise<GeneratedMessage | null> = Promise.resolve(null)
    act(() => {
      message = result.current.generate(input)
    })
    await act(async () => {
      run.reject({
        code: "configuration_missing",
        message: "No agent to write the commit message",
        i18n_key: "errors.noAgent",
      })
      expect(await message).toBeNull()
    })
    expect(toastError).toHaveBeenCalledTimes(1)
    const [title, options] = toastError.mock.calls[0]
    expect(title).toBe(enMessages.CommitMessageGeneration.toasts.failed)
    expect(options.description).toBe(
      enMessages.CommitMessageGeneration.errors.noAgent
    )
    act(() => options.action.onClick())
    expect(result.current.settingsOpen).toBe(true)
  })

  it("starts nothing while a run is going or without a folder", () => {
    pending()
    const { result, rerender } = renderHook(
      ({ path }: { path: string | null }) =>
        useCommitMessageGeneration({ path, folderId: 7 }),
      { wrapper, initialProps: { path: "/repo" as string | null } }
    )
    act(() => {
      void result.current.generate(input)
    })
    act(() => {
      void result.current.generate(input)
    })
    expect(api.generate).toHaveBeenCalledTimes(1)

    rerender({ path: null })
    act(() => {
      void result.current.generate(input)
    })
    expect(api.generate).toHaveBeenCalledTimes(1)
  })
})

describe("sameFiles", () => {
  it("compares the files, not their order", () => {
    expect(sameFiles(["a.ts", "b.ts"], ["b.ts", "a.ts"])).toBe(true)
    expect(sameFiles(["a.ts"], ["a.ts", "b.ts"])).toBe(false)
    expect(sameFiles(["a.ts", "b.ts"], ["a.ts", "c.ts"])).toBe(false)
    expect(sameFiles([], [])).toBe(true)
  })
})
