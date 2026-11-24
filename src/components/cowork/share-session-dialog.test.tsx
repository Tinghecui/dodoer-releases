import type { ReactNode } from "react"
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import zhMessages from "@/i18n/messages/zh-CN.json"
import {
  CoworkTeamError,
  type TeamShareTarget,
  type TeamShares,
  type TeamTargets,
} from "@/lib/cowork/team"
import { useCoworkTeamStore } from "@/stores/cowork-team-store"
import {
  SHARE_RETRY_MS,
  ShareSessionButton,
  ShareSessionDialog,
} from "./share-session-dialog"

// 假的命令层：只换掉四个 op，其余（错误类型、teamSessionId）用真的。
const api = vi.hoisted(() => ({
  teamTargets: vi.fn<() => Promise<TeamTargets>>(),
  teamShares: vi.fn<(id: string) => Promise<TeamShares>>(),
  teamShare:
    vi.fn<
      (
        id: string,
        targets: TeamShareTarget[],
        note?: string
      ) => Promise<TeamShares>
    >(),
  teamUnshare:
    vi.fn<(id: string, target?: TeamShareTarget) => Promise<TeamShares>>(),
}))
vi.mock("@/lib/cowork/team", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/cowork/team")>()
  return { ...actual, ...api }
})

const TARGETS: TeamTargets = {
  users: [
    { name: "member-c", label: "丙" },
    { name: "member-b", label: "Lee" },
    { name: "member-d", label: "Dana" },
  ],
  groups: [{ id: "g1", name: "Backend" }],
}

const SHARES: TeamShares = {
  id: "42",
  shares: [
    {
      type: "user",
      name: "member-d",
      label: "Dana",
      note: "",
      createdAt: "2026-11-22T08:00:00Z",
    },
  ],
}

function makeAvailable() {
  act(() => {
    useCoworkTeamStore.getState().setStatus({
      applicable: true,
      enabled: true,
      me: { name: "member-c", label: "丙" },
      leaderOf: [],
      portalUrl: null,
    })
  })
}

function intl(ui: ReactNode) {
  return (
    <NextIntlClientProvider locale="en" messages={enMessages}>
      {ui}
    </NextIntlClientProvider>
  )
}

function renderDialog(onOpenChange = vi.fn()) {
  render(
    intl(
      <ShareSessionDialog
        open
        onOpenChange={onOpenChange}
        sessionId="42"
        title="Fix login"
      />
    )
  )
  return onOpenChange
}

function candidateKeys(): string[] {
  return Array.from(document.querySelectorAll("[data-share-candidate]")).map(
    (el) => el.getAttribute("data-share-candidate") ?? ""
  )
}

beforeEach(() => {
  useCoworkTeamStore.getState().reset()
  api.teamTargets.mockResolvedValue(TARGETS)
  api.teamShares.mockResolvedValue(SHARES)
  api.teamShare.mockResolvedValue(SHARES)
  api.teamUnshare.mockResolvedValue({ id: "42", shares: [] })
})

afterEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  useCoworkTeamStore.getState().reset()
})

describe("ShareSessionButton", () => {
  it("团队功能不可用时不画按钮，也不发任何请求", () => {
    render(intl(<ShareSessionButton conversationId={42} title="Fix login" />))
    expect(document.querySelector("[data-share-session-button]")).toBeNull()
    expect(api.teamTargets).not.toHaveBeenCalled()
    expect(api.teamShares).not.toHaveBeenCalled()
  })

  it("草稿（没有数字会话号）上没有按钮", () => {
    makeAvailable()
    render(intl(<ShareSessionButton conversationId={null} title="Draft" />))
    expect(document.querySelector("[data-share-session-button]")).toBeNull()
  })

  it("可用且有会话号时有按钮，点开对话框拉候选和现有分享", async () => {
    makeAvailable()
    render(intl(<ShareSessionButton conversationId={42} title="Fix login" />))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    await waitFor(() => expect(api.teamShares).toHaveBeenCalledWith("42"))
    expect(api.teamTargets).toHaveBeenCalledTimes(1)
    expect(await screen.findByText("Share conversation")).toBeInTheDocument()
  })
  it("等自动重试时顶栏重新渲染：不重新加载，重试照样在 3 秒后发出", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShare
      .mockRejectedValueOnce(new CoworkTeamError("not_found", ""))
      .mockResolvedValueOnce(SHARES)
    const { rerender } = render(
      intl(<ShareSessionButton conversationId={42} title="Fix login" />)
    )
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    const dialog = document.querySelector(
      "[data-share-session-dialog]"
    ) as HTMLElement
    fireEvent.click(within(dialog).getByRole("button", { name: "Share" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    // 顶栏因为切会话之类的原因重新渲染了一次。
    rerender(intl(<ShareSessionButton conversationId={43} title="Other" />))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS + 50)
    })
    expect(api.teamTargets).toHaveBeenCalledTimes(1)
    expect(api.teamShare).toHaveBeenCalledTimes(2)
    expect(api.teamShare.mock.calls[1]).toEqual([
      "42",
      [{ type: "user", name: "member-b" }],
      undefined,
    ])
  })
})

describe("ShareSessionDialog", () => {
  it("列出候选的人和组（不含自己、不含已分享的）和现有分享，写明对方能看到全部", async () => {
    makeAvailable()
    renderDialog()
    await waitFor(() => expect(candidateKeys()).toEqual(["g:g1", "u:member-b"]))
    expect(
      document.querySelector('[data-share-entry="u:member-d"]')
    ).toHaveTextContent("Dana")
    expect(
      screen.getByText(/can see everything in this conversation/)
    ).toBeInTheDocument()
    expect(
      screen.getByText(/Secrets in common formats are masked/)
    ).toBeInTheDocument()
  })

  it("按名字搜候选只在本地过滤", async () => {
    makeAvailable()
    renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.change(screen.getByLabelText("Search people or groups"), {
      target: { value: "lee" },
    })
    expect(candidateKeys()).toEqual(["u:member-b"])
    expect(api.teamTargets).toHaveBeenCalledTimes(1)
  })

  it("确认按契约发 share（勾上的人和组、说明），成功后关闭", async () => {
    makeAvailable()
    const onOpenChange = renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Backend" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.change(screen.getByLabelText("Add a note (optional)"), {
      target: { value: "  please review  " },
    })
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    await waitFor(() =>
      expect(api.teamShare).toHaveBeenCalledWith(
        "42",
        [
          { type: "group", id: "g1" },
          { type: "user", name: "member-b" },
        ],
        "please review"
      )
    )
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("逐个取消发带 target 的 unshare，列表按返回值更新", async () => {
    makeAvailable()
    renderDialog()
    fireEvent.click(
      await screen.findByRole("button", { name: "Stop sharing with Dana" })
    )
    await waitFor(() =>
      expect(api.teamUnshare).toHaveBeenCalledWith("42", {
        type: "user",
        name: "member-d",
      })
    )
    await waitFor(() =>
      expect(screen.getByText("Not shared with anyone yet")).toBeInTheDocument()
    )
  })

  it("「全部取消」发不带 target 的 unshare", async () => {
    makeAvailable()
    renderDialog()
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }))
    await waitFor(() => expect(api.teamUnshare).toHaveBeenCalledTimes(1))
    expect(api.teamUnshare.mock.calls[0]).toEqual(["42", undefined])
  })

  it("服务端报错时按错误码说人话、不显示原文，对话框不关", async () => {
    makeAvailable()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    api.teamShare.mockRejectedValue(
      new CoworkTeamError("invalid", "note too long <b>*x*</b>")
    )
    const onOpenChange = renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("Something went wrong. Try again later")
    expect(alert).not.toHaveTextContent("note too long")
    expect(String(warn.mock.calls[0]?.[0])).toContain("note too long")
    warn.mockRestore()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    expect(screen.getByText("Share conversation")).toBeInTheDocument()
  })

  it("中文界面：读取失败只说「出了点问题，稍后再试」，查不到服务端原文", async () => {
    makeAvailable()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    api.teamShares.mockRejectedValue(
      new CoworkTeamError("invalid", "group 要是整数")
    )
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <ShareSessionDialog
          open
          onOpenChange={vi.fn()}
          sessionId="42"
          title="Fix login"
        />
      </NextIntlClientProvider>
    )
    const alert = await screen.findByRole("alert")
    expect(alert).toHaveTextContent("出了点问题，稍后再试")
    expect(screen.queryByText(/要是整数/)).toBeNull()
    warn.mockRestore()
  })

  it("中文界面：没有权限时说「你没有权限做这件事」", async () => {
    makeAvailable()
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    api.teamShares.mockRejectedValue(
      new CoworkTeamError("forbidden", "not your session")
    )
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <ShareSessionDialog
          open
          onOpenChange={vi.fn()}
          sessionId="42"
          title="Fix login"
        />
      </NextIntlClientProvider>
    )
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "你没有权限做这件事"
    )
    warn.mockRestore()
  })

  it("右上角关闭按钮的读屏文字跟着界面语言（中文是「关闭」）", async () => {
    makeAvailable()
    render(
      <NextIntlClientProvider locale="zh-CN" messages={zhMessages}>
        <ShareSessionDialog
          open
          onOpenChange={vi.fn()}
          sessionId="42"
          title="Fix login"
        />
      </NextIntlClientProvider>
    )
    expect(await screen.findByRole("button", { name: "关闭" })).toBeTruthy()
    expect(screen.queryByRole("button", { name: "Close" })).toBeNull()
  })

  it("会话刚建好回 not_found：提示过几秒再试，3 秒后自动重试一次（只一次）", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShare.mockRejectedValue(new CoworkTeamError("not_found", "gone"))
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    const onOpenChange = renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This conversation was just created. Try again in a few seconds."
    )
    expect(api.teamShare).toHaveBeenCalledTimes(1)
    // 专门提示照旧，但服务端原文也记一行，方便排查。
    expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "not_found gone"
    )
    warn.mockRestore()

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS - 100)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(1)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(2)
    expect(api.teamShare.mock.calls[1]).toEqual([
      "42",
      [{ type: "user", name: "member-b" }],
      undefined,
    ])

    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS * 3)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(2)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("自动重试成功后照常关掉对话框", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShare
      .mockRejectedValueOnce(new CoworkTeamError("not_found", ""))
      .mockResolvedValueOnce(SHARES)
    const onOpenChange = renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS + 50)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false))
  })

  it("等自动重试时又做了别的操作：旧的重试作废，不会再发", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShares.mockResolvedValue({
      id: "42",
      shares: [
        ...SHARES.shares,
        {
          type: "user",
          name: "member-b",
          label: "Lee",
          note: "",
          createdAt: "2026-11-22T09:00:00Z",
        },
      ],
    })
    api.teamUnshare
      .mockRejectedValueOnce(new CoworkTeamError("not_found", ""))
      .mockResolvedValueOnce(SHARES)
    renderDialog()
    fireEvent.click(await screen.findByRole("button", { name: "Stop all" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(api.teamUnshare.mock.calls[0]).toEqual(["42", undefined])
    // 重试还没到点，用户改成只取消 Lee 一个人。
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Stop sharing with Lee" })
      ).not.toBeDisabled()
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Stop sharing with Lee" })
    )
    await waitFor(() => expect(api.teamUnshare).toHaveBeenCalledTimes(2))
    expect(api.teamUnshare.mock.calls[1]).toEqual([
      "42",
      { type: "user", name: "member-b" },
    ])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS * 3)
    })
    // 旧的「全部取消」不能在 3 秒后再发出去。
    expect(api.teamUnshare).toHaveBeenCalledTimes(2)
    expect(screen.getByText("Dana")).toBeInTheDocument()
  })

  it("等自动重试时改了勾选或说明：旧的重试作废，不按旧的对象分享", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShare.mockRejectedValue(new CoworkTeamError("not_found", ""))
    const onOpenChange = renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    expect(api.teamShare).toHaveBeenCalledTimes(1)
    // 重试还没到点，用户取消了 Lee、改勾 Backend。
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("checkbox", { name: "Backend" }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS * 3)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("等自动重试时只改了说明：旧的重试也作废", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShare.mockRejectedValue(new CoworkTeamError("not_found", ""))
    renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
      target: { value: "new note" },
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS * 3)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(1)
  })

  it("分享请求还没回来时改了勾选：之后回 not_found 也不再按旧的对象重试", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    let reject: (e: unknown) => void = () => {}
    api.teamShare.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    const onOpenChange = renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    expect(api.teamShare).toHaveBeenCalledTimes(1)
    // 请求还在路上，用户取消了 Lee。
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    await act(async () => {
      reject(new CoworkTeamError("not_found", ""))
    })
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This conversation was just created"
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS * 3)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(1)
    expect(onOpenChange).not.toHaveBeenCalledWith(false)
  })

  it("分享请求还没回来时改了说明：之后回 not_found 也不再按旧的说明重试", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    let reject: (e: unknown) => void = () => {}
    api.teamShare.mockImplementationOnce(
      () =>
        new Promise((_, rej) => {
          reject = rej
        })
    )
    renderDialog()
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    fireEvent.click(screen.getByRole("checkbox", { name: "Lee" }))
    fireEvent.click(screen.getByRole("button", { name: "Share" }))
    fireEvent.change(screen.getByRole("textbox", { name: /note/i }), {
      target: { value: "new note" },
    })
    await act(async () => {
      reject(new CoworkTeamError("not_found", ""))
    })
    expect(await screen.findByRole("alert")).toBeInTheDocument()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS * 3)
    })
    expect(api.teamShare).toHaveBeenCalledTimes(1)
  })

  it("打开时 shares 回 not_found：3 秒后自动重试，成功后提示消失", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    makeAvailable()
    api.teamShares
      .mockRejectedValueOnce(new CoworkTeamError("not_found", ""))
      .mockResolvedValueOnce(SHARES)
    renderDialog()
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "This conversation was just created"
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SHARE_RETRY_MS + 50)
    })
    expect(api.teamShares).toHaveBeenCalledTimes(2)
    await waitFor(() => expect(candidateKeys()).toHaveLength(2))
    expect(screen.queryByRole("alert")).toBeNull()
  })
})
