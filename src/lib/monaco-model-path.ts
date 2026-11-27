// Monaco model URI for a file tab. Model identity must be collision-free
// across tabs: two distinct absolute paths must never map to the same URI,
// or Monaco would share one text model (and undo stack) between them.

/**
 * Build the Monaco model path for a tab. Pathless tabs (diffs) key on the
 * tab id. Absolute paths yield `file:///…`; a UNC `//server/share/…` keeps
 * its authority (`file://server/share/…`) so it can never collide with the
 * single-slash POSIX form of the same tail.
 */
export function buildMonacoModelPath(path: string | null, id: string): string {
  if (!path) return `inmemory://model/${encodeURIComponent(id)}`
  const normalized = path.replace(/\\/g, "/")
  if (normalized.startsWith("//")) {
    const encoded = normalized
      .slice(2)
      .split("/")
      .map(encodeURIComponent)
      .join("/")
    return `file://${encoded}`
  }
  // Trim the leading slashes of an absolute path — the scheme supplies
  // them; keeping them would yield "file:////…".
  const encoded = normalized
    .replace(/^\/+/, "")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
  return `file:///${encoded}`
}

/**
 * Model URIs of every open tab — the keep-set for reconciling Monaco's model
 * registry against the tab list (models whose tab has closed get disposed).
 * Every tab is included regardless of kind: tabs that never materialize a
 * model (rich diffs render their own editor) just never match a registry
 * entry.
 */
export function collectLiveModelPaths(
  tabs: ReadonlyArray<{ id: string; path: string | null }>
): string[] {
  const uris = new Set<string>()
  for (const tab of tabs) {
    uris.add(buildMonacoModelPath(tab.path, tab.id))
  }
  return [...uris]
}

/** Release only models whose last open buffer closed, never a hidden scope. */
export function disposeClosedEditorModels(
  tracked: Set<string>,
  live: ReadonlySet<string>,
  getModel: (
    uri: string
  ) => { isAttachedToEditor: () => boolean; dispose: () => void } | null
): void {
  for (const uri of [...tracked]) {
    if (live.has(uri)) continue
    const model = getModel(uri)
    if (model?.isAttachedToEditor()) continue
    model?.dispose()
    tracked.delete(uri)
  }
}

/**
 * 编辑器重新挂载时，@monaco-editor/react 会直接用同一路径留着的旧 model
 * （keepCurrentModel），不会把这次的 value 写进去；挂载那一刻的 value 也不算
 * 变化，不会再同步。标签内容才是准的：旧 model 的文字和它不一样时（比如上次
 * 读失败留下的错误文字、后来读成功了，#1511），在这里写进去。一样时不动，
 * 保住撤销记录。返回有没有改。
 */
export function syncRetainedModelValue(
  model: { getValue: () => string; setValue: (value: string) => void } | null,
  value: string
): boolean {
  if (!model || model.getValue() === value) return false
  model.setValue(value)
  return true
}
