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
import { takeFileTabEvictedByCap } from "@/lib/files/file-tab-evictions"
import { subscribeUserPickedFileTab } from "@/lib/files/file-tab-user-pick"
import {
  fileTabsServerKey,
  fileTabsStorageKey,
  forgetPersistedFileTabPaths,
  readPersistedFileTabs,
  readSharedFileTabs,
  samePersistedFileTabs,
  sharedFileTabsStorageKey,
  snapshotFileTabs,
  writePersistedFileTabs,
  writeSharedFileTabs,
  type PersistedFileTabs,
  type SharedFileTabs,
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

// 这个文档里每个项目正在做的恢复，key 是存储的 key（分服务器、分项目）。标签跟随
// 项目时每次切进一个项目都对一下它记下的标签：缺了的（文件标签最多开三个，别的项目开标签时会把
// 这个项目的挤掉）补开回来。同一个项目同时只有一次恢复，provider 重新挂载也接着
// 等它；第一次恢复做完的记在 restoredKeys 里，在那之前、以及恢复进行中，这个项目
// 一律不写。刷新、重启是新文档，从头恢复。
const restores = new Map<string, Promise<boolean>>()
const restoredKeys = new Set<string>()
// 恢复时发现读不到的文件（删了、挪了），这个文档里不再试。
const skipped = new Map<string, Set<string>>()
// 刷新后恢复共用那一排（标签不跟随项目时）已经了结的服务器：恢复完了、没记过共用
// 那一排、或者这个文档里先按项目恢复过（开关开着）。没了结之前换项目，新项目接着
// 恢复共用那一排（半路停下的那次恢复不算数），不读它自己的旧记录；了结之前也不写
// 共用那一排。
const sharedSettled = new Set<string>()
// 这个文档里已经有一次恢复做完了的服务器：之后标签不跟随项目时切项目，共用那排
// 原样不动，不再补开新项目以前记下的标签。
const rowRestored = new Set<string>()

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
  sharedSettled.clear()
  rowRestored.clear()
}

/** 一次恢复的账：标签栏变了，靠它分清是恢复自己做的还是用户做的。 */
interface RestoreLedger {
  /** 恢复还会让它出现在标签栏里的路径，出现一次就划掉。 */
  adding: Set<string>
  /** 恢复打开的所有路径：没有选中项时工作区会自己选上其中一个。 */
  all: Set<string>
  /** 这次恢复开始时读到的记录。 */
  entries: PersistedFileTabs
  /** 恢复的是共用那一排时，每个文件在哪些项目里开着。 */
  owners?: Map<string, number[]>
}

// 共用那排记每个文件属于哪些项目时，聊天会话用的全局范围记成 0：folderScope(0)
// 就是全局范围，恢复时按它打开就开进聊天会话的标签组。
const GLOBAL_OWNER = 0

/** 记下的项目编号对应的标签范围（0 是聊天会话的全局范围）。 */
function ownerScope(owner: number): string {
  return String(folderScope(owner === GLOBAL_OWNER ? null : owner))
}

/**
 * 只留这个项目自己的标签（标签不跟随项目时，按项目的记录不能混进别的项目的文件，
 * 不然打开跟随后会开进这个项目的标签组）。是谁的看它登记在哪个项目的标签组里；
 * 哪个组都没登记的（还没开出来）看共用那排记下的项目，都没有的算这个项目的。
 */
function ownTabs(
  tabs: PersistedFileTabs,
  folderId: number,
  owners: Map<string, number[]> | undefined
): PersistedFileTabs {
  const { fileRefs } = useFolderTabsStore.getState()
  const own = String(folderScope(folderId))
  const paths = tabs.paths.filter((path) => {
    const id = buildFileTabId({ kind: "file", path })
    const scopes = Object.keys(fileRefs).filter((scope) =>
      fileRefs[scope]?.includes(id)
    )
    if (scopes.length > 0) return scopes.includes(own)
    const owner = owners?.get(path)
    return !owner?.length || owner.some((id) => ownerScope(id) === own)
  })
  const active =
    tabs.active != null && paths.includes(tabs.active) ? tabs.active : null
  return { paths, active }
}

/**
 * 标签不跟随项目时这个项目要记下的样子：共用那排里算它自己的那几个，再留着它以前
 * 记下、眼下不在共用那排里的（被标签上限挤掉的，开关开着时也一样留着）。只有用户
 * 这次关掉的、读不到的才去掉。不然在这个项目里点一下别的项目的文件，就会把它被挤掉的
 * 那几个从记录里抹掉，打开跟随后就没了。留下的按以前记下的位置插回去。
 */
function keepUnseen(
  own: PersistedFileTabs,
  row: PersistedFileTabs,
  previous: PersistedFileTabs,
  closed: ReadonlySet<string>,
  gone: ReadonlySet<string> | undefined
): PersistedFileTabs {
  const inRow = new Set(row.paths)
  const paths = [...own.paths]
  previous.paths.forEach((path, index) => {
    if (inRow.has(path) || closed.has(path) || gone?.has(path)) return
    if (paths.includes(path)) return
    let at = 0
    for (let before = index - 1; before >= 0; before--) {
      const found = paths.indexOf(previous.paths[before])
      if (found >= 0) {
        at = found + 1
        break
      }
    }
    paths.splice(at, 0, path)
  })
  const active =
    own.active ??
    (previous.active != null && paths.includes(previous.active)
      ? previous.active
      : null)
  return { paths, active }
}

/** 共用那排里每个文件登记在哪些项目的标签组里（同一个文件可以在几个项目里都开着，
 *  全记下；聊天会话的全局范围记成 0），刷新后开回每一个。 */
function tabOwners(paths: readonly string[]): Map<string, number[]> {
  const { fileRefs } = useFolderTabsStore.getState()
  const owners = new Map<string, number[]>()
  for (const path of paths) {
    const id = buildFileTabId({ kind: "file", path })
    const folderIds: number[] = []
    for (const [scope, ids] of Object.entries(fileRefs)) {
      if (!ids.includes(id)) continue
      const folderId = scope === "global" ? GLOBAL_OWNER : Number(scope)
      if (Number.isInteger(folderId) && !folderIds.includes(folderId)) {
        folderIds.push(folderId)
      }
    }
    if (folderIds.length > 0) owners.set(path, folderIds)
  }
  return owners
}

/** 共用那排记下的项目里，这个文件还没登记进哪几个的标签组（恢复到一半停下时，
 *  可能只开进了前几个）。 */
function unregisteredOwners(
  path: string,
  owners: Map<string, number[]> | undefined
): number[] {
  const targets = owners?.get(path)
  if (!targets?.length) return []
  const { fileRefs } = useFolderTabsStore.getState()
  const id = buildFileTabId({ kind: "file", path })
  return targets.filter((target) => !fileRefs[ownerScope(target)]?.includes(id))
}

/**
 * 恢复还没做完时用户动过标签，要记下的样子：用户眼下的标签栏，后面接着还没开出来
 * 的（以及被上限挤掉、还要补开的），按记下的顺序；用户没自己选过就留着记下的选中
 * 项。关掉的不在里面，切回来、刷新都不会再开出来；还没开出来的也不丢。
 */
function mergeWithRemainder(
  current: PersistedFileTabs,
  ledger: RestoreLedger,
  evicted: Set<string> | undefined,
  userPicked: boolean
): PersistedFileTabs {
  const open = new Set(current.paths)
  const rest = ledger.entries.paths.filter(
    (path) =>
      !open.has(path) && (ledger.adding.has(path) || !!evicted?.has(path))
  )
  const paths = [...current.paths, ...rest]
  const recorded = ledger.entries.active
  const active =
    !userPicked && recorded != null && paths.includes(recorded)
      ? recorded
      : current.active
  return { paths, active }
}

// 恢复共用那排途中用户动过标签：共用那排当时就写下（刷新后第一次恢复读的是它）。
// 还没开出来的照记下的项目，开出来的再合上它眼下登记在哪些项目里。
function writeSharedDuringRestore(
  merged: PersistedFileTabs,
  recorded: Map<string, number[]>,
  server: string
) {
  const owners = new Map(recorded)
  for (const [path, ids] of tabOwners(merged.paths)) {
    owners.set(path, [...new Set([...(owners.get(path) ?? []), ...ids])])
  }
  writeSharedFileTabs(merged, server, owners)
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
 * 从这以后这个项目的标签栏一变就写。恢复期间动过的当时就写，写的是用户眼下的
 * 标签栏接上还没开出来的那几个（切走再回来、刷新都不丢），恢复完再按实际的写一次。只换项目、换范围
 * 不算变化。标签不跟随项目时，用户关掉的标签同时从别的项目的记录里划掉。
 *
 * 标签不跟随项目时标签栏是各项目共用的一排，这一整排另记一份（不管是谁改的，连同
 * 每个文件在哪个项目里开的），刷新、重启后第一次恢复读它，标签、顺序、选中项和刷新
 * 前一样，每个文件开回它自己的项目。恢复过以后切项目，这一排原样不动，不补开新项目
 * 以前记下的。按项目的记录这时只记这个项目自己的标签，打开跟随后各项目只恢复自己的。
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
  // 开关的值要等页面加载后才从本机读出来，在那之前 enabled 是初始的 false、不作数：
  // 不开始恢复，不然开关开着时刷新会当成关着、去读共用的那一排。
  const preferenceReady = useFolderTabsStore((s) => s.preferenceHydrated)
  // 每个文件登记在哪些项目的标签组里：只是多登记进一个项目（标签栏没变）也要重记
  // 共用那一排。
  const fileRefs = useFolderTabsStore((s) => s.fileRefs)
  // 一个恢复做完了，让下面的 effect 重跑。
  const [restoredTick, setRestoredTick] = useState(0)
  const server = fileTabsServerKey()
  const storageKey =
    activeFolderId == null ? null : fileTabsStorageKey(activeFolderId, server)
  // 标签不跟随项目、又没有当前项目（会话标签全关掉了）时，共用那排照样恢复、照样记：
  // 恢复和对账用共用那排的 key，项目当成聊天会话的全局范围（0）。按项目的记录不写。
  const rowKey =
    activeFolderId == null && !tabsFollowFolder
      ? sharedFileTabsStorageKey(server)
      : null
  const restoreKey = storageKey ?? rowKey
  const restoreFolderId = activeFolderId ?? (rowKey ? GLOBAL_OWNER : null)
  // 标签跟随项目时，看到的标签栏是当前范围的；范围可能晚一次渲染才跟上项目，
  // 对不上的那一下标签栏不属于这个项目，不看。
  const consistent =
    restoreKey != null &&
    (!tabsFollowFolder || tabScope === folderScope(activeFolderId))
  const storageKeyRef = useRef(restoreKey)
  useEffect(() => {
    storageKeyRef.current = restoreKey
  }, [restoreKey])
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
  // 标签栏告诉我们用户点了、拖了标签的项目，等下面对账的 effect 记成用户选过。
  // 点的是已经选中的标签时标签栏不变，只靠对比前后的标签栏看不出来。
  const pickedNowRef = useRef<Set<string>>(new Set())
  const [pickTick, setPickTick] = useState(0)
  const fileTabsRef = useRef(fileTabs)
  useEffect(() => {
    fileTabsRef.current = fileTabs
  }, [fileTabs])
  useEffect(
    () =>
      subscribeUserPickedFileTab((tabId) => {
        const key = storageKeyRef.current
        if (key == null) return
        // 只管这个项目标签栏里的；恢复做完、记下的那个也选过了，就和平常一样
        // 只看标签栏的变化。
        if (!fileTabsRef.current.some((tab) => tab.id === tabId)) return
        if (!restores.has(key) && !pendingActiveRef.current.has(key)) return
        pickedNowRef.current.add(key)
        setPickTick((tick) => tick + 1)
      }),
    []
  )

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
    if (restoreKey == null || restoreFolderId == null || !preferenceReady) {
      enteredRef.current = null
      return
    }
    // 标签栏还没跟上这个项目：等跟上了再看缺什么。
    if (!consistent) {
      if (enteredRef.current !== restoreKey) enteredRef.current = null
      return
    }
    if (enteredRef.current === restoreKey) {
      // 补开时把自己另一个标签挤掉了：等这次恢复做完，再补开一次被挤掉的（这时
      // 刚开的几个是最近用过的，上限会去关别的项目的）。
      const evicted = evictedRef.current.get(restoreKey)
      if (
        !evicted?.size ||
        restores.has(restoreKey) ||
        retriedRef.current.has(restoreKey)
      ) {
        return
      }
      retriedRef.current.add(restoreKey)
    } else {
      enteredRef.current = restoreKey
      retriedRef.current.delete(restoreKey)
    }
    evictedRef.current.delete(restoreKey)
    const key = restoreKey
    const folderId = restoreFolderId
    let running = restores.get(key)
    if (!running) {
      // 标签不跟随项目、这个文档里已经恢复过：标签栏是大家共用的一排，切项目时
      // 原样不动，不把这个项目以前记下的补开进来（会挤掉开着的、换掉选中项）。
      // 记成恢复过，以后这个项目照常写。
      // 不记成「已进入」：之后就在这个项目里打开跟随，要按进入它来恢复它自己的。
      if (!tabsFollowFolder && rowRestored.has(server)) {
        restoredKeys.add(key)
        enteredRef.current = null
        return
      }
      // 没有当前项目：只恢复刷新前记下的共用那排，没记过（或已经了结）就什么都不开，
      // 等进了项目再按项目的来。
      if (
        key === rowKey &&
        (sharedSettled.has(server) || !readSharedFileTabs(server))
      ) {
        return
      }
      // 这个项目还有没写的先写掉，下面读到的才是最新的。
      if (pendingRef.current?.key === key) flushRef.current()
      // 新文档里的第一次恢复、标签不跟随项目：恢复刷新前共用的那一排，不看这个
      // 项目自己的记录（那是在这个项目里最后改的时候的样子，之后在别的项目开的
      // 不在里面）。没记过共用的那一排就还按项目的。这次恢复半路换了项目（没做完）
      // 的，新项目接着恢复共用那一排。
      const shared: SharedFileTabs | null =
        !tabsFollowFolder && !sharedSettled.has(server)
          ? readSharedFileTabs(server)
          : null
      if (!shared) sharedSettled.add(server)
      const entries = shared ?? readPersistedFileTabs(folderId, server)
      const gone = skipped.get(key)
      const open = new Set(snapshot.paths)
      // 恢复共用那排时，已经开着、但还没开进记下的每个项目的（上次恢复到一半停下
      // 的）也算缺的：接着开进其余的项目。
      const partial = new Set(
        shared
          ? entries.paths.filter(
              (path) =>
                open.has(path) &&
                unregisteredOwners(path, shared.owners).length > 0
            )
          : []
      )
      const missing = entries.paths.filter(
        (path) => (!open.has(path) || partial.has(path)) && !gone?.has(path)
      )
      // 以后切进来只管被挤掉的：什么都没缺就不动，选中项也不去改（标签不跟随项目
      // 时标签栏是大家共用的，选中别的项目的标签是常态）。
      const first = !restoredKeys.has(key)
      if (!first && missing.length === 0) return
      running = restore(
        folderId,
        key,
        entries,
        missing,
        partial,
        first,
        shared?.owners
      )
      // 恢复的是共用的那一排：这个项目最后写下的还是它自己那份，以后标签栏改成和
      // 共用那排一样时也要写。
      if (shared) {
        lastWrittenRef.current.set(key, readPersistedFileTabs(folderId, server))
      }
      restores.set(key, running)
    }
    const current = running
    const fromShared = !sharedSettled.has(server)
    void current.then((done) => {
      // provider 重新挂载过的话，新旧两个实例都等着同一次恢复，谁先到谁清掉。
      if (restores.get(key) === current) restores.delete(key)
      // 半路停下的，下次切回来接着恢复（已经开着的不会重复开）。
      if (!done) {
        // 恢复共用那一排的途中打开了跟随：还在这个项目里，就重新进一次，改恢复
        // 它自己的记录（不然要等切走再回来）。
        if (
          fromShared &&
          useFolderTabsStore.getState().enabled &&
          enteredRef.current === key
        ) {
          enteredRef.current = null
          setRestoredTick((tick) => tick + 1)
        }
        return
      }
      if (fromShared) sharedSettled.add(server)
      // 没有当前项目时不对账（按项目的那个 effect 不跑），恢复加的不会从账上划掉：
      // 做完就清掉，免得以后进了项目，用户重新打开同一个文件被当成恢复加的。
      if (key === rowKey) ledgersRef.current.get(key)?.adding.clear()
      rowRestored.add(server)
      restoredKeys.add(key)
      settledRef.current.add(key)
      setRestoredTick((tick) => tick + 1)
    })

    async function restore(
      folderId: number,
      key: string,
      entries: PersistedFileTabs,
      missing: string[],
      // 已经在标签栏里、只差开进其余项目的：不会再出现一次，不记进 adding。
      partial: Set<string>,
      first: boolean,
      // 恢复的是共用那一排时有：每个文件开回它自己的项目（打开跟随后在那个项目的
      // 标签组里）；没记的开进这个项目。
      owners: Map<string, number[]> | undefined
    ): Promise<boolean> {
      const fromShared = owners != null
      lastWrittenRef.current.set(key, entries)
      userPickedRef.current.delete(key)
      userEditedRef.current.delete(key)
      const ledger: RestoreLedger = {
        adding: new Set(missing.filter((path) => !partial.has(path))),
        all: new Set(entries.paths),
        entries,
        owners,
      }
      ledgersRef.current.set(key, ledger)
      // 用户换到了别的项目：标签不跟随项目时标签栏是全局的，原项目剩下的不再
      // 打开（免得混进别的项目的标签栏），切回来再接着开；跟随项目时打开的是
      // 原项目自己那组标签，在后台接着开完。恢复的是共用那一排、途中打开了跟随：
      // 剩下的是别的项目的标签，不再开进这个项目的标签组。
      const abandoned = () => {
        const follow = useFolderTabsStore.getState().enabled
        return (
          (fromShared && follow) || (storageKeyRef.current !== key && !follow)
        )
      }
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
          // 在几个项目里都开着的，每个项目都开一次（登记进各自的标签组）。
          const targets = partial.has(path)
            ? unregisteredOwners(path, owners)
            : owners?.get(path)?.length
              ? owners.get(path)!
              : [folderId]
          let resolved: string | null = null
          for (const target of targets) {
            if (abandoned()) return giveUp(index)
            resolved =
              (await openFilePreviewRef.current(path, {
                background: true,
                folderId: target,
              })) ?? resolved
          }
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
      // 最后一个开的时候打开了跟随，也不算恢复完。
      if (fromShared && abandoned()) return giveUp(missing.length)
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
  }, [
    restoreKey,
    rowKey,
    consistent,
    restoreFolderId,
    server,
    snapshot,
    restoredTick,
    tabsFollowFolder,
    preferenceReady,
  ])

  // 选中记下的那个。不能恢复完立刻选：办公文档加完标签就返回，这时还没提交，
  // 工作区认的标签列表里没有它，选了会被当成不存在的标签忽略。等它出现在
  // fileTabs 里再选；工作区的列表在它自己的 effect 里更新，比这里晚，所以再
  // 推到下一轮。真选了才清掉记下的 id：定时器还没到，标签栏又变了（比如下面
  // 关掉读不到的标签），定时器会被取消，下一次 effect 还要再排。
  useEffect(() => {
    if (restoreKey == null || !consistent) return
    const key = restoreKey
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
    restoreKey,
    consistent,
    fileTabs,
    activeFileTabId,
    switchFileTab,
    restoredTick,
  ])

  // 恢复出来但读不到的文件（出错的标签）关掉；读到了的就不再管。只看当前项目
  // 恢复完的：跟随项目时别的项目的标签不在这条标签栏里，等切回去再看。
  useEffect(() => {
    if (restoreKey == null || !consistent || !restoredKeys.has(restoreKey)) {
      return
    }
    const pending = restoredIdsRef.current
    for (const [id, key] of [...pending]) {
      if (key !== restoreKey) continue
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
  }, [restoreKey, consistent, fileTabs, closeFileTab, restoredTick])

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
    // 标签不跟随项目时，共用那排里算这个项目自己的那几个（看登记在哪个项目的
    // 标签组里）：标签栏没变、只是多登记进这个项目，也要重记它的记录。
    own: string
  } | null>(null)
  const view =
    storageKey == null
      ? null
      : `${storageKey}\u0001${tabsFollowFolder ? String(tabScope) : ""}`
  useEffect(() => {
    if (storageKey == null || view == null || !consistent) {
      seenRef.current = null
      // 没有当前项目、恢复的是共用那排：下面的对账不跑，用户在标签栏上点了、拖了
      // 标签也要在这里记成选过，不然恢复完又选回记下的那个。恢复期间共用那排也当时
      // 写下，恢复完之前刷新才不丢。
      if (rowKey != null && consistent && pickedNowRef.current.has(rowKey)) {
        userPickedRef.current.add(rowKey)
        pendingActiveRef.current.delete(rowKey)
        const ledger = ledgersRef.current.get(rowKey)
        if (restores.has(rowKey) && ledger?.owners) {
          writeSharedDuringRestore(
            mergeWithRemainder(
              snapshotRef.current,
              ledger,
              evictedRef.current.get(rowKey),
              true
            ),
            ledger.owners,
            server
          )
        }
      }
      pickedNowRef.current.clear()
      return
    }
    const folderId = Number(activeFolderId)
    // 换了项目：上一个项目没写完的先写掉。
    if (pendingRef.current && pendingRef.current.key !== storageKey) {
      flushRef.current()
    }
    const current = snapshotRef.current
    const previous = seenRef.current
    const own = tabsFollowFolder
      ? ""
      : JSON.stringify(
          ownTabs(current, folderId, ledgersRef.current.get(storageKey)?.owners)
        )
    seenRef.current = {
      view,
      signature,
      snapshot: current,
      rawActive: activeFileTabId,
      bufferCount,
      restoreCredit: 0,
      own,
    }
    let changed = false
    // 这次变化里用户自己关掉的：标签不跟随项目时，这个项目的记录里也去掉。
    let closedNow: string[] = []
    if (
      !tabsFollowFolder &&
      previous &&
      previous.view === view &&
      previous.signature === signature &&
      previous.own !== own &&
      !restores.has(storageKey)
    ) {
      // 标签栏没变，只是用户在这个项目里点开了别的项目开着的文件（登记进了这个
      // 项目的标签组）：也是用户改的，这个项目的记录要记上它，打开跟随后才有。
      changed = true
      liveRef.current.add(storageKey)
    }
    if (pickedNowRef.current.delete(storageKey)) {
      // 用户在标签栏上点了、拖了标签（可能是工作区自己选上的那个，选中项没变）：
      // 算用户自己选过，恢复完不再去选记下的那个。
      changed = true
      liveRef.current.add(storageKey)
      userPickedRef.current.add(storageKey)
      pendingActiveRef.current.delete(storageKey)
    }
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
      closedNow = verdict.userClosed
      // 标签不跟随项目时标签栏是大家共用的，里面有从别的项目记录恢复出来的标签：
      // 用户在这里关掉的，别的项目的记录里也划掉，切过去才不会又被补开。
      if (!tabsFollowFolder && verdict.userClosed.length > 0) {
        // 划掉后的样子也记成那几个项目最后写下的：不然回去重新打开、标签栏恰好和
        // 划掉前一样时，会以为没变跳过不写，刷新就丢了。
        for (const { folderId: other, entries } of forgetPersistedFileTabPaths(
          verdict.userClosed,
          server,
          folderId
        )) {
          lastWrittenRef.current.set(fileTabsStorageKey(other, server), entries)
        }
      }
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
    const schedule = (tabs: PersistedFileTabs) => {
      // 标签不跟随项目时标签栏是共用的：这个项目只记它自己的那几个，以前记下、
      // 眼下不在共用那排里的（被上限挤掉的）留着。
      const previous =
        pendingRef.current?.key === storageKey
          ? pendingRef.current.snapshot
          : readPersistedFileTabs(folderId, server)
      const snapshot = tabsFollowFolder
        ? tabs
        : keepUnseen(
            ownTabs(tabs, folderId, ledgersRef.current.get(storageKey)?.owners),
            tabs,
            previous,
            new Set(closedNow),
            skipped.get(storageKey)
          )
      pendingRef.current = { key: storageKey, folderId, server, snapshot }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null
        flushRef.current()
      }, SAVE_DEBOUNCE_MS)
    }
    if (restores.has(storageKey)) {
      // 恢复期间用户开、关、拖、选过：不等恢复做完，连同还没开出来的一起写下。
      // 不然用户切到别的项目再回来，会照旧的记录把关掉的补开、把顺序和选中项摆
      // 回去；恢复完之前刷新也会丢。
      const ledger = ledgersRef.current.get(storageKey)
      const picked = userPickedRef.current.has(storageKey)
      if (
        changed &&
        ledger &&
        (picked || userEditedRef.current.has(storageKey))
      ) {
        const merged = mergeWithRemainder(
          current,
          ledger,
          evictedRef.current.get(storageKey),
          picked
        )
        schedule(merged)
        if (!tabsFollowFolder && ledger.owners) {
          // 恢复的是共用那排：刷新后第一次恢复读的是它，不是按项目的记录。也当时
          // 记下，不然恢复完之前再刷新，又按旧的那排把选中项、顺序摆回去。还没开
          // 出来的照记下的项目，开出来的看它眼下登记在哪些项目里。
          writeSharedDuringRestore(merged, ledger.owners, server)
        }
      }
      return
    }
    const settled = settledRef.current.delete(storageKey)
    if (!restoredKeys.has(storageKey) || !liveRef.current.has(storageKey)) {
      return
    }
    if (!changed && !settled) return
    schedule(current)
  }, [
    storageKey,
    view,
    consistent,
    signature,
    activeFolderId,
    server,
    activeFileTabId,
    bufferCount,
    tabsFollowFolder,
    restoredTick,
    fileRefs,
    pickTick,
    rowKey,
  ])

  // 标签不跟随项目时把共用的那一整排记下来：恢复全做完以后标签栏一变就写（恢复补开
  // 的也算，那也是用户看到的样子）。恢复还没做完不写，不然刷新后半空的标签栏会把
  // 刷新前的冲掉。
  const lastSharedRef = useRef<{
    tabs: PersistedFileTabs
    owners: string
  } | null>(null)
  useEffect(() => {
    if (tabsFollowFolder || restoreKey == null || !consistent) return
    if (!sharedSettled.has(server)) return
    // 没有当前项目时，这个文档里共用那排恢复过（在哪个项目里都算）就照写。
    const ready =
      restoredKeys.has(restoreKey) ||
      (restoreKey === rowKey && rowRestored.has(server))
    if (!ready || restores.size > 0) return
    const owners = tabOwners(snapshot.paths)
    const ownersKey = JSON.stringify([...owners])
    const last = lastSharedRef.current
    if (
      last &&
      last.owners === ownersKey &&
      samePersistedFileTabs(last.tabs, snapshot)
    ) {
      return
    }
    lastSharedRef.current = { tabs: snapshot, owners: ownersKey }
    writeSharedFileTabs(snapshot, server, owners)
  }, [
    tabsFollowFolder,
    restoreKey,
    rowKey,
    consistent,
    snapshot,
    server,
    restoredTick,
    fileRefs,
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
  /** 用户自己关掉的路径（不是自己关的出错标签，也不是上限关的）。 */
  userClosed: string[]
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
  // 次渲染里，或者紧接着的下一次）。是不是上限关的由工作区记下（见
  // lib/files/file-tab-evictions），这里只问它，不靠数个数猜：同一次渲染里上限挤掉
  // 的是别的项目的、用户又关了一个，用户关的那个不能当成挤掉的。另外只认恢复刚加
  // 进来的那几个能挤掉几个：用户自己开标签引起的上限关闭算用户改的。
  const credit = books.restoreCredit + restoredNow
  let evictable = Math.min(
    credit,
    Math.max(0, books.prevBufferCount + added.length - MAX_FILE_TABS)
  )
  const evicted: string[] = []
  const userClosed: string[] = []
  for (const path of removed) {
    if (books.closing.delete(path)) {
      closedByUs.add(path)
      continue
    }
    const capped = takeFileTabEvictedByCap(path)
    if (capped && evictable > 0) {
      evictable -= 1
      evicted.push(path)
      closedByUs.add(path)
    } else {
      paths = false
      if (!capped) userClosed.push(path)
    }
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
  return { paths, active, evicted, restoreCredit, userClosed }
}
