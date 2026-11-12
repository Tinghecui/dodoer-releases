"use client"

import { useCallback, useRef, useState } from "react"
import type { PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"

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
   * Only ever set together with `failed`; retry clears both.
   */
  failure?: QueueFailureKind
}

export type QueueFailureKind = "auth"

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

export function useMessageQueue(): UseMessageQueueReturn {
  const [queue, setQueue] = useState<QueuedMessage[]>([])
  const [editingItemId, setEditingItemId] = useState<string | null>(null)
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
    [commit, editingItemId]
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
    [commit]
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

  const startEditing = useCallback((id: string) => {
    setEditingItemId(id)
  }, [])

  const cancelEditing = useCallback(() => {
    setEditingItemId(null)
  }, [])

  return {
    queue,
    enqueue,
    requeueFront,
    requeueFailed,
    failHead,
    retry,
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
