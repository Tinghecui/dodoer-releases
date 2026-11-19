"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  getSystemTerminalSettings,
  terminalKill,
  terminalSnapshot,
} from "@/lib/api"
import { getActiveRemoteConnectionId, getTransport } from "@/lib/transport"
import { FOLDER_CHANGED_EVENT, type FolderChange } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useFolderTabsStore } from "@/stores/folder-tabs-store"
import { useShortcutSettings } from "@/hooks/use-shortcut-settings"
import { matchShortcutEvent } from "@/lib/keyboard-shortcuts"
import {
  commandLinkKey,
  useCommandTerminalLinkStore,
} from "@/stores/command-terminal-link-store"

export interface TerminalTab {
  id: string
  folderId: number
  title: string
  workingDir: string
  shell?: string
  initialCommand?: string
  /** The launcher command this tab was started for. Not the command itself. */
  commandId?: number
  restored?: boolean
}

const DEFAULT_HEIGHT = 300
const MIN_HEIGHT = 150
const MAX_HEIGHT = 600
const TERMINAL_SETTINGS_UPDATED_EVENT = "app://terminal-settings-updated"

const TERMINAL_SESSION_KEY = "codeg:terminal-session:v1"
const PAGE_NAME_PREFIX = "codeg-terminal-page:"
const MAX_STORED_TITLE_LENGTH = 256
const DEFAULT_TITLE = /^Terminal (\d+)$/
const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** `commandId` is judged on its own: a bad one costs the tab its link to a
 *  launcher command, not its way back to its PTY. */
type StoredTerminalTab = Pick<
  TerminalTab,
  "id" | "folderId" | "title" | "workingDir" | "shell"
> & { commandId?: unknown }

interface StoredTerminalSession {
  version: 1
  scope: string
  pageId: string
  isOpen: boolean
  activeTabId: string | null
  tabs: StoredTerminalTab[]
}

/**
 * Whether one stored tab may come back. Judged per tab, so an entry the reader
 * rejects costs that tab alone rather than every other tab's way back to its
 * PTY — and every bound here must admit whatever the writer below persists.
 * `workingDir` and `shell` only ever launch a tab's first process, and a
 * restored tab never launches one, so any string the writer kept will do.
 */
function isRestorableTab(tab: unknown): tab is StoredTerminalTab {
  if (typeof tab !== "object" || tab === null) return false
  const { id, folderId, title, workingDir, shell } = tab as Record<
    string,
    unknown
  >
  return (
    typeof id === "string" &&
    UUID_V4.test(id) &&
    // 0 is a real value: a tab opened while no workspace tab is active (the
    // sidebar's "open in terminal") has no folder to record.
    Number.isSafeInteger(folderId) &&
    (folderId as number) >= 0 &&
    // Any length: it is only a label, clamped on the way in and out.
    typeof title === "string" &&
    typeof workingDir === "string" &&
    (shell === undefined || typeof shell === "string")
  )
}

/** Any safe integer: folder commands have positive ids, global ones (see
 *  `global-commands`) negative. */
function storedCommandId(value: unknown): number | undefined {
  return Number.isSafeInteger(value) ? (value as number) : undefined
}

/**
 * Where default titles resume, so a new tab never repeats one still shown.
 * A bigint: a restored title can carry any number, and counting on from it
 * must stay exact however large it is.
 */
function restoredTabCounter(tabs: TerminalTab[]): bigint {
  let counter = BigInt(tabs.length)
  for (const { title } of tabs) {
    const digits = DEFAULT_TITLE.exec(title)?.[1]
    if (digits !== undefined && BigInt(digits) > counter) {
      counter = BigInt(digits)
    }
  }
  return counter
}

function terminalScope(): string {
  return JSON.stringify([
    getCurrentWindowLabel(),
    getActiveRemoteConnectionId(),
  ])
}

/**
 * sessionStorage is a discovery hint, not permission to use a PTY. A tab opened
 * with window.opener can inherit a copy of that storage; window.name belongs to
 * the browsing context and survives reload, but is not cloned into the new tab.
 */
function currentPageId(): string | null {
  if (typeof window === "undefined") return null
  // Do not overwrite a host/application-assigned window name. Those windows
  // keep their normal terminal behavior, but opt out of reload recovery.
  if (!window.name) window.name = `${PAGE_NAME_PREFIX}${randomUUID()}`
  if (!window.name.startsWith(PAGE_NAME_PREFIX)) return null
  const id = window.name.slice(PAGE_NAME_PREFIX.length)
  return UUID_V4.test(id) ? id : null
}

function readTerminalSession(): {
  pageId: string | null
  scope: string
  isOpen: boolean
  activeTabId: string | null
  tabs: TerminalTab[]
} {
  const scope = terminalScope()
  const pageId = currentPageId()
  const empty = { pageId, scope, isOpen: false, activeTabId: null, tabs: [] }
  if (!pageId || typeof window === "undefined") return empty
  try {
    const raw = window.sessionStorage.getItem(TERMINAL_SESSION_KEY)
    if (!raw) return empty
    const saved: StoredTerminalSession = JSON.parse(raw)
    if (
      saved.version !== 1 ||
      saved.scope !== scope ||
      saved.pageId !== pageId ||
      !Array.isArray(saved.tabs)
    )
      return empty
    const tabs: TerminalTab[] = (saved.tabs as unknown[])
      .filter(isRestorableTab)
      .map((tab) => ({
        id: tab.id,
        folderId: tab.folderId,
        title: tab.title.slice(0, MAX_STORED_TITLE_LENGTH),
        workingDir: tab.workingDir,
        shell: tab.shell,
        commandId: storedCommandId(tab.commandId),
        restored: true,
      }))
    return {
      pageId,
      scope,
      isOpen: saved.isOpen === true,
      tabs,
      activeTabId: tabs.some((tab) => tab.id === saved.activeTabId)
        ? saved.activeTabId
        : (tabs[0]?.id ?? null),
    }
  } catch {
    return empty
  }
}

interface TerminalContextValue {
  isOpen: boolean
  height: number
  minHeight: number
  maxHeight: number
  toggle: () => void
  setHeight: (h: number) => void
  tabs: TerminalTab[]
  /** 终端栏里该列出来的终端：「标签页跟随文件夹」开着、有当前项目时只有这个
   *  项目的和全局（folderId 0）的；别的情况等于 `tabs`。`tabs` 仍是全部，
   *  别的项目的终端在后台照常运行（#787）。 */
  visibleTabs: TerminalTab[]
  activeTabId: string | null
  exitedTerminals: Set<string>
  markTerminalExited: (id: string) => void
  markTerminalRunning: (id: string) => void
  markTerminalStarted: (id: string) => void
  createTerminal: () => Promise<void>
  /** 有当前项目、`createTerminal` 真能建出终端时为 true；面板据此决定显不显示
   *  空状态和「新建终端」（没有项目时那个按钮点了没反应，#787）。 */
  canCreateTerminal: boolean
  createTerminalInDirectory: (
    workingDir: string,
    title?: string,
    shell?: string,
    /** 终端属于哪个项目；不给就是当前项目（#787）。 */
    folderId?: number
  ) => Promise<string | null>
  createTerminalWithCommand: (
    title: string,
    command: string,
    commandId?: number
  ) => Promise<string | null>
  closeTerminal: (id: string) => void
  closeOtherTerminals: (id: string) => void
  closeAllTerminals: () => void
  /** Close every terminal opened for one of these folders (`TerminalTab.folderId`)
   *  — what removing a project from the workspace promises (#176). */
  closeTerminalsByFolder: (folderIds: readonly number[]) => void
  renameTerminal: (id: string, title: string) => void
  switchTerminal: (id: string) => void
}

const TerminalContext = createContext<TerminalContextValue | null>(null)

export function useTerminalContext() {
  const ctx = useContext(TerminalContext)
  if (!ctx) {
    throw new Error("useTerminalContext must be used within TerminalProvider")
  }
  return ctx
}

export function TerminalProvider({ children }: { children: ReactNode }) {
  const { activeFolder, activeFolderId } = useActiveFolder()
  const { shortcuts } = useShortcutSettings()
  const [restoredSession] = useState(readTerminalSession)
  const [isOpen, setIsOpen] = useState(restoredSession.isOpen)
  const [height, setHeightState] = useState(DEFAULT_HEIGHT)
  const [tabs, setTabs] = useState<TerminalTab[]>(restoredSession.tabs)
  const [activeTabId, setActiveTabId] = useState<string | null>(
    restoredSession.activeTabId
  )
  const tabCounterRef = useRef(restoredTabCounter(restoredSession.tabs))
  const [exitedTerminals, setExitedTerminals] = useState<Set<string>>(new Set())
  const [defaultTerminalShell, setDefaultTerminalShell] = useState<
    string | null
  >(null)
  const lastMouseActivityInTerminalRef = useRef(false)
  // Persist before TerminalView's passive spawn effect. A refresh during the
  // spawn request must leave an ID that the next page can probe without replay.
  useLayoutEffect(() => {
    if (!restoredSession.pageId || typeof window === "undefined") return
    const state: StoredTerminalSession = {
      version: 1,
      scope: restoredSession.scope,
      pageId: restoredSession.pageId,
      isOpen,
      activeTabId,
      // The command is intentionally never stored: recovery only attaches to
      // the existing PTY and must not retain sensitive command arguments.
      // Its launcher entry's id is only a number, and is what lets the
      // launcher find the tab again.
      tabs: tabs.map(
        ({ id, folderId, title, workingDir, shell, commandId }) => ({
          id,
          folderId,
          // A rename or a long folder name can run past the reader's bound.
          // The stored title is only a label until the pane reattaches.
          title: title.slice(0, MAX_STORED_TITLE_LENGTH),
          workingDir,
          shell,
          commandId,
        })
      ),
    }
    try {
      window.sessionStorage.setItem(TERMINAL_SESSION_KEY, JSON.stringify(state))
    } catch {
      // Private mode or quota failure: terminal remains usable in this page.
    }
  }, [restoredSession, isOpen, activeTabId, tabs])

  const folderPath = activeFolder?.path ?? ""
  const currentFolderId = activeFolderId ?? 0
  // 跟随开着时终端按项目分开显示（#787）；没有当前项目时没得跟，照旧全列。
  const followFolder = useFolderTabsStore((s) => s.enabled)
  const filterByFolder = followFolder && currentFolderId !== 0
  const visibleTabs = useMemo(
    () =>
      filterByFolder
        ? tabs.filter((t) => t.folderId === currentFolderId || t.folderId === 0)
        : tabs,
    [filterByFolder, tabs, currentFolderId]
  )
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  // 关闭类操作在 setTabs 的 updater 里判断「看得见」，用 ref 拿最新的筛选条件。
  const isVisibleRef = useRef<(tab: TerminalTab) => boolean>(() => true)
  isVisibleRef.current = (tab: TerminalTab) =>
    !filterByFolder || tab.folderId === currentFolderId || tab.folderId === 0
  const filterByFolderRef = useRef(filterByFolder)
  filterByFolderRef.current = filterByFolder
  // 每个项目上次选中的自己的终端，和离开时选中的终端（包括全局终端），
  // 切项目的 effect 用（#338、#787）。
  const lastActiveByFolderRef = useRef(new Map<number, string>())
  const selectedOnLeaveRef = useRef(new Map<number, string>())
  const resolveTerminalShell = useCallback(
    (shell?: string) => shell ?? defaultTerminalShell ?? undefined,
    [defaultTerminalShell]
  )

  useEffect(() => {
    let cancelled = false
    let unlisten: (() => void) | undefined

    getSystemTerminalSettings()
      .then((settings) => {
        if (!cancelled) setDefaultTerminalShell(settings.default_shell)
      })
      .catch((err) => {
        console.error("[terminal] load terminal settings failed:", err)
      })

    getTransport()
      .subscribe<{ default_shell: string | null }>(
        TERMINAL_SETTINGS_UPDATED_EVENT,
        (settings) => {
          setDefaultTerminalShell(settings.default_shell)
        }
      )
      .then((dispose) => {
        if (cancelled) {
          dispose()
          return
        }
        unlisten = dispose
      })
      .catch((err) => {
        console.error("[terminal] subscribe terminal settings failed:", err)
      })

    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const markTerminalRunning = useCallback((id: string) => {
    setExitedTerminals((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const markTerminalStarted = useCallback((id: string) => {
    setTabs((current) =>
      current.map((tab) =>
        tab.id === id && !tab.restored ? { ...tab, restored: true } : tab
      )
    )
  }, [])

  const markTerminalExited = useCallback((id: string) => {
    setExitedTerminals((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })
  }, [])

  // The launcher's command↔terminal links live in memory. Rebuilt from the
  // restored tabs, a command still running in one reads as running, rather
  // than offering to start a second copy beside it.
  useEffect(() => {
    const { setLink } = useCommandTerminalLinkStore.getState()
    for (const tab of restoredSession.tabs) {
      if (tab.commandId !== undefined) {
        setLink(commandLinkKey(tab.folderId, tab.commandId), tab.id)
      }
    }
  }, [restoredSession])

  // A tab's view reports its exit, but views unmount (a closed mobile drawer)
  // and a reload never hears an exit from before it. The launcher tells a
  // running command from an ended one by `exitedTerminals`, so command tabs
  // are watched here, mounted or not.
  const uncheckedRestoredRef = useRef(
    new Set(
      restoredSession.tabs
        .filter((tab) => tab.commandId !== undefined)
        .map((tab) => tab.id)
    )
  )
  const commandTabIds = tabs
    .filter((tab) => tab.commandId !== undefined)
    .map((tab) => tab.id)
    .join(" ")
  useEffect(() => {
    if (!commandTabIds) return
    const unchecked = uncheckedRestoredRef.current
    let disposed = false
    const listening: string[] = []
    const unlisteners: (() => void)[] = []
    // Asked only once listening, so an end in between is heard anyway, and
    // asked again after a reconnect if the asking failed. A missing one is
    // left to its view, which waits out a launch the reload may have
    // overtaken.
    const check = (id: string) => {
      if (!unchecked.has(id)) return
      terminalSnapshot(id)
        .then((snapshot) => {
          if (disposed) return
          unchecked.delete(id)
          if (snapshot.exists && !snapshot.alive) markTerminalExited(id)
        })
        .catch(() => {})
    }
    for (const id of commandTabIds.split(" ")) {
      getTransport()
        .subscribe(`terminal://exit/${id}`, () => {
          if (!disposed) markTerminalExited(id)
        })
        .then((unlisten) => {
          if (disposed) return unlisten()
          unlisteners.push(unlisten)
          listening.push(id)
          check(id)
        })
        .catch(() => {})
    }
    const unlistenReady = getTransport().onReady?.(() => {
      for (const id of listening) check(id)
    })
    return () => {
      disposed = true
      unlistenReady?.()
      for (const unlisten of unlisteners) unlisten()
    }
  }, [commandTabIds, markTerminalExited])

  const removeExitedTerminals = useCallback((ids: string[]) => {
    setExitedTerminals((prev) => {
      if (prev.size === 0) return prev
      let changed = false
      const next = new Set(prev)
      for (const id of ids) {
        if (next.delete(id)) changed = true
      }
      return changed ? next : prev
    })
  }, [])

  const killTerminalTabs = useCallback((targetTabs: TerminalTab[]) => {
    targetTabs.forEach((tab) => {
      terminalKill(tab.id).catch(() => {})
    })
  }, [])

  const toggle = useCallback(() => {
    setIsOpen((wasOpen) => !wasOpen)

    // 打开面板时，当前看得见的终端一个都没有就自动建第一个（跟随开着时只看
    // 这个项目的和全局的，#787）。收起面板时不建：跟随开着时面板可能正开着
    // 空状态。
    if (isOpen || !folderPath) return
    if (tabsRef.current.some((t) => isVisibleRef.current(t))) return
    const autoId = randomUUID()
    tabCounterRef.current += 1n
    const tab: TerminalTab = {
      id: autoId,
      folderId: currentFolderId,
      title: `Terminal ${tabCounterRef.current}`,
      workingDir: folderPath,
      shell: resolveTerminalShell(),
    }
    setTabs((prev) => [...prev, tab])
    setActiveTabId(autoId)
  }, [isOpen, folderPath, currentFolderId, resolveTerminalShell])

  const createTerminalWithCommand = useCallback(
    async (title: string, command: string, commandId?: number) => {
      if (!folderPath) return null

      setIsOpen(true)

      const id = randomUUID()
      tabCounterRef.current += 1n
      setTabs((prev) => [
        ...prev,
        {
          id,
          folderId: currentFolderId,
          title,
          workingDir: folderPath,
          shell: resolveTerminalShell(),
          initialCommand: command,
          commandId,
        },
      ])
      setActiveTabId(id)

      return id
    },
    [folderPath, currentFolderId, resolveTerminalShell]
  )

  const createTerminalInDirectory = useCallback(
    async (
      workingDir: string,
      title?: string,
      shell?: string,
      folderId?: number
    ) => {
      if (!workingDir) return null

      setIsOpen(true)

      // 侧栏给别的项目「在终端打开」时，终端记到那个项目名下（目录是它的），
      // 不记到当前项目（#787）。
      const ownerFolderId = folderId ?? currentFolderId
      const id = randomUUID()
      tabCounterRef.current += 1n
      const defaultTitle = `Terminal ${tabCounterRef.current}`
      const tab: TerminalTab = {
        id,
        folderId: ownerFolderId,
        title: title ?? defaultTitle,
        workingDir,
        shell: resolveTerminalShell(shell),
      }
      setTabs((prev) => [...prev, tab])
      if (isVisibleRef.current(tab)) {
        setActiveTabId(id)
      } else {
        // 跟随开着、终端属于别的项目：这里看不见，不选中它；记下来，切到那个
        // 项目时选中的就是它。
        lastActiveByFolderRef.current.set(ownerFolderId, id)
        selectedOnLeaveRef.current.set(ownerFolderId, id)
      }

      return id
    },
    [currentFolderId, resolveTerminalShell]
  )

  const createTerminal = useCallback(async () => {
    if (!folderPath) return
    await createTerminalInDirectory(folderPath)
  }, [folderPath, createTerminalInDirectory])

  const setHeight = useCallback((h: number) => {
    setHeightState(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, h)))
  }, [])

  const closeTerminal = useCallback(
    (id: string) => {
      markTerminalExited(id)
      removeExitedTerminals([id])
      terminalKill(id).catch(() => {})
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== id)
        if (next.length === 0) {
          tabCounterRef.current = 0n
          // 跟随开着时面板留着，显示这个项目的空状态和「新建终端」（#787）；
          // 关着时照旧收起。
          if (!filterByFolderRef.current) setIsOpen(false)
          setActiveTabId(null)
        } else {
          // 关掉的是选中的那个时，落到还看得见的最后一个；跟随开着、这个项目
          // 没有剩下的就不选，面板显示空状态（不跳到别的项目的终端，#787）。
          const visible = next.filter((t) => isVisibleRef.current(t))
          setActiveTabId((prevActive) =>
            prevActive === id
              ? (visible[visible.length - 1]?.id ?? null)
              : prevActive
          )
        }
        return next
      })
    },
    [markTerminalExited, removeExitedTerminals]
  )

  // 跟随开着时「关闭其它」「关闭所有」只管看得见的终端，别的项目的不动（#787）。
  const closeOtherTerminals = useCallback(
    (id: string) => {
      setTabs((prev) => {
        const closed = prev.filter(
          (t) => t.id !== id && isVisibleRef.current(t)
        )
        killTerminalTabs(closed)
        removeExitedTerminals(closed.map((t) => t.id))
        return prev.filter((t) => !closed.includes(t))
      })
      setActiveTabId(id)
    },
    [killTerminalTabs, removeExitedTerminals]
  )

  const closeAllTerminals = useCallback(() => {
    setTabs((prev) => {
      const closed = prev.filter((t) => isVisibleRef.current(t))
      killTerminalTabs(closed)
      removeExitedTerminals(closed.map((t) => t.id))
      const next = prev.filter((t) => !closed.includes(t))
      if (next.length === 0) tabCounterRef.current = 0n
      return next
    })
    setActiveTabId(null)
    setIsOpen(false)
  }, [killTerminalTabs, removeExitedTerminals])

  // Removing a project from the workspace closes "its tabs and terminals" —
  // the confirm says so (#176). Terminals are shared across projects, so only
  // the ones opened for these folders go; the rest stay as they were. Like
  // `closeTerminal`, an active terminal that goes falls to one still open, and
  // closing the last one folds the panel away.
  const closeTerminalsByFolder = useCallback(
    (folderIds: readonly number[]) => {
      const ids = new Set(folderIds)
      setTabs((prev) => {
        const closed = prev.filter((t) => ids.has(t.folderId))
        if (closed.length === 0) return prev
        killTerminalTabs(closed)
        removeExitedTerminals(closed.map((t) => t.id))
        const next = prev.filter((t) => !ids.has(t.folderId))
        if (next.length === 0) {
          tabCounterRef.current = 0n
          setIsOpen(false)
          setActiveTabId(null)
        } else {
          // 只落到还看得见的终端上：跟随开着时别的项目的终端在后台，选中它
          // 会让「关闭当前终端」关掉看不见的终端；一个都看不见就不选（#787）。
          const visible = next.filter((t) => isVisibleRef.current(t))
          setActiveTabId((prevActive) =>
            prevActive !== null && visible.some((t) => t.id === prevActive)
              ? prevActive
              : (visible[0]?.id ?? null)
          )
        }
        return next
      })
    },
    [killTerminalTabs, removeExitedTerminals]
  )

  // A folder deleted for good — a worktree removed from the branch menu, the
  // sidebar's clean-up offer or a task's merge — leaves its terminals sitting
  // in a directory that is gone (#176). The backend announces it on
  // `folder://changed`; closing a folder from the workspace does not, and the
  // sidebar closes those terminals itself.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    getTransport()
      .subscribe<FolderChange>(FOLDER_CHANGED_EVENT, (change) => {
        if (change.kind === "deleted") closeTerminalsByFolder([change.id])
      })
      .then((dispose) => {
        if (disposed) dispose()
        else unlisten = dispose
      })
      .catch((err) => {
        console.error("[terminal] subscribe folder changes failed:", err)
      })
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [closeTerminalsByFolder])

  const renameTerminal = useCallback((id: string, title: string) => {
    setTabs((prev) => prev.map((t) => (t.id === id ? { ...t, title } : t)))
  }, [])

  const switchTerminal = useCallback((id: string) => {
    setActiveTabId(id)
  }, [])

  // 终端跟着当前项目走（#338）：每个项目记住上次选中的终端，切到别的项目时
  // 显示那个项目的终端。只换选中的那个，不关、不新建；全局终端（folderId 0）
  // 选中时也不被切走。这个项目一个终端都没有时：跟随关着就不动（别的项目的
  // 终端标签上带着项目名）；跟随开着就不选，面板显示空状态（#787），切回来
  // 时再找回那个项目上次选中的。
  useEffect(() => {
    const tab = tabs.find((t) => t.id === activeTabId)
    if (tab && tab.folderId !== 0) {
      lastActiveByFolderRef.current.set(tab.folderId, tab.id)
    }
  }, [activeTabId, tabs])
  // 离开每个项目时选中的是哪个终端（包括全局终端）。跟随开着时切回来先找它：
  // 路过没有自己终端的项目时会自动落到全局终端上，回来不能就停在全局终端，
  // 要回到这个项目原来选中的那个（#787）。
  const activeTabIdRef = useRef(activeTabId)
  activeTabIdRef.current = activeTabId
  const previousFolderIdRef = useRef(currentFolderId)
  const previousFilterRef = useRef(filterByFolder)
  useEffect(() => {
    const previousFolderId = previousFolderIdRef.current
    const folderChanged = previousFolderId !== currentFolderId
    // 跟随刚打开时也按当前项目重新挑一次，免得选中的是看不见的终端。
    const filterTurnedOn = filterByFolder && !previousFilterRef.current
    previousFolderIdRef.current = currentFolderId
    previousFilterRef.current = filterByFolder
    if (!folderChanged && !filterTurnedOn) return
    if (folderChanged && previousFolderId !== 0) {
      const leaving = activeTabIdRef.current
      if (leaving) selectedOnLeaveRef.current.set(previousFolderId, leaving)
      else selectedOnLeaveRef.current.delete(previousFolderId)
    }
    if (currentFolderId === 0) return
    setActiveTabId((prev) => {
      const current = tabsRef.current
      if (filterByFolder && folderChanged) {
        const leftId = selectedOnLeaveRef.current.get(currentFolderId)
        const left = current.find((t) => t.id === leftId)
        if (
          left &&
          (left.folderId === 0 || left.folderId === currentFolderId)
        ) {
          return left.id
        }
      }
      const active = current.find((t) => t.id === prev)
      if (
        active &&
        (active.folderId === 0 || active.folderId === currentFolderId)
      ) {
        return prev
      }
      // 跟随关着时，没有选中的终端就照旧不动。
      if (!active && !filterByFolder) return prev
      const remembered = lastActiveByFolderRef.current.get(currentFolderId)
      const target =
        current.find(
          (t) => t.id === remembered && t.folderId === currentFolderId
        ) ?? current.find((t) => t.folderId === currentFolderId)
      if (target) return target.id
      return filterByFolder ? null : prev
    })
  }, [currentFolderId, filterByFolder])

  // 终端栏里还有看得见的终端时，选中的必须是其中一个，不然面板既没有终端也
  // 没有空状态（#787）：切到没有自己终端的项目时落到全局终端上；关掉跟随时
  // 选中为空就找回这个项目上次选中的那个，没有就选最后一个。
  useEffect(() => {
    setActiveTabId((prev) => {
      const visible = tabsRef.current.filter((t) => isVisibleRef.current(t))
      if (visible.some((t) => t.id === prev)) return prev
      // 一个都看不见时不留着隐藏的选中项（别的项目的终端），免得快捷键
      // 「关闭当前终端」关掉用户看不见的终端。
      if (visible.length === 0) return null
      const remembered = lastActiveByFolderRef.current.get(currentFolderId)
      return (
        visible.find((t) => t.id === remembered) ?? visible[visible.length - 1]
      ).id
    })
  }, [visibleTabs, activeTabId, currentFolderId])

  const isInTerminalRegion = useCallback((target: EventTarget | null) => {
    if (!(target instanceof Element)) return false
    return Boolean(target.closest('[data-terminal-panel-region="true"]'))
  }, [])

  const updateLastMouseActivity = useCallback(
    (target: EventTarget | null) => {
      const next = isInTerminalRegion(target)
      if (lastMouseActivityInTerminalRef.current === next) return
      lastMouseActivityInTerminalRef.current = next
    },
    [isInTerminalRegion]
  )

  useEffect(() => {
    const handlePointerActivity = (event: PointerEvent) => {
      updateLastMouseActivity(event.target)
    }
    const handleFocusActivity = (event: FocusEvent) => {
      updateLastMouseActivity(event.target)
    }

    window.addEventListener("pointerover", handlePointerActivity, true)
    window.addEventListener("pointerdown", handlePointerActivity, true)
    window.addEventListener("focusin", handleFocusActivity, true)
    return () => {
      window.removeEventListener("pointerover", handlePointerActivity, true)
      window.removeEventListener("pointerdown", handlePointerActivity, true)
      window.removeEventListener("focusin", handleFocusActivity, true)
    }
  }, [updateLastMouseActivity])

  useEffect(() => {
    if (!isOpen) {
      lastMouseActivityInTerminalRef.current = false
    }
  }, [isOpen])

  useEffect(() => {
    const handleTerminalHotkeys = (event: KeyboardEvent) => {
      if (!isOpen) return

      const targetInTerminal = isInTerminalRegion(event.target)
      const activeElementInTerminal = isInTerminalRegion(document.activeElement)
      const shouldHandle =
        lastMouseActivityInTerminalRef.current ||
        targetInTerminal ||
        activeElementInTerminal
      if (!shouldHandle) return

      if (matchShortcutEvent(event, shortcuts.new_terminal_tab)) {
        event.preventDefault()
        event.stopPropagation()
        void createTerminal()
        return
      }

      if (
        activeTabId &&
        matchShortcutEvent(event, shortcuts.close_current_terminal_tab)
      ) {
        event.preventDefault()
        event.stopPropagation()
        closeTerminal(activeTabId)
      }
    }

    window.addEventListener("keydown", handleTerminalHotkeys, true)
    return () => {
      window.removeEventListener("keydown", handleTerminalHotkeys, true)
    }
  }, [
    activeTabId,
    closeTerminal,
    createTerminal,
    isInTerminalRegion,
    isOpen,
    shortcuts.close_current_terminal_tab,
    shortcuts.new_terminal_tab,
  ])

  const value = useMemo(
    () => ({
      isOpen,
      height,
      minHeight: MIN_HEIGHT,
      maxHeight: MAX_HEIGHT,
      toggle,
      setHeight,
      tabs,
      visibleTabs,
      activeTabId,
      exitedTerminals,
      markTerminalExited,
      markTerminalRunning,
      markTerminalStarted,
      createTerminal,
      canCreateTerminal: folderPath !== "",
      createTerminalInDirectory,
      createTerminalWithCommand,
      closeTerminal,
      closeOtherTerminals,
      closeAllTerminals,
      closeTerminalsByFolder,
      renameTerminal,
      switchTerminal,
    }),
    [
      isOpen,
      height,
      toggle,
      setHeight,
      tabs,
      visibleTabs,
      activeTabId,
      exitedTerminals,
      markTerminalExited,
      markTerminalRunning,
      markTerminalStarted,
      createTerminal,
      folderPath,
      createTerminalInDirectory,
      createTerminalWithCommand,
      closeTerminal,
      closeOtherTerminals,
      closeAllTerminals,
      closeTerminalsByFolder,
      renameTerminal,
      switchTerminal,
    ]
  )

  return (
    <TerminalContext.Provider value={value}>
      {children}
    </TerminalContext.Provider>
  )
}
