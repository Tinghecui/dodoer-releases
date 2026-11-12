"use client"

import { useCallback, useRef, useState, type PointerEvent } from "react"
import { Reorder, useDragControls } from "motion/react"
import { Clock, GripVertical, Pencil, RotateCcw, X, Zap } from "lucide-react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { draftRidesBlocks } from "@/lib/prompt-draft"
import type { QueuedMessage } from "@/hooks/use-message-queue"

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
  isEditing: boolean
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
  isEditing,
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

  // Keep the action visible, but disable rows that cannot be sent safely:
  // * The row under edit. Its authoritative text is in the composer now, so
  //   inserting would send the PRE-edit draft and then drop the row the edit
  //   was going to save into. (The composer hides its own mid-turn send while
  //   editing for the same reason.)
  // * A draft carrying attachments on a pull-tool session. The pull channel
  //   delivers text, so the backend rejects blocks there — every click would
  //   land on the turn-end fallback, which only moves the row to the front
  //   and never inserts it. It still goes out whole with the next turn.
  const canSteer =
    Boolean(onSteerItem) &&
    !isEditing &&
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
        "flex items-center gap-1 rounded-md border px-1.5 py-1 text-3xs leading-none select-none [text-box-trim:both] [text-box-edge:cap_alphabetic]",
        "bg-[var(--g-fill1)] border-transparent",
        isEditing && "border-primary/50 bg-primary/5",
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
          className="inline-flex shrink-0 items-center gap-1 rounded-sm bg-destructive/10 px-1.5 py-1 text-destructive hover:bg-destructive/15"
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
        className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-1 text-primary hover:bg-primary/10 disabled:opacity-50"
        title={t(steerChannel === "pull" ? "steerItemAsNote" : "steerItemNow")}
      >
        {steerChannel === "pull" ? (
          <Clock className="h-2.5 w-2.5" />
        ) : (
          <Zap className="h-2.5 w-2.5" />
        )}
        <span>{t("steer")}</span>
      </button>
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
        title={t("editItem")}
      >
        <Pencil className="h-2.5 w-2.5" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className="shrink-0 rounded-sm p-0.5 hover:bg-muted-foreground/15 text-muted-foreground"
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

  if (queue.length === 0) return null

  // Cowork fork: a failed head holds everything behind it (the jenny rule in
  // `useMessageQueue.dequeue`), so "sent after this turn ends" would be
  // untrue. Say what is holding the queue and how to release it.
  const headFailed = queue[0].failed === true

  return (
    <div className="pb-1">
      {headFailed ? (
        <p
          data-queue-hint
          data-queue-blocked=""
          className="mb-1 text-xs leading-relaxed text-destructive"
        >
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
          {t("hint")}
        </p>
      )}
      <Reorder.Group
        as="div"
        axis="y"
        values={queue}
        onReorder={onReorder}
        className="flex max-h-28 flex-col gap-0.5 overflow-y-auto"
      >
        {queue.map((item, index) => (
          <QueueItem
            key={item.id}
            item={item}
            index={index}
            isEditing={editingItemId === item.id}
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
