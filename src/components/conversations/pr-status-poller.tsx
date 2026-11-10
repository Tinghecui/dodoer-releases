"use client"

import { useEffect, useRef } from "react"
import { useShallow } from "zustand/react/shallow"
import { folderPrStatuses } from "@/lib/api"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { FOLDER_PR_STATUS_EVENT, worktreeFolderIds } from "@/lib/pr-status"
import type { FolderPrStatusEntry } from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
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

/**
 * Keeps `usePrStatusStore` filled for the worktree folders the sidebar lists.
 * Renders nothing; mounted once with the sidebar.
 *
 * Besides the poll, a folder is refreshed right away (forced) when a
 * conversation in it finishes a turn — the agent may just have pushed or
 * opened the pull request — and when codeg itself pushes from it.
 */
export function PrStatusPoller() {
  const enabled = usePrStatusStore((s) => s.enabled)
  const folderIds = useAppWorkspaceStore(
    useShallow((s) => worktreeFolderIds(s.allFolders, s.conversations))
  )
  // Read by the subscriptions below, which outlive any one render.
  const idsRef = useRef<number[]>([])
  useEffect(() => {
    idsRef.current = enabled ? folderIds : []
  }, [enabled, folderIds])

  useEffect(() => {
    usePrStatusStore.setState({ enabled: loadPrStatusEnabled() })
  }, [])

  // Periodic poll of every listed worktree; restarts when the set changes so
  // a new worktree is asked about at once.
  const idsKey = enabled ? folderIds.join(",") : ""
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
        const entries = await folderPrStatuses(ids)
        if (!cancelled) applyPrStatuses(entries)
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
  }, [idsKey])

  // Pushes: another client's (or this one's) refresh found a change.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<FolderPrStatusEntry>(
        FOLDER_PR_STATUS_EVENT,
        (entry) => applyPrStatuses([entry])
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Forced refreshes: a turn ended in a worktree, or codeg pushed from one.
  useEffect(() => {
    const force = (ids: number[]) => {
      const listed = ids.filter((id) => idsRef.current.includes(id))
      if (listed.length === 0) return
      void folderPrStatuses(listed, true)
        .then(applyPrStatuses)
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
      for (const [id, folderId] of running) {
        if (!now.has(id)) ended.add(folderId)
      }
      running = now
      if (ended.size > 0) force([...ended])
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
