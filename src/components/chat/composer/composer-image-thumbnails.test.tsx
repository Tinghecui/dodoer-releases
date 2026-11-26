import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { compile } from "tailwindcss"
import { beforeEach, describe, expect, it, vi } from "vitest"

import enMessages from "@/i18n/messages/en.json"
import type { ImageInputAttachment } from "@/components/chat/message-input-attachments"

const mocks = vi.hoisted(() => ({
  canCopyImageToClipboard: vi.fn(() => true),
  copyImageToClipboard: vi.fn(async () => {}),
  downloadImage: vi.fn(async () => true),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  ancestorContextMenu: vi.fn(),
}))

vi.mock("@/lib/copy-image", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/copy-image")>()
  return {
    ...actual,
    canCopyImageToClipboard: mocks.canCopyImageToClipboard,
    copyImageToClipboard: mocks.copyImageToClipboard,
  }
})

vi.mock("@/lib/image-download", () => ({ downloadImage: mocks.downloadImage }))

vi.mock("sonner", () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}))

import { ComposerImageThumbnails } from "./composer-image-thumbnails"

const ATTACHMENT: ImageInputAttachment = {
  id: "att-1",
  type: "image",
  data: "QQ==",
  uri: null,
  name: "shot.png",
  mimeType: "image/png",
}

function renderStrip() {
  return render(
    // The outer handler stands in for the composer's own text context menu,
    // which wraps the whole input area including the attachment strip.
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <div onContextMenu={mocks.ancestorContextMenu}>
        <ComposerImageThumbnails
          attachments={[ATTACHMENT]}
          onRemove={vi.fn()}
        />
      </div>
    </NextIntlClientProvider>
  )
}

/** The context-menu trigger wrapped around the staged thumbnail. */
function trigger(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-image-actions]")
  if (!element) throw new Error("expected a context-menu trigger on the tile")
  return element
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.canCopyImageToClipboard.mockReturnValue(true)
})

describe("ComposerImageThumbnails", () => {
  it("offers Copy image on right-click instead of the composer text menu", async () => {
    renderStrip()

    fireEvent.contextMenu(trigger())

    const copyItem = await screen.findByRole("menuitem", {
      name: "Copy image",
    })
    expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()

    fireEvent.click(copyItem)
    await waitFor(() =>
      expect(mocks.copyImageToClipboard).toHaveBeenCalledWith({
        data: ATTACHMENT.data,
        mime_type: ATTACHMENT.mimeType,
      })
    )
  })

  it("offers Download image on right-click", async () => {
    renderStrip()

    fireEvent.contextMenu(trigger())

    const downloadItem = await screen.findByRole("menuitem", {
      name: "Download image",
    })
    fireEvent.click(downloadItem)
    await waitFor(() =>
      expect(mocks.downloadImage).toHaveBeenCalledWith({
        data: ATTACHMENT.data,
        mime_type: ATTACHMENT.mimeType,
        suggestedName: ATTACHMENT.name,
      })
    )
  })

  it("carries the actions into the blown-up preview", async () => {
    renderStrip()

    fireEvent.click(screen.getByAltText(ATTACHMENT.name))
    const dialog = await screen.findByRole("dialog")

    fireEvent.click(within(dialog).getByRole("button", { name: "Copy image" }))
    await waitFor(() =>
      expect(mocks.copyImageToClipboard).toHaveBeenCalledWith({
        data: ATTACHMENT.data,
        mime_type: ATTACHMENT.mimeType,
      })
    )
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Download image" })
    )
    await waitFor(() => expect(mocks.downloadImage).toHaveBeenCalled())
    // Neither action doubles as "close": the buttons stop the click from
    // reaching the backdrop that dismisses the preview.
    expect(screen.queryByRole("dialog")).not.toBeNull()
  })

  it("offers the right-click menu on the blown-up image too", async () => {
    renderStrip()

    fireEvent.click(screen.getByAltText(ATTACHMENT.name))
    const dialog = await screen.findByRole("dialog")
    const previewTrigger = dialog.querySelector<HTMLElement>(
      "[data-image-actions]"
    )
    expect(previewTrigger).not.toBeNull()

    fireEvent.contextMenu(previewTrigger as HTMLElement)
    const downloadItem = await screen.findByRole("menuitem", {
      name: "Download image",
    })

    fireEvent.click(downloadItem)
    await waitFor(() => expect(mocks.downloadImage).toHaveBeenCalled())
    // The menu is portaled out, but its click still bubbles through the React
    // tree to the dialog's dismiss-on-click backdrop — which must not fire.
    expect(screen.queryByRole("dialog")).not.toBeNull()
  })

  it("keeps the tile out of our menu when the clipboard cannot take images", () => {
    mocks.canCopyImageToClipboard.mockReturnValue(false)
    renderStrip()

    // The native-menu passthrough still blocks the composer's text menu.
    const native = document.querySelector("[data-image-actions-native]")
    expect(native).not.toBeNull()
    fireEvent.contextMenu(native as HTMLElement)
    expect(mocks.ancestorContextMenu).not.toHaveBeenCalled()
  })
})

describe("ComposerImageThumbnails touch target", () => {
  function removeButton() {
    return screen.getByRole("button", {
      name: enMessages.Folder.chat.messageInput.removeAttachmentAria.replace(
        "{name}",
        "shot.png"
      ),
    })
  }

  it("grows the remove cross itself, with no invisible area over the tile", () => {
    renderStrip()
    const remove = removeButton()
    expect(remove).toHaveClass(
      "absolute",
      "right-1",
      "top-1",
      "pointer-coarse:size-6"
    )
    // 看不见的 ::after 会盖住缩略图右上角，点那里想看预览却删了附件
    expect(remove.className).not.toMatch(/(^|\s)\S*after:/)
    expect(remove.querySelector("svg")).toHaveClass("h-3", "w-3")
  })

  it("opens the preview, not removal, when the tile is tapped", async () => {
    const onRemove = vi.fn()
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposerImageThumbnails
          attachments={[ATTACHMENT]}
          onRemove={onRemove}
        />
      </NextIntlClientProvider>
    )
    // 缩略图本身是另一个按钮，叉不在它里面，点缩略图（包括右上方叉旁边）
    // 落到的是预览按钮
    const tile = screen.getByAltText(ATTACHMENT.name).closest("button")
    expect(tile).not.toBeNull()
    expect(tile?.contains(removeButton())).toBe(false)
    fireEvent.click(tile as HTMLElement)
    expect(await screen.findByRole("dialog")).not.toBeNull()
    expect(onRemove).not.toHaveBeenCalled()
  })

  // jsdom 不排版：把叉和缩略图图片的类名真的用 Tailwind 编成 CSS，按粗指针下的
  // 规则算出叉的矩形，再按缩略图上的几个具体位置检查点到的是不是叉
  it("only removes inside the visible cross; centre and the area beside it preview", async () => {
    renderStrip()
    const remove = removeButton()
    const image = screen.getByAltText(ATTACHMENT.name)
    const classes = [
      ...remove.className.split(/\s+/),
      ...image.getAttribute("class")!.split(/\s+/),
    ].filter(Boolean)
    const compiler = await compile(
      "@theme { --spacing: 0.25rem; }\n@tailwind utilities;",
      {}
    )
    const css = compiler.build(classes)
    // 一个类一块：`.类名 { … }`，取出它在粗指针下（有的话）和平时的声明
    const px = (cls: string, prop: string, coarse: boolean) => {
      const escaped = cls.replace(/[:.]/g, (c) => `\\\\${c}`)
      const block = new RegExp(`\\.${escaped} \\{([\\s\\S]*?)\\n\\}`).exec(
        css
      )?.[1]
      expect(block, cls).toBeDefined()
      if (coarse) expect(block).toContain("@media (pointer: coarse)")
      const value = new RegExp(
        `${prop}: calc\\(var\\(--spacing\\) \\* ([\\d.]+)\\)`
      ).exec(block!)?.[1]
      expect(value, `${cls} ${prop}`).toBeDefined()
      return Number(value) * 4
    }
    const tile = px("h-14", "height", false)
    expect(px("w-14", "width", false)).toBe(tile)
    const right = px("right-1", "right", false)
    const top = px("top-1", "top", false)
    const size = px("pointer-coarse:size-6", "width", true)
    expect(px("pointer-coarse:size-6", "height", true)).toBe(size)
    // 叉就是看得见的那一块，没有往外扩的 ::after（上一个测试查过）
    const cross = {
      left: tile - right - size,
      right: tile - right,
      top,
      bottom: top + size,
    }
    const hitsCross = (x: number, y: number) =>
      x >= cross.left && x < cross.right && y >= cross.top && y < cross.bottom
    // 叉在缩略图里面，不伸出去
    expect(cross.left).toBeGreaterThan(0)
    expect(cross.right).toBeLessThanOrEqual(tile)
    // 正中间、右上方叉的左边和下边、紧贴叉的外沿：都是预览
    for (const [x, y, where] of [
      [tile / 2, tile / 2, "centre"],
      [cross.left - 2, cross.top + size / 2, "left of the cross"],
      [cross.left + size / 2, cross.bottom + 2, "below the cross"],
      [cross.left - 1, cross.bottom, "next to the cross corner"],
      [tile - 1, cross.bottom + 1, "top-right edge below the cross"],
    ] as const) {
      expect(hitsCross(x, y), where).toBe(false)
    }
    // 叉自己（中心和四角里面一点）是删除
    for (const [x, y] of [
      [cross.left + size / 2, cross.top + size / 2],
      [cross.left + 1, cross.top + 1],
      [cross.right - 1, cross.bottom - 1],
    ]) {
      expect(hitsCross(x, y)).toBe(true)
    }
  })
})
