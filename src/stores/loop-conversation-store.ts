/**
 * jenny fork: what a folder's Loop conversation shows, shared by its main view
 * and the aux panel's registration, so both read one copy of Jenny's files and
 * the panel can point the view at a stage.
 */

import { create } from "zustand"

import { getLoopConversation } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { JennyLoopConversation } from "@/lib/types"

/** A stage the view should bring on screen. `nonce` repeats a jump to the same
 *  stage. */
export interface LoopFocus {
  folderId: number
  loopId: string
  stageId: string
  nonce: number
}

interface FolderEntry {
  detail: JennyLoopConversation | null
  error: string | null
}

interface LoopConversationState {
  byFolder: Record<number, FolderEntry>
  /** The Loop the panel shows, per folder. Unset follows the live one. */
  selectedLoop: Record<number, string>
  focus: LoopFocus | null
  load: (folderId: number) => Promise<void>
  selectLoop: (folderId: number, loopId: string) => void
  focusStage: (folderId: number, loopId: string, stageId: string) => void
}

const inFlight = new Set<number>()

export const useLoopConversationStore = create<LoopConversationState>(
  (set, get) => ({
    byFolder: {},
    selectedLoop: {},
    focus: null,
    load: async (folderId) => {
      if (inFlight.has(folderId)) return
      inFlight.add(folderId)
      try {
        const detail = await getLoopConversation(folderId)
        set((s) => ({
          byFolder: { ...s.byFolder, [folderId]: { detail, error: null } },
        }))
      } catch (e) {
        // A failed refresh keeps the last good read on screen.
        const detail = get().byFolder[folderId]?.detail ?? null
        set((s) => ({
          byFolder: {
            ...s.byFolder,
            [folderId]: { detail, error: toErrorMessage(e) },
          },
        }))
      } finally {
        inFlight.delete(folderId)
      }
    },
    selectLoop: (folderId, loopId) =>
      set((s) => ({ selectedLoop: { ...s.selectedLoop, [folderId]: loopId } })),
    focusStage: (folderId, loopId, stageId) =>
      set((s) => ({
        focus: {
          folderId,
          loopId,
          stageId,
          nonce: (s.focus?.nonce ?? 0) + 1,
        },
      })),
  })
)
