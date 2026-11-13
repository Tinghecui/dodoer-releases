// The send queue across a page reload (AI QA #159).
//
// jenny's queue (`use-message-queue.ts`) lives in React state only, so a
// reload dropped every message still waiting in it, and the retry button of a
// failed one with them. It is now mirrored into sessionStorage per saved
// conversation, and read back when the conversation's view mounts.
//
// What comes back is ALWAYS failed — retry or delete, never sent on its own:
// a reload can land at any moment, and sending what was read back could send
// a message twice. sessionStorage, not localStorage: it survives a reload of
// this tab and nothing else, so a second window on the same conversation
// never shows (and offers to re-send) the first window's queue.

import { getActiveRemoteConnectionId } from "@/lib/transport"
import type { PromptDraft } from "@/lib/types"
import type { QueuedMessage } from "@/hooks/use-message-queue"

const STORAGE_PREFIX = "cowork:message-queue:v1"
/** Per conversation. Enough for any real queue; a pathological one keeps
 *  its first items. */
export const MAX_STORED_ITEMS = 50
/** Per conversation, in UTF-16 code units of the JSON (sessionStorage has a
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

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage
  } catch {
    return null
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
      // A refusal for credentials keeps its "sign in" link; anything else
      // says it was read back after a reload.
      failure: e.failure === "auth" ? "auth" : "restored",
    })
  }
  return items
}

/** Mirror `queue` into `key`; an empty queue removes the entry. Never
 *  throws: storage full or unavailable only loses the reload copy. */
export function writeStoredQueue(key: string, queue: QueuedMessage[]): void {
  const store = storage()
  if (!store) return
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
    // Quota or a disabled storage: the queue still works until a reload.
  }
}
