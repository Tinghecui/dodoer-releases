"use client"

import { useEffect, useMemo, useRef, useState } from "react"

import { useActiveFolder } from "@/contexts/active-folder-context"
import {
  useWorkspaceActions,
  useWorkspaceFileTabs,
} from "@/contexts/workspace-context"
import { readFileBase64 } from "@/lib/api"
import { isNotFoundError } from "@/lib/app-error"
import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { buildFileTabId } from "@/lib/file-tab-id"
import {
  fileTabsServerKey,
  fileTabsStorageKey,
  readPersistedFileTabs,
  samePersistedFileTabs,
  snapshotFileTabs,
  writePersistedFileTabs,
  type PersistedFileTabs,
} from "@/lib/files/file-tab-persistence"
import { isOfficePreviewable } from "@/lib/language-detect"
import { MAX_FILE_TABS } from "@/lib/tab-limit"
import { folderScope, useFolderTabsStore } from "@/stores/folder-tabs-store"

/** 探一下文件在不在：只要元数据，比这个大的直接报「太大」，不读内容。 */
const PROBE_MAX_BYTES = 4096

/**
 * 办公文档打开时不读内容（预览自己去渲染），文件不在了也会开成正常的标签，
 * 靠「出错的标签」判断不了，只能先问一下后端。只有明确回「不存在」才算不在；
 * 太大、读失败这些说明文件还在，照样恢复。
 */
async function officeFileGone(path: string): Promise<boolean> {
  try {
    await readFileBase64(path, PROBE_MAX_BYTES)
    return false
  } catch (error) {
    return isNotFoundError(error)
  }
}

/** 一串连着的改动（拖动、关掉、选中）合成一次写。 */
const SAVE_DEBOUNCE_MS = 300

// 这个文档里每个项目正在做的恢复，key 是存储的 key（分服务器、分项目）。每次切进
// 一个项目都对一下它记下的标签：缺了的（文件标签最多开三个，别的项目开标签时会把
// 这个项目的挤掉）补开回来。同一个项目同时只有一次恢复，provider 重新挂载也接着
// 等它；第一次恢复做完的记在 restoredKeys 里，在那之前、以及恢复进行中，这个项目
// 一律不写。刷新、重启是新文档，从头恢复。
const restores = new Map<string, Promise<boolean>>()
const restoredKeys = new Set<string>()
// 恢复时发现读不到的文件（删了、挪了），这个文档里不再试。
const skipped = new Map<string, Set<string>>()

function skip(key: string, path: string): void {
  let paths = skipped.get(key)
  if (!paths) {
    paths = new Set()
    skipped.set(key, paths)
  }
  paths.add(path)
}

/** 仅测试用。 */
export function resetFileTabsPersistenceForTests(): void {
  restores.clear()
  restoredKeys.clear()
  skipped.clear()
}

/** 一次恢复的账：标签栏变了，靠它分清是恢复自己做的还是用户做的。 */
interface RestoreLedger {
  /** 恢复还会让它出现在标签栏里的路径，出现一次就划掉。 */
  adding: Set<string>
  /** 恢复打开的所有路径：没有选中项时工作区会自己选上其中一个。 */
  all: Set<string>
}

/**
 * 把文件标签（打开了哪些、顺序、选中哪个）存进本机，刷新、重启后读回来。
 * 挂在工作区 provider 里面，和浏览器标签的持久化挨着；不渲染任何东西。
 *
 * 切到一个项目时恢复它记下的标签：一个个在后台打开（不抢焦点、不切面板），最后
 * 选中记下的那个；读不到的文件（删了、挪了）打开后是出错的标签，直接关掉；办公
 * 文档打开时不读内容、不会出错，打开前先问一下在不在。没保存的改动不恢复。
 *
 * 什么时候写：恢复完成之前不写，不然新文档的空标签栏会把上次记下的冲掉。标签栏
 * 每变一次都对一下账：恢复自己加的标签、关掉的出错标签、选中记下的那个都不算；
 * 别的变化（用户开、关、拖、选中，恢复期间做的也算）说明用户动过这个项目的标签，
 * 从这以后这个项目的标签栏一变就写，恢复期间动过的等恢复完写。只换项目、换范围
 * 不算变化。
 */
export function FileTabsPersistence() {
  const { activeFolderId } = useActiveFolder()
  const { openFilePreview, switchFileTab, closeFileTab, reorderFileTabs } =
    useWorkspaceActions()
  const { fileTabs, allFileTabs, activeFileTabId } = useWorkspaceFileTabs()
  // 所有项目合计开着几个标签：标签上限按它算（标签跟随项目时看到的只是一部分）。
  const bufferCount = (allFileTabs ?? fileTabs).length
  const tabsFollowFolder = useFolderTabsStore((s) => s.enabled)
  const tabScope = useFolderTabsStore((s) => s.scope)
  // 一个恢复做完了，让下面的 effect 重跑。
  const [restoredTick, setRestoredTick] = useState(0)
  const server = fileTabsServerKey()
  const storageKey =
    activeFolderId == null ? null : fileTabsStorageKey(activeFolderId, server)
  // 标签跟随项目时，看到的标签栏是当前范围的；范围可能晚一次渲染才跟上项目，
  // 对不上的那一下标签栏不属于这个项目，不看。
  const consistent =
    activeFolderId != null &&
    (!tabsFollowFolder || tabScope === folderScope(activeFolderId))
  const storageKeyRef = useRef(storageKey)
  useEffect(() => {
    storageKeyRef.current = storageKey
  }, [storageKey])
  const openFilePreviewRef = useRef(openFilePreview)
  useEffect(() => {
    openFilePreviewRef.current = openFilePreview
  }, [openFilePreview])

  // 持久化眼里的标签栏：文件标签的路径、顺序和选中项。打字、重新加载不改它。
  const snapshot = useMemo(
    () => snapshotFileTabs(fileTabs, activeFileTabId),
    [fileTabs, activeFileTabId]
  )

  // 恢复时打开的标签（id → 项目的 key），等提交以后看它是不是读失败了。
  const restoredIdsRef = useRef<Map<string, string>>(new Map())
  // 每个项目恢复完要选中的标签，等它进了标签栏再选（见下面选中的那个 effect）。
  const pendingActiveRef = useRef<Map<string, { id: string; path: string }>>(
    new Map()
  )
  const ledgersRef = useRef<Map<string, RestoreLedger>>(new Map())
  // 自己关掉的出错标签、自己选中的那个：标签栏因此变了不算用户改的。
  const closingRef = useRef<Set<string>>(new Set())
  const switchingRef = useRef<Map<string, string>>(new Map())
  // 用户动过标签的项目：从此标签栏一变就写。
  const liveRef = useRef<Set<string>>(new Set())
  // 这次恢复期间用户自己选过标签的项目：恢复完不再去选记下的那个。
  const userPickedRef = useRef<Set<string>>(new Set())
  // 这次恢复期间用户自己开、关、拖过标签的项目：恢复完不再按记下的排顺序。
  const userEditedRef = useRef<Set<string>>(new Set())
  // 每个项目恢复完要排成的顺序（补开的标签加在末尾，要挪回记下的位置）。
  const pendingOrderRef = useRef<Map<string, string[]>>(new Map())
  // 自己排的顺序：标签栏因此变了不算用户拖的。
  const reorderingRef = useRef<Map<string, string>>(new Map())
  // 恢复做完、还没在它自己的标签栏里看过一次的项目：动过的话那时写。
  const settledRef = useRef<Set<string>>(new Set())
  // 恢复补开时被标签上限挤掉的这个项目自己的标签：再补开一次（每次切进来最多
  // 一次，免得自己挤自己来回转）。
  const evictedRef = useRef<Map<string, Set<string>>>(new Map())
  const retriedRef = useRef<Set<string>>(new Set())
  // 每个项目最后写下的样子，一样就不重复写。
  const lastWrittenRef = useRef<Map<string, PersistedFileTabs>>(new Map())
  const pendingRef = useRef<{
    key: string
    folderId: number
    server: string
    snapshot: PersistedFileTabs
  } | null>(null)
  const timerRef = useRef<number | null>(null)

  // 写盘用的两个函数挂在 ref 上，pagehide 和卸载时也能拿到。
  const flushRef = useRef<() => void>(() => {})
  useEffect(() => {
    flushRef.current = () => {
      if (timerRef.current !== null) {
        window.clearTimeout(timerRef.current)
        timerRef.current = null
      }
      const pending = pendingRef.current
      pendingRef.current = null
      if (!pending) return
      const last = lastWrittenRef.current.get(pending.key)
      if (last && samePersistedFileTabs(last, pending.snapshot)) return
      lastWrittenRef.current.set(pending.key, pending.snapshot)
      writePersistedFileTabs(pending.folderId, pending.snapshot, pending.server)
    }
  }, [])

  // 切进哪个项目就恢复哪个项目：第一次把记下的都开出来；以后每次切进来，把记下的
  // 里面缺了的补开（被标签上限挤掉的），顺序和选中项也照记下的摆回去。
  const enteredRef = useRef<string | null>(null)
  useEffect(() => {
    if (storageKey == null || activeFolderId == null) {
      enteredRef.current = null
      return
    }
    // 标签栏还没跟上这个项目：等跟上了再看缺什么。
    if (!consistent) {
      if (enteredRef.current !== storageKey) enteredRef.current = null
      return
    }
    if (enteredRef.current === storageKey) {
      // 补开时把自己另一个标签挤掉了：等这次恢复做完，再补开一次被挤掉的（这时
      // 刚开的几个是最近用过的，上限会去关别的项目的）。
      const evicted = evictedRef.current.get(storageKey)
      if (
        !evicted?.size ||
        restores.has(storageKey) ||
        retriedRef.current.has(storageKey)
      ) {
        return
      }
      retriedRef.current.add(storageKey)
    } else {
      enteredRef.current = storageKey
      retriedRef.current.delete(storageKey)
    }
    evictedRef.current.delete(storageKey)
    const key = storageKey
    const folderId = activeFolderId
    let running = restores.get(key)
    if (!running) {
      // 这个项目还有没写的先写掉，下面读到的才是最新的。
      if (pendingRef.current?.key === key) flushRef.current()
      const entries = readPersistedFileTabs(folderId, server)
      const gone = skipped.get(key)
      const open = new Set(snapshot.paths)
      const missing = entries.paths.filter(
        (path) => !open.has(path) && !gone?.has(path)
      )
      // 以后切进来只管被挤掉的：什么都没缺就不动，选中项也不去改（标签不跟随项目
      // 时标签栏是大家共用的，选中别的项目的标签是常态）。
      const first = !restoredKeys.has(key)
      if (!first && missing.length === 0) return
      running = restore(folderId, key, entries, missing, first)
      restores.set(key, running)
    }
    const current = running
    void current.then((done) => {
      // provider 重新挂载过的话，新旧两个实例都等着同一次恢复，谁先到谁清掉。
      if (restores.get(key) === current) restores.delete(key)
      // 半路停下的，下次切回来接着恢复（已经开着的不会重复开）。
      if (!done) return
      restoredKeys.add(key)
      settledRef.current.add(key)
      setRestoredTick((tick) => tick + 1)
    })

    async function restore(
      folderId: number,
      key: string,
      entries: PersistedFileTabs,
      missing: string[],
      first: boolean
    ): Promise<boolean> {
      lastWrittenRef.current.set(key, entries)
      userPickedRef.current.delete(key)
      userEditedRef.current.delete(key)
      const ledger: RestoreLedger = {
        adding: new Set(missing),
        all: new Set(entries.paths),
      }
      ledgersRef.current.set(key, ledger)
      // 用户换到了别的项目：标签不跟随项目时标签栏是全局的，原项目剩下的不再
      // 打开（免得混进别的项目的标签栏），切回来再接着开；跟随项目时打开的是
      // 原项目自己那组标签，在后台接着开完。
      const abandoned = () =>
        storageKeyRef.current !== key && !useFolderTabsStore.getState().enabled
      const giveUp = (index: number) => {
        for (const rest of missing.slice(index)) ledger.adding.delete(rest)
        return false
      }
      const ids = new Map<string, string>()
      // 一个接一个：每次都加在末尾，顺序才和记下的一样。
      for (const [index, path] of missing.entries()) {
        if (abandoned()) return giveUp(index)
        try {
          if (isOfficePreviewable(path) && (await officeFileGone(path))) {
            ledger.adding.delete(path)
            skip(key, path)
            continue
          }
          if (abandoned()) return giveUp(index)
          const resolved = await openFilePreviewRef.current(path, {
            background: true,
            folderId,
          })
          if (!resolved) {
            ledger.adding.delete(path)
            skip(key, path)
            continue
          }
          const id = buildFileTabId({ kind: "file", path: resolved })
          restoredIdsRef.current.set(id, key)
          ids.set(path, id)
        } catch {
          /* 打不开就跳过这一个 */
          ledger.adding.delete(path)
          skip(key, path)
        }
      }
      // 第一次选中记下的那个；以后只在它被挤掉、这次补开了的时候选回去。
      const active = entries.active
      if (
        active != null &&
        (first || missing.includes(active)) &&
        !skipped.get(key)?.has(active) &&
        !userPickedRef.current.has(key)
      ) {
        pendingActiveRef.current.set(key, {
          id: ids.get(active) ?? buildFileTabId({ kind: "file", path: active }),
          path: active,
        })
      }
      pendingOrderRef.current.set(key, entries.paths)
      return true
    }
    // restoredTick：一次恢复做完，看看要不要把补开时挤掉的再补开一次。
  }, [storageKey, consistent, activeFolderId, server, snapshot, restoredTick])

  // 选中记下的那个。不能恢复完立刻选：办公文档加完标签就返回，这时还没提交，
  // 工作区认的标签列表里没有它，选了会被当成不存在的标签忽略。等它出现在
  // fileTabs 里再选；工作区的列表在它自己的 effect 里更新，比这里晚，所以再
  // 推到下一轮。真选了才清掉记下的 id：定时器还没到，标签栏又变了（比如下面
  // 关掉读不到的标签），定时器会被取消，下一次 effect 还要再排。
  useEffect(() => {
    if (storageKey == null || !consistent) return
    const key = storageKey
    const pending = pendingActiveRef.current.get(key)
    if (!pending || !fileTabs.some((tab) => tab.id === pending.id)) return
    if (activeFileTabId === pending.id) {
      pendingActiveRef.current.delete(key)
      return
    }
    const timer = window.setTimeout(() => {
      if (pendingActiveRef.current.get(key) !== pending) return
      pendingActiveRef.current.delete(key)
      switchingRef.current.set(key, pending.path)
      switchFileTab(pending.id)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [
    storageKey,
    consistent,
    fileTabs,
    activeFileTabId,
    switchFileTab,
    restoredTick,
  ])

  // 恢复出来但读不到的文件（出错的标签）关掉；读到了的就不再管。只看当前项目
  // 恢复完的：跟随项目时别的项目的标签不在这条标签栏里，等切回去再看。
  useEffect(() => {
    if (storageKey == null || !consistent || !restoredKeys.has(storageKey)) {
      return
    }
    const pending = restoredIdsRef.current
    for (const [id, key] of [...pending]) {
      if (key !== storageKey) continue
      const tab = fileTabs.find((candidate) => candidate.id === id)
      if (tab?.loading) continue
      pending.delete(id)
      if (tab && tab.saveState === "error") {
        if (tab.path) {
          closingRef.current.add(tab.path)
          skip(key, tab.path)
        }
        closeFileTab(id)
      }
    }
  }, [storageKey, consistent, fileTabs, closeFileTab, restoredTick])

  const signature = `${snapshot.active ?? ""}\u0001${snapshot.paths.join("\u0000")}`
  const snapshotRef = useRef(snapshot)
  useEffect(() => {
    snapshotRef.current = snapshot
  }, [snapshot])

  // 上一次看到的标签栏，连同当时在哪个项目、哪个标签范围。换了项目或范围只把
  // 这时的样子当成新的起点：标签跟随项目（默认开）时换项目，可见的标签栏会跟着
  // 变，这不是用户改了标签，不能写进新项目名下冲掉它原来记下的。
  const seenRef = useRef<{
    view: string
    signature: string
    snapshot: PersistedFileTabs
    // 工作区真正的选中项（可能是浏览器标签）：它不是空的时候，工作区不会自己
    // 选上新开的文件标签。
    rawActive: string | null
    // 当时所有项目合计开着几个标签。
    bufferCount: number
    // 上一次变化里恢复加进来、还没看到上限因此关掉标签的个数（上限可能晚一次
    // 渲染才关）。
    restoreCredit: number
  } | null>(null)
  const view =
    storageKey == null
      ? null
      : `${storageKey}\u0001${tabsFollowFolder ? String(tabScope) : ""}`
  useEffect(() => {
    if (storageKey == null || view == null || !consistent) {
      seenRef.current = null
      return
    }
    const folderId = Number(activeFolderId)
    // 换了项目：上一个项目没写完的先写掉。
    if (pendingRef.current && pendingRef.current.key !== storageKey) {
      flushRef.current()
    }
    const current = snapshotRef.current
    const previous = seenRef.current
    seenRef.current = {
      view,
      signature,
      snapshot: current,
      rawActive: activeFileTabId,
      bufferCount,
      restoreCredit: 0,
    }
    let changed = false
    if (
      previous &&
      previous.view === view &&
      previous.signature !== signature
    ) {
      changed = true
      const verdict = explainChange(previous.snapshot, current, {
        ledgers: ledgersRef.current,
        closing: closingRef.current,
        switching: switchingRef.current,
        reordering: reorderingRef.current,
        key: storageKey,
        prevRawActive: previous.rawActive,
        prevBufferCount: previous.bufferCount,
        restoreCredit: previous.restoreCredit,
      })
      seenRef.current.restoreCredit = verdict.restoreCredit
      if (verdict.evicted.length > 0) {
        let evicted = evictedRef.current.get(storageKey)
        if (!evicted) {
          evicted = new Set()
          evictedRef.current.set(storageKey, evicted)
        }
        for (const path of verdict.evicted) evicted.add(path)
      }
      if (!verdict.paths || !verdict.active) liveRef.current.add(storageKey)
      if (!verdict.paths) {
        // 用户自己开、关、拖过：恢复完不再按记下的排顺序。
        userEditedRef.current.add(storageKey)
        pendingOrderRef.current.delete(storageKey)
      }
      if (!verdict.active) {
        // 用户自己选了标签：恢复完不再去选记下的那个。
        userPickedRef.current.add(storageKey)
        pendingActiveRef.current.delete(storageKey)
      }
    }
    if (restores.has(storageKey)) return
    const settled = settledRef.current.delete(storageKey)
    if (!restoredKeys.has(storageKey) || !liveRef.current.has(storageKey)) {
      return
    }
    if (!changed && !settled) return
    pendingRef.current = {
      key: storageKey,
      folderId,
      server,
      snapshot: current,
    }
    if (timerRef.current !== null) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null
      flushRef.current()
    }, SAVE_DEBOUNCE_MS)
  }, [
    storageKey,
    view,
    consistent,
    signature,
    activeFolderId,
    server,
    activeFileTabId,
    bufferCount,
    restoredTick,
  ])

  // 恢复完把记下的那几个标签摆回记下的顺序：补开的标签加在末尾，要挪回原位。只在
  // 这几个标签占着的位置之间换，别的标签不动；用户这次恢复期间动过标签就不排。
  // 放在写的那个 effect 后面：要等它把这一轮出现的标签从账上划掉。
  useEffect(() => {
    if (storageKey == null || !consistent || restores.has(storageKey)) return
    const key = storageKey
    const order = pendingOrderRef.current.get(key)
    if (!order) return
    if ((ledgersRef.current.get(key)?.adding.size ?? 0) > 0) return
    pendingOrderRef.current.delete(key)
    if (userEditedRef.current.has(key)) return
    const wanted = new Set(order)
    const slots: number[] = []
    const byPath = new Map<string, FileWorkspaceTab>()
    fileTabs.forEach((tab, index) => {
      if (tab.kind !== "file" || !tab.path || !wanted.has(tab.path)) return
      slots.push(index)
      byPath.set(tab.path, tab)
    })
    const want = order.filter((path) => byPath.has(path))
    if (slots.every((slot, n) => fileTabs[slot].path === want[n])) return
    const next = [...fileTabs]
    slots.forEach((slot, n) => {
      next[slot] = byPath.get(want[n])!
    })
    reorderingRef.current.set(
      key,
      snapshotFileTabs(next, activeFileTabId).paths.join("\u0000")
    )
    reorderFileTabs(next)
  }, [
    storageKey,
    consistent,
    fileTabs,
    activeFileTabId,
    reorderFileTabs,
    restoredTick,
  ])

  useEffect(() => {
    const flush = () => flushRef.current()
    window.addEventListener("pagehide", flush)
    return () => {
      window.removeEventListener("pagehide", flush)
      // 卸载时没写完的不能丢。
      flush()
    }
  }, [])

  return null
}

/**
 * 标签栏从 prev 变成 next，是不是恢复自己做的：多出来的是哪次恢复还要加的、少了的
 * 是自己关掉的出错标签、留下的相对顺序没变（paths）；选中项没变、是自己选的那个、
 * 原来没选中时工作区自己选上了恢复的标签、或者原来选中的那个被自己关掉了（active）。
 * 对上了的账划掉，同一件事只解释一次。
 */
function explainChange(
  prev: PersistedFileTabs,
  next: PersistedFileTabs,
  books: {
    ledgers: Map<string, RestoreLedger>
    closing: Set<string>
    switching: Map<string, string>
    reordering: Map<string, string>
    key: string
    prevRawActive: string | null
    prevBufferCount: number
    restoreCredit: number
  }
): {
  paths: boolean
  active: boolean
  evicted: string[]
  restoreCredit: number
} {
  const prevSet = new Set(prev.paths)
  const nextSet = new Set(next.paths)
  const added = next.paths.filter((path) => !prevSet.has(path))
  const removed = prev.paths.filter((path) => !nextSet.has(path))
  let paths = true
  let restoredNow = 0
  for (const path of added) {
    const ledger = [...books.ledgers.values()].find((candidate) =>
      candidate.adding.has(path)
    )
    if (ledger) {
      ledger.adding.delete(path)
      restoredNow += 1
    } else paths = false
  }
  const closedByUs = new Set<string>()
  // 标签上限挤掉的：恢复补开标签让所有项目合计超过上限时，工作区自己关掉的（同一
  // 次渲染里，或者紧接着的下一次）。只认恢复刚加进来的那几个能挤掉几个：没保存的
  // 标签上限不关，合计可能一直超着，这时用户自己关的不能当成上限挤掉的。
  const credit = books.restoreCredit + restoredNow
  let evictable = Math.min(
    credit,
    Math.max(0, books.prevBufferCount + added.length - MAX_FILE_TABS)
  )
  const evicted: string[] = []
  for (const path of removed) {
    if (books.closing.delete(path)) closedByUs.add(path)
    else if (evictable > 0) {
      evictable -= 1
      evicted.push(path)
      closedByUs.add(path)
    } else paths = false
  }
  const keptPrev = prev.paths.filter((path) => nextSet.has(path))
  const keptNext = next.paths.filter((path) => prevSet.has(path))
  if (keptPrev.some((path, i) => path !== keptNext[i])) {
    // 自己按记下的顺序排的不算。
    const reordering = books.reordering.get(books.key)
    if (reordering != null && reordering === next.paths.join("\u0000")) {
      books.reordering.delete(books.key)
    } else {
      paths = false
    }
  }

  let active = next.active === prev.active
  const switching = books.switching.get(books.key)
  if (!active && next.active != null && next.active === switching) {
    books.switching.delete(books.key)
    active = true
  }
  // 原来什么都没选中（连浏览器标签也没有）时，工作区会自己选上新开的标签。
  if (
    !active &&
    prev.active == null &&
    books.prevRawActive == null &&
    next.active != null
  ) {
    const target = next.active
    active = [...books.ledgers.values()].some((ledger) =>
      ledger.all.has(target)
    )
  }
  if (!active && prev.active != null && closedByUs.has(prev.active)) {
    active = true
  }
  // 恢复这次加进来、上限还没关掉标签的，留给紧接着的下一次变化。
  const restoreCredit = Math.max(
    0,
    restoredNow - Math.max(0, evicted.length - books.restoreCredit)
  )
  return { paths, active, evicted, restoreCredit }
}
