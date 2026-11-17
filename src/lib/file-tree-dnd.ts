/**
 * Shared drag-and-drop contract for the workspace file tree. A single MIME type
 * and payload shape are read by two independent drop targets:
 *  - the tree itself (drop a node onto a directory → move it there), and
 *  - the message composer (drop a node onto the input → insert a file reference).
 *
 * The payload is serialized as JSON on a private MIME type so it can't be
 * confused with an OS file drop (`dataTransfer.files` / the `"Files"` type) or a
 * plain-text drop. A `text/plain` fallback (the absolute path) is set alongside
 * so dropping onto a terminal or a plain text field still yields something
 * useful.
 */

/** Private MIME type carrying the JSON {@link FileTreeDragPayload}. Lowercase to
 * match how `DataTransfer.types` normalizes custom types. */
export const FILE_TREE_DND_MIME = "application/x-codeg-tree-entry"

/** The five kinds of inline reference the composer can embed — mirrors the
 * tree node kinds it can carry. */
export interface FileTreeDragPayload {
  /** Absolute workspace root path the entry lives under. */
  rootPath: string
  /** Entry path relative to {@link rootPath} (forward slashes). */
  relPath: string
  /** Absolute path of the entry (`rootPath` joined with `relPath`). */
  absPath: string
  /** Leaf name of the entry. */
  name: string
  kind: "file" | "dir"
}

/**
 * The subset of `DataTransfer` the codec touches. Declaring it structurally
 * keeps the helpers unit-testable with a plain mock (jsdom's `DataTransfer` does
 * not implement `setData`/`getData` faithfully).
 */
export interface DragDataLike {
  setData: (format: string, data: string) => void
  getData: (format: string) => string
  readonly types: ReadonlyArray<string>
}

/**
 * Write the payload onto a drag's `dataTransfer`: the private JSON type (read
 * back by our drop targets) plus a `text/plain` absolute-path fallback for
 * foreign drop targets. Callers set `effectAllowed` separately since the tree
 * ("move") and composer ("copy") diverge.
 */
export function writeFileTreeDragData(
  dataTransfer: DragDataLike,
  payload: FileTreeDragPayload
): void {
  dataTransfer.setData(FILE_TREE_DND_MIME, JSON.stringify(payload))
  dataTransfer.setData("text/plain", payload.absPath)
}

/**
 * Whether a drag carries a file-tree payload. Reads `types` (available in
 * `dragover`, unlike `getData`), so a drop target can decide to accept the drop
 * before it lands.
 */
export function hasFileTreeDragType(
  dataTransfer: Pick<DragDataLike, "types"> | null | undefined
): boolean {
  if (!dataTransfer) return false
  // `types` entries are lowercased by the platform; compare accordingly.
  return Array.from(dataTransfer.types).some(
    (type) => type.toLowerCase() === FILE_TREE_DND_MIME
  )
}

/**
 * Parse the file-tree payload from a completed drop, or null when the drag
 * carries none or the JSON is malformed / the wrong shape. Only valid to call in
 * a `drop` handler (where `getData` returns data).
 */
export function readFileTreeDragPayload(
  dataTransfer: DragDataLike | null | undefined
): FileTreeDragPayload | null {
  if (!dataTransfer) return null
  const raw = dataTransfer.getData(FILE_TREE_DND_MIME)
  if (!raw) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== "object") return null
  const candidate = parsed as Record<string, unknown>
  const { rootPath, relPath, absPath, name, kind } = candidate
  if (
    typeof rootPath !== "string" ||
    typeof relPath !== "string" ||
    typeof absPath !== "string" ||
    typeof name !== "string" ||
    (kind !== "file" && kind !== "dir")
  ) {
    return null
  }
  return { rootPath, relPath, absPath, name, kind }
}

// 桌面版：当前是不是正在从文件树拖东西。文件树拖动开始时设、结束（含取消）时清。
// Tauri 的拖放事件里文件树拖动不带路径，和从别的应用拖文字进来分不开，
// 输入框那边靠它决定对话区要不要高亮（见 `useComposerAttachments`）。
let fileTreeDragActive = false

/** 文件树拖动开始（true）或结束（false）时调用。 */
export function setFileTreeDragActive(active: boolean): void {
  fileTreeDragActive = active
}

/** 当前是不是正在从文件树拖东西。 */
export function isFileTreeDragActive(): boolean {
  return fileTreeDragActive
}

/**
 * DOM attribute marking a directory drop zone. Its value is the destination
 * directory path relative to the workspace root (`""` = the root itself).
 */
export const FILE_TREE_DROP_DIR_ATTR = "data-tree-drop-dir"
/**
 * DOM attribute marking the message composer as a drop zone. Its value is the
 * composer's attachment tab id, used to route a dropped entry to that specific
 * session's input.
 */
export const FILE_TREE_DROP_COMPOSER_ATTR = "data-tree-drop-composer"

/** 对话区（`ConversationShell` 的根）的标记，和
 *  `CONVERSATION_DROP_ZONE_SELECTOR`（composer/attachment-files.ts）是同一个。 */
const CONVERSATION_SHELL_SELECTOR = "[data-conversation-shell]"

/**
 * 落点在某个对话区里、但不在输入框外框上时（聊天记录、收起的那一条），找这个对话区
 * 自己的输入框：取离落点最近的对话区，在里面找直接属于它的输入框（跳过嵌套在里层
 * 对话区里的）。用选择器找而不是按坐标取，输入框收起、本体看不见时也找得到。
 */
function composerInConversationShell(element: Element): Element | null {
  const shell = element.closest(CONVERSATION_SHELL_SELECTOR)
  if (!shell) return null
  for (const el of shell.querySelectorAll(
    `[${FILE_TREE_DROP_COMPOSER_ATTR}]`
  )) {
    if (el.closest(CONVERSATION_SHELL_SELECTOR) !== shell) continue
    if (el.getAttribute(FILE_TREE_DROP_COMPOSER_ATTR)) return el
  }
  return null
}

/** Where a file-tree drag landed, resolved from the element under the drop
 *  point. `dir` moves the entry; `composer` inserts a file reference. */
export type FileTreeDropZone =
  | { kind: "dir"; destDir: string }
  | { kind: "composer"; tabId: string }

/**
 * Resolve the drop zone under `element` by walking up to the nearest marked
 * ancestor. Used by the desktop drop path, where Tauri's webview consumes the
 * HTML5 `drop` event before WebKit dispatches it to the DOM (its native
 * drag-drop handler always reports the drop as handled), so a drag is committed
 * from Tauri's own drag-drop event by hit-testing the drop coordinates rather
 * than from a `drop` handler that never runs. Returns null when the point isn't
 * over a directory row, the workspace-root row, a composer, or a conversation
 * area that contains a composer (anywhere in a conversation area counts as its
 * own composer — the area lights up as one drop zone during the drag).
 */
export function resolveFileTreeDropZone(
  element: Element | null
): FileTreeDropZone | null {
  if (!element) return null
  const dirEl = element.closest(`[${FILE_TREE_DROP_DIR_ATTR}]`)
  const composerEl = element.closest(`[${FILE_TREE_DROP_COMPOSER_ATTR}]`)
  const toDir = (el: Element): FileTreeDropZone => ({
    kind: "dir",
    destDir: el.getAttribute(FILE_TREE_DROP_DIR_ATTR) ?? "",
  })
  const toComposer = (el: Element): FileTreeDropZone | null => {
    const tabId = el.getAttribute(FILE_TREE_DROP_COMPOSER_ATTR)
    return tabId ? { kind: "composer", tabId } : null
  }
  // The tree and the composer never nest, but if both matched, prefer the
  // deeper (more specific) zone.
  if (dirEl && composerEl) {
    return composerEl.contains(dirEl) ? toDir(dirEl) : toComposer(composerEl)
  }
  if (dirEl) return toDir(dirEl)
  if (composerEl) return toComposer(composerEl)
  const shellComposer = composerInConversationShell(element)
  return shellComposer ? toComposer(shellComposer) : null
}
