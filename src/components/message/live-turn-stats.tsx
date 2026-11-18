"use client"

import { useEffect, useMemo, useState, type ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import type {
  LiveContentBlock,
  LiveMessage,
} from "@/contexts/acp-connections-context"
import { inferLiveToolName } from "@/lib/tool-call-normalization"
import {
  toolCallFailedOrRejected,
  writeOverwritePatch,
} from "@/lib/session-files"
import { countLines } from "@/lib/activity/format"
import { formatElapsedLabel } from "@/lib/format-elapsed"
import {
  applyPatchHunks,
  applyTextEdits,
  countUnifiedDiffLineChanges,
  estimateEditFragmentStats,
  textEditsLineDelta,
  type TextEdit,
} from "@/lib/line-change-stats"
import { FilePenLine, Plane, Timer } from "lucide-react"
import { useTokenOutputSpeed } from "@/hooks/use-token-output-speed"
import type { AwaitingUserKind } from "@/stores/awaiting-user-store"

interface LiveTurnStatsProps {
  /** The running turn; `null` once it has ended while `trailing` still has
   *  something to say (work the turn left running). */
  message: LiveMessage | null
  /** Drawn after the figures, at the row's end — the "N running" chip. */
  trailing?: ReactNode
  /**
   * Cowork: what the agent is parked on the user for (`useAwaitingUser`, the
   * source of the sidebar's "needs your answer" mark). The one state this row
   * names: the turn is still running while it waits, its clock included, and
   * nothing in the figures says it is the user's move.
   */
  awaitingUser?: AwaitingUserKind | null
}

/** The sidebar badge's wording (`Folder.sidebar`), so both places name the
 *  wait alike in every locale. */
const AWAITING_USER_LABEL: Record<
  AwaitingUserKind,
  | "statusAwaitingQuestionBadge"
  | "statusAwaitingPermissionBadge"
  | "statusAwaitingPlanBadge"
> = {
  question: "statusAwaitingQuestionBadge",
  permission: "statusAwaitingPermissionBadge",
  plan: "statusAwaitingPlanBadge",
}

interface LineChangeStats {
  additions: number
  deletions: number
}

interface LiveEditStats extends LineChangeStats {
  files: number
}

function formatCompactInt(n: number, formatter: Intl.NumberFormat): string {
  if (n < 1000) return String(n)
  return formatter.format(n)
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function parseInputObject(
  input: string | null
): Record<string, unknown> | null {
  if (!input) return null
  try {
    return asObject(JSON.parse(input))
  } catch {
    return null
  }
}

function unescapeInlineEscapes(text: string): string {
  return text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, "\t")
}

function looksLikeDiffPayload(input: string): boolean {
  const normalized = unescapeInlineEscapes(input)
  return (
    normalized.includes("*** Begin Patch") ||
    normalized.includes("*** Update File:") ||
    /^diff --git /m.test(normalized) ||
    (/^--- .+/m.test(normalized) && /^\+\+\+ .+/m.test(normalized)) ||
    /^@@ /m.test(normalized)
  )
}

function extractPatchText(
  rawInput: string | null,
  parsed: Record<string, unknown> | null
): string | null {
  if (!rawInput) return null
  if (looksLikeDiffPayload(rawInput)) return unescapeInlineEscapes(rawInput)
  if (!parsed) return null

  const candidates = [
    parsed.patch,
    parsed.diff,
    parsed.unified_diff,
    parsed.unifiedDiff,
    parsed.command,
    parsed.input,
    parsed.arguments,
    parsed.payload,
  ]

  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue
    if (looksLikeDiffPayload(candidate)) return unescapeInlineEscapes(candidate)
  }

  return null
}

function addPathIfValid(paths: Set<string>, value: unknown): void {
  if (typeof value !== "string") return
  const path = value.trim()
  if (!path) return
  paths.add(path)
}

function collectParsedPaths(
  parsed: Record<string, unknown> | null
): Set<string> {
  const paths = new Set<string>()
  if (!parsed) return paths

  addPathIfValid(
    paths,
    parsed.file_path ?? parsed.filePath ?? parsed.path ?? parsed.notebook_path
  )

  const changes = asObject(parsed.changes)
  if (changes) {
    for (const path of Object.keys(changes)) {
      addPathIfValid(paths, path)
    }
  }

  return paths
}

interface FileLineChange {
  path: string
  additions: number
  deletions: number
  // 这次新建了它（write 整篇写入、补丁 Add File）：写入的内容
  created?: string
  // write 覆盖的是已经存在的文件（结果里带了改动补丁）：本轮没新建过它的话
  // 算修改，增删是补丁的
  overwritesExisting?: boolean
  // 这次是字符串替换式的编辑：能套到已知内容上
  edits?: TextEdit[]
  // 这次是补丁的 Update File 段：段里的正文，能套到已知内容上
  patchHunks?: string[]
}

function addFileChange(
  perFile: Map<string, FileLineChange>,
  path: string,
  additions: number,
  deletions: number
): void {
  const entry = perFile.get(path) ?? { path, additions: 0, deletions: 0 }
  entry.additions += additions
  entry.deletions += deletions
  perFile.set(path, entry)
}

function parseApplyPatchStats(patch: string): {
  files: Set<string>
  additions: number
  deletions: number
  // 补丁里每个文件各自的增删（跟在 *** Add/Update/Delete File 或 +++ 后面的行）；
  // 出现在任何文件头之前的行记不到文件上，只算进上面的总数。
  perFile: Map<string, FileLineChange>
} {
  const files = new Set<string>()
  const perFile = new Map<string, FileLineChange>()
  let additions = 0
  let deletions = 0
  let current: string | null = null
  // 正在读的 Add File 段写入的行（不在 Add File 段里时是 null）
  let addedLines: string[] | null = null
  const added = new Map<string, string[]>()
  // 正在读的 Update File 段的正文（不在 Update File 段里时是 null）
  let updateLines: string[] | null = null
  const updated = new Map<string, string[]>()
  // 在 *** Add/Update/Delete File 段里：段里 + / - 开头的行都是内容，
  // 「++ x」「-- x」写出来的「+++ x」「--- x」不是 unified diff 的文件头
  let inPatchSection = false

  const setCurrent = (value: string) => {
    const path = value.trim()
    current = path || null
    if (current) files.add(current)
    addedLines = null
    updateLines = null
  }

  for (const line of patch.split("\n")) {
    if (line.startsWith("*** Add File: ")) {
      setCurrent(line.slice(14))
      inPatchSection = true
      if (current) {
        addedLines = []
        added.set(current, addedLines)
      }
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      setCurrent(line.slice(17))
      inPatchSection = true
      if (current) {
        updateLines = updated.get(current) ?? []
        updated.set(current, updateLines)
      }
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      setCurrent(line.slice(17))
      inPatchSection = true
      continue
    }
    if (
      line.startsWith("*** End Patch") ||
      line.startsWith("*** Begin Patch")
    ) {
      current = null
      addedLines = null
      updateLines = null
      inPatchSection = false
      continue
    }
    if (inPatchSection) {
      updateLines?.push(line)
      if (line.startsWith("+")) {
        additions += 1
        if (current) addFileChange(perFile, current, 1, 0)
        addedLines?.push(line.slice(1))
      } else if (line.startsWith("-")) {
        deletions += 1
        if (current) addFileChange(perFile, current, 0, 1)
      }
      continue
    }
    if (line.startsWith("+++ ")) {
      const normalized = line.slice(4).replace(/^b\//, "").trim()
      if (normalized && normalized !== "/dev/null") {
        setCurrent(normalized)
      }
      continue
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      additions += 1
      if (current) addFileChange(perFile, current, 1, 0)
      addedLines?.push(line.slice(1))
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      deletions += 1
      if (current) addFileChange(perFile, current, 0, 1)
    }
  }

  for (const [path, lines] of added) {
    const entry = perFile.get(path) ?? { path, additions: 0, deletions: 0 }
    entry.created = lines.length > 0 ? `${lines.join("\n")}\n` : ""
    perFile.set(path, entry)
  }
  for (const [path, lines] of updated) {
    const entry = perFile.get(path)
    // 同一个文件既有 Add 又有 Update 段的，按新建算
    if (entry && entry.created === undefined) entry.patchHunks = lines
  }

  return { files, additions, deletions, perFile }
}

function extractEditStats(parsed: Record<string, unknown>): LineChangeStats & {
  // `changes` 形式的多文件 edit：每个文件各自的增删
  perFile: Map<string, FileLineChange> | null
  // 单个文件的 old/new 编辑
  edits: TextEdit[] | null
} {
  const changes = asObject(parsed.changes)
  if (changes) {
    let additions = 0
    let deletions = 0
    const perFile = new Map<string, FileLineChange>()

    for (const [rawPath, change] of Object.entries(changes)) {
      const record = asObject(change)
      if (!record) continue
      const path = rawPath.trim()

      const unifiedDiff =
        (typeof record.unifiedDiff === "string" && record.unifiedDiff) ||
        (typeof record.unified_diff === "string" && record.unified_diff) ||
        null

      let stats: LineChangeStats
      let edit: TextEdit | null = null
      if (unifiedDiff) {
        stats = countUnifiedDiffLineChanges(unifiedDiff)
      } else {
        const oldString =
          (typeof record.oldText === "string" && record.oldText) ||
          (typeof record.old_string === "string" && record.old_string) ||
          ""
        const newString =
          (typeof record.newText === "string" && record.newText) ||
          (typeof record.new_string === "string" && record.new_string) ||
          ""
        stats = estimateEditFragmentStats(oldString, newString)
        edit = { oldText: oldString, newText: newString }
      }
      additions += stats.additions
      deletions += stats.deletions
      if (path) {
        perFile.set(path, {
          path,
          additions: stats.additions,
          deletions: stats.deletions,
          // unified diff 形式的改动没有原文和新文，套不到内容上
          ...(edit ? { edits: [edit] } : {}),
        })
      }
    }

    return { additions, deletions, perFile, edits: null }
  }

  const oldString =
    (typeof parsed.old_string === "string" && parsed.old_string) ||
    (typeof parsed.oldText === "string" && parsed.oldText) ||
    ""
  const newString =
    (typeof parsed.new_string === "string" && parsed.new_string) ||
    (typeof parsed.newText === "string" && parsed.newText) ||
    ""

  return {
    ...estimateEditFragmentStats(oldString, newString),
    perFile: null,
    edits:
      oldString || newString
        ? [
            {
              oldText: oldString,
              newText: newString,
              replaceAll: parsed.replace_all === true,
            },
          ]
        : null,
  }
}

function extractWriteStats(
  parsed: Record<string, unknown>
): LineChangeStats & { content: string } {
  const content =
    (typeof parsed.content === "string" && parsed.content) ||
    (typeof parsed.new_source === "string" && parsed.new_source) ||
    ""

  // 结尾的换行不另算一行，和工具卡、回复下面的文件统计同一种数法。
  return { additions: countLines(content), deletions: 0, content }
}

interface BlockEditContribution {
  toolName: "edit" | "write" | "apply_patch"
  files: string[]
  // 能分到具体文件上的增删（按文件记账用）
  perFile: FileLineChange[]
  // 分不到文件上的增删，直接加进总数
  additions: number
  deletions: number
}

// Parsing a tool call's `raw_input` (JSON.parse + diff line counting) is the
// expensive part of the live edit stats, and it re-runs on every streaming
// token because the `message` reference changes each token. A completed
// tool_call block keeps a stable reference across tokens (the reducer rebuilds
// only the block that changed — see acp-connections-context), so cache each
// block's contribution keyed on the block object. Only the block currently
// being updated re-parses; the rest are O(1) lookups. Keying on the block ref
// is sound because a block's ref changes iff its content changes, and the
// WeakMap lets dropped blocks be collected.
const blockEditContributionCache = new WeakMap<
  LiveContentBlock,
  BlockEditContribution | null
>()

function computeBlockEditContribution(
  block: LiveContentBlock
): BlockEditContribution | null {
  if (block.type !== "tool_call") return null
  const toolName = inferLiveToolName({
    title: block.info.title,
    kind: block.info.kind,
    rawInput: block.info.raw_input,
    meta: block.info.meta,
  })
  if (toolName !== "edit" && toolName !== "write" && toolName !== "apply_patch")
    return null
  // A write the user turned down, or that failed, changed nothing on disk —
  // the reply's change card skips it the same way (`extractReplyFileChanges`).
  if (toolCallFailedOrRejected(block.info)) return null

  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  let perFile: Map<string, FileLineChange> | null = null
  // 只动一个文件时，这次对它做了什么（新建的内容 / 字符串编辑）
  let created: string | undefined
  let edits: TextEdit[] | undefined
  let overwritesExisting = false

  const parsed = parseInputObject(block.info.raw_input)
  for (const path of collectParsedPaths(parsed)) files.add(path)

  if (toolName === "apply_patch") {
    const patch = extractPatchText(block.info.raw_input, parsed)
    if (patch) {
      const stats = parseApplyPatchStats(patch)
      for (const path of stats.files) files.add(path)
      additions += stats.additions
      deletions += stats.deletions
      perFile = stats.perFile
    }
  } else if (parsed) {
    if (toolName === "edit") {
      const stats = extractEditStats(parsed)
      additions += stats.additions
      deletions += stats.deletions
      perFile = stats.perFile
      edits = stats.edits ?? undefined
    } else {
      const stats = extractWriteStats(parsed)
      // 结果里带了改动补丁：覆盖的是原来就有的文件，增删按补丁算
      const overwrite = writeOverwritePatch(
        block.info.raw_output_chunks.join("") || block.info.content
      )
      const counted = overwrite ? countUnifiedDiffLineChanges(overwrite) : stats
      additions += counted.additions
      deletions += counted.deletions
      created = stats.content
      overwritesExisting = overwrite !== null
    }
  }

  // 只动一个文件的：整笔记到这个文件上（补丁里文件头前的零散行也算它的）。
  // 动多个文件的：能分到文件上的按文件记，剩下的直接加进总数。
  const entries: FileLineChange[] = []
  if (files.size === 1) {
    const [path] = files
    const fromPatch = perFile?.get(path)
    // 补丁 / changes 编辑里只有这一个文件时，它是 Add 还是 Update、改了什么看
    // perFile；补丁段外还有零散行就不算
    const patchEntry =
      fromPatch &&
      fromPatch.additions === additions &&
      fromPatch.deletions === deletions
        ? fromPatch
        : undefined
    const patchCreated = patchEntry?.created
    // 只改一个文件的 `changes` 编辑，替换内容记在 perFile 里
    const fileEdits = edits ?? patchEntry?.edits
    entries.push({
      path,
      additions,
      deletions,
      ...(created !== undefined || patchCreated !== undefined
        ? { created: created ?? patchCreated }
        : {}),
      ...(overwritesExisting ? { overwritesExisting } : {}),
      ...(fileEdits ? { edits: fileEdits } : {}),
      ...(patchEntry?.patchHunks ? { patchHunks: patchEntry.patchHunks } : {}),
    })
    additions = 0
    deletions = 0
  } else if (perFile) {
    for (const entry of perFile.values()) {
      entries.push(entry)
      additions -= entry.additions
      deletions -= entry.deletions
    }
  }

  return { toolName, files: [...files], perFile: entries, additions, deletions }
}

function blockEditContribution(
  block: LiveContentBlock
): BlockEditContribution | null {
  const cached = blockEditContributionCache.get(block)
  if (cached !== undefined) return cached
  const contribution = computeBlockEditContribution(block)
  blockEditContributionCache.set(block, contribution)
  return contribution
}

export function extractLiveEditStats(message: LiveMessage): LiveEditStats {
  const files = new Set<string>()
  let additions = 0
  let deletions = 0
  // edit / write / apply_patch 能分到文件上的增删按文件记账（多文件补丁、
  // `changes` 形式的多文件 edit 也逐个文件记）：write 把整个文件换成这次的内容，
  // 之前的增删作废、从这次写入的行数重新算；本轮写过的文件按净行数算，
  // 和回复下面「新增文件」的数字对得上（写 3 行再改一行还是 +3/-0）。
  const perFile = new Map<
    string,
    {
      additions: number
      deletions: number
      // 本轮新建过（write / 补丁 Add File）：additions 记的是文件现在的行数
      written: boolean
      // 新建过的文件现在的内容；套不上编辑以后就不知道了（null）
      content: string | null
    }
  >()

  for (const block of message.content) {
    const contribution = blockEditContribution(block)
    if (!contribution) continue
    for (const path of contribution.files) files.add(path)
    for (const change of contribution.perFile) {
      files.add(change.path)
      const entry = perFile.get(change.path) ?? {
        additions: 0,
        deletions: 0,
        written: false,
        content: null,
      }
      // 覆盖原来就有的文件（本轮没新建过它）按修改记补丁的增删；本轮新建过
      // 的，覆盖了还是新文件，按新内容重新数
      const createsFile =
        change.created !== undefined &&
        !(change.overwritesExisting && !entry.written)
      if (createsFile && change.created !== undefined) {
        entry.additions = countLines(change.created)
        entry.deletions = 0
        entry.written = true
        entry.content = change.created
      } else if (entry.written) {
        // 新建过的文件再改：能套到已知内容上就改一遍再数行，
        // 套不上的按换行符（字符串编辑）或补丁的净增减算
        const edited =
          entry.content === null
            ? null
            : change.edits
              ? applyTextEdits(entry.content, change.edits)
              : change.patchHunks
                ? applyPatchHunks(entry.content, change.patchHunks)
                : null
        if (edited !== null) {
          entry.additions = countLines(edited)
        } else {
          const delta = change.edits
            ? textEditsLineDelta(change.edits)
            : change.additions - change.deletions
          entry.additions = Math.max(0, entry.additions + delta)
        }
        entry.content = edited
      } else {
        entry.additions += change.additions
        entry.deletions += change.deletions
      }
      perFile.set(change.path, entry)
    }
    additions += contribution.additions
    deletions += contribution.deletions
  }

  for (const entry of perFile.values()) {
    if (entry.written) {
      additions += entry.additions
    } else {
      additions += entry.additions
      deletions += entry.deletions
    }
  }

  return { files: files.size, additions, deletions }
}

/**
 * The live activity row above the composer: the running turn's figures — how
 * long the turn has run, the files it has changed and how fast it is writing —
 * then whatever `trailing` adds (the "N running" chip), which can outlast the
 * turn. That the agent is at work, and at what — thinking, running a step,
 * writing — the transcript's own timeline says ("Working" on the reply's
 * header, a shimmer on the step, a turning ring at the foot of its rail), so
 * this row carries neither a word for it nor a pulsing mark. (Cowork: a wait
 * on the user is the exception — see `awaitingUser`.)
 *
 * Narrow, the row sheds the edit figures first, then the speed; the time and
 * the trailing chip stay.
 */
export function LiveTurnStats({
  message,
  trailing,
  awaitingUser = null,
}: LiveTurnStatsProps) {
  const tSidebar = useTranslations("Folder.sidebar")
  return (
    // jenny fork (Liquid Glass): a glass capsule floating just above the
    // composer dock, not a row of its own under the transcript.
    <div
      data-live-turn-stats=""
      className="@container/turnstats pointer-events-none absolute inset-x-0 bottom-[calc(var(--glass-dock-h,0px)+0.625rem)] z-10 flex justify-center px-4"
    >
      <div className="lg pointer-events-auto flex min-h-[1.875rem] max-w-full flex-wrap items-center justify-center gap-x-3 gap-y-1 rounded-full px-3.5 py-1 text-xs leading-none text-muted-foreground tabular-nums">
        {message && awaitingUser ? (
          // It is the user's move. The timer keeps counting — it is the
          // turn's age, which the wait is part of.
          <>
            <span data-awaiting-user={awaitingUser}>
              {tSidebar(AWAITING_USER_LABEL[awaitingUser])}
            </span>
            <span className="text-border leading-none">|</span>
          </>
        ) : null}
        {/* Keyed by its turn: a turn that starts while the last one's figures
            are still on screen gets figures of its own, its clock from zero. */}
        {message && <LiveTurnFigures key={message.id} message={message} />}
        {message && trailing ? (
          <span className="text-border leading-none">|</span>
        ) : null}
        {trailing}
      </div>
    </div>
  )
}

function LiveTurnFigures({ message }: { message: LiveMessage }) {
  const locale = useLocale()
  const t = useTranslations("Folder.chat.liveTurnStats")
  const [elapsed, setElapsed] = useState(() => Date.now() - message.startedAt)
  const editStats = useMemo(() => extractLiveEditStats(message), [message])
  const tps = useTokenOutputSpeed(message)
  const compactNumberFormatter = useMemo(
    () =>
      new Intl.NumberFormat(locale, {
        notation: "compact",
        maximumFractionDigits: 1,
      }),
    [locale]
  )

  useEffect(() => {
    const timer = setInterval(() => {
      setElapsed(Date.now() - message.startedAt)
    }, 1_000)
    return () => clearInterval(timer)
  }, [message.startedAt])

  const elapsedLabel = formatElapsedLabel(elapsed, t)

  return (
    <>
      <span className="inline-flex items-center gap-1 leading-none">
        <Timer className="h-3 w-3 shrink-0" />
        {elapsedLabel}
      </span>
      {editStats.files > 0 && (
        <>
          <span className="hidden text-border leading-none @[24rem]/turnstats:inline">
            |
          </span>
          <span className="hidden items-center gap-1 leading-none @[24rem]/turnstats:inline-flex">
            <FilePenLine className="h-3 w-3 shrink-0" />
            {editStats.files}F +
            {formatCompactInt(editStats.additions, compactNumberFormatter)}/-
            {formatCompactInt(editStats.deletions, compactNumberFormatter)}
          </span>
        </>
      )}
      {tps != null && (
        <>
          <span className="hidden text-border leading-none @[30rem]/turnstats:inline">
            |
          </span>
          {/* `tabular-nums` so the digits stop shimmering as the rate moves. */}
          <span
            className="hidden items-center gap-1 leading-none tabular-nums @[30rem]/turnstats:inline-flex"
            title={t("outputSpeedTooltip")}
          >
            {/* Name hangs off the icon, matching `ComposerContextUsage` —
                  `aria-label` on the bare wrapper span carries no role and
                  isn't reliably exposed. */}
            <Plane
              aria-label={t("outputSpeedAria")}
              className="h-3 w-3 shrink-0"
            />
            {tps.toFixed(1)} tok/s
          </span>
        </>
      )}
    </>
  )
}
