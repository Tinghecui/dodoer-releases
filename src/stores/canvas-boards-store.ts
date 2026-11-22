import { create } from "zustand"
import { canvasListBoards } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  CanvasBoard,
  CanvasBoardChange,
  CanvasBoardSummary,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/**
 * The canvas list, and which canvas the canvas route is showing.
 *
 * Board rows are small, full-state and idempotent on the wire (`upsert` /
 * `deleted` on `canvas-board://changed`), so there is no revision protocol
 * here. Events apply in arrival order — the backend broadcasts them in commit
 * order, one per board write — and a list read replaces the list; together
 * they are the only sources of a row's CONTENT. The races around them:
 *
 *  - A list read already in flight when an event lands may have read before
 *    that event's commit. Changes applied while a read is out are recorded and
 *    replayed on top of its answer; events lost while the transport was down
 *    are covered by the refetch every reconnect triggers.
 *  - The answer to our own edit is deliberately NOT applied. It travels apart
 *    from the events, so nothing orders it against them or against a list
 *    read: applied late, it could paint over a newer edit that reached this
 *    client only through a read. The edit's own event (emitted before the
 *    answer) or the reconnect read is what shows it.
 *  - The answer to our own create only ever ADDS a board no event or read has
 *    shown yet — a row that is already here is at least as new — so the new
 *    canvas can be opened at once.
 *  - A deleted board is remembered (a tombstone, for this backend scope), so a
 *    late create answer or a stale read can never bring it back. Ids are never
 *    handed out twice (`canvas_board.id` is AUTOINCREMENT), so a tombstone
 *    cannot hide a board that really exists.
 *  - Answers to requests sent before a `reset()` (another backend) carry the
 *    old scope and are ignored: their ids mean nothing in the new one.
 */
interface CanvasBoardsState {
  /** Every board, most recently edited first. */
  boards: readonly CanvasBoardSummary[]
  /** The first list landed. */
  hydrated: boolean
  /** Why the last list fetch failed, while nothing newer has loaded. The list
   *  keeps whatever it had and offers a retry. */
  loadError: string | null
  /** A list read is out. Lets an empty list show a spinner instead of the
   *  "no canvases" call to action until the read says it really is empty. */
  refetching: boolean
  /** 列表按哪个项目取（项目根文件夹的 id，见 `canvasProjectOf`）；null = 不分
   *  项目、全部列出。画布按项目分开（#1193）：列表里只有这个项目的画布和不属于
   *  任何项目的画布，别的项目的画布事件不进列表。 */
  folderId: number | null
  /** 换项目。变了就丢掉在途的读、把列表里别的项目的画布拿掉并标成没读完，开着的
   *  画布属于别的项目就退回列表。返回有没有变：变了调用方接着 `refetch()`。 */
  setFolder: (folderId: number | null) => boolean
  /** The board the canvas route shows, or null for the list. Session memory:
   *  leaving the route and coming back returns to the same board, while a
   *  fresh start (like every full-page route) begins at the list. */
  activeBoardId: number | null
  /** A board that was open when it was deleted elsewhere, so the page can say
   *  why it just left it. Cleared by `acknowledgeClosedNotice`. */
  closedNotice: number | null
  openBoard: (boardId: number) => void
  closeBoard: () => void
  /** Leave the open board because it no longer exists, with the notice. */
  closeMissingBoard: (boardId: number) => void
  acknowledgeClosedNotice: () => void
  /** The backend scope a request is sent in; hand it back with the answer.
   *  Changes on every `reset()`. */
  scope: () => number
  /** The answer to our own create: added unless an event or read has already
   *  shown the board (that row is at least as new), it was deleted meanwhile,
   *  it belongs to another project than the one listed now, or `scope` is
   *  stale. Returns whether the answer still belongs here. */
  applyCreatedBoard: (board: CanvasBoard, scope: number) => boolean
  /** The answer to our own delete: drop and tombstone the board, unless
   *  `scope` is stale. Returns whether the answer still belongs here. */
  removeBoard: (boardId: number, scope: number) => boolean
  handleBoardChanged: (change: CanvasBoardChange) => void
  /** Re-read the list. Coalesces: a call while one is in flight schedules
   *  exactly one more after it, so the last answer is never older than the
   *  last request. */
  refetch: () => Promise<void>
  reset: () => void
}

type BoardOp =
  /** A board event: insert or replace, unconditionally — events are ordered. */
  | { kind: "event"; board: CanvasBoard }
  /** Our create's answer: insert only if absent. */
  | { kind: "created"; board: CanvasBoard }
  | { kind: "delete"; id: number }

/** `board` 在按 `folderId` 取的列表里该不该出现。 */
export function boardInFolder(
  board: CanvasBoard,
  folderId: number | null
): boolean {
  return (
    folderId == null || board.folder_id == null || board.folder_id === folderId
  )
}

/** Display order only — never used to decide which of two rows is newer. */
function compareRecent(a: CanvasBoardSummary, b: CanvasBoardSummary): number {
  const ta = Date.parse(a.board.updated_at)
  const tb = Date.parse(b.board.updated_at)
  if (tb !== ta)
    return (Number.isNaN(tb) ? 0 : tb) - (Number.isNaN(ta) ? 0 : ta)
  return b.board.id - a.board.id
}

function applyOp(
  boards: readonly CanvasBoardSummary[],
  op: BoardOp,
  deleted: ReadonlySet<number>,
  folderId: number | null
): readonly CanvasBoardSummary[] {
  if (op.kind === "delete") {
    const next = boards.filter((s) => s.board.id !== op.id)
    return next.length === boards.length ? boards : next
  }
  if (deleted.has(op.board.id)) return boards
  // 别的项目的画布不进这个项目的列表（画布不会换项目，所以也不会在列表里）。
  if (!boardInFolder(op.board, folderId)) return boards
  const index = boards.findIndex((s) => s.board.id === op.board.id)
  if (index < 0) {
    // New to us: no nodes yet as far as this client knows — the counts and
    // thumbnail arrive with the next list read.
    return [
      ...boards,
      { board: op.board, node_count: 0, terminal_count: 0, preview: [] },
    ].sort(compareRecent)
  }
  if (op.kind === "created") return boards
  const known = boards[index]
  const next = boards.slice()
  // Only the board row changed; what is ON it is still what we last read.
  next[index] = { ...known, board: op.board }
  return next.sort(compareRecent)
}

let fetchInFlight: Promise<void> | null = null
/** A refetch was requested while one was in flight. */
let fetchAgain = false
/** Changes applied since the in-flight fetch started, replayed onto its
 *  answer. Null while no fetch is in flight. */
let opsSinceFetch: BoardOp[] | null = null
/** Bumped by reset(): a list from before it must not land after it. */
let fetchEpoch = 0
/** The backend scope, bumped by every reset(). */
let scopeEpoch = 0
/** Boards deleted in this backend scope. */
const deletedBoards = new Set<number>()

export const useCanvasBoardsStore = create<CanvasBoardsState>((set, get) => {
  const apply = (op: BoardOp) => {
    opsSinceFetch?.push(op)
    const boards = applyOp(get().boards, op, deletedBoards, get().folderId)
    if (boards !== get().boards) set({ boards })
  }
  const forget = (boardId: number) => {
    deletedBoards.add(boardId)
    apply({ kind: "delete", id: boardId })
  }

  return {
    boards: [],
    hydrated: false,
    loadError: null,
    refetching: false,
    folderId: null,
    activeBoardId: null,
    closedNotice: null,

    setFolder: (folderId) => {
      if (get().folderId === folderId) return false
      // 上一个项目的读回来时已经不算数了。
      fetchEpoch++
      fetchInFlight = null
      fetchAgain = false
      opsSinceFetch = null
      const { boards, activeBoardId } = get()
      const active = boards.find((s) => s.board.id === activeBoardId)
      set({
        folderId,
        boards: boards.filter((s) => boardInFolder(s.board, folderId)),
        // 没读到这个项目的列表之前显示加载中，不显示「还没有画布」。
        hydrated: false,
        loadError: null,
        refetching: false,
        activeBoardId:
          active && !boardInFolder(active.board, folderId)
            ? null
            : activeBoardId,
      })
      return true
    },

    openBoard: (boardId) => set({ activeBoardId: boardId }),

    closeBoard: () => set({ activeBoardId: null }),

    closeMissingBoard: (boardId) => {
      if (get().activeBoardId !== boardId) return
      set({ activeBoardId: null, closedNotice: boardId })
    },

    acknowledgeClosedNotice: () => set({ closedNotice: null }),

    scope: () => scopeEpoch,

    applyCreatedBoard: (board, scope) => {
      if (scope !== scopeEpoch) return false
      // 建的时候在别的项目，回来时已经换了项目：不打开它。
      if (!boardInFolder(board, get().folderId)) return false
      apply({ kind: "created", board })
      return true
    },

    removeBoard: (boardId, scope) => {
      if (scope !== scopeEpoch) return false
      forget(boardId)
      return true
    },

    handleBoardChanged: (change) => {
      if (change.kind === "upsert") {
        apply({ kind: "event", board: change.board })
        return
      }
      forget(change.id)
      // Deleted out from under a client that had it open: leave, and say why.
      get().closeMissingBoard(change.id)
    },

    refetch: () => {
      if (fetchInFlight) {
        fetchAgain = true
        return fetchInFlight
      }
      const epoch = fetchEpoch
      const folderId = get().folderId
      opsSinceFetch = []
      set({ refetching: true })
      const settle = () => {
        fetchInFlight = null
        opsSinceFetch = null
        if (fetchAgain) {
          fetchAgain = false
          void get().refetch()
        }
      }
      fetchInFlight = canvasListBoards(folderId)
        .then((list) => {
          if (epoch !== fetchEpoch) return
          let boards: readonly CanvasBoardSummary[] = list.filter(
            (s) =>
              !deletedBoards.has(s.board.id) && boardInFolder(s.board, folderId)
          )
          for (const op of opsSinceFetch ?? []) {
            boards = applyOp(boards, op, deletedBoards, folderId)
          }
          set({ boards, hydrated: true, loadError: null, refetching: false })
          settle()
        })
        .catch((e) => {
          if (epoch !== fetchEpoch) return
          console.error("[canvas] board list fetch failed:", e)
          set({ loadError: toErrorMessage(e), refetching: false })
          settle()
        })
      return fetchInFlight
    },

    reset: () => {
      fetchEpoch++
      fetchInFlight = null
      fetchAgain = false
      opsSinceFetch = null
      scopeEpoch++
      // Board ids belong to the backend that handed them out.
      deletedBoards.clear()
      set({
        boards: [],
        hydrated: false,
        loadError: null,
        refetching: false,
        // 项目 id 也是这个后端的；新后端的项目由 `useCanvasBoardsFolder` 重新设上。
        folderId: null,
        activeBoardId: null,
        closedNotice: null,
      })
    },
  }
})

registerBackendScopedStoreReset(() => useCanvasBoardsStore.getState().reset())
