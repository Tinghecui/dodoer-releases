export interface LineChangeStats {
  additions: number
  deletions: number
}

/**
 * Maximum product of changed-window line counts before both the collapsed stat
 * (the LIS below) and the expanded diff (`generateUnifiedDiff`'s LCS table)
 * stop computing an exact diff and treat the whole window as changed.
 *
 * This single ceiling is the crux of keeping the two consistent: because the
 * number of matching line pairs is ≤ the product of the line counts, one
 * product budget bounds BOTH the LIS work here and the O(n*m) diff table, and —
 * decisively — makes the two share ONE fallback trigger. Below the budget both
 * compute the exact line LCS (identical counts); at or above it both report the
 * full trimmed window (identical counts). They can therefore never disagree.
 *
 * Kept modest because the collapsed stat runs on every edit-card render;
 * localized edits trim to a tiny window regardless of file size, so only
 * genuinely huge contiguous rewrites (~1000+ changed lines) reach the fallback.
 */
export const LINE_DIFF_LCS_BUDGET = 1_000_000

/**
 * Whether a changed window is too large for an exact line LCS. Shared by the
 * collapsed stat and `generateUnifiedDiff` so they fall back in lockstep.
 */
export function exceedsLineDiffBudget(
  oldWindow: string[],
  newWindow: string[]
): boolean {
  return oldWindow.length * newWindow.length > LINE_DIFF_LCS_BUDGET
}

export function splitNormalizedLines(text: string): string[] {
  if (!text) return []
  const lines = text.split("\n")
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop()
  }
  return lines
}

/**
 * Strip the common leading/trailing lines shared by both sides, returning just
 * the changed window. Mirrors the trimming in `generateUnifiedDiff` so the
 * collapsed stat and the expanded diff are computed over the same region.
 */
function trimCommonOuterLines(
  oldLines: string[],
  newLines: string[]
): { oldWindow: string[]; newWindow: string[] } {
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }

  let suffix = 0
  while (
    suffix < oldLines.length - prefix &&
    suffix < newLines.length - prefix &&
    oldLines[oldLines.length - 1 - suffix] ===
      newLines[newLines.length - 1 - suffix]
  ) {
    suffix += 1
  }

  return {
    oldWindow: oldLines.slice(prefix, oldLines.length - suffix),
    newWindow: newLines.slice(prefix, newLines.length - suffix),
  }
}

function lowerBound(values: number[], target: number): number {
  let left = 0
  let right = values.length
  while (left < right) {
    const mid = left + ((right - left) >> 1)
    if (values[mid] < target) {
      left = mid + 1
    } else {
      right = mid
    }
  }
  return left
}

function lcsLengthByLine(oldLines: string[], newLines: string[]): number {
  const positions = new Map<string, number[]>()
  for (let i = 0; i < newLines.length; i += 1) {
    const line = newLines[i]
    const bucket = positions.get(line)
    if (bucket) {
      bucket.push(i)
    } else {
      positions.set(line, [i])
    }
  }

  const lis: number[] = []
  for (const line of oldLines) {
    const bucket = positions.get(line)
    if (!bucket || bucket.length === 0) continue

    for (let i = bucket.length - 1; i >= 0; i -= 1) {
      const pos = bucket[i]
      const at = lowerBound(lis, pos)
      if (at === lis.length) {
        lis.push(pos)
      } else {
        lis[at] = pos
      }
    }
  }

  return lis.length
}

export function estimateChangedLineStats(
  oldText: string,
  newText: string
): LineChangeStats {
  const oldLines = splitNormalizedLines(oldText)
  const newLines = splitNormalizedLines(newText)

  if (oldLines.length === 0 && newLines.length === 0) {
    return { additions: 0, deletions: 0 }
  }
  if (oldLines.length === 0) {
    return { additions: newLines.length, deletions: 0 }
  }
  if (newLines.length === 0) {
    return { additions: 0, deletions: oldLines.length }
  }

  // Trim the common prefix/suffix first so this estimate runs on the same
  // changed window the unified diff renders from (generateUnifiedDiff trims
  // identically). For the normal LCS path this is mathematically equal to
  // diffing the full text — common outer lines belong to every LCS — but it
  // keeps the collapsed +N/−M stat in agreement with the expanded diff when the
  // pair-budget fallback would otherwise diverge (e.g. a large duplicate prefix
  // that the diff trims away before counting).
  const { oldWindow, newWindow } = trimCommonOuterLines(oldLines, newLines)
  if (oldWindow.length === 0) {
    return { additions: newWindow.length, deletions: 0 }
  }
  if (newWindow.length === 0) {
    return { additions: 0, deletions: oldWindow.length }
  }

  // Window too large / duplicate-heavy for an exact LCS: report the whole
  // (already-trimmed) window as changed. generateUnifiedDiff applies the SAME
  // gate, so the collapsed stat and the expanded diff fall back together and
  // their +/- counts stay identical.
  if (exceedsLineDiffBudget(oldWindow, newWindow)) {
    return { additions: newWindow.length, deletions: oldWindow.length }
  }

  const lcs = lcsLengthByLine(oldWindow, newWindow)
  return {
    additions: Math.max(0, newWindow.length - lcs),
    deletions: Math.max(0, oldWindow.length - lcs),
  }
}

/**
 * 字符串替换式编辑（Edit 的 old_string / new_string）的两段片段，后面接的
 * 是文件里同一段内容。只有一边以换行结尾时（「y」改成「y\n」），切行时
 * 结尾的换行被去掉，两边都是 ["y"]，比不出差别；这时给两边各补一个换行再比，
 * 多出的那个空行才算得出来。两边都以换行结尾或都不以换行结尾的，切行对两边
 * 一样，不补（补了会在 diff 里多出一行空的公共上下文，块头行数和正文对不上）。
 * 有一边是空的（新建、整段删除）也不补，按原样比。
 *
 * 片段看不出文件原来最后一行有没有换行：没有的话，「y」改成「y\n」其实只是
 * 补上结尾换行，这里仍按多了一个空行算（文件一般以换行结尾，按常见情况）。
 */
export function editFragmentTexts(
  oldText: string,
  newText: string
): { oldText: string; newText: string } {
  if (!oldText || !newText) return { oldText, newText }
  if (oldText.endsWith("\n") === newText.endsWith("\n")) {
    return { oldText, newText }
  }
  return { oldText: `${oldText}\n`, newText: `${newText}\n` }
}

/**
 * 纯插入的编辑（去掉片段里相同的首尾行以后旧的一边是空的），插入的几行和
 * 片段后面紧跟的文件行一样时，对整个文件做 diff 会把插入往后挪（连续空行
 * 末尾再加一个空行，算在最后）。片段看不到后面的文件内容，后端读文件算出
 * 插入真正的起始行 `changeStartLine`（工具输入里的 `_change_start_line`）。
 *
 * 往后挪了 d 行，说明片段后面那 d 行就是插入的几行轮着排下去；把这 d 行补到
 * 两边片段的末尾，再按片段算行号、生成 diff，就和整个文件的 diff 一样。
 * 先按 `editFragmentTexts` 补齐换行。`changeStartLine` 对不上（不是纯插入、
 * 不比片段里的插入位置靠后、片段不以换行结尾）时只做补齐。
 */
export function editFragmentTextsAt(
  oldText: string,
  newText: string,
  startLine: number | undefined,
  changeStartLine: number | undefined
): { oldText: string; newText: string } {
  const padded = editFragmentTexts(oldText, newText)
  if (
    startLine === undefined ||
    changeStartLine === undefined ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(changeStartLine) ||
    startLine <= 0 ||
    !padded.oldText.endsWith("\n") ||
    !padded.newText.endsWith("\n")
  ) {
    return padded
  }
  const oldLines = splitNormalizedLines(padded.oldText)
  const newLines = splitNormalizedLines(padded.newText)
  let prefix = 0
  while (
    prefix < oldLines.length &&
    prefix < newLines.length &&
    oldLines[prefix] === newLines[prefix]
  ) {
    prefix += 1
  }
  const inserted = newLines.slice(prefix)
  // 旧的一边整个是新的一边的开头，才是插在片段末尾、可能往后挪的纯插入
  if (prefix !== oldLines.length || inserted.length === 0) return padded
  const shift = changeStartLine - (startLine + prefix)
  if (shift <= 0 || shift > MAX_SLIDE_LINES) return padded
  const following = Array.from(
    { length: shift },
    (_, i) => inserted[i % inserted.length]
  )
  const tail = `${following.join("\n")}\n`
  return { oldText: padded.oldText + tail, newText: padded.newText + tail }
}

// 往后挪的行数上限：防一个错的 `_change_start_line` 让片段变得很长
const MAX_SLIDE_LINES = 10_000

/** 字符串替换式编辑的增删行数：`editFragmentTexts` 补齐后再比。 */
export function estimateEditFragmentStats(
  oldText: string,
  newText: string
): LineChangeStats {
  const padded = editFragmentTexts(oldText, newText)
  return estimateChangedLineStats(padded.oldText, padded.newText)
}

const UNIFIED_HUNK_HEADER = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/

export function countUnifiedDiffLineChanges(text: string): LineChangeStats {
  const lines = text.split("\n")

  // Precise path for real unified diffs: walk each `@@` hunk and consume exactly
  // the number of old/new lines it declares. This attributes every body line by
  // POSITION, so a deletion/addition whose content itself begins with `--- `/
  // `+++ ` (source that starts with `-- `/`++ `, emitted as `--- `/`+++ `) is
  // counted correctly instead of being mistaken for a `--- a/…`/`+++ b/…` file
  // header — which a pure prefix scan cannot disambiguate.
  if (lines.some((line) => UNIFIED_HUNK_HEADER.test(line))) {
    let additions = 0
    let deletions = 0
    let i = 0
    while (i < lines.length) {
      const header = UNIFIED_HUNK_HEADER.exec(lines[i])
      i += 1
      if (!header) continue

      // Omitted count means 1 (`@@ -a +c @@`).
      let oldRemaining = header[1] === undefined ? 1 : Number(header[1])
      let newRemaining = header[2] === undefined ? 1 : Number(header[2])
      while (i < lines.length && (oldRemaining > 0 || newRemaining > 0)) {
        const line = lines[i]
        i += 1
        if (line.startsWith("\\")) continue // "\ No newline at end of file"
        if (line.startsWith("-")) {
          deletions += 1
          oldRemaining -= 1
        } else if (line.startsWith("+")) {
          additions += 1
          newRemaining -= 1
        } else {
          // Context line (leading space); belongs to both sides.
          oldRemaining -= 1
          newRemaining -= 1
        }
      }
    }
    return { additions, deletions }
  }

  // Header-less +/- block (e.g. a new-file diff without `@@` hunks): prefix scan,
  // skipping the `--- a/…` / `+++ b/…` file-header lines (which carry a trailing
  // space before the path).
  let additions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.startsWith("+") && !/^\+\+\+ /.test(line)) additions += 1
    if (line.startsWith("-") && !/^--- /.test(line)) deletions += 1
  }
  return { additions, deletions }
}

/** 一次字符串替换式的编辑：把 oldText 换成 newText（replaceAll 时全部替换）。 */
export interface TextEdit {
  oldText: string
  newText: string
  replaceAll?: boolean
}

function countNewlines(text: string): number {
  let count = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) count++
  }
  return count
}

/**
 * 把编辑依次套到已知的文件内容上，得到改完的内容；有一处对不上（找不到
 * oldText）就返回 null，调用方改用 `textEditsLineDelta` 估算。
 */
export function applyTextEdits(
  content: string,
  edits: TextEdit[]
): string | null {
  let next = content
  for (const edit of edits) {
    if (!edit.oldText) {
      // 空的 oldText 只在文件本来是空的时候说得通（整篇写入）
      if (next) return null
      next = edit.newText
      continue
    }
    const index = next.indexOf(edit.oldText)
    if (index < 0) return null
    next = edit.replaceAll
      ? next.split(edit.oldText).join(edit.newText)
      : next.slice(0, index) +
        edit.newText +
        next.slice(index + edit.oldText.length)
  }
  return next
}

/**
 * 不知道文件内容时，这些编辑让文件行数净变了多少：按换行符的增减算。
 * 只看行的增删估算（`estimateChangedLineStats`）会漏掉「b」改成「b\n」这种
 * 多出一个空行的情况，按换行符数就不会。
 */
export function textEditsLineDelta(edits: TextEdit[]): number {
  let delta = 0
  for (const edit of edits) {
    delta += countNewlines(edit.newText) - countNewlines(edit.oldText)
  }
  return delta
}

/**
 * 把补丁 `*** Update File:` 段的正文（`@@` 分块，行首是空格 / `-` / `+`）
 * 套到已知的文件内容上，得到改完的内容；有一块对不上就返回 null，调用方
 * 改用补丁的净增减估算。
 */
export function applyPatchHunks(
  content: string,
  body: string[]
): string | null {
  const lines = splitNormalizedLines(content)
  // 正文结尾的换行切出来的空串不是一行上下文
  let end = body.length
  while (end > 0 && body[end - 1] === "") end--
  const hunks: { oldLines: string[]; newLines: string[] }[] = []
  let hunk: { oldLines: string[]; newLines: string[] } | null = null
  for (const line of body.slice(0, end)) {
    if (line.startsWith("@@")) {
      hunk = { oldLines: [], newLines: [] }
      hunks.push(hunk)
      continue
    }
    // 「文件结尾」标记和「\ No newline at end of file」不影响行
    if (line.startsWith("*** ") || line.startsWith("\\")) continue
    if (!hunk) {
      // 有的补丁第一块前面不写 @@
      hunk = { oldLines: [], newLines: [] }
      hunks.push(hunk)
    }
    if (line.startsWith("+")) {
      hunk.newLines.push(line.slice(1))
    } else if (line.startsWith("-")) {
      hunk.oldLines.push(line.slice(1))
    } else if (line.startsWith(" ") || line === "") {
      // 上下文行；空行的上下文有时连行首的空格也省掉
      hunk.oldLines.push(line.slice(1))
      hunk.newLines.push(line.slice(1))
    } else {
      return null
    }
  }

  const out: string[] = []
  let cursor = 0
  for (const { oldLines, newLines } of hunks) {
    if (oldLines.length === 0) {
      // 纯插入、没有上下文：加在文件末尾
      out.push(...lines.slice(cursor), ...newLines)
      cursor = lines.length
      continue
    }
    let at = -1
    for (let i = cursor; i + oldLines.length <= lines.length; i++) {
      if (oldLines.every((line, k) => lines[i + k] === line)) {
        at = i
        break
      }
    }
    if (at < 0) return null
    out.push(...lines.slice(cursor, at), ...newLines)
    cursor = at + oldLines.length
  }
  out.push(...lines.slice(cursor))
  return out.length > 0 ? `${out.join("\n")}\n` : ""
}
