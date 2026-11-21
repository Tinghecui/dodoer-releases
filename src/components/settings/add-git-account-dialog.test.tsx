import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/api", () => ({
  saveAccountToken: vi.fn(),
}))

import { AddGitAccountDialog } from "./add-git-account-dialog"
import enMessages from "@/i18n/messages/en.json"
import { saveAccountToken } from "@/lib/api"

const mockSave = vi.mocked(saveAccountToken)
const T = enMessages.VersionControlSettings.gitAccount

function renderDialog(onAccountAdded = vi.fn()) {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <AddGitAccountDialog
        open
        onOpenChange={vi.fn()}
        onAccountAdded={onAccountAdded}
        isFirstAccount
      />
    </NextIntlClientProvider>
  )
  return onAccountAdded
}

function fill(serverUrl: string) {
  fireEvent.change(screen.getByPlaceholderText(T.serverUrlPlaceholder), {
    target: { value: serverUrl },
  })
  fireEvent.change(screen.getByPlaceholderText(T.usernamePlaceholder), {
    target: { value: "qa-user" },
  })
  fireEvent.change(screen.getByPlaceholderText(T.passwordPlaceholder), {
    target: { value: "secret" },
  })
  fireEvent.click(screen.getByRole("button", { name: T.add }))
}

describe("AddGitAccountDialog server address", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockSave.mockResolvedValue(undefined)
  })

  // 回归 #1049：「not a url !!」这种地址原样存进去，列表里就多了一个连不上的账号。
  it("rejects an address that is not an http(s) URL", async () => {
    const onAdded = renderDialog()
    fill("not a url !!")

    expect(await screen.findByText(T.serverInvalid)).toBeInTheDocument()
    expect(mockSave).not.toHaveBeenCalled()
    expect(onAdded).not.toHaveBeenCalled()
  })

  // 返工：地址错误要显示在地址输入框旁边，并标到这个输入框上，
  // 不能和用户名、令牌的错误一起挤在令牌下面。
  it("shows the address error right next to the server input", async () => {
    renderDialog()
    fill("not a url !!")

    const message = await screen.findByText(T.serverInvalid)
    const input = screen.getByPlaceholderText(T.serverUrlPlaceholder)
    expect(input).toHaveAttribute("aria-invalid", "true")
    expect(input.getAttribute("aria-describedby")).toBe(message.id)
    expect(input.parentElement).toContainElement(message)
  })

  it("rejects a non-http scheme", async () => {
    const onAdded = renderDialog()
    fill("ftp://git.example.test")

    expect(await screen.findByText(T.serverInvalid)).toBeInTheDocument()
    expect(onAdded).not.toHaveBeenCalled()
  })

  it("stores a bare host name as an https address", async () => {
    const onAdded = renderDialog()
    fill("  git.example.test  ")

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onAdded.mock.calls[0][0].server_url).toBe("https://git.example.test")
  })

  it("keeps a full http(s) address as typed", async () => {
    const onAdded = renderDialog()
    fill("http://git.example.test:8080/scm")

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onAdded.mock.calls[0][0].server_url).toBe(
      "http://git.example.test:8080/scm"
    )
  })

  // 返工 3：只去掉路径末尾的斜杠，查询参数和 # 后面的内容原样保留，
  // 不然「测试」请求的就不是用户填的地址。
  it("trims trailing slashes only from the path, not the query", async () => {
    const onAdded = renderDialog()
    fill("https://git.example.test/scm//?next=/repo/")

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onAdded.mock.calls[0][0].server_url).toBe(
      "https://git.example.test/scm?next=/repo/"
    )
  })

  it("keeps a trailing slash inside the fragment", async () => {
    const onAdded = renderDialog()
    fill("https://git.example.test/#/")

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onAdded.mock.calls[0][0].server_url).toBe(
      "https://git.example.test#/"
    )
  })

  it("still trims trailing slashes from a plain address", async () => {
    const onAdded = renderDialog()
    fill("https://git.example.test/scm///")

    await waitFor(() => expect(onAdded).toHaveBeenCalled())
    expect(onAdded.mock.calls[0][0].server_url).toBe(
      "https://git.example.test/scm"
    )
  })
})
