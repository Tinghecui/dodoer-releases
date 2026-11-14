"use client"

import { useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { conversationPrStatuses, folderPrStatuses } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  agentPrConversationIds,
  CONVERSATION_PR_STATUS_EVENT,
  FOLDER_PR_STATUS_EVENT,
  worktreeFolderIds,
} from "@/lib/pr-status"
import type {
  ConversationPrStatusEntry,
  FolderPrStatusEntry,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  applyConversationPrStatuses,
  applyPrStatuses,
  loadPrStatusEnabled,
  usePrStatusStore,
} from "@/stores/pr-status-store"

/** How often the visible sidebar asks. Cheap: the backend answers from its
 *  cache and only goes to the forge for folders that are due (20 s while
 *  checks run, minutes otherwise). The ask itself is the lease — nobody
 *  looking, nothing fetched. */
const POLL_MS = 20_000

const GIT_PUSH_SUCCEEDED_EVENT = "folder://git-push-succeeded"

/** Poll `ask` for `idsKey` (comma-joined ids; empty = nothing to ask) while
 *  the page is visible; restarts when the set changes so a new id is asked
 *  about at once. */
function usePoll<E>(
  idsKey: string,
  ask: (ids: number[]) => Promise<E[]>,
  apply: (entries: E[]) => void
) {
  useEffect(() => {
    if (!idsKey) return
    const ids = idsKey.split(",").map(Number)
    let cancelled = false
    let inFlight = false
    const poll = async () => {
      if (inFlight || cancelled) return
      if (typeof document !== "undefined" && document.hidden) return
      inFlight = true
      try {
        const entries = await ask(ids)
        if (!cancelled) apply(entries)
      } catch {
        // A failed ask leaves the last answers up; the next tick tries again.
      } finally {
        inFlight = false
      }
    }
    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    const onVisible = () => {
      if (!document.hidden) void poll()
    }
    document.addEventListener("visibilitychange", onVisible)
    // Pushes sent while the WebSocket was down are lost; ask again.
    const offReconnect = onTransportReconnect(() => void poll())
    return () => {
      cancelled = true
      clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisible)
      offReconnect?.()
    }
  }, [idsKey, ask, apply])
}

/** Apply `event`'s pushes: another client's (or this one's) refresh found a
 *  change. */
function usePushes<E>(event: string, apply: (entries: E[]) => void) {
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<E>(event, (entry) => apply([entry]))
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [event, apply])
}

const askFolders = (ids: number[]) => folderPrStatuses(ids)
const askConversations = (ids: number[]) => conversationPrStatuses(ids)

/**
 * Keeps `usePrStatusStore` filled for the worktree folders the sidebar lists,
 * and for the Claude conversations outside them (whose agent may have made a
 * worktree itself or opened a pull request — `agentPrConversationIds`).
 * Renders nothing; mounted once with the sidebar.
 *
 * Besides the poll, a folder (or such a conversation) is refreshed right away
 * (forced) when a conversation in it finishes a turn — the agent may just
 * have pushed or opened the pull request — and a folder when codeg itself
 * pushes from it.
 */
export function PrStatusPoller() {
  const enabled = usePrStatusStore((s) => s.enabled)
  const folderIds = useAppWorkspaceStore(
    useShallow((s) => worktreeFolderIds(s.allFolders, s.conversations))
  )
  const conversationIds = useAppWorkspaceStore(
    useShallow((s) => agentPrConversationIds(s.allFolders, s.conversations))
  )
  // Read by the subscriptions below, which outlive any one render.
  const idsRef = useRef<number[]>([])
  const conversationIdsRef = useRef<number[]>([])
  useEffect(() => {
    idsRef.current = enabled ? folderIds : []
    conversationIdsRef.current = enabled ? conversationIds : []
  }, [enabled, folderIds, conversationIds])

  useEffect(() => {
    usePrStatusStore.setState({ enabled: loadPrStatusEnabled() })
  }, [])

  usePoll(enabled ? folderIds.join(",") : "", askFolders, applyPrStatuses)
  usePoll(
    enabled ? conversationIds.join(",") : "",
    askConversations,
    applyConversationPrStatuses
  )
  usePushes<FolderPrStatusEntry>(FOLDER_PR_STATUS_EVENT, applyPrStatuses)
  usePushes<ConversationPrStatusEntry>(
    CONVERSATION_PR_STATUS_EVENT,
    applyConversationPrStatuses
  )

  // Forced refreshes: a turn ended in a worktree (or in a conversation asked
  // about on its own), or codeg pushed from a worktree.
  useEffect(() => {
    const force = (ids: number[]) => {
      const listed = ids.filter((id) => idsRef.current.includes(id))
      if (listed.length === 0) return
      void folderPrStatuses(listed, true)
        .then(applyPrStatuses)
        .catch(() => {})
    }
    const forceConversations = (ids: number[]) => {
      const listed = ids.filter((id) => conversationIdsRef.current.includes(id))
      if (listed.length === 0) return
      void conversationPrStatuses(listed, true)
        .then(applyConversationPrStatuses)
        .catch(() => {})
    }

    let running = new Map<number, number>()
    const seed = (
      conversations: readonly {
        id: number
        status: string
        folder_id: number
      }[]
    ) => {
      const next = new Map<number, number>()
      for (const c of conversations) {
        if (c.status === "in_progress") next.set(c.id, c.folder_id)
      }
      return next
    }
    running = seed(useAppWorkspaceStore.getState().conversations)
    const offStore = useAppWorkspaceStore.subscribe((state, prev) => {
      if (state.conversations === prev.conversations) return
      const now = seed(state.conversations)
      const ended = new Set<number>()
      const endedConversations: number[] = []
      for (const [id, folderId] of running) {
        if (now.has(id)) continue
        ended.add(folderId)
        endedConversations.push(id)
      }
      running = now
      if (ended.size > 0) force([...ended])
      if (endedConversations.length > 0) forceConversations(endedConversations)
    })

    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<{ folder_id: number }>(
        GIT_PUSH_SUCCEEDED_EVENT,
        (event) => force([event.folder_id])
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      offStore()
      disposed = true
      unlisten?.()
    }
  }, [])

  return null
}
