import { act, render } from "@testing-library/react"
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { FileWorkspaceTab } from "@/contexts/workspace-context"

// 一个假的工作区：openFilePreview 往标签栏末尾加（已经开着的不动），
// 读不到的文件变成出错的标签，和真实的 provider 一样；办公文档不读内容，
// 文件不在了也照样开成正常的预览标签（真实的 provider 也是这样）。
const mocks = vi.hoisted(() => ({
  folderId: 7 as number | null,
  fileTabs: [] as FileWorkspaceTab[],
  // 所有项目合计的标签（标签跟随项目时比看到的多）；null 就和 fileTabs 一样
  allFileTabs: null as FileWorkspaceTab[] | null,
  activeFileTabId: null as string | null,
  missing: new Set<string>(),
  openFilePreview: vi.fn(),
  switchFileTab: vi.fn(),
  closeFileTab: vi.fn(),
  reorderFileTabs: vi.fn(),
  rerender: null as null | (() => void),
  readFileBase64: vi.fn(),
  // 设了就改用 React 状态做的工作区（见下面的 RealishWorkspace）
  useWorkspace: null as null | (() => FakeWorkspaceValue),
  // 连的是哪个服务器：null 是本机
  remoteId: null as number | null,
}))

type FakeWorkspaceValue = {
  actions: {
    openFilePreview: (
      path: string,
      options?: { background?: boolean }
    ) => Promise<string | null>
    switchFileTab: (id: string) => void
    closeFileTab: (id: string) => void
    reorderFileTabs: (tabs: FileWorkspaceTab[]) => void
  }
  fileTabs: FileWorkspaceTab[]
  activeFileTabId: string | null
}

vi.mock("@/lib/transport", () => ({
  getActiveRemoteConnectionId: () => mocks.remoteId,
}))

vi.mock("@/lib/api", () => ({
  readFileBase64: mocks.readFileBase64,
}))

vi.mock("@/contexts/active-folder-context", () => ({
  useActiveFolder: () => ({
    activeFolderId: mocks.folderId,
    activeFolder: null,
  }),
}))
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaceActions: () =>
    mocks.useWorkspace
      ? mocks.useWorkspace().actions
      : {
          openFilePreview: mocks.openFilePreview,
          switchFileTab: mocks.switchFileTab,
          closeFileTab: mocks.closeFileTab,
          reorderFileTabs: mocks.reorderFileTabs,
        },
  useWorkspaceFileTabs: () => {
    if (mocks.useWorkspace) {
      const { fileTabs, activeFileTabId } = mocks.useWorkspace()
      return { fileTabs, activeFileTabId }
    }
    return {
      fileTabs: mocks.fileTabs,
      allFileTabs: mocks.allFileTabs ?? undefined,
      activeFileTabId: mocks.activeFileTabId,
    }
  },
}))

import {
  fileTabsStorageKey,
  readPersistedFileTabs,
  readSharedFileTabs,
  writePersistedFileTabs,
  writeSharedFileTabs,
} from "@/lib/files/file-tab-persistence"
import {
  clearFileTabEvictionMarks,
  markFileTabsEvictedByCap,
  resetFileTabEvictionsForTests,
} from "@/lib/files/file-tab-evictions"
import { pickTabsToEvict, TabRecency } from "@/lib/tab-limit"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  openingScope,
  resetFolderTabsStore,
  useFolderTabsStore,
} from "@/stores/folder-tabs-store"
import {
  FileTabsPersistence,
  resetFileTabsPersistenceForTests,
} from "./file-tabs-persistence"

function isOffice(path: string): boolean {
  return /\.(docx|xlsx|pptx)$/.test(path)
}

function appError(code: string): Error {
  return new Error(JSON.stringify({ code, message: code }))
}

function fileTab(path: string, error = false): FileWorkspaceTab {
  return {
    id: `file:${encodeURIComponent(path)}`,
    kind: "file",
    folderId: null,
    title: path.split("/").pop() ?? path,
    description: path,
    path,
    language: "plaintext",
    content: error ? "unable" : "x",
    loading: false,
    saveState: error ? "error" : "idle",
    saveError: error ? "not found" : null,
  }
}

// 和真实的 provider 一样用 React 状态存标签：标签的 ref 在提交后的 effect 里
// 才更新（而且父组件的 effect 在子组件之后跑），switchFileTab 只认 ref 里有的
// 标签；办公文档打开时不读内容，加完标签就返回，中间不等提交。
const FakeWorkspaceContext = createContext<FakeWorkspaceValue | null>(null)
const observed = {
  fileTabs: [] as FileWorkspaceTab[],
  activeFileTabId: null as string | null,
}

function RealishWorkspace({ children }: { children: ReactNode }) {
  const [fileTabs, setFileTabs] = useState<FileWorkspaceTab[]>([])
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null)
  const fileTabsRef = useRef<FileWorkspaceTab[]>([])
  useEffect(() => {
    fileTabsRef.current = fileTabs
    observed.fileTabs = fileTabs
  }, [fileTabs])
  useEffect(() => {
    observed.activeFileTabId = activeFileTabId
  }, [activeFileTabId])
  const actions = useMemo<FakeWorkspaceValue["actions"]>(
    () => ({
      openFilePreview: async (path) => {
        const tab = fileTab(path, mocks.missing.has(path) && !isOffice(path))
        setFileTabs((prev) =>
          prev.some((candidate) => candidate.id === tab.id)
            ? prev
            : [...prev, tab]
        )
        setActiveFileTabId((prev) => prev ?? tab.id)
        if (!isOffice(path)) await Promise.resolve()
        return path
      },
      switchFileTab: (id) => {
        if (!fileTabsRef.current.some((tab) => tab.id === id)) return
        setActiveFileTabId(id)
      },
      closeFileTab: (id) =>
        setFileTabs((prev) => prev.filter((tab) => tab.id !== id)),
      reorderFileTabs: (tabs) => setFileTabs(tabs),
    }),
    []
  )
  const value = useMemo(
    () => ({ actions, fileTabs, activeFileTabId }),
    [actions, fileTabs, activeFileTabId]
  )
  return (
    <FakeWorkspaceContext.Provider value={value}>
      {children}
    </FakeWorkspaceContext.Provider>
  )
}

function useFakeWorkspace(): FakeWorkspaceValue {
  const value = useContext(FakeWorkspaceContext)
  if (!value) throw new Error("RealishWorkspace missing")
  return value
}

async function flush() {
  await act(async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve()
    // 选中记下的那个是推到下一轮做的
    vi.advanceTimersByTime(0)
  })
}

// 标签跟随项目时的假工作区：每个项目一组标签、一个选中项，看到的是当前项目那组。
// 带 folderId 打开的加进那个项目（不在看的项目就是后台），换项目时可见的标签栏跟着换。
// 给了 cap 就和真实的工作区一样：所有项目合计最多开 cap 个文件，用真实的 TabRecency
// 和 pickTabsToEvict 按最近使用的顺序关掉最久没用的（新开的和正看着的选中项除外），
// 关的时候所有项目里都关掉。lazy：像真实工作区的 layout effect 那样先让超了的那一下
// 渲染出来，再关。dirty：有没保存改动的标签路径，上限不关它们。
function useScopedTabs(
  cap = Infinity,
  { lazy = false, dirty = new Set<string>() } = {}
) {
  const scopes = new Map<number, FileWorkspaceTab[]>()
  const actives = new Map<number, string | null>()
  // 所有项目的标签按打开的先后排（真实工作区的缓冲区列表）。
  let buffers: string[] = []
  const recency = new TabRecency()
  const show = () => {
    const folder = mocks.folderId ?? -1
    mocks.fileTabs = scopes.get(folder) ?? []
    mocks.activeFileTabId = actives.get(folder) ?? null
    const present = new Set([...scopes.values()].flat().map((tab) => tab.id))
    buffers = [
      ...buffers.filter((id) => present.has(id)),
      ...[...present].filter((id) => !buffers.includes(id)),
    ]
    mocks.allFileTabs = buffers.map(
      (id) => [...scopes.values()].flat().find((tab) => tab.id === id)!
    )
  }
  const fileTabsById = () =>
    new Map([...scopes.values()].flat().map((tab) => [tab.id, tab]))
  // 和真实工作区的 layout effect 一样：每次变了都同步一下最近使用，超了就关。
  const evict = () => {
    show()
    const keep = actives.get(mocks.folderId ?? -1) ?? null
    recency.sync(buffers, keep)
    // 和真实工作区一样：开着的不再算上限关过的，关之前记下这次关的是哪几个。
    const pathOf = (id: string) => fileTabsById().get(id)?.path ?? ""
    clearFileTabEvictionMarks(buffers.map(pathOf))
    if (buffers.length <= cap) return
    const dirtyIds = new Set([...dirty].map((path) => fileTab(path).id))
    const victims = pickTabsToEvict(
      buffers,
      cap,
      recency,
      (id) => id === keep || dirtyIds.has(id)
    )
    markFileTabsEvictedByCap(victims.map(pathOf))
    if (lazy) mocks.rerender?.()
    for (const victim of victims) {
      for (const [folder, list] of scopes) {
        const next = list.filter((tab) => tab.id !== victim)
        scopes.set(folder, next)
        if (actives.get(folder) === victim)
          actives.set(folder, next[0]?.id ?? null)
      }
    }
    show()
    recency.sync(buffers, keep)
  }
  mocks.openFilePreview.mockImplementation(
    async (path: string, options?: { folderId?: number }) => {
      const folder = options?.folderId ?? mocks.folderId ?? -1
      const list = scopes.get(folder) ?? []
      if (!list.some((tab) => tab.path === path)) {
        const tab = fileTab(path, mocks.missing.has(path) && !isOffice(path))
        scopes.set(folder, [...list, tab])
        if (!actives.get(folder)) actives.set(folder, tab.id)
      }
      evict()
      mocks.rerender?.()
      return path
    }
  )
  mocks.switchFileTab.mockImplementation((id: string) => {
    const folder = mocks.folderId ?? -1
    if (!(scopes.get(folder) ?? []).some((tab) => tab.id === id)) return
    actives.set(folder, id)
    evict()
    mocks.rerender?.()
  })
  mocks.reorderFileTabs.mockImplementation((tabs: FileWorkspaceTab[]) => {
    scopes.set(mocks.folderId ?? -1, tabs)
    show()
    mocks.rerender?.()
  })
  mocks.closeFileTab.mockImplementation((id: string) => {
    const folder = mocks.folderId ?? -1
    const next = (scopes.get(folder) ?? []).filter((tab) => tab.id !== id)
    scopes.set(folder, next)
    if (actives.get(folder) === id) actives.set(folder, next[0]?.id ?? null)
    show()
    mocks.rerender?.()
  })
  return {
    /** 用户在当前项目里改标签栏 */
    edit(tabs: FileWorkspaceTab[], active: string | null) {
      const folder = mocks.folderId ?? -1
      scopes.set(folder, tabs)
      actives.set(folder, active)
      evict()
      mocks.rerender?.()
    },
    /** 用户在当前项目里关掉一个标签，不重新渲染（和下一次变化落在同一次渲染里） */
    drop(path: string) {
      const folder = mocks.folderId ?? -1
      const next = (scopes.get(folder) ?? []).filter((tab) => tab.path !== path)
      scopes.set(folder, next)
      if (actives.get(folder) === fileTab(path).id)
        actives.set(folder, next[0]?.id ?? null)
    },
    /** 换项目：项目、可见的标签栏和范围一起变 */
    async switchTo(folderId: number) {
      mocks.folderId = folderId
      evict()
      await act(async () => {
        useFolderTabsStore.setState({ scope: folderId })
        mocks.rerender?.()
      })
    },
    paths(folderId: number) {
      return (scopes.get(folderId) ?? []).map((tab) => tab.path)
    },
    active(folderId: number) {
      return actives.get(folderId) ?? null
    },
  }
}

describe("FileTabsPersistence", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    localStorage.clear()
    resetFileTabsPersistenceForTests()
    resetFileTabEvictionsForTests()
    resetFolderTabsStore()
    // 开关的值默认当成已经读出来了；要测「还没读出来」的单独改回去。
    useFolderTabsStore.setState({ preferenceHydrated: true })
    mocks.folderId = 7
    mocks.remoteId = null
    mocks.fileTabs = []
    mocks.allFileTabs = null
    mocks.activeFileTabId = null
    mocks.missing = new Set()
    mocks.openFilePreview.mockReset()
    mocks.openFilePreview.mockImplementation(async (path: string) => {
      if (!mocks.fileTabs.some((tab) => tab.path === path)) {
        mocks.fileTabs = [
          ...mocks.fileTabs,
          fileTab(path, mocks.missing.has(path) && !isOffice(path)),
        ]
        mocks.activeFileTabId ??= mocks.fileTabs[0].id
      }
      mocks.rerender?.()
      return path
    })
    mocks.readFileBase64.mockReset()
    mocks.readFileBase64.mockImplementation(async (path: string) => {
      if (mocks.missing.has(path)) throw appError("not_found")
      return ""
    })
    mocks.switchFileTab.mockReset()
    mocks.switchFileTab.mockImplementation((id: string) => {
      mocks.activeFileTabId = id
      mocks.rerender?.()
    })
    mocks.reorderFileTabs.mockReset()
    mocks.reorderFileTabs.mockImplementation((tabs: FileWorkspaceTab[]) => {
      mocks.fileTabs = tabs
      mocks.rerender?.()
    })
    mocks.closeFileTab.mockReset()
    mocks.closeFileTab.mockImplementation((id: string) => {
      mocks.fileTabs = mocks.fileTabs.filter((tab) => tab.id !== id)
      if (mocks.activeFileTabId === id)
        mocks.activeFileTabId = mocks.fileTabs[0]?.id ?? null
      mocks.rerender?.()
    })
  })

  afterEach(() => {
    mocks.rerender = null
    mocks.useWorkspace = null
    vi.useRealTimers()
  })

  function mount() {
    const view = render(<FileTabsPersistence />)
    mocks.rerender = () => view.rerender(<FileTabsPersistence />)
    return view
  }

  it("刷新前的标签、顺序和选中项在刷新后回来", async () => {
    // 第一次：打开三个、拖动顺序、关掉一个、选中一个
    const first = mount()
    await flush()
    const readme = fileTab("/repo/README.md")
    const flags = fileTab("/repo/src/flags.ts")
    const version = fileTab("/repo/src/version.ts")
    mocks.fileTabs = [flags, version, readme]
    mocks.activeFileTabId = readme.id
    mocks.rerender?.()
    mocks.fileTabs = [readme, flags, version]
    mocks.rerender?.()
    mocks.fileTabs = [readme, version]
    mocks.activeFileTabId = version.id
    mocks.rerender?.()
    await act(async () => {
      vi.advanceTimersByTime(400)
    })
    first.unmount()

    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/README.md", "/repo/src/version.ts"],
      active: "/repo/src/version.ts",
    })

    // 刷新：新文档，标签栏从空开始
    resetFileTabsPersistenceForTests()
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()

    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/README.md",
      "/repo/src/version.ts",
    ])
    expect(mocks.activeFileTabId).toBe(version.id)
    // 一个个在后台打开，不抢焦点；最后才选中记下的那个
    for (const call of mocks.openFilePreview.mock.calls) {
      expect(call[1]).toMatchObject({ background: true })
    }
    expect(mocks.switchFileTab).toHaveBeenCalledWith(version.id)
  })

  it("记下的文件已经不在了就跳过，不报错", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/gone.ts", "/repo/b.ts"],
      active: "/repo/b.ts",
    })
    mocks.missing.add("/repo/gone.ts")
    mount()
    await flush()
    await flush()

    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ])
    expect(mocks.activeFileTabId).toBe(fileTab("/repo/b.ts").id)
  })

  it("办公文档不在了也跳过（打开时不读内容，标签不会出错）", async () => {
    writePersistedFileTabs(7, {
      paths: [
        "/repo/a.ts",
        "/repo/gone.docx",
        "/repo/big.pptx",
        "/repo/b.xlsx",
      ],
      active: "/repo/gone.docx",
    })
    mocks.missing.add("/repo/gone.docx")
    // 文件在、只是太大：不是「不在了」，照样恢复
    mocks.readFileBase64.mockImplementation(async (path: string) => {
      if (path === "/repo/big.pptx") throw appError("invalid_input")
      if (mocks.missing.has(path)) throw appError("not_found")
      return ""
    })
    mount()
    await flush()
    await flush()

    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/repo/big.pptx",
      "/repo/b.xlsx",
    ])
    expect(mocks.openFilePreview).not.toHaveBeenCalledWith(
      "/repo/gone.docx",
      expect.anything()
    )
    // 只有办公文档要先探一下，普通文件照旧靠打开时读不到来判断
    expect(mocks.readFileBase64).not.toHaveBeenCalledWith(
      "/repo/a.ts",
      expect.anything()
    )
    expect(mocks.switchFileTab).not.toHaveBeenCalled()
  })

  it("最后恢复的是选中的办公文档时也能选中（标签要等提交后才认）", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/report.docx"],
      active: "/repo/report.docx",
    })
    mocks.useWorkspace = useFakeWorkspace
    observed.fileTabs = []
    observed.activeFileTabId = null
    render(
      <RealishWorkspace>
        <FileTabsPersistence />
      </RealishWorkspace>
    )
    await flush()
    await flush()
    await flush()

    expect(observed.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/repo/report.docx",
    ])
    expect(observed.activeFileTabId).toBe(fileTab("/repo/report.docx").id)
  })

  it("恢复时关掉读不到的标签，不会把选中记下的那个弄丢", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/gone.ts"],
      active: "/repo/b.ts",
    })
    mocks.missing.add("/repo/gone.ts")
    mocks.useWorkspace = useFakeWorkspace
    observed.fileTabs = []
    observed.activeFileTabId = null
    render(
      <RealishWorkspace>
        <FileTabsPersistence />
      </RealishWorkspace>
    )
    await flush()
    await flush()
    await flush()

    expect(observed.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ])
    expect(observed.activeFileTabId).toBe(fileTab("/repo/b.ts").id)
  })

  it("恢复到一半换了项目：后面的不再打开，也不往新项目里写原项目的标签", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/c.ts",
    })
    writePersistedFileTabs(8, { paths: ["/other/x.ts"], active: null })
    // 第一个文件读得慢：读完之前用户换到了项目 8
    let releaseFirst: () => void = () => {}
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementationOnce(
      (path: string, options?: unknown) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(base(path, options))
        })
    )
    mount()
    await flush()
    mocks.folderId = 8
    mocks.rerender?.()
    await act(async () => {
      releaseFirst()
    })
    await flush()
    await flush()

    // 原项目后面的文件不再打开，换成恢复项目 8 的
    const callsFor = (folderId: number) =>
      mocks.openFilePreview.mock.calls.filter(
        (call) => (call[1] as { folderId?: number }).folderId === folderId
      )
    expect(callsFor(7)).toHaveLength(1)
    expect(callsFor(7)[0][1]).toMatchObject({ background: true })
    expect(callsFor(8).map((call) => call[0])).toEqual(["/other/x.ts"])
    expect(mocks.switchFileTab).not.toHaveBeenCalled()
    // 只是换了项目、恢复出来的标签：新项目记下的不被冲掉
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/x.ts"],
      active: null,
    })

    // 回到项目 7：标签不跟随项目时标签栏是共用的一排，已经恢复过了，切回来原样
    // 不动，不补开 7 剩下的（项目 8 的 x 比读得慢的 a 先进标签栏）；记录不变
    mocks.folderId = 7
    mocks.rerender?.()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/other/x.ts",
      "/repo/a.ts",
    ])
    expect(mocks.switchFileTab).not.toHaveBeenCalled()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/c.ts",
    })
  })

  it("标签跟随项目：换项目时标签栏跟着变，不当成改了标签，不冲掉别的项目记下的", async () => {
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    writePersistedFileTabs(8, { paths: ["/other/x.ts"], active: null })
    writePersistedFileTabs(9, { paths: ["/third/y.ts"], active: null })
    const tabs = useScopedTabs()
    mount()
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a.ts"])

    // 换到项目 8：项目和可见的标签栏在同一次渲染里一起变
    await tabs.switchTo(8)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/x.ts"],
      active: null,
    })

    // 换到项目 9：项目先变，标签栏的范围晚一次渲染才跟上
    mocks.folderId = 9
    mocks.rerender?.()
    await tabs.switchTo(9)
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(9)).toEqual({
      paths: ["/third/y.ts"],
      active: null,
    })

    // 在项目 9 里真的改了标签，照样记下
    const opened = fileTab("/third/w.ts")
    tabs.edit([...mocks.fileTabs, opened], opened.id)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(9)).toEqual({
      paths: ["/third/y.ts", "/third/w.ts"],
      active: "/third/w.ts",
    })
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts"],
      active: "/repo/a.ts",
    })
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/x.ts"],
      active: null,
    })
  })

  it("标签跟随项目：切到哪个项目就恢复哪个项目的标签，在那里新开文件不冲掉原来的", async () => {
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    writePersistedFileTabs(8, {
      paths: ["/other/x.ts", "/other/y.ts"],
      active: "/other/y.ts",
    })
    const tabs = useScopedTabs()
    mount()
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a.ts"])

    await tabs.switchTo(8)
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual(["/other/x.ts", "/other/y.ts"])
    expect(mocks.activeFileTabId).toBe(fileTab("/other/y.ts").id)
    // 打开的是项目 8 的标签栏
    expect(mocks.openFilePreview).toHaveBeenCalledWith("/other/x.ts", {
      background: true,
      folderId: 8,
    })

    // 在项目 8 新开一个文件：记录是原来的加上新的
    const opened = fileTab("/other/z.ts")
    tabs.edit([...mocks.fileTabs, opened], opened.id)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/x.ts", "/other/y.ts", "/other/z.ts"],
      active: "/other/z.ts",
    })

    // 切回 7 再切到 8：同一个页面里每个项目只恢复一次
    await tabs.switchTo(7)
    await flush()
    await tabs.switchTo(8)
    await flush()
    expect(
      mocks.openFilePreview.mock.calls.filter(
        (call) => call[0] === "/other/x.ts"
      )
    ).toHaveLength(1)
  })

  it("标签不跟随项目：切到别的项目，共用那排原样不动，不补开那个项目以前记下的", async () => {
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    writePersistedFileTabs(8, {
      paths: ["/other/x.ts", "/other/y.ts"],
      active: "/other/x.ts",
    })
    mount()
    await flush()
    await flush()
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await flush()

    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual(["/repo/a.ts"])
    expect(mocks.activeFileTabId).toBe(fileTab("/repo/a.ts").id)
    expect(mocks.openFilePreview).not.toHaveBeenCalledWith(
      "/other/x.ts",
      expect.anything()
    )
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    // 只是换项目，不改两个项目的记录
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/x.ts", "/other/y.ts"],
      active: "/other/x.ts",
    })
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts"],
      active: "/repo/a.ts",
    })
  })

  it("标签不跟随项目：各项目只记自己开的文件；刷新后开回各自的项目，打开跟随后各组只有自己的", async () => {
    // 和真实的工作区一样：开文件时登记到它所在项目的标签组
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      async (path: string, options?: { folderId?: number }) => {
        register(path, options?.folderId)
        return base(path, options)
      }
    )
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    const first = mount()
    await flush()
    await flush()
    // 在 A 里开 a.ts
    const a = fileTab("/repo/a.ts")
    await act(async () => {
      register(a.path!)
      mocks.fileTabs = [a]
      mocks.activeFileTabId = a.id
      mocks.rerender?.()
    })
    // 到 B 里开 x.ts，共用那排是 a、x
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    const x = fileTab("/other/x.ts")
    await act(async () => {
      register(x.path!)
      mocks.fileTabs = [a, x]
      mocks.activeFileTabId = x.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7).paths).toEqual(["/repo/a.ts"])
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/x.ts"],
      active: "/other/x.ts",
    })
    first.unmount()
    // 卸掉的那个不能再 rerender（不然刷新后第一个打开的会当成打不开）
    mocks.rerender = null

    // 刷新：回到 A，共用那排原样回来，每个文件开回它自己的项目
    resetFileTabsPersistenceForTests()
    resetFolderTabsStore()
    useFolderTabsStore.setState({ preferenceHydrated: true })
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.folderId = 7
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    const second = mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/other/x.ts",
    ])
    expect(mocks.activeFileTabId).toBe(x.id)
    // 打开跟随：A 的组里只有 a，B 的组里只有 x
    const refs = useFolderTabsStore.getState().fileRefs
    expect(refs[7]).toEqual([a.id])
    expect(refs[8]).toEqual([x.id])
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    second.unmount()
    mocks.rerender = null

    // 真的打开跟随再刷新：A 只恢复出 a，切到 B 只恢复出 x
    resetFileTabsPersistenceForTests()
    resetFolderTabsStore()
    useFolderTabsStore.setState({
      preferenceHydrated: true,
      enabled: true,
      scope: 7,
    })
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.folderId = 7
    mocks.openFilePreview.mockReset()
    const tabs = useScopedTabs()
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a.ts"])
    await tabs.switchTo(8)
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual(["/other/x.ts"])
    expect(tabs.paths(7)).toEqual(["/repo/a.ts"])
  })

  it("标签不跟随项目：同一个文件在几个项目里都开着，刷新后开回每一个项目", async () => {
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      async (path: string, options?: { folderId?: number }) => {
        register(path, options?.folderId)
        return base(path, options)
      }
    )
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    const first = mount()
    await flush()
    await flush()
    // 在 A 里开 shared.ts
    const shared = fileTab("/shared/shared.ts")
    await act(async () => {
      register(shared.path!)
      mocks.fileTabs = [shared]
      mocks.activeFileTabId = shared.id
      mocks.rerender?.()
    })
    // 到 B 里又开了一次 shared.ts（登记进 B 的组），再开 x.ts
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    const x = fileTab("/other/x.ts")
    await act(async () => {
      register(shared.path!)
      register(x.path!)
      mocks.fileTabs = [shared, x]
      mocks.activeFileTabId = x.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    first.unmount()
    // 卸掉的那个不能再 rerender（不然刷新后第一个打开的会当成打不开）
    mocks.rerender = null

    // 刷新：回到 A
    resetFileTabsPersistenceForTests()
    resetFolderTabsStore()
    useFolderTabsStore.setState({ preferenceHydrated: true })
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.folderId = 7
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/shared/shared.ts",
      "/other/x.ts",
    ])
    // A、B 两个组里都有 shared.ts：打开跟随后 B 不会少了它
    const refs = useFolderTabsStore.getState().fileRefs
    expect(refs[7]).toEqual([shared.id])
    expect(refs[8]).toEqual([shared.id, x.id])
  })

  it("标签不跟随项目：在 B 里点开 A 开着、正选中的文件，标签栏没变也记下它在 B 里开着", async () => {
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mount()
    await flush()
    await flush()
    const a = fileTab("/repo/a.ts")
    await act(async () => {
      register(a.path!)
      mocks.fileTabs = [a]
      mocks.activeFileTabId = a.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    // 在 B 里点开 a.ts：只登记进 B 的组，标签栏和选中项都不变
    await act(async () => {
      register(a.path!)
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readSharedFileTabs()?.owners.get("/repo/a.ts")).toEqual([7, 8])
  })

  it("标签不跟随项目：在 B 里点开 A 开着、正选中的文件，B 的记录也记上它；打开跟随再刷新，B 里有它", async () => {
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    const first = mount()
    await flush()
    await flush()
    const a = fileTab("/repo/a.ts")
    await act(async () => {
      register(a.path!)
      mocks.fileTabs = [a]
      mocks.activeFileTabId = a.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    // 在 B 里点开 a.ts：只登记进 B 的组，标签栏和选中项都不变
    await act(async () => {
      register(a.path!)
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/repo/a.ts"],
      active: "/repo/a.ts",
    })
    first.unmount()
    mocks.rerender = null

    // 打开跟随，在 B 里刷新：B 恢复它自己的记录，里面有 a.ts
    resetFileTabsPersistenceForTests()
    resetFolderTabsStore()
    useFolderTabsStore.setState({
      preferenceHydrated: true,
      enabled: true,
      scope: 8,
    })
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    const tabs = useScopedTabs()
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual(["/repo/a.ts"])
    expect(tabs.active(8)).toBe(a.id)
  })

  it("标签不跟随项目：在两个项目间点开对方的文件，再打开跟随刷新，每个项目自己的文件都在（被上限挤掉的也在）", async () => {
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    // 和真实的工作区一样：点开标签时登记进当前项目的组，再选中它
    mocks.switchFileTab.mockImplementation((id: string) => {
      useFolderTabsStore.getState().addFile(id, openingScope(), true)
      mocks.activeFileTabId = id
      mocks.rerender?.()
    })
    const save = async () => {
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
    }
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    const first = mount()
    await flush()
    await flush()
    // docs-site（7）里开 index.md、intro.md
    const index = fileTab("/docs/index.md")
    const intro = fileTab("/docs/intro.md")
    await act(async () => {
      register(index.path!)
      register(intro.path!)
      mocks.fileTabs = [index, intro]
      mocks.activeFileTabId = intro.id
      mocks.rerender?.()
    })
    await save()
    // 到 demo（8）里开 package.json、version.ts：最多三个，index.md 被上限挤掉
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    const pkg = fileTab("/demo/package.json")
    const version = fileTab("/demo/version.ts")
    await act(async () => {
      register(pkg.path!)
      mocks.fileTabs = [index, intro, pkg]
      mocks.activeFileTabId = pkg.id
      mocks.rerender?.()
    })
    await act(async () => {
      register(version.path!)
      markFileTabsEvictedByCap([index.path!])
      useFolderTabsStore.getState().forgetFile(index.id)
      mocks.fileTabs = [intro, pkg, version]
      mocks.activeFileTabId = version.id
      mocks.rerender?.()
    })
    await save()
    // 回 docs-site，点开 demo 的 package.json
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.folderId = 7
    mocks.rerender?.()
    await flush()
    await act(async () => {
      mocks.switchFileTab(pkg.id)
    })
    await save()
    // 到 demo，点开 docs-site 的 intro.md
    useAppWorkspaceStore.setState({ activeFolderId: 8 })
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await act(async () => {
      mocks.switchFileTab(intro.id)
    })
    await save()
    expect(readPersistedFileTabs(7).paths).toEqual([
      "/docs/index.md",
      "/docs/intro.md",
      "/demo/package.json",
    ])
    first.unmount()
    mocks.rerender = null

    // 打开跟随，在 docs-site 里刷新：它自己开过的都回来，切到 demo 也是
    resetFileTabsPersistenceForTests()
    resetFolderTabsStore()
    useFolderTabsStore.setState({
      preferenceHydrated: true,
      enabled: true,
      scope: 7,
    })
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.folderId = 7
    mocks.openFilePreview.mockReset()
    mocks.switchFileTab.mockReset()
    const tabs = useScopedTabs()
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual([
      "/docs/index.md",
      "/docs/intro.md",
      "/demo/package.json",
    ])
    await tabs.switchTo(8)
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual([
      "/docs/intro.md",
      "/demo/package.json",
      "/demo/version.ts",
    ])
  })

  it("标签不跟随项目：聊天会话和项目都开着同一个文件，刷新后聊天会话里也还有它", async () => {
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      async (path: string, options?: { folderId?: number }) => {
        register(path, options?.folderId)
        return base(path, options)
      }
    )
    // 9 是聊天会话的隐藏项目：它的标签在全局范围里
    useAppWorkspaceStore.setState({
      activeFolderId: 9,
      allFolders: [{ id: 9, kind: "chat" }] as never,
    })
    mocks.folderId = 9
    const first = mount()
    await flush()
    await flush()
    const shared = fileTab("/shared/notes.md")
    await act(async () => {
      register(shared.path!)
      mocks.fileTabs = [shared]
      mocks.activeFileTabId = shared.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    // 到项目 7 里又点开它
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.folderId = 7
    mocks.rerender?.()
    await flush()
    await act(async () => {
      register(shared.path!)
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    first.unmount()
    mocks.rerender = null

    // 刷新：在项目 7 里，共用那排开回项目 7 和聊天会话两边
    resetFileTabsPersistenceForTests()
    resetFolderTabsStore()
    useFolderTabsStore.setState({ preferenceHydrated: true })
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual(["/shared/notes.md"])
    const refs = useFolderTabsStore.getState().fileRefs
    expect(refs[7]).toEqual([shared.id])
    expect(refs.global).toEqual([shared.id])
    useAppWorkspaceStore.setState({ allFolders: [] })
  })

  it("标签不跟随项目：恢复几个项目都开着的文件时，开进第一个项目后就换了项目，新项目接着把它开进其余项目", async () => {
    const register = (path: string, folderId?: number) =>
      useFolderTabsStore
        .getState()
        .addFile(fileTab(path).id, openingScope(folderId), false)
    const shared = fileTab("/shared/shared.ts")
    writeSharedFileTabs(
      { paths: [shared.path!, "/other/x.ts"], active: shared.path! },
      undefined,
      new Map([
        [shared.path!, [7, 8]],
        ["/other/x.ts", [8]],
      ])
    )
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      async (path: string, options?: { folderId?: number }) => {
        register(path, options?.folderId)
        return base(path, options)
      }
    )
    // 开进项目 7 的那一次：标签已经出来、登记进了 7，还没返回时用户换到了项目 8
    let releaseFirst: () => void = () => {}
    mocks.openFilePreview.mockImplementationOnce(
      (path: string, options?: { folderId?: number }) => {
        register(path, options?.folderId)
        const opened = base(path, options)
        return new Promise((resolve) => {
          releaseFirst = () => resolve(opened)
        })
      }
    )
    useAppWorkspaceStore.setState({ activeFolderId: 7 })
    mount()
    await flush()
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await act(async () => {
      releaseFirst()
    })
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/shared/shared.ts",
      "/other/x.ts",
    ])
    const refs = useFolderTabsStore.getState().fileRefs
    expect(refs[7]).toEqual([shared.id])
    expect(refs[8]).toEqual([shared.id, fileTab("/other/x.ts").id])
  })

  it("标签不跟随项目：切到别的项目后就在那里打开跟随，不用切走再回来就恢复它自己的标签", async () => {
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    writePersistedFileTabs(8, {
      paths: ["/other/x.ts", "/other/y.ts"],
      active: "/other/y.ts",
    })
    mount()
    await flush()
    await flush()
    // 开关关着切到 8：共用那排不动
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual(["/repo/a.ts"])

    // 就在 8 里打开跟随：看到的是 8 自己的组（还是空的）
    await act(async () => {
      useFolderTabsStore.setState({ enabled: true, scope: 8 })
      mocks.fileTabs = []
      mocks.activeFileTabId = null
      mocks.rerender?.()
    })
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/other/x.ts",
      "/other/y.ts",
    ])
  })

  it("恢复过程中用户开、关、选中的标签也记下来，选中的不被记下的那个抢走", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/c.ts",
    })
    // 第一个文件读得慢：读完之前用户自己开了一个文件并选中
    let releaseFirst: () => void = () => {}
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementationOnce(
      (path: string, options?: unknown) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(base(path, options))
        })
    )
    mount()
    await flush()
    const mine = fileTab("/repo/mine.ts")
    mocks.fileTabs = [...mocks.fileTabs, mine]
    mocks.activeFileTabId = mine.id
    mocks.rerender?.()
    await act(async () => {
      releaseFirst()
    })
    await flush()
    await flush()
    // 恢复完了，用户再把 b 关掉
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/mine.ts",
      "/repo/a.ts",
      "/repo/b.ts",
      "/repo/c.ts",
    ])
    mocks.fileTabs = mocks.fileTabs.filter((tab) => tab.path !== "/repo/b.ts")
    mocks.rerender?.()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(mocks.activeFileTabId).toBe(mine.id)
    expect(mocks.switchFileTab).not.toHaveBeenCalled()
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/mine.ts", "/repo/a.ts", "/repo/c.ts"],
      active: "/repo/mine.ts",
    })
  })

  it("恢复过程中只拖动了顺序，恢复完也记下来", async () => {
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
    const tabs = useScopedTabs()
    // 第三个读得慢：用户在这之前把 b 拖到最前
    let releaseLast: () => void = () => {}
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      (path: string, options?: unknown) =>
        path === "/repo/c.ts"
          ? new Promise((resolve) => {
              releaseLast = () => resolve(base(path, options))
            })
          : base(path, options)
    )
    mount()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a.ts", "/repo/b.ts"])
    const [a, b] = mocks.fileTabs
    tabs.edit([b, a], mocks.activeFileTabId)
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    // 恢复还没完：先按用户拖的顺序写下，还没开出来的 c 接在后面，刷新也不丢
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/b.ts", "/repo/a.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
    await act(async () => {
      releaseLast()
    })
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/b.ts", "/repo/a.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
  })

  // 标签跟随项目，项目 7 记下 a、b、c，c 读得慢：a、b 开出来以后用户关掉 b。
  async function closeDuringRestore(tabs: ReturnType<typeof useScopedTabs>) {
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
    writePersistedFileTabs(8, { paths: ["/other/x.ts"], active: null })
    let releaseLast: () => void = () => {}
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      (path: string, options?: unknown) =>
        path === "/repo/c.ts"
          ? new Promise((resolve) => {
              releaseLast = () => resolve(base(path, options))
            })
          : base(path, options)
    )
    const view = mount()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a.ts", "/repo/b.ts"])
    const [a] = mocks.fileTabs
    await act(async () => {
      tabs.edit([a], a.id)
    })
    await flush()
    return { view, release: () => releaseLast() }
  }

  it("恢复过程中关掉的标签，切到别的项目再切回来不会被补开", async () => {
    const tabs = useScopedTabs()
    const { release } = await closeDuringRestore(tabs)
    await tabs.switchTo(8)
    await flush()
    await act(async () => {
      release()
    })
    await flush()
    await flush()
    await tabs.switchTo(7)
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(tabs.paths(7)).toEqual(["/repo/a.ts", "/repo/c.ts"])
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
  })

  it("恢复过程中关掉了标签、恢复完之前就刷新：关掉的不丢，还没开出来的也还在", async () => {
    const { view } = await closeDuringRestore(useScopedTabs())
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    view.unmount()
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
  })

  it("记录按服务器分开：连着远程服务器时不读本机同一个项目编号的记录", async () => {
    writePersistedFileTabs(7, { paths: ["/local/a.ts"], active: null })
    mocks.remoteId = 3
    writePersistedFileTabs(7, { paths: ["/remote/b.ts"], active: null })
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual(["/remote/b.ts"])
    const opened = fileTab("/remote/c.ts")
    mocks.fileTabs = [...mocks.fileTabs, opened]
    mocks.rerender?.()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7).paths).toEqual([
      "/remote/b.ts",
      "/remote/c.ts",
    ])
    mocks.remoteId = null
    expect(readPersistedFileTabs(7).paths).toEqual(["/local/a.ts"])
  })

  it("标签跟随项目、合计最多三个文件：两个项目来回切，各自的标签都能恢复", async () => {
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    writePersistedFileTabs(7, {
      paths: ["/repo/a1.ts", "/repo/a2.ts"],
      active: "/repo/a2.ts",
    })
    writePersistedFileTabs(8, {
      paths: ["/other/b1.ts", "/other/b2.ts"],
      active: "/other/b2.ts",
    })
    const tabs = useScopedTabs(3)
    mount()
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a1.ts", "/repo/a2.ts"])

    // 切到 8：开 8 的两个会挤掉 7 的一个
    await tabs.switchTo(8)
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual(["/other/b1.ts", "/other/b2.ts"])
    expect(tabs.paths(7)).toHaveLength(1)

    // 切回 7：被挤掉的补回来，顺序和选中项照记下的
    await tabs.switchTo(7)
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a1.ts", "/repo/a2.ts"])
    expect(tabs.active(7)).toBe(fileTab("/repo/a2.ts").id)

    // 再切到 8 也一样
    await tabs.switchTo(8)
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual(["/other/b1.ts", "/other/b2.ts"])
    expect(tabs.active(8)).toBe(fileTab("/other/b2.ts").id)

    // 都是恢复做的，两个项目的记录不变
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a1.ts", "/repo/a2.ts"],
      active: "/repo/a2.ts",
    })
    expect(readPersistedFileTabs(8)).toEqual({
      paths: ["/other/b1.ts", "/other/b2.ts"],
      active: "/other/b2.ts",
    })
  })

  it.each([
    ["关标签和打开在同一次渲染里", false],
    ["先渲染出超了的那一下再关", true],
  ])(
    "标签跟随项目、合计最多三个文件：补开时挤掉了自己另一个标签，也补回来、不改记录（%s）",
    async (_name, lazy) => {
      useFolderTabsStore.setState({ enabled: true, scope: 7 })
      writePersistedFileTabs(7, {
        paths: ["/repo/a1.ts", "/repo/a2.ts", "/repo/a3.ts"],
        active: "/repo/a1.ts",
      })
      const tabs = useScopedTabs(3, { lazy })
      mount()
      await flush()
      await flush()
      expect(tabs.paths(7)).toEqual([
        "/repo/a1.ts",
        "/repo/a2.ts",
        "/repo/a3.ts",
      ])
      expect(tabs.active(7)).toBe(fileTab("/repo/a1.ts").id)

      // 切到 8 开一个：上限挤掉 7 的 a2（最久没用的）
      await tabs.switchTo(8)
      await flush()
      const b1 = fileTab("/other/b1.ts")
      await act(async () => {
        tabs.edit([...mocks.fileTabs, b1], b1.id)
      })
      await flush()
      expect(tabs.paths(7)).toEqual(["/repo/a1.ts", "/repo/a3.ts"])

      // 切回 7：补开 a2 时上限按最近使用挤掉了 a3，a3 也要补回来，挤掉的换成 8 的
      await tabs.switchTo(7)
      await flush()
      await flush()
      await flush()
      await act(async () => {
        vi.advanceTimersByTime(1000)
      })
      expect(tabs.paths(7)).toEqual([
        "/repo/a1.ts",
        "/repo/a2.ts",
        "/repo/a3.ts",
      ])
      expect(tabs.active(7)).toBe(fileTab("/repo/a1.ts").id)
      expect(readPersistedFileTabs(7)).toEqual({
        paths: ["/repo/a1.ts", "/repo/a2.ts", "/repo/a3.ts"],
        active: "/repo/a1.ts",
      })
    }
  )

  it("标签跟随项目：恢复补开标签的同一次渲染里用户关掉一个，不当成上限挤掉的，不再补开", async () => {
    // 项目 8 先开着两个，合计已经快到上限
    mocks.folderId = 8
    useFolderTabsStore.setState({ enabled: true, scope: 8 })
    writePersistedFileTabs(8, {
      paths: ["/other/b1.ts", "/other/b2.ts"],
      active: "/other/b1.ts",
    })
    writePersistedFileTabs(7, {
      paths: ["/repo/a1.ts", "/repo/a2.ts", "/repo/a3.ts"],
      active: "/repo/a3.ts",
    })
    const tabs = useScopedTabs(3)
    const base = mocks.openFilePreview.getMockImplementation()!
    // 恢复补开 a2 的同一次渲染里，用户关掉了已经出来的 a1（合计没超，上限什么都没关）
    mocks.openFilePreview.mockImplementation(
      async (path: string, options?: { folderId?: number }) => {
        if (path === "/repo/a2.ts") tabs.drop("/repo/a1.ts")
        return base(path, options)
      }
    )
    mount()
    await flush()
    await flush()
    expect(tabs.paths(8)).toEqual(["/other/b1.ts", "/other/b2.ts"])

    await tabs.switchTo(7)
    await flush()
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(tabs.paths(7)).toEqual(["/repo/a2.ts", "/repo/a3.ts"])
    expect(readPersistedFileTabs(7).paths).toEqual([
      "/repo/a2.ts",
      "/repo/a3.ts",
    ])
  })

  it("标签不跟随项目：在项目 B 里关掉从 A 恢复出来的标签，切回 A 不再补开", async () => {
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    mount()
    await flush()
    await flush()
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await flush()
    // 在 8 里开 x
    await act(async () => {
      const x = fileTab("/other/x.ts")
      mocks.fileTabs = [...mocks.fileTabs, x]
      mocks.activeFileTabId = x.id
      mocks.rerender?.()
    })
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/other/x.ts",
    ])

    // 在 8 里关掉 A 的标签
    await act(async () => {
      mocks.fileTabs = mocks.fileTabs.filter((tab) => tab.path !== "/repo/a.ts")
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    // 切回 7：关掉的不再出现，7 的记录里也没有它了
    mocks.folderId = 7
    mocks.rerender?.()
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual(["/other/x.ts"])
    expect(readPersistedFileTabs(7).paths).toEqual([])
    expect(readPersistedFileTabs(8).paths).toEqual(["/other/x.ts"])
  })

  it("标签不跟随项目：在 B 里划掉了 A 记录里的标签，回 A 重新打开、和划掉前一模一样时也照写，刷新还在", async () => {
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    writePersistedFileTabs(8, {
      paths: ["/other/x.ts"],
      active: "/other/x.ts",
    })
    const first = mount()
    await flush()
    await flush()
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await flush()

    // 在 8 里关掉 A 的标签：7 的记录里划掉了
    await act(async () => {
      mocks.fileTabs = mocks.fileTabs.filter((tab) => tab.path !== "/repo/a.ts")
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7).paths).toEqual([])

    // 回 7：关掉 x、重新打开 a 并选中，标签栏和 7 原来记下的一模一样
    mocks.folderId = 7
    mocks.rerender?.()
    await flush()
    await flush()
    await act(async () => {
      const a = fileTab("/repo/a.ts")
      mocks.fileTabs = [a]
      mocks.activeFileTabId = a.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts"],
      active: "/repo/a.ts",
    })

    // 刷新：a 回来
    first.unmount()
    resetFileTabsPersistenceForTests()
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual(["/repo/a.ts"])
  })

  it("标签不跟随项目：在 B 里开了文件后刷新、回到 A，标签栏还是刷新前共用的那一排", async () => {
    // A 很早以前记下的三个；B 没有记录
    writePersistedFileTabs(7, {
      paths: ["/demo/package.json", "/demo/version.ts", "/demo/live.txt"],
      active: "/demo/live.txt",
    })
    const first = mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/demo/package.json",
      "/demo/version.ts",
      "/demo/live.txt",
    ])

    // 到 B 里开 index.md：上限挤掉了 live.txt，共用的一排是 index、package、version
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    const [pkg, version] = mocks.fileTabs
    const index = fileTab("/docs/index.md")
    await act(async () => {
      mocks.fileTabs = [index, pkg, version]
      mocks.activeFileTabId = index.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    first.unmount()

    // 刷新：活动项目回到 A
    resetFileTabsPersistenceForTests()
    mocks.folderId = 7
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/docs/index.md",
      "/demo/package.json",
      "/demo/version.ts",
    ])
    expect(mocks.activeFileTabId).toBe(index.id)
  })

  it("标签不跟随项目：会话标签全关掉、没有当前项目时改了共用那排，刷新后还是那一排", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts"],
      active: "/repo/a.ts",
    })
    const first = mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/a.ts",
      "/repo/b.ts",
    ])

    // 会话标签全关掉：没有当前项目了，共用那排还开着文件；接着开一个、关一个、选一个
    mocks.folderId = null
    mocks.rerender?.()
    await flush()
    const [, b] = mocks.fileTabs
    const c = fileTab("/repo/c.ts")
    await act(async () => {
      mocks.fileTabs = [b, c]
      mocks.activeFileTabId = c.id
      mocks.rerender?.()
    })
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    first.unmount()
    expect(readSharedFileTabs()).toMatchObject({
      paths: ["/repo/b.ts", "/repo/c.ts"],
      active: "/repo/c.ts",
    })

    // 刷新：还是没有当前项目，共用那排原样回来
    resetFileTabsPersistenceForTests()
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/repo/b.ts",
      "/repo/c.ts",
    ])
    expect(mocks.activeFileTabId).toBe(c.id)
  })

  it("标签不跟随项目：刷新后恢复共用那排还没做完就换了项目，新项目接着恢复共用那排，不把它冲掉", async () => {
    writeSharedFileTabs({
      paths: ["/docs/index.md", "/demo/package.json", "/demo/version.ts"],
      active: "/docs/index.md",
    })
    writePersistedFileTabs(7, {
      paths: ["/demo/package.json", "/demo/version.ts", "/demo/live.txt"],
      active: "/demo/live.txt",
    })
    writePersistedFileTabs(8, { paths: ["/other/old.ts"], active: null })
    // 第一个文件开得慢：开完之前用户换到了项目 8
    let releaseFirst: () => void = () => {}
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementationOnce(
      (path: string, options?: unknown) =>
        new Promise((resolve) => {
          releaseFirst = () => resolve(base(path, options))
        })
    )
    const first = mount()
    await flush()
    mocks.folderId = 8
    mocks.rerender?.()
    await flush()
    await act(async () => {
      releaseFirst()
    })
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/docs/index.md",
      "/demo/package.json",
      "/demo/version.ts",
    ])
    first.unmount()

    // 再刷新：还是那一排
    resetFileTabsPersistenceForTests()
    mocks.folderId = 7
    mocks.fileTabs = []
    mocks.activeFileTabId = null
    mount()
    await flush()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([
      "/docs/index.md",
      "/demo/package.json",
      "/demo/version.ts",
    ])
    expect(mocks.activeFileTabId).toBe(fileTab("/docs/index.md").id)
  })

  it("标签不跟随项目：刷新后恢复共用那排的途中打开了跟随，剩下的不再开进这个项目，改恢复它自己的", async () => {
    writeSharedFileTabs({
      paths: ["/docs/index.md", "/demo/package.json", "/demo/version.ts"],
      active: "/docs/index.md",
    })
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    const tabs = useScopedTabs()
    const base = mocks.openFilePreview.getMockImplementation()!
    // 共用那排的第一个刚开出来，用户就打开了「标签页跟随文件夹」
    mocks.openFilePreview.mockImplementation(
      async (path: string, options?: { folderId?: number }) => {
        const resolved = await base(path, options)
        if (path === "/docs/index.md") {
          useFolderTabsStore.setState({ enabled: true, scope: 7 })
          mocks.rerender?.()
        }
        return resolved
      }
    )
    mount()
    await flush()
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(tabs.paths(7)).not.toContain("/demo/package.json")
    expect(tabs.paths(7)).not.toContain("/demo/version.ts")
    expect(tabs.paths(7)).toContain("/repo/a.ts")
  })

  it("刷新时先挂载、后读出开关为开：不读共用的那一排，只恢复这个项目自己的", async () => {
    writeSharedFileTabs({
      paths: ["/docs/index.md", "/demo/package.json", "/demo/version.ts"],
      active: "/docs/index.md",
    })
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    // 新文档：开关还没从本机读出来（enabled 还是初始的 false）
    useFolderTabsStore.setState({ preferenceHydrated: false })
    const tabs = useScopedTabs()
    mount()
    await flush()
    await flush()
    // 读出来是开（没存过就是默认的开）
    await act(async () => {
      useFolderTabsStore.getState().hydratePreference()
      // 真实页面里范围由活动项目决定；这里的假工作区没有，直接给上
      useFolderTabsStore.setState({ scope: 7 })
      mocks.rerender?.()
    })
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(useFolderTabsStore.getState().enabled).toBe(true)
    expect(tabs.paths(7)).toEqual(["/repo/a.ts"])
    expect(mocks.openFilePreview).not.toHaveBeenCalledWith(
      "/docs/index.md",
      expect.anything()
    )
  })

  it("标签跟随项目时不读共用的那一排，照旧恢复这个项目自己的", async () => {
    writeSharedFileTabs({ paths: ["/docs/index.md"], active: "/docs/index.md" })
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: "/repo/a.ts" })
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    const tabs = useScopedTabs()
    mount()
    await flush()
    await flush()
    expect(tabs.paths(7)).toEqual(["/repo/a.ts"])
  })

  it("有没保存的标签让合计一直超过三个：用户自己关掉的标签不当成上限挤掉的，不再冒出来", async () => {
    useFolderTabsStore.setState({ enabled: true, scope: 7 })
    writePersistedFileTabs(7, {
      paths: ["/repo/d1.ts", "/repo/d2.ts", "/repo/d3.ts", "/repo/mine.ts"],
      active: "/repo/mine.ts",
    })
    // 恢复出来以后三个都改了没保存，加上选中的那个：上限一个都关不了，合计停在四个
    const dirty = new Set(["/repo/d1.ts", "/repo/d2.ts", "/repo/d3.ts"])
    const tabs = useScopedTabs(3, { dirty })
    mount()
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    const d = [...dirty].map((path) => fileTab(path))
    expect(tabs.paths(7)).toEqual([...dirty, "/repo/mine.ts"])
    expect(tabs.active(7)).toBe(fileTab("/repo/mine.ts").id)

    // 用户关掉选中的那个，然后在没保存的标签里接着改（标签栏又变了一下：选中 d1）
    await act(async () => {
      tabs.edit(d, d[0].id)
    })
    await flush()
    await act(async () => {
      tabs.edit(d, d[1].id)
    })
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    expect(tabs.paths(7)).toEqual([...dirty])
    expect(tabs.active(7)).toBe(d[1].id)
    expect(readPersistedFileTabs(7)).toEqual({
      paths: [...dirty],
      active: "/repo/d2.ts",
    })
  })

  it("恢复时选中的是浏览器标签：用户选中恢复出来的文件，不被记下的那个抢走", async () => {
    writePersistedFileTabs(7, {
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/c.ts",
    })
    const browser = {
      ...fileTab("/web"),
      id: "browser:1",
      kind: "browser",
      path: null,
      language: "browser",
      browser: {},
    } as unknown as FileWorkspaceTab
    mocks.fileTabs = [browser]
    mocks.activeFileTabId = browser.id
    // 第二个文件读得慢：这时用户选中已经开出来的 a
    let releaseSecond: () => void = () => {}
    const base = mocks.openFilePreview.getMockImplementation()!
    mocks.openFilePreview.mockImplementation(
      (path: string, options?: unknown) =>
        path === "/repo/b.ts"
          ? new Promise((resolve) => {
              releaseSecond = () => resolve(base(path, options))
            })
          : base(path, options)
    )
    mount()
    await flush()
    expect(mocks.fileTabs.map((tab) => tab.path)).toEqual([null, "/repo/a.ts"])
    // 浏览器标签选中时，工作区不会自己去选新开的文件
    expect(mocks.activeFileTabId).toBe(browser.id)
    mocks.activeFileTabId = fileTab("/repo/a.ts").id
    mocks.rerender?.()
    await act(async () => {
      releaseSecond()
    })
    await flush()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })

    expect(mocks.activeFileTabId).toBe(fileTab("/repo/a.ts").id)
    expect(mocks.switchFileTab).not.toHaveBeenCalled()
    expect(readPersistedFileTabs(7)).toEqual({
      paths: ["/repo/a.ts", "/repo/b.ts", "/repo/c.ts"],
      active: "/repo/a.ts",
    })
  })

  it("恢复完成前不写，空标签栏不会冲掉上次记下的", async () => {
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: null })
    // 打开文件一直不返回：恢复没完成
    mocks.openFilePreview.mockImplementation(() => new Promise(() => {}))
    const view = mount()
    await flush()
    await act(async () => {
      vi.advanceTimersByTime(1000)
    })
    view.unmount()
    expect(readPersistedFileTabs(7).paths).toEqual(["/repo/a.ts"])
  })

  it("没有项目时什么都不做", async () => {
    mocks.folderId = null
    writePersistedFileTabs(7, { paths: ["/repo/a.ts"], active: null })
    mount()
    await flush()
    expect(mocks.openFilePreview).not.toHaveBeenCalled()
    expect(localStorage.getItem(fileTabsStorageKey(7))).not.toBeNull()
  })
})
