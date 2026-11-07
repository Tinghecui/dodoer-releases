import { useEffect } from "react"
import { create } from "zustand"
import { getConversationTaxonomy } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  CONVERSATION_TAXONOMY_CHANGED_EVENT,
  type ConversationTaxonomy,
  type ConversationTaxonomyChangedEvent,
} from "@/lib/conversation-taxonomy"
import { onTransportReconnect, subscribe } from "@/lib/platform"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"

/**
 * jenny fork: the conversation mind maps this window has looked at, by root
 * folder id.
 *
 * A map changes on the backend (a nightly plan, Jev placing a new
 * conversation, a move by hand in any window), which broadcasts only the
 * project and its new revision; this store refetches when a broadcast is
 * ahead of what it holds. Every answer carries its revision, and an answer
 * older than the one held is dropped, so a slow read can never paint over a
 * newer one.
 */
export interface TaxonomyEntry {
  taxonomy: ConversationTaxonomy | null
  loading: boolean
  error: string | null
}

interface ConversationTaxonomyState {
  byFolder: Record<number, TaxonomyEntry>
  fetch: (folderId: number) => Promise<void>
  /** Keep `taxonomy` unless what is held is newer. */
  accept: (taxonomy: ConversationTaxonomy) => void
  handleChanged: (event: ConversationTaxonomyChangedEvent) => void
  reset: () => void
}

const EMPTY: TaxonomyEntry = { taxonomy: null, loading: false, error: null }

/** Bumped by `reset()`: answers to requests from before it are ignored. */
let scope = 0

export const useConversationTaxonomyStore = create<ConversationTaxonomyState>(
  (set, get) => ({
    byFolder: {},

    fetch: async (folderId) => {
      const asked = scope
      set((s) => ({
        byFolder: {
          ...s.byFolder,
          [folderId]: { ...(s.byFolder[folderId] ?? EMPTY), loading: true },
        },
      }))
      try {
        const taxonomy = await getConversationTaxonomy(folderId)
        if (asked !== scope) return
        get().accept(taxonomy)
        // A worktree folder answers with its root's map; the entry asked
        // for is done loading either way.
        set((s) => ({
          byFolder: {
            ...s.byFolder,
            [folderId]: {
              ...(s.byFolder[folderId] ?? EMPTY),
              loading: false,
              error: null,
            },
          },
        }))
      } catch (err) {
        if (asked !== scope) return
        set((s) => ({
          byFolder: {
            ...s.byFolder,
            [folderId]: {
              ...(s.byFolder[folderId] ?? EMPTY),
              loading: false,
              error: toErrorMessage(err),
            },
          },
        }))
      }
    },

    accept: (taxonomy) => {
      set((s) => {
        const held = s.byFolder[taxonomy.folder_id]?.taxonomy
        if (held && held.revision > taxonomy.revision) return s
        return {
          byFolder: {
            ...s.byFolder,
            [taxonomy.folder_id]: {
              ...(s.byFolder[taxonomy.folder_id] ?? EMPTY),
              taxonomy,
              error: null,
            },
          },
        }
      })
    },

    handleChanged: (event) => {
      const entry = get().byFolder[event.folder_id]
      // Only maps this window has asked for are kept live.
      if (!entry) return
      if (entry.taxonomy && entry.taxonomy.revision >= event.revision) return
      void get().fetch(event.folder_id)
    },

    reset: () => {
      scope += 1
      set({ byFolder: {} })
    },
  })
)

registerBackendScopedStoreReset(() =>
  useConversationTaxonomyStore.getState().reset()
)

/**
 * Keep `folderId`'s mind map loaded and live while the caller is mounted:
 * subscribe first, then read (a change landing between an earlier read and
 * the subscription would reach neither), and read again after a reconnect
 * (broadcasts sent while nobody listened are gone).
 */
export function useConversationTaxonomySync(folderId: number | null): void {
  useEffect(() => {
    if (folderId == null) return
    const store = useConversationTaxonomyStore.getState
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      try {
        const dispose = await subscribe<ConversationTaxonomyChangedEvent>(
          CONVERSATION_TAXONOMY_CHANGED_EVENT,
          (event) => store().handleChanged(event)
        )
        if (disposed) {
          dispose()
          return
        }
        unlisten = dispose
      } catch (err) {
        console.error("[ConversationTaxonomy] subscribe failed:", err)
      }
      if (disposed) return
      void store().fetch(folderId)
    })()

    const offReconnect = onTransportReconnect(() => {
      void store().fetch(folderId)
    })

    return () => {
      disposed = true
      unlisten?.()
      offReconnect?.()
    }
  }, [folderId])
}
