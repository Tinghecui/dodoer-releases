"use client"

import { useCallback, useRef, useState, type PointerEvent } from "react"
import { Reorder, useDragControls } from "motion/react"
import { Clock, GripVertical, Pencil, RotateCcw, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { draftRidesBlocks } from "@/lib/prompt-draft"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import { COARSE_BOX_32, COARSE_HIT_32, TOUCH_GAP_1 } from "@/lib/touch-target"

/**
 * Cowork fork: what the host knows about a failed head, shown with the hint
 * that replaces the generic one while the head is failed.
 */
export interface QueueFailedHeadNotice {
  /** One sentence saying why it failed (no usable agent, say). */
  reason?: string
  /** Where the user can fix it — a link after the hint. */
  action?: { label: string; onClick: () => void }
}

interface MessageQueueDisplayProps {
  queue: QueuedMessage[]
  onReorder: (items: QueuedMessage[]) => void
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  /** jenny fork: send a failed item again (see `QueuedMessage.failed`). */
  onRetry?: (id: string) => void
  /**
   * Cowork fork: send every failed row again, in queue order. Offered only
   * while two or more shown rows are failed (one has its own retry).
   */
  onRetryAll?: () => void
  /** The row under edit is not shown — its text is in the composer. */
  editingItemId: string | null
  /**
   * Send one queued item straight into the RUNNING turn over the session's
   * live-feedback channel (same delivery as the composer's mid-turn send).
   * Present only while the session has a working channel AND a turn is in
   * flight; the host decides whether the row is removed (it stays queued on
   * the turn-end race). Resolves once delivery is settled.
   */
  onSteerItem?: (id: string) => Promise<void> | void
  /** Which channel {@link onSteerItem} rides; picks the honest icon/copy,
   *  mirroring the composer's split-button (`Zap` = instant insert,
   *  `Clock` = note the agent reads on its next check). */
  steerChannel?: "native" | "pull"
  /** Cowork fork: see {@link QueueFailedHeadNotice}. Ignored unless the head
   *  is failed. */
  failedHeadNotice?: QueueFailedHeadNotice | null
}

interface QueueItemProps {
  item: QueuedMessage
  index: number
  onEdit: (id: string) => void
  onDelete: (id: string) => void
  onRetry?: (id: string) => void
  onSteerItem?: (id: string) => Promise<void> | void
  steerChannel: "native" | "pull"
  /** Whether an insert from ANY row is in flight — every row's button is
   *  disabled for the duration, so two rows can't race the one channel. */
  steering: boolean
  onSteerStart: (id: string) => Promise<void>
}

function QueueItem({
  item,
  index,
  onEdit,
  onDelete,
  onRetry,
  onSteerItem,
  steerChannel,
  steering,
  onSteerStart,
}: QueueItemProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  const dragControls = useDragControls()

  // Keep the action visible, but disable a row that cannot be sent safely:
  // a draft carrying attachments on a pull-tool session. The pull channel
  // delivers text, so the backend rejects blocks there — every click would
  // land on the turn-end fallback, which only moves the row to the front and
  // never inserts it. It still goes out whole with the next turn. (The row
  // under edit is not rendered at all — its text is in the composer.)
  const canSteer =
    Boolean(onSteerItem) &&
    (steerChannel === "native" || !draftRidesBlocks(item.draft))

  const startDrag = useCallback(
    (event: PointerEvent<HTMLButtonElement>) => {
      event.preventDefault()
      event.stopPropagation()
      dragControls.start(event)
    },
    [dragControls]
  )

  return (
    <Reorder.Item
      as="div"
      value={item}
      dragListener={false}
      dragControls={dragControls}
      data-queue-item={index + 1}
      className={cn(
        "flex items-center rounded-md border px-1.5 py-1 text-3xs leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
        // 间距同时告诉重试、引导按钮，触屏上它们的点按区域各伸进空隙的一半
        TOUCH_GAP_1,
        "bg-[var(--g-fill1)] border-transparent",
        item.failed && "border-destructive/60 bg-destructive/5"
      )}
      data-queue-failed={item.failed ? "" : undefined}
    >
      <button
        type="button"
        className="shrink-0 cursor-grab touch-none active:cursor-grabbing p-0"
        onPointerDown={startDrag}
      >
        <GripVertical className="h-3 w-3 text-muted-foreground/60" />
      </button>
      <span className="shrink-0 font-mono text-3xs text-muted-foreground/70">
        #{index + 1}
      </span>
      <span className="min-w-0 flex-1 truncate text-3xs text-foreground/80">
        {item.draft.displayText}
      </span>
      {item.failed && (
        <span className="shrink-0 text-3xs text-destructive">
          {t("sendFailed")}
        </span>
      )}
      {item.failed && onRetry && (
        <button
          type="button"
          onClick={() => onRetry(item.id)}
          // On the composer's glass: red text on a light red fill, never a
          // second layer of glass (handoff 6.12 #7).
          className={`relative inline-flex shrink-0 items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-1 text-destructive hover:bg-destructive/15 ${COARSE_HIT_32}`}
          title={t("retryItem")}
        >
          <RotateCcw className="h-2.5 w-2.5" />
          <span>{t("retry")}</span>
        </button>
      )}
      <button
        type="button"
        onClick={() => void onSteerStart(item.id)}
        disabled={steering || !canSteer}
        className={`relative inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-primary hover:bg-primary/10 disabled:opacity-50 ${COARSE_HIT_32}`}
        title={t(steerChannel === "pull" ? "steerItemAsNote" : "steerItemNow")}
      >
        {steerChannel === "pull" ? (
          <Clock className="h-2.5 w-2.5" />
        ) : (
          <Zap className="h-2.5 w-2.5" />
        )}
        <span>{t("steer")}</span>
      </button>
      {/* 编辑、删除挨在一起：触屏上按钮本身撑到 32px，不用居中的 ::after，
          免得删除的点按区域盖住编辑的右半边。 */}
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        className={`shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground ${COARSE_BOX_32}`}
        title={t("editItem")}
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className={`shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground ${COARSE_BOX_32}`}
        title={t("deleteItem")}
      >
        <X className="h-2.5 w-2.5" />
      </button>
    </Reorder.Item>
  )
}

export function MessageQueueDisplay({
  queue,
  onReorder,
  onEdit,
  onDelete,
  onRetry,
  onRetryAll,
  editingItemId,
  onSteerItem,
  steerChannel = "pull",
  failedHeadNotice,
}: MessageQueueDisplayProps) {
  const t = useTranslations("Folder.chat.messageQueue")
  // The id whose insert is in flight. A per-row `steering` would let a
  // concurrent click on another row race the same channel; one shared id
  // both disables the clicked row and (via `steeringId !== null`) the others
  // — matching the composer's single-flight `steering` guard.
  const [steeringId, setSteeringId] = useState<string | null>(null)
  // The click handler's re-entrancy lock. Taken in the click itself and
  // released in `finally`, so a second click that lands before React commits
  // the disabled buttons is still refused: the state above only drives
  // rendering and lags a commit.
  const steeringIdRef = useRef<string | null>(null)

  const handleSteerStart = useCallback(
    async (id: string) => {
      if (!onSteerItem || steeringIdRef.current !== null) return
      steeringIdRef.current = id
      setSteeringId(id)
      try {
        await onSteerItem(id)
      } finally {
        steeringIdRef.current = null
        setSteeringId(null)
      }
    },
    [onSteerItem]
  )

  // Cowork fork: the row under edit is in the composer, so it is not shown
  // here too. The others keep their place in the whole queue as their number.
  const editingIndex =
    editingItemId === null
      ? -1
      : queue.findIndex((item) => item.id === editingItemId)
  const shown =
    editingIndex < 0
      ? queue
      : queue.filter((_, index) => index !== editingIndex)

  // A drag only sees the shown rows; put the hidden one back at its index so
  // the hook gets a full permutation (it drops a reorder of the wrong length).
  const handleReorder = (items: QueuedMessage[]) => {
    if (editingIndex < 0) {
      onReorder(items)
      return
    }
    const next = [...items]
    next.splice(editingIndex, 0, queue[editingIndex])
    onReorder(next)
  }

  if (shown.length === 0) return null

  // Cowork fork: a failed head holds everything behind it (the jenny rule in
  // `useMessageQueue.dequeue`), so "sent after this turn ends" would be
  // untrue. Say what is holding the queue and how to release it. Judged on
  // the whole queue: a failed head under edit still holds the rest.
  const headFailed = queue[0].failed === true
  const failedShown = shown.filter((item) => item.failed === true).length
  const retryAllButton =
    onRetryAll && failedShown >= 2 ? (
      <button
        type="button"
        data-queue-retry-all=""
        onClick={onRetryAll}
        className="float-right ml-2 inline-flex items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-0.5 text-3xs leading-none text-destructive hover:bg-destructive/15"
        title={t("retryAllHint")}
      >
        <RotateCcw className="h-2.5 w-2.5" />
        <span>{t("retryAll", { count: failedShown })}</span>
      </button>
    ) : null

  return (
    <div className="pb-1">
      {headFailed ? (
        <p
          data-queue-hint
          data-queue-blocked=""
          className="mb-1 text-xs leading-relaxed text-destructive"
        >
          {retryAllButton}
          {failedHeadNotice?.reason ? (
            <span data-queue-blocked-reason="" className="mr-1">
              {failedHeadNotice.reason}
            </span>
          ) : null}
          {t(queue.length > 1 ? "failedHeadHint" : "failedSingleHint")}
          {failedHeadNotice?.action ? (
            <button
              type="button"
              data-queue-blocked-action=""
              onClick={failedHeadNotice.action.onClick}
              className="ml-1 underline underline-offset-2 hover:text-destructive/80"
            >
              {failedHeadNotice.action.label}
            </button>
          ) : null}
        </p>
      ) : (
        <p
          data-queue-hint
          className="mb-1 text-xs leading-relaxed text-muted-foreground"
        >
          {retryAllButton}
          {t("hint")}
        </p>
      )}
      <Reorder.Group
        as="div"
        axis="y"
        values={shown}
        onReorder={handleReorder}
        className="flex max-h-28 flex-col gap-0.5 overflow-y-auto"
      >
        {shown.map((item) => (
          <QueueItem
            key={item.id}
            item={item}
            index={queue.indexOf(item)}
            onEdit={onEdit}
            onDelete={onDelete}
            onRetry={onRetry}
            onSteerItem={onSteerItem}
            steerChannel={steerChannel}
            steering={steeringId !== null}
            onSteerStart={handleSteerStart}
          />
        ))}
      </Reorder.Group>
    </div>
  )
}
