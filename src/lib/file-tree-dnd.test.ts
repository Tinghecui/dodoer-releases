import { afterEach, describe, expect, it } from "vitest"

import {
  FILE_TREE_DND_MIME,
  FILE_TREE_DROP_COMPOSER_ATTR,
  FILE_TREE_DROP_DIR_ATTR,
  hasFileTreeDragType,
  isFileTreeDragActive,
  readFileTreeDragPayload,
  resolveFileTreeDropZone,
  setFileTreeDragActive,
  writeFileTreeDragData,
  type FileTreeDragPayload,
} from "./file-tree-dnd"

/** Minimal in-memory stand-in for `DataTransfer` (jsdom's is not faithful). */
class MockDataTransfer {
  private store = new Map<string, string>()
  setData(format: string, data: string) {
    this.store.set(format.toLowerCase(), data)
  }
  getData(format: string) {
    return this.store.get(format.toLowerCase()) ?? ""
  }
  get types(): ReadonlyArray<string> {
    return Array.from(this.store.keys())
  }
}

const payload: FileTreeDragPayload = {
  rootPath: "/repo",
  relPath: "src/app.ts",
  absPath: "/repo/src/app.ts",
  name: "app.ts",
  kind: "file",
}

describe("file-tree drag payload codec", () => {
  it("round-trips a payload through write/read", () => {
    const dt = new MockDataTransfer()
    writeFileTreeDragData(dt, payload)
    expect(readFileTreeDragPayload(dt)).toEqual(payload)
  })

  it("also writes a text/plain absolute-path fallback", () => {
    const dt = new MockDataTransfer()
    writeFileTreeDragData(dt, payload)
    expect(dt.getData("text/plain")).toBe("/repo/src/app.ts")
  })

  it("detects the drag type from `types` (dragover-safe)", () => {
    const dt = new MockDataTransfer()
    writeFileTreeDragData(dt, payload)
    expect(hasFileTreeDragType(dt)).toBe(true)
  })

  it("reports no drag type for an OS file drop", () => {
    const osDrop = { types: ["Files"] as ReadonlyArray<string> }
    expect(hasFileTreeDragType(osDrop)).toBe(false)
  })

  it("returns null for a nullish transfer or missing payload", () => {
    expect(readFileTreeDragPayload(null)).toBeNull()
    expect(hasFileTreeDragType(null)).toBe(false)
    expect(readFileTreeDragPayload(new MockDataTransfer())).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    const dt = new MockDataTransfer()
    dt.setData(FILE_TREE_DND_MIME, "{not json")
    expect(readFileTreeDragPayload(dt)).toBeNull()
  })

  it("returns null when the shape is wrong (bad kind)", () => {
    const dt = new MockDataTransfer()
    dt.setData(
      FILE_TREE_DND_MIME,
      JSON.stringify({ ...payload, kind: "symlink" })
    )
    expect(readFileTreeDragPayload(dt)).toBeNull()
  })

  it("carries directory payloads", () => {
    const dir: FileTreeDragPayload = {
      rootPath: "/repo",
      relPath: "src",
      absPath: "/repo/src",
      name: "src",
      kind: "dir",
    }
    const dt = new MockDataTransfer()
    writeFileTreeDragData(dt, dir)
    expect(readFileTreeDragPayload(dt)).toEqual(dir)
  })
})

describe("resolveFileTreeDropZone", () => {
  it("returns null for a nullish element or an unmarked subtree", () => {
    expect(resolveFileTreeDropZone(null)).toBeNull()
    const div = document.createElement("div")
    div.innerHTML = `<span><em>leaf</em></span>`
    expect(resolveFileTreeDropZone(div.querySelector("em"))).toBeNull()
  })

  it("resolves a directory zone from a descendant of the marked row", () => {
    const row = document.createElement("button")
    row.setAttribute(FILE_TREE_DROP_DIR_ATTR, "src/components")
    row.innerHTML = `<span class="icon"></span><span class="name">components</span>`
    expect(resolveFileTreeDropZone(row.querySelector(".name"))).toEqual({
      kind: "dir",
      destDir: "src/components",
    })
  })

  it("treats an empty dir attribute as the workspace root", () => {
    const row = document.createElement("button")
    row.setAttribute(FILE_TREE_DROP_DIR_ATTR, "")
    expect(resolveFileTreeDropZone(row)).toEqual({ kind: "dir", destDir: "" })
  })

  it("resolves a composer zone and carries its tab id", () => {
    const composer = document.createElement("div")
    composer.setAttribute(FILE_TREE_DROP_COMPOSER_ATTR, "tab-42")
    composer.innerHTML = `<div class="editor"><p>x</p></div>`
    expect(resolveFileTreeDropZone(composer.querySelector("p"))).toEqual({
      kind: "composer",
      tabId: "tab-42",
    })
  })

  it("ignores a composer zone with an empty tab id", () => {
    const composer = document.createElement("div")
    composer.setAttribute(FILE_TREE_DROP_COMPOSER_ATTR, "")
    expect(resolveFileTreeDropZone(composer)).toBeNull()
  })

  it("prefers the deeper zone when a dir row is nested in a composer", () => {
    const composer = document.createElement("div")
    composer.setAttribute(FILE_TREE_DROP_COMPOSER_ATTR, "tab-1")
    const nestedDir = document.createElement("button")
    nestedDir.setAttribute(FILE_TREE_DROP_DIR_ATTR, "pkg")
    composer.append(nestedDir)
    expect(resolveFileTreeDropZone(nestedDir)).toEqual({
      kind: "dir",
      destDir: "pkg",
    })
  })
})

describe("resolveFileTreeDropZone 在对话区里找它自己的输入框", () => {
  let mounted: HTMLElement[] = []
  afterEach(() => {
    for (const el of mounted) el.remove()
    mounted = []
  })

  /** 一个对话区：聊天记录、收起的那一条、输入框外框（可以没有）。 */
  function mountShell(tabId: string | null) {
    const shell = document.createElement("div")
    shell.setAttribute("data-conversation-shell", "")
    const transcript = document.createElement("div")
    transcript.innerHTML = `<p class="msg"><span>hello</span></p>`
    const collapsedBar = document.createElement("button")
    const body = document.createElement("div")
    shell.append(transcript, collapsedBar, body)
    if (tabId !== null) {
      const composer = document.createElement("div")
      composer.setAttribute(FILE_TREE_DROP_COMPOSER_ATTR, tabId)
      body.append(composer)
    }
    document.body.append(shell)
    mounted.push(shell)
    return { shell, transcript, collapsedBar, body }
  }

  it("聊天记录里的元素落到这个对话区的输入框", () => {
    const { transcript } = mountShell("tab-a")
    expect(resolveFileTreeDropZone(transcript.querySelector("span"))).toEqual({
      kind: "composer",
      tabId: "tab-a",
    })
  })

  it("两个对话区并排时各认各的", () => {
    const left = mountShell("tab-left")
    const right = mountShell("tab-right")
    expect(resolveFileTreeDropZone(left.transcript)).toEqual({
      kind: "composer",
      tabId: "tab-left",
    })
    expect(resolveFileTreeDropZone(right.transcript)).toEqual({
      kind: "composer",
      tabId: "tab-right",
    })
  })

  it("对话区里没有输入框时没有落点", () => {
    const { transcript } = mountShell(null)
    expect(resolveFileTreeDropZone(transcript)).toBeNull()
  })

  it("输入框收起时，松在收起的那一条或聊天记录上同样落到它", () => {
    const { body, collapsedBar, transcript } = mountShell("tab-c")
    // 收起时输入框本体看不见，但还在对话区里
    body.style.visibility = "hidden"
    expect(resolveFileTreeDropZone(collapsedBar)).toEqual({
      kind: "composer",
      tabId: "tab-c",
    })
    expect(resolveFileTreeDropZone(transcript)).toEqual({
      kind: "composer",
      tabId: "tab-c",
    })
  })

  it("嵌套的对话区：外层只认直接属于它的输入框，不认里层的", () => {
    const outer = mountShell("tab-outer")
    const inner = document.createElement("div")
    inner.setAttribute("data-conversation-shell", "")
    const innerComposer = document.createElement("div")
    innerComposer.setAttribute(FILE_TREE_DROP_COMPOSER_ATTR, "tab-inner")
    const innerTranscript = document.createElement("div")
    inner.append(innerTranscript, innerComposer)
    // 里层的放在外层输入框前面，选择器按文档顺序会先碰到它
    outer.transcript.prepend(inner)
    expect(resolveFileTreeDropZone(outer.collapsedBar)).toEqual({
      kind: "composer",
      tabId: "tab-outer",
    })
    expect(resolveFileTreeDropZone(innerTranscript)).toEqual({
      kind: "composer",
      tabId: "tab-inner",
    })
  })

  it("对话区外面仍然没有落点", () => {
    mountShell("tab-a")
    const sidebar = document.createElement("nav")
    document.body.append(sidebar)
    mounted.push(sidebar)
    expect(resolveFileTreeDropZone(sidebar)).toBeNull()
  })
})

describe("文件树拖动标记", () => {
  afterEach(() => setFileTreeDragActive(false))

  it("开始时设、结束时清", () => {
    expect(isFileTreeDragActive()).toBe(false)
    setFileTreeDragActive(true)
    expect(isFileTreeDragActive()).toBe(true)
    setFileTreeDragActive(false)
    expect(isFileTreeDragActive()).toBe(false)
  })
})
