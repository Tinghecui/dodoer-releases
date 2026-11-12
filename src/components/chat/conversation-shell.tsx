import type { ConversationFolderPickerOverride } from "@/components/chat/conversation-context-bar"
import { useEffect, useRef, type ReactNode, type RefObject } from "react"
import type {
  AgentType,
  ConnectionStatus,
  PendingPlanApprovalState,
  PendingQuestionState,
  PlanApprovalAnswer,
  PromptCapabilitiesInfo,
  PromptDraft,
  PromptInputBlock,
  QuestionAnswer,
  SessionConfigOptionInfo,
  SessionFailureRecord,
  SessionModeInfo,
  AvailableCommandInfo,
  RemoteControlInfo,
} from "@/lib/types"
import { ComposerStatusStrips } from "@/components/chat/composer-status-strips"
import { RemoteControlStrip } from "@/components/chat/remote-control-strip"
import type {
  PendingPermission,
  PendingQuestion,
  ClaudeApiRetryState,
} from "@/contexts/acp-connections-context"
import type { QueuedMessage } from "@/hooks/use-message-queue"
import { ChatInput } from "@/components/chat/chat-input"
import type { QueueFailedHeadNotice } from "@/components/chat/message-queue-display"
import { ChatWidthHandles } from "@/components/chat/chat-width-handles"
import { chatGutterStyle } from "@/lib/chat-content-width"
import { cn } from "@/lib/utils"
import type { ComposerInjectContent } from "@/components/chat/message-input"
import { PermissionDialog } from "@/components/chat/permission-dialog"
import { QuestionDialog } from "@/components/chat/question-dialog"
import { AskQuestionCard } from "@/components/chat/ask-question-card"
import { PlanApprovalCard } from "@/components/chat/plan-approval-card"
import { MarkdownImageProvider } from "@/components/ai-elements/markdown-local-image"

interface ConversationShellProps {
  hasMessages?: boolean
  status: ConnectionStatus | null
  promptCapabilities: PromptCapabilitiesInfo
  defaultPath?: string
  agentName?: string
  /** The in-flight retry line under the composer (see
   *  `ComposerStatusStrips`). The session's errors are notifications, raised by
   *  the connections provider — none is drawn here. */
  claudeApiRetry: ClaudeApiRetryState | null
  /** AIR typed session failures for this connection (active + resolved); the
   *  dock draws only the in-flight retry incidents. Omit/empty renders
   *  nothing. */
  sessionFailures?: SessionFailureRecord[]
  /** Closes an incident strip, taking every record it stands for. Passed for
   *  every surface with a live store — dismissing is client-local, so viewers
   *  get it too. */
  onSessionFailureDismiss?: (ids: string[]) => void
  /** Claude Code's Remote Control while it is on; its strip shows the
   *  session's link and QR code. Omit/`null` renders nothing. */
  remoteControl?: RemoteControlInfo | null
  /** Turns Remote Control off (sends `/remote-control off`). Omitted for
   *  surfaces without a connection of their own — the button is then hidden. */
  onRemoteControlOff?: () => void
  pendingPermission: PendingPermission | null
  pendingQuestion: PendingQuestion | null
  /** Awaiting-answer multiple-choice `ask_user_question`. */
  pendingAskQuestion: PendingQuestionState | null
  /** Awaiting-decision Grok `exit_plan_mode` approval. */
  pendingPlanApproval: PendingPlanApprovalState | null
  onFocus: () => void
  onSend: (draft: PromptDraft, modeId?: string | null) => void
  onCancel: () => void
  onRespondPermission: (requestId: string, optionId: string) => void
  onAnswerQuestion: (answer: string) => void
  onAnswerAskQuestion: (
    questionId: string,
    answer: QuestionAnswer
  ) => void | Promise<void>
  onAnswerPlanApproval: (
    approvalId: string,
    answer: PlanApprovalAnswer
  ) => void | Promise<void>
  children: ReactNode
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
  /** The prompt the agent predicts the user will send next; the empty
   *  composer offers it (see `MessageInput.promptSuggestion`). */
  promptSuggestion?: string | null
  attachmentTabId?: string | null
  /** Pass-through: see `MessageInput`. */
  folderPickerOverride?: ConversationFolderPickerOverride
  draftStorageKey?: string | null
  /** Pass-through: see `MessageInput.getSentHistory`. */
  getSentHistory?: () => string[]
  hideInput?: boolean
  /** Optional banner rendered in the composer dock, where the input sits.
   *  Used with `hideInput` to explain WHY the composer is unavailable (e.g.
   *  the agent failed to load this session) without hijacking the message
   *  area above. Renders nothing when omitted. */
  composerBanner?: ReactNode
  /** Optional read-only live-feedback notes list rendered just above the
   *  composer (see `FeedbackNotesDisplay`). Renders nothing when there are no
   *  notes for the current turn. */
  feedbackList?: ReactNode
  /** Open the live-feedback dialog from the composer "+" menu (hidden when
   *  omitted / feature off). */
  onAddFeedback?: () => void
  /** Grey out the live-feedback "+" entry when a note can't be sent right now. */
  feedbackAddDisabled?: boolean
  isActive?: boolean
  /** Show the composer's flowing active-session border (tiled multi-session
   *  active tab only). Threaded straight through to the composer. */
  showActiveFlow?: boolean
  queue?: QueuedMessage[]
  onEnqueue?: (draft: PromptDraft, modeId: string | null) => void
  onQueueReorder?: (items: QueuedMessage[]) => void
  onQueueEdit?: (id: string) => void
  onQueueDelete?: (id: string) => void
  /** jenny fork: send a failed queued item again. */
  onQueueRetry?: (id: string) => void
  /** Cowork fork: threaded straight through to the composer's queue list.
   *  See `ChatInputProps.queueFailedHeadNotice`. */
  queueFailedHeadNotice?: QueueFailedHeadNotice | null
  /** Insert one queued item into the RUNNING turn over the session's
   *  live-feedback channel; threaded straight through to the composer's
   *  queue list. See `ChatInputProps.onQueueSteer`. */
  onQueueSteer?: (id: string) => Promise<void> | void
  editingItemId?: string | null
  editingDraftText?: string | null
  editingDraftBlocks?: PromptInputBlock[] | null
  isEditingQueueItem?: boolean
  onSaveQueueEdit?: (draft: PromptDraft) => void
  onCancelQueueEdit?: () => void
  /** Send the draft into the RUNNING turn over the session's live-feedback
   *  channel. Present only for sessions with a working delivery channel;
   *  threaded straight through to the composer. `blocks` carries the full
   *  draft when it holds more than plain text (image attachments, file
   *  badges); `text` stays the recorded/display form. Must stay in sync with
   *  `MessageInputProps.onSteer` — the optional second parameter makes a
   *  stale one-arg declaration here assignable, so tsc would NOT catch a
   *  wrapper that silently drops the blocks. */
  onSteer?: (text: string, blocks?: PromptInputBlock[]) => Promise<void>
  /** Which channel `onSteer` rides (picks the composer's honest copy);
   *  threaded straight through. See `MessageInput`. */
  steerChannel?: "native" | "pull"
  /** Optional banner pinned to the top of the panel, above the message area
   *  (e.g. the "restart to apply" config-stale banner). Renders nothing when
   *  omitted. */
  topBanner?: ReactNode
  /** Content pushed into the docked composer from outside it — currently a
   *  quoted transcript selection. Cleared by the host via `onInjectConsumed`
   *  once the composer has taken it. */
  injectContent?: ComposerInjectContent | null
  onInjectConsumed?: () => void
  /** Give the chat column drag handles on its edges (`ChatWidthHandles`) and
   *  the window-edge gutter they need. Only for the conversation tab: a canvas
   *  card renders this shell inside the board's zoom transform, where the
   *  handles' layout maths would be off by the zoom factor, and a card has no
   *  window edge to keep clear. */
  resizableWidth?: boolean
}

export function ConversationShell({
  hasMessages = false,
  status,
  promptCapabilities,
  defaultPath,
  agentName,
  claudeApiRetry,
  sessionFailures,
  onSessionFailureDismiss,
  remoteControl,
  onRemoteControlOff,
  pendingPermission,
  pendingQuestion,
  pendingAskQuestion,
  pendingPlanApproval,
  onFocus,
  onSend,
  onCancel,
  onRespondPermission,
  onAnswerQuestion,
  onAnswerAskQuestion,
  onAnswerPlanApproval,
  children,
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
  hideInput = false,
  composerBanner,
  feedbackList,
  onAddFeedback,
  feedbackAddDisabled,
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
  topBanner,
  injectContent,
  onInjectConsumed,
  resizableWidth = false,
}: ConversationShellProps) {
  const shellRef = useRef<HTMLDivElement>(null)
  const dockRef = useRef<HTMLDivElement>(null)
  useGlassDockInset(shellRef, dockRef)

  return (
    // The gutter keeps the chat column (transcript and composer alike) off
    // the window edge, so its width handles stay grabbable at any width.
    <div
      ref={shellRef}
      data-conversation-shell=""
      className="relative flex h-full min-h-0 flex-col"
      style={resizableWidth ? chatGutterStyle : undefined}
    >
      {/* Strips pinned above the transcript. With the floating top bar over
          the column (Liquid Glass) they start below it; while there are none
          the transcript itself scrolls under the bar instead. */}
      <div
        data-conversation-top-strips=""
        className="shrink-0 [&:not(:empty)]:pt-[var(--glass-top-inset,0px)]"
      >
        {topBanner}

        {/* Above the transcript, not down in the composer dock: Remote Control
            is the session's standing state, and pinning it here keeps it still
            while the messages scroll under it. The dock below is for things
            that come and go with the turn or the connection
            (`ComposerStatusStrips`). Work running past a turn — background
            tasks, sub-agents, delegations — is the transcript's live activity
            row's "N running" (`MessageListView`'s `liveRuns`). */}
        {remoteControl && (
          <RemoteControlStrip
            remoteControl={remoteControl}
            onTurnOff={onRemoteControlOff}
            canTurnOff={status === "connected"}
          />
        )}
      </div>

      <div className={cn("flex-1 min-h-0", resizableWidth && "relative")}>
        {children}
        {resizableWidth && <ChatWidthHandles />}
      </div>

      {/* Composer dock (Liquid Glass): floats over the transcript, 14px off
          the bottom, so the conversation flows under the permission card and
          the composer. Its height is published as `--glass-dock-inset`, which
          the transcript adds after its last row — at the bottom nothing rests
          under the glass. Everything in it stays in the order it had: the
          permission / question cards, then the ask-question and plan cards,
          the banner, feedback notes, the status strips (moved up from under
          the composer, which now sits on the window's bottom edge) and the
          composer itself. The cards and the composer are 12px wider than the
          text column on each side (`chat-content-w` + `px-1`). */}
      <div
        ref={dockRef}
        data-glass-dock=""
        className="pointer-events-none absolute inset-x-0 bottom-0 z-20 flex flex-col pb-[0.875rem] [&>*]:pointer-events-auto"
      >
        {/* Below the transcript, so outside its image scope: a request or a
            plan names local images the way a reply does, against the same
            folder. */}
        {/* Each dialog renders nothing while it has nothing to ask. */}
        <div className="mx-auto w-full chat-content-w px-1 empty:hidden">
          <MarkdownImageProvider rootPath={defaultPath ?? null}>
            <PermissionDialog
              permission={pendingPermission}
              onRespond={onRespondPermission}
              agentType={agentType}
            />
          </MarkdownImageProvider>
        </div>

        <div className="mx-auto w-full chat-content-w px-1 empty:hidden">
          <QuestionDialog
            question={pendingQuestion}
            onAnswer={onAnswerQuestion}
          />
        </div>

        {pendingAskQuestion && pendingAskQuestion.questions.length > 0 && (
          <div className="mx-auto w-full chat-content-w px-1">
            <AskQuestionCard
              question={pendingAskQuestion}
              onAnswer={onAnswerAskQuestion}
            />
          </div>
        )}
        {pendingPlanApproval && (
          <div className="mx-auto w-full chat-content-w px-1">
            {/* key on approval_id so the card always remounts (fresh in-flight /
                feedback state) if the slot is ever reused for a new approval. */}
            <MarkdownImageProvider rootPath={defaultPath ?? null}>
              <PlanApprovalCard
                key={pendingPlanApproval.approval_id}
                approval={pendingPlanApproval}
                onAnswer={onAnswerPlanApproval}
              />
            </MarkdownImageProvider>
          </div>
        )}

        {composerBanner && (
          <div className="mx-auto w-full chat-content-w px-1 pb-2">
            {composerBanner}
          </div>
        )}

        {!hideInput && feedbackList && (
          <div className="mx-auto w-full chat-content-w px-1">
            {feedbackList}
          </div>
        )}

        <div className="mx-auto w-full chat-content-w px-1 empty:hidden">
          <ComposerStatusStrips
            status={status}
            claudeApiRetry={claudeApiRetry}
            sessionFailures={sessionFailures}
            onSessionFailureDismiss={onSessionFailureDismiss}
          />
        </div>

        {!hideInput && (
          <div className="mx-auto w-full chat-content-w">
            <ChatInput
              hasMessages={hasMessages}
              status={status}
              promptCapabilities={promptCapabilities}
              defaultPath={defaultPath}
              agentName={agentName}
              onFocus={onFocus}
              onSend={onSend}
              onCancel={onCancel}
              modes={modes}
              configOptions={configOptions}
              modeLoading={modeLoading}
              configOptionsLoading={configOptionsLoading}
              selectorsLoading={selectorsLoading}
              selectedModeId={selectedModeId}
              onModeChange={onModeChange}
              onConfigOptionChange={onConfigOptionChange}
              agentType={agentType}
              availableCommands={availableCommands}
              promptSuggestion={promptSuggestion}
              attachmentTabId={attachmentTabId}
              folderPickerOverride={folderPickerOverride}
              draftStorageKey={draftStorageKey}
              getSentHistory={getSentHistory}
              isActive={isActive}
              showActiveFlow={showActiveFlow}
              queue={queue}
              onEnqueue={onEnqueue}
              onQueueReorder={onQueueReorder}
              onQueueEdit={onQueueEdit}
              onQueueDelete={onQueueDelete}
              onQueueRetry={onQueueRetry}
              queueFailedHeadNotice={queueFailedHeadNotice}
              onQueueSteer={onQueueSteer}
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
            />
          </div>
        )}
      </div>
    </div>
  )
}

/** Gap between the last transcript row and the floating dock (px). */
const DOCK_GAP_PX = 12

/**
 * Publish the floating dock's height on the shell as `--glass-dock-inset`, so
 * the transcript can end above it. A status capsule in a bottom corner of the
 * window (StatusCapsules) also lifts the dock when the two would overlap —
 * at narrow widths — so neither covers the other.
 */
function useGlassDockInset(
  shellRef: RefObject<HTMLDivElement | null>,
  dockRef: RefObject<HTMLDivElement | null>
) {
  useEffect(() => {
    const shell = shellRef.current
    const dock = dockRef.current
    if (!shell || !dock || typeof ResizeObserver === "undefined") return
    let frame = 0
    const update = () => {
      frame = 0
      let lift = 0
      const dockRect = dock.getBoundingClientRect()
      const content = dock.lastElementChild?.getBoundingClientRect()
      if (content && content.width > 0) {
        for (const capsule of document.querySelectorAll<HTMLElement>(
          "[data-status-capsule]"
        )) {
          const r = capsule.getBoundingClientRect()
          const overlapsX = r.left < content.right && r.right > content.left
          const sameBand = r.bottom > dockRect.bottom - 64
          if (overlapsX && sameBand) {
            lift = Math.max(lift, r.height + 8)
          }
        }
      }
      dock.style.setProperty("--glass-dock-lift", `${lift}px`)
      dock.style.paddingBottom = lift ? `calc(0.875rem + ${lift}px)` : ""
      shell.style.setProperty("--glass-dock-h", `${dock.offsetHeight}px`)
      shell.style.setProperty(
        "--glass-dock-inset",
        `${dock.offsetHeight + DOCK_GAP_PX}px`
      )
    }
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update)
    }
    const observer = new ResizeObserver(schedule)
    observer.observe(dock)
    observer.observe(shell)
    update()
    window.addEventListener("resize", schedule)
    return () => {
      observer.disconnect()
      window.removeEventListener("resize", schedule)
      if (frame) cancelAnimationFrame(frame)
    }
  }, [shellRef, dockRef])
}
