"use client"

import { useCallback, useLayoutEffect, useState } from "react"
import {
  useStickToBottom,
  type ScrollToBottom,
  type StickToBottomState,
} from "use-stick-to-bottom"
import { cn } from "@/lib/utils"
import {
  MessageThread,
  type MessageThreadProps,
} from "@/components/ai-elements/message-thread"

type ConversationMessageThreadProps = MessageThreadProps & {
  loading: boolean
}

function pinToBottom(state: StickToBottomState, viewport: HTMLElement) {
  if (!state.isAtBottom) return
  // Use the library's imperative setter so its scroll handler recognises this
  // write as programmatic, including when virtual measurements shrink content.
  state.scrollTop = Math.max(0, viewport.scrollHeight - viewport.clientHeight)
}

/** Keyed by conversation/visibility so cached tabs also enter at the bottom. */
// Entry reveal: the thread stays transparent until its rows stop resizing for
// REVEAL_QUIET_MS (capped at REVEAL_MAX_MS), then fades in already at the
// bottom — so opening a conversation never shows rows measuring and the view
// shifting under them.
const REVEAL_QUIET_MS = 90
const REVEAL_MAX_MS = 450

export function ConversationMessageThread({
  loading,
  resize,
  className,
  ...props
}: ConversationMessageThreadProps) {
  const [entering, setEntering] = useState(true)
  const [revealed, setRevealed] = useState(false)
  const instance = useStickToBottom({
    initial: "instant",
    resize: entering ? "instant" : resize,
  })
  const { scrollRef, contentRef, state, scrollToBottom } = instance
  const scroll: ScrollToBottom = useCallback(
    (options) =>
      scrollToBottom(
        entering
          ? {
              ...(typeof options === "object" ? options : {}),
              animation: "instant",
            }
          : options
      ),
    [entering, scrollToBottom]
  )

  useLayoutEffect(() => {
    if (!entering) return
    const viewport = scrollRef.current
    const content = contentRef.current
    if (!viewport || !content) return

    // The library's instant scroll still waits for rAF. Pin before paint, and
    // again after virtual-row measurements, using the current DOM extent.
    const pin = () => pinToBottom(state, viewport)
    pin()
    const observer = new ResizeObserver(pin)
    observer.observe(content)
    observer.observe(viewport)
    return () => observer.disconnect()
  }, [entering, scrollRef, contentRef, state])

  useLayoutEffect(() => {
    if (revealed) return
    const reveal = () => setRevealed(true)
    let quiet = window.setTimeout(reveal, REVEAL_QUIET_MS)
    const cap = window.setTimeout(reveal, REVEAL_MAX_MS)
    const content = contentRef.current
    const observer = new ResizeObserver(() => {
      window.clearTimeout(quiet)
      quiet = window.setTimeout(reveal, REVEAL_QUIET_MS)
    })
    if (content) observer.observe(content)
    return () => {
      window.clearTimeout(quiet)
      window.clearTimeout(cap)
      observer.disconnect()
    }
  }, [revealed, contentRef])

  useLayoutEffect(() => {
    // Slow history loads must not spend the entry interval on a placeholder.
    if (loading) return
    const timer = setTimeout(() => setEntering(false), 1500)
    return () => clearTimeout(timer)
  }, [loading])

  return (
    <MessageThread
      {...props}
      data-thread-revealed={revealed ? "" : undefined}
      className={cn(
        className,
        "transition-opacity duration-200 ease-out motion-reduce:transition-none",
        revealed ? "opacity-100" : "opacity-0"
      )}
      instance={{ ...instance, scrollToBottom: scroll }}
    />
  )
}
