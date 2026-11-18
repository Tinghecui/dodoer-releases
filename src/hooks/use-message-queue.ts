"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import {
  CLAIM_REFRESH_MS,
  acquireStoredQueue,
  claimStoredQueue,
  readStoredQueue,
  releaseStoredQueue,
  writeStoredQueue,
} from "@/lib/cowork/message-queue-storage"

export { messageQueueStorageKey } from "@/lib/cowork/message-queue-storage"

export interface QueuedMessage {
  id: string
  draft: PromptDraft
  /**
   * The mode this message will be sent under. `null` means "leave the agent's
   * mode alone" — an explicit choice for the answer / plan-notes retry paths,
   * which must not switch mode on their way out.
   *
   * That is why {@link QueuedMessage.adoptSendTimeMode} exists as a separate
   * flag rather than being spelled `modeId === null`: "unknown yet" and
   * "deliberately none" are different intents.
   */
  modeId: string | null
  /**
   * Resolve the mode when this message actually SENDS, ignoring `modeId`.
   *
   * For messages queued before their tab could know its modes — a prompt parked
   * on a brand-new draft by "ask about this selection", which is enqueued while
   * the connection is still coming up. Without it the agent would run in
   * whatever mode it happened to start in while the composer above displayed the
   * user's saved mode.
   */
  adoptSendTimeMode?: boolean
  /**
   * jenny fork: it went out and the send failed (network drop, 413, a failed
   * create). It stays at the head, visible, with a retry button, and holds
   * the items behind it so they do not overtake it. Retry clears the flag.
   */
  failed?: boolean
  /**
   * Cowork fork: what kind of failure it was, when the panel knows and the
   * queue's hint has something to offer for it. `auth` — the agent refused
   * the turn for credentials, so the hint links to where the agent signs in.
   * `restored` — read back after a page reload or an app restart
   * (`message-queue-storage.ts`):
   * it may or may not have been about to go, so it waits for the user.
   * `turn_failed` — it went out, but the turn failed before the agent
   * answered anything (#424): retrying sends it again.
   * Only ever set together with `failed`; retry clears both.
   */
  failure?: QueueFailureKind
}

export type QueueFailureKind = "auth" | "restored" | "turn_failed"

export interface UseMessageQueueReturn {
  queue: QueuedMessage[]
  enqueue: (
    draft: PromptDraft,
    modeId: string | null,
    opts?: { adoptSendTimeMode?: boolean }
  ) => void
  /**
   * Put a draft back at the FRONT of the queue. Used when an auto-flushed item
   * was dequeued, sent, and bounced (TurnBusyError): it must return to the head
   * so it retries before items that were already behind it (FIFO preserved).
   */
  requeueFront: (draft: PromptDraft, modeId: string | null) => void
  /** Put a draft whose send failed back at the FRONT, flagged `failed`. */
  requeueFailed: (
    draft: PromptDraft,
    modeId: string | null,
    failure?: QueueFailureKind
  ) => void
  /**
   * Cowork fork: flag the item at the head `failed` where it stands (same id,
   * same place). For a message that never went out and, as things are, never
   * will — no usable agent, or the worktree it was to start in could not be
   * created — so it shows the retry / delete row instead of waiting forever.
   * Does nothing on an empty queue or a head that is already failed.
   */
  failHead: (failure?: QueueFailureKind) => void
  /** Clear an item's `failed` flag so the auto-flush sends it again. */
  retry: (id: string) => void
  /**
   * Cowork fork: clear `failed` / `failure` on every failed item except the
   * one under edit, in one commit, keeping order and ids. The auto-flush then
   * sends them one per turn in queue order. Returns how many it cleared — a
   * second call in the same tick finds none and changes nothing.
   */
  retryAll: () => number
  /** Returns nothing while the head is a failed item: it waits for retry. */
  dequeue: () => QueuedMessage | undefined
  remove: (id: string) => void
  reorder: (items: QueuedMessage[]) => void
  /** Prioritize a still-queued item using its latest draft and mode. */
  moveToFront: (id: string) => void
  updateItem: (id: string, draft: PromptDraft) => void
  /**
   * The queue length, read SYNCHRONOUSLY from the authoritative ref — it
   * reflects the same-tick result of an enqueue/requeue/dequeue, before React
   * commits the next render. Callers gating on "is the queue non-empty right
   * now" — the direct-send routing — must use this rather than `queue.length`
   * (which lags a render).
   */
  getQueueLength: () => number
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

/**
 * `storageKey` (Cowork fork, #159): keep the queue across a page reload and an
 * app restart under this key (`messageQueueStorageKey`); null / omitted keeps
 * it in memory only. The queue read back at mount is all failed — see
 * `message-queue-storage.ts`. Only the window that claims the key reads and
 * writes it (dodoer #416); another window's queue stays in memory.
 */
export function useMessageQueue(
  storageKey?: string | null
): UseMessageQueueReturn {
  // What `storageKey` stored is read once its claim is confirmed (below).
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemIdState] = useState<string | null>(null)
  // Cowork fork: same-tick copy of `editingItemId` for `retryAll`, which must
  // skip the item under edit even before React commits the new id.
  const editingItemIdRef = useRef<string | null>(null)
  const setEditingItemId = useCallback((id: string | null) => {
    editingItemIdRef.current = id
    setEditingItemIdState(id)
  }, [])
  // Authoritative copy of the queue, updated SYNCHRONOUSLY by every mutation
  // (before the React state commit). Reads that must observe the same-tick
  // result of a mutation — the direct-send queue routing — go through this
  // ref / `getQueueLength`, NOT the `queue` state (which lags until React
  // commits) and NOT a passive-effect-synced mirror (which lags a full
  // render). Without this, a bounce that re-queues a draft leaves a window
  // where a caller still sees an empty queue.
  const queueRef = useRef<QueuedMessage[]>(queue)

  // Update the authoritative ref first, then schedule the render. A plain value
  // (not a functional updater) is correct because `queueRef.current` is always
  // the latest committed value.
  const commit = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    setQueue(next)
  }, [])

  // Hold the claim on `storageKey` while mounted (refreshed so it does not
  // lapse), and let it go on unmount (dodoer #416). Once the first claim of
  // this mount is confirmed, what is stored there comes back in front of what
  // was queued meanwhile. A key held by another window stays theirs for this
  // mount. Losing the claim later stops the mirror and drops the copies read
  // back and not yet retried — they are the other window's now.
  const ownedKeyRef = useRef<string | null>(null)
  const restoredIdsRef = useRef<Set<string>>(new Set())
  const readBackRef = useRef(true)
  const loseClaim = useCallback(() => {
    ownedKeyRef.current = null
    const restoredIds = restoredIdsRef.current
    restoredIdsRef.current = new Set()
    // A read-back item still failed was never retried here (retry clears
    // `failed`); whatever its failure kind, the other window owns it now.
    const kept = queueRef.current.filter(
      (item) => !(restoredIds.has(item.id) && item.failed)
    )
    if (kept.length !== queueRef.current.length) commit(kept)
  }, [commit])
  useEffect(() => {
    ownedKeyRef.current = null
    if (!storageKey) return
    let cancelled = false
    let refresh: ReturnType<typeof setInterval> | undefined
    void acquireStoredQueue(storageKey).then((owned) => {
      if (cancelled || !owned) return
      ownedKeyRef.current = storageKey
      const live = new Set(queueRef.current.map((item) => item.id))
      const back = readBackRef.current
        ? readStoredQueue(storageKey).filter((item) => !live.has(item.id))
        : []
      readBackRef.current = false
      restoredIdsRef.current = new Set(back.map((item) => item.id))
      if (back.length > 0) commit([...back, ...queueRef.current])
      else writeStoredQueue(storageKey, queueRef.current)
      refresh = setInterval(() => {
        if (!claimStoredQueue(storageKey)) loseClaim()
      }, CLAIM_REFRESH_MS)
    })
    return () => {
      cancelled = true
      clearInterval(refresh)
      ownedKeyRef.current = null
      releaseStoredQueue(storageKey)
    }
  }, [storageKey, commit, loseClaim])

  // Mirror every committed queue while the claim is ours (the key arriving
  // later — a draft that just got saved — writes what is queued once it is
  // claimed).
  useEffect(() => {
    if (!storageKey || ownedKeyRef.current !== storageKey) return
    if (claimStoredQueue(storageKey)) writeStoredQueue(storageKey, queue)
    else loseClaim()
  }, [storageKey, queue, loseClaim])

  const enqueue = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      opts?: { adoptSendTimeMode?: boolean }
    ) => {
      commit([
        ...queueRef.current,
        {
          id: randomUUID(),
          draft,
          modeId,
          ...(opts?.adoptSendTimeMode ? { adoptSendTimeMode: true } : {}),
        },
      ])
    },
    [commit]
  )

  const requeueFront = useCallback(
    (draft: PromptDraft, modeId: string | null) => {
      commit([{ id: randomUUID(), draft, modeId }, ...queueRef.current])
    },
    [commit]
  )

  const requeueFailed = useCallback(
    (draft: PromptDraft, modeId: string | null, failure?: QueueFailureKind) => {
      commit([
        {
          id: randomUUID(),
          draft,
          modeId,
          failed: true,
          ...(failure ? { failure } : {}),
        },
        ...queueRef.current,
      ])
    },
    [commit]
  )

  const failHead = useCallback(
    (failure?: QueueFailureKind) => {
      const current = queueRef.current
      if (current.length === 0 || current[0].failed) return
      commit([
        { ...current[0], failed: true, ...(failure ? { failure } : {}) },
        ...current.slice(1),
      ])
    },
    [commit]
  )

  const retry = useCallback(
    (id: string) => {
      commit(
        queueRef.current.map((item) =>
          item.id === id ? { ...item, failed: false, failure: undefined } : item
        )
      )
    },
    [commit]
  )

  const retryAll = useCallback((): number => {
    // Read the ref, not the state: a second click in the same tick (or an
    // auto-flush dequeue between them) must see this call's result.
    const editing = editingItemIdRef.current
    let cleared = 0
    const next = queueRef.current.map((item) => {
      if (!item.failed || item.id === editing) return item
      cleared += 1
      return { ...item, failed: false, failure: undefined }
    })
    if (cleared > 0) commit(next)
    return cleared
  }, [commit])

  const dequeue = useCallback((): QueuedMessage | undefined => {
    const current = queueRef.current
    if (current.length === 0 || current[0].failed) return undefined
    commit(current.slice(1))
    return current[0]
  }, [commit])

  const remove = useCallback(
    (id: string) => {
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      commit(queueRef.current.filter((item) => item.id !== id))
    },
    [commit, editingItemId, setEditingItemId]
  )

  const reorder = useCallback(
    (items: QueuedMessage[]) => {
      // Apply a reorder ONLY if it is a true permutation of the live queue, and
      // rebuild it from the AUTHORITATIVE items rather than the caller's
      // (possibly stale) objects. A drag emission carries the queue order from
      // the render it began in; if the live queue changed since (dequeue /
      // requeue / remove / updateItem), the dragged array is stale. Reject any
      // length mismatch, unknown id, or repeated id (e.g. `[A, A]` would
      // otherwise drop `B` and duplicate `A`); commit the current item objects
      // in the requested order so a concurrent `updateItem` isn't clobbered.
      const current = queueRef.current
      if (items.length !== current.length) return
      const byId = new Map(current.map((item) => [item.id, item]))
      const seen = new Set<string>()
      const next: QueuedMessage[] = []
      for (const item of items) {
        const authoritative = byId.get(item.id)
        if (!authoritative || seen.has(item.id)) return
        seen.add(item.id)
        next.push(authoritative)
      }
      commit(next)
    },
    [commit]
  )

  const updateItem = useCallback(
    (id: string, draft: PromptDraft) => {
      commit(
        queueRef.current.map((item) =>
          item.id === id ? { ...item, draft } : item
        )
      )
      setEditingItemId(null)
    },
    [commit, setEditingItemId]
  )

  const moveToFront = useCallback(
    (id: string) => {
      const current = queueRef.current
      const index = current.findIndex((item) => item.id === id)
      if (index <= 0) return
      commit([current[index], ...current.filter((item) => item.id !== id)])
    },
    [commit]
  )

  const getQueueLength = useCallback(() => queueRef.current.length, [])

  const startEditing = useCallback(
    (id: string) => {
      setEditingItemId(id)
    },
    [setEditingItemId]
  )

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [setEditingItemId])

  return {
    queue,
    enqueue,
    requeueFront,
    requeueFailed,
    failHead,
    retry,
    retryAll,
    dequeue,
    remove,
    reorder,
    moveToFront,
    updateItem,
    getQueueLength,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
