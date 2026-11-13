import { create } from "zustand"

/**
 * A request to show one round of a conversation once its transcript is on
 * screen — what picking a message hit in the search dialog leaves behind
 * after it opens the conversation. The conversation page's transcript takes
 * the request (`takeTurnReveal`) once its detail has loaded and jumps the way
 * a click in the message navigator does: straight to a loaded message, or
 * paging history in through one above the window.
 *
 * One request at a time; a newer one replaces it. Client-only.
 */
export interface TurnRevealRequest {
  /** DB conversation id. */
  conversationId: number
  /** The round's user turn. */
  turnId: string
  /** Its index in the full transcript (`turns_offset` coordinates). */
  turnIndex: number
}

interface TurnRevealState {
  pending: TurnRevealRequest | null
}

export const useTurnRevealStore = create<TurnRevealState>(() => ({
  pending: null,
}))

export function requestTurnReveal(request: TurnRevealRequest): void {
  useTurnRevealStore.setState({ pending: { ...request } })
}

/** The pending request for `conversationId`, cleared as it is taken; null
 *  when there is none for it. */
export function takeTurnReveal(
  conversationId: number
): TurnRevealRequest | null {
  const { pending } = useTurnRevealStore.getState()
  if (pending == null || pending.conversationId !== conversationId) return null
  useTurnRevealStore.setState({ pending: null })
  return pending
}
