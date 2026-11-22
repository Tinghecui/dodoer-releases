"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import dynamic from "next/dynamic"
import { ChevronLeft, ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { useMonaco } from "@monaco-editor/react"
import type { DiffOnMount, OnMount } from "@monaco-editor/react"
import type { editor as MonacoEditorNs } from "monaco-editor"
import {
  defineMonacoThemes,
  MONACO_UNICODE_HIGHLIGHT_OPTIONS,
  useMonacoWorkspaceTheme,
} from "@/lib/monaco-themes"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import { cn } from "@/lib/utils"

import "@/lib/monaco-local"

const MonacoDiffEditor = dynamic(
  async () => {
    const mod = await import("@monaco-editor/react")
    return { default: mod.DiffEditor }
  },
  { ssr: false }
)

// Single-pane editor for a diff with one empty side (new / untracked file,
// deleted file). Side by side, Monaco treats the empty side as one blank line
// and pairs it badly — a red "deleted" line on the left and an extra blank "+"
// line on the right for a plain new file (#1037) — so there is nothing to
// compare and the non-empty side is shown alone, marked added or removed.
const MonacoEditor = dynamic(
  async () => {
    const mod = await import("@monaco-editor/react")
    return { default: mod.default }
  },
  { ssr: false }
)

// Commit-synchronous on the client so the teardown below runs in the deletion
// commit — strictly before the library's passive unmount cleanup, whatever the
// parent/child effect order is; a no-op-safe passive effect during the
// static-export prerender where `useLayoutEffect` would warn.
const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect

// Lines in a text the way a diff counts them: a trailing newline ends the last
// line rather than starting another one, and "" has no lines at all.
function countLines(text: string): number {
  if (text === "") return 0
  const parts = text.split("\n").length
  return text.endsWith("\n") ? parts - 1 : parts
}

// @monaco-editor/react tears the diff editor down in the wrong order on
// unmount: it disposes both text models and only then the widget. Monaco
// flags that as a self-check bug ("TextModel got disposed before
// DiffEditorWidget model got reset") and its default handler rethrows it from
// a timeout, i.e. an uncaught error in the dev overlay on every diff→file tab
// switch or dialog close. Do the teardown first, correctly: detach the models
// (which drops the widget's onWillDispose listeners), then dispose them —
// nothing else in the app owns or tracks them, since no model path is passed
// and Monaco hands out an anonymous URI per model. The library then reads a
// null model and only disposes the widget.
//
// Rendered as a sibling of the diff editor so it unmounts with it — whether
// the whole viewer closes or only the diff editor gives way to the
// single-pane view of a one-sided file.
//
// This assumes the subtree is being DESTROYED. Layout cleanup also fires when
// a subtree is merely hidden (`<Activity mode="hidden">`, a Suspense
// fallback); no host does that today, and if one ever wraps a diff that way
// the models must be re-created on re-show instead of disposed here.
function DiffEditorTeardown({
  editorRef,
  timerRef,
}: {
  editorRef: React.RefObject<MonacoEditorNs.IStandaloneDiffEditor | null>
  timerRef: React.RefObject<ReturnType<typeof setTimeout> | null>
}) {
  useIsomorphicLayoutEffect(
    () => () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const editor = editorRef.current
      editorRef.current = null
      const model = editor?.getModel()
      editor?.setModel(null)
      model?.original.dispose()
      model?.modified.dispose()
    },
    [editorRef, timerRef]
  )
  return null
}

export interface DiffViewerProps {
  original: string
  modified: string
  originalLabel?: string
  modifiedLabel?: string
  language?: string
  className?: string
}

export function DiffViewer({
  original,
  modified,
  originalLabel = "Original",
  modifiedLabel = "Modified",
  language = "plaintext",
  className,
}: DiffViewerProps) {
  const t = useTranslations("DiffViewer")
  // Conditionally mounted (only when a diff is shown), so useMonaco() here is
  // already lazy — Monaco is loading for this editor anyway.
  const monaco = useMonaco()
  const editorTheme = useMonacoWorkspaceTheme(monaco)
  const { zoomLevel } = useZoomLevel()
  const { editorFontStack, editorFontSize, editorLigatures, editorWordWrap } =
    useEditorFont()
  const diffEditorRef = useRef<MonacoEditorNs.IStandaloneDiffEditor | null>(
    null
  )
  const [diffChanges, setDiffChanges] = useState<MonacoEditorNs.ILineChange[]>(
    []
  )
  const [currentChangeIndex, setCurrentChangeIndex] = useState(-1)
  // Initial diff read, deferred because the first computation lands after
  // mount. Cancelled on unmount so it can never poke a disposed widget.
  const initialDiffReadRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleEditorMount: DiffOnMount = useCallback((editor) => {
    diffEditorRef.current = editor
    let scrolledToFirst = false

    const updateDiffs = () => {
      const changes = editor.getLineChanges()
      setDiffChanges(changes ?? [])
      if (changes && changes.length > 0) {
        setCurrentChangeIndex(0)
        // Auto-scroll to the first change only once
        if (!scrolledToFirst) {
          scrolledToFirst = true
          const first = changes[0]
          const lineNumber =
            first.modifiedStartLineNumber || first.originalStartLineNumber || 1
          const modifiedEditor = editor.getModifiedEditor()
          modifiedEditor.revealLineInCenter(lineNumber)
          modifiedEditor.setPosition({ lineNumber, column: 1 })
        }
      }
    }

    editor.onDidUpdateDiff(updateDiffs)
    initialDiffReadRef.current = setTimeout(updateDiffs, 300)
  }, [])

  const navigateToChange = useCallback(
    (index: number) => {
      const editor = diffEditorRef.current
      if (!editor || diffChanges.length === 0) return

      const clampedIndex = Math.max(0, Math.min(index, diffChanges.length - 1))
      setCurrentChangeIndex(clampedIndex)

      const change = diffChanges[clampedIndex]
      const lineNumber =
        change.modifiedStartLineNumber || change.originalStartLineNumber || 1

      const modifiedEditor = editor.getModifiedEditor()
      modifiedEditor.revealLineInCenter(lineNumber)
      modifiedEditor.setPosition({ lineNumber, column: 1 })
    },
    [diffChanges]
  )

  const handlePrevChange = useCallback(() => {
    if (currentChangeIndex > 0) {
      navigateToChange(currentChangeIndex - 1)
    }
  }, [currentChangeIndex, navigateToChange])

  const handleNextChange = useCallback(() => {
    if (currentChangeIndex < diffChanges.length - 1) {
      navigateToChange(currentChangeIndex + 1)
    }
  }, [currentChangeIndex, diffChanges.length, navigateToChange])

  // Stable identity: the library runs `updateOptions` on every change of this
  // prop, so an inline literal would re-push the whole option set each render.
  const diffOptions = useMemo<MonacoEditorNs.IDiffEditorConstructionOptions>(
    () => ({
      readOnly: true,
      renderSideBySide: true,
      renderSideBySideInlineBreakpoint: 0,
      automaticLayout: true,
      fontSize: (editorFontSize * zoomLevel) / 100,
      fontFamily: editorFontStack,
      fontLigatures: editorLigatures,
      wordWrap: editorWordWrap ? "on" : "off",
      minimap: { enabled: false },
      unicodeHighlight: MONACO_UNICODE_HIGHLIGHT_OPTIONS,
      scrollBeyondLastLine: false,
      renderOverviewRuler: false,
      ignoreTrimWhitespace: true,
      renderIndicators: true,
      originalEditable: false,
    }),
    [
      zoomLevel,
      editorFontStack,
      editorFontSize,
      editorLigatures,
      editorWordWrap,
    ]
  )

  // One side empty and the other not: show the non-empty side alone.
  const oneSided =
    (original === "") !== (modified === "")
      ? original === ""
        ? ("added" as const)
        : ("removed" as const)
      : null
  const oneSidedText = oneSided === "added" ? modified : original

  // Same options as the diff, minus the diff-only ones.
  const singleOptions =
    useMemo<MonacoEditorNs.IStandaloneEditorConstructionOptions>(
      () => ({
        readOnly: true,
        domReadOnly: true,
        automaticLayout: true,
        fontSize: (editorFontSize * zoomLevel) / 100,
        fontFamily: editorFontStack,
        fontLigatures: editorLigatures,
        wordWrap: editorWordWrap ? "on" : "off",
        minimap: { enabled: false },
        unicodeHighlight: MONACO_UNICODE_HIGHLIGHT_OPTIONS,
        scrollBeyondLastLine: false,
        overviewRulerLanes: 0,
      }),
      [
        zoomLevel,
        editorFontStack,
        editorFontSize,
        editorLigatures,
        editorWordWrap,
      ]
    )

  const handleSingleMount: OnMount = useCallback(
    (editor) => {
      if (!oneSided) return
      const lines = countLines(oneSidedText)
      if (lines === 0) return
      // Monaco's own diff line styles (green / red row, "+" / "−" gutter
      // sign). The blank line after a final newline is not part of the file's
      // content and stays undecorated.
      const kind = oneSided === "added" ? "insert" : "delete"
      editor.createDecorationsCollection([
        {
          range: {
            startLineNumber: 1,
            startColumn: 1,
            endLineNumber: lines,
            endColumn: 1,
          },
          options: {
            className: `line-${kind}`,
            isWholeLine: true,
            linesDecorationsClassName: `${kind}-sign codicon codicon-diff-${
              kind === "insert" ? "insert" : "remove"
            }`,
            marginClassName: `gutter-${kind}`,
          },
        },
      ])
    },
    // The editor is keyed on the content below, so a mount always sees the
    // text it decorates.
    [oneSided, oneSidedText]
  )

  const { additions, deletions } = useMemo(() => {
    // A side that is empty (new / untracked file, deleted file) is still one
    // blank line to Monaco, and its diff scoring prefers pairing that blank
    // line with real content over matching it, so a one-line new file comes
    // back as "original 1-1 → modified 1-2" and would read +2 -1. When one
    // side is empty the counts are simply the other side's line count.
    if (original === "" || modified === "") {
      return {
        additions: countLines(modified),
        deletions: countLines(original),
      }
    }
    // Monaco also treats a final newline as starting one more (blank) line, so
    // when only one side ends with a newline its blank last line shows up in
    // the change ("edited line" → "edited linesecond line\n" comes back as
    // original 1-1 → modified 1-2, #1252). Clamp each range to the side's real
    // line count so that blank line is not counted, the same as git.
    const origLines = countLines(original)
    const modLines = countLines(modified)
    const span = (start: number, end: number, lines: number) =>
      Math.max(0, Math.min(end, lines) - start + 1)
    // Whether a side's last real line falls in a counted range.
    const covers = (start: number, end: number, lines: number) =>
      start <= lines && Math.min(end, lines) >= lines
    // Only one side ends with a newline: git compares lines with their
    // newlines, so the last line of the side without one ("a" vs "a\n")
    // never equals a line on the other side.
    const eofDiffers = original.endsWith("\n") !== modified.endsWith("\n")
    const noNewlineIsOriginal = !original.endsWith("\n")
    let noNewlineLastCounted = false
    let add = 0
    let del = 0
    for (const change of diffChanges) {
      // Monaco ILineChange: endLineNumber === 0 means no lines on that side
      // Pure insertion: originalEndLineNumber === 0
      // Pure deletion: modifiedEndLineNumber === 0
      if (change.originalEndLineNumber !== 0) {
        del += span(
          change.originalStartLineNumber,
          change.originalEndLineNumber,
          origLines
        )
        if (noNewlineIsOriginal) {
          noNewlineLastCounted ||= covers(
            change.originalStartLineNumber,
            change.originalEndLineNumber,
            origLines
          )
        }
      }
      if (change.modifiedEndLineNumber !== 0) {
        add += span(
          change.modifiedStartLineNumber,
          change.modifiedEndLineNumber,
          modLines
        )
        if (!noNewlineIsOriginal) {
          noNewlineLastCounted ||= covers(
            change.modifiedStartLineNumber,
            change.modifiedEndLineNumber,
            modLines
          )
        }
      }
    }
    // If Monaco left that last line unchanged, it paired it with an equal
    // line on the other side, which git sees as a rewrite: one line on each
    // side ("a" → "a\n" is +1 -1). If a change already covers it, git agrees
    // with Monaco and nothing is added ("a\n" → "a\nb" stays +1 -0).
    if (eofDiffers && !noNewlineLastCounted) {
      del += 1
      add += 1
    }
    return { additions: add, deletions: del }
  }, [diffChanges, original, modified])

  // A one-sided diff is a single change; there is nothing to step through.
  const changeCount = oneSided ? 1 : diffChanges.length

  // Only one side ends with a newline: git marks this "\\ No newline at end of
  // file"; the counts above count it the way git does, and this says why.
  const eofNewlineChanged =
    !oneSided &&
    original !== "" &&
    original.endsWith("\n") !== modified.endsWith("\n")

  return (
    <div className={cn("flex h-full flex-col", className)}>
      <div className="flex items-center gap-3 border-b bg-muted/50 px-3 py-1.5 text-xs text-muted-foreground">
        <span className="font-medium">{originalLabel}</span>
        <span className="text-muted-foreground/60">↔</span>
        <span className="font-medium">{modifiedLabel}</span>
        {changeCount > 0 && (
          <>
            <span className="ml-2 font-mono text-tone-success">
              +{additions}
            </span>
            <span className="font-mono text-tone-danger">-{deletions}</span>
            <span>
              {changeCount} {changeCount === 1 ? "change" : "changes"}
            </span>
            {eofNewlineChanged && (
              <span className="rounded border border-border px-1 text-3xs">
                {t("eofNewlineChanged")}
              </span>
            )}
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                onClick={handlePrevChange}
                disabled={oneSided !== null || currentChangeIndex <= 0}
                className="rounded border border-border bg-background px-2 py-0.5 text-3xs disabled:opacity-40 hover:bg-muted transition-colors inline-flex items-center gap-1"
              >
                <ChevronLeft className="h-3 w-3" />
                Prev
              </button>
              <span className="tabular-nums text-3xs">
                {oneSided ? 1 : currentChangeIndex + 1} / {changeCount}
              </span>
              <button
                type="button"
                onClick={handleNextChange}
                disabled={
                  oneSided !== null ||
                  currentChangeIndex >= diffChanges.length - 1
                }
                className="rounded border border-border bg-background px-2 py-0.5 text-3xs disabled:opacity-40 hover:bg-muted transition-colors inline-flex items-center gap-1"
              >
                Next
                <ChevronRight className="h-3 w-3" />
              </button>
            </div>
          </>
        )}
      </div>
      <div className="min-h-0 flex-1">
        {oneSided ? (
          <MonacoEditor
            key={`${oneSided}:${oneSidedText}`}
            value={oneSidedText}
            language={language}
            theme={editorTheme}
            beforeMount={defineMonacoThemes}
            onMount={handleSingleMount}
            loading={
              <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                Loading diff viewer...
              </div>
            }
            options={singleOptions}
          />
        ) : (
          <>
            <DiffEditorTeardown
              editorRef={diffEditorRef}
              timerRef={initialDiffReadRef}
            />
            <MonacoDiffEditor
              original={original}
              modified={modified}
              language={language}
              theme={editorTheme}
              beforeMount={defineMonacoThemes}
              onMount={handleEditorMount}
              loading={
                <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
                  Loading diff viewer...
                </div>
              }
              options={diffOptions}
            />
          </>
        )}
      </div>
    </div>
  )
}
