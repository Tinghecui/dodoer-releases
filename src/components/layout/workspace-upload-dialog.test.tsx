/**
 * 上传弹窗的字节显示：浏览器上传的进度事件报的是整个 multipart 请求体的
 * 字节数（文件 + 边界 + 表单字段），列表和汇总里一直要显示文件本身的大小。
 */
import { act, fireEvent, render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"

const upload = vi.hoisted(() => ({
  onProgress: null as ((loaded: number, total: number) => void) | null,
  resolve: null as (() => void) | null,
  reject: null as ((err: Error) => void) | null,
}))

vi.mock("@/lib/api", () => ({
  cancelWorkspaceTransfer: vi.fn(),
  isUploadAbortError: () => false,
  listenWorkspaceTransferProgress: vi.fn(async () => () => {}),
  uploadWorkspaceLocalPathsToRemote: vi.fn(),
  uploadWorkspaceFile: vi.fn(
    (args: { onProgress?: (loaded: number, total: number) => void }) =>
      new Promise<void>((resolve, reject) => {
        upload.onProgress = args.onProgress ?? null
        upload.resolve = resolve
        upload.reject = reject
      })
  ),
}))
vi.mock("@/lib/transport", () => ({ isRemoteDesktopMode: () => false }))
vi.mock("sonner", () => ({
  toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

import { WorkspaceUploadDialog } from "./workspace-upload-dialog"

function renderDialog() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkspaceUploadDialog
        open
        onOpenChange={() => {}}
        rootPath="/tmp/demo-root"
        targetPath="demo"
        folderUploadSupported
        onComplete={() => {}}
      />
    </NextIntlClientProvider>
  )
}

async function startSixByteUpload() {
  renderDialog()
  const input = document.querySelector(
    'input[type="file"]:not([webkitdirectory])'
  ) as HTMLInputElement
  const file = new File(["abcdef"], "six.txt", { type: "text/plain" })
  fireEvent.change(input, { target: { files: [file] } })
  await userEvent.click(
    await screen.findByRole("button", {
      name: enMessages.Folder.fileTreeTab.uploadDialog.startUpload,
    })
  )
  await vi.waitFor(() => expect(upload.onProgress).not.toBeNull())
}

describe("WorkspaceUploadDialog 字节显示", () => {
  it("进度按请求体比例换算成文件字节，完成后仍显示文件大小", async () => {
    await startSixByteUpload()
    act(() => upload.onProgress!(208, 416))
    expect(screen.getByText(/3 B \/ 6 B/)).toBeInTheDocument()
    expect(screen.queryByText(/416 B/)).toBeNull()

    act(() => upload.onProgress!(416, 416))
    await act(async () => upload.resolve!())
    expect(await screen.findByText(/6 B \/ 6 B/)).toBeInTheDocument()
    expect(screen.queryByText(/416 B/)).toBeNull()
  })

  it("上传失败后也不把请求体大小当成文件大小", async () => {
    await startSixByteUpload()
    act(() => upload.onProgress!(416, 416))
    await act(async () => upload.reject!(new Error("boom")))
    expect(screen.queryByText(/416 B/)).toBeNull()
    expect(screen.getAllByText(/6 B/).length).toBeGreaterThan(0)
  })
})
