// The send queue across a page reload (AI QA #159) and an app restart (ported
// from dodoer #416).
//
// jenny's queue (`use-message-queue.ts`) lives in React state only, so a
// reload, a quit, a crash or "Restart to update" dropped every message still
// waiting in it, and the retry button of a failed one with them. It is now
// mirrored into localStorage per saved conversation, and read back when the
// conversation's view mounts.
//
// What comes back is ALWAYS failed — retry or delete, never sent on its own:
// a restart can land at any moment, and sending what was read back could send
// a message twice.
//
// localStorage is shared by every window of the origin, so each stored queue
// is CLAIMED by one window: the first to open the conversation reads and
// writes it, and a second window on the same conversation neither shows (nor
// offers to re-send) it nor overwrites it. Nothing is read back before the
// claim is confirmed (`acquireStoredQueue`). On the desktop a claim names its
// window by the Tauri window label, which a restart keeps, so the same window
// takes its own queue back at once. In a browser it names the page itself (a
// duplicated tab copies sessionStorage, so nothing kept there can tell two
// pages apart); a reload lets the old page's claim go on `pagehide`. Another
// window's claim lapses when that window lets it go (view closed, page
// hidden) or stops refreshing it (a crash).

import { getCurrentWindowLabel } from "@/lib/browser/window-label"
import { getActiveRemoteConnectionId, isDesktop } from "@/lib/transport"
import type { PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import type { QueuedMessage } from "@/hooks/use-message-queue"

const STORAGE_PREFIX = "cowork:message-queue:v1"
/** Per conversation. Enough for any real queue; a pathological one keeps
 *  its first items. */
export const MAX_STORED_ITEMS = 50
/** Per conversation, in UTF-16 code units of the JSON (localStorage has a
 *  few MB per origin in all). Items past it (a big pasted image) are kept in
 *  memory only, as before. */
export const MAX_STORED_CHARS = 512 * 1024

/** The storage key of `conversationId`'s queue on the active backend (a
 *  desktop window on a remote workspace shares the origin with local ones). */
export function messageQueueStorageKey(conversationId: number): string {
  const remoteId = getActiveRemoteConnectionId()
  const scope = remoteId == null ? "local" : `remote-${remoteId}`
  return `${STORAGE_PREFIX}:${scope}:${conversationId}`
}

/** A draft tab's queue before its conversation exists (#650). The draft tab
 *  comes back after a reload under the same id, and so does what it queued;
 *  once the conversation is created the queue moves to its key. */
export function draftMessageQueueStorageKey(tabId: string): string {
  const remoteId = getActiveRemoteConnectionId()
  const scope = remoteId == null ? "local" : `remote-${remoteId}`
  return `${STORAGE_PREFIX}:${scope}:draft-${tabId}`
}

/** How often a window that holds a claim refreshes it. */
export const CLAIM_REFRESH_MS = 20_000
/** A claim not refreshed for this long belongs to a window that is gone.
 *  Minutes, not seconds: a hidden tab's timers may run only once a minute. */
export const CLAIM_STALE_MS = 3 * 60_000
/** How long a fresh claim must stand before it counts: two windows that
 *  claim at once both write, and only the one written last reads its own
 *  claim back after this. */
export const CLAIM_SETTLE_MS = 150
const CLAIM_SUFFIX = ":claim"

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage
  } catch {
    return null
  }
}

let pageId: string | null = null

/** Who claims for this document: the Tauri window label (one window per
 *  label, the same after a restart), else this page, for as long as it is
 *  loaded. */
function ownerId(): string {
  if (isDesktop()) return `window:${getCurrentWindowLabel()}`
  pageId ??= randomUUID()
  return `page:${pageId}`
}

/** Claims this document holds, given up when the page goes away. */
const held = new Set<string>()
let releaseOnHideArmed = false

function readClaim(
  store: Storage,
  key: string
): { owner: string; at: number } | null {
  try {
    const parsed: unknown = JSON.parse(
      store.getItem(key + CLAIM_SUFFIX) ?? "null"
    )
    if (!parsed || typeof parsed !== "object") return null
    const { owner, at } = parsed as Record<string, unknown>
    return typeof owner === "string" && typeof at === "number"
      ? { owner, at }
      : null
  } catch {
    return null
  }
}

/** Whether this window may claim `key`'s queue: no claim, a lapsed one or
 *  its own. Reads only (a render may ask). */
export function canClaimStoredQueue(key: string, now = Date.now()): boolean {
  const store = storage()
  if (!store) return true
  const claim = readClaim(store, key)
  return !claim || claim.owner === ownerId() || now - claim.at >= CLAIM_STALE_MS
}

/** Take this window's claim on `key`'s queue and confirm it after
 *  `CLAIM_SETTLE_MS`: true only if it is still this window's then. Read the
 *  stored queue only after this says true. */
export async function acquireStoredQueue(key: string): Promise<boolean> {
  if (!claimStoredQueue(key)) return false
  const store = storage()
  if (!store) return true
  await new Promise((resolve) => setTimeout(resolve, CLAIM_SETTLE_MS))
  return readClaim(store, key)?.owner === ownerId()
}

/** Take (or refresh) this window's claim on `key`'s queue. False while
 *  another window holds a live claim: this window then neither reads nor
 *  writes it. Without storage there is nothing to share, so true. */
export function claimStoredQueue(key: string, now = Date.now()): boolean {
  if (!canClaimStoredQueue(key, now)) return false
  const store = storage()
  if (!store) return true
  const me = ownerId()
  try {
    store.setItem(key + CLAIM_SUFFIX, JSON.stringify({ owner: me, at: now }))
  } catch {
    // Full storage: the claim is ours for this run, as before.
  }
  held.add(key)
  if (!releaseOnHideArmed && typeof window !== "undefined") {
    releaseOnHideArmed = true
    window.addEventListener("pagehide", () => {
      for (const k of [...held]) releaseStoredQueue(k)
    })
  }
  return true
}

/** Let `key`'s claim go if this window holds it; the queue stays stored. */
export function releaseStoredQueue(key: string): void {
  held.delete(key)
  const store = storage()
  if (!store) return
  try {
    if (readClaim(store, key)?.owner === ownerId()) {
      store.removeItem(key + CLAIM_SUFFIX)
    }
  } catch {
    // Unavailable storage: the claim lapses on its own.
  }
}

function isDraft(value: unknown): value is PromptDraft {
  if (!value || typeof value !== "object") return false
  const d = value as Record<string, unknown>
  return (
    Array.isArray(d.blocks) &&
    d.blocks.every(
      (b) =>
        b != null &&
        typeof b === "object" &&
        typeof (b as { type?: unknown }).type === "string"
    ) &&
    typeof d.displayText === "string"
  )
}

/** Read `key`'s queue back, every item failed (see the header). Anything
 *  unreadable reads as an empty queue. */
export function readStoredQueue(key: string): QueuedMessage[] {
  const store = storage()
  if (!store) return []
  let parsed: unknown
  try {
    const raw = store.getItem(key)
    if (!raw) return []
    parsed = JSON.parse(raw)
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const items: QueuedMessage[] = []
  const ids = new Set<string>()
  for (const entry of parsed.slice(0, MAX_STORED_ITEMS)) {
    if (!entry || typeof entry !== "object") continue
    const e = entry as Record<string, unknown>
    if (typeof e.id !== "string" || !e.id || ids.has(e.id)) continue
    const draft = e.draft
    if (!isDraft(draft)) continue
    const modeId =
      typeof e.modeId === "string" ? e.modeId : e.modeId === null ? null : 0
    if (modeId === 0) continue
    ids.add(e.id)
    items.push({
      id: e.id,
      draft,
      modeId,
      ...(e.adoptSendTimeMode === true ? { adoptSendTimeMode: true } : {}),
      ...(typeof e.clientMessageId === "string" && e.clientMessageId
        ? { clientMessageId: e.clientMessageId }
        : {}),
      ...(e.firstOfConversation === true ? { firstOfConversation: true } : {}),
      failed: true,
      // A refusal for credentials keeps its "sign in" link, and a message
      // whose turn failed after it went out still says so (#424): neither
      // was "not sent yet". Anything else says it was read back after a
      // reload.
      failure:
        e.failure === "auth" || e.failure === "turn_failed"
          ? e.failure
          : "restored",
    })
  }
  return items
}

// #650 第 11 次返工（收件箱 #716 的 P2）：侧栏把存着排队消息的会话排在前面，
// 存的东西一变就要重排。本窗口写的在 `writeStoredQueue` 里通知，别的窗口
// 写的靠 `storage` 事件。
let storedQueuesVer = 0
const storedQueueListeners = new Set<() => void>()
let storageEventArmed = false

function noteStoredQueuesChanged(): void {
  storedQueuesVer += 1
  for (const listener of [...storedQueueListeners]) listener()
}

/** 存着的排队消息变了就调 `listener`（给 useSyncExternalStore 用）。 */
export function subscribeStoredQueues(listener: () => void): () => void {
  storedQueueListeners.add(listener)
  if (!storageEventArmed && typeof window !== "undefined") {
    storageEventArmed = true
    window.addEventListener("storage", (e) => {
      if (e.key == null || e.key.startsWith(STORAGE_PREFIX)) {
        noteStoredQueuesChanged()
      }
    })
  }
  return () => {
    storedQueueListeners.delete(listener)
  }
}

/** 每变一次加一（给 useSyncExternalStore 当快照）。 */
export function storedQueuesVersion(): number {
  return storedQueuesVer
}

/** 当前后端上 `conversationId` 这条会话存着排队消息（没发出去的、失败的）。 */
export function hasStoredQueue(conversationId: number): boolean {
  const store = storage()
  if (!store) return false
  try {
    return store.getItem(messageQueueStorageKey(conversationId)) != null
  } catch {
    return false
  }
}

/** 草稿标签 `tabId` 的排队区存着消息（还没有会话、没发出去的，比如新工作树
 *  没建成，#833）。输入框这时已经清空，靠这个才知道草稿不是空的。 */
export function hasStoredDraftQueue(tabId: string): boolean {
  const store = storage()
  if (!store) return false
  try {
    return store.getItem(draftMessageQueueStorageKey(tabId)) != null
  } catch {
    return false
  }
}

/** 草稿标签换成新标签接着用（关掉最后一个标签时补的那个草稿）时，把排队区
 *  存的消息搬到新标签名下（#833），像输入框文字一样跟过去。新标签那份原来
 *  有的排在后面。 */
export function moveStoredDraftQueue(fromTabId: string, toTabId: string): void {
  const from = draftMessageQueueStorageKey(fromTabId)
  const to = draftMessageQueueStorageKey(toTabId)
  if (from === to) return
  const moving = readStoredQueue(from)
  if (moving.length === 0) return
  const ids = new Set(moving.map((item) => item.id))
  const kept = readStoredQueue(to).filter((item) => !ids.has(item.id))
  writeStoredQueue(to, [...moving, ...kept])
  // 新键确实存下了才清旧键（超出存储上限时旧的那份留着）
  const landed = new Set(readStoredQueue(to).map((item) => item.id))
  if (moving.every((item) => landed.has(item.id))) {
    writeStoredQueue(from, [])
    noteStoredQueueLeft(from, ids)
  }
  noteStoredQueueLanded(to)
}

// #1042：草稿关掉时没有补出来的草稿接着用（网页版标签跟着项目走、项目里
// 只剩它，或者还开着别的标签），排队区存的消息先寄存起来，这个项目下一个
// 新建或重开的草稿领走。每个关掉的草稿单独寄存一份（不合并：几个草稿的新
// 工作树选择可能不一样，合起来也可能超过排队区的上限被截掉），项目名下记
// 一张清单：寄存在哪、原来的工作目录和新工作树选择。消息就留在关掉的草稿
// 自己的键下，不另外复制一份（第 2 次返工：存储满了复制不成功，消息就会
// 落在清单里没有的键下，再也领不到）。

function parkListKey(folderId: number): string {
  return `${draftMessageQueueStorageKey(`closed-folder-${folderId}`)}:parks`
}

/** 寄存时跟着消息一起记下的草稿设置。 */
export interface ParkedDraftHandoff {
  workingDir?: string
  /** 原草稿的新工作树选择（形状由调用方检查）。 */
  pendingWorktree?: unknown
}

interface ParkEntry extends ParkedDraftHandoff {
  /** 消息存在哪个「标签号」名下（关掉的草稿自己的标签号）。 */
  tabId: string
}

function readParkList(store: Storage, folderId: number): ParkEntry[] {
  try {
    const parsed: unknown = JSON.parse(
      store.getItem(parkListKey(folderId)) ?? "null"
    )
    if (!Array.isArray(parsed)) return []
    const out: ParkEntry[] = []
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue
      const e = entry as Record<string, unknown>
      if (typeof e.tabId !== "string" || !e.tabId) continue
      out.push({
        tabId: e.tabId,
        ...(typeof e.workingDir === "string"
          ? { workingDir: e.workingDir }
          : {}),
        ...(e.pendingWorktree != null
          ? { pendingWorktree: e.pendingWorktree }
          : {}),
      })
    }
    return out
  } catch {
    return []
  }
}

function writeParkList(
  store: Storage,
  folderId: number,
  list: ParkEntry[]
): void {
  try {
    if (list.length === 0) store.removeItem(parkListKey(folderId))
    else store.setItem(parkListKey(folderId), JSON.stringify(list))
  } catch {
    // 存储不可用：清单还是旧的那份。
  }
}

/** 把关掉的草稿 `fromTabId` 排队区存的消息寄存到项目 `folderId` 名下，
 *  单独一份，连同它自己的设置。返回清单里是不是确实记下了这一份（#1191：
 *  存储满了清单写不进去时，调用方要知道消息领不回来）。 */
export function parkStoredDraftQueue(
  fromTabId: string,
  folderId: number,
  handoff: ParkedDraftHandoff
): boolean {
  if (!hasStoredDraftQueue(fromTabId)) return false
  const store = storage()
  if (!store) return false
  const list = readParkList(store, folderId).filter(
    (e) => e.tabId !== fromTabId
  )
  writeParkList(store, folderId, [...list, { ...handoff, tabId: fromTabId }])
  return readParkList(store, folderId).some((e) => e.tabId === fromTabId)
}

/** 项目 `folderId` 寄存着关掉的草稿的消息时，把最后关掉、`accept` 认可的
 *  那一份搬给草稿 `toTabId`，返回它的设置；没有可领的返回 null。一次只领
 *  一份，领过的就没了，别的留给之后的草稿。 */
export function claimParkedDraftQueue(
  folderId: number,
  toTabId: string,
  accept: (handoff: ParkedDraftHandoff) => boolean = () => true
): ParkedDraftHandoff | null {
  const store = storage()
  if (!store) return null
  const before = readParkList(store, folderId)
  if (before.length === 0) return null
  // 消息已经没了的（别处清掉了）顺手从清单里去掉
  const list = before.filter((e) => hasStoredDraftQueue(e.tabId))
  let claimed: ParkEntry | null = null
  for (let i = list.length - 1; i >= 0; i--) {
    if (!accept(list[i])) continue
    claimed = list[i]
    moveStoredDraftQueue(claimed.tabId, toTabId)
    // 没搬完（存不下）就留在清单里，下次还能领。
    if (!hasStoredDraftQueue(claimed.tabId)) list.splice(i, 1)
    break
  }
  if (list.length !== before.length || claimed) {
    writeParkList(store, folderId, list)
  }
  if (!claimed) return null
  return {
    ...(claimed.workingDir != null ? { workingDir: claimed.workingDir } : {}),
    ...(claimed.pendingWorktree != null
      ? { pendingWorktree: claimed.pendingWorktree }
      : {}),
  }
}

// #1042 返工：搬进来的草稿排队区可能正挂在界面上（「新建会话」复用了已有
// 的草稿），那边的排队区只在挂载时读一次存储，搬完要通知它读进来，不然看
// 不到，它下次改队列还会用内存里的那份把搬来的覆盖掉。
const landedListeners = new Map<string, Set<() => void>>()

/** 有别处把排队消息搬到 `key` 下（`moveStoredDraftQueue`）时调 `listener`。 */
export function subscribeStoredQueueLanded(
  key: string,
  listener: () => void
): () => void {
  let set = landedListeners.get(key)
  if (!set) {
    set = new Set()
    landedListeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = landedListeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) landedListeners.delete(key)
  }
}

function noteStoredQueueLanded(key: string): void {
  for (const listener of [...(landedListeners.get(key) ?? [])]) listener()
}

// #1191 返工：反过来，挂着的排队区的消息被搬走了（草稿翻成聊天草稿，消息
// 寄存到项目名下），那边要放下这几条，不然还显示着，下次改队列又写回来。
const leftListeners = new Map<string, Set<(ids: Set<string>) => void>>()

/** 有别处把 `key` 下的排队消息搬走（`moveStoredDraftQueue`）时调 `listener`，
 *  带上搬走的那几条的 id。 */
export function subscribeStoredQueueLeft(
  key: string,
  listener: (ids: Set<string>) => void
): () => void {
  let set = leftListeners.get(key)
  if (!set) {
    set = new Set()
    leftListeners.set(key, set)
  }
  set.add(listener)
  return () => {
    const current = leftListeners.get(key)
    if (!current) return
    current.delete(listener)
    if (current.size === 0) leftListeners.delete(key)
  }
}

function noteStoredQueueLeft(key: string, ids: Set<string>): void {
  for (const listener of [...(leftListeners.get(key) ?? [])]) listener(ids)
}

// #1191 第 3 次返工：排队区的消息不一定存得进存储（太大超过上限、存储满了），
// 这时存储里看不到它，「新建会话」和 Ctrl+T 还以为排队区是空的。挂着的排队区
// 在这里登记一个读当前内存里消息 id 的函数，按 key 查得到。
// 第 4 次返工：登记的是整条消息，不只是 id：改过的消息存不进去时，存储里
// 还是同一个 id 的旧版本，要比内容才看得出没存好。
const liveQueueReaders = new Map<string, Set<() => readonly QueuedMessage[]>>()

/** 挂着的排队区登记 `key` 下内存里的消息（`read` 每次调都读当前的）。 */
export function registerLiveQueue(
  key: string,
  read: () => readonly QueuedMessage[]
): () => void {
  let set = liveQueueReaders.get(key)
  if (!set) {
    set = new Set()
    liveQueueReaders.set(key, set)
  }
  set.add(read)
  return () => {
    const current = liveQueueReaders.get(key)
    if (!current) return
    current.delete(read)
    if (current.size === 0) liveQueueReaders.delete(key)
  }
}

/** 草稿标签 `tabId` 挂着的排队区内存里的消息 id（存没存进存储都算）。 */
export function liveDraftQueueIds(tabId: string): Set<string> {
  const ids = new Set<string>()
  const key = draftMessageQueueStorageKey(tabId)
  for (const read of liveQueueReaders.get(key) ?? []) {
    for (const item of read()) ids.add(item.id)
  }
  return ids
}

/** 草稿标签 `tabId` 的排队区有消息：存储里存着，或者挂着的排队区内存里有。 */
export function draftQueueHoldsMessages(tabId: string): boolean {
  return hasStoredDraftQueue(tabId) || liveDraftQueueIds(tabId).size > 0
}

/** 寄存时要原样带走的内容（发送失败的原因读回来会变成 "restored"，不算）。 */
function storedContent(item: QueuedMessage): string {
  return JSON.stringify([
    item.draft,
    item.modeId,
    item.adoptSendTimeMode === true,
    item.clientMessageId || null,
    item.firstOfConversation === true,
  ])
}

/** 草稿标签 `tabId` 挂着的排队区内存里的消息都原样存进了存储（没挂着的
 *  算是）：同一个 id 在存储里的内容也要和内存里的一样，改过没存进去的不算。 */
export function draftQueueFullyStored(tabId: string): boolean {
  const key = draftMessageQueueStorageKey(tabId)
  const readers = liveQueueReaders.get(key)
  if (!readers || readers.size === 0) return true
  const stored = new Map(
    readStoredQueue(key).map((item) => [item.id, storedContent(item)])
  )
  for (const read of readers) {
    for (const item of read()) {
      if (stored.get(item.id) !== storedContent(item)) return false
    }
  }
  return true
}

/** Mirror `queue` into `key`; an empty queue removes the entry. Never
 *  throws: storage full or unavailable only loses the restart copy. Only the
 *  window holding the claim (`claimStoredQueue`) calls this. */
export function writeStoredQueue(key: string, queue: QueuedMessage[]): void {
  const store = storage()
  if (!store) return
  try {
    writeStoredQueueTo(store, key, queue)
  } finally {
    noteStoredQueuesChanged()
  }
}

function writeStoredQueueTo(
  store: Storage,
  key: string,
  queue: QueuedMessage[]
): void {
  try {
    if (queue.length === 0) {
      store.removeItem(key)
      return
    }
    const kept: string[] = []
    let size = 2
    for (const item of queue.slice(0, MAX_STORED_ITEMS)) {
      const json = JSON.stringify({
        id: item.id,
        draft: item.draft,
        modeId: item.modeId,
        ...(item.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
        ...(item.clientMessageId
          ? { clientMessageId: item.clientMessageId }
          : {}),
        ...(item.firstOfConversation ? { firstOfConversation: true } : {}),
        ...(item.failure ? { failure: item.failure } : {}),
      })
      // In order: a later item never takes the place of an earlier one.
      if (size + json.length + 1 > MAX_STORED_CHARS) break
      kept.push(json)
      size += json.length + 1
    }
    if (kept.length === 0) {
      store.removeItem(key)
      return
    }
    store.setItem(key, `[${kept.join(",")}]`)
  } catch {
    // Quota or a disabled storage: the queue still works until a restart.
  }
}
