// 刷新、重启以后要回来的文件标签：打开了哪些文件、顺序、选中的是哪个。
//
// 只记文件标签（kind 为 "file"）的绝对路径，不记内容：内容回来时从磁盘重新读，
// 没保存的改动不恢复。diff 标签是一次 git 操作的结果，浏览器标签有
// `lib/browser/browser-tab-persistence` 管，这里都不记。
//
// 只存在本机（localStorage），一个服务器的一个项目一个 key
// （`workspace:file-tabs:v1:<server>:<folderId>`，server 是 `local` 或桌面端连着的
// `remote-<连接编号>`：不同服务器的项目编号会重，不能共用一条），不进服务器、不跨设备。
// 标签不跟随项目时标签栏是各项目共用的一排，这一整排另记一条
// （`workspace:file-tabs:v1:<server>:shared`），刷新后原样恢复。这里只有纯函数；什么时候存、什么时候读回来见
// `components/files/file-tabs-persistence`。

import type { FileWorkspaceTab } from "@/contexts/workspace-context"
import { getActiveRemoteConnectionId } from "@/lib/transport"

export const FILE_TABS_STORAGE_VERSION = 1
const KEY_PREFIX = `workspace:file-tabs:v${FILE_TABS_STORAGE_VERSION}:`

export interface PersistedFileTabs {
  /** 文件标签的绝对路径，按标签栏的顺序。 */
  paths: string[]
  /** 选中的那个标签的路径；选中的不是文件标签（或没有选中）时为 null。 */
  active: string | null
}

/** 共用的那一排：另记每个文件是在哪个项目里开的，刷新后开回那个项目的标签组。 */
export interface SharedFileTabs extends PersistedFileTabs {
  /** 路径 → 项目编号（同一个文件可以同时在几个项目里开着，全记下）；没记的（旧记录、
   *  不在哪个项目里开的）不在里面。 */
  owners: Map<string, number[]>
}

interface StoredShape {
  version: number
  tabs: { kind: "file"; path: string; folderIds?: number[] }[]
  active: string | null
}

/** 现在连的是哪个服务器：本机是 `local`，桌面端连着的远程服务器是 `remote-<编号>`。 */
export function fileTabsServerKey(): string {
  const remoteId = getActiveRemoteConnectionId()
  return remoteId == null ? "local" : `remote-${remoteId}`
}

export function fileTabsStorageKey(
  folderId: number,
  server: string = fileTabsServerKey()
): string {
  return `${KEY_PREFIX}${server}:${folderId}`
}

/** 标签不跟随项目时共用的那一排记在哪：一个服务器一条。 */
export function sharedFileTabsStorageKey(
  server: string = fileTabsServerKey()
): string {
  return `${KEY_PREFIX}${server}:shared`
}

const EMPTY: PersistedFileTabs = { paths: [], active: null }

/** 读回某个项目记下的文件标签。坏数据、旧版本、读不了 localStorage 都当成没有，
 *  不抛错；单条坏的只丢那一条。 */
export function readPersistedFileTabs(
  folderId: number,
  server?: string
): PersistedFileTabs {
  const stored = readStored(fileTabsStorageKey(folderId, server))
  return stored ? { paths: stored.paths, active: stored.active } : EMPTY
}

/** 读回共用的那一排；没记过（或坏了）是 null，和「记的是空的」分开。 */
export function readSharedFileTabs(server?: string): SharedFileTabs | null {
  return readStored(sharedFileTabsStorageKey(server))
}

function readStored(key: string): SharedFileTabs | null {
  if (typeof window === "undefined") return null
  let raw: string | null
  try {
    raw = localStorage.getItem(key)
  } catch {
    return null
  }
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== FILE_TABS_STORAGE_VERSION ||
      !Array.isArray(parsed.tabs)
    ) {
      return null
    }
    const paths: string[] = []
    const seen = new Set<string>()
    const owners = new Map<string, number[]>()
    for (const entry of parsed.tabs as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const { kind, path, folderIds } = entry as Record<string, unknown>
      if (kind !== "file" || typeof path !== "string" || path === "") continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
      if (Array.isArray(folderIds)) {
        const ids = [
          ...new Set(
            folderIds.filter(
              (id): id is number =>
                typeof id === "number" && Number.isInteger(id)
            )
          ),
        ]
        if (ids.length > 0) owners.set(path, ids)
      }
    }
    const active =
      typeof parsed.active === "string" && seen.has(parsed.active)
        ? parsed.active
        : null
    return { paths, active, owners }
  } catch {
    return null
  }
}

export function writePersistedFileTabs(
  folderId: number,
  state: PersistedFileTabs,
  server?: string
): void {
  if (typeof window === "undefined") return
  const key = fileTabsStorageKey(folderId, server)
  try {
    if (state.paths.length === 0) {
      localStorage.removeItem(key)
      return
    }
    const stored: StoredShape = {
      version: FILE_TABS_STORAGE_VERSION,
      tabs: state.paths.map((path) => ({ kind: "file" as const, path })),
      active: state.active,
    }
    localStorage.setItem(key, JSON.stringify(stored))
  } catch {
    /* 配额满了、隐私模式：这次的标签就不留了 */
  }
}

/** 记下共用的那一排。全关了也记一条空的：刷新后是空的，不退回去读某个项目的记录。
 *  owners 是每个文件在哪些项目里开着的（没有的不记）。 */
export function writeSharedFileTabs(
  state: PersistedFileTabs,
  server?: string,
  owners?: ReadonlyMap<string, readonly number[]>
): void {
  if (typeof window === "undefined") return
  try {
    const stored: StoredShape = {
      version: FILE_TABS_STORAGE_VERSION,
      tabs: state.paths.map((path) => {
        const folderIds = owners?.get(path)
        return folderIds?.length
          ? { kind: "file" as const, path, folderIds: [...folderIds] }
          : { kind: "file" as const, path }
      }),
      active: state.active,
    }
    localStorage.setItem(
      sharedFileTabsStorageKey(server),
      JSON.stringify(stored)
    )
  } catch {
    /* 配额满了、隐私模式：这次的标签就不留了 */
  }
}

/**
 * 把这几个路径从这个服务器上别的项目的记录里划掉（exceptFolderId 那个项目自己的
 * 记录不动，由调用方按标签栏写）。标签不跟随项目时标签栏是共用的，用户在一个项目
 * 里关掉了从别的项目恢复出来的标签，那个项目的记录里也不能再有它。选中的被划掉
 * 了就不留选中项。返回改写过的那几个项目和改写后的记录，调用方据此更新自己的
 * 「最后写下的样子」，免得以后写同样的内容时以为没变、跳过不写。
 */
export function forgetPersistedFileTabPaths(
  paths: readonly string[],
  server: string,
  exceptFolderId: number
): { folderId: number; entries: PersistedFileTabs }[] {
  const rewritten: { folderId: number; entries: PersistedFileTabs }[] = []
  if (typeof window === "undefined" || paths.length === 0) return rewritten
  const prefix = `${KEY_PREFIX}${server}:`
  const folderIds: number[] = []
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key?.startsWith(prefix)) continue
      const folderId = Number(key.slice(prefix.length))
      if (Number.isInteger(folderId) && folderId !== exceptFolderId) {
        folderIds.push(folderId)
      }
    }
  } catch {
    return rewritten
  }
  const gone = new Set(paths)
  for (const folderId of folderIds) {
    const recorded = readPersistedFileTabs(folderId, server)
    if (!recorded.paths.some((path) => gone.has(path))) continue
    const entries: PersistedFileTabs = {
      paths: recorded.paths.filter((path) => !gone.has(path)),
      active:
        recorded.active != null && gone.has(recorded.active)
          ? null
          : recorded.active,
    }
    writePersistedFileTabs(folderId, entries, server)
    rewritten.push({ folderId, entries })
  }
  return rewritten
}

/** 标签栏在持久化眼里的样子：文件标签的路径（按顺序）和选中的那个。 */
export function snapshotFileTabs(
  fileTabs: readonly FileWorkspaceTab[],
  activeFileTabId: string | null
): PersistedFileTabs {
  const paths: string[] = []
  let active: string | null = null
  for (const tab of fileTabs) {
    if (tab.kind !== "file" || !tab.path) continue
    paths.push(tab.path)
    if (tab.id === activeFileTabId) active = tab.path
  }
  return { paths, active }
}

export function samePersistedFileTabs(
  a: PersistedFileTabs,
  b: PersistedFileTabs
): boolean {
  if (a.active !== b.active || a.paths.length !== b.paths.length) return false
  return a.paths.every((path, i) => path === b.paths[i])
}
