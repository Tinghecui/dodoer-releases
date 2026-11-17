// 刷新、重启以后要回来的文件标签：打开了哪些文件、顺序、选中的是哪个。
//
// 只记文件标签（kind 为 "file"）的绝对路径，不记内容：内容回来时从磁盘重新读，
// 没保存的改动不恢复。diff 标签是一次 git 操作的结果，浏览器标签有
// `lib/browser/browser-tab-persistence` 管，这里都不记。
//
// 只存在本机（localStorage），一个服务器的一个项目一个 key
// （`workspace:file-tabs:v1:<server>:<folderId>`，server 是 `local` 或桌面端连着的
// `remote-<连接编号>`：不同服务器的项目编号会重，不能共用一条），不进服务器、不跨设备。这里只有纯函数；什么时候存、什么时候读回来见
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

interface StoredShape {
  version: number
  tabs: { kind: "file"; path: string }[]
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

const EMPTY: PersistedFileTabs = { paths: [], active: null }

/** 读回某个项目记下的文件标签。坏数据、旧版本、读不了 localStorage 都当成没有，
 *  不抛错；单条坏的只丢那一条。 */
export function readPersistedFileTabs(
  folderId: number,
  server?: string
): PersistedFileTabs {
  if (typeof window === "undefined") return EMPTY
  let raw: string | null
  try {
    raw = localStorage.getItem(fileTabsStorageKey(folderId, server))
  } catch {
    return EMPTY
  }
  if (!raw) return EMPTY
  try {
    const parsed = JSON.parse(raw) as Partial<StoredShape> | null
    if (
      !parsed ||
      typeof parsed !== "object" ||
      parsed.version !== FILE_TABS_STORAGE_VERSION ||
      !Array.isArray(parsed.tabs)
    ) {
      return EMPTY
    }
    const paths: string[] = []
    const seen = new Set<string>()
    for (const entry of parsed.tabs as unknown[]) {
      if (!entry || typeof entry !== "object") continue
      const { kind, path } = entry as Record<string, unknown>
      if (kind !== "file" || typeof path !== "string" || path === "") continue
      if (seen.has(path)) continue
      seen.add(path)
      paths.push(path)
    }
    const active =
      typeof parsed.active === "string" && seen.has(parsed.active)
        ? parsed.active
        : null
    return { paths, active }
  } catch {
    return EMPTY
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
