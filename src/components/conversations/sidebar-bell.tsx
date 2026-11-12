"use client"

import { useMemo } from "react"
import { Bell } from "lucide-react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAwaitingUserStore } from "@/stores/awaiting-user-store"
import {
  countUnreadByGroup,
  useConversationSeenStore,
} from "@/stores/conversation-seen-store"
import { Button } from "@/components/ui/button"
import {
  AwaitingCountBadge,
  RunningCountBadge,
  UnreadCountBadge,
} from "./sidebar-unread-badge"

export function SidebarBell({
  pressed,
  onClick,
}: {
  pressed: boolean
  onClick: () => void
}) {
  const t = useTranslations("Folder.sidebar")
  const allConversations = useAppWorkspaceStore((s) => s.conversations)
  const folders = useAppWorkspaceStore((s) => s.folders)
  // jenny fork: only what the sidebar can show — open folders, chats and
  // pinned rows — the same sessions the project rows count. A session in a
  // folder closed from the workspace has no row to accept it from, so it
  // must not hold the bell's count up.
  const conversations = useMemo(() => {
    const open = new Set(folders.map((f) => f.id))
    return allConversations.filter(
      (c) => open.has(c.folder_id) || c.kind === "chat" || c.pinned_at != null
    )
  }, [allConversations, folders])
  const seenState = useConversationSeenStore(
    useShallow((s) => ({
      baselineAt: s.baselineAt,
      seen: s.seen,
      markedUnread: s.markedUnread,
    }))
  )
  const awaitingBySession = useAwaitingUserStore((s) => s.bySession)
  // Roots only: a sub-agent's prompt already marks its parent's session.
  const awaiting = conversations.filter(
    (c) =>
      c.parent_id == null &&
      c.external_id != null &&
      awaitingBySession.has(c.external_id)
  ).length
  const running = conversations.filter((c) => c.status === "in_progress").length
  const unread =
    countUnreadByGroup(conversations, seenState, () => 0).get(0) ?? 0
  const label = t("sortBySessionActivity")

  return (
    <Button
      variant="ghost"
      size="icon"
      className="lg-ib h-6 w-auto min-w-6 shrink-0 gap-0.5 rounded-full px-1 text-[var(--ink2)] hover:bg-[var(--g-hover)] aria-pressed:bg-[var(--g-sel)] dark:hover:bg-[var(--g-hover)]"
      data-sidebar-bell=""
      aria-pressed={pressed}
      aria-label={label}
      title={label}
      onClick={onClick}
    >
      <Bell aria-hidden="true" className="h-[0.9375rem] w-[0.9375rem]" />
      <AwaitingCountBadge count={awaiting} />
      <RunningCountBadge count={running} global />
      <UnreadCountBadge count={unread} global />
    </Button>
  )
}
