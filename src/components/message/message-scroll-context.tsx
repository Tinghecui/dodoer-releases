"use client"

import { createContext, useContext } from "react"
import type { ScrollToIndexOpts } from "virtua"

export interface MessageScrollToIndexOpts extends ScrollToIndexOpts {
  /** Let go of the stick-to-bottom lock whatever the current scroll offset
   *  says. For jumps made right after the thread mounts (a search hit opening
   *  another conversation): the first stick to the bottom hasn't landed yet,
   *  the view still rests at the top, and the target doesn't look "above". */
  leaveBottom?: boolean
}

export interface MessageScrollContextValue {
  scrollToIndex: (index: number, opts?: MessageScrollToIndexOpts) => void
  /** Scrolls the transcript up to `element` when its top is above the view,
   *  letting go of the stream it was following; leaves it alone otherwise. */
  revealFromAbove: (element: Element) => void
}

const MessageScrollContext = createContext<MessageScrollContextValue | null>(
  null
)

export const MessageScrollProvider = MessageScrollContext.Provider

export function useMessageScroll(): MessageScrollContextValue | null {
  return useContext(MessageScrollContext)
}
