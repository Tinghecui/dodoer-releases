"use client"

import { useEffect } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { ensureSeenHydrated } from "@/stores/conversation-seen-store"

/** Loads the stored sidebar "unread" data for the active backend (jenny fork).
 *
 *  Opening or viewing a conversation deliberately does NOT clear its unread
 *  marker — only the sidebar menu's "Accepted" action does — so all this does
 *  is hydrate, re-checking when the conversation list reloads (cheap no-op
 *  unless the backend changed). Mounted in the workspace layout (not the
 *  sidebar, which unmounts when collapsed). Renders nothing. */
export function ConversationSeenTracker() {
  const conversations = useAppWorkspaceStore((s) => s.conversations)

  useEffect(() => {
    ensureSeenHydrated()
  }, [conversations])

  return null
}
