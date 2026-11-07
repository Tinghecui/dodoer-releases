"use client"

import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { create } from "zustand"

/**
 * jenny fork: a place inside the top-right corner capsule for the shown
 * conversation's own buttons (its "more actions" menu, maximize/restore), so
 * the corner reads as one container instead of a row of separate pills.
 *
 * `RightEdgeChrome` renders the one `RightChromeSlot`; the conversation header
 * wraps its buttons in `RightChromePortal`, which moves them there when asked
 * and the slot exists, and leaves them in place otherwise (aux panel open,
 * phone, tests).
 */
const useSlotStore = create<{
  slot: HTMLElement | null
  setSlot: (slot: HTMLElement | null) => void
}>((set) => ({
  slot: null,
  setSlot: (slot) => set({ slot }),
}))

/** The capsule's slot. Empty, it takes no room; filled, a hairline sets it
 *  apart from the window buttons after it. */
export function RightChromeSlot() {
  const setSlot = useSlotStore((s) => s.setSlot)
  return (
    <div
      ref={setSlot}
      data-right-chrome-slot=""
      className="flex items-center gap-0.5 empty:hidden after:mx-1 after:h-4 after:w-px after:bg-[var(--g-sep2)] after:content-['']"
    />
  )
}

/** `children` in the corner capsule when `enabled` and the slot exists, else
 *  `fallback` where it is. */
export function RightChromePortal({
  enabled,
  children,
  fallback,
}: {
  enabled: boolean
  children: ReactNode
  fallback: ReactNode
}) {
  const slot = useSlotStore((s) => s.slot)
  return enabled && slot ? createPortal(children, slot) : <>{fallback}</>
}
