"use client"

import { useCallback, useEffect } from "react"
import { toast } from "sonner"
import {
  canvasCreateBoard,
  canvasDeleteBoard,
  canvasUpdateBoard,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { forgetCanvasBoardViewState } from "@/lib/canvas-view-storage"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import {
  CANVAS_BOARD_CHANGED_EVENT,
  CANVAS_CHANGED_EVENT,
  type CanvasBoardChange,
  type FolderDetail,
} from "@/lib/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useCanvasBoardsStore } from "@/stores/canvas-boards-store"

/** What the create / edit dialog hands back. Empty strings mean "none": the
 *  backend trims every field and stores blank as NULL, so an edit that empties
 *  a field clears it. */
export interface CanvasBoardFormValues {
  name: string
  description: string
  color: string
}

/**
 * The three board writes, shared by the canvas list and the breadcrumb menu
 * inside a board so both doors behave the same. Each resolves to whether it
 * succeeded — a dialog stays open on failure (the toast says why) so what the
 * user typed is not thrown away.
 */
export function useCanvasBoardActions() {
  const createBoard = useCallback(async (values: CanvasBoardFormValues) => {
    const before = useCanvasBoardsStore.getState()
    const scope = before.scope()
    try {
      const board = await canvasCreateBoard({
        name: values.name,
        description: values.description,
        color: values.color,
        // 建在当前项目下，只在这个项目的画布列表里出现。
        folderId: before.folderId,
      })
      const store = useCanvasBoardsStore.getState()
      // A new canvas is created to be worked on: open it straight away —
      // unless the answer belongs to a backend (or a project) this client has
      // since left.
      if (store.applyCreatedBoard(board, scope)) store.openBoard(board.id)
      return true
    } catch (e) {
      toast.error(toErrorMessage(e))
      return false
    }
  }, [])

  const updateBoard = useCallback(
    async (boardId: number, values: CanvasBoardFormValues) => {
      try {
        // The answer is not applied: the edit's own event (or, if the
        // transport dropped it, the reconnect read) is what updates the row —
        // see the boards store for why an answer can't be ordered safely.
        await canvasUpdateBoard(boardId, {
          name: values.name,
          description: values.description,
          color: values.color,
        })
        return true
      } catch (e) {
        toast.error(toErrorMessage(e))
        return false
      }
    },
    []
  )

  const deleteBoard = useCallback(async (boardId: number) => {
    // Leave it first: the board view unmounts (ending its fetches and letting
    // go of its live cards) before the rows it is drawing disappear under it.
    const store = useCanvasBoardsStore.getState()
    const scope = store.scope()
    if (store.activeBoardId === boardId) store.closeBoard()
    try {
      await canvasDeleteBoard(boardId)
      // Only in the scope that asked: after a backend switch the same id may
      // name some other backend's board.
      if (useCanvasBoardsStore.getState().removeBoard(boardId, scope)) {
        forgetCanvasBoardViewState(boardId)
      }
      return true
    } catch (e) {
      toast.error(toErrorMessage(e))
      return false
    }
  }, [])

  return { createBoard, updateBoard, deleteBoard }
}

/**
 * 画布列表按哪个项目取：侧栏当前项目的根文件夹（worktree 归到它的仓库，和思维导图
 * 一样）。没有当前项目、或者当前是聊天模式背后的文件夹时给 null，列出全部画布。
 * 项目列表还没取到时先用当前文件夹的 id，后端会自己找到它的项目。
 */
export function canvasProjectOf(
  activeFolderId: number | null,
  folders: readonly FolderDetail[]
): number | null {
  if (activeFolderId == null) return null
  const folder = folders.find((f) => f.id === activeFolderId)
  if (!folder) return activeFolderId
  if (folder.kind === "chat") return null
  return folder.parent_id ?? folder.id
}

/**
 * 让画布列表跟着侧栏的当前项目走（#1193）：项目变了就换成那个项目的画布重新读。
 * 画布页和列表各挂一次（同一个项目设第二次什么也不做），列表自己挂是为了它挂上
 * 时那一次读就带上项目，不先读一遍全部。
 */
export function useCanvasBoardsFolder(): void {
  const project = useAppWorkspaceStore((s) =>
    canvasProjectOf(s.activeFolderId, s.allFolders)
  )
  // 也看 store 里的：后端切换时 `reset()` 把它清掉，这里要再设回去。
  const current = useCanvasBoardsStore((s) => s.folderId)
  useEffect(() => {
    if (useCanvasBoardsStore.getState().setFolder(project)) {
      void useCanvasBoardsStore.getState().refetch()
    }
  }, [project, current])
}

/**
 * Keeps the board list live while the canvas route is mounted — the list
 * itself, and the breadcrumb inside a board, which names the board and must
 * notice it being deleted elsewhere. Subscribe first, read the list once the
 * listener is live (the same handshake as the node stream), refetch on a
 * transport reconnect since events are dropped while the socket is down.
 */
export function useCanvasBoardsData(): void {
  useCanvasBoardsFolder()
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<CanvasBoardChange>(
        CANVAS_BOARD_CHANGED_EVENT,
        (change) => useCanvasBoardsStore.getState().handleBoardChanged(change)
      )
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
      void useCanvasBoardsStore.getState().refetch()
    })()
    const offReconnect = onTransportReconnect(() =>
      useCanvasBoardsStore.getState().refetch()
    )
    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [])
}

/** How long node activity must be quiet before the list re-reads its counts
 *  and thumbnails. A drag in another window is one event per drop, but a busy
 *  board produces them in bursts — one read per burst is plenty for a card. */
const STATS_REFRESH_DELAY_MS = 800

/**
 * While the list is on screen, keep each card's node count and thumbnail
 * current: board rows arrive with their own events, but what is ON a board
 * only moves on the node stream. Re-reads the list on mount too — coming back
 * from inside a board is exactly when that board's card is stale.
 */
export function useCanvasBoardStatsRefresh(): void {
  useEffect(() => {
    void useCanvasBoardsStore.getState().refetch()
    let disposed = false
    let unlisten: (() => void) | undefined
    let timer: ReturnType<typeof setTimeout> | null = null
    void (async () => {
      const dispose = await subscribe(CANVAS_CHANGED_EVENT, () => {
        if (timer != null) clearTimeout(timer)
        timer = setTimeout(() => {
          timer = null
          void useCanvasBoardsStore.getState().refetch()
        }, STATS_REFRESH_DELAY_MS)
      })
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
      if (timer != null) clearTimeout(timer)
    }
  }, [])
}
