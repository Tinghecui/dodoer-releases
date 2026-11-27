import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { createElement } from "react"
import { render, waitFor } from "@testing-library/react"
import MonacoEditor, { loader, type Monaco } from "@monaco-editor/react"

import { expect, it, vi } from "vitest"
import { URI } from "monaco-editor/base/common/uri.js"
import {
  buildMonacoModelPath,
  syncRetainedModelValue,
} from "@/lib/monaco-model-path"

const panelSource = readFileSync(
  resolve(process.cwd(), "src/components/files/file-workspace-panel.tsx"),
  "utf8"
)

// #1511：读失败的标签内容是错误文字，重读成功时编辑器先卸载（内容清空在读）再挂载，
// 包装组件直接用同一路径留着的旧 model，挂载时的 value 不会写进去。
it("syncs the tab content into a retained model when the editor remounts", async () => {
  expect(panelSource).toMatch(
    /handleEditorMount: OnMount = useCallback\([\s\S]{0,400}syncRetainedModelValue\(\s*editorInstance\.getModel\(\),\s*editorValueRef\.current\s*\)/
  )
  expect(panelSource).toMatch(
    /const next = isFileTab \? imeSafeEditorValue : renderedContent\s*if \(next !== undefined\) editorValueRef\.current = next/
  )

  const path = buildMonacoModelPath("/repo/README.md", "file:/repo/README.md")
  let text = "无法加载内容。\n\n500"
  const model = {
    uri: URI.parse(path),
    isAttachedToEditor: () => true,
    dispose: vi.fn(),
    getValue: () => text,
    setValue: vi.fn((next: string) => {
      text = next
    }),
    getFullModelRange: () => ({}),
  }
  const editor = {
    getModel: () => model,
    getValue: () => text,
    getOption: () => false,
    executeEdits: vi.fn(),
    pushUndoStop: vi.fn(),
    updateOptions: vi.fn(),
    restoreViewState: vi.fn(),
    saveViewState: vi.fn(),
    onDidChangeModelContent: () => ({ dispose: vi.fn() }),
    dispose: vi.fn(),
  }
  const createModel = vi.fn()
  loader.config({
    monaco: {
      Uri: URI,
      editor: {
        getModel: () => model,
        createModel,
        create: vi.fn(() => editor),
        setTheme: vi.fn(),
        onDidChangeMarkers: () => ({ dispose: vi.fn() }),
        EditorOption: { readOnly: 0 },
      },
    } as unknown as Monaco,
  })
  const onMount = vi.fn((instance: { getModel: () => typeof model }) => {
    syncRetainedModelValue(instance.getModel(), "fourth\n")
  })
  render(
    createElement(MonacoEditor, {
      path,
      keepCurrentModel: true,
      defaultValue: "fourth\n",
      value: "fourth\n",
      onMount: onMount as never,
    })
  )
  await waitFor(() => expect(onMount).toHaveBeenCalledOnce())
  // 包装组件确实沿用了旧 model（没有新建），所以要靠挂载时同步。
  expect(createModel).not.toHaveBeenCalled()
  expect(text).toBe("fourth\n")
  // 内容一样时不动 model，保住撤销记录。
  expect(syncRetainedModelValue(model, "fourth\n")).toBe(false)
  expect(model.setValue).toHaveBeenCalledOnce()
})
