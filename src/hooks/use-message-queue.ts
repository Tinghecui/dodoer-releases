"use client"

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import type { MessageTurn, PromptDraft } from "@/lib/types"
import { randomUUID } from "@/lib/utils"
import {
  CLAIM_REFRESH_MS,
  acquireStoredQueue,
  canClaimStoredQueue,
  claimStoredQueue,
  readStoredQueue,
  registerLiveQueue,
  releaseStoredQueue,
  subscribeStoredQueueLanded,
  subscribeStoredQueueLeft,
  writeStoredQueue,
} from "@/lib/cowork/message-queue-storage"

export {
  draftMessageQueueStorageKey,
  messageQueueStorageKey,
} from "@/lib/cowork/message-queue-storage"

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
  /**
   * #970：这条发出去时带的 clientMessageId（乐观用户轮次的 id）。后端把它
   * 当成这条用户消息的 message_id 广播、放进会话快照。发送途中退出、重开后
   * 读回成 `restored` 的这条，只要在会话里看到同一个 id，就是已经送到了，
   * 用 `dropDelivered` 拿掉，不再挂「发送失败」。
   */
  clientMessageId?: string
  /**
   * #970 返工：发这条时会话里还一条消息都没有（新会话的第一条）。这一轮在
   * 重开前就回完了的话，快照里没有进行中的用户消息，历史里的用户轮次 id 也
   * 换回了解析器的 `turn-N`，按 id 对不上；这时只要历史从头加载、第一条用户
   * 消息就是这条的文字，它就是这次发出去的那条（会话是这次发送建的，第一条
   * 不会是别的），见 `dropDelivered`。
   */
  firstOfConversation?: boolean
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
  /**
   * Put a draft whose send failed back at the FRONT, flagged `failed`.
   * Returns the new item's id (Cowork fork #984: the panel takes it back out
   * once the server turns out to have received the message after all).
   */
  requeueFailed: (
    draft: PromptDraft,
    modeId: string | null,
    failure?: QueueFailureKind
  ) => string
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
  /**
   * Returns nothing while the head is a failed item: it waits for retry.
   * #650 第 10 次返工：出队的那条从排队区拿掉，但存储里还留着（「在路上」），
   * 直到调用方 `settle(id)`：后端收下了、或者已经按别的 id 放回排队区。
   * 发送途中刷新，刷新回来它读回成失败、带重试，不会丢。
   */
  dequeue: () => QueuedMessage | undefined
  /** #650：`dequeue` 出去的那条有了着落，从存储里拿掉。别的 id 不做事。 */
  settle: (id: string) => void
  /**
   * #650 第 12 次返工：不进排队区、直接发出去的这条，当场按「在路上」存下
   * （和 `dequeue` 出去的那条一样），返回它的 id，有了着落以后 `settle(id)`。
   * 新会话回车直接发、建会话途中刷新，刷新回来读回成失败、带重试。
   */
  hold: (
    draft: PromptDraft,
    modeId: string | null,
    clientMessageId?: string,
    firstOfConversation?: boolean
  ) => string
  /**
   * #970：`dequeue` / `hold` 出去、还没有着落的那条，记下这次发送带的
   * clientMessageId（当场写进存储）。不是在路上的 id 不做事。
   */
  stampInFlight: (
    id: string,
    clientMessageId: string,
    firstOfConversation?: boolean
  ) => void
  /**
   * #970：读回成 `restored` 的条目里，clientMessageId 在 `delivered` 里的
   * （会话里已经有这条用户消息了）拿掉。按 id 对，不按文字对；唯一的例外是
   * 新会话的第一条（`firstOfConversation`）：`firstUserText`（从头加载的历史
   * 里第一条用户消息的文字，见 `firstUserTurnText`）和它的文字一样也拿掉。
   */
  dropDelivered: (
    delivered: ReadonlySet<string>,
    firstUserText?: string | null
  ) => void
  remove: (id: string) => void
  /**
   * Cowork fork (#984 第 1 次返工): remove `id` only if it still holds this
   * exact `draft` (the user has not saved an edit over it) and is not open in
   * the editor. Returns whether it removed it. For a failed copy that the
   * server turns out to have received after all: a copy the user changed is
   * their own message now and stays.
   */
  removeIfUnchanged: (id: string, draft: PromptDraft) => boolean
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
  /**
   * #650 第 9 次返工：当场把排队区（内存里的和 `storageKey` 存着、还没读回的）
   * 挪到 `key` 下，之后改队列都写 `key`，不等调用方下一次渲染换 key。草稿
   * 标签绑上会话时用：刷新回来的标签 id 按会话号重新生成，按标签读不回。
   * 别的窗口占着 `key` 的不挪。
   */
  moveStorageTo: (key: string) => void
  editingItemId: string | null
  startEditing: (id: string) => void
  cancelEditing: () => void
}

/**
 * #970：会话里已经有的用户消息 id：快照里进行中那条（`pendingUserMessage`）
 * 和详情里的用户轮次（进行中那轮的用户轮次被后端标成发送时的
 * clientMessageId）。给 `dropDelivered` 用。
 */
export function deliveredClientMessageIds(
  pendingUserMessageId: string | null | undefined,
  turns: readonly MessageTurn[] | null | undefined
): ReadonlySet<string> {
  const ids = new Set<string>()
  if (pendingUserMessageId) ids.add(pendingUserMessageId)
  for (const turn of turns ?? []) {
    if (turn.role === "user" && turn.id) ids.add(turn.id)
  }
  return ids
}

/**
 * #970 返工：历史从头加载（`turnsOffset` 为 0）时第一条用户消息的文字（文字
 * 块拼起来、去掉首尾空白）；历史只加载了尾部、没有用户消息或没有文字的给
 * null。给 `dropDelivered` 认新会话的第一条用。还有用户消息在路上
 * （`pendingUserMessageId` 不为空，智能体还在回）时也给 null：这时只按发送的
 * id 认，id 对不上就留着，不拿文字猜。
 */
export function firstUserTurnText(
  turns: readonly MessageTurn[] | null | undefined,
  turnsOffset: number | null | undefined,
  pendingUserMessageId?: string | null
): string | null {
  if (pendingUserMessageId) return null
  if (!turns || (turnsOffset ?? 0) !== 0) return null
  const first = turns.find((turn) => turn.role === "user")
  if (!first) return null
  const text = first.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
  return text || null
}

/** #970 返工：草稿的文字，和 `firstUserTurnText` 同样拼法。 */
function draftTexts(draft: PromptDraft): string[] {
  const joined = draft.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
  return [joined, draft.displayText.trim()].filter((text) => text !== "")
}

/**
 * 把 `queue` 写进 `key` 的存储。返回 false 表示认领是这个窗口的、但已经被
 * 别的窗口拿走了（调用方 loseClaim）。
 * #650 第 7 次返工：认领还没确认（挂载或换 key 后 150 毫秒内），这时排进来
 * 的消息也要马上落进存储，不然按回车后、会话刚建好时刷新就丢了。别的
 * 窗口占着的不写；存着、还没读回来的那些原样留在前面，确认后照常读回。
 * 这期间写进去、后来又出了队（发出去、删了）的，要从存储里拿掉，不然
 * 确认后会被当成刷新前没发的读回来。
 */
function persistQueue(
  key: string | null,
  queue: QueuedMessage[],
  ownedKey: string | null,
  earlyWrittenRef: { current: { key: string | null; ids: Set<string> } }
): boolean {
  if (!key) return true
  if (ownedKey !== key) {
    const early = earlyWrittenRef.current
    const mine = early.key === key ? early.ids : new Set<string>()
    if (queue.length === 0 && mine.size === 0) return true
    if (!canClaimStoredQueue(key)) return true
    const ids = new Set(queue.map((item) => item.id))
    const stored = readStoredQueue(key).filter(
      (item) => !ids.has(item.id) && !mine.has(item.id)
    )
    writeStoredQueue(key, [...stored, ...queue])
    earlyWrittenRef.current = { key, ids }
    return true
  }
  if (!claimStoredQueue(key)) return false
  writeStoredQueue(key, queue)
  return true
}

/**
 * `storageKey` (Cowork fork, #159): keep the queue across a page reload and an
 * app restart under this key (`messageQueueStorageKey`); null / omitted keeps
 * it in memory only. The queue read back at mount is all failed — see
 * `message-queue-storage.ts`. Only the window that claims the key reads and
 * writes it (dodoer #416); another window's queue stays in memory.
 */
export function useMessageQueue(
  storageKey?: string | null,
  opts?: {
    /**
     * #650 第 8 次返工：第一次读回时也读这个 key 存的那份，读完清掉（草稿
     * 标签的那份：标签刚绑上会话、排队区还没挪过去就刷新，刷新回来按会话号读）。
     */
    alsoReadKey?: string | null
  }
): UseMessageQueueReturn {
  const alsoReadKey = opts?.alsoReadKey ?? null
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
  // #650 第 10 次返工：出了队、还没有着落的（见 `dequeue` / `settle`）。不在
  // 排队区里显示，但跟着排队区一起存，排在前面。
  const inFlightRef = useRef<QueuedMessage[]>([])

  // Update the authoritative ref first, then schedule the render. A plain value
  // (not a functional updater) is correct because `queueRef.current` is always
  // the latest committed value.
  // #650 第 8 次返工：每次改队列当场写存储（见 `persistQueue`），不等渲染后的
  // effect：按回车到 effect 跑之间刷新也不丢。key 跟着渲染在 layout effect 里更新。
  const storageKeyRef = useRef<string | null>(storageKey ?? null)
  useLayoutEffect(() => {
    storageKeyRef.current = storageKey ?? null
  }, [storageKey])
  const ownedKeyRef = useRef<string | null>(null)
  // #650：认领确认前写进存储的条目（见 `persistQueue`）。
  const earlyWrittenRef = useRef<{ key: string | null; ids: Set<string> }>({
    key: null,
    ids: new Set(),
  })
  const commit = useCallback((next: QueuedMessage[]) => {
    queueRef.current = next
    // 认领丢了的情况留给下面的 effect 处理（它会 loseClaim）
    persistQueue(
      storageKeyRef.current,
      [...inFlightRef.current, ...next],
      ownedKeyRef.current,
      earlyWrittenRef
    )
    setQueue(next)
  }, [])

  // Hold the claim on `storageKey` while mounted (refreshed so it does not
  // lapse), and let it go on unmount (dodoer #416). Once the first claim of
  // this mount is confirmed, what is stored there comes back in front of what
  // was queued meanwhile. A key held by another window stays theirs for this
  // mount. Losing the claim later stops the mirror and drops the copies read
  // back and not yet retried — they are the other window's now.
  const restoredIdsRef = useRef<Set<string>>(new Set())
  const readBackRef = useRef(true)
  // #650：上一个认领到的 key。key 换了（草稿按标签存的那份换成按会话号存）、
  // 新 key 认领到以后，清掉旧 key 那份，不然刷新回来旧的那份还会被读出来。
  // 卸载时不清（刷新要靠它读回）。
  const lastOwnedKeyRef = useRef<string | null>(null)
  // #650：这次挂载第一个 key。刷新回来的草稿标签可能在认领确认之前就绑上了
  // 找回的会话，第一次读回时这个 key 存的那份也要一起读进来。
  const firstKeyRef = useRef<string | null>(null)
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
    firstKeyRef.current ??= storageKey
    let cancelled = false
    let refresh: ReturnType<typeof setInterval> | undefined
    void acquireStoredQueue(storageKey).then((owned) => {
      // 第 9 次返工：已经挪到别的 key 下（moveStorageTo），这个 key 不再读写
      if (cancelled || !owned || storageKeyRef.current !== storageKey) return
      ownedKeyRef.current = storageKey
      const first = firstKeyRef.current
      const extra = [first, alsoReadKey].filter(
        (key, i, all): key is string =>
          !!key &&
          key !== storageKey &&
          all.indexOf(key) === i &&
          canClaimStoredQueue(key)
      )
      const sources = readBackRef.current ? [...extra, storageKey] : []
      const seen = new Set(
        [...inFlightRef.current, ...queueRef.current].map((item) => item.id)
      )
      const back: QueuedMessage[] = []
      for (const key of sources) {
        for (const item of readStoredQueue(key)) {
          if (seen.has(item.id)) continue
          seen.add(item.id)
          back.push(item)
        }
      }
      readBackRef.current = false
      restoredIdsRef.current = new Set(back.map((item) => item.id))
      if (back.length > 0) commit([...back, ...queueRef.current])
      else
        writeStoredQueue(storageKey, [
          ...inFlightRef.current,
          ...queueRef.current,
        ])
      const stale = new Set([lastOwnedKeyRef.current, ...sources])
      lastOwnedKeyRef.current = storageKey
      for (const key of stale) {
        if (key && key !== storageKey) writeStoredQueue(key, [])
      }
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
    // alsoReadKey 只在第一次读回时用，变了不重新认领
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey, commit, loseClaim])

  // #1042 返工：挂着的时候别处把排队消息搬到这个 key 下（「新建会话」复用
  // 了这个草稿、领回关掉的草稿寄存的消息），当场读进来排在前面，算读回的。
  // 还没认领到的不用管：认领确认后第一次读回会读到。
  useEffect(() => {
    if (!storageKey) return
    return subscribeStoredQueueLanded(storageKey, () => {
      if (
        ownedKeyRef.current !== storageKey ||
        storageKeyRef.current !== storageKey
      )
        return
      const seen = new Set(
        [...inFlightRef.current, ...queueRef.current].map((item) => item.id)
      )
      const landed = readStoredQueue(storageKey).filter(
        (item) => !seen.has(item.id)
      )
      if (landed.length === 0) return
      for (const item of landed) restoredIdsRef.current.add(item.id)
      commit([...landed, ...queueRef.current])
    })
  }, [storageKey, commit])

  // #1191 返工：挂着的时候别处把这个 key 下的排队消息搬走了（Ctrl+T 把草稿
  // 翻成聊天草稿，消息寄存到项目名下等着回项目时领），当场从排队区放下，
  // 不然还显示着、会在聊天里重试，下次改队列也会把它写回这个 key。
  useEffect(() => {
    if (!storageKey) return
    return subscribeStoredQueueLeft(storageKey, (ids) => {
      if (storageKeyRef.current !== storageKey) return
      const kept = queueRef.current.filter((item) => !ids.has(item.id))
      if (kept.length === queueRef.current.length) return
      for (const id of ids) restoredIdsRef.current.delete(id)
      commit(kept)
    })
  }, [storageKey, commit])

  // #1191 第 3 次返工：登记内存里的消息（存储存不下的也在），让标签那边
  // （「新建会话」、Ctrl+T）知道这个草稿的排队区不是空的。挪到别的 key 下
  // （moveStorageTo）以后这个 key 不再算有。第 4 次返工：交整条消息，
  // 标签那边比得出改过的内容有没有存进去。
  useEffect(() => {
    if (!storageKey) return
    return registerLiveQueue(storageKey, () =>
      storageKeyRef.current === storageKey
        ? [...inFlightRef.current, ...queueRef.current]
        : []
    )
  }, [storageKey])

  // Mirror every committed queue while the claim is ours (the key arriving
  // later — a draft that just got saved — writes what is queued once it is
  // claimed).
  useEffect(() => {
    if (!storageKey) return
    // 第 9 次返工：已经挪到别的 key 下（moveStorageTo），不再写旧 key
    if (storageKeyRef.current !== storageKey) return
    if (
      !persistQueue(
        storageKey,
        [...inFlightRef.current, ...queue],
        ownedKeyRef.current,
        earlyWrittenRef
      )
    )
      loseClaim()
  }, [storageKey, queue, loseClaim])

  const moveStorageTo = useCallback((key: string) => {
    const from = storageKeyRef.current
    if (from === key || !canClaimStoredQueue(key)) return
    const memory = [...inFlightRef.current, ...queueRef.current]
    const memoryIds = new Set(memory.map((item) => item.id))
    // 旧 key 存着、还没读回内存的（刷新回来认领还没确认）一起带过去
    const fromStored =
      from && (ownedKeyRef.current === from || canClaimStoredQueue(from))
        ? readStoredQueue(from)
        : []
    const seen = new Set(memoryIds)
    const stored: QueuedMessage[] = []
    for (const item of [...readStoredQueue(key), ...fromStored]) {
      if (seen.has(item.id)) continue
      seen.add(item.id)
      stored.push(item)
    }
    writeStoredQueue(key, [...stored, ...memory])
    earlyWrittenRef.current = { key, ids: memoryIds }
    storageKeyRef.current = key
    if (!from) return
    // 新 key 确实存下了才清旧 key（超出存储上限时旧的那份留着）
    const landed = new Set(readStoredQueue(key).map((item) => item.id))
    if ([...fromStored, ...memory].every((item) => landed.has(item.id)))
      writeStoredQueue(from, [])
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
    (
      draft: PromptDraft,
      modeId: string | null,
      failure?: QueueFailureKind
    ): string => {
      const id = randomUUID()
      commit([
        {
          id,
          draft,
          modeId,
          failed: true,
          ...(failure ? { failure } : {}),
        },
        ...queueRef.current,
      ])
      return id
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
    inFlightRef.current = [...inFlightRef.current, current[0]]
    commit(current.slice(1))
    return current[0]
  }, [commit])

  const hold = useCallback(
    (
      draft: PromptDraft,
      modeId: string | null,
      clientMessageId?: string,
      firstOfConversation?: boolean
    ): string => {
      const item: QueuedMessage = {
        id: randomUUID(),
        draft,
        modeId,
        ...(clientMessageId ? { clientMessageId } : {}),
        ...(firstOfConversation ? { firstOfConversation: true } : {}),
      }
      inFlightRef.current = [...inFlightRef.current, item]
      // 排队区本身没变，只是让存储当场写上这一条
      commit(queueRef.current)
      return item.id
    },
    [commit]
  )

  const stampInFlight = useCallback(
    (id: string, clientMessageId: string, firstOfConversation?: boolean) => {
      const before = inFlightRef.current
      if (!before.some((item) => item.id === id)) return
      inFlightRef.current = before.map((item) =>
        item.id === id
          ? {
              ...item,
              clientMessageId,
              ...(firstOfConversation ? { firstOfConversation: true } : {}),
            }
          : item
      )
      // 排队区本身没变，只是让存储当场写上这个 id
      commit(queueRef.current)
    },
    [commit]
  )

  const dropDelivered = useCallback(
    (delivered: ReadonlySet<string>, firstUserText?: string | null) => {
      if (delivered.size === 0 && !firstUserText) return
      const current = queueRef.current
      // 新会话的第一条只认一份：同一段话读回了两条时只拿掉最前面那条
      let firstMatched = false
      const kept = current.filter((item) => {
        if (
          !item.failed ||
          item.failure !== "restored" ||
          item.clientMessageId == null
        )
          return true
        if (delivered.has(item.clientMessageId)) return false
        if (
          !firstMatched &&
          item.firstOfConversation === true &&
          firstUserText &&
          draftTexts(item.draft).includes(firstUserText)
        ) {
          firstMatched = true
          return false
        }
        return true
      })
      if (kept.length === current.length) return
      const editing = editingItemIdRef.current
      if (editing != null && !kept.some((item) => item.id === editing))
        setEditingItemId(null)
      commit(kept)
    },
    [commit, setEditingItemId]
  )

  const settle = useCallback((id: string) => {
    const before = inFlightRef.current
    if (!before.some((item) => item.id === id)) return
    inFlightRef.current = before.filter((item) => item.id !== id)
    const key = storageKeyRef.current
    if (!key) return
    if (ownedKeyRef.current === key) {
      if (claimStoredQueue(key))
        writeStoredQueue(key, [...inFlightRef.current, ...queueRef.current])
      return
    }
    // 认领还没确认、或者已经卸载：只拿掉这一条，别的原样留着
    if (!canClaimStoredQueue(key)) return
    const stored = readStoredQueue(key)
    if (stored.some((item) => item.id === id))
      writeStoredQueue(
        key,
        stored.filter((item) => item.id !== id)
      )
  }, [])

  const remove = useCallback(
    (id: string) => {
      if (editingItemId === id) {
        setEditingItemId(null)
      }
      commit(queueRef.current.filter((item) => item.id !== id))
    },
    [commit, editingItemId, setEditingItemId]
  )

  const removeIfUnchanged = useCallback(
    (id: string, draft: PromptDraft): boolean => {
      if (editingItemIdRef.current === id) return false
      const current = queueRef.current
      const item = current.find((entry) => entry.id === id)
      if (!item || item.draft !== draft) return false
      commit(current.filter((entry) => entry.id !== id))
      return true
    },
    [commit]
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
    settle,
    hold,
    stampInFlight,
    dropDelivered,
    remove,
    removeIfUnchanged,
    reorder,
    moveToFront,
    updateItem,
    getQueueLength,
    moveStorageTo,
    editingItemId,
    startEditing,
    cancelEditing,
  }
}
