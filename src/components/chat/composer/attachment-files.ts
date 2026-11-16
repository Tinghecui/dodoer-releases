/**
 * Pure file/blob helpers shared by every composer that can take attachments.
 *
 * Extracted verbatim from `message-input.tsx` so the conversation composer and
 * the to-do task composers classify, name and encode a dropped/pasted/picked
 * file exactly the same way — one MIME table, one base64 reader. Nothing here
 * touches React or the editor except {@link editorHasFileReference}, which only
 * reads a Tiptap document.
 */

import type { Editor } from "@tiptap/core"

import { detectPlatform } from "@/hooks/use-platform"

const MIME_BY_EXT: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  csv: "text/csv",
  html: "text/html",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  ts: "text/typescript",
  tsx: "text/tsx",
  jsx: "text/jsx",
  py: "text/x-python",
  rs: "text/rust",
  go: "text/x-go",
  java: "text/x-java-source",
  xml: "application/xml",
  toml: "application/toml",
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
}

/** Ceiling on the bytes a dropped local image may inline for its thumbnail. */
export const DRAG_DROP_IMAGE_MAX_BYTES = 20_000_000

export function fileNameFromPath(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function mimeTypeFromPath(path: string): string | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? ""
  return MIME_BY_EXT[ext] ?? null
}

export function hasDragFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer?.types) return false
  return Array.from(dataTransfer.types).includes("Files")
}

/** 对话区（`ConversationShell` 的根）的标记。 */
export const CONVERSATION_DROP_ZONE_SELECTOR = "[data-conversation-shell]"

/**
 * 把 Tauri 给的拖放坐标换算成 CSS 像素（`elementFromPoint` 用的那种），只换一次，
 * 和文件树的拖放一样：macOS 上 wry 给的是窗口点，本来就等于 CSS 像素（Tauri 标成
 * physical 是标错了），原样用；别的系统给的是真的物理像素，除以 DPR。
 */
export function osDropPointToCss(position: { x: number; y: number }): {
  x: number
  y: number
} {
  const scale = detectPlatform() === "macos" ? 1 : window.devicePixelRatio || 1
  return { x: position.x / scale, y: position.y / scale }
}

/**
 * Whether an OS drag position (Tauri reports window coordinates) lands on
 * `element` **and** `element` is what the user would actually hit there.
 * `element` 是对话区的根，或者没有对话区的输入框（待办任务的）自己的外框。
 *
 * Guards, all needed because a Tauri drag-drop event is delivered to every
 * listener in the window:
 *
 * - Hidden/detached hosts are rejected outright. Inactive conversation tabs stay
 *   mounted at `absolute inset-0` with `visibility: hidden`, so their bounding
 *   rect overlaps the active tab's — without this, one OS drop would fan out
 *   across every open conversation. 这条查的是对话区：收起的输入框外框本来就是
 *   hidden，不能拿它判。
 * - The point is converted once ({@link osDropPointToCss}). 原样和除以 DPR 两种
 *   都试的话，分栏时一个文件会进两个对话。
 * - The topmost element at the point must be inside the host. A composer sitting
 *   behind a modal (the to-do task editor dialog, the detail drawer) still has
 *   its full rect at the same coordinates; `elementFromPoint` is what tells the
 *   two apart, so the drop lands only in the composer the user can see. 对话区
 *   套着对话区时，只算离落点最近的那个。
 */
export function pointWithinElement(
  position: { x: number; y: number },
  element: HTMLElement
): boolean {
  const doc = element.ownerDocument
  const style = doc?.defaultView?.getComputedStyle(element)
  if (style) {
    if (
      style.visibility === "hidden" ||
      style.display === "none" ||
      style.pointerEvents === "none"
    ) {
      return false
    }
  }
  const rect = element.getBoundingClientRect()
  if (rect.width === 0 || rect.height === 0) return false
  const point = osDropPointToCss(position)
  if (
    point.x < rect.left ||
    point.x > rect.right ||
    point.y < rect.top ||
    point.y > rect.bottom
  ) {
    return false
  }
  // `elementFromPoint` is unavailable in some test DOMs — fall back to the
  // rect result there rather than dropping the event on the floor.
  if (typeof doc?.elementFromPoint !== "function") return true
  const top = doc.elementFromPoint(point.x, point.y)
  if (top === null || !element.contains(top)) return false
  if (element.matches(CONVERSATION_DROP_ZONE_SELECTOR)) {
    return top.closest(CONVERSATION_DROP_ZONE_SELECTOR) === element
  }
  return true
}

export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => {
      reject(reader.error ?? new Error("Failed to read blob"))
    }
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Unexpected non-string blob reader result"))
        return
      }
      const markerIndex = reader.result.indexOf(",")
      resolve(
        markerIndex >= 0 ? reader.result.slice(markerIndex + 1) : reader.result
      )
    }
    reader.readAsDataURL(blob)
  })
}

export function getFilePath(file: File): string | null {
  const withPath = file as File & { path?: string; webkitRelativePath?: string }
  if (typeof withPath.path === "string" && withPath.path.trim().length > 0) {
    return withPath.path
  }
  if (
    typeof withPath.webkitRelativePath === "string" &&
    withPath.webkitRelativePath.trim().length > 0
  ) {
    return withPath.webkitRelativePath
  }
  return null
}

/** Whether the document already holds a `refType` reference badge for `uri`. */
export function editorHasReference(
  editor: Editor,
  refType: string,
  uri: string
): boolean {
  let found = false
  editor.state.doc.descendants((node) => {
    if (found) return false
    if (
      node.type.name === "reference" &&
      node.attrs?.refType === refType &&
      node.attrs?.uri === uri
    ) {
      found = true
      return false
    }
    return true
  })
  return found
}

/** Whether the document already holds a file reference badge for `uri` (used to
 *  dedupe repeated drops/picks of the same path, mirroring the old seen-set). */
export function editorHasFileReference(editor: Editor, uri: string): boolean {
  return editorHasReference(editor, "file", uri)
}
