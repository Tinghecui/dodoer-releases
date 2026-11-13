import { render, screen, waitFor } from "@testing-library/react"
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
  return { events, state, lineChanges }
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

  return {
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
