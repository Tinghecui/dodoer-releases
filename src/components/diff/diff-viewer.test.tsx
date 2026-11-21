import { render, screen, waitFor } from "@testing-library/react"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// Shared recorder for the fake Monaco pair below. Declared through
// `vi.hoisted` so the module factory (which runs before this file's body) can
// reach it.
const harness = vi.hoisted(() => {
  const events: string[] = []
  // The model pair the fake widget currently holds — the state Monaco's
  // DiffEditorWidget consults through its `onWillDispose` listeners.
  const state: { attached: Record<string, object> | null } = { attached: null }
  // What the fake widget's `getLineChanges()` reports, i.e. Monaco's diff.
  const lineChanges: {
    current: Array<{
      originalStartLineNumber: number
      originalEndLineNumber: number
      modifiedStartLineNumber: number
      modifiedEndLineNumber: number
    }>
  } = { current: [] }
  // What the fake single-pane editor was given: its text and the whole-line
  // decorations the component put on it.
  const single: {
    value: string | null
    decorations: Array<{
      range: { startLineNumber: number; endLineNumber: number }
      options: {
        className?: string
        isWholeLine?: boolean
        linesDecorationsClassName?: string
        marginClassName?: string
      }
    }>
  } = { value: null, decorations: [] }
  return { events, state, lineChanges, single }
})

// Stand-in for `@monaco-editor/react`'s DiffEditor that reproduces the two
// behaviours the component's teardown exists for: the library disposes both
// text models BEFORE the widget, and Monaco's DiffEditorWidget reports a model
// disposed while still attached as a bug ("TextModel got disposed before
// DiffEditorWidget model got reset", rethrown by its default error handler).
vi.mock("@monaco-editor/react", async () => {
  const { createElement, useEffect } = await import("react")

  const makeDiffEditor = () => {
    let model: Record<string, { dispose: () => void }> | null = null
    const detach = () => {
      model = null
      harness.state.attached = null
    }
    // Monaco's widget listens for `onWillDispose` on the pair it holds: it
    // reports the bug and then resets itself, which is why a real teardown
    // surfaces one error rather than two.
    const makeModel = (side: "original" | "modified") => {
      const m = {
        dispose: () => {
          if (harness.state.attached?.[side] === m) {
            harness.events.push(`bug:${side}`)
            detach()
          }
          harness.events.push(`${side}:dispose`)
        },
      }
      return m
    }
    model = { original: makeModel("original"), modified: makeModel("modified") }
    harness.state.attached = model
    const innerEditor = {
      revealLineInCenter: () => {},
      setPosition: () => {},
    }
    return {
      getModel: () => model,
      setModel: (next: typeof model) => {
        model = next
        harness.state.attached = next
      },
      getModifiedEditor: () => innerEditor,
      getLineChanges: () => harness.lineChanges.current,
      onDidUpdateDiff: () => ({ dispose: () => {} }),
      dispose: () => harness.events.push("editor:dispose"),
    }
  }

  const DiffEditor = ({
    onMount,
  }: {
    onMount?: (editor: ReturnType<typeof makeDiffEditor>) => void
  }) => {
    useEffect(() => {
      const editor = makeDiffEditor()
      onMount?.(editor)
      return () => {
        // @monaco-editor/react@4.7.0's unmount path, verbatim in spirit:
        // models first, widget last.
        const current = editor.getModel()
        current?.original?.dispose()
        current?.modified?.dispose()
        editor.dispose()
      }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return createElement("div", { "data-testid": "mock-diff-editor" })
  }

  // Stand-in for the library's default (single-pane) Editor.
  const Editor = ({
    value,
    onMount,
  }: {
    value?: string
    onMount?: (editor: unknown, monaco: unknown) => void
  }) => {
    useEffect(() => {
      harness.single.value = value ?? null
      onMount?.(
        {
          createDecorationsCollection: (
            decorations: typeof harness.single.decorations
          ) => {
            harness.single.decorations = decorations
            return { clear: () => {}, set: () => {} }
          },
        },
        {}
      )
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])
    return createElement("div", { "data-testid": "mock-single-editor" })
  }

  return {
    default: Editor,
    Editor,
    DiffEditor,
    useMonaco: () => null,
    loader: { config: () => {} },
  }
})

vi.mock("@/lib/monaco-themes", () => ({
  defineMonacoThemes: () => {},
  MONACO_UNICODE_HIGHLIGHT_OPTIONS: {},
  useMonacoWorkspaceTheme: () => "vs-dark",
}))

vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
  useEditorFont: () => ({
    editorFontStack: "monospace",
    editorFontSize: 12,
    editorLigatures: false,
    editorWordWrap: false,
  }),
}))

const { DiffViewer } = await import("./diff-viewer")
const { DiffEditor: MockDiffEditor } =
  (await import("@monaco-editor/react")) as unknown as {
    DiffEditor: () => React.ReactElement
  }

describe("DiffViewer teardown", () => {
  beforeEach(() => {
    harness.events.length = 0
    harness.state.attached = null
  })

  it("disposes the diff models only after detaching them from the widget", async () => {
    const { unmount } = render(<DiffViewer original="a" modified="b" />)
    expect(await screen.findByTestId("mock-diff-editor")).toBeInTheDocument()

    unmount()

    // No "TextModel got disposed before DiffEditorWidget model got reset":
    // the widget no longer holds either model by the time it is disposed.
    expect(harness.events.filter((e) => e.startsWith("bug:"))).toEqual([])
    // Both models still get disposed exactly once — detaching must not leak
    // them (they are anonymous, so nothing else could ever reclaim them).
    expect(harness.events).toEqual([
      "original:dispose",
      "modified:dispose",
      "editor:dispose",
    ])
  })

  it("the fake reproduces the library bug when the component does not intervene", async () => {
    // Guards the test above from passing vacuously: rendered bare, the same
    // fake records exactly the disposal-while-attached that Monaco flags.
    const { unmount } = render(<MockDiffEditor />)
    expect(await screen.findByTestId("mock-diff-editor")).toBeInTheDocument()

    unmount()

    expect(harness.events).toEqual([
      "bug:original",
      "original:dispose",
      "modified:dispose",
      "editor:dispose",
    ])
  })
})

describe("DiffViewer change counts", () => {
  beforeEach(() => {
    harness.events.length = 0
    harness.state.attached = null
    harness.lineChanges.current = []
    harness.single.value = null
    harness.single.decorations = []
  })

  const expectCounts = async (add: string, del: string) => {
    // The first diff read is deferred until after mount.
    await waitFor(() => expect(screen.getByText(add)).toBeInTheDocument(), {
      timeout: 2000,
    })
    expect(screen.getByText(del)).toBeInTheDocument()
  }

  it("counts a one-line new file as +1 -0, not Monaco's blank-line pairing", async () => {
    // What Monaco really reports for "" → "hello qa\n": the empty original's
    // single blank line paired with both modified lines (#161).
    harness.lineChanges.current = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 2,
      },
    ]
    render(<DiffViewer original="" modified={"hello qa\n"} />)
    await expectCounts("+1", "-0")
  })

  it("counts a new file without a trailing newline by its lines", async () => {
    harness.lineChanges.current = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 3,
      },
    ]
    render(<DiffViewer original="" modified={"a\nb\nc"} />)
    await expectCounts("+3", "-0")
  })

  it("counts a deleted file as +0 -N", async () => {
    harness.lineChanges.current = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
      },
    ]
    render(<DiffViewer original={"a\nb\n"} modified="" />)
    await expectCounts("+0", "-2")
  })

  it("keeps counting an ordinary edit from Monaco's line changes", async () => {
    harness.lineChanges.current = [
      // modified line 2 (1 → 1)
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
      // pure insertion of 2 lines after original line 4
      {
        originalStartLineNumber: 4,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 5,
        modifiedEndLineNumber: 6,
      },
    ]
    render(
      <DiffViewer original={"a\nb\nc\nd\n"} modified={"a\nB\nc\nd\ne\nf\n"} />
    )
    await expectCounts("+3", "-1")
  })
})

describe("DiffViewer one-sided diffs", () => {
  beforeEach(() => {
    harness.events.length = 0
    harness.state.attached = null
    harness.lineChanges.current = []
    harness.single.value = null
    harness.single.decorations = []
  })

  const decoratedLines = () =>
    harness.single.decorations.map((d) => ({
      start: d.range.startLineNumber,
      end: d.range.endLineNumber,
      className: d.options.className,
      isWholeLine: d.options.isWholeLine,
    }))

  it("shows an untracked file as one pane of added lines, not a side-by-side diff", async () => {
    // Monaco's own diff for "" → "alpha\nbeta\n": the empty HEAD side's blank
    // line comes back as a deletion next to three insertions (#1037).
    harness.lineChanges.current = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 3,
      },
    ]
    render(<DiffViewer original="" modified={"alpha\nbeta\n"} />)

    expect(await screen.findByTestId("mock-single-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("mock-diff-editor")).not.toBeInTheDocument()
    expect(harness.single.value).toBe("alpha\nbeta\n")
    // Lines 1 and 2 only: the blank line after the final newline is not added.
    expect(decoratedLines()).toEqual([
      { start: 1, end: 2, className: "line-insert", isWholeLine: true },
    ])
    expect(screen.getByText("+2")).toBeInTheDocument()
    expect(screen.getByText("-0")).toBeInTheDocument()
    expect(screen.getByText(/1\s*change$/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: /Prev/ })).toBeDisabled()
    expect(screen.getByRole("button", { name: /Next/ })).toBeDisabled()
  })

  it("shows a deleted file as one pane of removed lines", async () => {
    render(<DiffViewer original={"a\nb\nc"} modified="" />)

    expect(await screen.findByTestId("mock-single-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("mock-diff-editor")).not.toBeInTheDocument()
    expect(harness.single.value).toBe("a\nb\nc")
    expect(decoratedLines()).toEqual([
      { start: 1, end: 3, className: "line-delete", isWholeLine: true },
    ])
    expect(screen.getByText("+0")).toBeInTheDocument()
    expect(screen.getByText("-3")).toBeInTheDocument()
  })

  it("keeps the side-by-side diff when both sides have content", async () => {
    render(<DiffViewer original="a" modified="b" />)
    expect(await screen.findByTestId("mock-diff-editor")).toBeInTheDocument()
    expect(screen.queryByTestId("mock-single-editor")).not.toBeInTheDocument()
  })

  it("tears the side-by-side diff down cleanly when the next file is one-sided", async () => {
    // The commit dialog keeps one viewer open while the user clicks from an
    // edited file to a new one, so only the diff editor unmounts.
    const { rerender } = render(<DiffViewer original="a" modified="b" />)
    expect(await screen.findByTestId("mock-diff-editor")).toBeInTheDocument()

    rerender(<DiffViewer original="" modified={"alpha\n"} />)
    expect(await screen.findByTestId("mock-single-editor")).toBeInTheDocument()

    expect(harness.events).toEqual([
      "original:dispose",
      "modified:dispose",
      "editor:dispose",
    ])
  })
})

// The single pane is a plain Monaco editor, not a diff editor, so its row
// colours and gutter signs only show if Monaco's stylesheet applies those
// classes under `.monaco-editor` too, not only under `.monaco-diff-editor`.
// Checked against the Monaco build the app actually serves (copied to
// public/vs on install), so an upgrade that renames or rescopes them fails
// here instead of quietly leaving the pane uncoloured.
describe("DiffViewer one-sided styling against the shipped Monaco CSS", () => {
  const monacoMin = join(process.cwd(), "node_modules/monaco-editor/min/vs")
  const css = readFileSync(join(monacoMin, "editor/editor.main.css"), "utf8")
  // Every `selector { body }` rule, selectors split on commas.
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
    selectors: m[1].split(",").map((sel) => sel.trim().replace(/\s+/g, " ")),
    body: m[2],
  }))
  const editorRules = (cls: string) =>
    rules.filter((r) => r.selectors.includes(`.monaco-editor .${cls}`))
  // Monaco registers its diff gutter icons by name; the `codicon-<name>`
  // class only gets a glyph if that name is registered in the served build.
  const editorJs = readdirSync(monacoMin)
    .filter((f) => /^editor.*\.js$/.test(f))
    .map((f) => readFileSync(join(monacoMin, f), "utf8"))
    .join("\n")

  beforeEach(() => {
    harness.single.value = null
    harness.single.decorations = []
  })

  it.each([
    { name: "added", original: "", modified: "alpha\nbeta\n" },
    { name: "removed", original: "alpha\nbeta\n", modified: "" },
  ])(
    "every class on a $name pane is styled in a plain editor",
    async ({ original, modified }) => {
      render(<DiffViewer original={original} modified={modified} />)
      await screen.findByTestId("mock-single-editor")
      const [decoration] = harness.single.decorations
      const { className, marginClassName, linesDecorationsClassName } =
        decoration.options

      // Row and gutter backgrounds.
      for (const cls of [className!, marginClassName!]) {
        expect(
          editorRules(cls).some((r) => /background-color\s*:/.test(r.body)),
          `.monaco-editor .${cls} has a background`
        ).toBe(true)
      }
      // The +/− sign next to the line numbers.
      const [sign, ...icon] = linesDecorationsClassName!.split(/\s+/)
      expect(
        editorRules(sign).length,
        `.monaco-editor .${sign}`
      ).toBeGreaterThan(0)
      expect(icon[0]).toBe("codicon")
      const iconName = icon[1].replace(/^codicon-/, "")
      expect(editorJs).toContain(`"${iconName}"`)
    }
  )
})
