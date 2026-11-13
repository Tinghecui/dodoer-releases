"use client"

import { Glass } from "@/components/ui/glass"
import { RightChromePortal } from "@/components/layout/right-chrome-slot"
import { cn } from "@/lib/utils"
import { memo, useCallback, useState, type ReactNode } from "react"
import {
  ChevronRight,
  Circle,
  EllipsisVertical,
  Info,
  Pencil,
  Pin,
  PinOff,
  SquarePen,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { useImeGuard } from "@/hooks/use-ime-guard"
import {
  deleteConversation,
  updateConversationPinned,
  updateConversationStatus,
  updateConversationTitle,
} from "@/lib/api"
import { formatConversationTitle } from "@/lib/conversation-title"
import { ConversationHeaderFolderPicker } from "@/components/chat/conversation-context-bar"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabActions } from "@/contexts/tab-context"
import { getRuntimeSession } from "@/stores/conversation-runtime-store"
import { withoutUnreadChange } from "@/stores/conversation-seen-store"
import type { ConversationStatus } from "@/lib/types"
import { MANUAL_STATUS_ORDER } from "@/lib/types"
import { ConversationStatusDot } from "@/components/conversations/conversation-status-dot"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  resolveActiveSessionDetails,
  type ActiveSessionDetails,
} from "./active-session-details"
import { SessionDetailsDialog } from "./session-details-dialog"
import { ConversationMindMapTrail } from "./conversation-mindmap-trail"
import { ConversationHeaderTags } from "./conversation-tag-picker"
import { useIsMobile } from "@/hooks/use-mobile"

// jenny fork: run a hand edit (rename, status) that leaves unread as it was.
// See `withoutUnreadChange`.
function keepingUnread(id: number, edit: () => Promise<void>): Promise<void> {
  const summary = useAppWorkspaceStore
    .getState()
    .conversations.find((c) => c.id === id)
  return summary ? withoutUnreadChange(summary, edit) : edit()
}

interface ConversationDetailHeaderProps {
  leadingReserve?: ReactNode
  trailingReserve?: ReactNode
  /** Extra buttons before the More actions menu (the panel's maximize). */
  actions?: ReactNode
  /** Move those buttons into the window's top-right capsule (this bar reaches
   *  that corner). */
  actionsInCorner?: boolean
  tabId: string
  /** Persisted DB id — null for an unsaved draft (rename / pin / status /
   *  details / delete disabled until the first send persists the row). */
  conversationId: number | null
  /** Virtual runtime key a new conversation streams under before it reconciles
   *  to `conversationId`; used to resolve live session details. */
  runtimeConversationId: number | null
  folderId: number
  folderPath: string | undefined
  title: string
  status: ConversationStatus | undefined
}

/**
 * Conversation detail header (desktop only): the owning folder name + the
 * conversation title on the left; an overflow (⋯) menu on the right. A single
 * instance renders fixed above the tile scroll area, scoped to the ACTIVE
 * conversation, so it never scrolls horizontally when many conversations are
 * tiled.
 *
 * The ⋯ menu mirrors the sidebar conversation card's right-click menu (new /
 * rename / pin / details / status / delete) so the two entry points stay
 * consistent, wired to the same APIs. Subscriptions are kept narrow — a
 * primitive `pinned_at != null` boolean — so the header never re-renders on
 * streaming tokens; details data is read on demand at click time via
 * `getRuntimeSession` / store `getState`.
 */
export const ConversationDetailHeader = memo(function ConversationDetailHeader({
  leadingReserve,
  trailingReserve,
  actions,
  actionsInCorner = false,
  tabId,
  conversationId,
  runtimeConversationId,
  folderId,
  folderPath,
  title,
  status,
}: ConversationDetailHeaderProps) {
  const t = useTranslations("Folder.conversationCard")
  const ime = useImeGuard()
  const tConv = useTranslations("Folder.conversation")
  const tStatus = useTranslations("Folder.statusLabels")
  const tDetails = useTranslations("Folder.sessionDetails")
  const { closeTab, openNewConversationTab } = useTabActions()
  const updateConversationLocal = useAppWorkspaceStore(
    (s) => s.updateConversationLocal
  )
  const refreshConversations = useAppWorkspaceStore(
    (s) => s.refreshConversations
  )
  // A brand-new (draft-origin) conversation keeps streaming under its virtual
  // runtime key even after it persists — its DB row exists, but the live
  // session (detail/turns) stays keyed by `runtimeConversationId`. So details
  // must target that key; the runtime store resolves the fetchable DB id from
  // it. Rename/pin/status/delete act on `conversationId` (the DB row).
  const runtimeId = runtimeConversationId ?? conversationId
  // Narrow reactive read: a primitive-derived boolean that doesn't change on
  // streaming tokens, so the header stays inert mid-turn.
  const isPinned = useAppWorkspaceStore(
    (s) =>
      conversationId != null &&
      (s.conversations.find((c) => c.id === conversationId)?.pinned_at ??
        null) != null
  )
  // Tags: offered only on a ROOT conversation of the sidebar list — the same
  // rows the sidebar lets you tag (a sub-session opened in a tab is not one).
  // Both reads are narrow: a boolean, and the row's own `tag_ids` array, whose
  // reference only changes when its tags do.
  const taggable = useAppWorkspaceStore(
    (s) =>
      conversationId != null &&
      s.conversations.some((c) => c.id === conversationId)
  )
  const tagIds = useAppWorkspaceStore((s) =>
    conversationId == null
      ? undefined
      : s.conversations.find((c) => c.id === conversationId)?.tag_ids
  )
  const gitBranch = useAppWorkspaceStore((s) =>
    conversationId == null
      ? null
      : (s.conversations.find((c) => c.id === conversationId)?.git_branch ??
        null)
  )
  const isMobile = useIsMobile()

  const [details, setDetails] = useState<ActiveSessionDetails | null>(null)
  // Snapshot the action target when a dialog OPENS. The header is a SINGLE
  // instance reused across active tabs (see conversation-detail-panel), and the
  // global tab-switch / close-tab shortcuts still fire while a dialog is open —
  // so a rename/delete confirm must act on the conversation the dialog was
  // opened for, not whatever happens to be active at confirm time.
  const [renameTarget, setRenameTarget] = useState<{
    id: number
    title: string
  } | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number
    tabId: string
    title: string
  } | null>(null)

  const persisted = conversationId != null
  const displayTitle =
    formatConversationTitle(title) || t("untitledConversation")

  const handleTogglePin = useCallback(() => {
    if (conversationId == null) return
    const next = !isPinned
    // Optimistic: instantly reorder the sidebar row; the upsert echo reconciles
    // the server `pinned_at` (mirrors sidebar card handleTogglePin).
    updateConversationLocal(conversationId, {
      pinned_at: next ? new Date().toISOString() : null,
    })
    updateConversationPinned(conversationId, next).catch((err) => {
      console.error("[ConversationDetailHeader] toggle pin:", err)
    })
  }, [conversationId, isPinned, updateConversationLocal])

  const handleNewConversation = useCallback(() => {
    if (!folderPath) return
    // Keep the active agent when the folder has no pinned default (matches the
    // panel's right-click "new conversation").
    openNewConversationTab(folderId, folderPath, { inheritFromActive: true })
  }, [folderId, folderPath, openNewConversationTab])

  const handleRenameOpen = useCallback(() => {
    if (conversationId == null) return
    setRenameValue(title || "")
    setRenameTarget({ id: conversationId, title })
  }, [conversationId, title])

  const handleRenameConfirm = useCallback(async () => {
    if (renameTarget == null) return
    const trimmed = renameValue.trim()
    if (trimmed && trimmed !== renameTarget.title) {
      try {
        // jenny fork: a rename leaves unread as it was (only 已验收 clears it).
        await keepingUnread(renameTarget.id, () =>
          updateConversationTitle(renameTarget.id, trimmed)
        )
        refreshConversations()
      } catch (err) {
        console.error("[ConversationDetailHeader] rename:", err)
      }
    }
    setRenameTarget(null)
  }, [renameTarget, renameValue, refreshConversations])

  const handleStatusChange = useCallback(
    (next: ConversationStatus) => {
      if (conversationId == null) return
      // Optimistic local patch, then persist (mirrors sidebar handleStatusChange).
      // jenny fork: a status set by hand leaves unread as it was. Read the
      // summary before the optimistic patch changes its status.
      const persist = keepingUnread(conversationId, () =>
        updateConversationStatus(conversationId, next)
      )
      updateConversationLocal(conversationId, { status: next })
      persist.catch((err) => {
        console.error("[ConversationDetailHeader] status change:", err)
      })
    },
    [conversationId, updateConversationLocal]
  )

  const handleDeleteOpen = useCallback(() => {
    if (conversationId == null) return
    setDeleteTarget({ id: conversationId, tabId, title: displayTitle })
  }, [conversationId, tabId, displayTitle])

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTarget == null) return
    try {
      await deleteConversation(deleteTarget.id)
      // The deleted conversation is gone — close its tab and refresh the list.
      // Not recorded for reopen: there is no longer a conversation to reopen.
      closeTab(deleteTarget.tabId, { recordForReopen: false })
      refreshConversations()
    } catch (err) {
      console.error("[ConversationDetailHeader] delete:", err)
    }
    setDeleteTarget(null)
  }, [deleteTarget, closeTab, refreshConversations])

  const handleOpenDetails = useCallback(() => {
    // Resolve on demand (no reactive whole-session subscription) via the same
    // helper the panel uses; `runtimeId` covers the virtual-key case.
    if (runtimeId == null) return
    const session = getRuntimeSession(runtimeId)
    const conversations = useAppWorkspaceStore.getState().conversations
    const resolved = resolveActiveSessionDetails(
      {
        conversationId,
        runtimeConversationId: runtimeConversationId ?? undefined,
      },
      (id) => (id === runtimeId ? session : null),
      conversations
    )
    if (!resolved.summary) return
    setDetails(resolved)
  }, [conversationId, runtimeConversationId, runtimeId])

  // "More actions", with the maximize/restore button beside it (fusion).
  const buttons = (
    <>
      {actions}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className="flex h-7 w-[1.875rem] shrink-0 items-center justify-center rounded-full text-[var(--ink2)] transition-colors hover:bg-[var(--g-hover)] hover:text-foreground"
            aria-label={tConv("moreActions")}
            title={tConv("moreActions")}
          >
            <EllipsisVertical className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            disabled={!folderPath}
            onSelect={handleNewConversation}
          >
            <SquarePen className="h-4 w-4" />
            {t("newConversation")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!persisted} onSelect={handleRenameOpen}>
            <Pencil className="h-4 w-4" />
            {t("rename")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!persisted} onSelect={handleTogglePin}>
            {isPinned ? (
              <PinOff className="h-4 w-4" />
            ) : (
              <Pin className="h-4 w-4" />
            )}
            {isPinned ? t("unpin") : t("pin")}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!persisted} onSelect={handleOpenDetails}>
            <Info className="h-4 w-4" />
            {tDetails("menuLabel")}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!persisted}>
              <Circle className="h-4 w-4" />
              {t("status")}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {/* Cowork fork: never `in_progress` by hand (#164). */}
              {MANUAL_STATUS_ORDER.filter((s) => s !== status).map((s) => (
                <DropdownMenuItem
                  key={s}
                  onSelect={() => handleStatusChange(s)}
                >
                  <ConversationStatusDot status={s} />
                  {tStatus(s)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            disabled={!persisted}
            onSelect={handleDeleteOpen}
          >
            <Trash2 className="h-4 w-4" />
            {t("delete")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  return (
    <div
      data-conversation-top-bar
      data-tauri-drag-region
      // Liquid Glass: a 52px top bar with no divider — the scroll edge fade
      // under it (ConversationTopEdge) takes the line's place. The title,
      // branch and tag chips are plain text, not glass.
      // jenny fork: on the desktop its row is centred on the traffic lights'
      // line, 31px down, with the sidebar head and the corner capsule.
      className={cn(
        "relative z-20 flex h-[3.25rem] shrink-0 items-center",
        !isMobile && "pt-2.5"
      )}
    >
      {leadingReserve}
      <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-4">
        {/* Folder selector — replaces the old folder-name breadcrumb. Switches
            folders for a draft; a static chip for a bound conversation. */}
        <ConversationHeaderFolderPicker tabId={tabId} />
        <ChevronRight
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50"
          aria-hidden
        />
        {/* jenny fork: the categories it sits in on the project's mind map. */}
        {conversationId != null ? (
          <ConversationMindMapTrail
            conversationId={conversationId}
            folderId={folderId}
          />
        ) : null}
        {/* The title takes the ellipsis, so the folder crumb on the left stays
            fully visible — but grows only as far as its own text
            (`max-w-max`), so the tags follow it instead of the far edge. */}
        <span
          data-tauri-drag-region
          className="min-w-0 max-w-max flex-1 truncate text-[0.84375rem] font-semibold text-foreground"
          title={title}
        >
          {displayTitle}
        </span>
        {/* Capped at half the row so a long tag list squeezes its own chips
            (they truncate) before it squeezes the title. */}
        {taggable && conversationId != null ? (
          <div className="flex max-w-[50%] min-w-0 shrink items-center">
            <ConversationHeaderTags
              conversationId={conversationId}
              folderId={folderId}
              tagIds={tagIds}
              gitBranch={gitBranch}
              max={isMobile ? 1 : 3}
            />
          </div>
        ) : null}
      </div>
      {/* jenny fork: in the window's top-right capsule while this bar reaches
          that corner (RightChromePortal); else a round glass button here —
          with maximize/restore beside it, the two share one capsule. */}
      <RightChromePortal
        enabled={actionsInCorner}
        fallback={
          <div className="flex shrink-0 items-center pl-2 pr-1 max-md:pr-3">
            <Glass
              interactive
              data-top-bar-actions=""
              className={cn(
                "flex h-8 shrink-0 items-center justify-center rounded-full",
                actions ? "gap-0.5 px-0.5" : "w-8"
              )}
            >
              {buttons}
            </Glass>
          </div>
        }
      >
        {buttons}
      </RightChromePortal>
      {trailingReserve}

      <Dialog
        open={renameTarget != null}
        onOpenChange={(o) => {
          if (!o) setRenameTarget(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("renameConversation")}</DialogTitle>
          </DialogHeader>
          <Input
            value={renameValue}
            onChange={(e) => setRenameValue(e.target.value)}
            {...ime.props}
            onKeyDown={(e) => {
              if (ime.isComposing(e)) return
              if (e.key === "Enter") handleRenameConfirm()
            }}
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameTarget(null)}>
              {t("cancel")}
            </Button>
            <Button onClick={handleRenameConfirm}>{t("save")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={deleteTarget != null}
        onOpenChange={(o) => {
          if (!o) setDeleteTarget(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConversationTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConversationDescription", {
                title: deleteTarget?.title ?? "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDeleteConfirm}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {details?.summary && (
        <SessionDetailsDialog
          open
          onOpenChange={(o) => {
            if (!o) setDetails(null)
          }}
          summary={details.summary}
          stats={details.stats}
          model={details.model}
        />
      )}
    </div>
  )
})
