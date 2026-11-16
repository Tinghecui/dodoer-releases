import { Editor } from "@tiptap/core"
import { act, renderHook, waitFor } from "@testing-library/react"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { ClipboardFile } from "@/lib/clipboard-files"
import { buildFileUri } from "@/lib/reference-link"

import { DRAG_DROP_IMAGE_MAX_BYTES } from "./attachment-files"
import { buildComposerExtensions } from "./editor-config"
import type { RichComposerHandle } from "./rich-composer"
import { useComposerAttachments } from "./use-composer-attachments"

// A desktop window, local unless a test binds it to a remote workspace.
const env = vi.hoisted(() => ({ remoteId: null as number | null }))
vi.mock("@/lib/platform", () => ({
  isDesktop: () => true,
  openFileDialog: vi.fn(),
}))
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  getActiveRemoteConnectionId: () => env.remoteId,
}))

// What the OS clipboard holds as files, per test; `null` makes the read fail.
const clipboard = vi.hoisted(() => ({
  files: [] as ClipboardFile[] | null,
}))
vi.mock("@/lib/clipboard-files", () => ({
  readClipboardFiles: vi.fn(async () => {
    if (clipboard.files === null) throw new Error("no clipboard")
    return clipboard.files
  }),
}))

const api = vi.hoisted(() => ({
  readFileBase64: vi.fn(async () => "aW1hZ2U="),
  uploadAttachment: vi.fn(async (file: File, sessionId?: string | null) => ({
    path: `/uploads/${sessionId ?? "anon"}/${file.name}`,
    name: file.name,
    size: file.size,
    mimeType: file.type || null,
  })),
}))
vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  readFileBase64: api.readFileBase64,
  uploadAttachment: api.uploadAttachment,
  uploadLocalPathToRemote: remoteUpload.uploadLocalPathToRemote,
}))
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

// 系统拖放：Tauri 的窗口事件，每个挂着的输入框都听到同一个。测试里自己发。
const tauri = vi.hoisted(() => ({
  listeners: new Map<string, Array<(event: { payload: unknown }) => void>>(),
}))
vi.mock("@tauri-apps/api/event", () => ({
  TauriEvent: {
    DRAG_ENTER: "tauri://drag-enter",
    DRAG_OVER: "tauri://drag-over",
    DRAG_DROP: "tauri://drag-drop",
    DRAG_LEAVE: "tauri://drag-leave",
  },
}))
vi.mock("@tauri-apps/api/webview", () => ({
  getCurrentWebview: () => ({
    listen: async (name: string, cb: (event: { payload: unknown }) => void) => {
      const list = tauri.listeners.get(name) ?? []
      list.push(cb)
      tauri.listeners.set(name, list)
      return () => {
        const cur = tauri.listeners.get(name) ?? []
        tauri.listeners.set(
          name,
          cur.filter((fn) => fn !== cb)
        )
      }
    },
  }),
}))
const platform = vi.hoisted(() => ({ os: "linux" as string }))
vi.mock("@/hooks/use-platform", () => ({
  detectPlatform: () => platform.os,
}))
const remoteUpload = vi.hoisted(() => ({
  uploadLocalPathToRemote: vi.fn(async (path: string) => ({
    path: `/remote-uploads/${path.split("/").pop()}`,
    name: path.split("/").pop() ?? path,
    size: 4,
    mimeType: null,
  })),
}))
vi.mock("@/lib/tauri", () => ({
  readFileBase64: vi.fn(async () => "aW1hZ2U="),
}))

let editor: Editor

beforeEach(() => {
  editor = new Editor({ extensions: buildComposerExtensions() })
  env.remoteId = null
  clipboard.files = []
  api.readFileBase64.mockClear()
  api.uploadAttachment.mockClear()
})

afterEach(() => {
  editor.destroy()
})

function renderAttachments() {
  const editorRef = {
    current: { getEditor: () => editor } as unknown as RichComposerHandle,
  }
  return renderHook(() =>
    useComposerAttachments({
      editorRef,
      promptCapabilities: { image: true, embedded_context: true },
      attachmentTabId: "tab-1",
    })
  )
}

function pastedFile(name: string, size: number, type = ""): File {
  return new File([new Uint8Array(size)], name, { type })
}

function paste(files: File[]): ClipboardEvent {
  return {
    clipboardData: {
      files,
      items: [],
      types: ["Files"],
      getData: () => "",
    },
  } as unknown as ClipboardEvent
}

function fileBadgeUris(): string[] {
  const uris: string[] = []
  editor.state.doc.descendants((node) => {
    if (node.type.name === "reference" && node.attrs.refType === "file") {
      uris.push(node.attrs.uri)
    }
  })
  return uris
}

describe("a desktop paste of files copied in Finder / Explorer", () => {
  it("attaches each file by its real path, as a drop would", async () => {
    clipboard.files = [
      { path: "/work/bundle.zip", name: "bundle.zip", size: 117, isDir: false },
      { path: "/work/assets", name: "assets", size: null, isDir: true },
    ]
    const { result } = renderAttachments()
    let consumed = false
    act(() => {
      consumed = result.current.handlePasteFiles(
        paste([
          pastedFile("bundle.zip", 117, "application/zip"),
          pastedFile("assets", 0),
        ])
      )
    })
    expect(consumed).toBe(true)
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([
        buildFileUri("/work/bundle.zip"),
        buildFileUri("/work/assets"),
      ])
    )
    // Nothing was read for its bytes or copied anywhere.
    expect(api.uploadAttachment).not.toHaveBeenCalled()
    expect(result.current.embeddedPayloadsRef.current.size).toBe(0)
  })

  it("keeps a pasted image file's thumbnail, read from its path", async () => {
    clipboard.files = [
      { path: "/work/shot.png", name: "shot.png", size: 70, isDir: false },
    ]
    const { result } = renderAttachments()
    act(() => {
      result.current.handlePasteFiles(
        paste([pastedFile("shot.png", 70, "image/png")])
      )
    })
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(result.current.imageAttachments[0]).toMatchObject({
      uri: buildFileUri("/work/shot.png"),
      data: "aW1hZ2U=",
    })
    expect(api.readFileBase64).toHaveBeenCalledWith(
      "/work/shot.png",
      DRAG_DROP_IMAGE_MAX_BYTES
    )
  })

  it("attaches an image whose thumbnail cannot be read by its path instead", async () => {
    clipboard.files = [
      { path: "/work/huge.png", name: "huge.png", size: 70, isDir: false },
    ]
    api.readFileBase64.mockRejectedValueOnce(new Error("over the inline cap"))
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderAttachments()
    act(() => {
      result.current.handlePasteFiles(
        paste([pastedFile("huge.png", 70, "image/png")])
      )
    })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([buildFileUri("/work/huge.png")])
    )
    expect(result.current.imageAttachments).toEqual([])
    quiet.mockRestore()
  })

  it("still sends a screenshot's bytes, since no file is behind it", async () => {
    const { result } = renderAttachments()
    act(() => {
      result.current.handlePasteFiles(
        paste([pastedFile("image.png", 70, "image/png")])
      )
    })
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(result.current.imageAttachments[0].uri).toBeNull()
    expect(api.readFileBase64).not.toHaveBeenCalled()
  })

  it("keeps other bytes with no file behind them in the uploads directory", async () => {
    const { result } = renderAttachments()
    const clip = pastedFile("clip.zip", 4, "application/zip")
    act(() => {
      result.current.handlePasteFiles(paste([clip]))
    })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([buildFileUri("/uploads/tab-1/clip.zip")])
    )
    expect(api.uploadAttachment).toHaveBeenCalledWith(clip, "tab-1")
    expect(result.current.embeddedPayloadsRef.current.size).toBe(0)
  })

  it("falls back to the bytes when the clipboard cannot be read", async () => {
    clipboard.files = null
    const { result } = renderAttachments()
    const zip = pastedFile("bundle.zip", 117, "application/zip")
    act(() => {
      result.current.handlePasteFiles(paste([zip]))
    })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([
        buildFileUri("/uploads/tab-1/bundle.zip"),
      ])
    )
    expect(api.uploadAttachment).toHaveBeenCalledWith(zip, "tab-1")
  })

  it("keeps uploading in a window bound to a remote workspace", async () => {
    env.remoteId = 7
    clipboard.files = [
      { path: "/work/bundle.zip", name: "bundle.zip", size: 117, isDir: false },
    ]
    const { result } = renderAttachments()
    const zip = pastedFile("bundle.zip", 117, "application/zip")
    act(() => {
      result.current.handlePasteFiles(paste([zip]))
    })
    await waitFor(() =>
      expect(api.uploadAttachment).toHaveBeenCalledWith(zip, "tab-1")
    )
    // The local path means nothing to the remote agent.
    expect(fileBadgeUris()).toEqual([buildFileUri("/uploads/tab-1/bundle.zip")])
  })
})

describe("appendClipboardFiles (a paste with no files of its own)", () => {
  it("attaches the files on the clipboard by path", async () => {
    clipboard.files = [
      {
        path: "/work/report.docx",
        name: "report.docx",
        size: 204,
        isDir: false,
      },
    ]
    const { result } = renderAttachments()
    let attached = false
    await act(async () => {
      attached = await result.current.appendClipboardFiles()
    })
    expect(attached).toBe(true)
    expect(fileBadgeUris()).toEqual([buildFileUri("/work/report.docx")])
  })

  it("keeps an image it cannot make a thumbnail of, by its path", async () => {
    clipboard.files = [
      { path: "/work/huge.png", name: "huge.png", size: 70, isDir: false },
    ]
    api.readFileBase64.mockRejectedValueOnce(new Error("over the inline cap"))
    const quiet = vi.spyOn(console, "error").mockImplementation(() => {})
    const { result } = renderAttachments()
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(true)
    })
    expect(fileBadgeUris()).toEqual([buildFileUri("/work/huge.png")])
    expect(result.current.imageAttachments).toEqual([])
    quiet.mockRestore()
  })

  it("reports false when the clipboard holds no files, or cannot be read", async () => {
    const { result } = renderAttachments()
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(false)
    })
    clipboard.files = null
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(false)
    })
    expect(fileBadgeUris()).toEqual([])
  })

  it("does nothing in a window bound to a remote workspace", async () => {
    env.remoteId = 7
    clipboard.files = [
      {
        path: "/work/report.docx",
        name: "report.docx",
        size: 204,
        isDir: false,
      },
    ]
    const { result } = renderAttachments()
    await act(async () => {
      expect(await result.current.appendClipboardFiles()).toBe(false)
    })
    expect(fileBadgeUris()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 系统拖放（Tauri 的 drag-drop 窗口事件）落在对话区里

type Hit = (x: number, y: number) => Element | null

let hit: Hit = () => null

function emit(name: string, payload: unknown) {
  for (const cb of tauri.listeners.get(name) ?? []) cb({ payload })
}

/** jsdom 的矩形全是 0；给一个够大的，落点都在里面，归谁由 `elementFromPoint` 定。 */
function withRect<T extends HTMLElement>(el: T): T {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      right: 2000,
      bottom: 2000,
      width: 2000,
      height: 2000,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect
  return el
}

/** 一个对话区：聊天记录、收起的那一条、输入框外框。 */
function mountZone() {
  const zone = withRect(document.createElement("div"))
  zone.setAttribute("data-conversation-shell", "")
  const transcript = document.createElement("div")
  const collapsedBar = document.createElement("button")
  const body = document.createElement("div")
  const host = withRect(document.createElement("div"))
  body.append(host)
  zone.append(transcript, collapsedBar, body)
  document.body.append(zone)
  return { zone, transcript, collapsedBar, body, host }
}

function renderDropTarget(opts: {
  host: HTMLElement
  zone?: HTMLElement
  disabled?: boolean
  target?: Editor
}) {
  const ed = opts.target ?? editor
  const editorRef = {
    current: { getEditor: () => ed } as unknown as RichComposerHandle,
  }
  const containerRef = { current: opts.host }
  const dropZoneRef = opts.zone ? { current: opts.zone } : undefined
  return renderHook(
    ({ disabled }: { disabled: boolean }) =>
      useComposerAttachments({
        editorRef,
        containerRef,
        dropZoneRef,
        disabled,
        promptCapabilities: { image: true, embedded_context: true },
        attachmentTabId: "tab-1",
      }),
    { initialProps: { disabled: opts.disabled ?? false } }
  )
}

async function listening(count = 1) {
  await waitFor(() =>
    expect(tauri.listeners.get("tauri://drag-drop")?.length ?? 0).toBe(count)
  )
}

function drop(paths: string[], position = { x: 40, y: 40 }) {
  act(() => emit("tauri://drag-drop", { paths, position }))
}

function badgesIn(target: Editor): string[] {
  const uris: string[] = []
  target.state.doc.descendants((node) => {
    if (node.type.name === "reference" && node.attrs.refType === "file") {
      uris.push(node.attrs.uri)
    }
  })
  return uris
}

describe("an OS drop anywhere in the conversation area", () => {
  let mounted: HTMLElement[] = []
  const track = <T extends { zone: HTMLElement }>(z: T): T => {
    mounted.push(z.zone)
    return z
  }

  beforeEach(() => {
    tauri.listeners.clear()
    platform.os = "linux"
    hit = () => null
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: (x: number, y: number) => hit(x, y),
    })
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 1,
    })
    vi.mocked(toast.error).mockClear()
    remoteUpload.uploadLocalPathToRemote.mockClear()
  })

  afterEach(() => {
    for (const el of mounted) el.remove()
    mounted = []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (document as any).elementFromPoint
  })

  it("lands in the composer when released over the transcript", async () => {
    const { zone, transcript, host } = track(mountZone())
    hit = () => transcript
    const { result } = renderDropTarget({ host, zone })
    await listening()
    drop(["/work/shot.png", "/work/notes.md"])
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
    expect(fileBadgeUris()).toEqual([buildFileUri("/work/notes.md")])
  })

  it("lands in a collapsed composer (hidden body, the collapsed bar on top)", async () => {
    const { zone, collapsedBar, body, host } = track(mountZone())
    body.style.visibility = "hidden"
    hit = () => collapsedBar
    const { result } = renderDropTarget({ host, zone })
    await listening()
    drop(["/work/shot.png"])
    await waitFor(() => expect(result.current.imageAttachments).toHaveLength(1))
  })

  it("goes only to the conversation area under the point", async () => {
    const a = track(mountZone())
    const b = track(mountZone())
    hit = () => b.transcript
    const second = new Editor({ extensions: buildComposerExtensions() })
    // 一个一个挂：两个输入框同时动态 import 被 mock 的模块时，vitest 给后到的
    // 那个真模块。
    const first = renderDropTarget({ host: a.host, zone: a.zone })
    await listening(1)
    const other = renderDropTarget({
      host: b.host,
      zone: b.zone,
      target: second,
    })
    await listening(2)
    drop(["/work/notes.md"])
    await waitFor(() =>
      expect(badgesIn(second)).toEqual([buildFileUri("/work/notes.md")])
    )
    expect(fileBadgeUris()).toEqual([])
    expect(first.result.current.attachments).toEqual([])
    expect(other.result.current.attachments).toEqual([])
    second.destroy()
  })

  it("converts the point once on macOS: no second guess divided by the DPR", async () => {
    platform.os = "macos"
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    })
    const a = track(mountZone())
    const b = track(mountZone())
    // (800, 400) 原样是第二个对话区；除以 2 的 (400, 200) 是第一个。
    hit = (x) => (x >= 600 ? b.transcript : a.transcript)
    const second = new Editor({ extensions: buildComposerExtensions() })
    renderDropTarget({ host: a.host, zone: a.zone })
    await listening(1)
    renderDropTarget({ host: b.host, zone: b.zone, target: second })
    await listening(2)
    drop(["/work/notes.md"], { x: 800, y: 400 })
    await waitFor(() =>
      expect(badgesIn(second)).toEqual([buildFileUri("/work/notes.md")])
    )
    expect(fileBadgeUris()).toEqual([])
    second.destroy()
  })

  it("divides by the DPR elsewhere", async () => {
    Object.defineProperty(window, "devicePixelRatio", {
      configurable: true,
      value: 2,
    })
    const { zone, transcript, host } = track(mountZone())
    const seen: Array<[number, number]> = []
    hit = (x, y) => {
      seen.push([x, y])
      return transcript
    }
    renderDropTarget({ host, zone })
    await listening()
    drop(["/work/notes.md"], { x: 800, y: 400 })
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([buildFileUri("/work/notes.md")])
    )
    expect(seen).toEqual([[400, 200]])
  })

  it("ignores a drop outside every conversation area (sidebar, file panel)", async () => {
    const { zone, host } = track(mountZone())
    const sidebar = document.createElement("nav")
    document.body.append(sidebar)
    hit = () => sidebar
    const { result } = renderDropTarget({ host, zone })
    await listening()
    act(() => emit("tauri://drag-over", { position: { x: 40, y: 40 } }))
    expect(result.current.isZoneDragActive).toBe(false)
    drop(["/work/notes.md"])
    await new Promise((r) => setTimeout(r, 20))
    expect(fileBadgeUris()).toEqual([])
    sidebar.remove()
  })

  it("ignores a drop on a dialog covering the conversation area", async () => {
    const { zone, host } = track(mountZone())
    const dialog = document.createElement("div")
    dialog.setAttribute("role", "dialog")
    document.body.append(dialog)
    hit = () => dialog
    renderDropTarget({ host, zone })
    await listening()
    drop(["/work/notes.md"])
    await new Promise((r) => setTimeout(r, 20))
    expect(fileBadgeUris()).toEqual([])
    dialog.remove()
  })

  it("ignores a drop on a hidden conversation tab", async () => {
    const tab = document.createElement("div")
    tab.style.visibility = "hidden"
    document.body.append(tab)
    const z = mountZone()
    tab.append(z.zone)
    mounted.push(tab)
    hit = () => z.transcript
    renderDropTarget({ host: z.host, zone: z.zone })
    await listening()
    drop(["/work/notes.md"])
    await new Promise((r) => setTimeout(r, 20))
    expect(fileBadgeUris()).toEqual([])
  })

  it("reports the drag over the area until it leaves or drops", async () => {
    const { zone, transcript, host } = track(mountZone())
    const outside = document.createElement("nav")
    document.body.append(outside)
    hit = () => transcript
    const { result } = renderDropTarget({ host, zone })
    await listening()
    act(() =>
      emit("tauri://drag-enter", {
        paths: ["/work/notes.md"],
        position: { x: 40, y: 40 },
      })
    )
    expect(result.current.isZoneDragActive).toBe(true)
    // 区里经过时输入框自己那块小高亮不亮
    expect(result.current.isDragActive).toBe(false)
    hit = () => outside
    act(() => emit("tauri://drag-over", { position: { x: 1, y: 1 } }))
    expect(result.current.isZoneDragActive).toBe(false)
    hit = () => transcript
    act(() => emit("tauri://drag-over", { position: { x: 40, y: 40 } }))
    expect(result.current.isZoneDragActive).toBe(true)
    act(() => emit("tauri://drag-leave", {}))
    expect(result.current.isZoneDragActive).toBe(false)
    act(() => emit("tauri://drag-over", { position: { x: 40, y: 40 } }))
    expect(result.current.isZoneDragActive).toBe(true)
    drop(["/work/notes.md"])
    expect(result.current.isZoneDragActive).toBe(false)
    outside.remove()
  })

  it("explains instead of dropping silently while the composer is disabled", async () => {
    const { zone, transcript, host } = track(mountZone())
    hit = () => transcript
    const { result } = renderDropTarget({ host, zone, disabled: true })
    await listening()
    act(() => emit("tauri://drag-over", { position: { x: 40, y: 40 } }))
    expect(result.current.isZoneDragActive).toBe(false)
    drop(["/work/notes.md", "/work/shot.png"])
    await new Promise((r) => setTimeout(r, 20))
    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error).toHaveBeenCalledWith("dropRejectedNotReady")
    expect(result.current.attachments).toEqual([])
    expect(fileBadgeUris()).toEqual([])
  })

  it("uploads what lands in the area of a remote-workspace window", async () => {
    env.remoteId = 7
    const { zone, transcript, host } = track(mountZone())
    hit = () => transcript
    renderDropTarget({ host, zone })
    await listening()
    drop(["/work/notes.md"])
    await waitFor(() =>
      expect(remoteUpload.uploadLocalPathToRemote).toHaveBeenCalledWith(
        "/work/notes.md",
        "tab-1"
      )
    )
    await waitFor(() =>
      expect(fileBadgeUris()).toEqual([
        buildFileUri("/remote-uploads/notes.md"),
      ])
    )
  })

  describe("a composer outside any conversation area (to-do tasks)", () => {
    it("takes only drops on its own frame", async () => {
      const dialog = document.createElement("div")
      const host = withRect(document.createElement("div"))
      const elsewhere = document.createElement("div")
      dialog.append(host, elsewhere)
      document.body.append(dialog)
      mounted.push(dialog)
      hit = () => elsewhere
      const { result } = renderDropTarget({ host })
      await listening()
      act(() => emit("tauri://drag-over", { position: { x: 40, y: 40 } }))
      expect(result.current.isDragActive).toBe(false)
      drop(["/work/notes.md"])
      await new Promise((r) => setTimeout(r, 20))
      expect(fileBadgeUris()).toEqual([])

      hit = () => host
      act(() => emit("tauri://drag-over", { position: { x: 40, y: 40 } }))
      expect(result.current.isDragActive).toBe(true)
      expect(result.current.isZoneDragActive).toBe(false)
      drop(["/work/notes.md"])
      await waitFor(() =>
        expect(fileBadgeUris()).toEqual([buildFileUri("/work/notes.md")])
      )
    })
  })
})
