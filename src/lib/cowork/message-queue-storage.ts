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
