"use client"

import type { ConversationFolderPickerOverride } from "@/components/chat/conversation-context-bar"
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { MessageSquareText, Send } from "lucide-react"
import { useTranslations } from "next-intl"
import type {
  AgentType,
  ConnectionStatus,
  PromptCapabilitiesInfo,
  PromptDraft,
  PromptInputBlock,
  SessionConfigOptionInfo,
  SessionModeInfo,
  AvailableCommandInfo,
} from "@/lib/types"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import {
  MessageInput,
  type ComposerInjectContent,
} from "@/components/chat/message-input"
import {
  MessageQueueDisplay,
  type QueueFailedHeadNotice,
} from "@/components/chat/message-queue-display"
import { cn } from "@/lib/utils"
import { buildSessionSettings, modelBrief } from "@/lib/session-settings"
import { AgentIcon } from "@/components/agent-icon"
import { GLASS_CARD_CLASS, useGlassRefraction } from "@/components/ui/glass"

// jenny fork: the collapse / expand morph. The composer's outline grows from
// the collapsed bar up to the full card (and back) on one eased height; the
// content cross-fades inside it. Expanding answers the pointer quickly and
// settles softly; collapsing is a touch shorter and eases out of the way.
const COMPOSER_EXPAND_MS = 320
const COMPOSER_COLLAPSE_MS = 260
const COMPOSER_EXPAND_EASE = "cubic-bezier(0.22, 1, 0.36, 1)"
const COMPOSER_COLLAPSE_EASE = "cubic-bezier(0.4, 0, 0.2, 1)"
/** Height of the collapsed bar (h-12) at 100% zoom. The bar is sized in rem,
 *  so it grows with the interface zoom; the outline follows its measured
 *  height and uses this only until there is one (and in tests). */
const COMPOSER_BAR_PX = 48
/** While it moves, the outline clips to the card's rounded
 *  box: 4px out at the top, just past the 2px outer line, so the card is uncovered
 *  from the bar upwards and never cut square; further out at the sides and
 *  bottom, where nothing pokes out but the card's shadow, so that is not
 *  sliced off into a hard grey band. The corner is the card's (18px, the
 *  sidebar card's radius — jenny fork) plus that 4px. */
const COMPOSER_OUTLINE_CLIP = "inset(-4px -16px -16px round 22px)"
/** How long the pointer may be away before the composer folds: brushing past
 *  its edge never snaps it shut. */
const COMPOSER_LEAVE_DELAY_MS = 220

interface ChatInputProps {
  hasMessages?: boolean
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  defaultPath?: string
  agentName?: string
  onFocus?: () => void
  onSend: (draft: PromptDraft, modeId?: string | null) => void
  onCancel: () => void
  modes?: SessionModeInfo[]
  configOptions?: SessionConfigOptionInfo[]
  modeLoading?: boolean
  configOptionsLoading?: boolean
  selectorsLoading?: boolean
  selectedModeId?: string | null
  onModeChange?: (modeId: string) => void
  onConfigOptionChange?: (configId: string, valueId: string) => void
  agentType?: AgentType | null
  availableCommands?: AvailableCommandInfo[] | null
  /** Pass-through: see `MessageInput.promptSuggestion`. */
  promptSuggestion?: string | null
  attachmentTabId?: string | null
  /** Pass-through: see `MessageInput`. */
  folderPickerOverride?: ConversationFolderPickerOverride
  draftStorageKey?: string | null
  /** Pass-through: see `MessageInput.getSentHistory`. */
  getSentHistory?: () => string[]
  isActive?: boolean
  /** Show the composer's flowing active-session border. Set only for the active
   *  tab when tiled across multiple sessions; passed through to MessageInput. */
  showActiveFlow?: boolean
  queue?: QueuedMessage[]
  onEnqueue?: (draft: PromptDraft, modeId: string | null) => void
  onQueueReorder?: (items: QueuedMessage[]) => void
  onQueueEdit?: (id: string) => void
  onQueueDelete?: (id: string) => void
  /** jenny fork: send a failed queued item again. */
  onQueueRetry?: (id: string) => void
  /** Cowork fork: why the failed head is stuck and where to fix it; threaded
   *  straight through to the queue list's hint. */
  queueFailedHeadNotice?: QueueFailedHeadNotice | null
  /** Insert one queued item into the RUNNING turn over the session's
   *  live-feedback channel (see `MessageQueueDisplayProps.onSteerItem`).
   *  Threaded straight through; present only while a turn is in flight and
   *  the session has a working channel. */
  onQueueSteer?: (id: string) => Promise<void> | void
  editingItemId?: string | null
  editingDraftText?: string | null
  editingDraftBlocks?: PromptInputBlock[] | null
  isEditingQueueItem?: boolean
  onSaveQueueEdit?: (draft: PromptDraft) => void
  onCancelQueueEdit?: () => void
  /** Send the draft into the RUNNING turn over the session's live-feedback
   *  channel. Present only when the session has a working delivery channel
   *  (`useSessionFeedback().steerAvailable`); resolves once recorded, rejects
   *  on any failure (incl. the turn-end race) so MessageInput can run its own
   *  enqueue fallback / draft preservation. `blocks` carries the full draft
   *  when it holds more than plain text (image attachments, file badges);
   *  `text` stays the recorded/display form. Must stay in sync with
   *  `MessageInputProps.onSteer` — the optional second parameter makes a
   *  stale one-arg declaration here assignable, so tsc would NOT catch a
   *  wrapper that silently drops the blocks. */
  onSteer?: (text: string, blocks?: PromptInputBlock[]) => Promise<void>
  /** Which channel `onSteer` rides (`useSessionFeedback().channel`); picks
   *  the composer's honest copy. See `MessageInput`. */
  steerChannel?: "native" | "pull"
  onAddFeedback?: () => void
  feedbackAddDisabled?: boolean
  /**
   * Keep the composer usable even while disconnected. Set for a folderless chat
   * draft: it has no working dir yet (so it never auto-connects), and the FIRST
   * send is precisely what lazily creates its conversation + scratch dir and
   * triggers the connection. Without this the composer would be permanently
   * disabled and the chat could never be started.
   */
  allowOfflineCompose?: boolean
  injectContent?: ComposerInjectContent | null
  onInjectConsumed?: () => void
  /** Drop the input's own horizontal padding when an ancestor already supplies
   *  the gutter (the welcome column wraps this in its own `px-4`). */
  flush?: boolean
  /** Use a taller minimum height for the composer. Set for the welcome
   *  (new-conversation) composer, which sits in a roomy empty state; active and
   *  historical conversations keep the compact default. */
  tall?: boolean
}

export const ChatInput = memo(function ChatInput({
  hasMessages = false,
  status,
  promptCapabilities,
  defaultPath,
  agentName,
  onFocus,
  onSend,
  onCancel,
  modes,
  configOptions,
  modeLoading = false,
  configOptionsLoading = false,
  selectorsLoading = false,
  selectedModeId,
  onModeChange,
  onConfigOptionChange,
  agentType,
  availableCommands,
  promptSuggestion,
  attachmentTabId,
  folderPickerOverride,
  draftStorageKey,
  getSentHistory,
  isActive,
  showActiveFlow,
  queue,
  onEnqueue,
  onQueueReorder,
  onQueueEdit,
  onQueueDelete,
  onQueueRetry,
  queueFailedHeadNotice,
  onQueueSteer,
  editingItemId,
  editingDraftText,
  editingDraftBlocks,
  isEditingQueueItem,
  onSaveQueueEdit,
  onCancelQueueEdit,
  onSteer,
  steerChannel,
  onAddFeedback,
  feedbackAddDisabled,
  allowOfflineCompose = false,
  injectContent,
  onInjectConsumed,
  flush = false,
  tall = false,
}: ChatInputProps) {
  const t = useTranslations("Folder.chat.chatInput")
  const tJenny = useTranslations("JennyFork")
  const isConnected = status === "connected"
  const isPrompting = status === "prompting"
  const isConnecting = status === "connecting"
  // The agent names its slash commands as part of coming up, so until it has
  // the composer's `/` panel shows a loading row rather than refusing to open.
  //
  // `connecting` alone is not the whole wait: the backend emits `connected`
  // EARLY — before session resume/load/new — and only forwards the agent's
  // buffered command list once `selectors_ready` has fired and the conversation
  // loop is running (see `emit_selectors_ready` in acp/connection.rs). Ending
  // the loading state at `connected` would blank the panel again for the whole
  // (often slow) session-init leg. `selectorsLoading` closes exactly that gap
  // and is bounded: `selectors_ready` fires on every establishment path whether
  // or not the agent has any commands, so this can never hang on a spinner.
  const commandsLoading = isConnecting || selectorsLoading
  const containerRef = useRef<HTMLDivElement>(null)
  const collapsedBarRef = useRef<HTMLButtonElement>(null)
  useGlassRefraction(collapsedBarRef, "pane")
  const [hovered, setHovered] = useState(false)
  const leaveTimerRef = useRef<number | null>(null)
  const cancelLeave = useCallback(() => {
    if (leaveTimerRef.current != null) {
      window.clearTimeout(leaveTimerRef.current)
      leaveTimerRef.current = null
    }
  }, [])
  useEffect(() => cancelLeave, [cancelLeave])
  const [focused, setFocused] = useState(false)
  const [hasDraft, setHasDraft] = useState(false)
  const [wasPrompting, setWasPrompting] = useState(isPrompting)
  const onDraftChange = useCallback((hasDraft: boolean) => {
    setHasDraft(hasDraft)
    if (hasDraft) setFocused(true)
  }, [])
  if (wasPrompting !== isPrompting) {
    setWasPrompting(isPrompting)
    if (wasPrompting) {
      setFocused(hasDraft)
      setHovered(false)
    }
  }
  // jenny fork: the model line on the folded bar.
  const brief = useMemo(
    () =>
      modelBrief(
        buildSessionSettings({
          configOptions: configOptions ?? [],
          modes: [],
          currentModeId: null,
          modeTitle: "",
        })
      ),
    [configOptions]
  )

  const collapsed =
    hasMessages &&
    !isPrompting &&
    !isConnecting &&
    !hovered &&
    !focused &&
    // jenny fork: unsent text keeps the composer open, so a click elsewhere
    // never folds a draft out of sight.
    !hasDraft &&
    !isEditingQueueItem &&
    !injectContent &&
    !queue?.length

  useEffect(() => {
    if (collapsed) {
      // Enter leaves the editor focused after sending. A completed turn must
      // release that stale focus as well as the space occupied by the editor.
      const active = document.activeElement
      if (
        active instanceof HTMLElement &&
        containerRef.current?.contains(active)
      ) {
        active.blur()
      }
    }
  }, [collapsed])

  useEffect(() => {
    const handleOutsidePress = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setFocused(false)
      }
    }
    document.addEventListener("pointerdown", handleOutsidePress)
    return () => document.removeEventListener("pointerdown", handleOutsidePress)
  }, [])

  // The morph. While collapsed or moving, the body is pinned to the bottom of
  // an outline whose height is animated — from the bar's height to the body's
  // own (measured) height — and clipped to it; only the outline's height
  // changes, so the editor inside never reflows mid-animation. Once expanded
  // and settled, the outline lets go (height auto, nothing clipped): the body
  // grows with its text, and the slash-command menu that opens above the
  // editor is not cut off.
  const outlineRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [bodyHeight, setBodyHeight] = useState(0)
  // jenny fork: the bar's real height. `h-12` is 3rem, which the interface
  // zoom scales (it sets the root font size); a fixed 48px outline sliced the
  // top of a zoomed bar off, frame and corners included.
  const [barHeight, setBarHeight] = useState(0)
  useLayoutEffect(() => {
    const body = bodyRef.current
    const bar = collapsedBarRef.current
    if (!body || !bar) return
    const measure = () => {
      setBodyHeight(body.offsetHeight)
      setBarHeight(bar.offsetHeight)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(body)
    observer.observe(bar)
    return () => observer.disconnect()
  }, [])
  const barPx = barHeight || COMPOSER_BAR_PX
  // What the outline is sized for. It trails `collapsed` by one layout pass
  // on the way down, so a settled outline is first pinned to its pixel
  // height and the shrink has a number to start from.
  const [shownCollapsed, setShownCollapsed] = useState(collapsed)
  const [settled, setSettled] = useState(!collapsed)
  if (collapsed && settled) setSettled(false)
  useLayoutEffect(() => {
    if (collapsed === shownCollapsed) return
    // Flush the pinned height before aiming at the new one: the second pass
    // is the point, so the transition has a start value.
    void outlineRef.current?.offsetHeight
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShownCollapsed(collapsed)
  }, [collapsed, shownCollapsed])
  useEffect(() => {
    if (collapsed || shownCollapsed || settled) return
    const timer = window.setTimeout(() => setSettled(true), COMPOSER_EXPAND_MS)
    return () => window.clearTimeout(timer)
  }, [collapsed, shownCollapsed, settled])
  // jenny fork: folded and at rest, the hidden body needs no clipping; the
  // clip goes, so the bar's shadow fades out above it uncut.
  const [folded, setFolded] = useState(collapsed)
  if (!collapsed && folded) setFolded(false)
  useEffect(() => {
    if (!collapsed || !shownCollapsed || folded) return
    const timer = window.setTimeout(() => setFolded(true), COMPOSER_COLLAPSE_MS)
    return () => window.clearTimeout(timer)
  }, [collapsed, shownCollapsed, folded])
  const outlineHeight = settled
    ? undefined
    : shownCollapsed
      ? barPx
      : Math.max(barPx, bodyHeight)

  const expandAndFocus = () => {
    setFocused(true)
    requestAnimationFrame(() => {
      const container = containerRef.current
      if (container?.dataset.composerState === "expanded") {
        container
          .querySelector<HTMLElement>('[contenteditable="true"]')
          ?.focus()
      }
    })
  }

  // Active/historical conversations dock the composer at the very bottom of the
  // message list. The attached folder/branch selector row now sits at the
  // composer's bottom edge, so the docked composer keeps only a tight bottom gap
  // (pb-1) — matching the row's own `pt-1` top gap, so the selectors read as
  // evenly spaced above and below rather than floating over a wide margin. The
  // welcome/draft composer (`flush`) uses the same pb-1 but supplies its own
  // px-4 gutter.
  return (
    <div
      ref={containerRef}
      data-composer-state={collapsed ? "collapsed" : "expanded"}
      // Collapsed, the composer keeps its shape and its full width: a rounded
      // input-sized bar, so it is clear where to rest the pointer. Expanding
      // grows the same box in height; collapsing waits a beat first, so
      // brushing past the edge does not snap it shut.
      // Liquid Glass: docked, the composer is 12px wider than the text column
      // on each side (rows are `px-4` in the same `chat-content-w`, this is
      // `px-1`), collapsed bar included (erratum E2).
      className={cn("pt-0", flush ? "pb-1" : "px-1 pb-1")}
      onMouseEnter={() => {
        cancelLeave()
        setHovered(true)
      }}
      onMouseLeave={() => {
        cancelLeave()
        leaveTimerRef.current = window.setTimeout(() => {
          leaveTimerRef.current = null
          setHovered(false)
        }, COMPOSER_LEAVE_DELAY_MS)
      }}
      onFocusCapture={() => {
        if (collapsed) expandAndFocus()
        else setFocused(true)
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget))
          setFocused(false)
      }}
      onContextMenu={(event) => event.stopPropagation()}
      // Touch and pen open a context menu from a LONG PRESS, which Radix arms on
      // pointerdown — and the whole conversation panel (composer included) sits
      // inside its own context-menu trigger. Without this, a slow tap on any
      // composer control (the agent icon, the send button, …) pops the
      // conversation menu. Mouse presses keep bubbling, so the panel's
      // selection bookkeeping is untouched; the composer's OWN context menu
      // still arms, since its trigger is nested below this wrapper.
      onPointerDown={(event) => {
        if (collapsed) expandAndFocus()
        else setFocused(true)
        if (event.pointerType !== "mouse") event.stopPropagation()
      }}
    >
      {/* The outline: sized for the bar while collapsed, for the body while
          open, eased between the two. While it moves it
          clips to its own rounded box — widened by the 2px line both the bar
          and the card draw outside themselves — so the card is uncovered from
          the bar upwards, never cut square. */}
      <div
        ref={outlineRef}
        data-composer-outline=""
        className="relative motion-reduce:transition-none"
        style={{
          height: outlineHeight,
          minHeight: `${barPx}px`,
          clipPath: settled || folded ? undefined : COMPOSER_OUTLINE_CLIP,
          transitionProperty: "height",
          transitionDuration: `${collapsed ? COMPOSER_COLLAPSE_MS : COMPOSER_EXPAND_MS}ms`,
          transitionTimingFunction: collapsed
            ? COMPOSER_COLLAPSE_EASE
            : COMPOSER_EXPAND_EASE,
        }}
      >
        <button
          ref={collapsedBarRef}
          type="button"
          data-composer-collapsed-bar=""
          title={t("sendMessage")}
          aria-label={t("sendMessage")}
          aria-hidden={!collapsed}
          tabIndex={collapsed ? 0 : -1}
          onClick={expandAndFocus}
          style={{ visibility: collapsed ? undefined : "hidden" }}
          className={cn(
            // jenny fork: collapsed, the composer is the same card as when
            // open — the same grey pane glass, frame and corners, only 48px
            // tall — so folding reads as the card getting shorter, not as a
            // white capsule taking its place.
            "lg lg-pane lg-ia absolute inset-x-0 bottom-0 z-10 flex h-12 items-center gap-2.5 rounded-[18px] px-[1.125rem] text-sm text-[var(--ink3)] outline-none",
            GLASS_CARD_CLASS,
            "hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
            "transition-[opacity,visibility,color] motion-reduce:transition-none",
            // Out of the way at once when opening; back in as the outline
            // lands on its height when folding.
            collapsed
              ? "opacity-100 delay-[110ms] duration-[150ms] ease-out"
              : "pointer-events-none opacity-0 duration-[90ms] ease-in"
          )}
        >
          <MessageSquareText
            aria-hidden="true"
            className="size-4 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 flex-1 truncate text-left">
            {t("sendMessage")}
          </span>
          {/* jenny fork: what a message would go to, and the send button's
              place, so the folded card still reads as the composer. */}
          {agentType || brief ? (
            <span
              data-composer-collapsed-model=""
              className="flex min-w-0 max-w-[45%] shrink items-center gap-1.5 text-xs text-muted-foreground"
            >
              {agentType ? (
                <AgentIcon agentType={agentType} className="size-3.5" />
              ) : null}
              <span className="truncate">
                {[brief?.provider ?? agentName, brief?.model]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            </span>
          ) : null}
          <span
            aria-hidden="true"
            data-composer-collapsed-send=""
            className="-mr-2.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground opacity-50"
          >
            <Send className="size-4" />
          </span>
        </button>
        <div
          ref={bodyRef}
          inert={collapsed}
          aria-hidden={collapsed}
          data-composer-body=""
          // Never force `visible`: an inactive tab hides its whole panel with
          // `visibility: hidden`, and an explicit `visible` here would show
          // this composer through it.
          style={{ visibility: collapsed ? "hidden" : undefined }}
          className={cn(
            settled ? "relative" : "absolute inset-x-0 bottom-0",
            "transition-[opacity,translate,visibility] motion-reduce:transition-none",
            // The content fades in as the outline opens (a beat behind it,
            // rising a few pixels) and out before it closes.
            collapsed
              ? "translate-y-1.5 opacity-0 duration-[140ms] ease-in"
              : "translate-y-0 opacity-100 delay-[50ms] duration-[220ms] ease-out"
          )}
        >
          <div>
            {queue &&
              queue.length > 0 &&
              // Cowork fork: a failed head is not waiting for the agent — it
              // waits for the user's retry, and the queue's own hint says so.
              !queue[0].failed &&
              ((!isConnected && !isPrompting) || selectorsLoading) && (
                <div
                  className="px-1 pb-1 text-xs text-muted-foreground"
                  data-jenny-queue-waiting=""
                >
                  {tJenny("waitingToSend", { agent: agentName ?? "Agent" })}
                </div>
              )}
            {queue &&
              queue.length > 0 &&
              onQueueReorder &&
              onQueueEdit &&
              onQueueDelete && (
                <MessageQueueDisplay
                  queue={queue}
                  onReorder={onQueueReorder}
                  onEdit={onQueueEdit}
                  onDelete={onQueueDelete}
                  onRetry={onQueueRetry}
                  failedHeadNotice={queueFailedHeadNotice}
                  editingItemId={editingItemId ?? null}
                  onSteerItem={onQueueSteer}
                  steerChannel={steerChannel}
                />
              )}
            <MessageInput
              onDraftChange={onDraftChange}
              suppressAutoFocus={hasMessages}
              onSend={onSend}
              promptCapabilities={promptCapabilities}
              onFocus={onFocus}
              defaultPath={defaultPath}
              disabled={
                // jenny fork: with a queue to hold it, a message sent before the
                // agent is ready waits there instead of the send button locking.
                allowOfflineCompose || onEnqueue
                  ? false
                  : (!isConnected && !isPrompting) || selectorsLoading
              }
              isPrompting={isPrompting}
              onCancel={onCancel}
              modes={modes}
              configOptions={configOptions}
              modeLoading={modeLoading}
              configOptionsLoading={configOptionsLoading}
              selectedModeId={selectedModeId}
              onModeChange={onModeChange}
              onConfigOptionChange={onConfigOptionChange}
              agentType={agentType}
              availableCommands={availableCommands}
              promptSuggestion={promptSuggestion}
              commandsLoading={commandsLoading}
              attachmentTabId={attachmentTabId}
              folderPickerOverride={folderPickerOverride}
              draftStorageKey={draftStorageKey}
              getSentHistory={getSentHistory}
              isActive={isActive}
              showActiveFlow={showActiveFlow}
              onEnqueue={onEnqueue}
              editingItemId={editingItemId}
              editingDraftText={editingDraftText}
              editingDraftBlocks={editingDraftBlocks}
              isEditingQueueItem={isEditingQueueItem}
              onSaveQueueEdit={onSaveQueueEdit}
              onCancelQueueEdit={onCancelQueueEdit}
              onSteer={onSteer}
              steerChannel={steerChannel}
              onAddFeedback={onAddFeedback}
              feedbackAddDisabled={feedbackAddDisabled}
              injectContent={injectContent}
              onInjectConsumed={onInjectConsumed}
              placeholder={
                isConnecting
                  ? t("connecting")
                  : isPrompting
                    ? t("agentResponding", { agent: agentName ?? "Agent" })
                    : t("sendMessage")
              }
              // Cowork: one name for the textbox whatever the hint above says.
              // It used to be the hint itself, so the box was renamed every
              // time a turn started or the agent reconnected, and a lookup by
              // name (assistive tech, the AI QA tester) lost it mid-session.
              ariaLabel={t("sendMessage")}
              // The floor goes through `tall`, not through a `min-h-*` here: the box
              // and its editable area carry two halves of the same number, and only
              // MessageInput knows the action row that divides them.
              tall={tall}
              className="max-h-60"
            />
          </div>
        </div>
      </div>
    </div>
  )
})

ChatInput.displayName = "ChatInput"
