const RENAME_SEPARATOR = " -> "

/**
 * 只有改名（R）和复制（C）的状态行才是「旧名 -> 新名」。别的状态行即使文件名
 * 里本来就带「 -> 」，也是一个完整的文件名，不能拆。
 */
export function isRenameStatus(status: string): boolean {
  return /[RC]/.test(status)
}

/**
 * git 状态里改名的一行是「旧名 -> 新名」（后端已经去掉了引号）。按最后一个
 * 「 -> 」切开：file 是新名，originalFile 是旧名；不是改名时没有 originalFile。
 * 写法和「变更」面板、文件树里取新名的那份一致。
 */
export function splitGitStatusRename(raw: string): {
  file: string
  originalFile?: string
} {
  const index = raw.lastIndexOf(RENAME_SEPARATOR)
  if (index < 0) return { file: raw }
  // 文件名首尾可以是空格，不能 trim（后端已经去掉了 git 加的引号）
  const originalFile = raw.slice(0, index)
  const file = raw.slice(index + RENAME_SEPARATOR.length)
  if (!originalFile || !file) return { file: raw }
  return { file, originalFile }
}

/**
 * 回滚 target（一个文件或目录，"." 是整个仓库）要交给恢复接口的路径。
 * 改名（R）的新名在 HEAD 里不存在，只恢复新名会把它删掉、旧名却留着暂存的删除，
 * 所以落在 target 里的改名要把旧名也一起恢复；旧名已经在 target 里的不用重复。
 * 旧名排在前面：先把旧文件恢复回来，再去掉新名。复制（C）的源文件没动，不加。
 * 旧名已经被状态里别的一行占着（比如改名后又在旧路径新建了未跟踪的文件）时也不加：
 * 按 HEAD 恢复旧名会覆盖那个文件，宁可旧名的暂存删除留着。
 */
export function rollbackPaths(
  target: string,
  entries: readonly { status: string; file: string; originalFile?: string }[]
): string[] {
  const covers = (path: string) =>
    target === "." || path === target || path.startsWith(`${target}/`)
  const occupied = new Set(entries.map((entry) => entry.file))
  const originals: string[] = []
  for (const entry of entries) {
    if (!entry.originalFile || !/R/.test(entry.status)) continue
    if (!covers(entry.file) || covers(entry.originalFile)) continue
    if (occupied.has(entry.originalFile)) continue
    if (!originals.includes(entry.originalFile)) {
      originals.push(entry.originalFile)
    }
  }
  return [...originals, target]
}
