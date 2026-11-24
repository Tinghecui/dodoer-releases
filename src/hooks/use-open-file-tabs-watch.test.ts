import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { buildFileTabId } from "@/lib/file-tab-id"

type Envelope = { changed_paths?: string[]; kind: string }
type Listener = (envelope: Envelope) => void

const listenersByRoot = new Map<string, Set<Listener>>()

vi.mock("@/hooks/use-workspace-state-store", () => ({
  getWorkspaceStateStore: (rootPath: string) => ({
    acquire: () => ({}),
    release: () => {},
    subscribeEnvelopes: (listener: Listener) => {
      let set = listenersByRoot.get(rootPath)
      if (!set) {
        set = new Set()
        listenersByRoot.set(rootPath, set)
      }
      set.add(listener)
      return () => set.delete(listener)
    },
  }),
}))

vi.mock("@/lib/api", () => ({
  readFileForEdit: vi.fn(async () => ({ content: "", etag: "e" })),
}))

import { useOpenFileTabsWatch } from "./use-open-file-tabs-watch"

const ROOT = "/work/demo"
const FOLDER = { id: 7, path: ROOT }

function diffTab(
  kind: "diff-working" | "diff-working-unified" | "diff-working-overview",
  path: string
): FileWorkspaceTab {
  return {
    id: buildFileTabId({ kind, folderId: FOLDER.id, path }),
    folderId: FOLDER.id,
    kind: kind === "diff-working" ? "rich-diff" : "diff",
    title: `Diff · ${path}`,
    description: path,
    path,
    language: "plaintext",
    content: "",
    loading: false,
    originalContent: "edited line",
    modifiedContent: "edited linesecond line",
  } as FileWorkspaceTab
}

function emit(envelope: Envelope) {
  for (const listener of listenersByRoot.get(ROOT) ?? []) listener(envelope)
}

function setup(tabs: FileWorkspaceTab[], activeId: string | null) {
  const refreshWorkingTreeDiffTab = vi.fn()
  const markTabsStaleBatch = vi.fn()
  const openFilePreview = vi.fn(async () => null)
  const activeFileTabIdRef = { current: activeId }
  renderHook(() =>
    useOpenFileTabsWatch({
      fileTabs: tabs,
      fileTabsRef: { current: tabs },
      activeFileTabIdRef,
      activeFileTab: tabs.find((t) => t.id === activeId) ?? null,
      allFolders: [FOLDER],
      openFilePreview,
      reloadOpenFileBackground: vi.fn(async () => {}),
      applyExternalReload: vi.fn(async () => {}),
      markTabsStale: vi.fn(),
      markTabsStaleBatch,
      rejectFileTab: vi.fn(),
      enqueueExternalConflict: vi.fn(),
      consumeSelfWriteEcho: () => false,
      refreshWorkingTreeDiffTab,
    })
  )
  return { refreshWorkingTreeDiffTab, activeFileTabIdRef, openFilePreview }
}

describe("useOpenFileTabsWatch：工作区差异标签", () => {
  beforeEach(() => {
    listenersByRoot.clear()
  })

  it("只开着差异标签时也订阅项目根目录", () => {
    const tab = diffTab("diff-working", "notes.txt")
    setup([tab], tab.id)
    expect(listenersByRoot.get(ROOT)?.size ?? 0).toBe(1)
  })

  it("提交改了 .git/index、HEAD 后重读开着的差异标签，不切换当前标签", async () => {
    const tab = diffTab("diff-working", "notes.txt")
    const other = diffTab("diff-working-unified", "other.txt")
    const { refreshWorkingTreeDiffTab, activeFileTabIdRef, openFilePreview } =
      setup([tab, other], tab.id)
    emit({
      kind: "meta",
      changed_paths: [".git/index", ".git/refs/heads/main"],
    })
    await waitFor(() =>
      expect(refreshWorkingTreeDiffTab).toHaveBeenCalledTimes(2)
    )
    expect(refreshWorkingTreeDiffTab).toHaveBeenCalledWith(tab.id)
    expect(refreshWorkingTreeDiffTab).toHaveBeenCalledWith(other.id)
    expect(activeFileTabIdRef.current).toBe(tab.id)
    expect(openFilePreview).not.toHaveBeenCalled()
  })

  it("文件本身改了只重读它的差异标签", async () => {
    const tab = diffTab("diff-working", "notes.txt")
    const other = diffTab("diff-working", "other.txt")
    const { refreshWorkingTreeDiffTab } = setup([tab, other], tab.id)
    emit({ kind: "meta", changed_paths: ["notes.txt"] })
    await waitFor(() =>
      expect(refreshWorkingTreeDiffTab).toHaveBeenCalledWith(tab.id)
    )
    expect(refreshWorkingTreeDiffTab).not.toHaveBeenCalledWith(other.id)
  })

  it("目录差异：目录下的文件变了也重读", async () => {
    const tab = diffTab("diff-working-overview", "src")
    const { refreshWorkingTreeDiffTab } = setup([tab], tab.id)
    emit({ kind: "meta", changed_paths: ["src/a/b.ts"] })
    await waitFor(() =>
      expect(refreshWorkingTreeDiffTab).toHaveBeenCalledWith(tab.id)
    )
  })

  it("resync / 列不出路径时全部重读", async () => {
    const tab = diffTab("diff-working", "notes.txt")
    const { refreshWorkingTreeDiffTab } = setup([tab], null)
    emit({ kind: "resync_hint" })
    await waitFor(() =>
      expect(refreshWorkingTreeDiffTab).toHaveBeenCalledWith(tab.id)
    )
  })
})
