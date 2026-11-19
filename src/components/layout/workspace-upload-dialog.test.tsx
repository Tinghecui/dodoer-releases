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
  signal: null as AbortSignal | null,
}))

vi.mock("@/lib/api", () => ({
  cancelWorkspaceTransfer: vi.fn(),
  isUploadAbortError: () => false,
  listenWorkspaceTransferProgress: vi.fn(async () => () => {}),
  uploadWorkspaceLocalPathsToRemote: vi.fn(),
  uploadWorkspaceFile: vi.fn(
    (args: {
      onProgress?: (loaded: number, total: number) => void
      signal?: AbortSignal
    }) =>
      new Promise<void>((resolve, reject) => {
        upload.onProgress = args.onProgress ?? null
        upload.signal = args.signal ?? null
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

function renderDialog(onOpenChange: (open: boolean) => void = () => {}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <WorkspaceUploadDialog
        open
        onOpenChange={onOpenChange}
        rootPath="/tmp/demo-root"
        targetPath="demo"
        folderUploadSupported
        onComplete={() => {}}
      />
    </NextIntlClientProvider>
  )
}

async function startSixByteUpload(onOpenChange?: (open: boolean) => void) {
  renderDialog(onOpenChange)
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

// #870：双击「开始上传」时第二下落在同一位置刚出现的「取消」上，
// 文件其实已经写进磁盘，列表却显示「已取消」。
describe("WorkspaceUploadDialog 取消", () => {
  const cancelLabel = enMessages.Folder.common.cancel
  const status = enMessages.Folder.fileTreeTab.uploadDialog.status

  it("刚点开始上传半秒内点取消不算数，这条照常完成", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(10_000)
    try {
      await startSixByteUpload()
      now.mockReturnValue(10_100)
      fireEvent.click(screen.getByRole("button", { name: cancelLabel }))
      expect(upload.signal?.aborted).toBe(false)
      await act(async () => upload.resolve!())
      expect(await screen.findByText(status.success)).toBeInTheDocument()
      expect(screen.queryByText(status.cancelled)).toBeNull()
    } finally {
      now.mockRestore()
    }
  })

  it("过了半秒点取消照样取消", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(20_000)
    try {
      await startSixByteUpload()
      now.mockReturnValue(20_600)
      fireEvent.click(screen.getByRole("button", { name: cancelLabel }))
      expect(upload.signal?.aborted).toBe(true)
    } finally {
      now.mockRestore()
    }
  })

  // 底部的「关闭」按钮（右上角的叉也叫 Close，排除掉）
  const footerCloseButton = () =>
    screen
      .getAllByRole("button", { name: enMessages.Folder.common.close })
      .find((el) => el.dataset.slot !== "dialog-close")!

  // 返工 2：小文件在双击的两下之间就传完了，第二下落在换出来的「关闭」上。
  it("半秒内传完时第二下点到关闭不关弹窗，照常显示完成", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(30_000)
    const onOpenChange = vi.fn()
    try {
      await startSixByteUpload(onOpenChange)
      await act(async () => upload.resolve!())
      expect(await screen.findByText(status.success)).toBeInTheDocument()
      now.mockReturnValue(30_200)
      fireEvent.click(footerCloseButton())
      expect(onOpenChange).not.toHaveBeenCalled()
      expect(screen.getByText(status.success)).toBeInTheDocument()

      now.mockReturnValue(30_600)
      fireEvent.click(footerCloseButton())
      expect(onOpenChange).toHaveBeenCalledWith(false)
    } finally {
      now.mockRestore()
    }
  })
})

// #870 返工：请求体发完后点取消，上传按服务端结果收尾。
describe("WorkspaceUploadDialog 取消后按服务端结果", () => {
  const cancelLabel = enMessages.Folder.common.cancel
  const dialogText = enMessages.Folder.fileTreeTab.uploadDialog
  const status = dialogText.status

  async function startTwoFileUpload() {
    renderDialog()
    const input = document.querySelector(
      'input[type="file"]:not([webkitdirectory])'
    ) as HTMLInputElement
    fireEvent.change(input, {
      target: {
        files: [
          new File(["abcdef"], "first.txt", { type: "text/plain" }),
          new File(["ghijkl"], "second.txt", { type: "text/plain" }),
        ],
      },
    })
    await userEvent.click(
      await screen.findByRole("button", { name: dialogText.startUpload })
    )
    await vi.waitFor(() => expect(upload.onProgress).not.toBeNull())
  }

  function summary(succeeded: number, failed: number) {
    return dialogText.summary
      .replace("{total}", "2")
      .replace("{succeeded}", String(succeeded))
      .replace("{failed}", String(failed))
  }

  it("取消后服务端返回错误，这条显示失败和原因，不显示已取消", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(30_000)
    try {
      await startTwoFileUpload()
      now.mockReturnValue(30_600)
      fireEvent.click(screen.getByRole("button", { name: cancelLabel }))
      expect(upload.signal?.aborted).toBe(true)
      await act(async () =>
        upload.reject!(new Error("demo/first.txt already exists"))
      )
      expect(
        await screen.findByText(/demo\/first\.txt already exists/)
      ).toBeInTheDocument()
      expect(screen.getByText(status.error)).toBeInTheDocument()
      // 后面那条没开始，照样取消
      expect(screen.getAllByText(status.cancelled)).toHaveLength(1)
      expect(screen.getByText(summary(0, 1))).toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })

  it("取消后当前这条成功返回，显示完成、成功 1，后面那条已取消", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(40_000)
    try {
      await startTwoFileUpload()
      now.mockReturnValue(40_600)
      fireEvent.click(screen.getByRole("button", { name: cancelLabel }))
      await act(async () => upload.resolve!())
      expect(await screen.findByText(status.success)).toBeInTheDocument()
      expect(screen.getAllByText(status.cancelled)).toHaveLength(1)
      expect(screen.getByText(summary(1, 0))).toBeInTheDocument()
    } finally {
      now.mockRestore()
    }
  })
})
